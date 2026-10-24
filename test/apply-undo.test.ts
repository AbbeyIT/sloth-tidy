import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyPlan } from "../src/apply.js";
import { undoLastBatch } from "../src/undo.js";

let temporary = "";
afterEach(async () => {
  vi.restoreAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function fixture(names: string[] = ["one.txt", "two.txt"]) {
  temporary = await mkdtemp(join(tmpdir(), "sloth-apply-"));
  const root = join(temporary, "root");
  await mkdir(root);
  const items = [];
  for (const name of names) {
    const path = join(root, name);
    await writeFile(path, `contents:${name}`);
    const info = await stat(path);
    items.push({ from: name, fromSize: info.size, fromMtime: info.mtimeMs, to: `Work/${name}`, reason: "test move", confidence: 0.9, status: "planned" });
  }
  const planPath = join(temporary, "plan.json");
  await writeFile(planPath, JSON.stringify({ version: 1, root, model: "test", createdAt: new Date().toISOString(), items }, null, 2));
  return { root, planPath, items };
}

async function userTree(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === ".sloth-tidy") continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { result.push(`${name}/`); await visit(join(directory, entry.name), name); }
      else result.push(name);
    }
  }
  await visit(root);
  return result.sort();
}

async function fileHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === ".sloth-tidy") continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else result[name] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex");
    }
  }
  await visit(root);
  return result;
}

describe("applyPlan and undoLastBatch", () => {
  it("applies and undoes a tree while restoring names and SHA-256 hashes", async () => {
    const { root, planPath } = await fixture();
    const beforeTree = await userTree(root);
    const beforeHashes = await fileHashes(root);
    const applied = await applyPlan(planPath, { yes: true });
    expect(applied?.applied).toBe(2);
    expect(await userTree(root)).toEqual(["Work/", "Work/one.txt", "Work/two.txt"]);
    const undone = await undoLastBatch(join(root, ".sloth-tidy", "undo.log.json"));
    expect(undone.restored).toHaveLength(2);
    expect(await userTree(root)).toEqual(beforeTree);
    expect(await fileHashes(root)).toEqual(beforeHashes);
  });

  it("does not overwrite an existing destination, including case-only differences", async () => {
    const { root, planPath } = await fixture(["one.txt"]);
    await mkdir(join(root, "Work"));
    await writeFile(join(root, "Work", "ONE.TXT"), "keep me");
    const applied = await applyPlan(planPath, { yes: true });
    expect(applied?.applied).toBe(0);
    expect(applied?.skipped).toBe(1);
    expect(await readFile(join(root, "Work", "ONE.TXT"), "utf8")).toBe("keep me");
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("contents:one.txt");
  });

  it.each(["../escape.txt", "absolute"])("rejects tampered destination %s before any move", async (to) => {
    const { root, planPath } = await fixture(["one.txt"]);
    const plan = JSON.parse(await readFile(planPath, "utf8")) as { items: Array<{ to: string }> };
    plan.items[0]!.to = to === "absolute" ? join(temporary, "outside.txt") : to;
    await writeFile(planPath, JSON.stringify(plan));
    await expect(applyPlan(planPath, { yes: true })).rejects.toThrow(/inside plan\.root|Invalid planned destination/);
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("contents:one.txt");
    expect(await userTree(root)).toEqual(["one.txt"]);
  });

  it("skips a source whose size or modification time changed", async () => {
    const { root, planPath } = await fixture(["one.txt"]);
    await writeFile(join(root, "one.txt"), "changed contents");
    const applied = await applyPlan(planPath, { yes: true });
    expect(applied?.applied).toBe(0);
    expect(applied?.skipped).toBe(1);
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("changed contents");
  });

  it("continues after one move fails and records both outcomes", async () => {
    const { root, planPath } = await fixture();
    let count = 0;
    const moveFile = async (from: string, to: string) => {
      count += 1;
      if (count === 1) throw new Error("simulated move failure");
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    };
    const result = await applyPlan(planPath, { yes: true, moveFile });
    expect(result?.applied).toBe(1);
    expect(result?.failed).toHaveLength(1);
    const updated = JSON.parse(await readFile(planPath, "utf8")) as { items: Array<{ status: string }> };
    expect(updated.items.map((item) => item.status)).toEqual(["failed", "applied"]);
    const log = JSON.parse(await readFile(join(root, ".sloth-tidy", "undo.log.json"), "utf8")) as Array<{ moves: unknown[] }>;
    expect(log[0]!.moves).toHaveLength(1);
  });

  it("skips a missing moved file and an occupied original path, and a second undo is harmless", async () => {
    const { root, planPath } = await fixture();
    await applyPlan(planPath, { yes: true });
    await unlink(join(root, "Work", "one.txt"));
    await writeFile(join(root, "two.txt"), "new file at original path");
    const first = await undoLastBatch(join(root, ".sloth-tidy", "undo.log.json"));
    expect(first.skipped).toHaveLength(2);
    expect(first.skipped.map((item) => item.reason)).toEqual(expect.arrayContaining(["destination file is missing", "original path is already taken"]));
    const beforeSecond = await fileHashes(root);
    const second = await undoLastBatch(join(root, ".sloth-tidy", "undo.log.json"));
    expect(second.nothingToUndo).toBe(true);
    expect(await fileHashes(root)).toEqual(beforeSecond);
  });

  it("requires confirmation unless --yes is supplied", async () => {
    const { root, planPath } = await fixture(["one.txt"]);
    const declined = await applyPlan(planPath, { confirm: async () => false });
    expect(declined).toBeUndefined();
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("contents:one.txt");
    expect(resolve(root)).toBe(root);
  });
});
