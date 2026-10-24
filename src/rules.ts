import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import picomatch from "picomatch";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_CATEGORIES } from "./decide.js";

export interface RuleOverride { match: string; category: string }
export interface Rules {
  folders?: string[];
  naming?: string;
  never_touch?: string[];
  overrides?: RuleOverride[];
  notes?: string;
}

const globSchema = z.string().trim().min(1, "glob pattern must not be empty").refine((pattern) => {
  try { picomatch.makeRe(pattern); return true; } catch { return false; }
}, "invalid glob pattern");

const rawRulesSchema = z.object({
  folders: z.array(z.string().trim().min(1)).min(1).optional(),
  naming: z.string().optional(),
  never_touch: z.array(globSchema).optional(),
  overrides: z.array(z.object({ match: globSchema, category: z.string().trim().min(1) }).strict()).optional(),
  notes: z.string().max(500).optional(),
}).strict();

export const rulesSchema = rawRulesSchema.superRefine((rules, context) => {
  if (rules.folders && new Set(rules.folders).size !== rules.folders.length) {
    context.addIssue({ code: "custom", path: ["folders"], message: "folder categories must be unique" });
  }
  const allowed = rules.folders ?? [...DEFAULT_CATEGORIES];
  rules.overrides?.forEach((override, index) => {
    if (!allowed.includes(override.category)) context.addIssue({
      code: "custom", path: ["overrides", index, "category"], message: `category must be one of: ${allowed.join(", ")}`,
    });
  });
});

export function validateRules(value: unknown): Rules {
  const result = rulesSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "rules"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid rules.yaml: ${details}. Fix: correct the rules fields and category names.`);
  }
  const rules = result.data;
  if (rules.naming && !/^YYYY-MM-DD[_-](?:short-)?description$/i.test(rules.naming)) {
    console.warn(`Ignoring unsupported rules.naming "${rules.naming}"; use YYYY-MM-DD_description.`);
    delete rules.naming;
  }
  return rules;
}

export async function loadRulesFile(path: string): Promise<Rules> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : "file is not readable";
    throw new Error(`Could not read rules file ${path}: ${reason}. Fix: check the path and read permissions.`);
  }
  let parsed: unknown;
  try { parsed = parse(source); }
  catch (error) {
    throw new Error(`Invalid rules.yaml syntax: ${(error as Error).message.split("\n")[0]}. Fix: correct YAML indentation and syntax.`);
  }
  return validateRules(parsed);
}

/** Explicit --rules wins; otherwise use a rules.yaml directly inside root. */
export async function loadRulesForFolder(root: string, explicitPath?: string): Promise<Rules | undefined> {
  if (explicitPath) return loadRulesFile(resolve(explicitPath));
  const candidate = join(resolve(root), "rules.yaml");
  try { await access(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read rules file ${candidate}. Fix: check the folder permissions.`);
  }
  return loadRulesFile(candidate);
}

/** Return the matching never_touch rule, if any. */
export function matchingNeverTouch(name: string, rules?: Rules): string | undefined {
  return rules?.never_touch?.find((pattern) => picomatch(pattern, { nocase: true })(name));
}

/** Return the first matching category override, if any. */
export function matchingOverride(name: string, rules?: Rules): RuleOverride | undefined {
  return rules?.overrides?.find((override) => picomatch(override.match, { nocase: true })(name));
}

/** Use a supplied category list instead of the built-in model enum when present. */
export function categoriesFromRules(rules?: Rules): string[] {
  return rules?.folders?.length ? [...rules.folders] : [...DEFAULT_CATEGORIES];
}

export function rulesPromptText(rules?: Rules): string {
  if (!rules) return "";
  const lines: string[] = [];
  if (rules.folders) lines.push("folders:", ...rules.folders.map((folder) => `  - ${folder}`));
  if (rules.naming) lines.push(`naming: ${rules.naming}`);
  if (rules.never_touch) lines.push("never_touch:", ...rules.never_touch.map((pattern) => `  - ${pattern}`));
  if (rules.overrides) lines.push("overrides:", ...rules.overrides.map(({ match, category }) => `  - match: ${match}\n    category: ${category}`));
  if (rules.notes) lines.push(`notes: ${rules.notes}`);
  return lines.join("\n");
}
