// SPDX-License-Identifier: AGPL-3.0-only
import {
  planApply,
  planUndo,
  runApply,
  runUndo,
  type ApplyDeps,
  type Plan,
  type RunResult,
  type Step,
} from "./apply";
import { buildReport, type ReportOptions } from "./report";
import { backupDir, statePath } from "./state";
import type { Report, ToolRow } from "./types";

export interface CommandIo {
  /** Skip the typed confirmation. */
  yes: boolean;
  /** Whether a person can answer. Without one, the run needs `yes`. */
  interactive: boolean;
  ask(prompt: string): Promise<string>;
}

type Log = (line: string) => void;

function describe(step: Step): string[] {
  switch (step.kind) {
    case "block":
      return step.unchanged
        ? [`keep   ${step.file}: the wsl-shadow block is already there`]
        : [
            `edit   ${step.file}: add or replace the wsl-shadow PATH block (backup first, \`${step.shell} -n\` before it goes live)`,
            ...step.content.split("\n").map((l) => `         ${l}`),
          ];
    case "link":
      return [`link   sudo ln -s '${step.target}' ${step.link}`];
    case "prune":
      return [`prune  sudo rm ${step.link}   (a link this tool made; its target is gone)`];
    case "unlink":
      return [`unlink sudo rm ${step.link}   (a link this tool made)`];
    case "restore":
      switch (step.how) {
        case "restore-backup":
          return [`restore ${step.file} from the backup taken before the first edit`];
        case "remove-file":
          return [`remove ${step.file}, which this tool created and you have not changed`];
        case "strip-block":
          return [`strip  only the wsl-shadow block from ${step.file} (it changed since, so no whole-file restore)`];
        default: {
          const unreachable: never = step.how;
          throw new Error(`unknown restore: ${String(unreachable)}`);
        }
      }
    case "forget":
      return [`forget ${step.link}: ${step.reason}; only the state file entry goes`];
    default: {
      const unreachable: never = step;
      throw new Error(`unknown step: ${JSON.stringify(unreachable)}`);
    }
  }
}

function printPlan(title: string, plan: Plan, deps: ApplyDeps, log: Log): void {
  log(`\n${title}`);
  if (plan.refusal !== null) {
    log(`refused: ${plan.refusal}`);
    return;
  }
  for (const note of plan.settled) log(`  settled ${note}`);
  if (plan.steps.length === 0) log("nothing to do");
  for (const step of plan.steps) for (const line of describe(step)) log(`  ${line}`);
  for (const s of plan.skipped) log(`  skip   ${s.what}: ${s.reason}`);
  const needsSudo = plan.steps.some((s) => s.kind === "link" || s.kind === "prune" || s.kind === "unlink");
  log(`  state   ${statePath(deps.ctx.home)}`);
  log(`  backups ${backupDir(deps.ctx.home)}`);
  if (needsSudo) log("  sudo asks for your password at this terminal, for the link commands only. It is never stored.");
}

function label(row: ToolRow): string {
  if (row.status === "ok" && row.npmPrefix?.invisibleToView) {
    const names = row.npmPrefix.unlinked;
    return names.length > 0 ? `ok, globals not visible to exec (${names.join(", ")})` : "ok, globals not visible to exec";
  }
  return row.status;
}

function printBeforeAfter(before: Report, after: Report, log: Log): void {
  log("\nbefore -> after");
  let shown = 0;
  for (const b of before.rows) {
    const a = after.rows.find((r) => r.tool === b.tool);
    if (a === undefined) continue;
    const from = label(b);
    const to = label(a);
    if (from === to && (from === "ok" || from === "missing" || from === "unmeasured" || from === "expected-windows")) continue;
    log(from === to ? `  ${b.tool.padEnd(8)} ${from}  (unchanged)` : `  ${b.tool.padEnd(8)} ${from}  ->  ${to}`);
    shown++;
  }
  if (shown === 0) log("  every tool is unchanged and fine");
  log(`  exit code ${before.exitCode} -> ${after.exitCode}`);
}

function printResults(run: RunResult, log: Log): void {
  for (const r of run.results) log(`  ${r.status.padEnd(9)} ${r.detail}`);
}

async function confirmed(word: string, io: CommandIo, log: Log): Promise<boolean | "no-terminal"> {
  if (io.yes) return true;
  if (!io.interactive) {
    log(`This needs a terminal to confirm. Run it in one, or pass --yes after reading the plan above.`);
    return "no-terminal";
  }
  const answer = await io.ask(`\nType "${word}" to continue, anything else cancels: `);
  return answer.trim() === word;
}

function effective(plan: Plan): boolean {
  return plan.steps.some((s) => !(s.kind === "block" && s.unchanged));
}

async function execute(
  kind: "apply" | "undo",
  deps: ApplyDeps,
  reportOpts: ReportOptions,
  io: CommandIo,
  log: Log,
): Promise<number> {
  const before = buildReport(deps.ctx, reportOpts);
  const plan = kind === "apply" ? planApply(before.fixes, deps) : planUndo(deps);
  printPlan(kind === "apply" ? "--apply plan" : "--undo plan", plan, deps, log);
  if (plan.refusal !== null) return 64;
  if (!effective(plan)) {
    log(kind === "apply" ? "\nNothing for --apply to change. The report below is unchanged." : "\nNothing recorded to undo.");
    log(`  exit code ${before.exitCode}`);
    return before.exitCode;
  }

  const go = await confirmed(kind, io, log);
  if (go === "no-terminal") return 64;
  if (!go) {
    log("Cancelled. Nothing was changed.");
    return 1;
  }

  const run = kind === "apply" ? runApply(plan, deps) : runUndo(plan, deps);
  log(`\n${kind === "apply" ? "applied" : "undone"}:`);
  printResults(run, log);
  const after = buildReport(deps.ctx, reportOpts);
  printBeforeAfter(before, after, log);
  if (!run.ok) log(`\nSome steps failed. Nothing else was touched. \`wsl-shadow --undo\` reverts what was recorded.`);
  return run.ok ? after.exitCode : 1;
}

export function runApplyCommand(deps: ApplyDeps, reportOpts: ReportOptions, io: CommandIo, log: Log): Promise<number> {
  return execute("apply", deps, reportOpts, io, log);
}

export function runUndoCommand(deps: ApplyDeps, reportOpts: ReportOptions, io: CommandIo, log: Log): Promise<number> {
  return execute("undo", deps, reportOpts, io, log);
}
