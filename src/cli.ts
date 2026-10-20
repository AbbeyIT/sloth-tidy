#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decideForFile } from "./llm.js";
import { scanFile, scanFolder } from "./scan.js";

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
    console.table(cards.map(({ name, ext, size, snippet }) => ({
      name,
      ext,
      size,
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
  .option("--rules <file>", "rules file")
  .option("--limit <number>", "maximum files to consider", (value) => Number.parseInt(value, 10))
  .action((_folder: string) => {
    console.log("not implemented yet");
  });

program
  .command("apply <plan>")
  .option("--yes", "apply without an interactive confirmation")
  .action((_plan: string) => {
    console.log("not implemented yet");
  });

program
  .command("undo")
  .option("--log <file>", "undo log file", ".sloth-tidy/undo.log.json")
  .action(() => {
    console.log("not implemented yet");
  });

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  program.parse();
}
