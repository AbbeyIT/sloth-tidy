# Sloth Tidy — SPEC

> Point it at a messy folder, walk away. A local open-weight model proposes where every file belongs. You review a dry-run plan, apply it with one command, and undo it with another.

Built for the Hacktoberfest Open-Source AI Challenge, Week 3: **Slow and Steady**.

## 1. Goals

- Tidy a cluttered folder (e.g. Downloads) by renaming and sorting files, with minimal human effort.
- Run **100% locally** using an open-weight model through Ollama. No network calls, no API keys, no cost per run.
- Be **safe by default**: nothing moves without an explicit apply step, nothing is overwritten, everything is undoable.

## 2. Non-goals

- No GUI, no cloud sync, no deleting files, no recursive deep-organization of nested project folders (v1 scans one folder level).
- No fine-tuning. Behavior is steered through prompt + `rules.yaml`.

## 3. Stack

- Node.js 20+, TypeScript (ESM)
- CLI: `commander`
- Validation: `zod`
- LLM: Ollama HTTP API at `http://localhost:11434` (plain `fetch`, no SDK needed)
- Text extraction: plain text/markdown/csv/json (built in), `pdf-parse` (pdf), `mammoth` (docx)
- Tests: `vitest`
- Config: `SLOTH_MODEL` env var (default `qwen2.5:7b`), `SLOTH_OLLAMA_URL` (default `http://localhost:11434`)

## 4. CLI

```
sloth-tidy plan <folder> [--out plan.json] [--rules rules.yaml] [--limit N]
sloth-tidy apply <plan.json> [--yes]
sloth-tidy undo [--log .sloth-tidy/undo.log.json]
sloth-tidy watch <folder>          # stretch goal
```

### `plan`
1. List files directly inside `<folder>` (skip dotfiles, directories, and `.sloth-tidy/`).
2. For each file, build a **file card**: original name, extension, size, modified date, and a text snippet (first ~1500 chars) when extractable.
3. Ask the model for a decision per file (see section 5).
4. Write `plan.json` and print a readable table: `old name -> new path (reason)`.
5. **Never moves anything.**

### `apply`
1. Load and validate `plan.json`.
2. Re-check each source file still exists and is unchanged (size + mtime).
3. Create destination folders, move/rename files, and append each move to `.sloth-tidy/undo.log.json`.
4. Skip (and report) any item that would overwrite an existing file.

### `undo`
Reverse the last applied batch from the undo log, newest move first. Remove destination folders it created if they are now empty. Refuse if a file is missing or the original path is taken, and report it.

## 5. Model contract

The model returns JSON only, validated with zod. `category` must be one of `rules.folders`; when no list is supplied, use the built-in list Invoices, Receipts, Work, School, Installers, Images, Misc.

```ts
const Decision = z.object({
  category: z.enum(categories),
  description: z.string(),              // 2-6 lowercase English words, letters/numbers/hyphens only
  documentDate: z.string(),             // YYYY-MM-DD or "unknown"
  reason: z.string().max(200),          // English
  confidence: z.number().min(0).max(1),
});
```

The model never supplies a path or filename. Code builds `folder` from the category, adding `/YYYY` for Invoices and Receipts only when a visible document date is known. Code builds `newName` as `<documentDate or file mtime date>_<description>.<original extension>`.

Rules enforced **in code**, not just in the prompt:
- Reject non-English/non-ASCII letters in `reason` or `description`, and reject invalid categories, dates, or descriptions. Retry once with the validation error appended, then fall back to "leave in place" with `reason: "model output invalid"` and confidence 0.
- If `confidence < 0.5`, leave the file in place and mark it `skipped`.
- Resolve collisions by appending ` (2)`, ` (3)`, and so on. Never overwrite.
- Prefer existing folders under the target root when the model's folder is a near match (case-insensitive).

## 6. `rules.yaml` (user steering)

```yaml
folders:            # preferred folder vocabulary
  - Invoices
  - Receipts
  - Work
  - School
  - Installers
  - Images
  - Misc
naming: "YYYY-MM-DD_short-description"   # preferred naming style
never_touch:                              # glob patterns to skip
  - "*.crdownload"
  - "*.part"
notes: "Filenames with URC or SAP go under Work."
```

The contents are injected into the system prompt. This is where the "open model you control" story shows up: users change behavior by editing a file and swapping models.

## 7. Plan file format

```json
{
  "version": 1,
  "root": "/abs/path/Downloads",
  "model": "qwen2.5:7b",
  "createdAt": "2026-10-20T10:00:00Z",
  "items": [
    {
      "from": "scan0012.pdf",
      "fromSize": 48213,
      "fromMtime": 1760000000000,
      "to": "Invoices/2026/2026-10-03_meralco-bill.pdf",
      "reason": "Electricity bill from Meralco",
      "confidence": 0.86,
      "status": "planned"
    }
  ]
}
```

`status`: `planned` | `skipped` | `applied` | `failed`.

## 8. Project layout

```
sloth-tidy/
  AGENTS.md
  SPEC.md
  package.json
  tsconfig.json
  src/
    cli.ts            # commander wiring
    scan.ts           # list files, build file cards
    extract.ts        # text extraction per file type
    llm.ts            # Ollama client, prompt, JSON parsing + retry
    decide.ts         # validation, sanitizing, collision handling
    plan.ts           # plan creation + printing
    apply.ts          # apply moves + undo log
    undo.ts
    rules.ts          # rules.yaml loader
  scripts/
    make-messy-folder.ts   # generates a reproducible demo mess
  test/
    sanitize.test.ts
    collisions.test.ts
    apply-undo.test.ts
    llm-parse.test.ts      # uses a mocked model response
  README.md
```

## 9. Milestones

1. **Scaffold**: project setup, CLI skeleton, `make-messy-folder` script.
2. **Scan + extract**: file cards for txt/md/csv/json/pdf/docx. Unit-tested.
3. **Model call**: Ollama client, prompt, zod validation, retry, mocked tests.
4. **Plan**: `plan` command writes `plan.json` and prints a table.
5. **Apply + undo**: safe moves, undo log, collision and overwrite protection, round-trip test (apply then undo restores the original tree).
6. **Polish**: `rules.yaml`, README with demo GIF/screenshots, `--limit`, helpful errors if Ollama is not running or the model is not pulled.
7. **Stretch**: `watch` mode that plans/applies for new files after a quiet period.

## 10. Acceptance criteria

- On a generated messy folder of ~30 files, `plan` completes locally with no network access.
- `apply` followed by `undo` restores the exact original file names and locations.
- No file is ever overwritten or deleted.
- Malformed or hostile model output (path traversal, empty names, non-JSON) never causes a move outside the target folder.
- Works offline once the model is pulled.

## 11. Privacy and safety notes

- File contents are sent only to the local Ollama endpoint. Refuse to run if `SLOTH_OLLAMA_URL` is not a localhost address unless `--allow-remote` is passed.
- Snippets are truncated and never written to the plan file or logs.
- Treat file contents as untrusted input: text inside a file is data, never instructions to the model. The system prompt says so explicitly.

## 12. Blog post angle (dev.to)

- **Sloth fit**: the chore everyone postpones; run it once, forget it.
- **Why open matters**: personal files never leave your machine, it works offline, it costs nothing per run, and you can swap models or edit `rules.yaml` to change behavior.
- **Where open beat closed**: privacy and zero marginal cost for a tool that reads your whole Downloads folder. Include a small table comparing models you tried (speed vs. accuracy on the demo folder).
- Show the before/after folder tree, the dry-run table, and the undo.
