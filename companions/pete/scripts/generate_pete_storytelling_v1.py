#!/usr/bin/env python3
"""Regenerate Arthurian lore storytelling training (canonical source)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    script = ROOT / "scripts" / "generate_pete_arthurian_lore_stories_v1.py"
    subprocess.run([sys.executable, str(script)], check=True)


if __name__ == "__main__":
    main()
