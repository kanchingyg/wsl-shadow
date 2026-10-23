// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";

export interface RunOptions {
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** Hand the terminal to the child (for `sudo`'s own password prompt). Output is not captured. */
  inherit?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error: string | null;
}

/** Everything that starts a process goes through this, so tests can fake it. */
export interface Runner {
  run(command: string, args: string[], opts: RunOptions): RunResult;
}

export const realRunner: Runner = {
  run(command, args, opts) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      env: opts.env,
      // Interactive .bashrc can hang waiting for a TTY; agents close stdin too.
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const err = result.error as NodeJS.ErrnoException | undefined;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status,
      timedOut: err?.code === "ETIMEDOUT",
      error: err ? err.message : null,
    };
  },
};
