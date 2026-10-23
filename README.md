# wsl-shadow

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

## Use

```bash
wsl-shadow                 # report
wsl-shadow --json          # schemaVersion 1, for agents and CI
wsl-shadow --fix           # prints proposals, changes nothing, runs nothing
wsl-shadow --view=exec     # interactive, login, exec, exec-zsh, here
wsl-shadow --require=node,npm
```

Exit `0` when every measured tool is fine. Exit `1` on `shadow`, `windows-only` or `unreachable`. Exit `2` when a tool named in `--require` is missing. `cursor` and `code` are expected to be Windows and do not affect the exit code.

| Status | Meaning |
|---|---|
| `ok` | every measured view resolves to Linux |
| `shadow` | a Linux build exists, and a view gets Windows |
| `windows-only` | a view gets Windows, and no Linux build exists |
| `unreachable` | a Linux build exists, and a view finds nothing |
| `missing` | nowhere |
| `unmeasured` | that view could not be run; the tool does not guess |

From a clone, until this is on npm:

```bash
bun run build        # dist/cli.js, Node 18+
bun run build:bin    # dist/wsl-shadow-linux-x64 and dist/wsl-shadow-linux-arm64
```

`bunx` and `npx` inside WSL can be the Windows Bun or npm. Run the binary, or `node dist/cli.js`.

## What `--fix` reaches

Each proposal names the views it fixes and the views it leaves broken.

| Proposal | `login` | `exec` |
|---|---|---|
| PATH block in the login file bash actually reads | yes | no |
| PATH block in `~/.zshenv` | yes, on zsh | `zsh -c` only |
| Symlink in `/usr/local/bin` | yes | yes |
| `appendWindowsPath=false` | yes, for `shadow` | yes, for `shadow` |

`sh -c`, `bash -c`, `wsl.exe -e` and spawn read no startup file. A clean `login` row leaves those on Windows `npm`. For `exec`, the choices are the symlink or a PATH set in that harness's own config.

`appendWindowsPath=false` is printed last. It drops `code`, `explorer.exe` and `cmd.exe` from PATH by name. It does not fix `unreachable`: `node` stays missing, and `npm` goes from a Windows path to not found.

The tool only reads. It never writes a file, never runs `sudo`, never passes `-f` to `ln`, and skips a `/usr/local/bin` name that already exists. It does not edit `/etc/wsl.conf`, `.wslconfig`, the Windows PATH, `WSLENV`, or anything under `/mnt/<drive>/`. It does not install nvm, Node, Bun or `claude`.

A symlink to `~/.nvm/versions/node/v22.x/bin/npm` keeps serving v22 after `nvm alias default` moves on. Point it at `~/.nvm/current/bin/<tool>` (`NVM_SYMLINK_CURRENT=true`, then `nvm use default`). `--fix` does that when `current` exists, and says so when it does not. Run wsl-shadow again after changing the default Node.

`windows-only` on `claude` means Claude Code is installed on Windows and not in WSL. That is the machine, not a bug in this tool.

Not measured: WSL1, Alpine, which launch form each harness uses. Not built: an MCP config check, a library export, an arm64 run of the binary.

## For agents

Paste `AGENTS-SNIPPET.md` into `AGENTS.md`, or load `skill/wsl-shadow/SKILL.md`. Both say: run `wsl-shadow --json --view=here` before trusting `node`, `npm`, `bun` or `claude`, and do not edit shell rc files to make the report pass.

Anyone can use, change, and share this for a noncommercial purpose, including personal and hobby use. Selling it, or shipping it in a paid product, is not covered. That takes a separate license from the copyright holder.

Augusto Cerrutti · [github.com/kanchingyg](https://github.com/kanchingyg) · [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
