# wsl-shadow

[![npm](https://img.shields.io/npm/v/wsl-shadow)](https://www.npmjs.com/package/wsl-shadow)
[![JSR](https://jsr.io/badges/@kanchingyg/wsl-shadow)](https://jsr.io/@kanchingyg/wsl-shadow)

```text
┌─ wsl ───────────────────────────────────────────────┐
│ alex@dev:~$ command -v npm                          │
│ /home/alex/.nvm/versions/node/v22.23.2/bin/npm      │
│                                                     │
│ agent (wsl.exe -e sh -c)                            │
│ /mnt/c/Program Files/nodejs/npm                     │
└─────────────────────────────────────────────────────┘
```

Your terminal and an AI agent on the same WSL distro can resolve `npm` to two different programs. wsl-shadow runs the lookup the way each of them launches a command, and prints the difference.

## The problem

WSL appends the Windows PATH to every process. nvm, fnm and the rest load from `~/.bashrc`, and Ubuntu's `~/.bashrc` returns immediately when the shell is not interactive. Agents start `wsl.exe bash -lc`, `wsl.exe -e sh -c`, or a spawn with no shell. None of those read `~/.bashrc`.

Linux `npm` is missing from that PATH, so `/mnt/c/Program Files/nodejs/npm` wins. `npm -v` still prints a version. `npm config get prefix` points at `C:\Users\...`, and `node` is often not found at all, because WSL will not run `node.exe` under the name `node`.

| View | How an agent launches it | What that shell reads |
|---|---|---|
| `interactive` | your terminal | `~/.bashrc`, and `~/.profile` if it is a login |
| `login` | `wsl.exe bash -lc`, MCP `"command": "wsl"` | `~/.profile`, unless `~/.bash_profile` or `~/.bash_login` exists |
| `exec` | `wsl.exe -e sh -c`, `bash -c`, spawn | nothing |
| `here` | whoever is running wsl-shadow | the PATH it inherited |

## Measured output

Real run on WSL2 Ubuntu with nvm and with Node also installed on Windows. User names and home paths are swapped. The `/mnt/c/Program Files/nodejs` hit and the `C:\` prefix are what the tool printed.

```text
$ wsl-shadow --view=interactive,login,exec

unreachable node
          interactive /home/alex/.nvm/versions/node/v22.23.2/bin/node
          login       (not found)  <- fails
          exec        (not found)  <- fails
shadow    npm
          interactive /home/alex/.nvm/versions/node/v22.23.2/bin/npm
          login       /mnt/c/Program Files/nodejs/npm  <- fails
          exec        /mnt/c/Program Files/nodejs/npm  <- fails
          measured: `npm config get prefix` = C:\Users\alex\AppData\Roaming\npm (login)
```

A PATH block in `~/.profile` cleared `login` and left `exec` on the Windows `npm`. Symlinks in `/usr/local/bin` cleared `exec` too.

Reported elsewhere:

- [openai/codex#20810](https://github.com/openai/codex/issues/20810): `node` missing, `npm` under `/mnt/c/.../fnm/`.
- [GitNexus#1220](https://github.com/abhigyanpatwari/GitNexus/issues/1220): interactive `which` is Linux; `wsl bash -lc` runs the Windows shim.
- [Kilo#8129](https://github.com/Kilo-Org/kilocode/issues/8129): the agent shell skips `.bashrc` and gets Windows npm.
- [pi#1756](https://github.com/badlogic/pi-mono/issues/1756): `spawnSync("npm")` and the shell `npm` disagree; `npm root -g` returns `C:\`.
- [agent-girl f184807](https://github.com/KenKaiii/agent-girl/commit/f1848071ee26fe8f7ca1b66d6729a95681518106): the launcher detects Windows Bun and installs a Linux one.

## Install

Run it inside WSL. Prefer the Linux binary or `node dist/cli.js`: `bunx` / `npx` inside WSL can resolve to the Windows Bun or npm.

[npm](https://www.npmjs.com/package/wsl-shadow):

```bash
bun add wsl-shadow
npm i wsl-shadow
```

[JSR](https://jsr.io/@kanchingyg/wsl-shadow):

```bash
bunx jsr add @kanchingyg/wsl-shadow
```

```bash
# Release binary (no Node required)
# Download wsl-shadow-linux-x64 or wsl-shadow-linux-arm64 from the GitHub Release,
# chmod +x it, put it on PATH (for example /usr/local/bin/wsl-shadow).
```

From a clone:

```bash
bun install
bun run build        # dist/cli.js, dist/index.js, types, JSON Schema
bun run build:bin    # dist/wsl-shadow-linux-x64 and dist/wsl-shadow-linux-arm64
node dist/cli.js --json
```

## Use

```bash
wsl-shadow                          # report
wsl-shadow --json                   # schemaVersion 1, for agents and CI
wsl-shadow --fix                    # prints proposals, changes nothing, runs nothing
wsl-shadow --apply                  # shows the plan, asks you to type "apply", then does it
wsl-shadow --undo                   # reverts only what --apply recorded
wsl-shadow --preflight              # pass/fail for a harness; stdout is a PATH prefix
wsl-shadow --mcp                    # read MCP configs (Cursor, Claude, Codex, Kilo, VS Code)
wsl-shadow --view=exec              # interactive, login, exec, exec-zsh, here
wsl-shadow --require=node,npm
wsl-shadow --expect-windows=claude  # treat that tool as expected Windows (exit 0)
```

Exit `0` when every measured tool is fine. Exit `1` on `shadow`, `windows-only`, `unreachable`, `drift`, an invisible npm global bin, or a bad MCP server under `--mcp`. Exit `2` when a tool named in `--require` is missing. `cursor` and `code` are expected to be Windows by default.

| Status | Meaning |
|---|---|
| `ok` | every measured view resolves to Linux, same version |
| `shadow` | a Linux build exists, and a view gets Windows |
| `windows-only` | a view gets Windows, and no Linux build exists |
| `unreachable` | a Linux build exists, and a view finds nothing |
| `drift` | every view is Linux, but `node`/`npm`/`bun --version` disagree |
| `missing` | nowhere |
| `unmeasured` | that view could not be run; the tool does not guess |

`--json` matches [schemas/report.v1.schema.json](schemas/report.v1.schema.json) (`schemaVersion: 1`). The published package also exposes it as `wsl-shadow/schema`.

## Drift and npm globals

Two Linux paths are not enough. If your terminal's `node` is v22 and the `exec` launch's `node` is v20, the status is `drift` and the exit code is 1.

When `npm` is already Linux, wsl-shadow runs `npm config get prefix` in that view and checks whether `$prefix/bin` is on PATH. If a symlink made `npm` visible but globals still land in an nvm folder that `exec` does not search, it warns, names the globals `exec` cannot run, and exits 1. A PATH block cannot fix that (`exec` reads no startup file); a link in `/usr/local/bin` can. `--fix` prints those links and `--apply` creates them. The warning clears once every global in that folder is reachable, and returns after the next `npm i -g` until you run `--apply` again.

## MCP configs (`--mcp`)

Read-only. Walks known config paths on the Linux home and under the Windows profile mount (`/mnt/c/Users/...`). Each path is marked `verified` (that client's docs), `reported` (a published guide), or `unverified` (guess).

For every server whose `command` is `wsl` / `wsl.exe`, or a bare `npx` / `node` / `bun`, it picks the launch view (`login` vs `exec` vs Windows-native), resolves the program, and prints status plus a printed-only fix hint. Config files are never edited.

## What `--fix` reaches

Each proposal names the views it fixes and the views it leaves broken. A PATH block can only fix the views whose shell reads that file.

| Proposal | `login` | `exec` |
|---|---|---|
| PATH block in the login file bash actually reads | yes | **no** |
| PATH block in `~/.zshenv` | yes, on zsh | `zsh -c` only |
| Symlink in `/usr/local/bin` | yes | yes |
| `appendWindowsPath=false` | yes, for `shadow` | yes, for `shadow` |

`sh -c`, `bash -c`, `wsl.exe -e` and spawn read no startup file. A clean `login` row leaves those on Windows `npm`. The only fix for `exec` is a link in a directory it already searches (`/usr/local/bin`), or a PATH set in that harness's own config.

`appendWindowsPath=false` is printed last, as text. It drops `code`, `explorer.exe` and `cmd.exe` from PATH by name. It does not fix `unreachable`: `node` stays missing, and `npm` goes from a Windows path to not found. `--apply` never does it.

A symlink to `~/.nvm/versions/node/v22.x/bin/npm` keeps serving v22 after `nvm alias default` moves on. Point it at `~/.nvm/current/bin/<tool>` (`NVM_SYMLINK_CURRENT=true`, then `nvm use default`). `--fix` and `--apply` use `current` when it exists, and say so when it does not. Run wsl-shadow again after changing the default Node.

`windows-only` on `claude` means Claude Code is installed on Windows and not in WSL. Pass `--expect-windows=claude` if that is intentional. The tool never installs Claude.

## `--apply` and `--undo`

`--fix` is a dry run and stays one. `--apply` prints the same plan plus the exact steps, asks you to type `apply`, and only then writes. `--yes` replaces the typed answer; without a terminal and without `--yes` it refuses.

```text
$ wsl-shadow --apply

--apply plan
  link   sudo ln -s '/home/alex/.nvm/versions/node/v22.23.2/bin/corepack' /usr/local/bin/corepack
  state   /home/alex/.local/state/wsl-shadow/applied.json
  backups /home/alex/.local/state/wsl-shadow/backups
  sudo asks for your password at this terminal, for the link commands only. It is never stored.

Type "apply" to continue, anything else cancels: apply

applied:
  done      /usr/local/bin/corepack -> /home/alex/.nvm/versions/node/v22.23.2/bin/corepack

before -> after
  npm      ok, globals not visible to exec (corepack)  ->  ok
  exit code 1 -> 0
```

It changes two kinds of thing, and nothing else:

| Change | Where | How it is made safe |
|---|---|---|
| One PATH block between `# >>> wsl-shadow >>>` and `# <<< wsl-shadow <<<` | the file bash reads for login (`~/.bash_profile`, else `~/.bash_login`, else `~/.profile`), or `~/.zshenv` | backup first; the new text is written to a temp file and must pass `bash -n` (`zsh -n`) before it replaces the file; mode and ownership of the existing file are kept; a second run replaces the block, never adds one; only `export PATH="dirs:$PATH"` lines for Linux dirs that exist |
| Symlinks | `/usr/local/bin` | `sudo ln -s`, never `-f`; a name that already exists is skipped; targets must exist and be Linux paths |

- Links come from the tool proposals (`node`, `npm`, `bun`… found in a manager dir) and from the npm prefix: every global in `$(npm config get prefix)/bin` that `exec` cannot run gets a link. Run `--apply` again after `npm i -g` to link the new ones. It also removes links it made earlier that now dangle (a deleted nvm version). A dangling link it did not make is left alone.
- `sudo` runs only for those link commands, through your normal terminal prompt. wsl-shadow never reads, caches or stores the password. It refuses to run as root. The shipped code always calls the real `sudo` binary; it does not escalate through the Windows host.
- Before each change, the intent is written to `~/.local/state/wsl-shadow/applied.json` and fsynced (`pending`). After the change lands it is marked done. If the process dies in between, the next `--apply` or `--undo` looks at the real files and either records what landed (so undo can reverse it) or drops the pending entry. Backups go under `~/.local/state/wsl-shadow/backups/`. If a file edit fails, no `sudo` runs.
- After `--apply` and `--undo` it re-measures every view and prints before and after.

`--undo` reads that state file and nothing else. It removes the links it created (only if they still point where it pointed them), and restores each edited file from the first backup. If you edited the file since, it removes only the marked block and keeps your edit. A file it created is deleted only while it is still exactly what it wrote. To revert by hand: delete the block between the markers, and `sudo rm` the links listed in `applied.json`.

Never touched: `/etc/wsl.conf`, `.wslconfig`, `/etc/profile`, `/etc/environment`, `~/.bashrc`, `WSLENV`, the Windows PATH, `System32`, anything under `/mnt/<drive>/`, or anything it did not create. It never runs `wsl --shutdown` and does not install nvm, Node, Bun or `claude`.

## Library

ESM with types. Importing it runs nothing: no process, no filesystem, no exit, no output.

```ts
import { scan, resolveTool, scanMcp, planFixes, preflight } from "wsl-shadow";

const report = scan({ required: ["node"] });        // same data as --json
const npm = resolveTool("npm");                      // one row; any command name works
const fixes = planFixes(report);                     // dry-run proposals, nothing is run
if (report.exitCode !== 0) console.error(npm.status, npm.consequence);
```

| Export | Returns |
|---|---|
| `scan(opts?)` | `Report`, the `--json` payload (`schemaVersion: 1`) |
| `resolveTool(name, opts?)` | one `ToolRow` |
| `scanMcp(opts?)` | `McpReport`, read-only |
| `planFixes(report, opts?)` | `Fix[]`, each with `fixesViews`, `leavesBroken`, `links` |
| `preflight(opts?)` | `{ exitCode, view, pathPrefix, problems, error }` |
| `planApply`, `runApply`, `planUndo`, `runUndo`, `createApplyDeps` | the `--apply` / `--undo` engine, for hosts that confirm in their own UI |

Every function takes an optional `runner`, `fs`, `env`, `home`, `distro`, `shell`, `mountRoot`, `wslExe`, `timeoutMs`, so tests can fake the machine. Functions return data and throw nothing for a bad machine; only the CLI exits. `runApply` and `runUndo` write, and are the only exports that do.

## `--preflight`

A fast pass/fail for a harness before it starts work: one lookup in the `exec` view (what `sh -c`, `wsl.exe -e` and spawn get), for `node` and `npm` unless you pass `--require=a,b`. No versions, no probes.

```bash
PATH="$(wsl-shadow --preflight):$PATH"     # prefix on stdout, reasons on stderr
wsl-shadow --preflight --json              # { exitCode, view, pathPrefix, problems, error }
```

| Exit | Meaning |
|---|---|
| `0` | every tool resolves to a Linux build in `exec` |
| `1` | a Windows build answers or nothing does, but a Linux build exists; stdout is the PATH prefix that reaches it. Also `1` if the view could not run (`error` is set, stdout empty) |
| `2` | a tool has no Linux build anywhere |

The prefix is the directory of each tool's Linux build, using `~/.nvm/current/bin` when it exists. Use the absolute path or a `/usr/local/bin` link to call wsl-shadow itself from `exec`.

Wiring, by harness. These are the generic patterns; none was run inside that harness yet:

- **Cursor, Kilo** (MCP servers via `wsl.exe`): `"command": "wsl.exe", "args": ["-e", "sh", "-c", "PATH=\"$(/usr/local/bin/wsl-shadow --preflight):$PATH\" exec npx -y your-server"]`.
- **Codex** (`[mcp_servers.x]` in `config.toml`): the same `command` and `args`. For its shell tool, call `wsl-shadow --preflight` first and stop on a non-zero exit.
- **Claude Code**: run `wsl-shadow --preflight || exit 1` in whatever script or hook starts the session, and export the printed prefix into its PATH.

Not measured: WSL1, Alpine, which launch form each harness uses, arm64 binary on hardware, `--apply` with a real interactive `sudo` prompt (the lab run used a stand-in), `--preflight` inside each harness.

## For agents

Paste `AGENTS-SNIPPET.md` into `AGENTS.md`, or load `skill/wsl-shadow/SKILL.md`. Both say: run `wsl-shadow --json --view=here` before trusting `node`, `npm`, `bun` or `claude`; you may suggest `wsl-shadow --apply`, but ask the user before running it, and never edit shell rc files or `/usr/local/bin` yourself.

## Contributing

```bash
bun install
bun run check-versions   # package.json and jsr.json must match
bun run typecheck
bun test
bun run build
bun run build:bin        # Linux binaries (run under WSL or Linux CI)
```

Contributor scripts under `scripts/`:

| Script | Purpose |
|---|---|
| `copy-schema.ts` | copies `schemas/report.v1.schema.json` into `dist/` during `bun run build` |
| `check-versions.ts` | asserts `package.json` / `jsr.json` versions match (and the git tag in release CI) |
| `registry-has-version.ts` | exit 0/1/2 for “version already on npm or JSR” (release workflow skips publish when 0) |
| `verify-dist.sh` | smoke-tests `dist/cli.js` and the Linux x64 binary the way a user without Bun would (run inside WSL after `build` + `build:bin`) |
| `scan-mojibake.py` | fails if tracked text files contain UTF-8 replacement characters |

```bash
# inside WSL, after a local build
bash scripts/verify-dist.sh
python3 scripts/scan-mojibake.py
```

Pack / JSR dry runs before a release:

```bash
npm pack --dry-run
bunx jsr publish --dry-run
```

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html). Free and open source. If you ship a modified version, or run a modified version as a network service, you must publish that source under the AGPL. Closed-source or proprietary commercial use needs a separate license from the author (dual licensing); ask via GitHub.

The name `wsl-shadow` is not licensed for use by forks or derived products without permission.

Augusto Cerrutti · [github.com/kanchingyg](https://github.com/kanchingyg)
