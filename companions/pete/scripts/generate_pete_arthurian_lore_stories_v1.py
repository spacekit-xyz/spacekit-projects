#!/usr/bin/env python3
"""Generate authentic Arthurian lore stories and sync into pete_fragments_v2.jsonl."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
FRAGMENTS_PATH = DATA / "pete_fragments_v2.jsonl"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pete_arthurian_lore_stories import (  # noqa: E402
    ARTHURIAN_STORY_FRAGMENTS,
    ARTHURIAN_TRAINING_ROWS,
)


def sync_fragments_v2(story_fragments: list[dict]) -> tuple[int, int]:
    kept: list[dict] = []
    if FRAGMENTS_PATH.exists():
        for line in FRAGMENTS_PATH.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("fragment_id", "").startswith("pete_story_"):
                continue
            kept.append(row)

    merged = kept + story_fragments
    with FRAGMENTS_PATH.open("w", encoding="utf-8") as f:
        for row in merged:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    return len(story_fragments), len(kept)


def main() -> None:
    frag_path = DATA / "pete_arthurian_lore_stories_fragments_v1.jsonl"
    train_path = DATA / "pete_arthurian_lore_stories_v1.jsonl"

    with frag_path.open("w", encoding="utf-8") as f:
        for row in ARTHURIAN_STORY_FRAGMENTS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with train_path.open("w", encoding="utf-8") as f:
        for row in ARTHURIAN_TRAINING_ROWS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    story_count, kept_count = sync_fragments_v2(ARTHURIAN_STORY_FRAGMENTS)

    print(f"wrote {len(ARTHURIAN_STORY_FRAGMENTS)} fragments -> {frag_path.name}")
    print(f"wrote {len(ARTHURIAN_TRAINING_ROWS)} training rows -> {train_path.name}")
    print(f"synced {story_count} story fragments into {FRAGMENTS_PATH.name} ({kept_count} non-story rows kept)")


if __name__ == "__main__":
    main()
