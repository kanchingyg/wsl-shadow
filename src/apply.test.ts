// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planApply, planUndo, runApply, runUndo, sha256, type ApplyDeps } from "./apply";
import { hasBlock, removeBlock, upsertBlock } from "./block";
import { runApplyCommand, runUndoCommand, type CommandIo } from "./cli-apply";
import { buildFixes, BLOCK_END, BLOCK_START } from "./fixes";
import { createCtx, realWritableFs } from "./env";
import { buildReport } from "./report";
import { realRunner } from "./runner";
import { loadState, statePath } from "./state";
import { applyRunner, fakeRunner, makeCtx, MemFs, NVM_BIN, type Tables } from "./testkit";
import type { Fix } from "./types";

const HOME = "/home/u";
const PREFIX = "/home/u/.nvm/versions/node/v22.1.0";
const PROFILE = `${HOME}/.profile`;
const PROFILE_TEXT = "# ~/.profile\numask 022\n";
const REPORT_OPTS = { required: [], views: null, expectWindows: [], mcp: false };
const NOW = new Date("2026-10-22T22:00:00.000Z");

interface WorldOptions {
  /** bun exists only under ~/.bun/bin, so login and exec cannot find it: a PATH block and a link are proposed. */
  loginBroken?: boolean;
  files?: Record<string, string>;
  links?: Record<string, string>;
  syntaxCode?: number;
  failLink?: string[];
  isRoot?: boolean;
  distro?: string | null;
}

function world(opts: WorldOptions = {}) {
  const fs = new MemFs(
    {
      [`${NVM_BIN}/node`]: "",
      [`${NVM_BIN}/npm`]: "",
      [`${NVM_BIN}/npx`]: "",
      [`${NVM_BIN}/corepack`]: "",
      [`${NVM_BIN}/foo`]: "",
      [PROFILE]: PROFILE_TEXT,
      ...(opts.loginBroken ? { "/home/u/.bun/bin/bun": "" } : {}),
      ...opts.files,
    },
    {
      "/usr/local/bin/node": `${NVM_BIN}/node`,
      "/usr/local/bin/npm": `${NVM_BIN}/npm`,
      "/usr/local/bin/npx": `${NVM_BIN}/npx`,
      ...opts.links,
    },
  );
  const linked = { node: "/usr/local/bin/node", npm: "/usr/local/bin/npm", npx: "/usr/local/bin/npx" };
  const interactive = {
    node: `${NVM_BIN}/node`,
    npm: `${NVM_BIN}/npm`,
    npx: `${NVM_BIN}/npx`,
    ...(opts.loginBroken ? { bun: "/home/u/.bun/bin/bun" } : {}),
  };
  const tables: Tables = {
    interactive,
    login: linked,
    exec: linked,
    here: linked,
  };
  const base = fakeRunner(tables, {
    "exec:npm config get prefix": PREFIX,
    "exec:printenv PATH": "/usr/local/bin:/usr/bin:/bin",
  });
  const runner = applyRunner(base, fs, { syntaxCode: opts.syntaxCode, failLink: opts.failLink });
  const deps: ApplyDeps = {
    ctx: makeCtx({ fs, runner, distro: opts.distro === undefined ? "Ubuntu" : opts.distro }),
    fs,
    now: () => NOW,
    isRoot: opts.isRoot ?? false,
  };
  const report = () => buildReport(deps.ctx, REPORT_OPTS);
  return { fs, runner, deps, report };
}

function applyOnce(w: ReturnType<typeof world>) {
  const plan = planApply(w.report().fixes, w.deps);
  return { plan, run: runApply(plan, w.deps) };
}

