// SPDX-License-Identifier: AGPL-3.0-only
import type { Hit, Status, VersionHit, ViewName } from "./types";

export interface Decision {
  status: Status;
  failingViews: ViewName[];
}

function viewsWith(entries: [ViewName, Hit][], verdict: Hit["verdict"]): ViewName[] {
  return entries.filter(([, hit]) => hit.verdict === verdict).map(([view]) => view);
}

/**
 * ok: every measured view resolves to Linux.
 * shadow: a Linux build exists but some view resolves to Windows. This is the bug.
 * windows-only: some view resolves to Windows and no Linux build exists anywhere.
 * unreachable: a Linux build exists but some view finds nothing.
 * missing: no view finds it and no Linux build exists.
 * expected-windows: meant to be the Windows build (cursor, code, or --expect-windows).
 * unmeasured: no view could be measured.
 */
export function decideStatus(
  tool: string,
  hits: Partial<Record<ViewName, Hit>>,
  linuxCandidate: string | null,
  expectedWindows: ReadonlySet<string>,
): Decision {
  const entries = Object.entries(hits) as [ViewName, Hit][];
  if (entries.length === 0) return { status: "unmeasured", failingViews: [] };

  const windows = viewsWith(entries, "windows");
  const missing = viewsWith(entries, "missing");

  if (windows.length > 0) {
    if (expectedWindows.has(tool)) return { status: "expected-windows", failingViews: [] };
    return { status: linuxCandidate ? "shadow" : "windows-only", failingViews: windows };
  }
  if (missing.length === entries.length) {
    return linuxCandidate
      ? { status: "unreachable", failingViews: missing }
      : { status: "missing", failingViews: [] };
  }
  if (missing.length > 0) return { status: "unreachable", failingViews: missing };
  return { status: "ok", failingViews: [] };
}

/** Same Linux paths can still hide different builds; versions that disagree become drift. */
export function applyDrift(status: Status, versions: VersionHit[]): Status {
  if (status !== "ok") return status;
  const seen = new Set(versions.map((v) => v.version).filter((v): v is string => v !== null && v.length > 0));
  return seen.size > 1 ? "drift" : "ok";
}

export function isProblem(status: Status): boolean {
  switch (status) {
    case "shadow":
    case "windows-only":
    case "unreachable":
    case "drift":
      return true;
    case "ok":
    case "missing":
    case "expected-windows":
    case "unmeasured":
      return false;
    default: {
      const unreachable: never = status;
      throw new Error(`unknown status: ${String(unreachable)}`);
    }
  }
}
