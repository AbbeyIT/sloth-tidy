import { access, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { resolveCollisions } from "./decide.js";
import { decideForFile } from "./llm.js";
import { scanFolder, type FileCard } from "./scan.js";
import type { Rules } from "./rules.js";

export interface PlanItem {
  from: string;
  fromSize: number;
  fromMtime: number;
  to: string;
  reason: string;
  confidence: number;
  status: "planned" | "skipped";
}

export interface PlanFile { version: 1; root: string; model: string; createdAt: string; items: PlanItem[] }

export interface CreatePlanOptions { limit?: number; rules?: Rules; out?: string; onProgress?: (index: number, total: number, name: string) => void }

function sameDestinationName(item: PlanItem): boolean {
  return item.to.replace(/\\/g, "/").split("/").at(-1)?.toLocaleLowerCase("en-US") === item.from.toLocaleLowerCase("en-US")
    && !item.to.includes("/");
}

async function existingRelativePaths(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile()) found.push(relativePath);
      else if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath);
    }
  }
  await visit(root);
  return found;
}

function isTemporary(name: string): boolean { return /\.(?:part|crdownload)$/i.test(name); }

export async function createPlan(rootPath: string, options: CreatePlanOptions = {}): Promise<{ plan: PlanFile; elapsedMs: number; modelCalls: number; extensionOnlyDecisions: number; replacedExistingPlan: boolean }> {
  const started = performance.now();
  const root = resolve(rootPath);
  const cards = await scanFolder(root, { limit: options.limit });
  const existing = await existingRelativePaths(root);
  const decisions = [] as Array<{ card: FileCard; decision: Awaited<ReturnType<typeof decideForFile>> }>;
  let modelCalls = 0;

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]!;
    options.onProgress?.(i + 1, cards.length, card.name);
    const decision = await decideForFile(card, options.rules, { onRequest: () => { modelCalls += 1; } });
    decisions.push({ card, decision });
  }

  const candidates = decisions.map(({ card, decision }) => {
    const folder = decision.folder === "." ? "" : decision.folder;
    const skipped = decision.confidence < 0.5 || isTemporary(card.name) || (decision.folder === "." && decision.newName === card.name);
    return { from: card.name, fromSize: card.size, fromMtime: card.mtimeMs, to: skipped ? "-" : folder ? join(folder, decision.newName).split(sep).join("/") : decision.newName, folder, newName: decision.newName, reason: decision.reason, confidence: decision.confidence, status: skipped ? "skipped" as const : "planned" as const };
  });

  // Resolve collisions across all proposed paths, then reserve names that exist
  // already (including source files) so the plan never targets an existing file.
  for (const item of candidates) {
    if (item.status === "planned" && sameDestinationName({ ...item, to: item.to })) {
      item.status = "skipped";
      item.to = "-";
    }
  }
  const plannedCandidates = candidates.filter((item) => item.status === "planned");
  const resolvedPlanned = resolveCollisions(
    plannedCandidates.map((item) => ({ ...item, folder: item.folder || ".", newName: item.newName })),
    existing,
  );
  const resolvedByName = new Map(resolvedPlanned.map((item) => [item.from, item]));
  const planItems: PlanItem[] = candidates.map((candidate) => {
    if (candidate.status === "skipped") return {
      from: candidate.from, fromSize: candidate.fromSize, fromMtime: candidate.fromMtime,
      to: "-", reason: candidate.reason, confidence: candidate.confidence, status: "skipped",
    };
    const item = resolvedByName.get(candidate.from)!;
    return {
      from: item.from, fromSize: item.fromSize, fromMtime: item.fromMtime,
      to: item.folder === "." ? item.newName : join(item.folder, item.newName).split(sep).join("/"),
      reason: item.reason, confidence: item.confidence, status: item.status,
    };
  });

  const plan: PlanFile = {
    version: 1,
    root,
    model: process.env.SLOTH_MODEL || "qwen2.5:7b",
    createdAt: new Date().toISOString(),
    items: planItems,
  };
  let replacedExistingPlan = false;
  if (options.out) {
    const outputPath = isAbsolute(options.out) ? options.out : resolve(options.out);
    try {
      await access(outputPath);
      replacedExistingPlan = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporaryPath = join(dirname(outputPath), `.${randomUUID()}.plan.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
      await rename(temporaryPath, outputPath);
    } catch (error) {
      try { await unlink(temporaryPath); } catch { /* no temporary file to clean up */ }
      throw error;
    }
  }
  const extensionOnlyDecisions = decisions.filter(({ card }) => !card.snippet?.trim()).length;
  return { plan, elapsedMs: performance.now() - started, modelCalls, extensionOnlyDecisions, replacedExistingPlan };
}

export function printPlanSummary(items: PlanItem[], elapsedMs: number, modelCalls = 0, extensionOnlyDecisions = 0): void {
  console.table(items.map((item) => ({ from: item.from, to: item.to, confidence: item.confidence, status: item.status })));
  const planned = items.filter((item) => item.status === "planned").length;
  console.log(`Planned: ${planned}  Skipped: ${items.length - planned}  Model calls: ${modelCalls}  Extension-only decisions: ${extensionOnlyDecisions}  Total time: ${(elapsedMs / 1000).toFixed(1)}s`);
}
