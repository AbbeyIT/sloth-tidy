import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";

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

const textContents: Record<string, string> = {
  "receipt_grocery_2026-09.txt": [
    "FRESHMART • Quezon City • 2026-09-18 18:42",
    "Bananas 1.2 kg                         PHP 96.00",
    "Rice, jasmine 2 kg                     PHP 178.00",
    "Eggs, dozen                            PHP 112.00",
    "TOTAL                                  PHP 386.00 • Card",
  ].join("\n"),
  "school_notes_biology.md": [
    "# Biology — Cell Membranes",
    "The phospholipid bilayer separates the cell from its surroundings.",
    "Hydrophilic heads face water; hydrophobic tails point inward.",
    "Diffusion moves particles down a concentration gradient without energy.",
    "Review: compare osmosis with facilitated diffusion before Friday's quiz.",
  ].join("\n"),
  "meeting-notes-final-final.txt": [
    "Customer portal check-in — 2026-10-12",
    "Decision: move the beta review from Tuesday to Thursday afternoon.",
    "Mina: send the revised onboarding copy by October 14.",
    "Joel: confirm the staging access list with IT before the review.",
    "Next meeting: October 19, 10:00 AM; bring the open bug list.",
  ].join("\n"),
  "receipt_pharmacy_2026-08.txt": [
    "Southside Pharmacy • 2026-08-22 11:16 • Receipt 581204",
    "Cetirizine 10 mg, 10 tablets           PHP 84.50",
    "Vitamin C 500 mg, 30 tablets          PHP 132.00",
    "Subtotal PHP 216.50   VAT PHP 25.98   Paid by card",
    "Thank you. Keep this receipt for returns within 7 days.",
  ].join("\n"),
  "budget_notes.txt": [
    "October household budget",
    "Rent and utilities: PHP 18,500 (due Oct 5)",
    "Groceries: PHP 7,000 planned; PHP 2,140 spent so far",
    "Transit: reload PHP 1,200 on payday",
    "Set aside PHP 3,000 for the laptop repair fund",
  ].join("\n"),
  "homework_history.md": [
    "# Philippine History — Homework",
    "Read: Teodoro Agoncillo, The Revolt of the Masses, chapter 2.",
    "The Propaganda Movement used essays and newspapers to seek reforms.",
    "Compare the goals of La Liga Filipina with the Katipunan.",
    "Due Wednesday: one-page timeline with three primary-source citations.",
  ].join("\n"),
  "class_schedule_fall.csv": [
    "Day,Time,Course,Room",
    "Monday,08:00-09:30,Biology 101,Science 204",
    "Tuesday,10:00-11:30,World History,Main 12",
    "Wednesday,08:00-09:30,Biology 101,Science 204",
    "Friday,13:00-15:00,English Composition,Library 3",
  ].join("\n"),
  "recipe_pancakes.txt": [
    "Fluffy banana pancakes — makes 6",
    "Whisk 1 cup flour, 1 tsp baking powder, and a pinch of salt.",
    "Mash 1 ripe banana; mix with 1 egg and 3/4 cup milk.",
    "Fold wet mixture into dry ingredients; rest batter for 5 minutes.",
    "Cook on a lightly oiled pan until bubbles form, then flip and brown.",
  ].join("\n"),
};

