// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path";
import { classify } from "./classify";
import type { Ctx } from "./env";
import { findLinuxCandidate } from "./candidates";
import { decideStatus } from "./status";
import type { Hit, McpConfigProbe, McpReport, McpServerRow, Status, ViewName } from "./types";
import { LOOKUP_SCRIPT, launchFor, runLaunch } from "./views";

export interface McpServerDef {
  name: string;
  command: string;
  args: string[];
}

export interface McpPathSpec {
  /** Absolute path under Linux, or a template with {winHome}. */
  path: string;
  source: string;
  side: "linux" | "windows";
  confidence: McpConfigProbe["confidence"];
}

/**
 * Paths checked for MCP configs.
 * verified = that client's own docs; reported = a published guide; unverified = guessed.
 * Codex uses TOML; we only look for command = "..." lines near a server table.
 */
export const MCP_PATHS: readonly McpPathSpec[] = [
  { path: "{home}/.cursor/mcp.json", source: "Cursor user", side: "linux", confidence: "verified" },
  { path: "{home}/.claude.json", source: "Claude Code user", side: "linux", confidence: "verified" },
  { path: "{home}/.mcp.json", source: "Claude Code / Copilot portable (home)", side: "linux", confidence: "reported" },
  { path: "{home}/.codex/config.toml", source: "Codex user", side: "linux", confidence: "verified" },
  { path: "{home}/.config/kilo/kilo.json", source: "Kilo Code user", side: "linux", confidence: "reported" },
  { path: "{home}/.config/kilo/kilo.jsonc", source: "Kilo Code user (jsonc)", side: "linux", confidence: "reported" },
  {
    path: "{home}/.vscode-server/data/User/mcp.json",
    source: "VS Code Remote-WSL user",
    side: "linux",
    confidence: "reported",
  },
  {
    path: "{winHome}/.cursor/mcp.json",
    source: "Cursor user (Windows)",
    side: "windows",
    confidence: "verified",
  },
  {
    path: "{winHome}/AppData/Roaming/Claude/claude_desktop_config.json",
    source: "Claude Desktop (Windows)",
    side: "windows",
    confidence: "verified",
  },
  {
    path: "{winHome}/AppData/Roaming/Code/User/mcp.json",
    source: "VS Code user (Windows)",
    side: "windows",
    confidence: "reported",
  },
  {
    path: "{winHome}/AppData/Roaming/Cursor/User/globalStorage/cursor-mcp-settings.json",
    source: "Cursor legacy globalStorage (Windows)",
    side: "windows",
    confidence: "unverified",
  },
  {
    path: "{winHome}/.codex/config.toml",
    source: "Codex user (Windows)",
    side: "windows",
    confidence: "reported",
  },
];

export function expandPath(spec: string, home: string, winHome: string | null): string | null {
  if (spec.includes("{winHome}")) {
    if (winHome === null) return null;
    return spec.replaceAll("{winHome}", winHome);
  }
  return spec.replaceAll("{home}", home);
}

/** Windows profile under the mount root, e.g. /mnt/c/Users/alex. */
export function detectWindowsHome(ctx: Ctx): string | null {
  const fromEnv = ctx.env.USERPROFILE;
  if (fromEnv && /^[A-Za-z]:[\\/]/.test(fromEnv)) {
    const letter = fromEnv[0]!.toLowerCase();
    const rest = fromEnv.slice(2).replace(/\\/g, "/");
    return posix.join(ctx.mountRoot, letter, rest);
  }
  const usersDir = posix.join(ctx.mountRoot, "c/Users");
  if (!ctx.fs.exists(usersDir)) return null;
  const skip = new Set(["Public", "Default", "Default User", "All Users", "desktop.ini"]);
  const names = ctx.fs.readDir(usersDir).filter((n) => !skip.has(n) && !n.startsWith("."));
  if (names.length === 1) return posix.join(usersDir, names[0]!);
  // Prefer a profile that already has a Cursor or Claude config.
  for (const name of names) {
    const base = posix.join(usersDir, name);
    if (
      ctx.fs.exists(posix.join(base, ".cursor/mcp.json")) ||
      ctx.fs.exists(posix.join(base, "AppData/Roaming/Claude/claude_desktop_config.json"))
    ) {
      return base;
    }
  }
  return names[0] ? posix.join(usersDir, names[0]) : null;
}

