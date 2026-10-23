// SPDX-License-Identifier: AGPL-3.0-only
export type ViewName = "interactive" | "login" | "exec" | "exec-zsh" | "here";

export const ALL_VIEWS: readonly ViewName[] = ["interactive", "login", "exec", "exec-zsh", "here"];

export type Verdict = "linux" | "windows" | "missing";

export type Status =
  | "ok"
  | "shadow"
  | "windows-only"
  | "unreachable"
  | "drift"
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

/** One symlink `--apply` may create: `link` -> `target`. Never forced, never overwrites. */
export interface LinkSpec {
  name: string;
  link: string;
  target: string;
}

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
  /** Links `--apply` would create for this proposal. Empty for anything else. */
  links: LinkSpec[];
  warning: string | null;
}

export interface VersionHit {
  view: ViewName;
  version: string | null;
}

export interface NpmPrefixInfo {
  view: ViewName;
  prefix: string | null;
  binDir: string | null;
  /** True when binDir is missing from that view's PATH. */
  invisibleToView: boolean;
  /** Global bins in binDir that no Linux dir on that view's PATH provides. Empty when unknown. */
  unlinked: string[];
}

export interface ToolRow {
  tool: string;
  status: Status;
  hits: Partial<Record<ViewName, Hit>>;
  failingViews: ViewName[];
  linuxCandidate: string | null;
  probes: Probe[];
  versions: VersionHit[];
  npmPrefix: NpmPrefixInfo | null;
  consequence: string | null;
}

export interface McpServerRow {
  configPath: string;
  source: string;
  server: string;
  command: string;
  args: string[];
  view: ViewName | "windows-native" | "skipped";
  program: string | null;
  resolvedPath: string | null;
  status: Status | "skipped" | "unavailable";
  consequence: string | null;
  fixHint: string | null;
}

export interface McpConfigProbe {
  path: string;
  source: string;
  side: "linux" | "windows";
  /** verified = path from that client's docs; reported = third-party guide; unverified = guessed. */
  confidence: "verified" | "reported" | "unverified";
  present: boolean;
  parseError: string | null;
}

export interface McpReport {
  configs: McpConfigProbe[];
  servers: McpServerRow[];
}

export interface Report {
  schemaVersion: 1;
  insideWsl: boolean;
  distro: string | null;
  mountRoot: string;
  views: ViewInfo[];
  rows: ToolRow[];
  mcp: McpReport | null;
  fixes: Fix[];
  exitCode: 0 | 1 | 2;
}
