#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ensures package.json and jsr.json share one version.
 * On release tags (refs/tags/v*), also requires the tag name to be "v" + that version.
 * Branch pushes and PRs only compare the two package files — GITHUB_REF_NAME is ignored.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): { version?: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { version?: string };
}

/**
 * Tag name to enforce, or null when only package/jsr alignment is required.
 * `--tag=` always counts (tests / local). Otherwise only `refs/tags/v*` from GITHUB_REF.
 */
export function releaseTagToCheck(
  argv: readonly string[],
  env: { GITHUB_REF?: string; GITHUB_REF_NAME?: string },
): string | null {
  const tagArg = argv.find((a) => a.startsWith("--tag="))?.slice("--tag=".length);
  if (tagArg !== undefined) return tagArg;
  const ref = env.GITHUB_REF ?? "";
  if (!/^refs\/tags\/v/.test(ref)) return null;
  return env.GITHUB_REF_NAME ?? ref.slice("refs/tags/".length);
}

export function checkVersions(
  pkgVersion: string,
  jsrVersion: string,
  tag: string | null,
): { ok: true; message: string } | { ok: false; message: string } {
  if (pkgVersion.length === 0) return { ok: false, message: "package.json is missing version" };
  if (jsrVersion.length === 0) return { ok: false, message: "jsr.json is missing version" };
  if (pkgVersion !== jsrVersion) {
    return { ok: false, message: `version mismatch: package.json=${pkgVersion} jsr.json=${jsrVersion}` };
  }
  if (tag !== null) {
    const expected = `v${pkgVersion}`;
    if (tag !== expected) {
      return { ok: false, message: `tag ${tag} does not match package version ${pkgVersion} (expected ${expected})` };
    }
    return { ok: true, message: `versions ok: ${pkgVersion} (tag ${tag})` };
  }
  return { ok: true, message: `versions ok: ${pkgVersion}` };
}

function main(argv: string[], env: NodeJS.ProcessEnv): number {
  const pkg = readJson(join(root, "package.json"));
  const jsr = readJson(join(root, "jsr.json"));
  const tag = releaseTagToCheck(argv, env);
  const result = checkVersions(
    typeof pkg.version === "string" ? pkg.version : "",
    typeof jsr.version === "string" ? jsr.version : "",
    tag,
  );
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }
  console.log(result.message);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), process.env));
}
