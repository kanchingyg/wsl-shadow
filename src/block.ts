// SPDX-License-Identifier: AGPL-3.0-only
import { classify } from "./classify";
import type { FsOps } from "./env";
import { BLOCK_END, BLOCK_START } from "./fixes";

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockRe(flags: string): RegExp {
  return new RegExp(`${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`, flags);
}

/** Puts `block` into `text`: replaces the marked block if there is one (collapsing duplicates), else appends. */
export function upsertBlock(text: string, block: string): string {
  const re = blockRe("g");
  if (!re.test(text)) {
    const lead = text === "" ? "" : `${text.endsWith("\n") ? text : `${text}\n`}\n`;
    return `${lead}${block}\n`;
  }
  let first = true;
  return text.replace(blockRe("g"), () => {
    if (!first) return "";
    first = false;
    return `${block}\n`;
  });
}

/** Removes every marked block, plus the one blank line `upsertBlock` put in front of it. */
export function removeBlock(text: string): string {
  let out = text;
  for (;;) {
    const match = blockRe("").exec(out);
    if (match === null) return out;
    let start = match.index;
    const end = start + match[0].length;
    if (start >= 2 && out[start - 1] === "\n" && out[start - 2] === "\n") start -= 1;
    out = out.slice(0, start) + out.slice(end);
  }
}

export function hasBlock(text: string): boolean {
  return blockRe("").test(text);
}

const PATH_LINE = /^export PATH="([^"]+):\$PATH"$/;

/**
 * `--apply` writes only this shape: the two markers around `export PATH="dirs:$PATH"` lines,
 * every dir a Linux path that exists. No `source`, no `eval`, nothing from /mnt/<drive>/.
 * Returns the reason it refuses, or null when the block is acceptable.
 */
export function blockProblem(content: string, home: string, fs: FsOps, mountRoot: string): string | null {
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 3 || lines[0] !== BLOCK_START || lines[lines.length - 1] !== BLOCK_END) {
    return "block is not wrapped in the wsl-shadow markers";
  }
  for (const line of lines.slice(1, -1)) {
    const match = PATH_LINE.exec(line);
    if (match === null) return `unexpected line in block: ${line}`;
    for (const raw of match[1]!.split(":")) {
      const dir = raw.replace(/^\$HOME(?=\/|$)/, home);
      if (!dir.startsWith("/") || dir.includes("$")) return `not an absolute path: ${raw}`;
      if (classify(`${dir}/`, mountRoot) !== "linux") return `not a Linux path: ${raw}`;
      if (!fs.exists(dir)) return `directory does not exist: ${dir}`;
    }
  }
  return null;
}
