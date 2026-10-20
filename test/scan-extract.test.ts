import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { afterEach, describe, expect, it } from "vitest";
import { extractSnippet } from "../src/extract.js";
import { scanFolder } from "../src/scan.js";

const temporaryDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sloth-tidy-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createTinyPdf(): Promise<Buffer> {
  const document = new PDFDocument();
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document.text("Tiny PDF snippet");
  document.end();
  return complete;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("scanFolder", () => {
  it("skips dotfiles, subfolders, and .sloth-tidy contents", async () => {
    const root = await makeTempDirectory();
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".sloth-tidy"));
    await writeFile(join(root, ".hidden.txt"), "hidden");
    await writeFile(join(root, "nested", "nested.txt"), "nested");
    await writeFile(join(root, ".sloth-tidy", "state.json"), "{}");
    await writeFile(join(root, "visible.txt"), "visible");

    const cards = await scanFolder(root);
    expect(cards.map(({ name }) => name)).toEqual(["visible.txt"]);
  });

  it("returns files in deterministic name order", async () => {
    const root = await makeTempDirectory();
    for (const name of ["zeta.bin", "alpha.bin", "middle.bin"]) {
      await writeFile(join(root, name), "");
    }

    const names = (await scanFolder(root)).map(({ name }) => name);
    expect(names).toEqual(["alpha.bin", "middle.bin", "zeta.bin"]);
  });
});

describe("extractSnippet", () => {
  it.each(["txt", "md", "csv", "json"])("extracts and normalizes %s", async (extension) => {
    const root = await makeTempDirectory();
    const file = join(root, `sample.${extension}`);
    await writeFile(file, "  first\n\tsecond    third fourth  ");

    expect(await extractSnippet(file, 15)).toBe("first second th");
  });

  it("returns undefined for unsupported and corrupt files without throwing", async () => {
    const root = await makeTempDirectory();
    const image = join(root, "photo.png");
    const corruptPdf = join(root, "broken.pdf");
    await writeFile(image, "not an image");
    await writeFile(corruptPdf, "not a PDF");

    await expect(extractSnippet(image)).resolves.toBeUndefined();
    await expect(extractSnippet(corruptPdf)).resolves.toBeUndefined();
  });

  it("returns undefined for files over 20 MB", async () => {
    const root = await makeTempDirectory();
    const largeText = join(root, "large.txt");
    await writeFile(largeText, Buffer.alloc(20 * 1024 * 1024 + 1));

    await expect(extractSnippet(largeText)).resolves.toBeUndefined();
  });

  it("extracts text from a tiny PDF and DOCX", async () => {
    const root = await makeTempDirectory();
    const pdfPath = join(root, "tiny.pdf");
    const docxPath = join(root, "tiny.docx");
    const docxFixture = fileURLToPath(new URL("./fixtures/tiny.docx", import.meta.url));
    await writeFile(pdfPath, await createTinyPdf());
    await writeFile(docxPath, await readFile(docxFixture));

    await expect(extractSnippet(pdfPath)).resolves.toContain("Tiny PDF snippet");
    await expect(extractSnippet(docxPath)).resolves.toBeTruthy();
  });
});
