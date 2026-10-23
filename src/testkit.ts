// SPDX-License-Identifier: AGPL-3.0-only
// Fakes for tests. Not part of the public API and not reachable from src/index.ts.
import { posix } from "node:path";
import {
  createCtx,
  type Ctx,
  type FileMeta,
  type FsOps,
  type WritableFs,
  type WriteTextOptions,
} from "./env";
import type { Runner, RunResult } from "./runner";
import type { ViewName } from "./types";
import { LOOKUP_SCRIPT } from "./views";

export const WSL_EXE = "/mnt/c/Windows/System32/wsl.exe";
export const NPM_WIN = "/mnt/c/Program Files/nodejs/npm";
export const NVM_BIN = "/home/u/.nvm/versions/node/v22.1.0/bin";

export type Tables = Partial<Record<ViewName, Record<string, string>>>;

export function ok(stdout: string): RunResult {
  return { stdout, stderr: "", code: 0, timedOut: false, error: null };
}

export function failed(code = 1, stderr = ""): RunResult {
  return { stdout: "", stderr, code, timedOut: false, error: null };
}

/** Answers lookups and probes per view. `probes` is keyed "view:command". */
export function fakeRunner(tables: Tables, probes: Record<string, string> = {}): Runner {
  return {
    run(command, args) {
      const sep = args.indexOf("_");
      const script = args[sep - 1] ?? "";
      const rest = args.slice(sep + 1);
      let view: ViewName;
      if (command === WSL_EXE) {
        const shell = args[3];
        view = shell === "bash" ? "login" : shell === "zsh" ? "exec-zsh" : "exec";
      } else if (command === "sh") view = "here";
      else view = "interactive";

      if (script === LOOKUP_SCRIPT) {
        const table = tables[view] ?? {};
        return ok(rest.map((t) => `${t}\t${table[t] ?? ""}\n`).join(""));
      }
      const out = probes[`${view}:${rest.join(" ")}`];
      return out === undefined ? { ...ok(""), code: 1 } : ok(`${out}\n`);
    },
  };
}

export function fakeFs(files: string[] = [], dirs: Record<string, string[]> = {}, texts: Record<string, string> = {}): FsOps {
  const set = new Set(files);
  return {
    exists: (p) => set.has(p),
    readDir: (p) => dirs[p] ?? [],
    readText: (p) => texts[p] ?? null,
    entryExists: (p) => set.has(p),
    readLink: () => null,
    stat: () => null,
  };
}

export function makeCtx(over: Partial<Ctx>): Ctx {
  return createCtx({
    home: "/home/u",
    distro: "Ubuntu",
    shell: "/bin/bash",
    mountRoot: "/mnt/",
    wslExe: WSL_EXE,
    env: {},
    fs: fakeFs(),
    ...over,
  });
}

/** In-memory filesystem with symlinks. `exists` follows links like the real one; `entryExists` does not. */
export class MemFs implements WritableFs {
  files = new Map<string, string>();
  links = new Map<string, string>();
  meta = new Map<string, FileMeta>();
  /** Every path written through writeText/rename/remove/copyFile, in order. */
  writes: string[] = [];
  /** Paths that were fsync'd via writeText({ sync: true }) or syncDir. */
  synced: string[] = [];

  constructor(
    files: Record<string, string> = {},
    links: Record<string, string> = {},
    meta: Record<string, FileMeta> = {},
  ) {
    for (const [p, text] of Object.entries(files)) {
      this.files.set(p, text);
      this.meta.set(p, meta[p] ?? { mode: 0o100644, uid: 1000, gid: 1000 });
    }
    for (const [p, target] of Object.entries(links)) this.links.set(p, target);
  }

  exists(path: string): boolean {
    if (this.files.has(path)) return true;
    const target = this.links.get(path);
    if (target !== undefined) return this.exists(target);
    const prefix = `${path.replace(/\/$/, "")}/`;
    return [...this.files.keys(), ...this.links.keys()].some((k) => k.startsWith(prefix));
  }

  entryExists(path: string): boolean {
    return this.files.has(path) || this.links.has(path);
  }

