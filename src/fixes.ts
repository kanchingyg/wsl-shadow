import { posix } from "node:path";
import type { Ctx } from "./env";
import type { Fix, ToolRow, ViewName } from "./types";

const BLOCK_START = "# >>> wsl-shadow >>>";
const BLOCK_END = "# <<< wsl-shadow <<<";
const NVM_VERSIONS = "/.nvm/versions/node/";

function withHomeVar(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `$HOME${path.slice(home.length)}` : path;
}

function pathBlock(dirs: string[], home: string): string {
  const joined = dirs.map((d) => withHomeVar(d, home)).join(":");
  return `${BLOCK_START}\nexport PATH="${joined}:$PATH"\n${BLOCK_END}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function failing(rows: ToolRow[], view: ViewName): ToolRow[] {
  return rows.filter((r) => r.linuxCandidate !== null && r.failingViews.includes(view));
}

function uniqueDirs(rows: ToolRow[]): string[] {
  return unique(rows.map((r) => posix.dirname(r.linuxCandidate!)));
}

function stillBroken(rows: ToolRow[], fixed: ViewName[]): ViewName[] {
  return unique(rows.flatMap((r) => r.failingViews)).filter((v) => !fixed.includes(v));
}

/** Bash reads the first of these that exists. ~/.profile is skipped if either of the others is there. */
export function loginFile(ctx: Ctx): string {
  for (const name of [".bash_profile", ".bash_login", ".profile"]) {
    const file = posix.join(ctx.home, name);
    if (ctx.fs.exists(file)) return file;
  }
  return posix.join(ctx.home, ".profile");
}

interface LinkTarget {
  target: string;
  pinned: boolean;
}

/** Prefer nvm's stable `current` link over a pinned version directory. */
function linkTarget(row: ToolRow, ctx: Ctx): LinkTarget {
  const candidate = row.linuxCandidate!;
  if (!candidate.includes(NVM_VERSIONS)) return { target: candidate, pinned: false };
  const current = posix.join(ctx.home, ".nvm/current/bin", row.tool);
  return ctx.fs.exists(current) ? { target: current, pinned: false } : { target: candidate, pinned: true };
}

const PINNED_NOTE =
  "Points at one pinned nvm version, so it goes stale when the default Node changes. " +
  "For a stable link: add `export NVM_SYMLINK_CURRENT=true` to ~/.bashrc, run `nvm use default`, " +
  "then link to ~/.nvm/current/bin/<tool> instead. (Not verified: nvm's README warns about races between terminal tabs.)";

function symlinkFix(rows: ToolRow[], ctx: Ctx): Fix | null {
  const linkable = rows.filter((r) => r.linuxCandidate !== null);
  if (linkable.length === 0) return null;

  const commands: string[] = [];
  const skipped: string[] = [];
  let pinned = false;
  for (const row of linkable) {
    const link = `/usr/local/bin/${row.tool}`;
    if (ctx.fs.exists(link)) {
      skipped.push(row.tool);
      continue;
    }
    const { target, pinned: isPinned } = linkTarget(row, ctx);
    pinned = pinned || isPinned;
    commands.push(`sudo ln -s '${target}' ${link}`);
  }

  const notes: string[] = [];
  if (pinned) notes.push(PINNED_NOTE);
  if (skipped.length > 0) {
    notes.push(`Left alone because /usr/local/bin already has ${skipped.join(", ")}. Check them by hand; this tool never proposes -f.`);
  }
  if (commands.length === 0 && notes.length === 0) return null;
  notes.push("Printed, not run. Needs sudo. Fixes every launch type, including spawn with no shell.");

  return {
    order: 2,
    kind: "symlink",
    tools: linkable.map((r) => r.tool),
    fixesViews: unique(linkable.flatMap((r) => r.failingViews)),
    leavesBroken: [],
    file: null,
    content: null,
    commands,
    warning: notes.join(" "),
  };
}

/** Dry-run proposals in the order we recommend them. Nothing here is applied or run. */
export function buildFixes(rows: ToolRow[], ctx: Ctx): Fix[] {
  const broken = rows.filter(
    (r) => r.status === "shadow" || r.status === "windows-only" || r.status === "unreachable",
  );
  if (broken.length === 0) return [];

  const fixes: Fix[] = [];

  const noLinux = broken.filter((r) => r.linuxCandidate === null);
  if (noLinux.length > 0) {
    fixes.push({
      order: 0,
      kind: "install",
      tools: noLinux.map((r) => r.tool),
      fixesViews: [],
      leavesBroken: stillBroken(noLinux, []),
      file: null,
      content: null,
      commands: [],
      warning: "No Linux build found anywhere. Install these inside WSL yourself (apt, nvm, fnm, volta, the vendor's native installer). This tool installs nothing.",
    });
  }

  const login = failing(broken, "login");
  if (login.length > 0) {
    const file = loginFile(ctx);
    const notes: string[] = [];
    if (!file.endsWith("/.profile")) {
      notes.push(`${posix.basename(file)} exists, so bash ignores ~/.profile. The block goes there instead.`);
    }
    if (login.some((r) => r.linuxCandidate!.includes(NVM_VERSIONS))) {
      notes.push("nvm paths change with the Node version. Regenerate this block after `nvm alias default`.");
    }
    notes.push("Only login shells read this file. sh -c, bash -c, wsl.exe -e and spawn do not.");
    fixes.push({
      order: 1,
      kind: "path-block",
      tools: login.map((r) => r.tool),
      fixesViews: ["login"],
      leavesBroken: stillBroken(login, ["login"]),
      file,
      content: pathBlock(uniqueDirs(login), ctx.home),
      commands: [],
      warning: notes.join(" "),
    });
  }

  const zsh = failing(broken, "exec-zsh");
  if (zsh.length > 0) {
    fixes.push({
      order: 1,
      kind: "path-block",
      tools: zsh.map((r) => r.tool),
      fixesViews: ["exec-zsh"],
      leavesBroken: stillBroken(zsh, ["exec-zsh"]),
      file: posix.join(ctx.home, ".zshenv"),
      content: pathBlock(uniqueDirs(zsh), ctx.home),
      commands: [],
      warning: "zsh reads ~/.zshenv even for zsh -c. bash and sh launches do not.",
    });
  }

  const symlink = symlinkFix(broken, ctx);
  if (symlink !== null) fixes.push(symlink);

  // Only `shadow` can be fixed this way: a Linux build exists and Windows is merely winning.
  // windows-only and unreachable tools would end up "not found", not fixed.
  const shadowed = broken.filter((r) => r.status === "shadow");
  const unreachable = broken.filter((r) => r.status !== "shadow");
  if (shadowed.length > 0) {
    const fixed = unique(shadowed.flatMap((r) => r.failingViews));
    fixes.push({
      order: 4,
      kind: "last-resort",
      tools: shadowed.map((r) => r.tool),
      fixesViews: fixed,
      leavesBroken: unique(unreachable.flatMap((r) => r.failingViews)),
      file: "/etc/wsl.conf",
      content: "[interop]\nappendWindowsPath=false",
      commands: ["wsl.exe --shutdown   # from Windows, then reopen WSL"],
      warning:
        "Printed only; this tool never edits wsl.conf. Removes every Windows directory from PATH, so code, explorer.exe and cmd.exe stop resolving by name. " +
        "It does not fix unreachable or windows-only tools: node would still not be found, and npm would go from Windows to not found. Try the options above first.",
    });
  }

  return fixes.sort((a, b) => a.order - b.order);
}
