import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI scaffold", () => {
  it("prints the placeholder for plan", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "plan", "demo/messy"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not implemented yet");
  });
});
