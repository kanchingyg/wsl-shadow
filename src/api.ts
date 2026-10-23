// SPDX-License-Identifier: AGPL-3.0-only
import type { ApplyDeps } from "./apply";
import { createCtx, realWritableFs, type Ctx, type FsOps, type WritableFs } from "./env";
import { buildFixes } from "./fixes";
import { scanMcp as scanMcpConfigs } from "./mcp";
import { DEFAULT_PREFLIGHT_TOOLS, runPreflight, type PreflightResult } from "./preflight";
import { buildReport } from "./report";
import type { Runner } from "./runner";
import { DEFAULT_EXPECTED_WINDOWS } from "./tools";
import type { Fix, McpReport, Report, ToolRow, ViewName } from "./types";

/**
 * Everything is injectable so a host can test against fakes. Omitted fields use the real
 * process, filesystem and environment, read when the function is called and never on import.
 */
export interface ScanOptions {
  /** Tools whose absence exits 2. */
  required?: string[];
  /** Limit to these views. Default: every view that applies. */
  views?: ViewName[] | null;
  /** Tools treated as expected Windows builds (added to cursor and code). */
  expectWindows?: string[];
  /** Include the MCP config scan. */
  mcp?: boolean;
  runner?: Runner;
  fs?: FsOps;
  env?: Record<string, string | undefined>;
  home?: string;
  distro?: string | null;
  shell?: string;
  mountRoot?: string;
  wslExe?: string | null;
  timeoutMs?: number;
}

function contextFor(opts: ScanOptions): Ctx {
  const { runner, fs, env, home, distro, shell, mountRoot, wslExe, timeoutMs } = opts;
  return createCtx({ runner, fs, env, home, distro, shell, mountRoot, wslExe, timeoutMs });
}

/** The same data as `wsl-shadow --json`. Never exits, never prints, never writes. */
export function scan(opts: ScanOptions = {}): Report {
  return buildReport(contextFor(opts), {
    required: opts.required ?? [],
    views: opts.views ?? null,
    expectWindows: opts.expectWindows ?? [],
    mcp: opts.mcp ?? false,
  });
}

/** One tool, measured in every applicable view. Any command name works, not only the built-in list. */
export function resolveTool(name: string, opts: ScanOptions = {}): ToolRow {
  const report = buildReport(contextFor(opts), {
    required: [],
    views: opts.views ?? null,
    expectWindows: opts.expectWindows ?? [],
    mcp: false,
    tools: [name],
  });
  return report.rows[0]!;
}

/** Read-only scan of Cursor, Claude, Codex, Kilo and VS Code MCP configs. */
export function scanMcp(opts: ScanOptions = {}): McpReport {
  return scanMcpConfigs(contextFor(opts), new Set([...DEFAULT_EXPECTED_WINDOWS, ...(opts.expectWindows ?? [])]));
}

/** Dry-run proposals for a report. `report.fixes` holds the same list; this recomputes it against the current files. */
export function planFixes(report: Report, opts: ScanOptions = {}): Fix[] {
  return buildFixes(report.rows, contextFor(opts));
}

export interface PreflightOptions extends ScanOptions {
  /** Tools every launch must resolve to Linux. Default: node, npm. */
  tools?: string[];
}

/** Fast pass/fail for a harness: one lookup in the `exec` view, plus a PATH prefix that would fix it. */
export function preflight(opts: PreflightOptions = {}): PreflightResult {
  return runPreflight(opts.tools ?? DEFAULT_PREFLIGHT_TOOLS, contextFor(opts));
}

export interface ApplyOptions extends ScanOptions {
  fs?: WritableFs;
  now?: () => Date;
  /** Defaults to the real uid check. */
  isRoot?: boolean;
}

/** Dependencies for `planApply`/`runApply`/`planUndo`/`runUndo`. The writable fs is explicit on purpose. */
export function createApplyDeps(opts: ApplyOptions = {}): ApplyDeps {
  const fs = opts.fs ?? realWritableFs;
  return {
    ctx: contextFor({ ...opts, fs }),
    fs,
    now: opts.now ?? (() => new Date()),
    isRoot: opts.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0),
  };
}
