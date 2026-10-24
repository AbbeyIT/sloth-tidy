import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan } from "../src/plan.js";

const decideMock = vi.hoisted(() => vi.fn());
vi.mock("../src/llm.js", () => ({ decideForFile: decideMock }));

let temporary: string;
afterEach(async () => {
  vi.clearAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function makeFolder(names: string[]): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), "sloth-plan-"));
  const root = join(temporary, "source");
  await mkdir(root);
  for (const name of names) await writeFile(join(root, name), `contents:${name}`);
  return root;
}

function suggestion(newName: string, folder = "Work", confidence = 0.9) {
  return {
    category: "Work", description: "project-notes", documentDate: "unknown", reason: "Work document", confidence,
    folder, newName, dateSource: "file modified date" as const,
  };
}

describe("createPlan", () => {
  it("creates SPEC-shaped plan items and writes no snippets", async () => {
    const root = await makeFolder(["one.txt"]);
    decideMock.mockResolvedValue(suggestion("2026-06-01_project-notes.txt"));
    const out = join(temporary, "result.json");
    const { plan } = await createPlan(root, { out });
    expect(Object.keys(plan)).toEqual(["version", "root", "model", "createdAt", "items"]);
    expect(plan.items[0]).toMatchObject({ from: "one.txt", to: "Work/2026-06-01_project-notes.txt", status: "planned" });
    expect(JSON.stringify(plan)).not.toContain("contents:one.txt");
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(plan);
  });

  it("resolves duplicate destinations across files and reserves existing target names", async () => {
    const root = await makeFolder(["one.txt", "two.txt"]);
    await mkdir(join(root, "Work"));
    await writeFile(join(root, "Work", "2026-06-01_project-notes.txt"), "existing target");
    decideMock.mockImplementation(async (card: { name: string }) => suggestion("2026-06-01_project-notes.txt", "Work"));
    const { plan } = await createPlan(root);
    const destinations = plan.items.map((item) => item.to.toLowerCase());
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(plan.items.find((item) => item.from === "one.txt")?.to).toBe("Work/2026-06-01_project-notes (2).txt");
    expect(plan.items.find((item) => item.from === "two.txt")?.to).toBe("Work/2026-06-01_project-notes (3).txt");
  });

  it("marks low confidence, temporary, and already-in-place decisions skipped", async () => {
    const root = await makeFolder(["low.txt", "download.part", "same.txt"]);
    decideMock.mockImplementation(async (card: { name: string }) => {
      if (card.name === "low.txt") return suggestion("new.txt", "Work", 0.4);
      if (card.name === "same.txt") return suggestion("same.txt", ".");
      return suggestion("download.txt");
    });
    const { plan } = await createPlan(root);
    expect(plan.items.map((item) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("leaves the source folder byte-for-byte unchanged", async () => {
    const root = await makeFolder(["one.txt", "two.txt"]);
    decideMock.mockResolvedValue(suggestion("renamed.txt"));
    const before = new Map<string, Buffer>();
    for (const name of await readdir(root)) before.set(name, await readFile(join(root, name)));
    const mtimes = new Map<string, number>();
    for (const name of before.keys()) mtimes.set(name, (await stat(join(root, name))).mtimeMs);
    await createPlan(root, { out: join(temporary, "plan.json") });
    expect(await readdir(root)).toEqual([...before.keys()]);
    for (const [name, bytes] of before) {
      expect(await readFile(join(root, name))).toEqual(bytes);
      expect((await stat(join(root, name))).mtimeMs).toBe(mtimes.get(name));
    }
  });
});
