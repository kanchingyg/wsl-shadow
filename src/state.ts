// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { FsOps, WritableFs } from "./env";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function upsertFileRecord(state: AppliedState, record: AppliedFile): void {
  state.files = [...state.files.filter((f) => f.path !== record.path), record];
}

export function upsertLinkRecord(state: AppliedState, record: AppliedLink): void {
  state.links = [...state.links.filter((l) => l.link !== record.link), record];
}

export interface AppliedFile {
  path: string;
  existedBefore: boolean;
  /** First copy of the file from before this tool touched it. Null when it did not exist. */
  originalBackup: string | null;
  /** SHA-256 of what this tool last wrote, to tell later whether the user edited the file since. */
  writtenSha256: string;
  appliedAt: string;
}

export interface AppliedLink {
  link: string;
  target: string;
  appliedAt: string;
}

export interface HistoryEntry {
  at: string;
  action: "apply" | "undo";
  changes: string[];
}

/**
 * Intent written (and fsynced) before a change. Cleared after the change is recorded as done.
 * A crash leaves this here; the next plan settles it against the real filesystem.
 */
export type PendingChange =
  | {
      kind: "block";
      file: string;
      intendedSha256: string;
      previousSha256: string | null;
      existedBefore: boolean;
      originalBackup: string | null;
      startedAt: string;
    }
  | {
      kind: "link";
      link: string;
      target: string;
      startedAt: string;
    }
  | {
      kind: "unlink" | "prune";
      link: string;
      target: string;
      startedAt: string;
    }
  | {
      kind: "restore";
      file: string;
      how: "restore-backup" | "remove-file" | "strip-block";
      originalBackup: string | null;
      existedBefore: boolean;
      previousSha256: string | null;
      startedAt: string;
    }
  | {
      kind: "forget";
      link: string;
      startedAt: string;
    };

/** Everything the tool created. `--undo` removes only what is listed here (after pending is settled). */
export interface AppliedState {
  schemaVersion: 1;
  files: AppliedFile[];
  links: AppliedLink[];
  history: HistoryEntry[];
  /** At most one in-flight change. Empty when idle. */
  pending: PendingChange[];
}

const HISTORY_LIMIT = 50;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function stateDir(home: string): string {
  return posix.join(home, ".local/state/wsl-shadow");
}

export function statePath(home: string): string {
  return posix.join(stateDir(home), "applied.json");
}

export function backupDir(home: string): string {
  return posix.join(stateDir(home), "backups");
}

export function emptyState(): AppliedState {
  return { schemaVersion: 1, files: [], links: [], history: [], pending: [] };
}

export type StateLoad = { ok: true; state: AppliedState } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function requireStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function parseAppliedFile(value: unknown, index: number): AppliedFile | string {
  const label = `files[${index}]`;
  if (!isRecord(value)) return `${label} is not an object`;
  const path = requireString(value.path);
  const existedBefore = requireBoolean(value.existedBefore);
  const writtenSha256 = requireString(value.writtenSha256);
  const appliedAt = requireString(value.appliedAt);
  const originalBackup = requireStringOrNull(value.originalBackup);
  if (path === null) return `${label}.path must be a string`;
  if (existedBefore === null) return `${label}.existedBefore must be a boolean`;
  if (writtenSha256 === null || !SHA256_RE.test(writtenSha256)) {
    return `${label}.writtenSha256 must be a 64-char hex SHA-256`;
  }
  if (appliedAt === null) return `${label}.appliedAt must be a string`;
  if (originalBackup === undefined) return `${label}.originalBackup must be a string or null`;
  return { path, existedBefore, originalBackup, writtenSha256, appliedAt };
}

function parseAppliedLink(value: unknown, index: number): AppliedLink | string {
  const label = `links[${index}]`;
  if (!isRecord(value)) return `${label} is not an object`;
  const link = requireString(value.link);
  const target = requireString(value.target);
  const appliedAt = requireString(value.appliedAt);
  if (link === null) return `${label}.link must be a string`;
  if (target === null) return `${label}.target must be a string`;
  if (appliedAt === null) return `${label}.appliedAt must be a string`;
  return { link, target, appliedAt };
}

function parseHistoryEntry(value: unknown, index: number): HistoryEntry | string {
  const label = `history[${index}]`;
  if (!isRecord(value)) return `${label} is not an object`;
  const at = requireString(value.at);
  const action = requireString(value.action);
  if (at === null) return `${label}.at must be a string`;
  if (action !== "apply" && action !== "undo") return `${label}.action must be "apply" or "undo"`;
  if (!Array.isArray(value.changes) || !value.changes.every((c) => typeof c === "string")) {
    return `${label}.changes must be an array of strings`;
  }
  return { at, action, changes: value.changes };
}

