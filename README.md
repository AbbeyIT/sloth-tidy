# Sloth Tidy

Point it at a messy folder; a local open-weight model proposes where everything belongs.

## Why local and open

Sloth Tidy sends readable file snippets to Ollama on your machine by default. After you pull a model, it can run without internet access, hosted model APIs, or API keys; file contents stay on your machine. Choose another Ollama model with `SLOTH_MODEL`, and steer its decisions with `rules.yaml`. A remote Ollama server is possible only when you explicitly pass `--allow-remote`.

## Requirements and setup

- Node.js 20 or newer
- Ollama installed and running
- A pulled model; the default is `qwen2.5:7b`
- Model weights are not included and are subject to their own licenses.

```sh
ollama pull qwen2.5:7b
npm install
npm run build
npm test
```

## Quick start with the demo

Generate the 30-file demo, copy it, and plan against the copy. The plan is written beside the copy so it is not scanned as an input file.

```powershell
npx tsx scripts/make-messy-folder.ts
if (Test-Path demo/messy-run) { Move-Item demo/messy-run ("demo/messy-run-backup-" + [guid]::NewGuid().ToString("N")) }
Copy-Item demo/messy demo/messy-run -Recurse
npx tsx src/cli.ts plan demo/messy-run --out demo/messy-run-plan.json
npx tsx src/cli.ts apply demo/messy-run-plan.json --yes
npx tsx src/cli.ts undo --log demo/messy-run/.sloth-tidy/undo.log.json
```

Review the plan table before applying. A trimmed run on the generated demo looked like this (model wording and timing can vary):

```text
from                    to                                                   confidence  status
scan0012.pdf            Invoices/2026/2026-10-31_meralco-electricity-bill.pdf 0.95        planned
installer_vscode.exe    Installers/installer_vscode.exe                      0.60        planned
download.part           -                                                    0.60        skipped
Planned: 29  Skipped: 1  Model calls: 20  Overrides: 0
Extension-only decisions: 10  Total time: 425.2s
```

After undo, compare the original top-level files by name and SHA-256. No output from `Compare-Object` means the names and contents match; the `.sloth-tidy` undo log remains as runtime metadata.

```powershell
$sourceRoot = (Resolve-Path demo/messy).Path
$copyRoot = (Resolve-Path demo/messy-run).Path
$source = Get-ChildItem $sourceRoot -File | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Path.Substring($sourceRoot.Length)) $($_.Hash)" } | Sort-Object
$copy = Get-ChildItem $copyRoot -File | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Path.Substring($copyRoot.Length)) $($_.Hash)" } | Sort-Object
Compare-Object $source $copy
```

On a fresh verification copy, apply moved 29 files, skipped one, and undo restored all 30 top-level file hashes with no differences.

## Commands reference

Run the source CLI with `npx tsx src/cli.ts` during development.

| Command | Purpose and flags |
| --- | --- |
| `npx tsx src/cli.ts plan <folder> [--out <file>] [--rules <file>] [--limit <number>] [--allow-remote]` | Read files and write a dry-run plan. `--out` defaults to `plan.json`; `--rules` defaults to `<folder>/rules.yaml` when present; `--limit` handles the first N files. |
| `npx tsx src/cli.ts apply <plan.json> [--yes]` | Apply planned moves. Without `--yes`, asks for confirmation. |
| `npx tsx src/cli.ts undo [--log <file>]` | Reverse the newest eligible batch. The log defaults to `.sloth-tidy/undo.log.json` relative to the current directory. |
| `npx tsx src/cli.ts watch <folder> [--rules <file>] [--apply] [--quiet-ms <milliseconds>] [--interval-ms <milliseconds>] [--min-confidence <number>] [--max-batch <number>] [--allow-remote]` | Poll for new, stable top-level files. Defaults: 30,000 ms quiet period, 10,000 ms poll interval, 0.8 confidence threshold, and 20 moves per cycle. Without `--apply`, appends proposals to `.sloth-tidy/pending-plan.json`. |
| `npx tsx src/cli.ts scan <folder>` | Hidden verification command. Prints top-level file cards and short snippets. |
| `npx tsx src/cli.ts decide <file> [--allow-remote]` | Hidden verification command. Prints one file decision. |

## How decisions work