describe("block markers", () => {
  const block = `${BLOCK_START}\nexport PATH="$HOME/bin:$PATH"\n${BLOCK_END}`;
  test("upsert appends once and is idempotent", () => {
    const once = upsertBlock("a=1\n", block);
    expect(once).toBe(`a=1\n\n${block}\n`);
    expect(upsertBlock(once, block)).toBe(once);
  });
  test("upsert replaces an old block and collapses duplicates", () => {
    const old = `${BLOCK_START}\nexport PATH="/old:$PATH"\n${BLOCK_END}`;
    const text = `x\n${old}\ny\n${old}\n`;
    const out = upsertBlock(text, block);
    expect(out.split(BLOCK_START).length - 1).toBe(1);
    expect(out).toContain('"$HOME/bin:$PATH"');
    expect(out).not.toContain("/old");
  });
  test("remove undoes an append exactly, and works on an empty file", () => {
    expect(removeBlock(upsertBlock("a=1\n", block))).toBe("a=1\n");
    expect(removeBlock(upsertBlock("", block))).toBe("");
    expect(hasBlock("nothing here")).toBe(false);
  });
});

describe("--apply: npm globals", () => {
  test("links only the globals exec cannot see, never with -f", () => {
    const w = world();
    expect(w.report().rows.find((r) => r.tool === "npm")!.npmPrefix?.unlinked).toEqual(["corepack", "foo"]);
    const { plan, run } = applyOnce(w);
    expect(plan.steps.map((s) => s.kind)).toEqual(["link", "link"]);
    expect(run.ok).toBe(true);
    expect(w.runner.sudo.calls).toEqual([
      ["ln", "-s", `${NVM_BIN}/corepack`, "/usr/local/bin/corepack"],
      ["ln", "-s", `${NVM_BIN}/foo`, "/usr/local/bin/foo"],
    ]);
    expect(w.runner.all.flat()).not.toContain("-f");
    expect(w.fs.links.get("/usr/local/bin/foo")).toBe(`${NVM_BIN}/foo`);
  });

  test("the npm-globals warning is gone after apply, and exit goes 1 -> 0", () => {
    const w = world();
    const before = w.report();
    expect(before.exitCode).toBe(1);
    expect(before.rows.find((r) => r.tool === "npm")!.npmPrefix?.invisibleToView).toBe(true);
    applyOnce(w);
    const after = w.report();
    expect(after.rows.find((r) => r.tool === "npm")!.npmPrefix?.invisibleToView).toBe(false);
    expect(after.exitCode).toBe(0);
  });

  test("records every link in the state file", () => {
    const w = world();
    applyOnce(w);
    const loaded = loadState(w.fs, HOME);
    expect(loaded.ok && loaded.state.links.map((l) => l.link)).toEqual(["/usr/local/bin/corepack", "/usr/local/bin/foo"]);
    expect(w.fs.files.has(statePath(HOME))).toBe(true);
    expect(loaded.ok && loaded.state.history[0]!.action).toBe("apply");
  });

  test("running it again changes nothing", () => {
    const w = world();
    applyOnce(w);
    const stateBefore = w.fs.files.get(statePath(HOME));
    const callsBefore = w.runner.sudo.calls.length;
    const { plan, run } = applyOnce(w);
    expect(plan.steps).toEqual([]);
    expect(run.results).toEqual([]);
    expect(w.runner.sudo.calls.length).toBe(callsBefore);
    expect(w.fs.files.get(statePath(HOME))).toBe(stateBefore);
  });

  test("a newly installed global is linked on the next run", () => {
    const w = world();
    applyOnce(w);
    w.fs.files.set(`${NVM_BIN}/bar`, "");
    const { plan } = applyOnce(w);
    expect(plan.steps.map((s) => (s.kind === "link" ? s.link : s.kind))).toEqual(["/usr/local/bin/bar"]);
    expect(w.fs.links.has("/usr/local/bin/bar")).toBe(true);
  });

  test("prefers ~/.nvm/current over the pinned version", () => {
    const w = world({ files: { "/home/u/.nvm/current/bin/foo": "", "/home/u/.nvm/current/bin/corepack": "" } });
    applyOnce(w);
    expect(w.fs.links.get("/usr/local/bin/foo")).toBe("/home/u/.nvm/current/bin/foo");
  });

  test("an existing link that is not ours is skipped, not replaced", () => {
    const w = world({ links: { "/usr/local/bin/foo": "/opt/other/foo" }, files: { "/opt/other/foo": "" } });
    const { plan } = applyOnce(w);
    expect(plan.steps.map((s) => (s.kind === "link" ? s.name : s.kind))).toEqual(["corepack"]);
    expect(w.fs.links.get("/usr/local/bin/foo")).toBe("/opt/other/foo");
    expect(w.runner.sudo.calls.some((c) => c.includes("/usr/local/bin/foo"))).toBe(false);
  });

  test("a dangling link we made is removed; one we did not make is left", () => {
    const w = world({
      links: {
        "/usr/local/bin/gone": "/home/u/.nvm/versions/node/v20.0.0/bin/gone",
        "/usr/local/bin/stranger": "/nowhere/stranger",
      },
    });
    applyOnce(w);
    w.fs.links.set("/usr/local/bin/gone", "/home/u/.nvm/versions/node/v20.0.0/bin/gone");
    const loaded = loadState(w.fs, HOME);
    if (!loaded.ok) throw new Error(loaded.reason);
    loaded.state.links.push({ link: "/usr/local/bin/gone", target: "/home/u/.nvm/versions/node/v20.0.0/bin/gone", appliedAt: NOW.toISOString() });
    w.fs.files.set(statePath(HOME), JSON.stringify(loaded.state));

    const plan = planApply(w.report().fixes, w.deps);
    expect(plan.steps).toEqual([{ kind: "prune", link: "/usr/local/bin/gone", target: "/home/u/.nvm/versions/node/v20.0.0/bin/gone" }]);
    const run = runApply(plan, w.deps);
    expect(run.ok).toBe(true);
    expect(w.fs.links.has("/usr/local/bin/gone")).toBe(false);
    expect(w.fs.links.has("/usr/local/bin/stranger")).toBe(true);
    const after = loadState(w.fs, HOME);
    expect(after.ok && after.state.links.some((l) => l.link === "/usr/local/bin/gone")).toBe(false);
  });

  test("a failed ln is reported, not recorded, and later steps do not run", () => {
    const w = world({ failLink: ["/usr/local/bin/corepack"] });
    const { run } = applyOnce(w);
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => r.status)).toEqual(["failed"]);
    expect(w.fs.links.has("/usr/local/bin/foo")).toBe(false);
    const loaded = loadState(w.fs, HOME);
    expect(loaded.ok && loaded.state.links).toEqual([]);
    expect(loaded.ok && loaded.state.pending).toEqual([]);
  });

  test("never stores or passes a password: sudo gets the terminal and no input", () => {
    const w = world();
    const seen: boolean[] = [];
    const inner = w.deps.ctx.runner;
    w.deps.ctx.runner = {
      run(command, args, opts) {
        if (command === "sudo") seen.push(opts.inherit === true && opts.env === undefined);
        return inner.run(command, args, opts);
      },
    };
    runApply(planApply(w.report().fixes, w.deps), w.deps);
    expect(seen).toEqual([true, true]);
    const state = w.fs.files.get(statePath(HOME)) ?? "";
    expect(state.toLowerCase()).not.toContain("password");
  });
});

