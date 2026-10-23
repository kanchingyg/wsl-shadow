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

export interface LinkCandidate {
  name: string;
  source: string;
}

export interface ProposedLinks {
  links: LinkSpec[];
  commands: string[];
  /** Names skipped because /usr/local/bin already has an entry (including dangling). */
  occupied: string[];
  /** Names skipped because the source path is missing. */
  missingSource: string[];
  pinned: boolean;
}

export interface ProposeLinksOptions {
  /** Names already proposed earlier in the same plan. */
  taken?: ReadonlySet<string>;
  /**
   * When true (npm globals), skip names whose source path is gone.
   * Tool rows leave this false: the scan already named a linuxCandidate.
   */
  requireSource?: boolean;
}

/**
 * One policy for every symlink proposal: never -f, prefer ~/.nvm/current, skip occupied names.
 */
export function proposeLinks(
  entries: readonly LinkCandidate[],
  ctx: Ctx,
  options: ProposeLinksOptions = {},
): ProposedLinks {
  const taken = options.taken ?? new Set();
  const requireSource = options.requireSource === true;
  const links: LinkSpec[] = [];
  const commands: string[] = [];
  const occupied: string[] = [];
  const missingSource: string[] = [];
  let pinned = false;

  for (const entry of entries) {
    if (taken.has(entry.name)) continue;
    const link = posix.join(LINK_DIR, entry.name);
    if (requireSource && !ctx.fs.exists(entry.source)) {
      missingSource.push(entry.name);
      continue;
    }
    if (ctx.fs.entryExists(link)) {
      occupied.push(ctx.fs.exists(link) ? entry.name : `${entry.name} (dangling)`);
      continue;
    }
    const { target, pinned: isPinned } = stableTarget(entry.source, entry.name, ctx);
    pinned = pinned || isPinned;
    commands.push(`sudo ln -s '${target}' ${link}`);
    links.push({ name: entry.name, link, target });
  }

  return { links, commands, occupied, missingSource, pinned };
}

/**
 * Shared warning text for every symlink proposal. `skipOverride: null` means "no skip line"
 * (npm globals folds occupied+missing into one sentence when present). Omit `skipOverride`
 * to use the default occupied / missing-source lines.
 */
function linkProposalNotes(
  proposed: ProposedLinks,
  opts: { lead?: string[]; trailer: string; skipOverride?: string | null },
): string {
  const notes: string[] = [...(opts.lead ?? [])];
  if (opts.skipOverride !== undefined) {
    // npm-globals: skip line, then pinned note, then trailer.
    if (opts.skipOverride !== null) notes.push(opts.skipOverride);
    if (proposed.pinned) notes.push(PINNED_NOTE);
  } else {
    // tool symlink: pinned note, then occupied / missing-source lines, then trailer.
    if (proposed.pinned) notes.push(PINNED_NOTE);
    if (proposed.occupied.length > 0) {
      notes.push(
        `Left alone because ${LINK_DIR} already has ${proposed.occupied.join(", ")}. Check them by hand; this tool never proposes -f.`,
      );
    }
    if (proposed.missingSource.length > 0) {
      notes.push(
        `Not linked (the source is gone): ${proposed.missingSource.join(", ")}. This tool never proposes -f.`,
      );
    }
  }
  if (opts.trailer.length > 0) notes.push(opts.trailer);
  return notes.join(" ");
}

function symlinkFix(rows: ToolRow[], ctx: Ctx): Fix | null {
  // An `ok` row is already Linux in every view; its npm globals are handled separately.
  const linkable = rows.filter((r) => r.linuxCandidate !== null && r.status !== "ok");
  if (linkable.length === 0) return null;

  const proposed = proposeLinks(
    linkable.map((r) => ({ name: r.tool, source: r.linuxCandidate! })),
    ctx,
  );
  if (proposed.commands.length === 0 && proposed.occupied.length === 0 && proposed.missingSource.length === 0) {
    return null;
  }

  return {
    order: 2,
    kind: "symlink",
    tools: linkable.map((r) => r.tool),
    fixesViews: unique(linkable.flatMap((r) => r.failingViews)),
    leavesBroken: [],
    file: null,
    content: null,
    commands: proposed.commands,
    links: proposed.links,
    warning: linkProposalNotes(proposed, {
      trailer: "Printed, not run. Needs sudo. Fixes every launch type, including spawn with no shell.",
    }),
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

  const proposed = proposeLinks(
    info.unlinked.map((name) => ({ name, source: posix.join(info.binDir!, name) })),
    ctx,
    { taken, requireSource: true },
  );

  const lead = [
    `${where}. A PATH block cannot help: sh -c, bash -c, wsl.exe -e and spawn read no startup file. The fix is a link in ${LINK_DIR}, which exec already searches.`,
  ];
  if (info.unlinked.length === 0) lead.push(`Could not list ${info.binDir}; link its entries by hand.`);
  const blocked = [...proposed.occupied, ...proposed.missingSource];

  return [
    {
      order: 2,
      kind: "symlink",
      tools: ["npm"],
      fixesViews: ["exec"],
      leavesBroken: [],
      file: null,
      content: null,
      commands: proposed.commands,
      links: proposed.links,
      warning: linkProposalNotes(proposed, {
        lead,
        skipOverride:
          blocked.length > 0
            ? `Not linked (name taken, or the source is gone): ${blocked.join(", ")}. This tool never proposes -f.`
            : null,
        trailer:
          proposed.links.length > 0
            ? "Printed, not run. Needs sudo. Run it again after each `npm i -g`: new globals are not linked automatically."
            : "",
      }),
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
      warning:
        "No Linux build found anywhere. Install these inside WSL yourself (apt, nvm, fnm, volta, the vendor's native installer). This tool installs nothing.",
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
    fixes.push(
      pathBlockFix("zsh", file, zsh, uniqueDirs(zsh), ctx, "zsh reads ~/.zshenv even for zsh -c. bash and sh launches do not."),
    );
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
