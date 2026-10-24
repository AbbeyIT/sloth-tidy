import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const planItemSchema = z.object({
  from: z.string().min(1), fromSize: z.number().finite().nonnegative(), fromMtime: z.number().finite(),
  to: z.string(), reason: z.string(), confidence: z.number().min(0).max(1),
  status: z.enum(["planned", "skipped", "applied", "failed"]),
}).strict();
const planSchema = z.object({
  version: z.literal(1), root: z.string().min(1), model: z.string(), createdAt: z.string(), items: z.array(planItemSchema),
}).strict();
const moveSchema = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();
const batchSchema = z.object({
  batchId: z.string().min(1), appliedAt: z.string(), moves: z.array(moveSchema), createdDirs: z.array(z.string()), undone: z.boolean().optional(),
}).strict();
const undoLogSchema = z.array(batchSchema);

export type ApplyPlan = z.infer<typeof planSchema>;
export interface ApplyResult { plan: ApplyPlan; applied: number; skipped: number; failed: Array<{ from: string; to: string; error: string }>; batchId: string }
export interface ApplyOptions { yes?: boolean; confirm?: () => Promise<boolean>; moveFile?: (from: string, to: string) => Promise<void> }

function assertInside(root: string, target: string, label: string): string {
  const absolute = resolve(root, target);
  const rel = relative(root, absolute);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside plan.root: ${target}`);
  }
  if (rel.split(/[\\/]+/).some((segment) => segment.toLocaleLowerCase("en-US") === ".sloth-tidy")) {
    throw new Error(`${label} cannot target .sloth-tidy metadata`);
  }
  return absolute;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isFile()) files.push(relative(root, absolute).split(sep).join("/").toLocaleLowerCase("en-US"));
      else if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) files.push(relative(root, absolute).split(sep).join("/").toLocaleLowerCase("en-US"));
    }
  }
  await visit(root);
  return files;
}

async function writeJsonSafely(path: string, value: unknown): Promise<void> {
  const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(tempPath, path);
  } catch (error) {
    try { await unlink(tempPath); } catch { /* temporary file may not exist */ }
    throw error;
  }
}

async function loadUndoLog(path: string): Promise<z.infer<typeof undoLogSchema>> {
  try { return undoLogSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Invalid undo log ${path}: ${(error as Error).message}`);
  }
}

function destinationRelative(itemTo: string): string {
  const normalized = itemTo.replace(/\\/g, "/");
  if (!normalized || normalized === "-" || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) {
    throw new Error(`Invalid planned destination: ${itemTo}`);
  }
  return normalized;
}

/** Validate everything in a plan before performing its first move. */
export async function applyPlan(planPath: string, options: ApplyOptions = {}): Promise<ApplyResult | undefined> {
  const parsed = planSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
  return applyPlanDataInternal(parsed, planPath, options);
}

/** Apply a validated in-memory batch through the identical checks and undo log. */
export async function applyPlanData(data: unknown, options: ApplyOptions = {}): Promise<ApplyResult | undefined> {
  return applyPlanDataInternal(planSchema.parse(data), undefined, options);
}

