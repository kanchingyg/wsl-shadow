export const TOOLS = [
  "node",
  "npm",
  "npx",
  "bun",
  "deno",
  "pnpm",
  "yarn",
  "git",
  "gh",
  "python3",
  "pip",
  "uv",
  "claude",
  "codex",
  "cursor",
] as const;

/** Programs that are meant to be the Windows build. Informational only. */
export const EXPECTED_WINDOWS: ReadonlySet<string> = new Set(["cursor", "code"]);

/** Fallback text when no probe could measure the consequence. */
export const CONSEQUENCES: Record<string, string> = {
  node: "Windows node runs Linux scripts with Windows paths and native modules",
  npm: "global installs go to the Windows npm prefix, not your Linux home",
  npx: "runs through the Windows node/npm resolution",
  bun: "Windows bun can't load Linux node_modules and breaks on UNC paths",
  deno: "Windows deno sees Windows paths and a separate cache",
  pnpm: "Windows pnpm uses a Windows store and may fail on \\\\wsl.localhost paths",
  yarn: "Windows yarn uses a Windows cache and global folder",
  git: "Windows git is slow on Linux files and handles line endings differently",
  gh: "Windows gh keeps its login in Windows, not in WSL",
  python3: "Windows python can't use Linux venvs or Linux paths",
  pip: "installs into the Windows python environment",
  uv: "Windows uv creates Windows virtual environments",
  claude: "runs the Windows build of the agent, with Windows paths and tools",
  codex: "runs the Windows build of the agent, with Windows paths and tools",
};

export const FALLBACK_CONSEQUENCE = "runs as a Windows binary";

/** Read-only commands that show what a tool really is. First argument is the program. */
export const PROBE_COMMANDS: Record<string, string[][]> = {
  node: [["node", "-p", "process.platform"]],
  npm: [
    ["npm", "config", "get", "prefix"],
    ["npm", "root", "-g"],
  ],
  git: [["git", "--version"]],
  python3: [["python3", "-c", "import sys;print(sys.platform)"]],
};
