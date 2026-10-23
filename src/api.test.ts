// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as api from "./index";
import { buildReport } from "./report";
import { applyRunner, failed, fakeFs, fakeRunner, makeCtx, MemFs, NPM_WIN, NVM_BIN, WSL_EXE, type Tables } from "./testkit";
import type { Fix, ViewName } from "./types";

const PREFIX = "/home/u/.nvm/versions/node/v22.1.0";
const SRC = import.meta.dir;

function nvmFs(extra: Record<string, string> = {}, links: Record<string, string> = {}) {
  return new MemFs(
    {
      [`${NVM_BIN}/node`]: "",
      [`${NVM_BIN}/npm`]: "",
      [`${NVM_BIN}/npx`]: "",
      [`${NVM_BIN}/corepack`]: "",
      [`${NVM_BIN}/pm2`]: "",
      ...extra,
    },
    { "/usr/local/bin/node": `${NVM_BIN}/node`, "/usr/local/bin/npm": `${NVM_BIN}/npm`, "/usr/local/bin/npx": `${NVM_BIN}/npx`, ...links },
  );
}

const linked = { node: "/usr/local/bin/node", npm: "/usr/local/bin/npm", npx: "/usr/local/bin/npx" };
const allLinked: Tables = { interactive: linked, login: linked, exec: linked, here: linked };
const execProbes = { "exec:npm config get prefix": PREFIX, "exec:printenv PATH": "/usr/local/bin:/usr/bin:/bin" };

function fixesFor(tables: Tables, fs: MemFs, probes: Record<string, string> = {}, shell = "/bin/bash", noExec = false): Fix[] {
  const inner = fakeRunner(tables, probes);
  const runner = {
    run: (command: string, args: string[], o: Parameters<typeof inner.run>[2]) =>
      noExec && command === WSL_EXE && args[3] === "sh" ? failed(1, "exec timed out") : inner.run(command, args, o),
  };
  const ctx = makeCtx({ fs, shell, runner });
  return buildReport(ctx, { required: [], views: null, expectWindows: [], mcp: false }).fixes;
}

describe("--fix tells the truth about exec", () => {
  const nvmOnly = { node: `${NVM_BIN}/node`, npm: `${NVM_BIN}/npm` };
  const scenarios: Record<string, () => Fix[]> = {
    "npm shadowed by Windows": () =>
      fixesFor({ interactive: nvmOnly, login: { npm: NPM_WIN }, exec: { npm: NPM_WIN }, here: nvmOnly }, nvmFs()),
    "node unreachable in login and exec": () =>
      fixesFor({ interactive: nvmOnly, login: {}, exec: {}, here: nvmOnly }, nvmFs()),
    "npm globals invisible to exec": () => fixesFor(allLinked, nvmFs(), execProbes),
    "npm globals invisible, exec view unavailable, login is Linux": () =>
      fixesFor(
        { interactive: linked, login: linked, here: linked },
        nvmFs(),
        { "login:npm config get prefix": PREFIX, "login:printenv PATH": "/usr/local/bin:/usr/bin" },
        "/bin/bash",
        true,
      ),
    "zsh user, exec-zsh broken": () =>
      fixesFor({ interactive: nvmOnly, login: nvmOnly, exec: nvmOnly, "exec-zsh": {}, here: nvmOnly }, nvmFs(), {}, "/usr/bin/zsh"),
    "everything wrong at once": () =>
      fixesFor({ interactive: nvmOnly, login: { npm: NPM_WIN }, exec: {}, here: {} }, nvmFs(), execProbes),
  };

  for (const [name, build] of Object.entries(scenarios)) {
    test(`a path block never lists exec, here or interactive: ${name}`, () => {
      for (const fix of build().filter((f) => f.kind === "path-block")) {
        expect(fix.fixesViews.length).toBe(1);
        const view = fix.fixesViews[0] as ViewName;
        expect(["login", "exec-zsh"]).toContain(view);
        expect(fix.file!.endsWith(view === "login" ? "/.profile" : "/.zshenv") || fix.file!.endsWith("_profile") || fix.file!.endsWith("_login")).toBe(true);
      }
    });
    test(`only a link or appendWindowsPath can claim exec: ${name}`, () => {
      for (const fix of build().filter((f) => f.fixesViews.includes("exec"))) {
        expect(["symlink", "last-resort"]).toContain(fix.kind);
      }
    });
    test(`a path block that fixes login leaves exec broken when exec fails: ${name}`, () => {
      for (const fix of build().filter((f) => f.kind === "path-block" && f.fixesViews[0] === "login")) {
        expect(fix.warning).toContain("sh -c");
      }
    });
  }

  test("the npm prefix proposal links the globals and says a PATH block cannot help", () => {
    const [fix] = fixesFor(allLinked, nvmFs(), execProbes);
    expect(fix!.kind).toBe("symlink");
    expect(fix!.fixesViews).toEqual(["exec"]);
    expect(fix!.leavesBroken).toEqual([]);
    expect(fix!.file).toBeNull();
    expect(fix!.content).toBeNull();
    expect(fix!.commands).toEqual([
      `sudo ln -s '${NVM_BIN}/corepack' /usr/local/bin/corepack`,
      `sudo ln -s '${NVM_BIN}/pm2' /usr/local/bin/pm2`,
    ]);
    expect(fix!.warning).toContain("A PATH block cannot help");
    expect(fix!.warning).toContain("read no startup file");
  });

  test("when the prefix dir cannot be listed it says so instead of claiming a fix", () => {
    const [fix] = fixesFor(allLinked, new MemFs(), execProbes);
    expect(fix!.commands).toEqual([]);
    expect(fix!.links).toEqual([]);
    expect(fix!.warning).toContain("Could not list");
  });

  test("when login is the Linux view, the prefix proposal is a login block and says exec is untouched", () => {
    const fixes = fixesFor(
      { interactive: linked, login: linked, here: linked },
      nvmFs(),
      { "login:npm config get prefix": PREFIX, "login:printenv PATH": "/usr/local/bin:/usr/bin" },
      "/bin/bash",
      true,
    );
    const block = fixes.find((f) => f.kind === "path-block")!;
    expect(block.fixesViews).toEqual(["login"]);
    expect(block.warning).toContain("sh -c");
  });
});

