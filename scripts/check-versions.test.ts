// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/check-versions.ts");

describe("check-versions", () => {
  test("package.json and jsr.json match on this tree", () => {
    const result = Bun.spawnSync(["bun", "run", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("versions ok:");
  });

  test("fails when --tag disagrees with package.json", () => {
    const result = Bun.spawnSync(["bun", "run", script, "--tag=v9.9.9"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("does not match");
  });
});
