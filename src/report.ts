// SPDX-License-Identifier: AGPL-3.0-only
import { findLinuxCandidate } from "./candidates";
import type { Ctx } from "./env";
import { buildFixes } from "./fixes";
import { scanMcp } from "./mcp";
import {
  findUnlinkedGlobals,
  npmBinDir,
  npmPrefixVisibility,
  readNpmPrefix,
  readPathVar,
  runProbes,
  runVersion,
} from "./probes";
import { applyDrift, decideStatus, isProblem } from "./status";
import {
  CONSEQUENCES,
  DEFAULT_EXPECTED_WINDOWS,
  FALLBACK_CONSEQUENCE,
  TOOLS,
  VERSION_TOOLS,
} from "./tools";
import type {
  Hit,
  NpmPrefixInfo,
  Probe,
  Report,
  ToolRow,
  VersionHit,
  ViewInfo,
  ViewName,
} from "./types";
import { activeViews, resolveView } from "./views";

export interface ReportOptions {
  required: string[];
  /** Limit to these views. Null measures all that apply. */
  views: ViewName[] | null;
  /** Extra tools treated as expected-windows (merged with cursor/code). */
  expectWindows: string[];
  /** Scan MCP configs and attach a report. */
  mcp: boolean;
  /** Tools to resolve. Defaults to the built-in list. */
  tools?: readonly string[];
}

function consequenceFor(
  row: Pick<ToolRow, "tool" | "status" | "failingViews" | "versions" | "npmPrefix">,
  probes: Probe[],
): string | null {
  switch (row.status) {
    case "shadow":
    case "windows-only": {
      const measured = probes.find((p) => p.windows && p.output !== null);
      if (measured) return `measured: \`${measured.command}\` = ${measured.output} (${measured.view})`;
      return CONSEQUENCES[row.tool] ?? FALLBACK_CONSEQUENCE;
    }
    case "unreachable":
      return `a Linux build exists, but the ${row.failingViews.join(", ")} launch can't find it`;
    case "drift": {
      const parts = row.versions
        .filter((v) => v.version !== null)
        .map((v) => `${v.view}=${v.version}`);
      return `Linux builds disagree on version (${parts.join(", ")})`;
    }
    case "ok":
      if (row.npmPrefix?.invisibleToView) {
        const names = row.npmPrefix.unlinked;
        const tail = names.length > 0 ? ` (not linked: ${names.join(", ")})` : "";
        return `npm global bin ${row.npmPrefix.binDir} is not on the ${row.npmPrefix.view} PATH; agent installs would be invisible${tail}`;
      }
      return null;
    case "missing":
    case "expected-windows":
    case "unmeasured":
      return null;
    default: {
      const unreachable: never = row.status;
      throw new Error(`unknown status: ${String(unreachable)}`);
    }
  }
}

export function exitCodeFor(rows: ToolRow[], required: string[], mcpProblem: boolean): 0 | 1 | 2 {
  if (mcpProblem || rows.some((r) => isProblem(r.status))) return 1;
  if (rows.some((r) => r.status === "ok" && r.npmPrefix?.invisibleToView)) return 1;
  const missingRequired = rows.some((r) => r.status === "missing" && required.includes(r.tool));
  return missingRequired ? 2 : 0;
}

function expectedSet(extra: string[]): ReadonlySet<string> {
  return new Set([...DEFAULT_EXPECTED_WINDOWS, ...extra]);
}

function collectVersions(
  tool: string,
  hits: Partial<Record<ViewName, Hit>>,
  ctx: Ctx,
): VersionHit[] {
  if (!VERSION_TOOLS.has(tool)) return [];
  const out: VersionHit[] = [];
  for (const [view, hit] of Object.entries(hits) as [ViewName, Hit][]) {
    if (hit.verdict !== "linux") continue;
    out.push({ view, version: runVersion(tool, view, ctx) });
  }
  return out;
}

function collectNpmPrefix(
  tool: string,
  status: ToolRow["status"],
  hits: Partial<Record<ViewName, Hit>>,
  ctx: Ctx,
): NpmPrefixInfo | null {
  if (tool !== "npm") return null;
  // Only when the launch already picks a Linux npm. Shadow has its own Windows probes.
  if (status !== "ok" && status !== "drift") return null;
  const preferred: ViewName[] = ["exec", "login", "here", "interactive"];
  const view = preferred.find((v) => hits[v]?.verdict === "linux");
  if (view === undefined) return null;
  const prefix = readNpmPrefix(view, ctx);
  const pathVar = readPathVar(view, ctx);
  const unlinked = prefix === null ? undefined : findUnlinkedGlobals(npmBinDir(prefix), pathVar, ctx);
  return npmPrefixVisibility(view, prefix, pathVar, unlinked);
}

export function buildReport(ctx: Ctx, opts: ReportOptions): Report {
  const expectedWindows = expectedSet(opts.expectWindows);
  const wanted = activeViews(ctx).filter((v) => opts.views === null || opts.views.includes(v));
  const tools = opts.tools ?? TOOLS;
  const results = wanted.map((view) => resolveView(view, tools, ctx));
  const infos: ViewInfo[] = results.map((r) => r.info);

  const rows: ToolRow[] = tools.map((tool) => {
    const hits: Partial<Record<ViewName, Hit>> = {};
    for (const result of results) {
      const hit = result.hits[tool];
      if (result.info.available && hit) hits[result.info.name] = hit;
    }
    const linuxCandidate = findLinuxCandidate(tool, hits, ctx);
    let { status, failingViews } = decideStatus(tool, hits, linuxCandidate, expectedWindows);

    const versions = status === "ok" ? collectVersions(tool, hits, ctx) : [];
    status = applyDrift(status, versions);

    const windowsView = failingViews.find((v) => hits[v]?.verdict === "windows");
    const probes =
      (status === "shadow" || status === "windows-only") && windowsView
        ? runProbes(tool, windowsView, ctx)
        : [];

    const npmPrefix = collectNpmPrefix(tool, status, hits, ctx);
    const row: ToolRow = {
      tool,
      status,
      hits,
      failingViews: status === "drift" ? Object.keys(hits) as ViewName[] : failingViews,
      linuxCandidate,
      probes,
      versions,
      npmPrefix,
      consequence: null,
    };
    row.consequence = consequenceFor(row, probes);
    return row;
  });

  const mcp = opts.mcp ? scanMcp(ctx, expectedWindows) : null;
  const mcpProblem =
    mcp !== null &&
    mcp.servers.some((s) => s.status === "shadow" || s.status === "windows-only" || s.status === "unreachable" || s.status === "drift");

  return {
    schemaVersion: 1,
    insideWsl: ctx.distro !== null,
    distro: ctx.distro,
    mountRoot: ctx.mountRoot,
    views: infos,
    rows,
    mcp,
    fixes: buildFixes(rows, ctx),
    exitCode: exitCodeFor(rows, opts.required, mcpProblem),
  };
}
