import { readdir, stat } from "node:fs/promises";
import { resolve, join, extname, basename } from "node:path";
import { extractSnippet } from "./extract.js";

export interface FileCard {
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  path: string;
  snippet?: string;
}

export interface ScanOptions {
  limit?: number;
  exclude?: string[];
}

async function createCard(filePath: string, name: string, size: number, mtimeMs: number): Promise<FileCard> {
  const snippet = await extractSnippet(filePath);
  return {
    name,
    ext: extname(name).slice(1).toLowerCase(),
    size,
    mtimeMs,
    path: filePath,
    ...(snippet === undefined ? {} : { snippet }),
  };
}

/** Build one file card without reading any sibling files. */
export async function scanFile(filePath: string): Promise<FileCard | undefined> {
  const absolutePath = resolve(filePath);
  const name = basename(absolutePath);
  if (name.startsWith(".")) return undefined;

  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) return undefined;
  return createCard(absolutePath, name, fileStats.size, fileStats.mtimeMs);
}

/** Scan only regular files directly inside root, in deterministic name order. */
export async function scanFolder(root: string, opts: ScanOptions = {}): Promise<FileCard[]> {
  const absoluteRoot = resolve(root);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const excluded = new Set((opts.exclude ?? []).map((name) => name.toLocaleLowerCase("en-US")));
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && !excluded.has(entry.name.toLocaleLowerCase("en-US")))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const limitedFiles = opts.limit === undefined ? files : files.slice(0, Math.max(0, opts.limit));

  return Promise.all(
    limitedFiles.map(async (entry): Promise<FileCard> => {
      const filePath = join(absoluteRoot, entry.name);
      const fileStats = await stat(filePath);
      return createCard(filePath, entry.name, fileStats.size, fileStats.mtimeMs);
    }),
  );
}
