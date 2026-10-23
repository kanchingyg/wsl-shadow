// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path";
import { removeBlock, upsertBlock } from "./block";
import type { FileMeta, WritableFs } from "./env";
import { loadSettled } from "./apply-plan";
import type { ApplyDeps, Plan, RunResult, Step, StepResult } from "./apply-types";
import {
  backupDir,
  clearPending,
  saveState,
  sha256Text,
  upsertFileRecord,
  upsertLinkRecord,
  type AppliedFile,
  type AppliedLink,
  type AppliedState,
  type PendingChange,
} from "./state";

const SUDO_TIMEOUT_MS = 120_000;

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function backupPath(deps: ApplyDeps, file: string): string {
  const dir = backupDir(deps.ctx.home);
  const base = `${stamp(deps.now())}-${posix.basename(file)}`;
  let candidate = posix.join(dir, base);
  for (let n = 1; deps.fs.entryExists(candidate); n++) candidate = posix.join(dir, `${base}.${n}`);
  return candidate;
}

/** Only ever the real `sudo` binary on PATH. Lab stand-ins that escalate via the Windows host are not used here. */
function sudo(deps: ApplyDeps, args: string[]): { ok: boolean; detail: string } {
  const result = deps.ctx.runner.run("sudo", args, { timeoutMs: SUDO_TIMEOUT_MS, inherit: true });
  if (result.error !== null) return { ok: false, detail: result.error };
  if (result.code !== 0) return { ok: false, detail: `sudo ${args.join(" ")} exited ${result.code}` };
  return { ok: true, detail: `sudo ${args.join(" ")}` };
}

/** Copies `file` into the backups dir and checks the copy. Returns its path. */
function backup(deps: ApplyDeps, file: string): string {
  const dest = backupPath(deps, file);
  deps.fs.mkdirp(posix.dirname(dest));
  deps.fs.copyFile(file, dest);
  if (deps.fs.readText(dest) !== deps.fs.readText(file)) throw new Error(`backup of ${file} does not match`);
  return dest;
}

function syntaxOk(deps: ApplyDeps, shell: "bash" | "zsh", file: string): { ok: boolean; detail: string } {
  const result = deps.ctx.runner.run(shell, ["-n", file], { timeoutMs: deps.ctx.timeoutMs });
  if (result.error === null && result.code === 0) return { ok: true, detail: `${shell} -n passed` };
  const why = result.error ?? result.stderr.trim().split("\n")[0] ?? `exit ${result.code}`;
  return { ok: false, detail: `${shell} -n failed: ${why}` };
}

/** Copy mode and ownership from `meta` onto `path` (best-effort). */
function restoreMeta(fs: WritableFs, path: string, meta: FileMeta | null): void {
  if (meta === null) return;
  fs.chmod(path, meta.mode);
  fs.chown(path, meta.uid, meta.gid);
}

/**
 * Writes `next` through a temp file that is syntax-checked first.
 * Mode and ownership of the existing file are copied onto the temp before rename.
 */
function writeChecked(
  deps: ApplyDeps,
  file: string,
  next: string,
  shell: "bash" | "zsh",
  previousMeta: FileMeta | null,
): { ok: boolean; detail: string } {
  const tmp = `${file}.wsl-shadow.tmp`;
  deps.fs.writeText(tmp, next);
  const check = syntaxOk(deps, shell, tmp);
  if (!check.ok) {
    deps.fs.remove(tmp);
    return check;
  }
  restoreMeta(deps.fs, tmp, previousMeta);
  deps.fs.rename(tmp, file);
  // Rename can drop ownership on some FS; re-apply after.
  restoreMeta(deps.fs, file, previousMeta);
  return check;
}

function beginPending(deps: ApplyDeps, state: AppliedState, op: PendingChange): void {
  state.pending = [op];
  saveState(deps.fs, deps.ctx.home, state);
  deps.onPendingWritten?.(op);
}

function finishPending(deps: ApplyDeps, state: AppliedState, op: PendingChange, commit: () => void): void {
  deps.onChangeDone?.(op);
  commit();
  state.pending = [];
  saveState(deps.fs, deps.ctx.home, state);
}

