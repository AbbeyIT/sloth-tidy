# Sloth Tidy: point it at a messy folder, a local open-weight model proposes where everything belongs.

## Status

- [x] Scaffold
- [x] Scan + extract
- [x] Model decisions
- [x] Plan output
- [x] Apply
- [x] Undo
- [x] rules.yaml
- [ ] Watch

## Why local and open

Sloth Tidy sends file cards to an Ollama model configured on the local machine. It uses no hosted model API or API key by default. The model can be changed with `SLOTH_MODEL`. Remote Ollama URLs are refused unless explicitly allowed.

## Requirements

- Node.js 20 or newer
- Ollama installed and running
- A pulled model; the default is `qwen2.5:7b`

Pull the default model with:

```sh
ollama pull qwen2.5:7b
```

## Setup

```sh
git clone <repository-url>
cd sloth-tidy
npm install
npm run build
npm test
```

## Try it today

Generate the deterministic 30-file demo folder, scan the files, then ask the local model to decide for one PDF:

```sh
npx tsx scripts/make-messy-folder.ts
npx tsx src/cli.ts scan ./demo/messy
npx tsx src/cli.ts decide ./demo/messy/scan0012.pdf
```

`scan` lists files directly inside the folder with extension, size, and a short extracted snippet. `decide` prints one model decision. It requires Ollama to be running with the selected model available.

Example output from a successful local `decide` run (the model wording may vary):

```json
{
  "category": "Invoices",
  "description": "meralco-electricity-bill",
  "documentDate": "2026-10-31",
  "reason": "Electricity bill from Meralco for October 2026",
  "confidence": 0.95,
  "folder": "Invoices/2026",
  "newName": "2026-10-31_meralco-electricity-bill.pdf"
}
```

## How decisions work

The model chooses a category from Invoices, Receipts, Work, School, Installers, Images, and Misc; it also returns a short description and a document date. Code builds the suggested folder and filename, preserving the original extension. A model-provided date must appear in the filename or extracted file text. Files without a readable snippet are not sent to the model by the scan or decide commands. Non-English letters and invalid output are rejected and retried once.

## Configuration

- `SLOTH_MODEL` selects the Ollama model; defaults to `qwen2.5:7b`.
- `SLOTH_OLLAMA_URL` sets the Ollama base URL; defaults to `http://localhost:11434`.
- Only localhost URLs are accepted by default. The hidden debug command accepts `--allow-remote` to permit another host:

```sh
npx tsx src/cli.ts decide ./demo/messy/scan0012.pdf --allow-remote
```

## Safety principles

- Dry-run by default: scan and decide only print results. Plan output is planned and not yet built.
- Never overwrite or delete files: planned for the future apply implementation.
- Undo log and restoration: planned with apply/undo; not yet built.
- File names and contents are treated as untrusted data, never as instructions.

## Project layout

```text
AGENTS.md
SPEC.md
README.md
package.json
tsconfig.json
src/
  cli.ts
  scan.ts
  extract.ts
  llm.ts
  decide.ts
  rules.ts
  plan.ts
  apply.ts
  undo.ts
scripts/
  make-messy-folder.ts
test/
  cli.test.ts
  llm-decide.test.ts
  scan-extract.test.ts
```

## Roadmap

- Milestone 4: create and print a dry-run plan.
- Milestone 5: safely apply moves and support undo.
- Milestone 6: load `rules.yaml` and polish the CLI.
- Milestone 7: watch a folder for new files.

License: TBD
