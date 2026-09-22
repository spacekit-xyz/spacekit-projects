#!/usr/bin/env python3
"""Generate freeform session training + sync pete_free_* fragments into pete_fragments_v2."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
FRAGMENTS_PATH = DATA / "pete_fragments_v2.jsonl"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pete_freeform_session import FREEFORM_FRAGMENTS, TRAINING_ROWS  # noqa: E402

SPECIFIC_INTENTS = {
    "mealtime_request",
    "mealtime_check",
    "feeding",
    "feeding_ack",
    "treat",
    "treat_offer",
    "food_preference",
    "storytelling",
    "arthurian_lore",
    "lore_qa",
    "lore_origin",
    "grounding_support",
    "school_stress",
    "emotional_support",
    "training_command",
    "trigger_warning",
    "separation_announcement",
    "separation_distress",
    "reunion_warm",
    "bedtime_routine",
    "gratitude_comfort",
    "gratitude_simple",
    "compliment",
    "play_invitation",
    "bonding_request",
    "hostile_meta",
    "social_pain",
}


def retag_open_ended(rows: list[dict]) -> tuple[list[dict], int]:
    """Strip open_ended_chat from auto fragments that have a specific primary intent."""
    changed = 0
    out: list[dict] = []
    for row in rows:
        fid = row.get("fragment_id", "")
        aff = row.get("intent_affinity") or []
        if fid.startswith("auto_") and "open_ended_chat" in aff:
            specific = [a for a in aff if a in SPECIFIC_INTENTS]
            if specific and "open_ended_chat" in aff:
                row = dict(row)
                row["intent_affinity"] = [a for a in aff if a != "open_ended_chat"]
                changed += 1
        out.append(row)
    return out, changed


def sync_fragments_v2(freeform_fragments: list[dict]) -> tuple[int, int, int]:
    kept: list[dict] = []
    if FRAGMENTS_PATH.exists():
        for line in FRAGMENTS_PATH.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            fid = row.get("fragment_id", "")
            if fid.startswith("pete_free_"):
                continue
            kept.append(row)

    kept, retag_count = retag_open_ended(kept)
    merged = kept + freeform_fragments
    with FRAGMENTS_PATH.open("w", encoding="utf-8") as f:
        for row in merged:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    return len(freeform_fragments), len(kept), retag_count


def main() -> None:
    frag_path = DATA / "pete_freeform_fragments_v1.jsonl"
    train_path = DATA / "pete_freeform_v1.jsonl"

    with frag_path.open("w", encoding="utf-8") as f:
        for row in FREEFORM_FRAGMENTS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with train_path.open("w", encoding="utf-8") as f:
        for row in TRAINING_ROWS:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    free_count, kept_count, retag_count = sync_fragments_v2(FREEFORM_FRAGMENTS)

    print(f"wrote {len(FREEFORM_FRAGMENTS)} fragments -> {frag_path.name}")
    print(f"wrote {len(TRAINING_ROWS)} training rows -> {train_path.name}")
    print(f"retagged {retag_count} auto fragments (stripped open_ended_chat)")
    print(f"synced {free_count} freeform fragments into {FRAGMENTS_PATH.name} ({kept_count} other rows kept)")


if __name__ == "__main__":
    main()