const pdfDocuments: Record<string, { title: string; lines: string[] }> = {
  "scan0012.pdf": {
    title: "Meralco Electricity Bill — October 2026",
    lines: [
      "MERALCO | Statement of Account | Billing period: 01–31 October 2026",
      "Customer: Ana Reyes     Service ID: 0123-4567-8901",
      "Service address: 24 Sampaguita Street, Quezon City",
      "Previous balance PHP 1,842.10 | Payment received PHP 1,842.10",
      "Current charges PHP 2,176.44 | Due date: 05 November 2026",
      "Pay through the Meralco app, a payment center, or your bank.",
    ],
  },
  "invoice_meralco_2026-10.pdf": {
    title: "Meralco Electricity Invoice — October 2026",
    lines: [
      "MERALCO | Electric service invoice | October 2026",
      "Account holder: Ana Reyes | Account no. 0123-4567-8901",
      "Meter reading 18,442 kWh; previous reading 18,211 kWh.",
      "Energy, delivery, taxes and other charges: PHP 2,176.44",
      "Amount due by 05 November 2026: PHP 2,176.44",
    ],
  },
  "invoice_acme_1042.pdf": {
    title: "Acme Office Supply Invoice 1042",
    lines: [
      "ACME OFFICE SUPPLY | INVOICE 1042 | 2026-10-08",
      "Bill to: Northstar Design Studio, Makati City",
      "A4 copier paper, 5 reams × PHP 245.00       PHP 1,225.00",
      "Black toner cartridge, 2 × PHP 1,890.00     PHP 3,780.00",
      "Total due PHP 5,005.00 | Due 07 November 2026 | Terms: Net 30",
    ],
  },
  "scan0013.pdf": {
    title: "Southside Pharmacy Receipt",
    lines: [
      "SOUTHSIDE PHARMACY | Receipt 581204 | 22 August 2026",
      "Cetirizine 10 mg, 10 tablets                 PHP 84.50",
      "Vitamin C 500 mg, 30 tablets               PHP 132.00",
      "VAT PHP 25.98 | Total paid PHP 242.48 by debit card",
      "Pharmacist: L. Santos | Returns accepted within 7 days",
    ],
  },
  "invoice_water_2026-10.pdf": {
    title: "Maynilad Water Services Invoice — October 2026",
    lines: [
      "MAYNILAD WATER SERVICES | Invoice dated 12 October 2026",
      "Customer: Ana Reyes | Contract account 4400-2187",
      "Consumption: 18 cubic meters | Reading date: 10 October 2026",
      "Water and wastewater charges PHP 684.20 | Tax PHP 82.10",
      "Total PHP 766.30 | Please pay on or before 28 October 2026",
    ],
  },
  "receipt_hardware_2026-07.pdf": {
    title: "BuildRight Hardware Store Receipt",
    lines: [
      "BUILDRIGHT HARDWARE | Receipt BR-77831 | 16 July 2026",
      "LED bulb, warm white, 4-pack              PHP 389.00",
      "Wall anchors, 10-piece pack               PHP 115.00",
      "Extension cord, 3 m                       PHP 275.00",
      "Total PHP 779.00 | Cash received PHP 1,000.00 | Change PHP 221.00",
    ],
  },
  "scan0014.pdf": {
    title: "Student Enrollment Form — School Year 2026–2027",
    lines: [
      "RIVERSIDE COMMUNITY SCHOOL | ENROLLMENT FORM",
      "School year: 2026–2027 | Grade level: 8",
      "Student: Miguel Santos | Date of birth: 14 March 2013",
      "Parent or guardian: Elena Santos | Contact: 0917-555-0142",
      "Documents received: birth certificate, report card, two ID photos",
      "Registrar review date: 20 October 2026 | Status: Complete",
    ],
  },
  "invoice_phone_2026-09.pdf": {
    title: "Globe Telecom Monthly Statement — September 2026",
    lines: [
      "GLOBE TELECOM | Monthly service statement | September 2026",
      "Subscriber: Ana Reyes | Mobile number ending 4821",
      "Plan 999 PHP 999.00 | International call add-on PHP 120.00",
      "VAT and regulatory fees PHP 134.28 | Total PHP 1,253.28",
      "Due 15 October 2026 | Pay through the GlobeOne app",
    ],
  },
};

const wordDocuments: Record<string, { title: string; lines: string[] }> = {
  "Document (3).docx": {
    title: "Application for Junior Accounts Assistant",
    lines: [
      "Dear Hiring Manager,",
      "I am applying for the Junior Accounts Assistant position at Harbor & Pine.",
      "My bookkeeping coursework and internship taught me to reconcile invoices carefully and meet month-end deadlines.",
      "I would welcome the chance to support your finance team and learn your reporting process.",
      "Sincerely,\nLara Mendoza\nlara.mendoza@example.test | 0917-555-0182",
    ],
  },
  "Document (4).docx": {
    title: "Product Launch Planning — Meeting Minutes",
    lines: [
      "Meeting: Product launch planning | 13 October 2026 | 2:00 PM",
      "Attendees: N. Cruz, P. Lim, A. Garcia | Location: Conference Room B",
      "Decision: release the customer portal beta to 20 pilot users on 2 November.",
      "Action: Paolo to finish the support guide by 21 October; Ana to confirm pilot accounts by 23 October.",
      "Next check-in: 26 October at 10:00 AM. Open risk: translation review is not yet scheduled.",
    ],
  },
  "Document (5).docx": {
    title: "Apartment Lease Summary — Unit 4B",
    lines: [
      "Property: 18 Mabini Avenue, Apartment 4B, Quezon City",
      "Tenant: Elena Santos | Landlord: Mabini Homes Cooperative",
      "Lease term: 1 November 2026 through 31 October 2027; monthly rent PHP 18,500.",
      "Security deposit: PHP 37,000. Rent is due on the fifth day of each month.",
      "Utilities are billed separately; tenant provides 30 days' notice before moving out.",
    ],
  },
  "worksheet_fractions.docx": {
    title: "Math Practice — Fractions and Mixed Numbers",
    lines: [
      "Name: ____________________    Date: ____________________",
      "1. Simplify 12/18.     2. Write 7/4 as a mixed number.",
      "3. Add 2/3 + 1/6.     4. Subtract 5/8 − 1/4.",
      "5. A recipe uses 3/4 cup of milk. How much for half a recipe?",
      "Show your work. Reduce every answer to lowest terms.",
    ],
  },
};

