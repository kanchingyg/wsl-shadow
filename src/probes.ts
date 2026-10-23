import type { Ctx } from "./env";
import { PROBE_COMMANDS } from "./tools";
import type { Probe, ViewName } from "./types";
import { EXEC_SCRIPT, launchFor, runLaunch } from "./views";

/** Output that only a Windows build produces. */
export function looksWindows(output: string): boolean {
  return (
    /^[A-Za-z]:\\/.test(output) ||
    output.startsWith("\\\\") ||
    /^win32$/i.test(output) ||
    /\bwindows\b/i.test(output)
  );
}

/** Read-only probes, run in the view that failed. Each has its own timeout. */
export function runProbes(tool: string, view: ViewName, ctx: Ctx): Probe[] {
  const commands = PROBE_COMMANDS[tool] ?? [];
  return commands.map((cmd) => {
    const outcome = runLaunch(launchFor(view, EXEC_SCRIPT, cmd, ctx), ctx);
    const command = cmd.join(" ");
    if (!outcome.ok) return { view, command, output: null, windows: false };
    const output = outcome.stdout.trim().split("\n").filter(Boolean).pop() ?? null;
    return { view, command, output, windows: output !== null && looksWindows(output) };
  });
}