  readLink(path: string): string | null {
    return this.links.get(path) ?? null;
  }

  readText(path: string): string | null {
    const target = this.links.get(path);
    if (target !== undefined) return this.readText(target);
    return this.files.get(path) ?? null;
  }

  readDir(path: string): string[] {
    const prefix = `${path.replace(/\/$/, "")}/`;
    const names = [...this.files.keys(), ...this.links.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length).split("/")[0]!);
    return [...new Set(names)];
  }

  stat(path: string): FileMeta | null {
    if (this.links.has(path)) return this.meta.get(path) ?? { mode: 0o120777, uid: 1000, gid: 1000 };
    if (this.files.has(path)) return this.meta.get(path) ?? { mode: 0o100644, uid: 1000, gid: 1000 };
    return null;
  }

  writeText(path: string, text: string, opts?: WriteTextOptions): void {
    this.writes.push(path);
    this.files.set(path, text);
    if (!this.meta.has(path)) this.meta.set(path, { mode: 0o100644, uid: 1000, gid: 1000 });
    if (opts?.sync) this.synced.push(path);
  }

  copyFile(from: string, to: string): void {
    const text = this.readText(from);
    if (text === null) throw new Error(`ENOENT ${from}`);
    this.writes.push(to);
    this.files.set(to, text);
    const meta = this.stat(from);
    if (meta !== null) this.meta.set(to, { ...meta });
  }

  mkdirp(): void {}

  remove(path: string): void {
    this.writes.push(path);
    this.meta.delete(path);
    if (!this.files.delete(path) && !this.links.delete(path)) throw new Error(`ENOENT ${path}`);
  }

  rename(from: string, to: string): void {
    const text = this.files.get(from);
    if (text === undefined) throw new Error(`ENOENT ${from}`);
    this.writes.push(to);
    this.files.delete(from);
    this.files.set(to, text);
    const meta = this.meta.get(from);
    this.meta.delete(from);
    if (meta !== undefined) this.meta.set(to, meta);
  }

  chmod(path: string, mode: number): void {
    const cur = this.stat(path);
    if (cur === null) throw new Error(`ENOENT ${path}`);
    this.meta.set(path, { ...cur, mode });
  }

  chown(path: string, uid: number, gid: number): void {
    const cur = this.stat(path);
    if (cur === null) throw new Error(`ENOENT ${path}`);
    this.meta.set(path, { ...cur, uid, gid });
  }

  syncDir(dir: string): void {
    this.synced.push(dir);
  }
}

export interface SudoLog {
  calls: string[][];
}

export interface ApplyRunnerOptions {
  /** `bash -n` / `zsh -n` exit code. */
  syntaxCode?: number;
  /** Link paths whose `ln` should fail. */
  failLink?: string[];
}

/** Layers fake `sudo ln|rm`, `bash -n` and `zsh -n` over a view runner. Mutates `fs` the way the real commands would. */
export function applyRunner(
  base: Runner,
  fs: MemFs,
  opts: ApplyRunnerOptions = {},
): Runner & { sudo: SudoLog; all: string[][] } {
  const sudo: SudoLog = { calls: [] };
  const all: string[][] = [];
  return {
    sudo,
    all,
    run(command, args, runOpts) {
      all.push([command, ...args]);
      if (command === "sudo") {
        sudo.calls.push(args);
        const [tool, ...rest] = args;
        if (tool === "ln" && rest[0] === "-s" && rest.length === 3) {
          const [, target, link] = rest as [string, string, string];
          if (opts.failLink?.includes(link) || fs.entryExists(link)) return failed(1, "ln: failed");
          fs.links.set(link, target);
          return ok("");
        }
        if (tool === "rm" && rest.length === 1) {
          fs.links.delete(rest[0]!);
          return ok("");
        }
        return failed(2, "unexpected sudo command");
      }
      if ((command === "bash" || command === "zsh") && args[0] === "-n") {
        const code = opts.syntaxCode ?? 0;
        return code === 0 ? ok("") : failed(code, `${posix.basename(args[1] ?? "")}: syntax error`);
      }
      return base.run(command, args, runOpts);
    },
  };
}