function applyBlock(step: Extract<Step, { kind: "block" }>, deps: ApplyDeps, state: AppliedState): StepResult {
  const { fs, ctx } = deps;
  if (step.unchanged) return { step, status: "unchanged", detail: `${step.file} already has the block` };
  const existed = fs.exists(step.file);
  const before = fs.readText(step.file) ?? "";
  const next = upsertBlock(before, step.content);
  const previous = state.files.find((f) => f.path === step.file);
  const previousMeta = existed ? fs.stat(step.file) : null;
  try {
    const saved = existed ? backup(deps, step.file) : null;
    const record: AppliedFile = {
      path: step.file,
      existedBefore: previous?.existedBefore ?? existed,
      originalBackup: previous?.originalBackup ?? saved,
      writtenSha256: sha256Text(next),
      appliedAt: deps.now().toISOString(),
    };
    const pending: PendingChange = {
      kind: "block",
      file: step.file,
      intendedSha256: record.writtenSha256,
      previousSha256: before === "" && !existed ? null : sha256Text(before),
      existedBefore: record.existedBefore,
      originalBackup: record.originalBackup,
      startedAt: record.appliedAt,
    };
    beginPending(deps, state, pending);
    const written = writeChecked(deps, step.file, next, step.shell, previousMeta);
    if (!written.ok) {
      clearPending(fs, ctx.home, state);
      return { step, status: "failed", detail: `${written.detail}; ${step.file} left as it was` };
    }
    finishPending(deps, state, pending, () => upsertFileRecord(state, record));
    return { step, status: "done", detail: saved === null ? `created ${step.file}` : `edited ${step.file}, backup ${saved}` };
  } catch (error) {
    // Pending may still be on disk (crash between intent and done). Leave it for settle.
    return { step, status: "failed", detail: `${step.file}: ${String(error)}` };
  }
}

function runLink(step: Extract<Step, { kind: "link" }>, deps: ApplyDeps, state: AppliedState): StepResult {
  const pending: PendingChange = {
    kind: "link",
    link: step.link,
    target: step.target,
    startedAt: deps.now().toISOString(),
  };
  try {
    beginPending(deps, state, pending);
    const made = sudo(deps, ["ln", "-s", step.target, step.link]);
    if (!made.ok) {
      clearPending(deps.fs, deps.ctx.home, state);
      return { step, status: "failed", detail: made.detail };
    }
    if (deps.fs.readLink(step.link) !== step.target) {
      clearPending(deps.fs, deps.ctx.home, state);
      return { step, status: "failed", detail: `${step.link} is not the link we asked for` };
    }
    const record: AppliedLink = { link: step.link, target: step.target, appliedAt: pending.startedAt };
    finishPending(deps, state, pending, () => upsertLinkRecord(state, record));
    return { step, status: "done", detail: `${step.link} -> ${step.target}` };
  } catch (error) {
    return { step, status: "failed", detail: `${step.link}: ${String(error)}` };
  }
}

function runUnlink(step: Extract<Step, { kind: "prune" | "unlink" }>, deps: ApplyDeps, state: AppliedState): StepResult {
  if (deps.fs.readLink(step.link) !== step.target) {
    return { step, status: "failed", detail: `${step.link} changed since planning; left alone` };
  }
  const pending: PendingChange = {
    kind: step.kind,
    link: step.link,
    target: step.target,
    startedAt: deps.now().toISOString(),
  };
  try {
    beginPending(deps, state, pending);
    const removed = sudo(deps, ["rm", step.link]);
    if (!removed.ok) {
      clearPending(deps.fs, deps.ctx.home, state);
      return { step, status: "failed", detail: removed.detail };
    }
    if (deps.fs.entryExists(step.link)) {
      clearPending(deps.fs, deps.ctx.home, state);
      return { step, status: "failed", detail: `${step.link} is still there` };
    }
    finishPending(deps, state, pending, () => {
      state.links = state.links.filter((l) => l.link !== step.link);
    });
    return { step, status: "done", detail: `removed ${step.link}` };
  } catch (error) {
    return { step, status: "failed", detail: `${step.link}: ${String(error)}` };
  }
}

function forgetLink(step: Extract<Step, { kind: "forget" }>, deps: ApplyDeps, state: AppliedState): StepResult {
  const pending: PendingChange = { kind: "forget", link: step.link, startedAt: deps.now().toISOString() };
  try {
    beginPending(deps, state, pending);
    finishPending(deps, state, pending, () => {
      state.links = state.links.filter((l) => l.link !== step.link);
    });
    return { step, status: "done", detail: `${step.link} ${step.reason}; dropped from the state file only` };
  } catch (error) {
    return { step, status: "failed", detail: `${step.link}: ${String(error)}` };
  }
}

function summarize(action: "apply" | "undo", results: StepResult[], deps: ApplyDeps, state: AppliedState): void {
  const changes = results.filter((r) => r.status === "done").map((r) => r.detail);
  if (changes.length === 0) return;
  state.history = [...state.history, { at: deps.now().toISOString(), action, changes }];
  saveState(deps.fs, deps.ctx.home, state);
}

