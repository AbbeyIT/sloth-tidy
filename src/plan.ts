import { access, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { extensionDecision, resolveCollisions } from "./decide.js";
import { decideForFile } from "./llm.js";
import { scanFolder, type FileCard } from "./scan.js";
import { categoriesFromRules, matchingNeverTouch, matchingOverride } from "./rules.js";
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

export interface CreatePlanOptions { limit?: number; rules?: Rules; allowRemote?: boolean; out?: string; onProgress?: (index: number, total: number, name: string) => void }

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

function ruleSkipDecision(card: FileCard, pattern: string): Awaited<ReturnType<typeof decideForFile>> {
  return { category: "Misc", description: "protected-file", documentDate: "unknown", reason: `matched never_touch rule: ${pattern}`,
    confidence: 0, folder: ".", newName: card.name, dateSource: "none" };
}

function overrideDecision(card: FileCard, category: string, pattern: string): Awaited<ReturnType<typeof decideForFile>> {
  const year = new Date(card.mtimeMs).toISOString().slice(0, 4);
  const folder = ["Invoices", "Receipts"].includes(category) ? `${category}/${year}` : category;
  return { category, description: "rule-override", documentDate: "unknown", reason: `matched override rule: ${pattern}`,
    confidence: 0.95, folder, newName: card.name, dateSource: "file modified date" };
}

function timeoutDecision(card: FileCard): Awaited<ReturnType<typeof decideForFile>> {
  return { category: "Misc", description: "model-timeout", documentDate: "unknown", reason: "model timeout",
    confidence: 0, folder: ".", newName: card.name, dateSource: "none" };
}

function isModelTimeout(error: unknown): boolean {
  return error instanceof Error && ["ModelTimeoutError", "TimeoutError", "AbortError"].includes(error.name);
}

export async function createPlan(rootPath: string, options: CreatePlanOptions = {}): Promise<{ plan: PlanFile; elapsedMs: number; modelCalls: number; overrideDecisions: number; extensionOnlyDecisions: number; neverTouchSkips: number; replacedExistingPlan: boolean; dateSources: Record<string, string> }> {
  const started = performance.now();
  const root = resolve(rootPath);
  const cards = await scanFolder(root, { limit: options.limit, exclude: ["rules.yaml"] });
  const existing = await existingRelativePaths(root);
  const decisions = [] as Array<{ card: FileCard; decision: Awaited<ReturnType<typeof decideForFile>>; kind: "model" | "override" | "extension" | "never-touch" | "timeout" }>;
  let modelCalls = 0;
  let overrideDecisions = 0;
  let neverTouchSkips = 0;
  const categories = categoriesFromRules(options.rules);

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]!;
    options.onProgress?.(i + 1, cards.length, card.name);
    const protectedByRule = matchingNeverTouch(card.name, options.rules);
    if (protectedByRule) {
      decisions.push({ card, decision: ruleSkipDecision(card, protectedByRule), kind: "never-touch" });
      neverTouchSkips += 1;
      continue;
    }
    const override = matchingOverride(card.name, options.rules);
    if (override) {
      decisions.push({ card, decision: overrideDecision(card, override.category, override.match), kind: "override" });
      overrideDecisions += 1;
      continue;
    }
    if (!card.snippet?.trim()) {
      decisions.push({ card, decision: extensionDecision(card, categories), kind: "extension" });
      continue;
    }
    const decideOptions = { allowRemote: options.allowRemote, onRequest: () => { modelCalls += 1; } };
    let decision: Awaited<ReturnType<typeof decideForFile>>;
    try { decision = await decideForFile(card, options.rules, decideOptions); }
    catch (error) {
      if (!isModelTimeout(error)) throw error;
      try { decision = await decideForFile(card, options.rules, decideOptions); }
      catch (retryError) {
        if (!isModelTimeout(retryError)) throw retryError;
        decisions.push({ card, decision: timeoutDecision(card), kind: "timeout" });
        continue;
      }
    }
    decisions.push({ card, decision, kind: "model" });
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
  const extensionOnlyDecisions = decisions.filter(({ kind }) => kind === "extension").length;
  const dateSources = Object.fromEntries(decisions.map(({ card, decision }) => [card.name, decision.dateSource]));
  return { plan, elapsedMs: performance.now() - started, modelCalls, overrideDecisions, extensionOnlyDecisions, neverTouchSkips, replacedExistingPlan, dateSources };
}

export function printPlanSummary(items: PlanItem[], elapsedMs: number, modelCalls = 0, extensionOnlyDecisions = 0, dateSources: Record<string, string> = {}, overrideDecisions = 0, neverTouchSkips = 0): void {
  console.table(items.map((item) => ({ from: item.from, to: item.to, dateSource: dateSources[item.from] ?? "-", confidence: item.confidence, status: item.status })));
  const planned = items.filter((item) => item.status === "planned").length;
  console.log(`Planned: ${planned}  Skipped: ${items.length - planned}  Model calls: ${modelCalls}  Overrides: ${overrideDecisions}  Extension-only decisions: ${extensionOnlyDecisions}  never_touch skips: ${neverTouchSkips}  Total time: ${(elapsedMs / 1000).toFixed(1)}s`);
}
