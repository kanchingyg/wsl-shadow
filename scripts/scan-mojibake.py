# SPDX-License-Identifier: AGPL-3.0-only
"""Scan text files for known mojibake byte patterns. ASCII-only source."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"node_modules", "dist", ".bun-cache", ".git"}
SKIP_FILES = {
    "INVESTIGACION-WSL.md",
    "LIMITES-Y-CHECKS.md",
    "HANDOFF-CURSOR.md",
    "scan-mojibake.py",
    "fix-readme-encoding.py",
}
# UTF-8 encodings of common mojibake strings (UTF-8 misread as latin1, then re-encoded).
# "a circumflex + dagger" etc. — patterns from corrupted box-drawing / arrows.
PATTERNS = [
    bytes([0xC3, 0xA2, 0xC2, 0x80, 0xC2, 0x9C]),  # corrupted box top-left start
    bytes([0xC3, 0xA2, 0xE2, 0x80, 0xA0, 0xE2, 0x80, 0x99]),  # corrupted arrow
    bytes([0xC3, 0x82, 0xC2, 0xB7]),  # corrupted middle-dot
]


def main() -> None:
    hits = 0
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name in SKIP_FILES:
            continue
        if path.suffix.lower() not in {".md", ".ts", ".json", ".yml", ".yaml"} and path.name != "LICENSE":
            continue
        data = path.read_bytes()
        if any(p in data for p in PATTERNS):
            hits += 1
            print(path.relative_to(ROOT))
    print(f"files_with_mojibake={hits}")


if __name__ == "__main__":
    main()