function runRestore(step: Extract<Step, { kind: "restore" }>, deps: ApplyDeps, state: AppliedState): StepResult {
  const { fs, ctx } = deps;
  const rec = state.files.find((f) => f.path === step.file)!;
  const previous = fs.readText(step.file);
  const previousMeta = fs.exists(step.file) ? fs.stat(step.file) : null;
  const pending: PendingChange = {
    kind: "restore",
    file: step.file,
    how: step.how,
    originalBackup: rec.originalBackup,
    existedBefore: rec.existedBefore,
    previousSha256: previous === null ? null : sha256Text(previous),
    startedAt: deps.now().toISOString(),
  };
  const dropRecord = (): void => {
    state.files = state.files.filter((f) => f.path !== step.file);
  };
  try {
    beginPending(deps, state, pending);
    switch (step.how) {
      case "restore-backup": {
        if (fs.exists(step.file)) backup(deps, step.file);
        const backupMeta = rec.originalBackup !== null ? fs.stat(rec.originalBackup) : null;
        fs.copyFile(rec.originalBackup!, step.file);
        restoreMeta(fs, step.file, previousMeta ?? backupMeta);
        finishPending(deps, state, pending, dropRecord);
        return { step, status: "done", detail: `restored ${step.file} from ${rec.originalBackup}` };
      }
      case "remove-file": {
        backup(deps, step.file);
        fs.remove(step.file);
        finishPending(deps, state, pending, dropRecord);
        return { step, status: "done", detail: `removed ${step.file}, which this tool created` };
      }
      case "strip-block": {
        const current = fs.readText(step.file) ?? "";
        const next = removeBlock(current);
        if (next === current) {
          finishPending(deps, state, pending, dropRecord);
          return { step, status: "unchanged", detail: `${step.file} has no wsl-shadow block; nothing to remove` };
        }
        const saved = backup(deps, step.file);
        const written = writeChecked(deps, step.file, next, step.file.endsWith(".zshenv") ? "zsh" : "bash", previousMeta);
        if (!written.ok) {
          clearPending(fs, ctx.home, state);
          return { step, status: "failed", detail: `${written.detail}; ${step.file} left as it was` };
        }
        finishPending(deps, state, pending, dropRecord);
        return {
          step,
          status: "done",
          detail: `removed only the wsl-shadow block from ${step.file} (you edited it since); backup ${saved}`,
        };
      }
      default: {
        const unreachable: never = step.how;
        throw new Error(`unknown restore: ${String(unreachable)}`);
      }
    }
  } catch (error) {
    return { step, status: "failed", detail: `${step.file}: ${String(error)}` };
  }
}

/** Runs a plan from `planApply`. File edits first; any failure there stops before sudo is ever called. */
export function runApply(plan: Plan, deps: ApplyDeps): RunResult {
  if (plan.refusal !== null) return { ok: false, results: [] };
  const loaded = loadSettled(deps);
  if (!loaded.ok) return { ok: false, results: [] };
  const state = loaded.state;
  const results: StepResult[] = [];

  for (const step of plan.steps.filter((s) => s.kind === "block")) {
    const result = applyBlock(step, deps, state);
    results.push(result);
    if (result.status === "failed") {
      summarize("apply", results, deps, state);
      return { ok: false, results };
    }
  }

  for (const step of plan.steps) {
    let result: StepResult | null = null;
    switch (step.kind) {
      case "block":
        break;
      case "prune":
      case "unlink":
        result = runUnlink(step, deps, state);
        break;
      case "forget":
        result = forgetLink(step, deps, state);
        break;
      case "link":
        result = runLink(step, deps, state);
        break;
      case "restore":
        break;
      default: {
        const unreachable: never = step;
        throw new Error(`unknown step: ${JSON.stringify(unreachable)}`);
      }
    }
    if (result === null) continue;
    results.push(result);
    if (result.status === "failed") {
      summarize("apply", results, deps, state);
      return { ok: false, results };
    }
  }
  summarize("apply", results, deps, state);
  return { ok: results.every((r) => r.status !== "failed"), results };
}

export function runUndo(plan: Plan, deps: ApplyDeps): RunResult {
  if (plan.refusal !== null) return { ok: false, results: [] };
  const loaded = loadSettled(deps);
  if (!loaded.ok) return { ok: false, results: [] };
  const state = loaded.state;
  const results: StepResult[] = [];
  for (const step of plan.steps) {
    switch (step.kind) {
      case "restore":
        results.push(runRestore(step, deps, state));
        break;
      case "unlink":
      case "prune":
        results.push(runUnlink(step, deps, state));
        break;
      case "forget":
        results.push(forgetLink(step, deps, state));
        break;
      case "block":
      case "link":
        break;
      default: {
        const unreachable: never = step;
        throw new Error(`unknown step: ${JSON.stringify(unreachable)}`);
      }
    }
  }
  summarize("undo", results, deps, state);
  return { ok: results.every((r) => r.status !== "failed"), results };
}
