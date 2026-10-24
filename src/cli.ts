#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { decideForFile } from "./llm.js";
import { scanFile, scanFolder } from "./scan.js";
import { createPlan, printPlanSummary } from "./plan.js";
import { applyPlan } from "./apply.js";
import { undoLastBatch } from "./undo.js";

export const program = new Command();

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
  .option("--limit <number>", "maximum files to consider", (value) => Number.parseInt(value, 10))
  .action(async (folder: string, options: { out: string; limit?: number }) => {
    const { plan, elapsedMs, modelCalls, extensionOnlyDecisions, replacedExistingPlan, dateSources } = await createPlan(folder, {
      out: options.out,
      limit: options.limit,
      onProgress: (index, total, name) => console.log(`[${index}/${total}] ${name}`),
    });
    if (replacedExistingPlan) console.log("replacing previous plan");
    printPlanSummary(plan.items, elapsedMs, modelCalls, extensionOnlyDecisions, dateSources);
  });

program
  .command("apply <plan>")
  .option("--yes", "apply without an interactive confirmation")
  .action(async (plan: string, options: { yes?: boolean }) => {
    await applyPlan(plan, {
      yes: options.yes,
      confirm: async () => {
        const prompt = createInterface({ input: stdin, output: stdout });
        try { return (await prompt.question("Continue? [y/N] ")).trim().toLocaleLowerCase("en-US") === "y"; }
        finally { prompt.close(); }
      },
    });
  });

program
  .command("undo")
  .option("--log <file>", "undo log file", ".sloth-tidy/undo.log.json")
  .action(async (options: { log: string }) => {
    await undoLastBatch(options.log);
  });

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  program.parse();
}
