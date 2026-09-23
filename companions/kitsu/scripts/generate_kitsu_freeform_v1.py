#!/usr/bin/env python3
"""Generate freeform session training + sync kitsu_free_* fragments into kitsu_fragments_v2."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
FRAGMENTS_PATH = DATA / "kitsu_fragments_v2.jsonl"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitsu_freeform_session import FREEFORM_FRAGMENTS, TRAINING_ROWS  # noqa: E402


def sync_fragments_v2(freeform_fragments: list[dict]) -> tuple[int, int]:
    kept: list[dict] = []
    if FRAGMENTS_PATH.exists():
        for line in FRAGMENTS_PATH.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            fid = row.get("fragment_id", "")
            if fid.startswith("kitsu_free_"):
                continue
            kept.append(row)

    merged = kept + freeform_fragments
    with FRAGMENTS_PATH.open("w", encoding="utf-8") as f:
        for row in merged:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    return len(freeform_fragments), len(kept)


def main() -> None:
    frag_path = DATA / "kitsu_freeform_fragments_v1.jsonl"
    train_path = DATA / "kitsu_freeform_v1.jsonl"

    with frag_path.open("w", encoding="utf-8") as f:
        for row in FREEFORM_FRAGMENTS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with train_path.open("w", encoding="utf-8") as f:
        for row in TRAINING_ROWS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    free_count, kept_count = sync_fragments_v2(FREEFORM_FRAGMENTS)

    print(f"wrote {len(FREEFORM_FRAGMENTS)} fragments -> {frag_path.name}")
    print(f"wrote {len(TRAINING_ROWS)} training rows -> {train_path.name}")
    print(f"synced {free_count} freeform fragments into {FRAGMENTS_PATH.name} ({kept_count} other rows kept)")


if __name__ == "__main__":
    main()
