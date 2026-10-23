import { EXPECTED_WINDOWS } from "./tools";
import type { Hit, Status, ViewName } from "./types";

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
 * expected-windows: meant to be the Windows build (cursor, code).
 * unmeasured: no view could be measured.
 */
export function decideStatus(
  tool: string,
  hits: Partial<Record<ViewName, Hit>>,
  linuxCandidate: string | null,
): Decision {
  const entries = Object.entries(hits) as [ViewName, Hit][];
  if (entries.length === 0) return { status: "unmeasured", failingViews: [] };

  const windows = viewsWith(entries, "windows");
  const missing = viewsWith(entries, "missing");

  if (windows.length > 0) {
    if (EXPECTED_WINDOWS.has(tool)) return { status: "expected-windows", failingViews: [] };
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

export function isProblem(status: Status): boolean {
  switch (status) {
    case "shadow":
    case "windows-only":
    case "unreachable":
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
