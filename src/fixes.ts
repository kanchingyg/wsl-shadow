// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path";
import type { Ctx } from "./env";
import type { Fix, LinkSpec, NpmPrefixInfo, ToolRow, ViewName } from "./types";

export const BLOCK_START = "# >>> wsl-shadow >>>";
export const BLOCK_END = "# <<< wsl-shadow <<<";
export const LINK_DIR = "/usr/local/bin";
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

function stillBroken(rows: Pick<ToolRow, "failingViews">[], fixed: ViewName[]): ViewName[] {
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
export function stableTarget(path: string, name: string, ctx: Ctx): LinkTarget {
  if (!path.includes(NVM_VERSIONS)) return { target: path, pinned: false };
  const current = posix.join(ctx.home, ".nvm/current/bin", name);
  return ctx.fs.exists(current) ? { target: current, pinned: false } : { target: path, pinned: true };
}

/**
 * The only way to build a path-block proposal. A login file helps `bash -l`; ~/.zshenv helps `zsh -c`.
 * Nothing here can claim `exec`: sh -c, bash -c, wsl.exe -e and spawn read no startup file.
 */
function pathBlockFix(
  shell: "login" | "zsh",
  file: string,
  rows: Pick<ToolRow, "tool" | "failingViews">[],
  dirs: string[],
  ctx: Ctx,
  warning: string,
): Fix {
  const fixed: ViewName = shell === "login" ? "login" : "exec-zsh";
  return {
    order: 1,
    kind: "path-block",
    tools: unique(rows.map((r) => r.tool)),
    fixesViews: [fixed],
    leavesBroken: stillBroken(rows, [fixed]),
    file,
    content: pathBlock(dirs, ctx.home),
    commands: [],
    links: [],
    warning,
  };
}
const PINNED_NOTE =
  "Points at one pinned nvm version, so it goes stale when the default Node changes. " +
  "For a stable link: add `export NVM_SYMLINK_CURRENT=true` to ~/.bashrc, run `nvm use default`, " +
  "then link to ~/.nvm/current/bin/<tool> instead. (Not verified: nvm's README warns about races between terminal tabs.)";

function symlinkFix(rows: ToolRow[], ctx: Ctx): Fix | null {
  // An `ok` row is already Linux in every view; its npm globals are handled separately.
  const linkable = rows.filter((r) => r.linuxCandidate !== null && r.status !== "ok");
  if (linkable.length === 0) return null;

  const commands: string[] = [];
  const links: LinkSpec[] = [];
  const skipped: string[] = [];
  let pinned = false;
  for (const row of linkable) {
    const link = posix.join(LINK_DIR, row.tool);
    if (ctx.fs.entryExists(link)) {
      skipped.push(ctx.fs.exists(link) ? row.tool : `${row.tool} (dangling)`);
      continue;
    }
    const { target, pinned: isPinned } = stableTarget(row.linuxCandidate!, row.tool, ctx);
    pinned = pinned || isPinned;
    commands.push(`sudo ln -s '${target}' ${link}`);
    links.push({ name: row.tool, link, target });
  }

  const notes: string[] = [];
  if (pinned) notes.push(PINNED_NOTE);
  if (skipped.length > 0) {
    notes.push(`Left alone because ${LINK_DIR} already has ${skipped.join(", ")}. Check them by hand; this tool never proposes -f.`);
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
    links,
    warning: notes.join(" "),
  };
}

/**
 * Globals that `npm i -g` put in a prefix bin dir this launch does not search.
 * Only a link in a dir `exec` already searches helps it; a PATH block cannot.
 */
function npmGlobalsFixes(info: NpmPrefixInfo, taken: ReadonlySet<string>, ctx: Ctx): Fix[] {
  if (info.binDir === null) return [];
  const where = `npm config get prefix in ${info.view} is ${info.prefix}; globals land in ${info.binDir}, which that launch does not search`;

  if (info.view === "login" || info.view === "exec-zsh") {
    const shell = info.view === "login" ? "login" : "zsh";
    const file = shell === "login" ? loginFile(ctx) : posix.join(ctx.home, ".zshenv");
    const read = shell === "login" ? "Only login shells read this file." : "zsh reads ~/.zshenv even for zsh -c.";
    const npm = { tool: "npm", failingViews: [] };
    return [pathBlockFix(shell, file, [npm], [info.binDir], ctx, `${where}. ${read} sh -c and wsl.exe -e do not.`)];
  }
  if (info.view !== "exec") return [];

  const commands: string[] = [];
  const links: LinkSpec[] = [];
  const blocked: string[] = [];
  let pinned = false;
  for (const name of info.unlinked.filter((n) => !taken.has(n))) {
    const link = posix.join(LINK_DIR, name);
    const source = posix.join(info.binDir, name);
    if (ctx.fs.entryExists(link) || !ctx.fs.exists(source)) {
      blocked.push(name);
      continue;
    }
    const { target, pinned: isPinned } = stableTarget(source, name, ctx);
    pinned = pinned || isPinned;
    commands.push(`sudo ln -s '${target}' ${link}`);
    links.push({ name, link, target });
  }

  const notes = [
    `${where}. A PATH block cannot help: sh -c, bash -c, wsl.exe -e and spawn read no startup file. The fix is a link in ${LINK_DIR}, which exec already searches.`,
  ];
  if (info.unlinked.length === 0) notes.push(`Could not list ${info.binDir}; link its entries by hand.`);
  if (blocked.length > 0) {
    notes.push(`Not linked (name taken, or the source is gone): ${blocked.join(", ")}. This tool never proposes -f.`);
  }
  if (pinned) notes.push(PINNED_NOTE);
  if (links.length > 0) {
    notes.push("Printed, not run. Needs sudo. Run it again after each `npm i -g`: new globals are not linked automatically.");
  }
  return [
    {
      order: 2,
      kind: "symlink",
      tools: ["npm"],
      fixesViews: ["exec"],
      leavesBroken: [],
      file: null,
      content: null,
      commands,
      links,
      warning: notes.join(" "),
    },
  ];
}

/** Dry-run proposals in the order we recommend them. Nothing here is applied or run. */
export function buildFixes(rows: ToolRow[], ctx: Ctx): Fix[] {
  const broken = rows.filter(
    (r) =>
      r.status === "shadow" ||
      r.status === "windows-only" ||
      r.status === "unreachable" ||
      r.status === "drift" ||
      (r.status === "ok" && r.npmPrefix?.invisibleToView === true),
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
      links: [],
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
    fixes.push(pathBlockFix("login", file, login, uniqueDirs(login), ctx, notes.join(" ")));
  }

  const zsh = failing(broken, "exec-zsh");
  if (zsh.length > 0) {
    const file = posix.join(ctx.home, ".zshenv");
    fixes.push(pathBlockFix("zsh", file, zsh, uniqueDirs(zsh), ctx, "zsh reads ~/.zshenv even for zsh -c. bash and sh launches do not."));
  }

  const symlink = symlinkFix(broken, ctx);
  if (symlink !== null) fixes.push(symlink);

  const invisibleNpm = broken.find((r) => r.tool === "npm" && r.npmPrefix?.invisibleToView === true);
  if (invisibleNpm?.npmPrefix) {
    const taken = new Set(symlink?.links.map((l) => l.name) ?? []);
    fixes.push(...npmGlobalsFixes(invisibleNpm.npmPrefix, taken, ctx));
  }

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
      links: [],
      warning:
        "Printed only; this tool never edits wsl.conf. Removes every Windows directory from PATH, so code, explorer.exe and cmd.exe stop resolving by name. " +
        "It does not fix unreachable or windows-only tools: node would still not be found, and npm would go from Windows to not found. Try the options above first.",
    });
  }

  return fixes.sort((a, b) => a.order - b.order);
}