const imageExtensions = new Set([".jpg", ".png"]);
const placeholderImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a3sAAAAASUVORK5CYII=",
  "base64",
);
const fixedCreationDate = new Date("2026-10-20T00:00:00.000Z");

async function createPdf(title: string, lines: string[]): Promise<Buffer> {
  const document = new PDFDocument({
    info: {
      Title: title,
      Author: "Sloth Tidy Demo",
      CreationDate: fixedCreationDate,
      ModDate: fixedCreationDate,
    },
  });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });

  document.fontSize(18).text(title, { underline: true });
  document.moveDown();
  document.fontSize(11).text(lines.join("\n"), { lineGap: 5 });
  document.end();
  return complete;
}

async function createDocx(title: string, lines: string[]): Promise<Buffer> {
  const document = new Document({
    creator: "Sloth Tidy Demo",
    lastModifiedBy: "Sloth Tidy Demo",
    title,
    sections: [{
      children: [
        new Paragraph({ text: title, heading: "Title" }),
        ...lines.map((line) => new Paragraph({ text: line })),
      ],
    }],
  });
  const packed = await Packer.toBuffer(document);
  const sourceArchive = await JSZip.loadAsync(packed);
  const deterministicArchive = new JSZip();

  for (const [path, entry] of Object.entries(sourceArchive.files)) {
    if (entry.dir) continue;
    let contents = await entry.async("nodebuffer");
    if (path === "docProps/core.xml") {
      const coreProperties = contents.toString("utf8").replace(
        /(<dcterms:(?:created|modified)\b[^>]*>)[\s\S]*?(<\/dcterms:(?:created|modified)>)/g,
        `$1${fixedCreationDate.toISOString()}$2`,
      );
      contents = Buffer.from(coreProperties, "utf8");
    }
    deterministicArchive.file(path, contents, { binary: true, date: fixedCreationDate });
  }

  const buffer = await deterministicArchive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  normalizeZipTimestamps(buffer);
  return buffer;
}

function normalizeZipTimestamps(buffer: Buffer): void {
  const fixedDosDate = ((2026 - 1980) << 9) | (10 << 5) | 20;
  const endRecordSignature = 0x06054b50;
  let endRecordOffset = -1;

  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === endRecordSignature) {
      endRecordOffset = offset;
      break;
    }
  }
  if (endRecordOffset < 0) throw new Error("Generated DOCX ZIP has no end record.");

  const entryCount = buffer.readUInt16LE(endRecordOffset + 10);
  let centralOffset = buffer.readUInt32LE(endRecordOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error("Generated DOCX ZIP has an invalid central directory.");
    }

    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    buffer.writeUInt16LE(0, centralOffset + 12);
    buffer.writeUInt16LE(fixedDosDate, centralOffset + 14);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Generated DOCX ZIP has an invalid local file header.");
    }
    buffer.writeUInt16LE(0, localOffset + 10);
    buffer.writeUInt16LE(fixedDosDate, localOffset + 12);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
}

await mkdir(target, { recursive: true });

for (const name of fileNames) {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const destination = join(target, name);

  if (imageExtensions.has(extension)) {
    await writeFile(destination, placeholderImage);
  } else if (textContents[name]) {
    await writeFile(destination, `${textContents[name]}\n`);
  } else if (pdfDocuments[name]) {
    const { title, lines } = pdfDocuments[name];
    await writeFile(destination, await createPdf(title, lines));
  } else if (wordDocuments[name]) {
    const { title, lines } = wordDocuments[name];
    await writeFile(destination, await createDocx(title, lines));
  } else {
    await writeFile(destination, Buffer.alloc(0));
  }
}

console.log(`Generated ${fileNames.length} deterministic demo files in ${target}`);