function parsePending(value: unknown, index: number): PendingChange | string {
  const label = `pending[${index}]`;
  if (!isRecord(value)) return `${label} is not an object`;
  const kind = requireString(value.kind);
  if (kind === null) return `${label}.kind must be a string`;
  const startedAt = requireString(value.startedAt);
  if (startedAt === null) return `${label}.startedAt must be a string`;

  switch (kind) {
    case "block": {
      const file = requireString(value.file);
      const intendedSha256 = requireString(value.intendedSha256);
      const existedBefore = requireBoolean(value.existedBefore);
      const originalBackup = requireStringOrNull(value.originalBackup);
      const previousSha256 = requireStringOrNull(value.previousSha256);
      if (file === null) return `${label}.file must be a string`;
      if (intendedSha256 === null || !SHA256_RE.test(intendedSha256)) {
        return `${label}.intendedSha256 must be a 64-char hex SHA-256`;
      }
      if (existedBefore === null) return `${label}.existedBefore must be a boolean`;
      if (originalBackup === undefined) return `${label}.originalBackup must be a string or null`;
      if (previousSha256 === undefined) return `${label}.previousSha256 must be a string or null`;
      if (previousSha256 !== null && !SHA256_RE.test(previousSha256)) {
        return `${label}.previousSha256 must be a 64-char hex SHA-256 or null`;
      }
      return {
        kind: "block",
        file,
        intendedSha256,
        previousSha256,
        existedBefore,
        originalBackup,
        startedAt,
      };
    }
    case "link": {
      const link = requireString(value.link);
      const target = requireString(value.target);
      if (link === null) return `${label}.link must be a string`;
      if (target === null) return `${label}.target must be a string`;
      return { kind: "link", link, target, startedAt };
    }
    case "unlink":
    case "prune": {
      const link = requireString(value.link);
      const target = requireString(value.target);
      if (link === null) return `${label}.link must be a string`;
      if (target === null) return `${label}.target must be a string`;
      return { kind, link, target, startedAt };
    }
    case "restore": {
      const file = requireString(value.file);
      const how = requireString(value.how);
      const existedBefore = requireBoolean(value.existedBefore);
      const originalBackup = requireStringOrNull(value.originalBackup);
      const previousSha256 = requireStringOrNull(value.previousSha256);
      if (file === null) return `${label}.file must be a string`;
      if (how !== "restore-backup" && how !== "remove-file" && how !== "strip-block") {
        return `${label}.how must be restore-backup, remove-file, or strip-block`;
      }
      if (existedBefore === null) return `${label}.existedBefore must be a boolean`;
      if (originalBackup === undefined) return `${label}.originalBackup must be a string or null`;
      if (previousSha256 === undefined) return `${label}.previousSha256 must be a string or null`;
      if (previousSha256 !== null && !SHA256_RE.test(previousSha256)) {
        return `${label}.previousSha256 must be a 64-char hex SHA-256 or null`;
      }
      return {
        kind: "restore",
        file,
        how,
        originalBackup,
        existedBefore,
        previousSha256,
        startedAt,
      };
    }
    case "forget": {
      const link = requireString(value.link);
      if (link === null) return `${label}.link must be a string`;
      return { kind: "forget", link, startedAt };
    }
    default:
      return `${label} has unknown kind ${JSON.stringify(kind)}; refusing to load so --undo cannot invent a reverse`;
  }
}

/**
 * A missing file is an empty state. Corrupt JSON, wrong schema, or unknown pending kinds fail closed:
 * the caller must not plan or undo until the file is fixed by hand. Never invents records.
 */
export function loadState(fs: FsOps, home: string): StateLoad {
  const path = statePath(home);
  const text = fs.readText(path);
  if (text === null) return { ok: true, state: emptyState() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `${path} is not valid JSON: ${String(error)}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: `${path} is not a wsl-shadow state file` };
  if (parsed.schemaVersion !== 1) {
    return { ok: false, reason: `${path} has unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}` };
  }
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.links)) {
    return { ok: false, reason: `${path} is not a wsl-shadow state file` };
  }

  const files: AppliedFile[] = [];
  for (let i = 0; i < parsed.files.length; i++) {
    const item = parseAppliedFile(parsed.files[i], i);
    if (typeof item === "string") return { ok: false, reason: `${path}: ${item}` };
    files.push(item);
  }

  const links: AppliedLink[] = [];
  for (let i = 0; i < parsed.links.length; i++) {
    const item = parseAppliedLink(parsed.links[i], i);
    if (typeof item === "string") return { ok: false, reason: `${path}: ${item}` };
    links.push(item);
  }

  const historyRaw = parsed.history === undefined ? [] : parsed.history;
  if (!Array.isArray(historyRaw)) return { ok: false, reason: `${path}: history must be an array` };
  const history: HistoryEntry[] = [];
  for (let i = 0; i < historyRaw.length; i++) {
    const item = parseHistoryEntry(historyRaw[i], i);
    if (typeof item === "string") return { ok: false, reason: `${path}: ${item}` };
    history.push(item);
  }

  const pendingRaw = parsed.pending === undefined ? [] : parsed.pending;
  if (!Array.isArray(pendingRaw)) return { ok: false, reason: `${path}: pending must be an array` };
  if (pendingRaw.length > 1) {
    return {
      ok: false,
      reason: `${path}: pending has ${pendingRaw.length} entries; at most one in-flight change is allowed`,
    };
  }
  const pending: PendingChange[] = [];
  for (let i = 0; i < pendingRaw.length; i++) {
    const item = parsePending(pendingRaw[i], i);
    if (typeof item === "string") return { ok: false, reason: `${path}: ${item}` };
    pending.push(item);
  }

  return {
    ok: true,
    state: { schemaVersion: 1, files, links, history, pending },
  };
}

/**
 * Writes the state through a temp file, fsyncs the temp, renames, then fsyncs the directory.
 * A crash never leaves a half-written JSON file.
 */
export function saveState(fs: WritableFs, home: string, state: AppliedState): void {
  const dir = stateDir(home);
  fs.mkdirp(dir);
  const trimmed: AppliedState = {
    ...state,
    history: state.history.slice(-HISTORY_LIMIT),
    pending: state.pending,
  };
  const path = statePath(home);
  const tmp = `${path}.tmp`;
  fs.writeText(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { sync: true });
  fs.rename(tmp, path);
  fs.syncDir(dir);
}

/** Drop a pending entry and save. Used when the change failed before it took effect. */
export function clearPending(fs: WritableFs, home: string, state: AppliedState): void {
  state.pending = [];
  saveState(fs, home, state);
}
