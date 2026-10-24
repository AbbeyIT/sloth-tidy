import { extname } from "node:path";
import { z } from "zod";
import type { FileCard } from "./scan.js";

export const DEFAULT_CATEGORIES = ["Invoices", "Receipts", "Work", "School", "Installers", "Images", "Personal", "Misc"] as const;
const descriptionSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine((value) => value.split("-").length >= 2 && value.split("-").length <= 6);
const documentDateSchema = z.string().regex(/^(?:\d{4}-\d{2}-\d{2}|unknown)$/).refine((value) => {
  if (value === "unknown") return true;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});

/** Model response schema. Runtime category validation is supplied from rules.folders. */
export const Decision = z.object({
  category: z.string().min(1).max(80),
  description: descriptionSchema,
  documentDate: documentDateSchema,
  reason: z.string().max(200),
  confidence: z.number().min(0).max(1),
});
export type ModelDecision = z.infer<typeof Decision>;
export interface Decision extends ModelDecision { folder: string; newName: string; dateSource: "document" | "file modified date" | "none" }

export function decisionSchemaFor(categories: readonly string[]) {
  const allowed = categories.length ? categories : [...DEFAULT_CATEGORIES];
  return Decision.extend({ category: z.enum(allowed as [string, ...string[]]) });
}

export function decisionJsonSchema(categories: readonly string[]) {
  const allowed = categories.length ? categories : [...DEFAULT_CATEGORIES];
  return {
    type: "object",
    properties: {
      category: { type: "string", enum: allowed },
      description: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+){1,5}$" },
      documentDate: { type: "string", pattern: "^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|unknown)$" },
      reason: { type: "string", maxLength: 200 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["category", "description", "documentDate", "reason", "confidence"],
    additionalProperties: false,
  } as const;
}

export function hasNonAsciiLetters(value: string): boolean {
  return Array.from(value).some((char) => (char.codePointAt(0) ?? 0) > 127 && /[\p{L}\p{M}]/u.test(char));
}

export function cleanDescription(description: string): string {
  const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
  return description.toLowerCase()
    .replace(new RegExp(`\\b(?:${months})\\b`, "gi"), "-")
    .replace(/\b\d{4}-\d{1,2}\b/g, "-")
    .replace(/\b\d{4}(?:-\d{4})?\b/g, "-")
    .replace(/\b(?:0?[1-9]|1[0-2])\b/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function extensionDecision(card: FileCard): Decision {
  const category = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic"]).has(card.ext)
    ? "Images"
    : new Set(["exe", "msi", "dmg", "pkg"]).has(card.ext) ? "Installers" : "Misc";
  return {
    category, description: "unreadable-file", documentDate: "unknown",
    reason: "no readable content; filed by extension", confidence: 0.6,
    folder: category, newName: card.name, dateSource: "none",
  };
}

/** Accept a model date only when that exact calendar date is visible in source data. */
export function hasVisibleDate(date: string, card: FileCard): boolean {
  if (date === "unknown") return true;
  const [year, month, day] = date.split("-").map(Number);
  const source = `${card.name}\n${card.snippet ?? ""}`;
  if (source.includes(date)) return true;
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = monthNames[month - 1];
  const escapedMonth = monthName;
  const patterns = [
    new RegExp(`\\b0?${day}\\s+${escapedMonth}\\s+${year}\\b`, "i"),
    new RegExp(`\\b${escapedMonth}\\s+0?${day},\\s*${year}\\b`, "i"),
  ];
  if (patterns.some((pattern) => pattern.test(source))) return true;

  // A billing period explicitly contains both endpoint dates. Accept either
  // endpoint as visible while leaving date preference to the prompt/model.
  const rangePattern = /\b(\d{1,2})\s*[\u2013-]\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi;
  for (const match of source.matchAll(rangePattern)) {
    const rangeMonth = monthNames.findIndex((value) => value.toLocaleLowerCase("en-US") === match[3]!.toLocaleLowerCase("en-US")) + 1;
    const rangeYear = Number(match[4]);
    if (rangeMonth === month && rangeYear === year && [Number(match[1]), Number(match[2])].includes(day)) return true;
  }
  return false;
}

/** Billing-period end date is preferred; other visible dates remain valid. */
export function isPreferredDocumentDate(date: string, card: FileCard): boolean {
  if (date === "unknown") return true;
  const [, monthText] = date.split("-");
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = monthNames[Number(monthText) - 1];
  const source = card.snippet ?? "";
  const rangePattern = /\b(\d{1,2})\s*[\u2013-]\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi;
  for (const match of source.matchAll(rangePattern)) {
    if (/billing\s+period/i.test(source) && Number(match[2]) === Number(date.slice(8, 10))
      && match[3]!.toLocaleLowerCase("en-US") === month!.toLocaleLowerCase("en-US") && match[4] === date.slice(0, 4)) return true;
  }
  return !/\bdue\s+date\b|\bpayment\s+(?:deadline|due)\b/i.test(source);
}

function mtimeDate(card: FileCard): string {
  return new Date(card.mtimeMs).toISOString().slice(0, 10);
}

/** Ignore all model-supplied paths and names; derive destinations from validated data. */
export function buildDecision(model: ModelDecision, card: FileCard): Decision {
  const description = cleanDescription(model.description) || "file-document";
  const knownDate = model.documentDate !== "unknown";
  const safeDate = knownDate ? model.documentDate : mtimeDate(card);
  const folder = ["Invoices", "Receipts"].includes(model.category)
    ? `${model.category}/${safeDate.slice(0, 4)}`
    : model.category;
  const extension = extname(card.name) || (card.ext ? `.${card.ext}` : "");
  return { ...model, description, folder, newName: `${safeDate}_${description}${extension}`, dateSource: knownDate ? "document" : "file modified date" };
}

export function fallbackDecision(card: FileCard, failureReason = "model output invalid"): Decision {
  return {
    category: "Misc", description: "unknown-file", documentDate: "unknown",
    reason: `model output invalid: ${failureReason}`.slice(0, 200), confidence: 0, folder: ".", newName: card.name, dateSource: "none",
  };
}

/** Preserve the source name for low-confidence suggestions. */
export function leaveInPlace(decision: Decision, card: FileCard): Decision {
  return decision.confidence < 0.5 ? { ...decision, folder: ".", newName: card.name, dateSource: "none" } : decision;
}

type CollisionTarget = Pick<Decision, "folder" | "newName">;
export function resolveCollisions<T extends CollisionTarget>(items: T[], occupiedTargets: string[] = []): T[] {
  const usedTargets = new Set(occupiedTargets.map((target) => target.replace(/\\/g, "/").toLocaleLowerCase("en-US")));
  const makeKey = (folder: string, name: string) => `${folder === "." ? "" : `${folder}/`}${name}`.toLocaleLowerCase("en-US");
  return items.map((item) => {
    const extension = extname(item.newName);
    const stem = extension ? item.newName.slice(0, -extension.length) : item.newName;
    let candidate = item.newName;
    let suffix = 2;
    let key = makeKey(item.folder, candidate);
    while (usedTargets.has(key)) {
      candidate = `${stem} (${suffix})${extension}`;
      key = makeKey(item.folder, candidate);
      suffix += 1;
    }
    usedTargets.add(key);
    return { ...item, newName: candidate };
  });
}
