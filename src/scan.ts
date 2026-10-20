import { readdir, stat } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
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
}

/** Scan only regular files directly inside root, in deterministic name order. */
export async function scanFolder(root: string, opts: ScanOptions = {}): Promise<FileCard[]> {
  const absoluteRoot = resolve(root);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const limitedFiles = opts.limit === undefined ? files : files.slice(0, Math.max(0, opts.limit));

  return Promise.all(
    limitedFiles.map(async (entry): Promise<FileCard> => {
      const filePath = join(absoluteRoot, entry.name);
      const fileStats = await stat(filePath);
      const snippet = await extractSnippet(filePath);

      return {
        name: entry.name,
        ext: extname(entry.name).slice(1).toLowerCase(),
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        path: filePath,
        ...(snippet === undefined ? {} : { snippet }),
      };
    }),
  );
}
