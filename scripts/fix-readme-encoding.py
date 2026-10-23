# SPDX-License-Identifier: AGPL-3.0-only
"""Fix double-encoded UTF-8 (mojibake) in README.md. Run from repo root."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"

HERO = """```text
┌─ wsl ───────────────────────────────────────────────┐
│ alex@dev:~$ command -v npm                          │
│ /home/alex/.nvm/versions/node/v22.23.2/bin/npm      │
│                                                     │
│ agent (wsl.exe -e sh -c)                            │
│ /mnt/c/Program Files/nodejs/npm                     │
└─────────────────────────────────────────────────────┘
```"""


def main() -> None:
    raw = README.read_bytes()
    text = raw.decode("utf-8")
    fixed: str | None = None
    try:
        candidate = text.encode("latin1").decode("utf-8")
        if "┌" in candidate:
            fixed = candidate
            print("recovered via latin1 roundtrip")
    except (UnicodeEncodeError, UnicodeDecodeError) as err:
        print(f"latin1 roundtrip failed: {err}")

    if fixed is None:
        fixed, n = re.subn(r"```text\n.*?```", HERO, text, count=1, flags=re.S)
        fixed = fixed.replace("Augusto Cerrutti Â·", "Augusto Cerrutti ·")
        fixed = fixed.replace("Augusto Cerrutti Ã‚Â·", "Augusto Cerrutti ·")
        print(f"manual hero replace count={n}")

    # Normalize author separator if still mangled
    fixed = re.sub(r"Augusto Cerrutti\s+.+?\s+\[github", "Augusto Cerrutti · [github", fixed, count=1)
    README.write_text(fixed, encoding="utf-8", newline="\n")
    out = README.read_text(encoding="utf-8")
    bad = sum(out.count(x) for x in ("â€", "â”", "Ã", "Â·", "Â "))
    print(f"has_box={'┌' in out} mojibake={bad}")
    for line in out.splitlines()[:11]:
        print(line)
    for line in out.splitlines():
        if "Augusto" in line:
            print(line)


if __name__ == "__main__":
    main()
