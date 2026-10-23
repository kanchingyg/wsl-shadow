// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions, releaseTagToCheck } from "./check-versions";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/check-versions.ts");
const pkgVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

describe("releaseTagToCheck", () => {
  test("branch refs do not require a tag match", () => {
    expect(releaseTagToCheck([], { GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" })).toBeNull();
    expect(releaseTagToCheck([], { GITHUB_REF: "refs/heads/master", GITHUB_REF_NAME: "master" })).toBeNull();
    expect(releaseTagToCheck([], { GITHUB_REF: "refs/pull/1/merge", GITHUB_REF_NAME: "1/merge" })).toBeNull();
  });

  test("refs/tags/v* requires the tag name", () => {
    expect(
      releaseTagToCheck([], { GITHUB_REF: "refs/tags/v0.1.0", GITHUB_REF_NAME: "v0.1.0" }),
    ).toBe("v0.1.0");
  });

  test("--tag= always wins over a branch env", () => {
    expect(
      releaseTagToCheck(["--tag=v9.9.9"], { GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" }),
    ).toBe("v9.9.9");
  });
});

describe("checkVersions", () => {
  test("matching package and jsr versions pass without a tag", () => {
    expect(checkVersions("0.1.0", "0.1.0", null)).toEqual({ ok: true, message: "versions ok: 0.1.0" });
  });

  test("matching tag v+version passes", () => {
    expect(checkVersions("0.1.0", "0.1.0", "v0.1.0").ok).toBe(true);
  });

  test("tag mismatch fails", () => {
    const r = checkVersions("0.1.0", "0.1.0", "v9.9.9");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("does not match");
  });

  test("package/jsr mismatch fails even without a tag", () => {
    const r = checkVersions("0.1.0", "0.2.0", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("version mismatch");
  });
});

function cliEnv(over: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GITHUB_REF;
  delete env.GITHUB_REF_NAME;
  return { ...env, ...over };
}

describe("check-versions CLI", () => {
  test("package.json and jsr.json match on this tree", () => {
    const result = Bun.spawnSync(["bun", "run", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: cliEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("versions ok:");
  });

  test('branch "main" passes when package and jsr versions match', () => {
    const result = Bun.spawnSync(["bun", "run", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: cliEnv({ GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" }),
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(`versions ok: ${pkgVersion}`);
    expect(new TextDecoder().decode(result.stderr)).not.toContain("does not match");
  });

  test("fails when --tag disagrees with package.json", () => {
    const result = Bun.spawnSync(["bun", "run", script, "--tag=v9.9.9"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: cliEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("does not match");
  });

  test("fails when GITHUB_REF is a mismatched release tag", () => {
    const result = Bun.spawnSync(["bun", "run", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: cliEnv({ GITHUB_REF: "refs/tags/v9.9.9", GITHUB_REF_NAME: "v9.9.9" }),
    });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("does not match");
  });
});