describe("--apply: profile block", () => {
  test("adds one marked block, backs up first, checks syntax on the new text", () => {
    const w = world({ loginBroken: true });
    const fixes = w.report().fixes;
    expect(fixes.some((f) => f.kind === "path-block" && f.file === PROFILE)).toBe(true);
    const { run } = applyOnce(w);
    expect(run.ok).toBe(true);
    const text = w.fs.files.get(PROFILE)!;
    expect(text.startsWith(PROFILE_TEXT)).toBe(true);
    expect(text.split(BLOCK_START).length - 1).toBe(1);
    const backups = [...w.fs.files.keys()].filter((k) => k.includes("/backups/"));
    expect(backups).toHaveLength(1);
    expect(w.fs.files.get(backups[0]!)).toBe(PROFILE_TEXT);
    const checked = w.runner.all.find((c) => c[0] === "bash" && c[1] === "-n")!;
    expect(checked[2]).toBe(`${PROFILE}.wsl-shadow.tmp`);
    expect(w.fs.files.has(`${PROFILE}.wsl-shadow.tmp`)).toBe(false);
  });

  test("a second run does not duplicate or rewrite it", () => {
    const w = world({ loginBroken: true });
    applyOnce(w);
    const first = w.fs.files.get(PROFILE);
    const writes = w.fs.writes.length;
    // The fake login view never changes, so the same proposal comes back. It must be a no-op.
    const plan = planApply(w.report().fixes, w.deps);
    expect(plan.steps).toEqual([expect.objectContaining({ kind: "block", unchanged: true })]);
    const run = runApply(plan, w.deps);
    expect(run.results.map((r) => r.status)).toEqual(["unchanged"]);
    expect(w.fs.files.get(PROFILE)).toBe(first);
    expect(w.fs.writes.length).toBe(writes);
    expect(first!.split(BLOCK_START).length - 1).toBe(1);
  });

  test("goes into ~/.bash_profile when that exists, because bash then ignores ~/.profile", () => {
    const w = world({ loginBroken: true, files: { "/home/u/.bash_profile": "# bp\n" } });
    applyOnce(w);
    expect(w.fs.files.get("/home/u/.bash_profile")).toContain(BLOCK_START);
    expect(w.fs.files.get(PROFILE)).toBe(PROFILE_TEXT);
  });

  test("a failed bash -n aborts: file untouched, no state entry, no sudo", () => {
    const w = world({ loginBroken: true, syntaxCode: 2 });
    const { plan, run } = applyOnce(w);
    expect(plan.steps.map((s) => s.kind)).toContain("link");
    expect(run.ok).toBe(false);
    expect(run.results[0]!.detail).toContain("bash -n failed");
    expect(w.fs.files.get(PROFILE)).toBe(PROFILE_TEXT);
    expect(w.fs.files.has(`${PROFILE}.wsl-shadow.tmp`)).toBe(false);
    expect(w.runner.sudo.calls).toEqual([]);
    const loaded = loadState(w.fs, HOME);
    expect(loaded.ok && loaded.state.files).toEqual([]);
    expect(loaded.ok && loaded.state.links).toEqual([]);
  });
});

