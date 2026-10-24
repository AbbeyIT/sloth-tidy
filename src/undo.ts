import { access, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const moveSchema = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();
const batchSchema = z.object({
  batchId: z.string().min(1), appliedAt: z.string(), moves: z.array(moveSchema), createdDirs: z.array(z.string()), undone: z.boolean().optional(),
}).strict();
const undoLogSchema = z.array(batchSchema);
export interface UndoResult { batchId?: string; restored: string[]; skipped: Array<{ from: string; to: string; reason: string }>; nothingToUndo: boolean }

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function hasCaseInsensitiveSibling(path: string): Promise<boolean> {
  try {
    const targetName = path.slice(dirname(path).length + 1).toLocaleLowerCase("en-US");
    return (await readdir(dirname(path))).some((name) => name.toLocaleLowerCase("en-US") === targetName);
  } catch { return false; }
}

async function saveLog(path: string, log: z.infer<typeof undoLogSchema>): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(log, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* no temp file remains */ }
    throw error;
  }
}

/** Reverse the newest batch that has not already been undone. */
export async function undoLastBatch(logPath = ".sloth-tidy/undo.log.json"): Promise<UndoResult> {
  const absoluteLogPath = resolve(logPath);
  let log: z.infer<typeof undoLogSchema>;
  try { log = undoLogSchema.parse(JSON.parse(await readFile(absoluteLogPath, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("Nothing to undo.");
      return { restored: [], skipped: [], nothingToUndo: true };
    }
    throw new Error(`Invalid undo log ${absoluteLogPath}: ${(error as Error).message}`);
  }

  let batchIndex = -1;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    if (!log[index]!.undone) { batchIndex = index; break; }
  }
  if (batchIndex < 0) {
    console.log("Nothing to undo.");
    return { restored: [], skipped: [], nothingToUndo: true };
  }

  const batch = log[batchIndex]!;
  const root = resolve(dirname(dirname(absoluteLogPath)));
  const realRoot = await realpath(root);
  async function assertParentsInside(target: string): Promise<void> {
    let parent = dirname(target);
    while (parent !== root) {
      try { await access(parent); break; }
      catch { parent = dirname(parent); }
    }
    const canonical = await realpath(parent);
    const rel = relative(realRoot, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Undo log path traverses outside its root: ${target}`);
  }
  for (const move of batch.moves) {
    if (!isAbsolute(move.from) || !isAbsolute(move.to) || !inside(root, resolve(move.from)) || !inside(root, resolve(move.to))) {
      throw new Error(`Undo log contains a path outside its root: ${move.from} -> ${move.to}`);
    }
    await assertParentsInside(resolve(move.from));
    await assertParentsInside(resolve(move.to));
  }
  for (const createdDir of batch.createdDirs) {
    if (!isAbsolute(createdDir) || !inside(root, resolve(createdDir))) throw new Error(`Undo log contains a directory outside its root: ${createdDir}`);
  }

  const restored: string[] = [];
  const skipped: UndoResult["skipped"] = [];
  for (const move of [...batch.moves].reverse()) {
    if (!(await exists(move.to))) {
      skipped.push({ from: move.from, to: move.to, reason: "destination file is missing" });
      continue;
    }
    if (await hasCaseInsensitiveSibling(move.from)) {
      skipped.push({ from: move.from, to: move.to, reason: "original path is already taken" });
      continue;
    }
    try {
      await mkdir(dirname(move.from), { recursive: true });
      await rename(move.to, move.from);
      restored.push(move.from);
    } catch (error) {
      skipped.push({ from: move.from, to: move.to, reason: (error as Error).message });
    }
  }

  for (const directory of [...batch.createdDirs].sort((a, b) => b.length - a.length)) {
    try { await rmdir(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") skipped.push({ from: directory, to: directory, reason: `could not remove empty directory: ${(error as Error).message}` });
    }
  }

  batch.undone = true;
  await saveLog(absoluteLogPath, log);
  console.log(`Undone batch ${batch.batchId}: restored ${restored.length}, skipped ${skipped.length}`);
  for (const item of skipped) console.error(`Skipped ${item.to}: ${item.reason}`);
  return { batchId: batch.batchId, restored, skipped, nothingToUndo: false };
}
