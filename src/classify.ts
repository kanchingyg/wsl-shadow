// SPDX-License-Identifier: AGPL-3.0-only
import type { Verdict } from "./types";

export const DEFAULT_MOUNT_ROOT = "/mnt/";

const WINDOWS_EXT = /\.(exe|cmd|bat)$/i;

/** A path is Windows when it sits on a drive mount or is a Windows executable type. */
export function classify(path: string | null, mountRoot: string = DEFAULT_MOUNT_ROOT): Verdict {
  if (path === null) return "missing";
  if (WINDOWS_EXT.test(path)) return "windows";
  if (path.startsWith(mountRoot)) {
    const rest = path.slice(mountRoot.length);
    if (/^[a-z]\//i.test(rest)) return "windows";
  }
  return "linux";
}

/** Reads `[automount] root` from /etc/wsl.conf text. Defaults to /mnt/. */
export function parseMountRoot(conf: string | null): string {
  if (conf === null) return DEFAULT_MOUNT_ROOT;
  let section = "";
  for (const raw of conf.split("\n")) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      continue;
    }
    if (section !== "automount") continue;
    const match = /^root\s*=\s*(.+)$/i.exec(line);
    if (match) {
      const root = match[1]!.trim();
      return root.endsWith("/") ? root : `${root}/`;
    }
  }
  return DEFAULT_MOUNT_ROOT;
}

/**
 * Parses `tool<TAB>path` lines. Interactive shells print noise, so lines that
 * don't name a known tool are ignored. An empty or non-absolute path is missing.
 */
export function parseTable(stdout: string, tools: readonly string[]): Map<string, string | null> {
  const known = new Set(tools);
  const table = new Map<string, string | null>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const tool = line.slice(0, tab).trim();
    if (!known.has(tool)) continue;
    const path = line.slice(tab + 1).trim();
    table.set(tool, path.startsWith("/") ? path : null);
  }
  return table;
}
