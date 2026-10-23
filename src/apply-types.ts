// SPDX-License-Identifier: AGPL-3.0-only
import type { Ctx, WritableFs } from "./env";
import type { PendingChange } from "./state";

export interface ApplyDeps {
  ctx: Ctx;
  fs: WritableFs;
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

export type Step =
  | { kind: "block"; file: string; content: string; shell: "bash" | "zsh"; unchanged: boolean }
  | { kind: "link"; name: string; link: string; target: string }
  | { kind: "prune"; link: string; target: string }
  | { kind: "unlink"; link: string; target: string }
  | { kind: "restore"; file: string; how: "restore-backup" | "remove-file" | "strip-block" }
  | { kind: "forget"; link: string; reason: string };

export interface Skipped {
  what: string;
  reason: string;
}

export interface Plan {
  steps: Step[];
  skipped: Skipped[];
  /** Notes from settling a crash left in pending. */
  settled: string[];
  /** Set when the whole run is refused. No step may run. */
  refusal: string | null;
}

export interface StepResult {
  step: Step;
  status: "done" | "unchanged" | "failed";
  detail: string;
}

export interface RunResult {
  ok: boolean;
  results: StepResult[];
}

