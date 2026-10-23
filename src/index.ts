// SPDX-License-Identifier: AGPL-3.0-only
// Public API. Importing this file runs nothing: no process, no filesystem, no exit.
export {
  createApplyDeps,
  planFixes,
  preflight,
  resolveTool,
  scan,
  scanMcp,
  type ApplyOptions,
  type PreflightOptions,
  type ScanOptions,
} from "./api";
export {
  planApply,
  planUndo,
  runApply,
  runUndo,
  type ApplyDeps,
  type Plan,
  type RunResult,
  type Skipped,
  type Step,
  type StepResult,
} from "./apply";
export { loadState, statePath, type AppliedFile, type AppliedLink, type AppliedState, type PendingChange } from "./state";
export { settlePending } from "./settle";
export type { Ctx, FsOps, WritableFs } from "./env";
export type { PreflightProblem, PreflightResult } from "./preflight";
export type { Runner, RunOptions, RunResult as ProcessResult } from "./runner";
export {
  ALL_VIEWS,
  type Fix,
  type FixKind,
  type Hit,
  type LinkSpec,
  type McpConfigProbe,
  type McpReport,
  type McpServerRow,
  type NpmPrefixInfo,
  type Probe,
  type Report,
  type Status,
  type ToolRow,
  type Verdict,
  type VersionHit,
  type ViewInfo,
  type ViewName,
} from "./types";
