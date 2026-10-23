---
name: wsl-shadow
description: Check which node, npm, bun or claude an agent will run under WSL before installing or running anything. Use when working inside WSL and a tool is "not found", behaves oddly, or installs packages to a C:\ path.
---

# wsl-shadow

Under WSL, the Windows PATH is appended to every process. Version managers such as nvm only load in interactive shells, so an agent's shell can get the Windows `npm` while the user's terminal gets the Linux one.

## Steps

1. Run `wsl-shadow --json --view=here`.
2. Find the row for the tool you need. Ignore the rest; the exit code covers every tool.
3. Act on `status`:
   - `ok`: carry on.
   - `shadow` or `windows-only`: a Windows program is answering. Don't install globals. Tell the user, and quote `consequence` and the probe output (for example the npm prefix).
   - `unreachable`: a Linux build exists at `linuxCandidate` but this launch can't see it. Tell the user. Don't install another copy.
   - `unmeasured`: the check couldn't run. Say so; don't guess.
4. If the user wants a fix, run `wsl-shadow --fix` (a dry run) and show them the output. Say which views each proposal fixes and which it leaves broken.
5. You may suggest `wsl-shadow --apply` (typed confirmation, backups, reversible with `wsl-shadow --undo`). **Ask the user before running `--apply` or `--undo`, every time.** If they say yes, run it in their terminal so `sudo` can prompt them; never pass `--yes` yourself unless they tell you to.
6. Before starting long work in WSL, `wsl-shadow --preflight` is a one-lookup pass/fail for `node` and `npm` in the `exec` view; stdout is a PATH prefix you can prepend.

## Don't

- Don't edit `~/.profile`, `~/.zshenv`, `/usr/local/bin` or `/etc/wsl.conf` by hand, and don't run `sudo` yourself. Applying a fix is the user's decision, through `wsl-shadow --apply` after you ask.
- Don't install nvm, Node, Bun or `claude` to make the report pass.
- Don't treat a clean `login` view as proof that `wsl.exe -e` or spawn launches are fixed; they read no startup files. Only a link in `/usr/local/bin` reaches them.
