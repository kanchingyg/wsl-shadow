#!/usr/bin/env node
import { createCtx } from "./env";
import { buildReport } from "./report";
import { ALL_VIEWS, type Fix, type Report, type ToolRow, type ViewName } from "./types";

interface Options {
  json: boolean;
  fix: boolean;
  required: string[];
  views: ViewName[] | null;
}

function parseArgs(argv: string[]): Options | string {
  const opts: Options = { json: false, fix: false, required: [], views: null };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--fix") opts.fix = true;
    else if (arg.startsWith("--require=")) opts.required = arg.slice(10).split(",").filter(Boolean);
    else if (arg.startsWith("--view=")) {
      const names = arg.slice(7).split(",").filter(Boolean);
      const bad = names.filter((n) => !ALL_VIEWS.includes(n as ViewName));
      if (bad.length > 0) return `unknown view: ${bad.join(", ")} (use ${ALL_VIEWS.join(", ")})`;
      opts.views = names as ViewName[];
    } else return `unknown argument: ${arg}`;
  }
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
        printProblem(row);
        break;
      case "ok":
        console.log(`ok        ${row.tool}`);
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
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === "string") {
    console.error(`wsl-shadow: ${opts}`);
    process.exit(64);
  }
  const report = buildReport(createCtx(), { required: opts.required, views: opts.views });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
    if (opts.fix) printFixes(report);
  }
  process.exit(report.exitCode);
}

main();
