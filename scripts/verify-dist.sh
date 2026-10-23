#!/usr/bin/env bash
# Runs the built artifacts the way a user without Bun would. Read-only.
# Copies the binary to /tmp first: running executables straight off /mnt/c is slower and not representative.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
cp "$here/dist/wsl-shadow-linux-x64" /tmp/wsl-shadow-bin && chmod +x /tmp/wsl-shadow-bin

echo "### node dist/cli.js (node: $(node --version))"
node "$here/dist/cli.js" --view=interactive,login,exec | head -12
echo "exit=${PIPESTATUS[0]}"

echo
echo "### compiled binary, empty PATH (no bun, no node, no npm)"
env -i HOME="$HOME" WSL_DISTRO_NAME="$WSL_DISTRO_NAME" PATH=/usr/bin:/bin /tmp/wsl-shadow-bin --view=interactive,exec | head -12
echo "exit=${PIPESTATUS[0]}"

echo
echo "### binary --json keys"
/tmp/wsl-shadow-bin --json --view=exec | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["schemaVersion"], sorted(d.keys()))'

rm -f /tmp/wsl-shadow-bin

echo
echo "### library import (node, ESM)"
node --input-type=module -e "import * as m from '$here/dist/index.js'; console.log(Object.keys(m).sort().join(','))"

echo
echo "### binary --preflight (stdout = PATH prefix, stderr = reasons)"
cp "$here/dist/wsl-shadow-linux-x64" /tmp/wsl-shadow-bin && chmod +x /tmp/wsl-shadow-bin
env -i HOME="$HOME" WSL_DISTRO_NAME="$WSL_DISTRO_NAME" PATH=/usr/bin:/bin /tmp/wsl-shadow-bin --preflight --require=node,npm
echo "exit=$?"
rm -f /tmp/wsl-shadow-bin