import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { DEFAULT_MOUNT_ROOT, parseMountRoot } from "./classify";
import { realRunner, type Runner } from "./runner";

export interface FsOps {
  exists(path: string): boolean;
  readDir(path: string): string[];
  readText(path: string): string | null;
}

export interface Ctx {
  runner: Runner;
  fs: FsOps;
  env: Record<string, string | undefined>;
  home: string;
  distro: string | null;
  shell: string;
  mountRoot: string;
  wslExe: string | null;
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
