#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from "node:readline/promises";
import { createApplyDeps } from "./api";
import { runApplyCommand, runUndoCommand } from "./cli-apply";
import { createCtx } from "./env";
import { DEFAULT_PREFLIGHT_TOOLS, runPreflight } from "./preflight";
import { buildReport } from "./report";
import {
  ALL_VIEWS,
  type Fix,
  type McpReport,
  type Report,
  type ToolRow,
  type ViewName,
} from "./types";

interface Options {
  json: boolean;
  fix: boolean;
  apply: boolean;
  undo: boolean;
  yes: boolean;
  preflight: boolean;
  mcp: boolean;
  required: string[];
  expectWindows: string[];
  views: ViewName[] | null;
}

function parseArgs(argv: string[]): Options | string {
  const opts: Options = {
    json: false,
    fix: false,
    apply: false,
    undo: false,
    yes: false,
    preflight: false,
    mcp: false,
    required: [],
    expectWindows: [],
    views: null,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--fix") opts.fix = true;
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--undo") opts.undo = true;
    else if (arg === "--yes") opts.yes = true;
    else if (arg === "--preflight") opts.preflight = true;
    else if (arg === "--mcp") opts.mcp = true;
    else if (arg.startsWith("--require=")) opts.required = arg.slice(10).split(",").filter(Boolean);
    else if (arg.startsWith("--expect-windows=")) {
      opts.expectWindows = arg.slice(17).split(",").filter(Boolean);
    } else if (arg.startsWith("--view=")) {
      const names = arg.slice(7).split(",").filter(Boolean);
      const bad = names.filter((n) => !ALL_VIEWS.includes(n as ViewName));
      if (bad.length > 0) return `unknown view: ${bad.join(", ")} (use ${ALL_VIEWS.join(", ")})`;
      opts.views = names as ViewName[];
    } else return `unknown argument: ${arg}`;
  }
  const modes = [opts.fix, opts.apply, opts.undo, opts.preflight].filter(Boolean).length;
  if (modes > 1) return "use only one of --fix, --apply, --undo, --preflight";
  if (opts.yes && !opts.apply && !opts.undo) return "--yes only goes with --apply or --undo";
  return opts;
}

function printViews(report: Report): void {
  const ok = report.views.filter((v) => v.available).map((v) => v.name);
  console.log(`views: ${ok.join(", ") || "none"}`);
  for (const view of report.views.filter((v) => !v.available)) {
    console.log(`  unavailable: ${view.name}: ${view.reason}`);
  }
  console.log("");
}

function printProblem(row: ToolRow): void {
  console.log(`${row.status.padEnd(9)} ${row.tool}`);
  for (const [view, hit] of Object.entries(row.hits)) {
    const flag = row.failingViews.includes(view as ViewName) ? "  <- fails" : "";
    console.log(`          ${view.padEnd(11)} ${hit.path ?? "(not found)"}${flag}`);
  }
  if (row.linuxCandidate !== null) console.log(`          linux build  ${row.linuxCandidate}`);
  for (const ver of row.versions) {
    console.log(`          version ${ver.view.padEnd(11)} ${ver.version ?? "(unknown)"}`);
  }
  if (row.npmPrefix !== null) {
    const mark = row.npmPrefix.invisibleToView ? "  <- not on PATH" : "";
    console.log(
      `          npm prefix ${row.npmPrefix.view} ${row.npmPrefix.prefix ?? "(unknown)"} -> ${row.npmPrefix.binDir ?? "?"}${mark}`,
    );
  }
  if (row.consequence !== null) console.log(`          ${row.consequence}`);
  for (const probe of row.probes) {
    console.log(`          probe ${probe.command} = ${probe.output ?? "(no output)"}`);
  }
}

function printTable(report: Report): void {
  printViews(report);
  for (const row of report.rows) {
    switch (row.status) {
      case "shadow":
      case "windows-only":
      case "unreachable":
      case "drift":
        printProblem(row);
        break;
      case "ok":
        if (row.npmPrefix?.invisibleToView) printProblem({ ...row, status: "ok" });
        else console.log(`ok        ${row.tool}`);
        break;
      case "missing":
        console.log(`missing   ${row.tool}`);
        break;
      case "expected-windows":
        console.log(`windows   ${row.tool}  (expected)`);
        break;
      case "unmeasured":
        console.log(`unmeasured ${row.tool}`);
        break;
      default: {
        const unreachable: never = row.status;
        throw new Error(`unknown status: ${String(unreachable)}`);
      }
    }
  }
}

