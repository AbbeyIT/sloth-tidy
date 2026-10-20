/** Parsed user steering rules. The YAML loader is part of milestone 6. */
export type Rules = string | {
  folders?: string[];
  naming?: string;
  never_touch?: string[];
  notes?: string;
};

import { DEFAULT_CATEGORIES } from "./decide.js";

/** Read the category vocabulary without requiring the milestone 6 YAML loader. */
export function categoriesFromRules(rules?: Rules): string[] {
  let folders: string[] | undefined;
  if (typeof rules === "string") {
    const match = rules.match(/^folders:\s*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)*)/m);
    folders = match?.[1]?.split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  } else {
    folders = rules?.folders;
  }
  const result = [...new Set((folders ?? []).map((folder) => folder.trim()).filter(Boolean))];
  return result.length ? result : [...DEFAULT_CATEGORIES];
}

// Milestone 6 stub: load user steering rules.
