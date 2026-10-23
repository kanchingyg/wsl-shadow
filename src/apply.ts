// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Apply / undo surface. Planning lives in `apply-plan.ts`; mutation in `apply-run.ts`.
 * This module re-exports both so callers and tests keep a single import path.
 */
export type { ApplyDeps, Plan, RunResult, Skipped, Step, StepResult } from "./apply-types";
export { planApply, planUndo } from "./apply-plan";
export { runApply, runUndo } from "./apply-run";
export { sha256Text as sha256 } from "./state";
