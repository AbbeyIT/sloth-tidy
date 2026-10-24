import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchSession } from "../src/watch.js";
import { undoLastBatch } from "../src/undo.js";

const decideMock = vi.hoisted(() => vi.fn());
vi.mock("../src/llm.js", () => ({ decideForFile: decideMock }));

let temporary = "";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T00:00:00.000Z"));
  decideMock.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), "sloth-watch-"));
  const root = join(temporary, "root");
  await mkdir(root);
  return root;
}

function decision(name: string, confidence = 0.95) {
  const stem = name.replace(/\.txt$/i, "");
  return {
    category: "Work", description: `renamed-${stem}`, documentDate: "unknown", reason: "New work document", confidence,
    folder: "Work", newName: `2026-10-24_renamed-${stem}.txt`, dateSource: "file modified date" as const,
  };
}

describe("watch mode", () => {
  it("does not process a file while it is still changing, then processes it when stable", async () => {
    const root = await makeRoot();
    decideMock.mockImplementation(async (card: { name: string }) => decision(card.name));
    const session = await createWatchSession(root, { quietMs: 3_000, now: Date.now });
    const file = join(root, "invoice.txt");
    await writeFile(file, "first write");
    await session.pollOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await writeFile(file, "second write is longer");
    await session.pollOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await session.pollOnce();
    expect(decideMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await session.pollOnce();
    expect(decideMock).toHaveBeenCalledTimes(1);
  });

  it("ignores .part files and default mode writes proposals without moving files", async () => {
    const root = await makeRoot();
    decideMock.mockImplementation(async (card: { name: string }) => decision(card.name));
    const session = await createWatchSession(root, { quietMs: 1_000, now: Date.now });
    await writeFile(join(root, "upload.part"), "partial");
    await writeFile(join(root, "proposal.txt"), "readable text to classify");
    await session.pollOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    const proposals = await session.pollOnce();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.from).toBe("proposal.txt");
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(await stat(join(root, "proposal.txt"))).toBeDefined();
    expect(await readFile(join(root, "proposal.txt"), "utf8")).toBe("readable text to classify");
    expect(await stat(join(root, "Work", "2026-10-24_renamed-proposal.txt")).catch(() => undefined)).toBeUndefined();
    const pending = JSON.parse(await readFile(session.pendingPath, "utf8")) as { items: Array<{ from: string }> };
    expect(pending.items.map((item) => item.from)).toEqual(["proposal.txt"]);
  });

  it("applies only confident items up to max-batch, records the undo batch, and undo restores the move", async () => {
    const root = await makeRoot();
    const session = await createWatchSession(root, { apply: true, quietMs: 1_000, minConfidence: 0.8, maxBatch: 1, now: Date.now });
    decideMock.mockImplementation(async (card: { name: string }) => decision(card.name, card.name === "b.txt" ? 0.7 : 0.95));
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), `contents of ${name}`);
    await session.pollOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await session.pollOnce();
    const pending = JSON.parse(await readFile(session.pendingPath, "utf8")) as { items: Array<{ from: string; status: string }> };
    expect(pending.items.map(({ from, status }) => [from, status])).toEqual([
      ["a.txt", "applied"], ["b.txt", "planned"], ["c.txt", "planned"],
    ]);
    expect(await stat(join(root, "Work", "2026-10-24_renamed-a.txt")).then(() => true)).toBe(true);
    expect(await stat(join(root, "b.txt")).then(() => true)).toBe(true);
    const undoLog = JSON.parse(await readFile(join(root, ".sloth-tidy", "undo.log.json"), "utf8")) as Array<{ moves: unknown[] }>;
    expect(undoLog).toHaveLength(1);
    expect(undoLog[0]!.moves).toHaveLength(1);
    const undone = await undoLastBatch(join(root, ".sloth-tidy", "undo.log.json"));
    expect(undone.restored).toHaveLength(1);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("contents of a.txt");
  });
});