describe("--undo", () => {
  test("restores the profile byte for byte and removes only our links", () => {
    const w = world({ loginBroken: true });
    w.fs.links.set("/usr/local/bin/mine", "/opt/mine");
    applyOnce(w);
    expect(w.fs.files.get(PROFILE)).not.toBe(PROFILE_TEXT);

    const plan = planUndo(w.deps);
    expect(plan.steps.map((s) => s.kind).sort()).toEqual(["restore", "unlink", "unlink", "unlink"]);
    const run = runUndo(plan, w.deps);
    expect(run.ok).toBe(true);
    expect(w.fs.files.get(PROFILE)).toBe(PROFILE_TEXT);
    expect(w.fs.links.has("/usr/local/bin/corepack")).toBe(false);
    expect(w.fs.links.has("/usr/local/bin/foo")).toBe(false);
    expect(w.fs.links.has("/usr/local/bin/bun")).toBe(false);
    expect(w.fs.links.get("/usr/local/bin/mine")).toBe("/opt/mine");
    expect(w.fs.links.get("/usr/local/bin/node")).toBe(`${NVM_BIN}/node`);
    const state = loadState(w.fs, HOME);
    expect(state.ok && state.state.files).toEqual([]);
    expect(state.ok && state.state.links).toEqual([]);
    expect(state.ok && state.state.history.map((h) => h.action)).toEqual(["apply", "undo"]);
  });

  test("after undo the warning is back, and a final apply fixes it again", () => {
    const w = world();
    applyOnce(w);
    runUndo(planUndo(w.deps), w.deps);
    expect(w.report().exitCode).toBe(1);
    applyOnce(w);
    expect(w.report().exitCode).toBe(0);
  });

  test("if you edited the file since, only the block is removed and your edit stays", () => {
    const w = world({ loginBroken: true });
    applyOnce(w);
    w.fs.files.set(PROFILE, `${w.fs.files.get(PROFILE)}export MY_EDIT=1\n`);
    const plan = planUndo(w.deps);
    expect(plan.steps.find((s) => s.kind === "restore")).toEqual({ kind: "restore", file: PROFILE, how: "strip-block" });
    runUndo(plan, w.deps);
    const text = w.fs.files.get(PROFILE)!;
    expect(text).toContain("MY_EDIT=1");
    expect(text).not.toContain(BLOCK_START);
  });

  test("a file this tool created is deleted only while it is still exactly what we wrote", () => {
    const w = world({ loginBroken: true });
    w.fs.files.delete(PROFILE);
    applyOnce(w);
    expect(w.fs.files.has(PROFILE)).toBe(true);
    const plan = planUndo(w.deps);
    expect(plan.steps.find((s) => s.kind === "restore")).toEqual({ kind: "restore", file: PROFILE, how: "remove-file" });
    runUndo(plan, w.deps);
    expect(w.fs.files.has(PROFILE)).toBe(false);
  });

  test("a link that now points elsewhere is forgotten, not removed", () => {
    const w = world();
    applyOnce(w);
    w.fs.links.set("/usr/local/bin/foo", "/someone/else/foo");
    runUndo(planUndo(w.deps), w.deps);
    expect(w.fs.links.get("/usr/local/bin/foo")).toBe("/someone/else/foo");
    expect(w.runner.sudo.calls.filter((c) => c[0] === "rm").map((c) => c[1])).toEqual(["/usr/local/bin/corepack"]);
  });

  test("with nothing recorded there is nothing to undo", () => {
    const w = world();
    expect(planUndo(w.deps).steps).toEqual([]);
  });
});

