// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path";
import { classify } from "./classify";
import type { Ctx } from "./env";
import { PROBE_COMMANDS } from "./tools";
import type { NpmPrefixInfo, Probe, ViewName } from "./types";
import { EXEC_SCRIPT, launchFor, runLaunch } from "./views";

/** Output that only a Windows build produces. */
export function looksWindows(output: string): boolean {
  return (
    /^[A-Za-z]:\\/.test(output) ||
    output.startsWith("\\\\") ||
    /^win32$/i.test(output) ||
    /\bwindows\b/i.test(output)
  );
}

/** Read-only probes, run in the view that failed. Each has its own timeout. */
export function runProbes(tool: string, view: ViewName, ctx: Ctx): Probe[] {
  const commands = PROBE_COMMANDS[tool] ?? [];
  return commands.map((cmd) => {
    const outcome = runLaunch(launchFor(view, EXEC_SCRIPT, cmd, ctx), ctx);
    const command = cmd.join(" ");
    if (!outcome.ok) return { view, command, output: null, windows: false };
    const output = outcome.stdout.trim().split("\n").filter(Boolean).pop() ?? null;
    return { view, command, output, windows: output !== null && looksWindows(output) };
  });
}

export function runVersion(tool: string, view: ViewName, ctx: Ctx): string | null {
  const outcome = runLaunch(launchFor(view, EXEC_SCRIPT, [tool, "--version"], ctx), ctx);
  if (!outcome.ok) return null;
  return outcome.stdout.trim().split("\n").filter(Boolean).pop() ?? null;
}

/** Global bin dir from `npm config get prefix`. Unix: `$prefix/bin` unless prefix already ends in /bin. */
export function npmBinDir(prefix: string): string {
  const trimmed = prefix.replace(/[/\\]+$/, "");
  if (/[/\\]bin$/i.test(trimmed)) return trimmed.replace(/\\/g, "/");
  return `${trimmed.replace(/\\/g, "/")}/bin`;
}

function sameDir(a: string, b: string): boolean {
  return a.replace(/\/$/, "") === b.replace(/\/$/, "");
}

/**
 * Names in `binDir` that no Linux dir on `pathVar` already provides, so an `exec` launch cannot run them.
 * Undefined when binDir is not a readable Linux dir with entries: the caller then falls back to "invisible".
 */
export function findUnlinkedGlobals(binDir: string, pathVar: string | null, ctx: Ctx): string[] | undefined {
  if (!binDir.startsWith("/") || classify(binDir, ctx.mountRoot) !== "linux") return undefined;
  const names = ctx.fs.readDir(binDir).filter((n) => !n.startsWith("."));
  if (names.length === 0) return undefined;
  const dirs = (pathVar ?? "")
    .split(":")
    .filter(Boolean)
    .filter((d) => !sameDir(d, binDir) && classify(`${d}/`, ctx.mountRoot) === "linux");
  return names.filter((n) => !dirs.some((d) => ctx.fs.exists(posix.join(d, n)))).sort();
}

/**
 * Where `npm i -g` would write, and whether that bin dir is on PATH for the view.
 * pathVar is that view's PATH (colon-separated). Missing PATH → treat as invisible.
 * With `unlinked` (see findUnlinkedGlobals) a bin dir that is off PATH still counts as
 * visible once every global in it is reachable through a Linux dir that is on PATH.
 */
export function npmPrefixVisibility(
  view: ViewName,
  prefix: string | null,
  pathVar: string | null,
  unlinked?: string[],
): NpmPrefixInfo {
  if (prefix === null) {
    return { view, prefix: null, binDir: null, invisibleToView: true, unlinked: [] };
  }
  const binDir = npmBinDir(prefix);
  const dirs = (pathVar ?? "").split(":").filter(Boolean);
  const onPath = dirs.some((d) => sameDir(d, binDir));
  if (onPath) return { view, prefix, binDir, invisibleToView: false, unlinked: [] };
  if (unlinked === undefined) return { view, prefix, binDir, invisibleToView: true, unlinked: [] };
  return { view, prefix, binDir, invisibleToView: unlinked.length > 0, unlinked };
}

export function readNpmPrefix(view: ViewName, ctx: Ctx): string | null {
  const outcome = runLaunch(launchFor(view, EXEC_SCRIPT, ["npm", "config", "get", "prefix"], ctx), ctx);
  if (!outcome.ok) return null;
  const line = outcome.stdout.trim().split("\n").filter(Boolean).pop() ?? null;
  return line && line !== "undefined" ? line : null;
}

export function readPathVar(view: ViewName, ctx: Ctx): string | null {
  const outcome = runLaunch(launchFor(view, EXEC_SCRIPT, ["printenv", "PATH"], ctx), ctx);
  if (!outcome.ok) return null;
  return outcome.stdout.trim().split("\n").filter(Boolean).pop() ?? null;
}
