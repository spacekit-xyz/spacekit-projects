#!/usr/bin/env python3
"""Regenerate authentic Japanese lore stories (canonical source for storytelling training)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    script = ROOT / "scripts" / "generate_kitsu_japanese_lore_stories_v1.py"
    subprocess.run([sys.executable, str(script)], check=True)


if __name__ == "__main__":
    main()
