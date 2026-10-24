// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";

/** Options for one {@link Runner.run} call. */
export interface RunOptions {
  /** Kill the child after this many milliseconds. */
  timeoutMs: number;
  /** Environment for the child. Defaults to the process env when omitted. */
  env?: Record<string, string | undefined>;
  /** Hand the terminal to the child (for `sudo`'s own password prompt). Output is not captured. */
  inherit?: boolean;
}

/** Captured result of one spawned process. Exported from the package as `ProcessResult`. */
export interface RunResult {
  /** Captured stdout (empty when inherit is true). */
  stdout: string;
  /** Captured stderr (empty when inherit is true). */
  stderr: string;
  /** Exit status, or null when the process was not started. */
  code: number | null;
  /** True when the spawn timed out. */
  timedOut: boolean;
  /** Spawn error message, or null on success. */
  error: string | null;
}

/** Everything that starts a process goes through this, so tests can fake it. */
export interface Runner {
  /** Run `command` with `args` and return stdout/stderr/status. */
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
