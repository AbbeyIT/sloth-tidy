import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, rename, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { applyPlanData } from "./apply.js";
import { decideCardForPlan, existingRelativePaths, planItemForDecision, type PlanFile, type PlanItem } from "./plan.js";
import { loadRulesForFolder, matchingNeverTouch } from "./rules.js";
import type { Rules } from "./rules.js";
import { scanFile } from "./scan.js";

const planItemSchema = z.object({
  from: z.string().min(1), fromSize: z.number().finite().nonnegative(), fromMtime: z.number().finite(),
  to: z.string(), reason: z.string(), confidence: z.number().min(0).max(1), status: z.enum(["planned", "skipped", "applied", "failed"]),
}).strict();
const pendingPlanSchema = z.object({
  version: z.literal(1), root: z.string(), model: z.string(), createdAt: z.string(), items: z.array(planItemSchema),
}).strict();

export interface WatchOptions {
  rules?: Rules;
  apply?: boolean;
  quietMs?: number;
  intervalMs?: number;
  minConfidence?: number;
  maxBatch?: number;
  allowRemote?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}
export interface WatchSession {
  pollOnce(): Promise<PlanItem[]>;
  run(): Promise<void>;
  pendingPath: string;
  logPath: string;
}

const WATCH_IGNORED_SUFFIX = /\.(?:part|crdownload|tmp)$/i;
const ALREADY_ORGANIZED = /^\d{4}-\d{2}-\d{2}_/;

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* no temporary file remains */ }
    throw error;
  }
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePause) => {
    if (signal?.aborted) { resolvePause(); return; }
    const timer = setTimeout(done, milliseconds);
    function done() { signal?.removeEventListener("abort", abort); resolvePause(); }
    function abort() { clearTimeout(timer); done(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function loadPending(path: string, root: string): Promise<PlanFile> {
  try {
    const parsed = pendingPlanSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (resolve(parsed.root) !== root) throw new Error("pending plan root does not match watch folder");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {
      version: 1, root, model: process.env.SLOTH_MODEL || "qwen2.5:7b", createdAt: new Date().toISOString(), items: [],
    };
    throw new Error(`Invalid pending-plan.json: ${(error as Error).message}. Fix: move it aside and restart watch to create a fresh pending plan.`);
  }
}

function validateOptions(options: WatchOptions): Required<Pick<WatchOptions, "quietMs" | "intervalMs" | "minConfidence" | "maxBatch">> {
  const quietMs = options.quietMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 10_000;
  const minConfidence = options.minConfidence ?? 0.8;
  const maxBatch = options.maxBatch ?? 20;
  if (!Number.isSafeInteger(quietMs) || quietMs < 1) throw new Error("Invalid --quiet-ms. Fix: provide a positive whole number of milliseconds.");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("Invalid --interval-ms. Fix: provide a positive whole number of milliseconds.");
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new Error("Invalid --min-confidence. Fix: provide a number from 0 to 1.");
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1) throw new Error("Invalid --max-batch. Fix: provide a positive whole number.");
  return { quietMs, intervalMs, minConfidence, maxBatch };
}

/** Create a polling session; exposed separately so tests can advance fake time between polls. */
export async function createWatchSession(rootPath: string, options: WatchOptions = {}): Promise<WatchSession> {
  const root = resolve(rootPath);
  const { quietMs, intervalMs, minConfidence, maxBatch } = validateOptions(options);
  const metadataDirectory = join(root, ".sloth-tidy");
  const pendingPath = join(metadataDirectory, "pending-plan.json");
  const logPath = join(metadataDirectory, "watch.log");
  await mkdir(metadataDirectory, { recursive: true });
  const pending = await loadPending(pendingPath, root);
  const entries = await readdir(root, { withFileTypes: true });
  const seen = new Set(entries.map((entry) => entry.name.toLocaleLowerCase("en-US")));
  const candidates = new Map<string, { size: number; mtimeMs: number; stableSince: number }>();
  const now = options.now ?? Date.now;
  const rules = options.rules ?? await loadRulesForFolder(root);

  async function log(event: string, name?: string): Promise<void> {
    const record = { at: new Date(now()).toISOString(), event, ...(name ? { name } : {}) };
    await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async function savePending(): Promise<void> { await atomicWrite(pendingPath, pending); }

  async function pollOnce(): Promise<PlanItem[]> {
    const currentEntries = await readdir(root, { withFileTypes: true });
    const stableNames: string[] = [];
    const timestamp = now();
    for (const entry of currentEntries) {
      const key = entry.name.toLocaleLowerCase("en-US");
      if (!entry.isFile() || seen.has(key)) continue;
      if (entry.name.startsWith(".") || WATCH_IGNORED_SUFFIX.test(entry.name) || ALREADY_ORGANIZED.test(entry.name)
        || entry.name.toLocaleLowerCase("en-US") === "rules.yaml" || matchingNeverTouch(entry.name, rules)) {
        seen.add(key);
        candidates.delete(key);
        continue;
      }
      const path = join(root, entry.name);
      let info;
      try { info = await lstat(path); } catch { candidates.delete(key); continue; }
      if (!info.isFile() || info.isSymbolicLink()) { seen.add(key); candidates.delete(key); continue; }
      const previous = candidates.get(key);
      if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
        candidates.set(key, { size: info.size, mtimeMs: info.mtimeMs, stableSince: timestamp });
        continue;
      }
      if (timestamp - previous.stableSince >= quietMs) stableNames.push(entry.name);
    }

    const proposals: PlanItem[] = [];
    for (const name of stableNames.sort((left, right) => left.localeCompare(right, "en"))) {
      if (options.signal?.aborted) break;
      const key = name.toLocaleLowerCase("en-US");
      seen.add(key);
      candidates.delete(key);
      const card = await scanFile(join(root, name));
      if (!card) continue;
      try {
        const { decision } = await decideCardForPlan(card, rules, { allowRemote: options.allowRemote });
        const occupied = [...await existingRelativePaths(root), ...pending.items.filter((item) => item.status === "planned" && item.to !== "-").map((item) => item.to)];
        const item = planItemForDecision(card, decision, occupied);
        pending.items.push(item);
        proposals.push(item);
        await log("proposal", name);
        console.log(`[watch] ${name} -> ${item.to}`);
      } catch {
        const item: PlanItem = { from: card.name, fromSize: card.size, fromMtime: card.mtimeMs, to: "-", reason: "decision failed", confidence: 0, status: "skipped" };
        pending.items.push(item);
        proposals.push(item);
        await log("decision failed", name);
        console.error(`[watch] ${name}: decision failed; left in place`);
      }
    }

    if (options.apply) {
      const batch = pending.items.filter((item) => item.status === "planned" && item.confidence >= minConfidence).slice(0, maxBatch);
      if (batch.length > 0) {
        const result = await applyPlanData({ ...pending, items: batch.map((item) => ({ ...item })) }, { yes: true });
        if (result) {
          const updated = new Map(result.plan.items.map((item) => [item.from.toLocaleLowerCase("en-US"), item]));
          for (let index = 0; index < pending.items.length; index += 1) {
            const item = pending.items[index]!;
            const changed = updated.get(item.from.toLocaleLowerCase("en-US"));
            if (changed) {
              pending.items[index] = changed;
              if (changed.status === "applied") {
                await log("applied", changed.from);
                console.log(`[watch] moved ${changed.from} -> ${changed.to}`);
              } else if (changed.status === "failed" || changed.status === "skipped") await log(`apply ${changed.status}`, changed.from);
            }
          }
        }
      }
    }
    if (proposals.length > 0 || options.apply) await savePending();
    return proposals;
  }

  async function run(): Promise<void> {
    while (!options.signal?.aborted) {
      await pause(intervalMs, options.signal);
      if (options.signal?.aborted) break;
      await pollOnce();
    }
  }

  return { pollOnce, run, pendingPath, logPath };
}

export async function watchFolder(root: string, options: WatchOptions = {}): Promise<void> {
  const session = await createWatchSession(root, options);
  console.log(`Watching ${resolve(root)} (apply: ${options.apply ? "on" : "off"})`);
  await logWatchStart(session.logPath, options.now ?? Date.now);
  await session.run();
  await appendFile(session.logPath, `${JSON.stringify({ at: new Date().toISOString(), event: "stopped" })}\n`, "utf8");
}

async function logWatchStart(path: string, now: () => number): Promise<void> {
  await appendFile(path, `${JSON.stringify({ at: new Date(now()).toISOString(), event: "started" })}\n`, "utf8");
}
