#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ensures package.json and jsr.json share one version, and (when GITHUB_REF_NAME
 * or --tag is set) that version matches the release tag (vX.Y.Z or X.Y.Z).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): { version?: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { version?: string };
}

function tagVersion(raw: string): string {
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

const pkg = readJson(join(root, "package.json"));
const jsr = readJson(join(root, "jsr.json"));

if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  console.error("package.json is missing version");
  process.exit(1);
}
if (typeof jsr.version !== "string" || jsr.version.length === 0) {
  console.error("jsr.json is missing version");
  process.exit(1);
}
if (pkg.version !== jsr.version) {
  console.error(`version mismatch: package.json=${pkg.version} jsr.json=${jsr.version}`);
  process.exit(1);
}

const tagArg = process.argv.find((a) => a.startsWith("--tag="))?.slice("--tag=".length);
const ref = tagArg ?? process.env.GITHUB_REF_NAME ?? "";
if (ref.length > 0) {
  const expected = tagVersion(ref);
  if (expected !== pkg.version) {
    console.error(`tag ${ref} does not match package version ${pkg.version}`);
    process.exit(1);
  }
}

console.log(`versions ok: ${pkg.version}${ref ? ` (tag ${ref})` : ""}`);
