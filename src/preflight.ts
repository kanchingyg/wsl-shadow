// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path";
import { findLinuxCandidate } from "./candidates";
import type { Ctx } from "./env";
import { stableTarget } from "./fixes";
import type { Hit, ViewName } from "./types";
import { resolveView } from "./views";

export const DEFAULT_PREFLIGHT_TOOLS: readonly string[] = ["node", "npm"];

export interface PreflightProblem {
  tool: string;
  /** windows: a Windows build answers. missing: nothing answers. */
  found: "windows" | "missing";
  /** A Linux build that exists and would fix it, or null when none was found anywhere. */
  linuxCandidate: string | null;
}

export interface PreflightResult {
  /** 0 every tool resolves to Linux. 1 fixable. 2 a tool has no Linux build anywhere. */
  exitCode: 0 | 1 | 2;
  /** The launch measured: `exec` (sh -c, wsl.exe -e, spawn), or `here` outside WSL. */
  view: ViewName;
  /** Colon-joined dirs to put in front of PATH so every tool resolves to its Linux build. Empty when none. */
  pathPrefix: string;
  problems: PreflightProblem[];
  /** Why the check could not run (view unavailable). Set together with exitCode 1. */
  error: string | null;
}

/**
 * One lookup in one view. For harnesses that want pass/fail before they start work.
 * Nothing is probed beyond that, so it is fast; use `scan` for versions and npm prefix.
 */
export function runPreflight(tools: readonly string[], ctx: Ctx): PreflightResult {
  const wantExec = resolveView("exec", tools, ctx);
  const measured = wantExec.info.available ? wantExec : resolveView("here", tools, ctx);
  const view: ViewName = wantExec.info.available ? "exec" : "here";
  if (!measured.info.available) {
    return { exitCode: 1, view, pathPrefix: "", problems: [], error: measured.info.reason ?? "view unavailable" };
  }

  const dirs: string[] = [];
  const problems: PreflightProblem[] = [];
  for (const tool of tools) {
    const hit: Hit = measured.hits[tool] ?? { path: null, verdict: "missing" };
    const candidate = findLinuxCandidate(tool, { [view]: hit }, ctx);
    if (hit.verdict !== "linux") {
      problems.push({ tool, found: hit.verdict === "windows" ? "windows" : "missing", linuxCandidate: candidate });
    }
    if (candidate !== null) dirs.push(posix.dirname(stableTarget(candidate, tool, ctx).target));
  }

  const unfixable = problems.some((p) => p.linuxCandidate === null);
  return {
    exitCode: unfixable ? 2 : problems.length > 0 ? 1 : 0,
    view,
    pathPrefix: [...new Set(dirs)].join(":"),
    problems,
    error: null,
  };
}
