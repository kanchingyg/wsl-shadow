// SPDX-License-Identifier: AGPL-3.0-only
import { hasBlock } from "./block";
import type { FsOps, WritableFs } from "./env";
import {
  saveState,
  sha256Text,
  upsertFileRecord,
  upsertLinkRecord,
  type AppliedState,
  type PendingChange,
} from "./state";

/**
 * Resolves a crash left in `pending` against the real filesystem.
 * - If the change landed, promote it into `files`/`links` so `--undo` can reverse it.
 * - If it did not, drop the pending entry: there is nothing to undo.
 * Never invents a change that the disk does not show.
 */
export function settlePending(state: AppliedState, fs: FsOps): { state: AppliedState; notes: string[] } {
  if (state.pending.length === 0) return { state, notes: [] };
  const notes: string[] = [];
  const next: AppliedState = { ...state, files: [...state.files], links: [...state.links], pending: [] };

  for (const p of state.pending) {
    switch (p.kind) {
      case "block": {
        const current = fs.readText(p.file);
        if (current !== null && sha256Text(current) === p.intendedSha256) {
          upsertFileRecord(next, {
            path: p.file,
            existedBefore: p.existedBefore,
            originalBackup: p.originalBackup,
            writtenSha256: p.intendedSha256,
            appliedAt: p.startedAt,
          });
          notes.push(`settled pending block on ${p.file}: change landed; recorded for undo`);
        } else {
          notes.push(`settled pending block on ${p.file}: change did not land; dropped`);
        }
        break;
      }
      case "link": {
        if (fs.readLink(p.link) === p.target) {
          upsertLinkRecord(next, { link: p.link, target: p.target, appliedAt: p.startedAt });
          notes.push(`settled pending link ${p.link}: change landed; recorded for undo`);
        } else {
          notes.push(`settled pending link ${p.link}: change did not land; dropped`);
        }
        break;
      }
      case "unlink":
      case "prune": {
        if (fs.readLink(p.link) === p.target) {
          // Still our link: the removal never happened. Keep it in links (if missing, put it back).
          if (!next.links.some((l) => l.link === p.link)) {
            upsertLinkRecord(next, { link: p.link, target: p.target, appliedAt: p.startedAt });
          }
          notes.push(`settled pending ${p.kind} ${p.link}: still present; left for a later undo`);
        } else {
          next.links = next.links.filter((l) => l.link !== p.link);
          notes.push(`settled pending ${p.kind} ${p.link}: gone or retargeted; dropped from records`);
        }
        break;
      }
      case "restore": {
        const current = fs.readText(p.file);
        const gone = current === null;
        const restored =
          p.how === "remove-file"
            ? gone
            : p.how === "restore-backup" && p.originalBackup !== null
              ? current === fs.readText(p.originalBackup)
              : current !== null && !hasBlock(current);
        if (restored) {
          next.files = next.files.filter((f) => f.path !== p.file);
          notes.push(`settled pending restore of ${p.file}: undo landed; dropped from records`);
        } else {
          notes.push(`settled pending restore of ${p.file}: undo did not land; file record kept`);
        }
        break;
      }
      case "forget": {
        next.links = next.links.filter((l) => l.link !== p.link);
        notes.push(`settled pending forget of ${p.link}: dropped from records`);
        break;
      }
      default: {
        const unreachable: never = p;
        throw new Error(`unknown pending: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return { state: next, notes };
}

/** Load-time settle that also persists when anything changed. */
export function settleAndSave(
  loaded: AppliedState,
  fs: WritableFs,
  home: string,
): { state: AppliedState; notes: string[] } {
  const { state, notes } = settlePending(loaded, fs);
  if (notes.length > 0 || loaded.pending.length > 0) {
    // Always rewrite after a settle pass so a cleared pending list is durable.
    saveState(fs, home, state);
  }
  return { state, notes };
}

export type { PendingChange };
