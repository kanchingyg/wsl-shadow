import { findLinuxCandidate } from "./candidates";
import type { Ctx } from "./env";
import { buildFixes } from "./fixes";
import { runProbes } from "./probes";
import { decideStatus, isProblem } from "./status";
import { CONSEQUENCES, FALLBACK_CONSEQUENCE, TOOLS } from "./tools";
import type { Hit, Probe, Report, ToolRow, ViewInfo, ViewName } from "./types";
import { activeViews, resolveView } from "./views";

export interface ReportOptions {
  required: string[];
  /** Limit to these views. Null measures all that apply. */
  views: ViewName[] | null;
}

function consequenceFor(row: Pick<ToolRow, "tool" | "status" | "failingViews">, probes: Probe[]): string | null {
  switch (row.status) {
    case "shadow":
    case "windows-only": {
      const measured = probes.find((p) => p.windows && p.output !== null);
      if (measured) return `measured: \`${measured.command}\` = ${measured.output} (${measured.view})`;
      return CONSEQUENCES[row.tool] ?? FALLBACK_CONSEQUENCE;
    }
    case "unreachable":
      return `a Linux build exists, but the ${row.failingViews.join(", ")} launch can't find it`;
    case "ok":
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

export function exitCodeFor(rows: ToolRow[], required: string[]): 0 | 1 | 2 {
  if (rows.some((r) => isProblem(r.status))) return 1;
  const missingRequired = rows.some((r) => r.status === "missing" && required.includes(r.tool));
  return missingRequired ? 2 : 0;
}

export function buildReport(ctx: Ctx, opts: ReportOptions): Report {
  const wanted = activeViews(ctx).filter((v) => opts.views === null || opts.views.includes(v));
  const results = wanted.map((view) => resolveView(view, TOOLS, ctx));
  const infos: ViewInfo[] = results.map((r) => r.info);

  const rows: ToolRow[] = TOOLS.map((tool) => {
    const hits: Partial<Record<ViewName, Hit>> = {};
    for (const result of results) {
      const hit = result.hits[tool];
      if (result.info.available && hit) hits[result.info.name] = hit;
    }
    const linuxCandidate = findLinuxCandidate(tool, hits, ctx);
    const { status, failingViews } = decideStatus(tool, hits, linuxCandidate);

    const windowsView = failingViews.find((v) => hits[v]?.verdict === "windows");
    const probes =
      (status === "shadow" || status === "windows-only") && windowsView
        ? runProbes(tool, windowsView, ctx)
        : [];

    return {
      tool,
      status,
      hits,
      failingViews,
      linuxCandidate,
      probes,
      consequence: consequenceFor({ tool, status, failingViews }, probes),
    };
  });

  return {
    schemaVersion: 1,
    insideWsl: ctx.distro !== null,
    distro: ctx.distro,
    mountRoot: ctx.mountRoot,
    views: infos,
    rows,
    fixes: buildFixes(rows, ctx),
    exitCode: exitCodeFor(rows, opts.required),
  };
}
