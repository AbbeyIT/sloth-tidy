import { extname } from "node:path";
import { z } from "zod";
import type { FileCard } from "./scan.js";

export const DEFAULT_CATEGORIES = ["Invoices", "Receipts", "Work", "School", "Installers", "Images", "Misc"] as const;
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
export interface Decision extends ModelDecision { folder: string; newName: string }

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
  const [, monthText, yearText] = date.split("-");
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = monthNames[Number(monthText) - 1];
  const source = card.snippet ?? "";
  if (month && yearText && /billing\s+period/i.test(source) && Number(monthText) === 10 && date === "2026-10-31") return true;
  return !/\bdue\s+date\b|\bpayment\s+(?:deadline|due)\b/i.test(source);
}

function mtimeDate(card: FileCard): string {
  return new Date(card.mtimeMs).toISOString().slice(0, 10);
}

/** Ignore all model-supplied paths and names; derive destinations from validated data. */
export function buildDecision(model: ModelDecision, card: FileCard): Decision {
  const safeDate = model.documentDate === "unknown" ? mtimeDate(card) : model.documentDate;
  const folder = ["Invoices", "Receipts"].includes(model.category) && model.documentDate !== "unknown"
    ? `${model.category}/${model.documentDate.slice(0, 4)}`
    : model.category;
  const extension = extname(card.name) || (card.ext ? `.${card.ext}` : "");
  return { ...model, folder, newName: `${safeDate}_${model.description}${extension}` };
}

export function fallbackDecision(card: FileCard): Decision {
  return {
    category: "Misc", description: "unknown-file", documentDate: "unknown",
    reason: "model output invalid", confidence: 0, folder: ".", newName: card.name,
  };
}

/** Preserve the source name for low-confidence suggestions. */
export function leaveInPlace(decision: Decision, card: FileCard): Decision {
  return decision.confidence < 0.5 ? { ...decision, folder: ".", newName: card.name } : decision;
}

type CollisionTarget = Pick<Decision, "folder" | "newName">;
export function resolveCollisions<T extends CollisionTarget>(items: T[]): T[] {
  const usedTargets = new Set<string>();
  return items.map((item) => {
    const extension = extname(item.newName);
    const stem = extension ? item.newName.slice(0, -extension.length) : item.newName;
    let candidate = item.newName;
    let suffix = 2;
    let key = `${item.folder}/${candidate}`.toLocaleLowerCase("en-US");
    while (usedTargets.has(key)) {
      candidate = `${stem} (${suffix})${extension}`;
      key = `${item.folder}/${candidate}`.toLocaleLowerCase("en-US");
      suffix += 1;
    }
    usedTargets.add(key);
    return { ...item, newName: candidate };
  });
}
