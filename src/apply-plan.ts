// SPDX-License-Identifier: AGPL-3.0-only
import { posix } from "node:path";
import { blockProblem, upsertBlock } from "./block";
import { classify } from "./classify";
import type { ApplyDeps, Plan, Skipped, Step } from "./apply-types";
import { LINK_DIR } from "./fixes";
import { settleAndSave } from "./settle";
import { loadState, sha256Text, type AppliedState } from "./state";
import type { Fix } from "./types";

/** Only these files in $HOME are ever edited. */
const EDITABLE = new Set([".profile", ".bash_profile", ".bash_login", ".zshenv"]);

export function refusalFor(deps: ApplyDeps): string | null {
  if (deps.ctx.distro === null) return "run this inside WSL: it edits your Linux home and /usr/local/bin";
  if (deps.isRoot) return "do not run as root: it edits your home and asks sudo only for the link commands";
  return null;
}

function editable(file: string, home: string): string | null {
  if (posix.dirname(file) !== home || !EDITABLE.has(posix.basename(file))) {
    return `only ${[...EDITABLE].join(", ")} directly in ${home} may be edited`;
  }
  return null;
}

function uniqueLinks(fixes: Fix[]): Fix["links"] {
  const seen = new Set<string>();
  return fixes
    .filter((f) => f.kind === "symlink")
    .flatMap((f) => f.links)
    .filter((l) => (seen.has(l.link) ? false : (seen.add(l.link), true)));
}

/** Load state, refuse on corrupt files, then settle any leftover pending against the disk. */
export function loadSettled(
  deps: ApplyDeps,
): { ok: true; state: AppliedState; settled: string[] } | { ok: false; reason: string } {
  const loaded = loadState(deps.fs, deps.ctx.home);
  if (!loaded.ok) return loaded;
  const { state, notes } = settleAndSave(loaded.state, deps.fs, deps.ctx.home);
  return { ok: true, state, settled: notes };
}

/** What `--apply` would do, from the proposals and the state file. Reads only (after settling pending). */
export function planApply(fixes: Fix[], deps: ApplyDeps): Plan {
  const refusal = refusalFor(deps);
  if (refusal !== null) return { steps: [], skipped: [], settled: [], refusal };
  const loaded = loadSettled(deps);
  if (!loaded.ok) return { steps: [], skipped: [], settled: [], refusal: loaded.reason };
  const { state, settled } = loaded;
  const { ctx, fs } = deps;

  const steps: Step[] = [];
  const skipped: Skipped[] = [];

  for (const fix of fixes.filter((f) => f.kind === "path-block")) {
    if (fix.file === null || fix.content === null) continue;
    const why = editable(fix.file, ctx.home) ?? blockProblem(fix.content, ctx.home, fs, ctx.mountRoot);
    if (why !== null) {
      skipped.push({ what: fix.file, reason: why });
      continue;
    }
    const before = fs.readText(fix.file) ?? "";
    steps.push({
      kind: "block",
      file: fix.file,
      content: fix.content,
      shell: fix.file.endsWith(".zshenv") ? "zsh" : "bash",
      unchanged: fs.exists(fix.file) && upsertBlock(before, fix.content) === before,
    });
  }

  for (const rec of state.links) {
    const current = fs.readLink(rec.link);
    if (current !== rec.target) {
      steps.push({
        kind: "forget",
        link: rec.link,
        reason: current === null ? "no longer exists" : "now points elsewhere; not ours to touch",
      });
    } else if (!fs.exists(rec.link)) {
      steps.push({ kind: "prune", link: rec.link, target: rec.target });
    }
  }

  for (const spec of uniqueLinks(fixes)) {
    const ours = state.links.find((l) => l.link === spec.link);
    if (ours !== undefined && fs.readLink(spec.link) === ours.target) continue;
    if (posix.dirname(spec.link) !== LINK_DIR) {
      skipped.push({ what: spec.link, reason: `links are only created in ${LINK_DIR}` });
    } else if (classify(spec.target, ctx.mountRoot) !== "linux" || !spec.target.startsWith("/")) {
      skipped.push({ what: spec.link, reason: `target is not a Linux path: ${spec.target}` });
    } else if (!fs.exists(spec.target)) {
      skipped.push({ what: spec.link, reason: `target does not exist: ${spec.target}` });
    } else if (fs.entryExists(spec.link)) {
      skipped.push({ what: spec.link, reason: "already exists; never overwritten" });
    } else {
      steps.push({ kind: "link", name: spec.name, link: spec.link, target: spec.target });
    }
  }

  return { steps, skipped, settled, refusal: null };
}

/** What `--undo` would do: only what the state file lists, after settling any pending crash. */
export function planUndo(deps: ApplyDeps): Plan {
  const refusal = refusalFor(deps);
  if (refusal !== null) return { steps: [], skipped: [], settled: [], refusal };
  const loaded = loadSettled(deps);
  if (!loaded.ok) return { steps: [], skipped: [], settled: [], refusal: loaded.reason };
  const { state, settled } = loaded;
  const { fs } = deps;

  const steps: Step[] = [];
  const skipped: Skipped[] = [];
  for (const rec of state.files) {
    const current = fs.readText(rec.path);
    const untouched = current !== null && sha256Text(current) === rec.writtenSha256;
    if (rec.existedBefore && rec.originalBackup !== null && fs.exists(rec.originalBackup) && (untouched || current === null)) {
      steps.push({ kind: "restore", file: rec.path, how: "restore-backup" });
    } else if (!rec.existedBefore && untouched) {
      steps.push({ kind: "restore", file: rec.path, how: "remove-file" });
    } else if (current !== null) {
      steps.push({ kind: "restore", file: rec.path, how: "strip-block" });
    } else {
      skipped.push({ what: rec.path, reason: "already gone" });
    }
  }
  for (const rec of state.links) {
    if (fs.readLink(rec.link) === rec.target) {
      steps.push({ kind: "unlink", link: rec.link, target: rec.target });
    } else {
      steps.push({
        kind: "forget",
        link: rec.link,
        reason: fs.readLink(rec.link) === null ? "no longer exists" : "now points elsewhere; not ours to touch",
      });
    }
  }
  return { steps, skipped, settled, refusal: null };
}
