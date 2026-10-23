// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { scan } from "./api";
import { fakeRunner, MemFs, NPM_WIN, NVM_BIN } from "./testkit";

const schemaPath = join(import.meta.dir, "..", "schemas", "report.v1.schema.json");

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  return ajv.compile(schema);
}

describe("report JSON Schema (schemaVersion 1)", () => {
  test("schema file is present and declares schemaVersion 1", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.properties.schemaVersion.const).toBe(1);
  });

  test("a clean scan() report validates", () => {
    const linked = { node: `${NVM_BIN}/node`, npm: `${NVM_BIN}/npm`, git: "/usr/bin/git" };
    const fs = new MemFs({
      [`${NVM_BIN}/node`]: "",
      [`${NVM_BIN}/npm`]: "",
      "/usr/bin/git": "",
    });
    const report = scan({
      runner: fakeRunner({
        interactive: linked,
        login: linked,
        exec: linked,
        here: linked,
      }),
      fs,
      env: {},
      home: "/home/u",
      distro: "Ubuntu",
      shell: "/bin/bash",
      mountRoot: "/mnt/",
      wslExe: "/mnt/c/Windows/System32/wsl.exe",
    });
    const validate = validator();
    const ok = validate(JSON.parse(JSON.stringify(report)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  test("a shadowed report with fixes and npm prefix validates", () => {
    const fs = new MemFs({
      [`${NVM_BIN}/node`]: "",
      [`${NVM_BIN}/npm`]: "",
      [`${NVM_BIN}/corepack`]: "",
    });
    const report = scan({
      runner: fakeRunner(
        {
          interactive: { npm: `${NVM_BIN}/npm` },
          login: { npm: NPM_WIN },
          exec: { npm: NPM_WIN },
          here: { npm: `${NVM_BIN}/npm` },
        },
        { "login:npm config get prefix": "C:\\Users\\a\\AppData\\Roaming\\npm" },
      ),
      fs,
      env: {},
      home: "/home/u",
      distro: "Ubuntu",
      shell: "/bin/bash",
      mountRoot: "/mnt/",
      wslExe: "/mnt/c/Windows/System32/wsl.exe",
      mcp: false,
    });
    expect(report.fixes.length).toBeGreaterThan(0);
    const validate = validator();
    const ok = validate(JSON.parse(JSON.stringify(report)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  test("makeCtx + buildReport shape stays in sync with the schema keys", () => {
    const report = scan({
      runner: fakeRunner({}),
      fs: new MemFs(),
      env: {},
      home: "/home/u",
      distro: null,
      wslExe: null,
    });
    expect(Object.keys(report).sort()).toEqual(
      ["distro", "exitCode", "fixes", "insideWsl", "mcp", "mountRoot", "rows", "schemaVersion", "views"].sort(),
    );
    const validate = validator();
    expect(validate(JSON.parse(JSON.stringify(report)))).toBe(true);
  });
});
