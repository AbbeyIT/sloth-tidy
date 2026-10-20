import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);

function normalizeSnippet(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, Math.max(0, maxChars));
}

/** Extract a short text snippet from a supported file. Parsing errors are ignored. */
export async function extractSnippet(
  filePath: string,
  maxChars = 1500,
): Promise<string | undefined> {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile() || fileStats.size > MAX_FILE_BYTES) return undefined;

    const extension = extname(filePath).toLowerCase();
    let text: string;

    if (TEXT_EXTENSIONS.has(extension)) {
      text = await readFile(filePath, "utf8");
    } else if (extension === ".pdf") {
      const [{ PDFParse }, buffer] = await Promise.all([
        import("pdf-parse"),
        readFile(filePath),
      ]);
      const parser = new PDFParse({ data: buffer });
      try {
        const parsed = await parser.getText();
        text = parsed.text;
      } finally {
        await parser.destroy();
      }
    } else if (extension === ".docx") {
      const [{ default: mammoth }, buffer] = await Promise.all([
        import("mammoth"),
        readFile(filePath),
      ]);
      const parsed = await mammoth.extractRawText({ buffer });
      text = parsed.value;
    } else {
      return undefined;
    }

    return normalizeSnippet(text, maxChars);
  } catch {
    return undefined;
  }
}
