// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path";
import { classify } from "./classify";
import type { Ctx } from "./env";
import type { Hit, ViewName } from "./types";

const STABLE_DIRS_UNDER_HOME = [
  ".local/share/fnm/aliases/default/bin",
  ".fnm/aliases/default/bin",
  ".volta/bin",
  ".bun/bin",
  ".deno/bin",
  ".local/share/pnpm",
  ".npm-global/bin",
  ".local/bin",
  ".cargo/bin",
  ".asdf/shims",
  ".local/share/mise/shims",
];

const SYSTEM_DIRS = ["/usr/local/bin", "/usr/bin"];

const HIT_ORDER: readonly ViewName[] = ["interactive", "login", "exec", "exec-zsh", "here"];

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** nvm's default alias if it matches an installed version, else the newest one. */
export function nvmDefaultBin(ctx: Ctx): string | null {
  const base = posix.join(ctx.home, ".nvm");
  const versions = ctx.fs.readDir(posix.join(base, "versions/node")).sort(compareVersions);
  if (versions.length === 0) return null;
  const alias = ctx.fs.readText(posix.join(base, "alias/default"))?.trim().replace(/^v/, "");
  const matching = alias ? versions.filter((v) => v.replace(/^v/, "").startsWith(alias)) : [];
  const chosen = matching.length > 0 ? matching[matching.length - 1]! : versions[versions.length - 1]!;
  return posix.join(base, "versions/node", chosen, "bin");
}

export function knownDirs(ctx: Ctx): string[] {
  const dirs: string[] = [];
  const nvm = nvmDefaultBin(ctx);
  if (nvm !== null) dirs.push(nvm);
  for (const rel of STABLE_DIRS_UNDER_HOME) dirs.push(posix.join(ctx.home, rel));
  return [...dirs, ...SYSTEM_DIRS];
}

/** A Linux build of `tool`: first any view that already found one, then the known manager dirs. */
export function findLinuxCandidate(
  tool: string,
  hits: Partial<Record<ViewName, Hit>>,
  ctx: Ctx,
): string | null {
  for (const view of HIT_ORDER) {
    const hit = hits[view];
    if (hit && hit.verdict === "linux" && hit.path !== null) return hit.path;
  }
  for (const dir of knownDirs(ctx)) {
    const file = posix.join(dir, tool);
    if (ctx.fs.exists(file) && classify(file, ctx.mountRoot) === "linux") return file;
  }
  return null;
}