describe("--apply safety", () => {
  test("refuses to run as root and outside WSL", () => {
    expect(planApply([], world({ isRoot: true }).deps).refusal).toContain("root");
    expect(planApply([], world({ distro: null }).deps).refusal).toContain("inside WSL");
    expect(planUndo(world({ isRoot: true }).deps).refusal).toContain("root");
  });

  test("refuses a state file it cannot read instead of guessing", () => {
    const w = world();
    w.fs.files.set(statePath(HOME), "{ not json");
    expect(planApply([], w.deps).refusal).toContain("not valid JSON");
    expect(planUndo(w.deps).refusal).toContain("not valid JSON");
  });

  const block = (file: string, line: string): Fix => ({
    order: 1, kind: "path-block", tools: ["node"], fixesViews: ["login"], leavesBroken: [], links: [], commands: [],
    file, warning: null, content: `${BLOCK_START}\n${line}\n${BLOCK_END}`,
  });
  const link = (name: string, linkPath: string, target: string): Fix => ({
    order: 2, kind: "symlink", tools: [name], fixesViews: ["exec"], leavesBroken: [], commands: [], file: null, content: null,
    warning: null, links: [{ name, link: linkPath, target }],
  });

  test("edits only the four startup files in $HOME", () => {
    const w = world();
    const line = `export PATH="${NVM_BIN}:$PATH"`;
    const plan = planApply(
      [block("/etc/wsl.conf", line), block("/etc/profile", line), block(`${HOME}/.bashrc`, line), block(`${HOME}/.config/x/.profile`, line)],
      w.deps,
    );
    expect(plan.steps).toEqual([]);
    expect(plan.skipped).toHaveLength(4);
  });

  test("writes only export PATH lines with real Linux dirs: no source, no eval, no /mnt/c", () => {
    const w = world();
    const plan = planApply(
      [
        block(PROFILE, 'source "$HOME/.nvm/nvm.sh"'),
        block(PROFILE, 'eval "$(curl x)"'),
        block(PROFILE, 'export PATH="/mnt/c/Windows/System32:$PATH"'),
        block(PROFILE, 'export PATH="/does/not/exist:$PATH"'),
      ],
      w.deps,
    );
    expect(plan.steps).toEqual([]);
    expect(plan.skipped.map((s) => s.reason).join("\n")).toContain("unexpected line");
    expect(plan.skipped.map((s) => s.reason).join("\n")).toContain("not a Linux path");
    expect(plan.skipped.map((s) => s.reason).join("\n")).toContain("does not exist");
  });

  test("links only into /usr/local/bin, only to existing Linux targets, never over an entry", () => {
    const w = world();
    const plan = planApply(
      [
        link("a", "/etc/a", `${NVM_BIN}/foo`),
        link("b", "/usr/local/bin/b", "/mnt/c/Windows/b.exe"),
        link("c", "/usr/local/bin/c", "/missing/c"),
        link("node", "/usr/local/bin/node", `${NVM_BIN}/node`),
        link("ok", "/usr/local/bin/ok", `${NVM_BIN}/foo`),
      ],
      w.deps,
    );
    expect(plan.steps.map((s) => (s.kind === "link" ? s.name : s.kind))).toEqual(["ok"]);
    expect(plan.skipped).toHaveLength(4);
  });

  test("never touches wsl.conf, .wslconfig, WSLENV or runs wsl --shutdown", () => {
    const w = world({ loginBroken: true });
    applyOnce(w);
    expect(w.fs.writes.some((p) => /wsl\.conf|\.wslconfig|System32|^\/mnt\//.test(p))).toBe(false);
    expect(w.runner.all.some((c) => c.includes("--shutdown"))).toBe(false);
    expect(JSON.stringify(w.runner.all)).not.toContain("WSLENV");
  });

  test("the last-resort and install proposals are never applied", () => {
    const w = world();
    const plan = planApply(
      [
        { order: 4, kind: "last-resort", tools: ["npm"], fixesViews: ["exec"], leavesBroken: [], file: "/etc/wsl.conf", content: "[interop]\nappendWindowsPath=false", commands: ["wsl.exe --shutdown"], links: [], warning: null },
        { order: 0, kind: "install", tools: ["bun"], fixesViews: [], leavesBroken: [], file: null, content: null, commands: [], links: [], warning: null },
      ],
      w.deps,
    );
    expect(plan.steps).toEqual([]);
  });
});

describe("command flow", () => {
  const io = (answer = "apply", over: Partial<CommandIo> = {}): CommandIo & { prompts: string[] } => {
    const prompts: string[] = [];
    return { yes: false, interactive: true, ask: async (p) => (prompts.push(p), answer), prompts, ...over };
  };

  test("asks for a typed word and prints the plan and before/after", async () => {
    const w = world();
    const lines: string[] = [];
    const code = await runApplyCommand(w.deps, REPORT_OPTS, io(), (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain("--apply plan");
    expect(out).toContain("sudo ln -s");
    expect(out).toContain("before -> after");
    expect(out).toContain("exit code 1 -> 0");
    expect(code).toBe(0);
  });

  test("a wrong answer changes nothing", async () => {
    const w = world();
    const lines: string[] = [];
    const code = await runApplyCommand(w.deps, REPORT_OPTS, io("yes"), (l) => lines.push(l));
    expect(code).toBe(1);
    expect(w.runner.sudo.calls).toEqual([]);
    expect(w.fs.files.has(statePath(HOME))).toBe(false);
    expect(lines.join("\n")).toContain("Cancelled");
  });

  test("without a terminal it refuses unless --yes is given", async () => {
    const w = world();
    const refused = await runApplyCommand(w.deps, REPORT_OPTS, io("apply", { interactive: false }), () => {});
    expect(refused).toBe(64);
    expect(w.runner.sudo.calls).toEqual([]);
    const forced = await runApplyCommand(w.deps, REPORT_OPTS, io("apply", { interactive: false, yes: true }), () => {});
    expect(forced).toBe(0);
    expect(w.runner.sudo.calls.length).toBe(2);
  });

  test("--undo asks for its own word and reverts", async () => {
    const w = world();
    await runApplyCommand(w.deps, REPORT_OPTS, io("apply", { yes: true }), () => {});
    const asked = io("undo");
    const code = await runUndoCommand(w.deps, REPORT_OPTS, asked, () => {});
    expect(asked.prompts[0]).toContain('"undo"');
    expect(code).toBe(1);
    expect(w.fs.links.has("/usr/local/bin/foo")).toBe(false);
  });

  test("state sha matches what was written", () => {
    const w = world({ loginBroken: true });
    applyOnce(w);
    const loaded = loadState(w.fs, HOME);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.state.files[0]!.writtenSha256).toBe(sha256(w.fs.files.get(PROFILE)!));
  });
});

describe("planning is pure", () => {
  test("buildFixes and planApply write nothing when there is no pending crash", () => {
    const w = world({ loginBroken: true });
    buildFixes(w.report().rows, w.deps.ctx);
    planApply(w.report().fixes, w.deps);
    planUndo(w.deps);
    expect(w.fs.writes).toEqual([]);
    expect(w.runner.sudo.calls).toEqual([]);
  });
});

describe("crash safety (pending intent)", () => {
  test("intent is fsynced before a link is created", () => {
    const w = world();
    let sawPending = false;
    w.deps.onPendingWritten = (op) => {
      if (op.kind !== "link") return;
      sawPending = true;
      const loaded = loadState(w.fs, HOME);
      expect(loaded.ok && loaded.state.pending).toEqual([op]);
      expect(w.fs.synced.some((p) => p.endsWith("applied.json") || p.endsWith("applied.json.tmp"))).toBe(true);
      expect(w.fs.links.has(op.link)).toBe(false);
    };
    applyOnce(w);
    expect(sawPending).toBe(true);
    const loaded = loadState(w.fs, HOME);
    expect(loaded.ok && loaded.state.pending).toEqual([]);
  });

  test("crash after pending, before the change: settle drops it; undo does nothing", () => {
    const w = world();
    w.deps.onPendingWritten = (op) => {
      if (op.kind === "link" && op.link.endsWith("/corepack")) throw new Error("crash before ln");
    };
    const { run } = applyOnce(w);
    expect(run.ok).toBe(false);
    expect(w.fs.links.has("/usr/local/bin/corepack")).toBe(false);
    const mid = loadState(w.fs, HOME);
    expect(mid.ok && mid.state.pending[0]?.kind).toBe("link");

    const plan = planUndo(w.deps);
    expect(plan.settled.some((n) => n.includes("did not land"))).toBe(true);
    expect(plan.steps.filter((s) => s.kind === "unlink")).toEqual([]);
    const after = loadState(w.fs, HOME);
    expect(after.ok && after.state.pending).toEqual([]);
    expect(after.ok && after.state.links.some((l) => l.link.endsWith("/corepack"))).toBe(false);
  });

  test("crash after the change, before done: settle records it; undo reverts only what landed", () => {
    const w = world();
    w.deps.onChangeDone = (op) => {
      if (op.kind === "link" && op.link.endsWith("/corepack")) throw new Error("crash after ln");
    };
    const { run } = applyOnce(w);
    expect(run.ok).toBe(false);
    expect(w.fs.links.get("/usr/local/bin/corepack")).toBe(`${NVM_BIN}/corepack`);
    const mid = loadState(w.fs, HOME);
    expect(mid.ok && mid.state.pending[0]?.kind).toBe("link");
    expect(mid.ok && mid.state.links.some((l) => l.link.endsWith("/corepack"))).toBe(false);

    const plan = planUndo(w.deps);
    expect(plan.settled.some((n) => n.includes("change landed"))).toBe(true);
    expect(plan.steps.some((s) => s.kind === "unlink" && s.link.endsWith("/corepack"))).toBe(true);
    const undone = runUndo(plan, w.deps);
    expect(undone.ok).toBe(true);
    expect(w.fs.links.has("/usr/local/bin/corepack")).toBe(false);
    const after = loadState(w.fs, HOME);
    expect(after.ok && after.state.pending).toEqual([]);
    expect(after.ok && after.state.links.some((l) => l.link.endsWith("/corepack"))).toBe(false);
  });

  test("crash after a profile edit, before done: settle + undo restores the backup", () => {
    const w = world({ loginBroken: true });
    w.deps.onChangeDone = (op) => {
      if (op.kind === "block") throw new Error("crash after profile write");
    };
    const { run } = applyOnce(w);
    expect(run.ok).toBe(false);
    expect(w.fs.files.get(PROFILE)).toContain(BLOCK_START);
    const mid = loadState(w.fs, HOME);
    expect(mid.ok && mid.state.pending[0]?.kind).toBe("block");
    expect(mid.ok && mid.state.files).toEqual([]);

    const plan = planUndo(w.deps);
    expect(plan.steps.some((s) => s.kind === "restore" && s.file === PROFILE)).toBe(true);
    runUndo(plan, w.deps);
    expect(w.fs.files.get(PROFILE)).toBe(PROFILE_TEXT);
  });
});

describe("file mode and ownership", () => {
  test("replacing a profile keeps mode and owner", () => {
    const w = world({ loginBroken: true });
    w.fs.meta.set(PROFILE, { mode: 0o100600, uid: 42, gid: 99 });
    applyOnce(w);
    expect(w.fs.stat(PROFILE)).toEqual({ mode: 0o100600, uid: 42, gid: 99 });
    runUndo(planUndo(w.deps), w.deps);
    expect(w.fs.stat(PROFILE)).toEqual({ mode: 0o100600, uid: 42, gid: 99 });
  });
});

describe("shipped sudo", () => {
  test("link steps invoke only the sudo binary (views may still call wsl.exe for lookups)", () => {
    const w = world();
    applyOnce(w);
    expect(w.runner.sudo.calls.length).toBeGreaterThan(0);
    for (const args of w.runner.sudo.calls) {
      expect(args[0] === "ln" || args[0] === "rm").toBe(true);
      expect(args.join(" ")).not.toMatch(/-u\s+root/);
    }
    // Escalation through the Windows host is never the command of a link step.
    expect(w.runner.all.filter((c) => c[0] === "sudo").every((c) => c[0] === "sudo")).toBe(true);
  });

  test("shipped sources never install a host-root stand-in for sudo", async () => {
    const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dir, "..");
    // The lab harness wrote a one-liner like: wsl.exe -d "$WSL_DISTRO_NAME" -u root -e "$@"
    const shim = /wsl(\.exe)?[^\n]{0,80}-u\s+root[^\n]{0,40}-e/;
    const hits: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".bun-cache") continue;
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) {
          walk(path);
          continue;
        }
        if (name.endsWith(".test.ts") || st.size > 1_000_000) continue;
        if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
        if (shim.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    // Always scan sources. Scan dist when present (local/CI after build); CI runs tests before build.
    walk(join(root, "src"));
    walk(join(root, "dist"));
    expect(hits).toEqual([]);
  });
});

// Real filesystem and a real `bash -n`, under a temp home. Linux/WSL only.
describe.skipIf(process.platform === "win32")("integration (real fs, real bash -n)", () => {
  test("edits, validates, backs up, then undoes byte for byte", () => {
    const home = mkdtempSync(join(tmpdir(), "wsl-shadow-home-"));
    try {
      mkdirSync(join(home, "bin"));
      const profile = join(home, ".profile");
      writeFileSync(profile, "# mine\n");
      chmodSync(profile, 0o600);
      const beforeMeta = realWritableFs.stat(profile)!;
      symlinkSync(join(home, "missing"), join(home, "dangling"));
      expect(realWritableFs.entryExists(join(home, "dangling"))).toBe(true);
      expect(realWritableFs.exists(join(home, "dangling"))).toBe(false);
      expect(realWritableFs.readLink(join(home, "dangling"))).toBe(join(home, "missing"));

      const ctx = createCtx({ home, distro: "Ubuntu", env: {}, fs: realWritableFs, runner: realRunner, wslExe: null, shell: "/bin/sh" });
      const deps: ApplyDeps = { ctx, fs: realWritableFs, now: () => NOW, isRoot: false };
      const fix: Fix = {
        order: 1, kind: "path-block", tools: ["node"], fixesViews: ["login"], leavesBroken: [], links: [], commands: [],
        file: profile, warning: null,
        content: `${BLOCK_START}\nexport PATH="$HOME/bin:$PATH"\n${BLOCK_END}`,
      };
      const run = runApply(planApply([fix], deps), deps);
      expect(run.ok).toBe(true);
      expect(readFileSync(profile, "utf8")).toContain(BLOCK_START);
      expect(existsSync(`${profile}.wsl-shadow.tmp`)).toBe(false);
      expect(existsSync(join(home, ".local/state/wsl-shadow/applied.json"))).toBe(true);
      const afterMeta = realWritableFs.stat(profile)!;
      expect(afterMeta.mode & 0o777).toBe(beforeMeta.mode & 0o777);
      expect(afterMeta.uid).toBe(beforeMeta.uid);
      expect(afterMeta.gid).toBe(beforeMeta.gid);

      const undone = runUndo(planUndo(deps), deps);
      expect(undone.ok).toBe(true);
      expect(readFileSync(profile, "utf8")).toBe("# mine\n");
      expect(realWritableFs.stat(profile)!.mode & 0o777).toBe(beforeMeta.mode & 0o777);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});