function stripJsonc(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

export function parseMcpJson(text: string): McpServerDef[] {
  const cleaned = stripJsonc(text);
  const data = JSON.parse(cleaned) as Record<string, unknown>;
  const block =
    (data.mcpServers as Record<string, unknown> | undefined) ??
    (data.servers as Record<string, unknown> | undefined) ??
    {};
  const out: McpServerDef[] = [];
  for (const [name, raw] of Object.entries(block)) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== "string") continue;
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
    out.push({ name, command: entry.command, args });
  }
  return out;
}

/** Minimal TOML scrape for Codex: [mcp_servers.NAME] command = "..." args = ["..."]. */
export function parseMcpToml(text: string): McpServerDef[] {
  const out: McpServerDef[] = [];
  let current: McpServerDef | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[mcp_servers\.([^\]]+)\]/.exec(line) ?? /^\[mcpServers\.([^\]]+)\]/.exec(line);
    if (header) {
      if (current) out.push(current);
      current = { name: header[1]!, command: "", args: [] };
      continue;
    }
    if (current === null) continue;
    const cmd = /^command\s*=\s*"([^"]*)"/.exec(line);
    if (cmd) {
      current.command = cmd[1]!;
      continue;
    }
    const args = /^args\s*=\s*\[(.*)\]/.exec(line);
    if (args) {
      current.args = [...args[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    }
  }
  if (current && current.command) out.push(current);
  return out.filter((s) => s.command.length > 0);
}

export function parseMcpFile(path: string, text: string): McpServerDef[] {
  if (path.endsWith(".toml")) return parseMcpToml(text);
  return parseMcpJson(text);
}

export interface LaunchKind {
  view: ViewName | "windows-native" | "skipped";
  program: string | null;
  reason: string | null;
}

