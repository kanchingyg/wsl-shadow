// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { DEFAULT_MOUNT_ROOT, parseMountRoot } from "./classify";
import { realRunner, type Runner } from "./runner";

/** Mode and ownership from `lstat`, used when replacing a file in place. */
export interface FileMeta {
  /** Permission bits from the filesystem. */
  mode: number;
  /** Owner user id. */
  uid: number;
  /** Owner group id. */
  gid: number;
}

/** Read-only filesystem surface used by scans and planning. */
export interface FsOps {
  /** True when the path exists (follows the platform exists check). */
  exists(path: string): boolean;
  /** Directory entries, or an empty list when the path cannot be read. */
  readDir(path: string): string[];
  /** File contents as UTF-8, or null when the path cannot be read. */
  readText(path: string): string | null;
  /** True for any directory entry, including a symlink whose target is gone. */
  entryExists(path: string): boolean;
  /** The link's target text, or null when `path` is not a symlink. */
  readLink(path: string): string | null;
  /** Mode and owner. Null when the path is missing. */
  stat(path: string): FileMeta | null;
}

/** Options for {@link WritableFs.writeText}. */
export interface WriteTextOptions {
  /** fsync the file after writing. Used for the state file. */
  sync?: boolean;
}

/** The only writes `--apply` and `--undo` make. Everything else in the tool is read-only. */
export interface WritableFs extends FsOps {
  /** Write UTF-8 text, optionally fsyncing afterward. */
  writeText(path: string, text: string, opts?: WriteTextOptions): void;
  /** Copy a file byte for byte (used for backups). */
  copyFile(from: string, to: string): void;
  /** Create a directory and parents. */
  mkdirp(dir: string): void;
  /** Unlink a file or symlink. */
  remove(path: string): void;
  /** Rename/move a path. */
  rename(from: string, to: string): void;
  /** Apply mode bits (permission mask). Best-effort on platforms that ignore them. */
  chmod(path: string, mode: number): void;
  /** Apply owner. Best-effort; may no-op without privileges. */
  chown(path: string, uid: number, gid: number): void;
  /** fsync the directory that holds a renamed file (best-effort; no-op when unsupported). */
  syncDir(dir: string): void;
}

/** Runtime context for lookups: runner, fs, env, and WSL paths. */
export interface Ctx {
  /** How child processes are started. */
  runner: Runner;
  /** Filesystem used for reads (and writes when it is a WritableFs). */
  fs: FsOps;
  /** Environment variables for launches. */
  env: Record<string, string | undefined>;
  /** Linux home directory. */
  home: string;
  /** WSL distro name, or null outside WSL. */
  distro: string | null;
  /** User shell path used for the interactive view. */
  shell: string;
  /** Automount root used to classify Windows paths. */
  mountRoot: string;
  /** Path to wsl.exe, or null when interop is off / not in WSL. */
  wslExe: string | null;
  /** Default timeout for spawned lookups, in milliseconds. */
  timeoutMs: number;
}

export const realFs: FsOps = {
  exists: (path) => existsSync(path),
  readDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  entryExists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
  readLink: (path) => {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  },
  stat: (path) => {
    try {
      const s = lstatSync(path);
      return { mode: s.mode, uid: s.uid, gid: s.gid };
    } catch {
      return null;
    }
  },
};

export const realWritableFs: WritableFs = {
  ...realFs,
  writeText: (path, text, opts) => {
    writeFileSync(path, text, "utf8");
    if (opts?.sync) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  },
  copyFile: (from, to) => copyFileSync(from, to),
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  remove: (path) => unlinkSync(path),
  rename: (from, to) => renameSync(from, to),
  chmod: (path, mode) => {
    try {
      chmodSync(path, mode & 0o7777);
    } catch {
      // Windows and some mounts ignore or reject chmod; leaving the default is better than failing the edit.
    }
  },
  chown: (path, uid, gid) => {
    try {
      chownSync(path, uid, gid);
    } catch {
      // Same user usually already owns $HOME files; root-owned targets are not edited here.
    }
  },
  syncDir: (dir) => {
    try {
      const fd = openSync(dir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Windows and some FS types cannot fsync a directory.
    }
  },
};

/** `bun run` prepends a temp dir with fake node/bun shims. They are not what the user has. */
const RUNTIME_SHIM_DIR = /^\/tmp\/bun-node-/;

export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.PATH === undefined) return env;
  const path = env.PATH.split(":")
    .filter((dir) => !RUNTIME_SHIM_DIR.test(dir))
    .join(":");
  return { ...env, PATH: path };
}

/** WSLSHADOW_MOUNT_ROOT exists only so tests can point at a temp directory. */
export function createCtx(overrides: Partial<Ctx> = {}): Ctx {
  const env = sanitizeEnv(overrides.env ?? process.env);
  const fs = overrides.fs ?? realFs;
  const mountRoot =
    overrides.mountRoot ??
    env.WSLSHADOW_MOUNT_ROOT ??
    parseMountRoot(fs.readText("/etc/wsl.conf")) ??
    DEFAULT_MOUNT_ROOT;
  const wslCandidate = posix.join(mountRoot, "c/Windows/System32/wsl.exe");

  return {
    runner: overrides.runner ?? realRunner,
    fs,
    env,
    home: overrides.home ?? env.HOME ?? homedir(),
    distro: overrides.distro !== undefined ? overrides.distro : (env.WSL_DISTRO_NAME ?? null),
    shell: overrides.shell ?? env.SHELL ?? "/bin/bash",
    mountRoot,
    wslExe: overrides.wslExe !== undefined ? overrides.wslExe : fs.exists(wslCandidate) ? wslCandidate : null,
    timeoutMs: overrides.timeoutMs ?? 10_000,
  };
}