function printMcp(mcp: McpReport): void {
  console.log("\n--mcp");
  for (const cfg of mcp.configs) {
    const mark = cfg.present ? "present" : "absent";
    const conf = cfg.confidence;
    console.log(`config ${mark}  [${conf}] ${cfg.source}`);
    console.log(`       ${cfg.path}`);
    if (cfg.parseError) console.log(`       parse error: ${cfg.parseError}`);
  }
  if (mcp.servers.length === 0) {
    console.log("no MCP servers with wsl/npx/node/bun commands found");
    return;
  }
  console.log("");
  for (const s of mcp.servers) {
    console.log(`${String(s.status).padEnd(14)} ${s.server}  (${s.source})`);
    console.log(`               command  ${s.command} ${s.args.join(" ")}`.trimEnd());
    console.log(`               view     ${s.view}${s.program ? `  program=${s.program}` : ""}`);
    if (s.resolvedPath) console.log(`               resolved ${s.resolvedPath}`);
    if (s.consequence) console.log(`               ${s.consequence}`);
    if (s.fixHint) console.log(`               fix: ${s.fixHint}`);
  }
}

function printFix(fix: Fix, index: number): void {
  console.log(`\n${index + 1}. ${fix.kind}  (${fix.tools.join(", ")})`);
  if (fix.fixesViews.length > 0) console.log(`   fixes:           ${fix.fixesViews.join(", ")}`);
  if (fix.leavesBroken.length > 0) console.log(`   still broken in: ${fix.leavesBroken.join(", ")}`);
  if (fix.file !== null) console.log(`   file: ${fix.file}`);
  if (fix.content !== null) {
    for (const line of fix.content.split("\n")) console.log(`     ${line}`);
  }
  for (const command of fix.commands) console.log(`   $ ${command}`);
  if (fix.warning !== null) console.log(`   note: ${fix.warning}`);
}

function printFixes(report: Report): void {
  console.log("\n--fix (dry run: nothing was changed, nothing was run)");
  if (report.fixes.length === 0) {
    console.log("nothing to fix");
    return;
  }
  report.fixes.forEach(printFix);
  console.log("\nAfter applying one, run wsl-shadow again. It re-measures every view.");
  if (report.fixes.some((f) => f.kind === "path-block" || f.links.length > 0)) {
    console.log("`wsl-shadow --apply` can do the file edits and links above for you (typed confirmation, backups, `--undo`).");
  }
}

async function confirmOnTerminal(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function runPreflightCommand(opts: Options): number {
  const tools = opts.required.length > 0 ? opts.required : [...DEFAULT_PREFLIGHT_TOOLS];
  const result = runPreflight(tools, createCtx());
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.exitCode;
  }
  // stdout is only the PATH prefix, so `PATH="$(wsl-shadow --preflight):$PATH"` works.
  console.log(result.pathPrefix);
  if (result.error !== null) console.error(`wsl-shadow: preflight could not run: ${result.error}`);
  else if (result.exitCode === 0) console.error(`wsl-shadow: preflight ok (${tools.join(", ")} resolve to Linux in ${result.view})`);
  for (const p of result.problems) {
    const hint = p.linuxCandidate === null ? "no Linux build found" : `Linux build at ${p.linuxCandidate}`;
    console.error(`wsl-shadow: ${p.tool}: ${p.found === "windows" ? "Windows build in" : "not found in"} ${result.view}; ${hint}`);
  }
  return result.exitCode;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === "string") {
    console.error(`wsl-shadow: ${opts}`);
    return 64;
  }
  const reportOpts = {
    required: opts.required,
    views: opts.views,
    expectWindows: opts.expectWindows,
    mcp: opts.mcp,
  };

  if (opts.preflight) return runPreflightCommand(opts);
  if (opts.apply || opts.undo) {
    const deps = createApplyDeps();
    const io = { yes: opts.yes, interactive: process.stdin.isTTY === true, ask: confirmOnTerminal };
    return opts.apply
      ? runApplyCommand(deps, reportOpts, io, console.log)
      : runUndoCommand(deps, reportOpts, io, console.log);
  }

  const report = buildReport(createCtx(), reportOpts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
    if (report.mcp !== null) printMcp(report.mcp);
    if (opts.fix) printFixes(report);
  }
  return report.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`wsl-shadow: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 70;
  },
);