import { spawnSync } from "node:child_process";

export interface RunOptions {
  timeoutMs: number;
  env?: Record<string, string | undefined>;
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
