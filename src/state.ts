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

/** A missing file is an empty state. A file we cannot read is an error: we never guess what we created. */
export function loadState(fs: FsOps, home: string): StateLoad {
  const text = fs.readText(statePath(home));
  if (text === null) return { ok: true, state: emptyState() };
  try {
    const parsed = JSON.parse(text) as Partial<AppliedState>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.links)) {
      return { ok: false, reason: `${statePath(home)} is not a wsl-shadow state file` };
    }
    return {
      ok: true,
      state: {
        schemaVersion: 1,
        files: parsed.files,
        links: parsed.links,
        history: parsed.history ?? [],
        pending: Array.isArray(parsed.pending) ? (parsed.pending as PendingChange[]) : [],
      },
    };
  } catch (error) {
    return { ok: false, reason: `${statePath(home)} is not valid JSON: ${String(error)}` };
  }
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
