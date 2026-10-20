import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const target = join(process.cwd(), "demo", "messy");

const fileNames = [
  "scan0012.pdf",
  "Document (3).docx",
  "invoice_meralco_2026-10.pdf",
  "receipt_grocery_2026-09.txt",
  "school_notes_biology.md",
  "IMG_20260401.jpg",
  "setup_printer.exe",
  "meeting-notes-final-final.txt",
  "receipt_coffee.png",
  "invoice_acme_1042.pdf",
  "worksheet_fractions.docx",
  "photo_trip_01.png",
  "installer_vscode.exe",
  "scan0013.pdf",
  "Document (4).docx",
  "receipt_pharmacy_2026-08.txt",
  "invoice_water_2026-10.pdf",
  "class_schedule_fall.csv",
  "IMG_20260512.jpg",
  "download.part",
  "budget_notes.txt",
  "receipt_hardware_2026-07.pdf",
  "homework_history.md",
  "setup_audio_driver.msi",
  "scan0014.pdf",
  "presentation_draft.pptx",
  "recipe_pancakes.txt",
  "invoice_phone_2026-09.pdf",
  "Screenshot 2026-10-03.png",
  "Document (5).docx",
];

const imageExtensions = new Set([".jpg", ".png"]);
const placeholderImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a3sAAAAASUVORK5CYII=",
  "base64",
);

await mkdir(target, { recursive: true });

for (const name of fileNames) {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const destination = join(target, name);

  if (imageExtensions.has(extension)) {
    await writeFile(destination, placeholderImage);
  } else if (extension === ".txt" || extension === ".md" || extension === ".csv") {
    await writeFile(destination, `${name}\nDemo content for Sloth Tidy.\n`);
  } else {
    await writeFile(destination, Buffer.alloc(0));
  }
}

console.log(`Generated ${fileNames.length} deterministic demo files in ${target}`);