The model chooses from Invoices, Receipts, Work, School, Installers, Images, Personal, and Misc, then supplies a short description and document date. Code builds the folder and filename and preserves the original extension. A document date must appear in the filename or extracted text; otherwise Sloth Tidy uses the file's modified date. Images, installers, empty files, and other files without readable text are classified by extension and never sent to the model. Invalid categories, schema failures, and non-English text are rejected and retried once; repeated invalid output is left in place.

Readable snippets can be extracted from TXT, Markdown, CSV, JSON, PDF, and DOCX files. Scanning is top-level only; it does not recurse into subfolders.

## `rules.yaml` reference

Pass a rules file with `--rules`, or place `rules.yaml` in the folder being planned or watched. This is the repository's `rules.example.yaml`:

```yaml
folders:
  - Invoices
  - Receipts
  - Work
  - School
  - Installers
  - Images
  - Personal
  - Misc
naming: YYYY-MM-DD_description
never_touch:
  - "*.part"
  - "*.crdownload"
overrides:
  - match: "worksheet*.docx"
    category: School
  - match: "Screenshot*.png"
    category: Images
notes: "Keep school material together; preserve the original filename for rule-based placements."
```

`folders` replaces the model's allowed category list. `naming` supports the `YYYY-MM-DD_description` style. `never_touch` contains glob patterns to skip. Matching `overrides` choose a category before a model call. `notes` adds up to 500 characters of prompt guidance.

## Watch mode

Copy the demo folder, start the watcher, then drop new files into the copy. It waits for each file to stop changing, then proposes a destination. With `--apply` it also moves files at or above `--min-confidence`. Press Ctrl+C to stop, and run `undo` to reverse what it moved.

```powershell
Copy-Item demo/messy demo/watch-demo -Recurse
npx tsx src/cli.ts watch demo/watch-demo --rules rules.example.yaml --apply --quiet-ms 3000 --interval-ms 2000
```

Leave out `--apply` to get proposals only, written to `.sloth-tidy/pending-plan.json`.

Files without readable content receive confidence 0.6, so the default `--min-confidence 0.8` will not auto-file them. Add an override to file a known image by extension and name, such as `Screenshot*.png` to `Images` in `rules.example.yaml`.

## Safety guarantees

- Planning is read-only; nothing moves until `apply` or watch's explicit `--apply` mode.
- Apply checks that every destination stays inside the plan root, that sources still match their planned size and modified time, and that destinations do not exist (case-insensitive check). It never overwrites or deletes files.
- Watch moves files only with `--apply` and only at or above `--min-confidence`, up to `--max-batch` per cycle.
- Every applied batch is recorded in `.sloth-tidy/undo.log.json`. Undo reverses the most recent batch; it skips a move if the destination is missing or the original path is occupied.
- `plan.json` and `watch.log` contain file names, but never file contents.
- File names and contents are treated as untrusted data, never as instructions. Snippets are not written to plans or logs.

## Configuration

- `SLOTH_MODEL`: Ollama model name; defaults to `qwen2.5:7b`.
- `SLOTH_OLLAMA_URL`: Ollama base URL; defaults to `http://localhost:11434`. Non-localhost URLs are refused unless the relevant command receives `--allow-remote` (`plan`, `watch`, or the hidden `decide` command).
- `SLOTH_TIMEOUT_MS`: per-request timeout in milliseconds; defaults to `120000`. A timed-out file is retried once; a second timeout is skipped and planning continues.

## Measured results

Across our 30-file demo runs, planning took about 425 to 570 seconds (7 to 10 minutes). A prior run made 22 model calls and 10 extension-only decisions; a fresh verification run made 20 model calls and 10 extension-only decisions. Timings and model classifications can vary.

Hardware: AMD Ryzen 5 5500U with Radeon Graphics

## Known limitations

- Only top-level files are scanned; there is no recursive organization.
- Small models can vary on borderline classifications; use `overrides` in `rules.yaml` when a file needs a fixed category.
- Windows was tested first; other platforms: not measured.
- Images and installers are filed by extension only; their contents are not interpreted.

## Project layout

```text
AGENTS.md
SPEC.md
README.md
package.json
package-lock.json
tsconfig.json
rules.example.yaml
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
  watch.ts
scripts/
  make-messy-folder.ts
test/
  cli.test.ts
  scan-extract.test.ts
  llm-decide.test.ts
  plan.test.ts
  apply-undo.test.ts
  rules.test.ts
  watch.test.ts
  fixtures/
    tiny.docx
```

License: [MIT](LICENSE.md)
