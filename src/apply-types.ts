// SPDX-License-Identifier: AGPL-3.0-only
import type { Ctx, WritableFs } from "./env";
import type { PendingChange } from "./state";

/** Injected deps for plan/run apply and undo. */
export interface ApplyDeps {
  /** Environment and process runner used for lookups and sudo. */
  ctx: Ctx;
  /** Writable filesystem used for edits, backups, and the state file. */
  fs: WritableFs;
  /** Clock for timestamps on state and backup names. */
  now: () => Date;
  /** True when running as uid 0. The tool refuses: it edits $HOME and asks sudo itself. */
  isRoot: boolean;
  /**
   * Test hook: called after the pending intent is fsynced, before the real change.
   * Throw to simulate a crash between intent and effect.
   */
  onPendingWritten?: (op: PendingChange) => void;
  /**
   * Test hook: called after the change landed, before pending is cleared and the done record is saved.
   * Throw to simulate a crash between effect and "done".
   */
  onChangeDone?: (op: PendingChange) => void;
}

/** One planned filesystem or symlink action for apply or undo. */
export type Step =
  | { kind: "block"; file: string; content: string; shell: "bash" | "zsh"; unchanged: boolean }
  | { kind: "link"; name: string; link: string; target: string }
  | { kind: "prune"; link: string; target: string }
  | { kind: "unlink"; link: string; target: string }
  | { kind: "restore"; file: string; how: "restore-backup" | "remove-file" | "strip-block" }
  | { kind: "forget"; link: string; reason: string };

/** A proposed change that was skipped with a reason. */
export interface Skipped {
  /** Path or label that was skipped. */
  what: string;
  /** Why it was not turned into a step. */
  reason: string;
}

/** Output of `planApply` or `planUndo`. */
export interface Plan {
  /** Ordered steps to run. */
  steps: Step[];
  /** Changes that were not turned into steps. */
  skipped: Skipped[];
  /** Notes from settling a crash left in pending. */
  settled: string[];
  /** Set when the whole run is refused. No step may run. */
  refusal: string | null;
}

/** Outcome of running one {@link Step}. */
export interface StepResult {
  /** Step that was attempted. */
  step: Step;
  /** done, unchanged (already applied), or failed. */
  status: "done" | "unchanged" | "failed";
  /** Human detail for logs. */
  detail: string;
}

/** Aggregate result of `runApply` or `runUndo`. */
export interface RunResult {
  /** True when no step failed. */
  ok: boolean;
  /** Per-step results in run order. */
  results: StepResult[];
}