async function applyPlanDataInternal(parsed: ApplyPlan, planPath: string | undefined, options: ApplyOptions): Promise<ApplyResult | undefined> {
  const root = resolve(parsed.root);
  const realRoot = await realpath(root);
  const plan: ApplyPlan = { ...parsed, root };

  // Validate every planned path before inspecting mutable filesystem state.
  const destinations = new Map<number, string>();
  const plannedTargetKeys = new Set<string>();
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index]!;
    if (item.status !== "planned") continue;
    if (item.from.includes("/") || item.from.includes("\\") || item.from === "." || item.from === ".." || isAbsolute(item.from)) {
      throw new Error(`Source must be a direct child of plan.root: ${item.from}`);
    }
    assertInside(root, item.from, "Source");
    const to = destinationRelative(item.to);
    const absoluteTo = assertInside(root, to, "Destination");
    let existingParent = dirname(absoluteTo);
    while (existingParent !== root) {
      try { await access(existingParent); break; }
      catch { existingParent = dirname(existingParent); }
    }
    const realParent = await realpath(existingParent);
    const realParentRelative = relative(realRoot, realParent);
    if (realParentRelative === ".." || realParentRelative.startsWith(`..${sep}`) || isAbsolute(realParentRelative)) {
      throw new Error(`Destination traverses outside plan.root through a symbolic link: ${item.to}`);
    }
    const key = relative(root, absoluteTo).split(sep).join("/").toLocaleLowerCase("en-US");
    if (plannedTargetKeys.has(key)) throw new Error(`Plan contains duplicate destination: ${item.to}`);
    plannedTargetKeys.add(key);
    destinations.set(index, absoluteTo);
  }

  const existing = new Set(await listFiles(root));
  const ready: number[] = [];
  let skipped = plan.items.filter((item) => item.status !== "planned").length;
  for (const [index, destination] of destinations) {
    const item = plan.items[index]!;
    const fromPath = join(root, item.from);
    let sourceStat;
    try { sourceStat = await lstat(fromPath); }
    catch {
      item.status = "skipped";
      item.reason = "source missing";
      skipped += 1;
      continue;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== item.fromSize || Math.abs(sourceStat.mtimeMs - item.fromMtime) > 1) {
      item.status = "skipped";
      item.reason = "source changed since plan was created";
      skipped += 1;
      continue;
    }
    const destinationKey = relative(root, destination).split(sep).join("/").toLocaleLowerCase("en-US");
    if (existing.has(destinationKey)) {
      item.status = "skipped";
      item.reason = "destination already exists";
      skipped += 1;
      continue;
    }
    ready.push(index);
  }

  console.log(`${ready.length} files will move, ${skipped} skipped`);
  if (!options.yes && !(await (options.confirm ?? (async () => false))())) {
    console.log("Apply cancelled.");
    return undefined;
  }

  const batchId = randomUUID();
  const createdDirs: string[] = [];
  const moves: Array<{ from: string; to: string }> = [];
  const failures: ApplyResult["failed"] = [];
  for (const index of ready) {
    const item = plan.items[index]!;
    const to = destinations.get(index)!;
    const parent = dirname(to);
    const missingDirs: string[] = [];
    let cursor = parent;
    while (cursor !== root && cursor.startsWith(root + sep)) {
      try { await access(cursor); break; }
      catch { missingDirs.unshift(cursor); cursor = dirname(cursor); }
    }
    try {
      for (const directory of missingDirs) {
        try { await mkdir(directory); createdDirs.push(directory); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(directory)).isDirectory()) throw error;
        }
      }
      const currentFiles = new Set(await listFiles(root));
      const targetKey = relative(root, to).split(sep).join("/").toLocaleLowerCase("en-US");
      if (currentFiles.has(targetKey)) throw new Error("destination appeared after preflight; refusing to overwrite");
      const fromPath = join(root, item.from);
      await (options.moveFile ?? rename)(fromPath, to);
      item.status = "applied";
      moves.push({ from: fromPath, to });
    } catch (error) {
      item.status = "failed";
      item.reason = `move failed: ${(error as Error).message}`.slice(0, 200);
      failures.push({ from: item.from, to: item.to, error: (error as Error).message });
    }
  }

  const logPath = join(root, ".sloth-tidy", "undo.log.json");
  await mkdir(dirname(logPath), { recursive: true });
  const log = await loadUndoLog(logPath);
  log.push({ batchId, appliedAt: new Date().toISOString(), moves, createdDirs, undone: false });
  await writeJsonSafely(logPath, log);
  if (planPath) await writeJsonSafely(resolve(planPath), plan);
  console.log(`Applied: ${moves.length}  Skipped: ${skipped}  Failed: ${failures.length}`);
  for (const failure of failures) console.error(`Failed ${failure.from} -> ${failure.to}: ${failure.error}`);
  return { plan, applied: moves.length, skipped, failed: failures, batchId };
}
