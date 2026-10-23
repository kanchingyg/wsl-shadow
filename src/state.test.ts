// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { MemFs } from "./testkit";
import {
  emptyState,
  loadState,
  saveState,
  sha256Text,
  statePath,
  type AppliedState,
  type PendingChange,
} from "./state";

const HOME = "/home/u";

function writeRaw(fs: MemFs, body: unknown): void {
  fs.mkdirp();
  fs.writeText(statePath(HOME), `${JSON.stringify(body, null, 2)}\n`);
}

function validFile(): AppliedState["files"][0] {
  return {
    path: `${HOME}/.profile`,
    existedBefore: true,
    originalBackup: `${HOME}/.local/state/wsl-shadow/backups/x`,
    writtenSha256: sha256Text("block"),
    appliedAt: "2026-01-01T00:00:00.000Z",
  };
}

function validLink(): AppliedState["links"][0] {
  return {
    link: "/usr/local/bin/npm",
    target: "/home/u/.nvm/versions/node/v22/bin/npm",
    appliedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("loadState", () => {
  test("missing file is an empty state", () => {
    const loaded = loadState(new MemFs(), HOME);
    expect(loaded).toEqual({ ok: true, state: emptyState() });
  });

  test("round-trips a valid file", () => {
    const fs = new MemFs();
    const state: AppliedState = {
      schemaVersion: 1,
      files: [validFile()],
      links: [validLink()],
      history: [{ at: "2026-01-01T00:00:00.000Z", action: "apply", changes: ["linked npm"] }],
      pending: [],
    };
    saveState(fs, HOME, state);
    expect(loadState(fs, HOME)).toEqual({ ok: true, state });
  });

  test("rejects invalid JSON", () => {
    const fs = new MemFs();
    fs.mkdirp();
    fs.writeText(statePath(HOME), "{ not json");
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("not valid JSON");
  });

  test("rejects unsupported schemaVersion", () => {
    const fs = new MemFs();
    writeRaw(fs, { schemaVersion: 2, files: [], links: [] });
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("unsupported schemaVersion");
  });

  test("rejects a corrupt file record", () => {
    const fs = new MemFs();
    writeRaw(fs, {
      schemaVersion: 1,
      files: [{ path: `${HOME}/.profile`, existedBefore: true }],
      links: [],
    });
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("files[0]");
  });

  test("rejects a corrupt link record", () => {
    const fs = new MemFs();
    writeRaw(fs, {
      schemaVersion: 1,
      files: [],
      links: [{ link: "/usr/local/bin/npm", appliedAt: "x" }],
    });
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("links[0].target");
  });

  test("rejects unknown history action", () => {
    const fs = new MemFs();
    writeRaw(fs, {
      schemaVersion: 1,
      files: [],
      links: [],
      history: [{ at: "x", action: "rebase", changes: [] }],
    });
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain('history[0].action must be "apply" or "undo"');
  });

  test("rejects more than one pending entry", () => {
    const fs = new MemFs();
    const pending: PendingChange = {
      kind: "forget",
      link: "/usr/local/bin/npm",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeRaw(fs, { schemaVersion: 1, files: [], links: [], pending: [pending, pending] });
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("at most one");
  });

  test("rejects unknown pending kind so undo cannot invent a reverse", () => {
    const fs = new MemFs();
    writeRaw(fs, {
      schemaVersion: 1,
      files: [],
      links: [],
      pending: [{ kind: "explode", startedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toContain("unknown kind");
      expect(loaded.reason).toContain("refusing to load");
    }
  });

  test("rejects pending block with a bad hash", () => {
    const fs = new MemFs();
    writeRaw(fs, {
      schemaVersion: 1,
      files: [],
      links: [],
      pending: [
        {
          kind: "block",
          file: `${HOME}/.profile`,
          intendedSha256: "not-a-hash",
          previousSha256: null,
          existedBefore: false,
          originalBackup: null,
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const loaded = loadState(fs, HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("intendedSha256");
  });

  test("accepts a valid pending link", () => {
    const fs = new MemFs();
    const pending: PendingChange = {
      kind: "link",
      link: "/usr/local/bin/npm",
      target: "/home/u/.nvm/bin/npm",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    writeRaw(fs, { schemaVersion: 1, files: [], links: [], pending: [pending] });
    expect(loadState(fs, HOME)).toEqual({
      ok: true,
      state: { schemaVersion: 1, files: [], links: [], history: [], pending: [pending] },
    });
  });
});
