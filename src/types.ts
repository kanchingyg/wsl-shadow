export type ViewName = "interactive" | "login" | "exec" | "exec-zsh" | "here";

export const ALL_VIEWS: readonly ViewName[] = ["interactive", "login", "exec", "exec-zsh", "here"];

export type Verdict = "linux" | "windows" | "missing";

export type Status =
  | "ok"
  | "shadow"
  | "windows-only"
  | "unreachable"
  | "missing"
  | "expected-windows"
  | "unmeasured";

export interface Hit {
  path: string | null;
  verdict: Verdict;
}

export interface ViewInfo {
  name: ViewName;
  available: boolean;
  reason: string | null;
}

export interface Probe {
  view: ViewName;
  command: string;
  output: string | null;
  windows: boolean;
}

export type FixKind = "install" | "path-block" | "symlink" | "harness" | "last-resort";

export interface Fix {
  order: number;
  kind: FixKind;
  tools: string[];
  fixesViews: ViewName[];
  /** Views that stay broken for these tools even after this fix is applied. */
  leavesBroken: ViewName[];
  /** File to edit, for path-block fixes. */
  file: string | null;
  /** Text to paste into the file or config. */
  content: string | null;
  /** Commands to run by hand. */
  commands: string[];
  warning: string | null;
}

export interface ToolRow {
  tool: string;
  status: Status;
  hits: Partial<Record<ViewName, Hit>>;
  failingViews: ViewName[];
  linuxCandidate: string | null;
  probes: Probe[];
  consequence: string | null;
}

export interface Report {
  schemaVersion: 1;
  insideWsl: boolean;
  distro: string | null;
  mountRoot: string;
  views: ViewInfo[];
  rows: ToolRow[];
  fixes: Fix[];
  exitCode: 0 | 1 | 2;
}
