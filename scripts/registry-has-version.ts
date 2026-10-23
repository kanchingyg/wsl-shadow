#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Exit 0 if the package version is already published; 1 if missing; 2 on hard error.
 *
 *   bun run scripts/registry-has-version.ts npm wsl-shadow 0.1.0
 *   bun run scripts/registry-has-version.ts jsr @kanchingyg/wsl-shadow 0.1.0
 *
 * Optional test hooks (inject instead of the network):
 *   --npm-json='{"version":"0.1.0"}'   --jsr-json='{"versions":{"0.1.0":{}}}'
 *   --npm-status=404                  --jsr-status=404
 */
export type Registry = "npm" | "jsr";

export interface ProbeResult {
  exists: boolean;
  error: string | null;
}

export interface ProbeOverrides {
  npmJson?: string | null;
  npmStatus?: number;
  jsrJson?: string | null;
  jsrStatus?: number;
}

export async function probeNpm(name: string, version: string, overrides: ProbeOverrides = {}): Promise<ProbeResult> {
  if (overrides.npmStatus !== undefined) {
    if (overrides.npmStatus === 404) return { exists: false, error: null };
    if (overrides.npmStatus >= 400) return { exists: false, error: `npm HTTP ${overrides.npmStatus}` };
  }
  if (overrides.npmJson !== undefined) {
    if (overrides.npmJson === null) return { exists: false, error: null };
    try {
      const body = JSON.parse(overrides.npmJson) as { version?: string };
      return { exists: body.version === version, error: null };
    } catch (error) {
      return { exists: false, error: `npm JSON: ${String(error)}` };
    }
  }
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (res.status === 404) return { exists: false, error: null };
    if (!res.ok) return { exists: false, error: `npm HTTP ${res.status}` };
    const body = (await res.json()) as { version?: string };
    return { exists: body.version === version, error: null };
  } catch (error) {
    return { exists: false, error: String(error) };
  }
}

export async function probeJsr(name: string, version: string, overrides: ProbeOverrides = {}): Promise<ProbeResult> {
  if (overrides.jsrStatus !== undefined) {
    if (overrides.jsrStatus === 404) return { exists: false, error: null };
    if (overrides.jsrStatus >= 400) return { exists: false, error: `JSR HTTP ${overrides.jsrStatus}` };
  }
  if (overrides.jsrJson !== undefined) {
    if (overrides.jsrJson === null) return { exists: false, error: null };
    try {
      const body = JSON.parse(overrides.jsrJson) as { versions?: Record<string, unknown> };
      return { exists: Boolean(body.versions?.[version]), error: null };
    } catch (error) {
      return { exists: false, error: `JSR JSON: ${String(error)}` };
    }
  }
  const path = name.startsWith("@") ? name : `@${name}`;
  try {
    const res = await fetch(`https://jsr.io/${path}/meta.json`);
    if (res.status === 404) return { exists: false, error: null };
    if (!res.ok) return { exists: false, error: `JSR HTTP ${res.status}` };
    const body = (await res.json()) as { versions?: Record<string, unknown> };
    return { exists: Boolean(body.versions?.[version]), error: null };
  } catch (error) {
    return { exists: false, error: String(error) };
  }
}

export async function registryHasVersion(
  registry: Registry,
  name: string,
  version: string,
  overrides: ProbeOverrides = {},
): Promise<ProbeResult> {
  switch (registry) {
    case "npm":
      return probeNpm(name, version, overrides);
    case "jsr":
      return probeJsr(name, version, overrides);
    default: {
      const unreachable: never = registry;
      return { exists: false, error: `unknown registry: ${String(unreachable)}` };
    }
  }
}

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
}

async function main(argv: string[]): Promise<number> {
  const registry = argv[0] as Registry | undefined;
  const name = argv[1];
  const version = argv[2];
  if (registry !== "npm" && registry !== "jsr") {
    console.error("usage: registry-has-version.ts <npm|jsr> <name> <version>");
    return 2;
  }
  if (!name || !version) {
    console.error("usage: registry-has-version.ts <npm|jsr> <name> <version>");
    return 2;
  }

  const overrides: ProbeOverrides = {};
  const npmJson = argValue(argv, "--npm-json");
  const jsrJson = argValue(argv, "--jsr-json");
  const npmStatus = argValue(argv, "--npm-status");
  const jsrStatus = argValue(argv, "--jsr-status");
  if (npmJson !== undefined) overrides.npmJson = npmJson === "null" ? null : npmJson;
  if (jsrJson !== undefined) overrides.jsrJson = jsrJson === "null" ? null : jsrJson;
  if (npmStatus !== undefined) overrides.npmStatus = Number(npmStatus);
  if (jsrStatus !== undefined) overrides.jsrStatus = Number(jsrStatus);

  const result = await registryHasVersion(registry, name, version, overrides);
  if (result.error !== null) {
    console.error(result.error);
    return 2;
  }
  if (result.exists) {
    console.log(`${registry} has ${name}@${version}`);
    return 0;
  }
  console.log(`${registry} missing ${name}@${version}`);
  return 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
