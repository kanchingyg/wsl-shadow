// SPDX-License-Identifier: AGPL-3.0-only

/** Launch style used to resolve tools: interactive shell, login, exec, zsh exec, or the current process. */
export type ViewName = "interactive" | "login" | "exec" | "exec-zsh" | "here";

/** Every view name the CLI and library accept in `--view` / `ScanOptions.views`. */
export const ALL_VIEWS: readonly ViewName[] = ["interactive", "login", "exec", "exec-zsh", "here"];

/** Whether a resolved path is a Linux binary, a Windows binary, or missing. */
export type Verdict = "linux" | "windows" | "missing";

/** Per-tool outcome after measuring every requested view. */
export type Status =
  | "ok"
  | "shadow"
  | "windows-only"
  | "unreachable"
  | "drift"
  | "missing"
  | "expected-windows"
  | "unmeasured";

/** One `command -v` result in a single view. */
export interface Hit {
  /** Absolute path from `command -v`, or null when not found. */
  path: string | null;
  /** linux, windows, or missing for that path. */
  verdict: Verdict;
}

/** Whether a view could be launched and why not, if it could not. */
export interface ViewInfo {
  /** View name that was requested. */
  name: ViewName;
  /** True when the lookup process started and returned output. */
  available: boolean;
  /** Failure reason when available is false. */
  reason: string | null;
}

/** Extra command run in a view (for example `npm config get prefix`). */
export interface Probe {
  /** View the probe ran in. */
  view: ViewName;
  /** Shell command string that was run. */
  command: string;
  /** Captured stdout, or null when empty or failed. */
  output: string | null;
  /** True when the output looks like a Windows path or Windows npm prefix. */
  windows: boolean;
}

/** Kind of dry-run proposal in a {@link Fix}. */
export type FixKind = "install" | "path-block" | "symlink" | "harness" | "last-resort";

/** One symlink `--apply` may create: `link` -> `target`. Never forced, never overwrites. */
export interface LinkSpec {
  /** Tool basename this link is for (node, npm, …). */
  name: string;
  /** Full path of the symlink to create, under `/usr/local/bin`. */
  link: string;
  /** Absolute Linux path the symlink should point at. */
  target: string;
}

/** One dry-run proposal from `planFixes` / `--fix`. */
export interface Fix {
  /** Sort order for display; lower comes first. */
  order: number;
  /** What kind of change this proposal describes. */
  kind: FixKind;
  /** Tool names this proposal addresses. */
  tools: string[];
  /** Views that would become healthy if this fix were applied. */
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
  /** Extra note shown with the proposal, or null. */
  warning: string | null;
}

/** `node` / `npm` / `bun --version` result in one view. */
export interface VersionHit {
  /** View the version was read from. */
  view: ViewName;
  /** Version string, or null when the probe failed. */
  version: string | null;
}

/** Result of `npm config get prefix` and whether its bin dir is on PATH. */
export interface NpmPrefixInfo {
  /** View where the prefix was measured. */
  view: ViewName;
  /** Raw prefix string, or null when unknown. */
  prefix: string | null;
  /** `$prefix/bin` (or the prefix itself when it already ends with `/bin`). */
  binDir: string | null;
  /** True when binDir is missing from that view's PATH. */
  invisibleToView: boolean;
  /** Global bins in binDir that no Linux dir on that view's PATH provides. Empty when unknown. */
  unlinked: string[];
}

/** One measured tool in a {@link Report}. */
export interface ToolRow {
  /** Command name that was looked up. */
  tool: string;
  /** Aggregate status across views. */
  status: Status;
  /** Per-view hit map. */
  hits: Partial<Record<ViewName, Hit>>;
  /** Views whose hit fails the status rules. */
  failingViews: ViewName[];
  /** Best Linux binary found on disk when a view cannot see it, or null. */
  linuxCandidate: string | null;
  /** Extra probes attached to this row. */
  probes: Probe[];
  /** Version probes when collected. */
  versions: VersionHit[];
  /** npm prefix visibility, only for the npm tool when measured. */
  npmPrefix: NpmPrefixInfo | null;
  /** Short human consequence string, or null. */
  consequence: string | null;
}

/** One MCP server entry after resolving its launch view and program. */
export interface McpServerRow {
  /** Absolute path of the config file that listed this server. */
  configPath: string;
  /** Short source label (Cursor, Claude, Codex, …). */
  source: string;
  /** Server key from the config. */
  server: string;
  /** `command` field from the config. */
  command: string;
  /** `args` field from the config. */
  args: string[];
  /** Inferred launch view, or windows-native / skipped. */
  view: ViewName | "windows-native" | "skipped";
  /** Program basename being resolved, or null when skipped. */
  program: string | null;
  /** Path `command -v` returned for the program, or null. */
  resolvedPath: string | null;
  /** Status for that program under the inferred view. */
  status: Status | "skipped" | "unavailable";
  /** Short consequence text, or null. */
  consequence: string | null;
  /** Printed-only fix hint, or null. Config files are never edited. */
  fixHint: string | null;
}

/** One known MCP config path that was probed for presence and parseability. */
export interface McpConfigProbe {
  /** Absolute path that was checked. */
  path: string;
  /** Short source label for the client. */
  source: string;
  /** Whether the path sits under the Linux home or the Windows profile mount. */
  side: "linux" | "windows";
  /** verified = path from that client's docs; reported = third-party guide; unverified = guessed. */
  confidence: "verified" | "reported" | "unverified";
  /** True when the file exists. */
  present: boolean;
  /** Parse error text when the file exists but could not be read as config. */
  parseError: string | null;
}

/** Read-only MCP scan: config paths probed and servers found. */
export interface McpReport {
  /** Every known config path that was checked. */
  configs: McpConfigProbe[];
  /** Servers whose command is wsl, npx, node, or bun. */
  servers: McpServerRow[];
}

/** Full scan payload (`schemaVersion: 1`), same shape as `--json`. */
export interface Report {
  /** Schema version; always 1 for this package. */
  schemaVersion: 1;
  /** True when WSL_DISTRO_NAME is set. */
  insideWsl: boolean;
  /** WSL distro name, or null outside WSL. */
  distro: string | null;
  /** Automount root used to classify Windows paths (usually `/mnt/`). */
  mountRoot: string;
  /** Per-view availability. */
  views: ViewInfo[];
  /** One row per measured tool. */
  rows: ToolRow[];
  /** MCP report when requested, otherwise null. */
  mcp: McpReport | null;
  /** Dry-run proposals for the current rows. */
  fixes: Fix[];
  /** Suggested process exit code: 0 ok, 1 problem, 2 required tool missing. */
  exitCode: 0 | 1 | 2;
}
