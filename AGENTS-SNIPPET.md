## WSL: check which tools you will really run

When you run inside WSL, `node`, `npm`, `bun` and `claude` may resolve to Windows programs under `/mnt/c/` even if the user's terminal shows Linux ones. Before you rely on them, or before `npm i -g` anything, run:

```bash
wsl-shadow --json --view=here
```

- Read the row for the tool you need. Ignore rows for tools the task doesn't use; the exit code covers all of them.
- `shadow` or `windows-only` on that row means a Windows program is answering. Stop and tell the user. Don't install globals.
- `unreachable` means a Linux build exists but your launch can't see it. Tell the user; don't install a second copy.
- Don't edit `~/.profile`, `/usr/local/bin` or `/etc/wsl.conf` to fix it. `wsl-shadow --fix` prints proposals for the user to apply.
