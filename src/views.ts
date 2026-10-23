// SPDX-License-Identifier: AGPL-3.0-only
import { classify, parseTable } from "./classify";
import type { Ctx } from "./env";
import type { Hit, ViewInfo, ViewName } from "./types";

/** Names arrive as arguments, never interpolated. dash's `command -v` takes one name, hence the loop. */
export const LOOKUP_SCRIPT = 'for t in "$@"; do printf "%s\\t%s\\n" "$t" "$(command -v "$t")"; done';
export const EXEC_SCRIPT = 'exec "$@"';

export type Launch =
  | { ok: true; command: string; args: string[]; env?: Record<string, string | undefined> }
  | { ok: false; reason: string };

function viaWsl(shellArgs: string[], ctx: Ctx): Launch {
  if (ctx.wslExe === null) {
    return { ok: false, reason: "wsl.exe not found (interop off, or not inside WSL)" };
  }
  if (ctx.distro === null) {
    return { ok: false, reason: "WSL_DISTRO_NAME not set (not inside WSL)" };
  }
  return { ok: true, command: ctx.wslExe, args: ["-d", ctx.distro, "-e", ...shellArgs] };
}

/** Builds the command that runs `script` with `args` the way this view's launcher would. */
export function launchFor(view: ViewName, script: string, args: string[], ctx: Ctx): Launch {
  switch (view) {
    case "interactive":
      return { ok: true, command: ctx.shell, args: ["-lic", script, "_", ...args], env: ctx.env };
    case "login":
      return viaWsl(["bash", "-lc", script, "_", ...args], ctx);
    case "exec":
      return viaWsl(["sh", "-c", script, "_", ...args], ctx);
    case "exec-zsh":
      return viaWsl(["zsh", "-c", script, "_", ...args], ctx);
    case "here":
      return { ok: true, command: "sh", args: ["-c", script, "_", ...args], env: ctx.env };
    default: {
      const unreachable: never = view;
      throw new Error(`unknown view: ${String(unreachable)}`);
    }
  }
}

/** exec-zsh only matters when the user's shell is zsh. */
export function activeViews(ctx: Ctx): ViewName[] {
  const views: ViewName[] = ["interactive", "login", "exec"];
  if (ctx.shell.endsWith("zsh")) views.push("exec-zsh");
  views.push("here");
  return views;
}

export type RunOutcome = { ok: true; stdout: string } | { ok: false; reason: string };

export function runLaunch(launch: Launch, ctx: Ctx): RunOutcome {
  if (!launch.ok) return { ok: false, reason: launch.reason };
  const result = ctx.runner.run(launch.command, launch.args, {
    timeoutMs: ctx.timeoutMs,
    env: launch.env,
  });
  if (result.timedOut) return { ok: false, reason: `timed out after ${ctx.timeoutMs} ms` };
  if (result.error !== null) return { ok: false, reason: result.error };
  if (result.stdout.trim() === "" && result.code !== 0) {
    const detail = result.stderr.trim().split("\n")[0] ?? "";
    return { ok: false, reason: `exit ${result.code}${detail ? `: ${detail}` : ""}` };
  }
  return { ok: true, stdout: result.stdout };
}

export interface ViewResult {
  info: ViewInfo;
  hits: Record<string, Hit>;
}

/** One call per view resolves every tool. */
export function resolveView(view: ViewName, tools: readonly string[], ctx: Ctx): ViewResult {
  const launch = launchFor(view, LOOKUP_SCRIPT, [...tools], ctx);
  const outcome = runLaunch(launch, ctx);
  if (!outcome.ok) {
    return { info: { name: view, available: false, reason: outcome.reason }, hits: {} };
  }
  const table = parseTable(outcome.stdout, tools);
  const hits: Record<string, Hit> = {};
  for (const tool of tools) {
    const path = table.get(tool) ?? null;
    hits[tool] = { path, verdict: classify(path, ctx.mountRoot) };
  }
  return { info: { name: view, available: true, reason: null }, hits };
}
