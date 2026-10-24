import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI", () => {
  it("creates a plan for an empty folder without requiring Ollama", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "sloth-cli-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "plan", temporary, "--out", join(temporary, "plan.json")], {
        cwd: process.cwd(), encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Planned: 0  Skipped: 0");
      expect(result.stderr).toBe("");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("limits planning to the first N sorted files", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "sloth-limit-"));
    const folder = join(temporary, "folder");
    const plan = join(temporary, "plan.json");
    await mkdir(folder);
    await writeFile(join(folder, "a.png"), "image");
    await writeFile(join(folder, "b.png"), "image");
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "plan", folder, "--out", plan, "--limit", "1"], {
        cwd: process.cwd(), encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(await readFile(plan, "utf8")).items.map((item: { from: string }) => item.from)).toEqual(["a.png"]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
