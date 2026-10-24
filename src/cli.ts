#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ZodError, z } from "zod";
import { decideForFile } from "./llm.js";
import { scanFile, scanFolder } from "./scan.js";
import { createPlan, printPlanSummary } from "./plan.js";
import { applyPlan } from "./apply.js";
import { undoLastBatch } from "./undo.js";
import { loadRulesForFolder } from "./rules.js";
import { watchFolder } from "./watch.js";

export const program = new Command();

function parseLimit(value: string): number {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  if (!parsed.success) throw new Error("Invalid --limit value. Fix: provide a positive whole number.");
  return parsed.data;
}

function parseConfidence(value: string): number {
  const parsed = z.coerce.number().min(0).max(1).safeParse(value);
  if (!parsed.success) throw new Error("Invalid --min-confidence. Fix: provide a number from 0 to 1.");
  return parsed.data;
}

function reportCommandError(error: unknown, command: "plan" | "apply" | "watch", target: string): void {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Could not reach Ollama")) console.error("Ollama is not running. Fix: start Ollama and retry.");
  else if (/Model .* is not pulled/.test(message)) console.error(message);
  else if ((command === "plan" || command === "watch") && ["ENOENT", "EACCES", "ENOTDIR"].includes(code)) {
    console.error(`Cannot read folder "${target}". Fix: check that it exists and that you have read permission.`);
  } else if (command === "apply" && code === "ENOENT") {
    console.error(`Cannot read plan "${target}". Fix: provide an existing plan.json file.`);
  } else if (command === "apply" && (error instanceof SyntaxError || error instanceof ZodError)) {
    console.error("Invalid plan.json. Fix: regenerate it with sloth-tidy plan <folder> --out <plan.json>.");
  } else console.error(message);
  process.exitCode = 1;
}

program
  .name("sloth-tidy")
  .description("Safely organize a folder with a local model.")
  .version("0.1.0");

program
  .command("scan <folder>", { hidden: true })
  .description("Print file cards for local verification.")
  .action(async (folder: string) => {
    const cards = await scanFolder(folder);
    console.table(cards.map(({ name, ext, size, mtimeMs, snippet }) => ({
      name,
      ext,
      size,
      modified: new Date(mtimeMs).toISOString(),
      snippet: snippet?.slice(0, 60) ?? "",
    })));
  });

program
  .command("decide <file>", { hidden: true })
  .description("Print one local model decision for verification.")
  .option("--allow-remote", "allow a non-local Ollama URL from SLOTH_OLLAMA_URL")
  .action(async (file: string, options: { allowRemote?: boolean }) => {
    const card = await scanFile(file);
    if (!card) throw new Error(`Could not scan file: ${file}`);

    const decision = await decideForFile(card, undefined, { allowRemote: options.allowRemote });
    console.log(JSON.stringify(decision, null, 2));
  });

program
  .command("plan <folder>")
  .option("--out <file>", "plan output file", "plan.json")
  .option("--rules <file>", "rules YAML file; defaults to <folder>/rules.yaml when present")
  .option("--limit <number>", "maximum files to consider", parseLimit)
  .option("--allow-remote", "allow a non-local Ollama URL from SLOTH_OLLAMA_URL")
  .action(async (folder: string, options: { out: string; rules?: string; limit?: number; allowRemote?: boolean }) => {
    try {
      const rules = await loadRulesForFolder(folder, options.rules);
      const { plan, elapsedMs, modelCalls, overrideDecisions, extensionOnlyDecisions, neverTouchSkips, replacedExistingPlan, dateSources } = await createPlan(folder, {
        out: options.out,
        limit: options.limit,
        rules,
        allowRemote: options.allowRemote,
        onProgress: (index, total, name) => console.log(`[${index}/${total}] ${name}`),
      });
      if (replacedExistingPlan) console.log("replacing previous plan");
      printPlanSummary(plan.items, elapsedMs, modelCalls, extensionOnlyDecisions, dateSources, overrideDecisions, neverTouchSkips);
    } catch (error) { reportCommandError(error, "plan", folder); }
  });

program
  .command("apply <plan>")
  .option("--yes", "apply without an interactive confirmation")
  .action(async (plan: string, options: { yes?: boolean }) => {
    try {
      await applyPlan(plan, {
        yes: options.yes,
        confirm: async () => {
          const prompt = createInterface({ input: stdin, output: stdout });
          try { return (await prompt.question("Continue? [y/N] ")).trim().toLocaleLowerCase("en-US") === "y"; }
          finally { prompt.close(); }
        },
      });
    } catch (error) { reportCommandError(error, "apply", plan); }
  });

program
  .command("undo")
  .option("--log <file>", "undo log file", ".sloth-tidy/undo.log.json")
  .action(async (options: { log: string }) => {
    await undoLastBatch(options.log);
  });

program
  .command("watch <folder>")
  .option("--rules <file>", "rules YAML file; defaults to <folder>/rules.yaml when present")
  .option("--apply", "automatically apply sufficiently confident decisions")
  .option("--quiet-ms <milliseconds>", "wait for each file to remain unchanged", parseLimit, 30_000)
  .option("--interval-ms <milliseconds>", "poll interval", parseLimit, 10_000)
  .option("--min-confidence <number>", "minimum confidence for automatic apply", parseConfidence, 0.8)
  .option("--max-batch <number>", "maximum files to apply per polling cycle", parseLimit, 20)
  .option("--allow-remote", "allow a non-local Ollama URL from SLOTH_OLLAMA_URL")
  .action(async (folder: string, options: { rules?: string; apply?: boolean; quietMs: number; intervalMs: number; minConfidence: number; maxBatch: number; allowRemote?: boolean }) => {
    const controller = new AbortController();
    const stop = () => { console.log("Stopping watch after the current file finishes..."); controller.abort(); };
    process.once("SIGINT", stop);
    try {
      const rules = await loadRulesForFolder(folder, options.rules);
      await watchFolder(folder, {
        rules, apply: options.apply, quietMs: options.quietMs, intervalMs: options.intervalMs,
        minConfidence: options.minConfidence, maxBatch: options.maxBatch, allowRemote: options.allowRemote,
        signal: controller.signal,
      });
    } catch (error) { reportCommandError(error, "watch", folder); }
    finally { process.off("SIGINT", stop); }
  });

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  program.parse();
}
