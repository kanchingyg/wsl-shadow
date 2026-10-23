import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLinuxCandidate, compareVersions, nvmDefaultBin } from "./candidates";
import { classify, parseMountRoot, parseTable } from "./classify";
import { createCtx, sanitizeEnv, type Ctx, type FsOps } from "./env";
import { buildReport } from "./report";
import type { Runner, RunResult } from "./runner";
import { TOOLS } from "./tools";
import type { ViewName } from "./types";
import { LOOKUP_SCRIPT } from "./views";

const WSL_EXE = "/mnt/c/Windows/System32/wsl.exe";
const NODE_WIN = "/mnt/c/Program Files/nodejs/node";
const NPM_WIN = "/mnt/c/Program Files/nodejs/npm";
const NVM_BIN = "/home/u/.nvm/versions/node/v22.1.0/bin";

type Tables = Partial<Record<ViewName, Record<string, string>>>;

function ok(stdout: string): RunResult {
  return { stdout, stderr: "", code: 0, timedOut: false, error: null };
}

/** Answers lookups and probes per view. `probes` is keyed "view:command". */
function fakeRunner(tables: Tables, probes: Record<string, string> = {}): Runner {
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

function fakeFs(files: string[] = [], dirs: Record<string, string[]> = {}, texts: Record<string, string> = {}): FsOps {
  const set = new Set(files);
  return {
    exists: (p) => set.has(p),
    readDir: (p) => dirs[p] ?? [],
    readText: (p) => texts[p] ?? null,
  };
}

function makeCtx(over: Partial<Ctx>): Ctx {
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

const run = (ctx: Ctx, required: string[] = []) => buildReport(ctx, { required, views: null });
const row = (report: ReturnType<typeof run>, tool: string) => report.rows.find((r) => r.tool === tool)!;

describe("classify", () => {
  test("drive mounts and Windows executables are windows", () => {
    expect(classify("/mnt/c/Users/a/npm")).toBe("windows");
    expect(classify("/mnt/d/tools/bun")).toBe("windows");
    expect(classify("/usr/local/bin/thing.exe")).toBe("windows");
    expect(classify("/opt/x/run.cmd")).toBe("windows");
  });
  test("other paths are linux, including /mnt/wsl", () => {
    expect(classify("/usr/bin/git")).toBe("linux");
    expect(classify("/mnt/wsl/shared/tool")).toBe("linux");
  });
  test("honors a custom mount root", () => {
    expect(classify("/win/c/Program Files/nodejs/npm", "/win/")).toBe("windows");
    expect(classify("/mnt/c/Program Files/nodejs/npm", "/win/")).toBe("linux");
  });
  test("null is missing", () => {
    expect(classify(null)).toBe("missing");
  });
});

describe("parseMountRoot", () => {
  test("reads [automount] root and adds a trailing slash", () => {
    expect(parseMountRoot("[boot]\nsystemd=true\n[automount]\nroot = /win\n")).toBe("/win/");
  });
  test("ignores root outside [automount] and defaults to /mnt/", () => {
    expect(parseMountRoot("[user]\nroot=/nope\n")).toBe("/mnt/");
    expect(parseMountRoot(null)).toBe("/mnt/");
  });
});

describe("sanitizeEnv", () => {
  test("drops the bun runtime shim dir and keeps the rest of PATH", () => {
    const env = sanitizeEnv({ PATH: "/tmp/bun-node-1000-abc:/usr/bin:/home/u/.nvm/bin" });
    expect(env.PATH).toBe("/usr/bin:/home/u/.nvm/bin");
  });
  test("leaves an env without PATH alone", () => {
    expect(sanitizeEnv({ HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});

describe("parseTable", () => {
  test("ignores shell noise and treats empty paths as missing", () => {
    const table = parseTable("welcome banner\nnode\t/usr/bin/node\nnpm\t\nfoo\t/x\n", ["node", "npm"]);
    expect(table.get("node")).toBe("/usr/bin/node");
    expect(table.get("npm")).toBeNull();
    expect(table.has("foo")).toBe(false);
  });
});

describe("statuses", () => {
  test("shadow: Linux in the terminal, Windows in exec and login", () => {
    const ctx = makeCtx({
      runner: fakeRunner(
        {
          interactive: { npm: `${NVM_BIN}/npm` },
          login: { npm: NPM_WIN },
          exec: { npm: NPM_WIN },
          here: { npm: `${NVM_BIN}/npm` },
        },
        { "login:npm config get prefix": "C:\\Users\\a\\AppData\\Roaming\\npm" },
      ),
    });
    const report = run(ctx);
    const npm = row(report, "npm");
    expect(npm.status).toBe("shadow");
    expect(npm.failingViews).toEqual(["login", "exec"]);
    expect(npm.linuxCandidate).toBe(`${NVM_BIN}/npm`);
    expect(npm.consequence).toContain("C:\\Users\\a\\AppData\\Roaming\\npm");
    expect(report.exitCode).toBe(1);
  });

  test("windows-only: Windows answers and no Linux build exists", () => {
    const ctx = makeCtx({
      runner: fakeRunner({
        interactive: { npm: NPM_WIN },
        login: { npm: NPM_WIN },
        exec: { npm: NPM_WIN },
        here: { npm: NPM_WIN },
      }),
    });
    const npm = row(run(ctx), "npm");
    expect(npm.status).toBe("windows-only");
    expect(npm.linuxCandidate).toBeNull();
  });

  test("unreachable: a Linux build exists but exec cannot find it", () => {
    const ctx = makeCtx({
      runner: fakeRunner({
        interactive: { node: `${NVM_BIN}/node` },
        login: {},
        exec: {},
        here: { node: `${NVM_BIN}/node` },
      }),
    });
    const node = row(run(ctx), "node");
    expect(node.status).toBe("unreachable");
    expect(node.failingViews).toEqual(["login", "exec"]);
    expect(run(ctx).exitCode).toBe(1);
  });

  test("missing, and exit 2 only when the tool is required", () => {
    const ctx = makeCtx({ runner: fakeRunner({ interactive: {}, login: {}, exec: {}, here: {} }) });
    expect(row(run(ctx), "bun").status).toBe("missing");
    expect(run(ctx).exitCode).toBe(0);
    expect(run(ctx, ["bun"]).exitCode).toBe(2);
  });

  test("a Linux build found on disk in a manager dir makes a missing tool a shadow", () => {
    const ctx = makeCtx({
      fs: fakeFs(["/home/u/.bun/bin/bun"]),
      runner: fakeRunner({
        interactive: {},
        login: { bun: "/mnt/c/Users/a/.bun/bin/bun" },
        exec: { bun: "/mnt/c/Users/a/.bun/bin/bun" },
        here: {},
      }),
    });
    const bun = row(run(ctx), "bun");
    expect(bun.status).toBe("shadow");
    expect(bun.linuxCandidate).toBe("/home/u/.bun/bin/bun");
  });

  test("expected-windows does not change the exit code", () => {
    const cursor = "/mnt/c/Users/a/AppData/Local/Programs/cursor/resources/app/bin/cursor";
    const ctx = makeCtx({
      runner: fakeRunner({ interactive: { cursor }, login: { cursor }, exec: { cursor }, here: { cursor } }),
    });
    const report = run(ctx);
    expect(row(report, "cursor").status).toBe("expected-windows");
    expect(report.exitCode).toBe(0);
  });

  test("ok when every view resolves to Linux", () => {
    const git = { git: "/usr/bin/git" };
    const ctx = makeCtx({ runner: fakeRunner({ interactive: git, login: git, exec: git, here: git }) });
    expect(row(run(ctx), "git").status).toBe("ok");
  });
});

describe("views", () => {
  test("login and exec are unavailable without wsl.exe, and say why", () => {
    const git = { git: "/usr/bin/git" };
    const ctx = makeCtx({ wslExe: null, runner: fakeRunner({ interactive: git, here: git }) });
    const report = run(ctx);
    const login = report.views.find((v) => v.name === "login")!;
    expect(login.available).toBe(false);
    expect(login.reason).toContain("wsl.exe");
    expect(row(report, "git").status).toBe("ok");
  });

  test("every view unavailable gives unmeasured, never a guess", () => {
    const failing: Runner = {
      run: () => ({ stdout: "", stderr: "boom", code: 1, timedOut: false, error: null }),
    };
    const ctx = makeCtx({ wslExe: null, runner: failing });
    const report = run(ctx);
    expect(row(report, "npm").status).toBe("unmeasured");
    expect(report.exitCode).toBe(0);
  });

  test("a timeout makes the view unavailable", () => {
    const slow: Runner = {
      run: () => ({ stdout: "", stderr: "", code: null, timedOut: true, error: "ETIMEDOUT" }),
    };
    const report = run(makeCtx({ runner: slow }));
    expect(report.views.every((v) => !v.available)).toBe(true);
    expect(report.views[0]!.reason).toContain("timed out");
  });

  test("exec-zsh is measured only when the shell is zsh", () => {
    const bash = run(makeCtx({ runner: fakeRunner({}) }));
    const zsh = run(makeCtx({ shell: "/usr/bin/zsh", runner: fakeRunner({}) }));
    expect(bash.views.map((v) => v.name)).not.toContain("exec-zsh");
    expect(zsh.views.map((v) => v.name)).toContain("exec-zsh");
  });

  test("a custom mount root changes what counts as Windows", () => {
    const winNpm = "/win/c/Program Files/nodejs/npm";
    const ctx = makeCtx({
      mountRoot: "/win/",
      fs: fakeFs(),
      runner: fakeRunner({ interactive: { npm: `${NVM_BIN}/npm` }, exec: { npm: winNpm }, login: { npm: winNpm }, here: {} }),
    });
    expect(row(run(ctx), "npm").status).toBe("shadow");
  });
});

describe("candidates", () => {
  test("compareVersions sorts numerically", () => {
    expect(["v9.0.0", "v22.1.0", "v10.2.0"].sort(compareVersions)).toEqual(["v9.0.0", "v10.2.0", "v22.1.0"]);
  });
  test("nvm default alias wins over a newer version", () => {
    const ctx = makeCtx({
      fs: fakeFs([], { "/home/u/.nvm/versions/node": ["v20.5.0", "v22.1.0"] }, { "/home/u/.nvm/alias/default": "20\n" }),
    });
    expect(nvmDefaultBin(ctx)).toBe("/home/u/.nvm/versions/node/v20.5.0/bin");
  });
  test("falls back to the newest nvm version", () => {
    const ctx = makeCtx({ fs: fakeFs([], { "/home/u/.nvm/versions/node": ["v18.0.0", "v22.1.0"] }) });
    expect(nvmDefaultBin(ctx)).toBe("/home/u/.nvm/versions/node/v22.1.0/bin");
  });
  test("finds a tool in a manager dir when no view saw it", () => {
    const ctx = makeCtx({ fs: fakeFs(["/home/u/.volta/bin/node"]) });
    expect(findLinuxCandidate("node", {}, ctx)).toBe("/home/u/.volta/bin/node");
  });
});

describe("fixes", () => {
  const shadowedWithFs = (fs: FsOps) =>
    makeCtx({
      fs,
      runner: fakeRunner({
        interactive: { npm: `${NVM_BIN}/npm` },
        login: { npm: NPM_WIN },
        exec: { npm: NPM_WIN },
        here: {},
      }),
    });
  const shadowed = () => shadowedWithFs(fakeFs());

  test("orders path block, symlink, then appendWindowsPath last", () => {
    const fixes = run(shadowed()).fixes;
    expect(fixes.map((f) => f.kind)).toEqual(["path-block", "symlink", "last-resort"]);
  });
  test("the path block targets ~/.profile for login and is marked", () => {
    const block = run(shadowed()).fixes[0]!;
    expect(block.file).toBe("/home/u/.profile");
    expect(block.fixesViews).toEqual(["login"]);
    expect(block.content).toContain("# >>> wsl-shadow >>>");
    expect(block.content).toContain('export PATH="$HOME/.nvm/versions/node/v22.1.0/bin:$PATH"');
    expect(block.warning).toContain("nvm");
  });
  test("the symlink is the exact command and covers exec", () => {
    const link = run(shadowed()).fixes[1]!;
    expect(link.commands).toEqual([`sudo ln -s '${NVM_BIN}/npm' /usr/local/bin/npm`]);
    expect(link.fixesViews).toContain("exec");
  });
  test("every proposal names the views it leaves broken", () => {
    const [block, link] = run(shadowed()).fixes;
    expect(block!.fixesViews).toEqual(["login"]);
    expect(block!.leavesBroken).toEqual(["exec"]);
    expect(block!.warning).toContain("Only login shells");
    expect(link!.leavesBroken).toEqual([]);
  });
  test("uses ~/.bash_profile when it exists, because bash then ignores ~/.profile", () => {
    const ctx = shadowedWithFs(fakeFs(["/home/u/.bash_profile"]));
    const block = run(ctx).fixes[0]!;
    expect(block.file).toBe("/home/u/.bash_profile");
    expect(block.warning).toContain("ignores ~/.profile");
  });
  test("links to nvm's stable current dir when it exists", () => {
    const ctx = shadowedWithFs(fakeFs(["/home/u/.nvm/current/bin/npm"]));
    const link = run(ctx).fixes[1]!;
    expect(link.commands).toEqual(["sudo ln -s '/home/u/.nvm/current/bin/npm' /usr/local/bin/npm"]);
    expect(link.warning).not.toContain("pinned");
  });
  test("a pinned nvm link says how to make it stable", () => {
    const link = run(shadowed()).fixes[1]!;
    expect(link.warning).toContain("NVM_SYMLINK_CURRENT=true");
  });
  test("never overwrites an existing /usr/local/bin entry", () => {
    const ctx = shadowedWithFs(fakeFs(["/usr/local/bin/npm"]));
    const link = run(ctx).fixes.find((f) => f.kind === "symlink")!;
    expect(link.commands).toEqual([]);
    expect(link.warning).toContain("already has npm");
    expect(link.commands.join(" ")).not.toContain("-f");
  });
  test("appendWindowsPath=false does not claim to fix unreachable tools", () => {
    const ctx = makeCtx({
      runner: fakeRunner({
        interactive: { npm: `${NVM_BIN}/npm`, node: `${NVM_BIN}/node` },
        login: { npm: NPM_WIN },
        exec: { npm: NPM_WIN },
        here: {},
      }),
    });
    const last = run(ctx).fixes.find((f) => f.kind === "last-resort")!;
    expect(last.tools).toEqual(["npm"]);
    expect(last.leavesBroken).toEqual(["login", "exec", "here"]);
    expect(last.warning).toContain("does not fix unreachable");
  });
  test("windows-only tools get no appendWindowsPath proposal, because it would only hide them", () => {
    const ctx = makeCtx({
      runner: fakeRunner({ interactive: { npm: NPM_WIN }, login: { npm: NPM_WIN }, exec: { npm: NPM_WIN }, here: {} }),
    });
    expect(run(ctx).fixes.map((f) => f.kind)).toEqual(["install"]);
  });
  test("appendWindowsPath=false is never first", () => {
    expect(run(shadowed()).fixes[0]!.kind).not.toBe("last-resort");
  });
  test("tools with no Linux build get an install note, not a path", () => {
    const ctx = makeCtx({
      runner: fakeRunner({ interactive: { npm: NPM_WIN }, login: { npm: NPM_WIN }, exec: { npm: NPM_WIN }, here: {} }),
    });
    expect(run(ctx).fixes[0]!.kind).toBe("install");
  });
  test("a clean machine has no fixes", () => {
    const git = { git: "/usr/bin/git" };
    const ctx = makeCtx({ runner: fakeRunner({ interactive: git, login: git, exec: git, here: git }) });
    expect(run(ctx).fixes).toEqual([]);
  });
});

describe("json shape", () => {
  test("is versioned and carries the documented fields", () => {
    const report = run(makeCtx({ runner: fakeRunner({}) }));
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.schemaVersion).toBe(1);
    expect(Object.keys(parsed).sort()).toEqual(
      ["distro", "exitCode", "fixes", "insideWsl", "mountRoot", "rows", "schemaVersion", "views"].sort(),
    );
    expect(Object.keys(parsed.rows[0]).sort()).toEqual(
      ["consequence", "failingViews", "hits", "linuxCandidate", "probes", "status", "tool"].sort(),
    );
    expect(parsed.rows).toHaveLength(TOOLS.length);
  });
});

// Real processes against stub binaries under a temp "mount root". Linux/WSL only.
describe.skipIf(process.platform === "win32")("integration (real sh)", () => {
  test("the here view flags a stub under the fake mount root", () => {
    const base = mkdtempSync(join(tmpdir(), "wsl-shadow-"));
    try {
      const winDir = join(base, "win", "c", "nodejs");
      const linDir = join(base, "bin");
      mkdirSync(winDir, { recursive: true });
      mkdirSync(linDir, { recursive: true });
      for (const [dir, name] of [[winDir, "npm"], [linDir, "git"]] as const) {
        const file = join(dir, name);
        writeFileSync(file, "#!/bin/sh\necho stub\n");
        chmodSync(file, 0o755);
      }
      const env = { PATH: `${winDir}:${linDir}:/usr/bin:/bin` };
      // Only paths inside the temp dir exist, so the machine's own /usr/local/bin can't change the result.
      const sandboxFs: FsOps = {
        exists: (p) => p.startsWith(base) && existsSync(p),
        readDir: () => [],
        readText: () => null,
      };
      const ctx = createCtx({
        env,
        fs: sandboxFs,
        mountRoot: `${join(base, "win")}/`,
        distro: null,
        wslExe: null,
        shell: "/bin/sh",
        home: base,
      });
      const report = buildReport(ctx, { required: [], views: ["here"] });
      const rows = Object.fromEntries(report.rows.map((r) => [r.tool, r.status]));
      expect(rows.npm).toBe("windows-only");
      expect(rows.git).toBe("ok");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
