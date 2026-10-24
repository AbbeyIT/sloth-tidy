import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { categoriesFromRules, loadRulesFile, loadRulesForFolder, matchingNeverTouch, matchingOverride, validateRules } from "../src/rules.js";

let temporary = "";
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

describe("rules.yaml", () => {
  it("loads and validates the sample demo rules", async () => {
    const rules = await loadRulesFile("rules.example.yaml");
    expect(rules.overrides).toEqual([
      { match: "worksheet*.docx", category: "School" },
      { match: "Screenshot*.png", category: "Images" },
    ]);
    expect(categoriesFromRules(rules)).toContain("Personal");
    expect(matchingOverride("worksheet_fractions.docx", rules)?.category).toBe("School");
    expect(matchingOverride("Screenshot 2026-10-03.png", rules)?.category).toBe("Images");
    expect(matchingNeverTouch("download.part", rules)).toBe("*.part");
  });

  it("loads <folder>/rules.yaml automatically and explicit files take precedence", async () => {
    temporary = await mkdtemp(join(tmpdir(), "sloth-rules-"));
    const root = join(temporary, "folder");
    await mkdir(root);
    await writeFile(join(root, "rules.yaml"), "folders:\n  - Home\nnotes: Keep home files together\n");
    const auto = await loadRulesForFolder(root);
    expect(auto?.folders).toEqual(["Home"]);
    const explicitPath = join(temporary, "custom.yaml");
    await writeFile(explicitPath, "folders:\n  - Work\n");
    expect((await loadRulesForFolder(root, explicitPath))?.folders).toEqual(["Work"]);
  });

  it("warns and ignores unsupported naming styles", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rules = validateRules({ naming: "spaces and folders" });
    expect(rules.naming).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring unsupported rules.naming"));
    warn.mockRestore();
  });
});