describe("public API", () => {
  const opts = (tables: Tables, probes: Record<string, string> = {}, fs = nvmFs()) => ({
    runner: fakeRunner(tables, probes),
    fs,
    env: {},
    home: "/home/u",
    distro: "Ubuntu",
    shell: "/bin/bash",
    mountRoot: "/mnt/",
    wslExe: "/mnt/c/Windows/System32/wsl.exe",
  });

  test("exports exactly the documented surface", () => {
    expect(Object.keys(api).sort()).toEqual(
      ["ALL_VIEWS", "createApplyDeps", "loadState", "planApply", "planFixes", "planUndo", "preflight", "resolveTool", "runApply", "runUndo", "scan", "scanMcp", "settlePending", "statePath"].sort(),
    );
  });

  test("scan returns the same data as --json, without side effects", () => {
    const o = opts(allLinked, execProbes);
    const report = api.scan(o);
    expect(JSON.parse(JSON.stringify(report))).toEqual(JSON.parse(JSON.stringify(buildReport(makeCtx({ ...o }), { required: [], views: null, expectWindows: [], mcp: false }))));
    expect(report.schemaVersion).toBe(1);
    expect(report.rows.find((r) => r.tool === "npm")!.npmPrefix?.invisibleToView).toBe(true);
    expect(report.exitCode).toBe(1);
  });

  test("scan never calls process.exit, even when the report fails", () => {
    const real = process.exit;
    let called = false;
    process.exit = (() => {
      called = true;
      throw new Error("exit called");
    }) as typeof process.exit;
    try {
      expect(api.scan(opts({ interactive: {}, login: {}, exec: {}, here: {} }, {}, new MemFs())).exitCode).toBe(0);
      expect(api.scan({ ...opts(allLinked, execProbes) }).exitCode).toBe(1);
    } finally {
      process.exit = real;
    }
    expect(called).toBe(false);
  });

  test("resolveTool measures one command, built in or not", () => {
    const o = opts({ interactive: { node: `${NVM_BIN}/node`, ripgrep: "/usr/bin/ripgrep" }, login: { node: NPM_WIN }, exec: {}, here: {} });
    const node = api.resolveTool("node", o);
    expect(node.tool).toBe("node");
    expect(node.status).toBe("shadow");
    const rg = api.resolveTool("ripgrep", o);
    expect(rg.tool).toBe("ripgrep");
    expect(rg.status).toBe("unreachable");
    expect(api.resolveTool("nothing-here", o).status).toBe("missing");
  });

  test("planFixes recomputes proposals from a report", () => {
    const o = opts(allLinked, execProbes);
    const report = api.scan(o);
    const fixes = api.planFixes(report, o);
    expect(fixes.map((f) => f.kind)).toEqual(report.fixes.map((f) => f.kind));
    expect(fixes[0]!.links.map((l) => l.name)).toEqual(["corepack", "pm2"]);
  });

  test("scanMcp reads configs through the injected fs", () => {
    const config = JSON.stringify({ mcpServers: { s: { command: "wsl.exe", args: ["-e", "sh", "-c", "npm run x"] } } });
    const fs = nvmFs({ "/home/u/.cursor/mcp.json": config });
    const mcp = api.scanMcp(opts({ interactive: linked, login: linked, exec: { npm: NPM_WIN }, here: linked }, {}, fs));
    expect(mcp.servers.find((s) => s.server === "s")!.view).toBe("exec");
  });

  test("the apply functions work through createApplyDeps with injected fakes", () => {
    const fs = nvmFs();
    const base = fakeRunner(allLinked, execProbes);
    const runner = applyRunner(base, fs);
    const deps = api.createApplyDeps({
      fs, runner, home: "/home/u", distro: "Ubuntu", env: {}, shell: "/bin/bash", mountRoot: "/mnt/",
      wslExe: "/mnt/c/Windows/System32/wsl.exe", isRoot: false, now: () => new Date(0),
    });
    const plan = api.planApply(api.scan(opts(allLinked, execProbes, fs)).fixes, deps);
    expect(plan.steps.map((s) => (s.kind === "link" ? s.name : s.kind))).toEqual(["corepack", "pm2"]);
    expect(api.runApply(plan, deps).ok).toBe(true);
    expect(api.runUndo(api.planUndo(deps), deps).ok).toBe(true);
    expect(fs.links.has("/usr/local/bin/pm2")).toBe(false);
  });

  test("importing the package prints and exits nothing", () => {
    const run = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(join(SRC, "index.ts"))}).then((m) => console.log(Object.keys(m).length))`], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+$/);
    expect(run.stderr).toBe("");
  });

  test("library modules never call process.exit or print", () => {
    const cliOnly = new Set(["cli.ts", "cli-apply.ts"]);
    for (const name of readdirSync(SRC).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !cliOnly.has(n))) {
      const text = readFileSync(join(SRC, name), "utf8");
      expect(text.includes("process.exit(")).toBe(false);
      expect(/console\.(log|error)\(/.test(text)).toBe(false);
    }
  });

  test("package.json exports ESM with types", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
    expect(pkg.type).toBe("module");
    expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" });
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.files).toContain("dist/index.js");
    expect(pkg.files).toContain("dist/*.d.ts");
    expect(pkg.bin["wsl-shadow"]).toBe("dist/cli.js");
  });
});

describe("--preflight", () => {
  const base = {
    env: {},
    home: "/home/u",
    distro: "Ubuntu",
    shell: "/bin/bash",
    mountRoot: "/mnt/",
    wslExe: "/mnt/c/Windows/System32/wsl.exe" as string | null,
  };

  test("passes when exec resolves every tool to Linux", () => {
    const result = api.preflight({ ...base, fs: nvmFs(), runner: fakeRunner(allLinked) });
    expect(result.exitCode).toBe(0);
    expect(result.view).toBe("exec");
    expect(result.pathPrefix).toBe("/usr/local/bin");
    expect(result.problems).toEqual([]);
  });

  test("fails with a ready PATH prefix when a Linux build exists but exec sees Windows", () => {
    const result = api.preflight({ ...base, fs: nvmFs(), runner: fakeRunner({ exec: { node: NPM_WIN, npm: NPM_WIN }, interactive: { node: `${NVM_BIN}/node`, npm: `${NVM_BIN}/npm` } }) });
    expect(result.exitCode).toBe(1);
    expect(result.pathPrefix).toBe(NVM_BIN);
    expect(result.problems.map((p) => [p.tool, p.found])).toEqual([["node", "windows"], ["npm", "windows"]]);
  });

  test("exits 2 when a tool has no Linux build anywhere", () => {
    const result = api.preflight({ ...base, fs: fakeFs(), runner: fakeRunner({ exec: { node: NPM_WIN } }), tools: ["node"] });
    expect(result.exitCode).toBe(2);
    expect(result.pathPrefix).toBe("");
    expect(result.problems[0]!.linuxCandidate).toBeNull();
  });

  test("prefers nvm's stable current dir in the prefix", () => {
    const fs = nvmFs({ "/home/u/.nvm/current/bin/node": "", "/home/u/.nvm/current/bin/npm": "" });
    const result = api.preflight({ ...base, fs, runner: fakeRunner({ exec: {}, interactive: { node: `${NVM_BIN}/node`, npm: `${NVM_BIN}/npm` } }) });
    expect(result.pathPrefix).toBe("/home/u/.nvm/current/bin");
  });

  test("outside WSL it measures the current process instead, and says so", () => {
    const result = api.preflight({ ...base, distro: null, wslExe: null, fs: nvmFs(), runner: fakeRunner({ here: linked }) });
    expect(result.view).toBe("here");
    expect(result.exitCode).toBe(0);
  });

  test("if no view can run it fails with the reason and never guesses", () => {
    const dead = { run: () => ({ stdout: "", stderr: "boom", code: 1, timedOut: false, error: null }) };
    const result = api.preflight({ ...base, wslExe: null, fs: nvmFs(), runner: dead });
    expect(result.exitCode).toBe(1);
    expect(result.error).not.toBeNull();
    expect(result.pathPrefix).toBe("");
  });

  test("uses one lookup, not a full scan", () => {
    let calls = 0;
    const counting = {
      run: (command: string, args: string[], o: Parameters<ReturnType<typeof fakeRunner>["run"]>[2]) => {
        calls++;
        return fakeRunner(allLinked).run(command, args, o);
      },
    };
    api.preflight({ ...base, fs: nvmFs(), runner: counting });
    expect(calls).toBe(1);
  });
});
