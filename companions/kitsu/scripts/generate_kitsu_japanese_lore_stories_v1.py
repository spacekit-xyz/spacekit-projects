#!/usr/bin/env python3
"""Generate authentic Japanese lore story training + sync story fragments into kitsu_fragments_v2."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
FRAGMENTS_PATH = DATA / "kitsu_fragments_v2.jsonl"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitsu_japanese_lore_stories import LORE_STORY_FRAGMENTS, LORE_TRAINING_ROWS  # noqa: E402


def sync_fragments_v2(story_fragments: list[dict]) -> tuple[int, int]:
    """Replace all kitsu_story_* rows in kitsu_fragments_v2.jsonl with canonical lore set."""
    story_ids = {row["fragment_id"] for row in story_fragments}
    kept: list[dict] = []

    if FRAGMENTS_PATH.exists():
        for line in FRAGMENTS_PATH.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            fid = row.get("fragment_id", "")
            if fid.startswith("kitsu_story_"):
                continue
            kept.append(row)

    merged = kept + story_fragments
    with FRAGMENTS_PATH.open("w", encoding="utf-8") as f:
        for row in merged:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    return len(story_fragments), len(kept)


def main() -> None:
    frag_path = DATA / "kitsu_japanese_lore_stories_fragments_v1.jsonl"
    train_path = DATA / "kitsu_japanese_lore_stories_v1.jsonl"

    with frag_path.open("w", encoding="utf-8") as f:
        for row in LORE_STORY_FRAGMENTS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with train_path.open("w", encoding="utf-8") as f:
        for row in LORE_TRAINING_ROWS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    story_count, kept_count = sync_fragments_v2(LORE_STORY_FRAGMENTS)

    print(f"wrote {len(LORE_STORY_FRAGMENTS)} lore fragments -> {frag_path.name}")
    print(f"wrote {len(LORE_TRAINING_ROWS)} training rows -> {train_path.name}")
    print(f"synced {story_count} story fragments into {FRAGMENTS_PATH.name} ({kept_count} non-story rows kept)")


if __name__ == "__main__":
    main()