function basenameCmd(command: string): string {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/** Which view an MCP entry actually launches, and which program to resolve. */
export function inferLaunch(command: string, args: string[]): LaunchKind {
  const base = basenameCmd(command);
  if (base === "wsl" || base === "wsl.exe") {
    const joined = args.map((a) => a.toLowerCase());
    const eIdx = joined.indexOf("-e");
    if (eIdx >= 0) {
      const after = args.slice(eIdx + 1);
      if (after[0] === "bash" && (after[1] === "-lc" || after[1] === "-c")) {
        return { view: after[1] === "-lc" ? "login" : "exec", program: firstWord(after[2] ?? ""), reason: null };
      }
      if (after[0] === "sh" && after[1] === "-c") {
        return { view: "exec", program: firstWord(after[2] ?? ""), reason: null };
      }
      if (after[0] === "zsh" && (after[1] === "-c" || after[1] === "-lc")) {
        return { view: after[1] === "-lc" ? "login" : "exec-zsh", program: firstWord(after[2] ?? ""), reason: null };
      }
      return { view: "exec", program: basenameCmd(after[0] ?? ""), reason: null };
    }
    const bashIdx = joined.indexOf("bash");
    if (bashIdx >= 0 && (args[bashIdx + 1] === "-lc" || args[bashIdx + 1] === "-c")) {
      return {
        view: args[bashIdx + 1] === "-lc" ? "login" : "exec",
        program: firstWord(args[bashIdx + 2] ?? ""),
        reason: null,
      };
    }
    return { view: "login", program: firstWord(args[args.length - 1] ?? ""), reason: "wsl without -e; treating as login" };
  }
  if (base === "npx" || base === "node" || base === "bun" || base === "npm" || base === "pnpm" || base === "yarn") {
    return { view: "windows-native", program: base, reason: "bare runtime on the host that owns this config" };
  }
  return { view: "skipped", program: null, reason: `command ${command} is not wsl/npx/node/bun` };
}

function firstWord(script: string): string | null {
  const trimmed = script.trim();
  if (trimmed.length === 0) return null;
  const token = trimmed.split(/[\s;|&]+/)[0] ?? "";
  if (token.includes("=")) return firstWord(trimmed.slice(token.length));
  const base = basenameCmd(token);
  return base.length > 0 ? base : null;
}

function resolveProgram(program: string, view: ViewName, ctx: Ctx): Hit {
  const outcome = runLaunch(launchFor(view, LOOKUP_SCRIPT, [program], ctx), ctx);
  if (!outcome.ok) return { path: null, verdict: "missing" };
  const line = outcome.stdout.split("\n").find((l) => l.startsWith(`${program}\t`));
  const path = line ? line.slice(program.length + 1).trim() : null;
  const abs = path && path.startsWith("/") ? path : null;
  return { path: abs, verdict: classify(abs, ctx.mountRoot) };
}


function fixHintFor(row: Pick<McpServerRow, "status" | "view" | "program">): string | null {
  if (row.status === "ok" || row.status === "expected-windows" || row.status === "skipped") return null;
  if (row.view === "login") {
    return "print: add the Linux bin dir to the login profile (wsl-shadow --fix), or rewrite the MCP entry to prepend PATH";
  }
  if (row.view === "exec" || row.view === "exec-zsh") {
    return "print: symlink into /usr/local/bin (wsl-shadow --fix), or set PATH in the MCP args before the command";
  }
  if (row.view === "windows-native") {
    return "print: install the tool inside WSL and launch with wsl.exe -e, or keep it Windows-only on purpose";
  }
  return null;
}

export function scanMcp(ctx: Ctx, expectedWindows: ReadonlySet<string>): McpReport {
  const winHome = detectWindowsHome(ctx);
  const configs: McpConfigProbe[] = [];
  const servers: McpServerRow[] = [];

  for (const spec of MCP_PATHS) {
    const path = expandPath(spec.path, ctx.home, winHome);
    if (path === null) {
      configs.push({
        path: spec.path,
        source: spec.source,
        side: spec.side,
        confidence: spec.confidence,
        present: false,
        parseError: "Windows home not found under the mount root",
      });
      continue;
    }
    const text = ctx.fs.readText(path);
    if (text === null) {
      configs.push({
        path,
        source: spec.source,
        side: spec.side,
        confidence: spec.confidence,
        present: false,
        parseError: null,
      });
      continue;
    }
    let defs: McpServerDef[] = [];
    let parseError: string | null = null;
    try {
      defs = parseMcpFile(path, text);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    configs.push({
      path,
      source: spec.source,
      side: spec.side,
      confidence: spec.confidence,
      present: true,
      parseError,
    });
    if (parseError !== null) continue;

    for (const def of defs) {
      const kind = inferLaunch(def.command, def.args);
      if (kind.view === "skipped") {
        servers.push({
          configPath: path,
          source: spec.source,
          server: def.name,
          command: def.command,
          args: def.args,
          view: "skipped",
          program: null,
          resolvedPath: null,
          status: "skipped",
          consequence: kind.reason,
          fixHint: null,
        });
        continue;
      }
      if (kind.view === "windows-native") {
        // Not a measured WSL view: decideStatus needs real hits. Host-native is only expected-windows vs windows-only.
        const status: Status =
          kind.program !== null && expectedWindows.has(kind.program) ? "expected-windows" : "windows-only";
        const row: McpServerRow = {
          configPath: path,
          source: spec.source,
          server: def.name,
          command: def.command,
          args: def.args,
          view: "windows-native",
          program: kind.program,
          resolvedPath: null,
          status,
          consequence: kind.reason,
          fixHint: null,
        };
        row.fixHint = fixHintFor(row);
        servers.push(row);
        continue;
      }

      const program = kind.program;
      if (program === null) {
        servers.push({
          configPath: path,
          source: spec.source,
          server: def.name,
          command: def.command,
          args: def.args,
          view: kind.view,
          program: null,
          resolvedPath: null,
          status: "unavailable",
          consequence: "could not extract a program name from the MCP args",
          fixHint: null,
        });
        continue;
      }

      const hit = resolveProgram(program, kind.view, ctx);
      const hits = { [kind.view]: hit };
      const linuxCandidate = findLinuxCandidate(program, hits, ctx);
      const finalStatus = decideStatus(program, hits, linuxCandidate, expectedWindows).status;
      const row: McpServerRow = {
        configPath: path,
        source: spec.source,
        server: def.name,
        command: def.command,
        args: def.args,
        view: kind.view,
        program,
        resolvedPath: hit.path,
        status: finalStatus,
        consequence:
          finalStatus === "ok" || finalStatus === "expected-windows"
            ? null
            : `${program} resolves as ${hit.verdict} under the ${kind.view} launch`,
        fixHint: null,
      };
      row.fixHint =
        finalStatus === "shadow" || finalStatus === "windows-only" || finalStatus === "unreachable"
          ? fixHintFor(row)
          : null;
      servers.push(row);
    }
  }

  return { configs, servers };
}
