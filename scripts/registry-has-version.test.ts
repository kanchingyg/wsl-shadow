// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registryHasVersion } from "./registry-has-version";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/registry-has-version.ts");

describe("registryHasVersion", () => {
  test("npm: version present", async () => {
    const r = await registryHasVersion("npm", "wsl-shadow", "0.1.0", {
      npmJson: JSON.stringify({ version: "0.1.0" }),
    });
    expect(r).toEqual({ exists: true, error: null });
  });

  test("npm: 404 is missing, not an error", async () => {
    const r = await registryHasVersion("npm", "wsl-shadow", "9.9.9", { npmStatus: 404 });
    expect(r).toEqual({ exists: false, error: null });
  });

  test("npm: non-404 HTTP is a hard error", async () => {
    const r = await registryHasVersion("npm", "wsl-shadow", "0.1.0", { npmStatus: 500 });
    expect(r.exists).toBe(false);
    expect(r.error).toContain("500");
  });

  test("jsr: version present in meta.versions", async () => {
    const r = await registryHasVersion("jsr", "@kanchingyg/wsl-shadow", "0.1.0", {
      jsrJson: JSON.stringify({ versions: { "0.1.0": {} } }),
    });
    expect(r).toEqual({ exists: true, error: null });
  });

  test("jsr: package 404 is missing", async () => {
    const r = await registryHasVersion("jsr", "@kanchingyg/wsl-shadow", "0.1.0", { jsrStatus: 404 });
    expect(r).toEqual({ exists: false, error: null });
  });

  test("cli exit codes match the contract", () => {
    const present = Bun.spawnSync(
      ["bun", "run", script, "npm", "wsl-shadow", "0.1.0", "--npm-json={\"version\":\"0.1.0\"}"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(present.exitCode).toBe(0);

    const missing = Bun.spawnSync(["bun", "run", script, "npm", "wsl-shadow", "9.9.9", "--npm-status=404"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missing.exitCode).toBe(1);

    const hard = Bun.spawnSync(["bun", "run", script, "jsr", "@kanchingyg/wsl-shadow", "0.1.0", "--jsr-status=500"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(hard.exitCode).toBe(2);
  });
});
