#!/usr/bin/env python3
"""Validate pete_seed_v2.jsonl against Pete v2 corpus spec."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

PETE_OCEAN = {"O": 0.85, "C": 0.6, "E": 0.5, "A": 0.85, "N": 0.25}

INTENT_TARGETS = {
    "greeting_check_in": 25,
    "mealtime_request": 20,
    "bonding_request": 20,
    "play_invitation": 18,
    "trigger_warning": 18,
    "training_command": 18,
    "curiosity_share": 16,
    "playful_attention_seeking": 16,
    "emotional_support": 15,
    "status_check": 15,
    "reunion_warm": 12,
    "reassurance_seeking": 12,
    "treat_offer": 10,
    "bedtime_routine": 10,
    "separation_announcement": 10,
    "simple_acknowledgment": 5,
}

INTENT_TARGETS_FILE = dict(INTENT_TARGETS)
INTENT_TARGETS_FILE["trigger_warning"] = 24
INTENT_TARGETS_FILE["training_command"] = 22

FORBIDDEN_SUBSTRINGS = [
    "i am dying", "as an ai", "i'm pet companion", "pet companion",
    "ready to help", "micro-brain", "for dogs, cats", "i cannot",
    "i can't help", "don't have the ability", "luna", "siamese cat",
]


def load_grounding_ids(grounding_path: Path) -> set[str]:
    text = grounding_path.read_text(encoding="utf-8")
    return set(re.findall(r'^id = "([^"]+)"', text, flags=re.MULTILINE))


def validate_one(example: dict, grounding_ids: set[str]) -> tuple[bool, list[str]]:
    errs: list[str] = []
    r = example.get("expected_response", "")
    if not isinstance(r, str):
        return False, ["expected_response not a string"]
    if "*" in r:
        errs.append("no_asterisks")
    low = r.lower()
    for bad in FORBIDDEN_SUBSTRINGS:
        if bad in low:
            errs.append(f"forbidden:{bad}")
    third = [
        "pete walks", "pete sits", "pete comes", "pete looks",
        " she walks", " she purrs", "the cat ", "the dragon walks",
    ]
    if any(t in low for t in third):
        errs.append("no_third_person")
    vocals = ("rumble", "thrum", "huff", "ember", "growl", "snort", "hum")
    body = ("my wing", "my scale", "my claw", "my breath", "my horn", "my snout", "my hearth", "my tail")
    medieval = ("thou ", "thee ", "thy ", "worry not", "gentle soul", "dear heart")
    has_signal = any(v in low for v in vocals) or any(b in low for b in body) or any(m in low for m in medieval)
    if not has_signal:
        errs.append("has_pet_signal")
    if len(r) < 60 or len(r) > 320:
        errs.append("length_ok")
    pet = example.get("pet") or {}
    if pet.get("pet_id") != "pete":
        errs.append("pet_id_pete")
    if pet.get("ocean") != PETE_OCEAN:
        errs.append("ocean_stable")
    st = pet.get("state") or {}
    for k in ("hunger", "energy", "mood"):
        v = st.get(k)
        if not isinstance(v, (int, float)) or not (0.0 <= float(v) <= 1.0):
            errs.append(f"state_bounded:{k}")
    for a in pet.get("graph_anchors") or []:
        if a not in grounding_ids:
            errs.append(f"anchor_invalid:{a}")
    return len(errs) == 0, errs


def hunger_energy_cell(h: float, e: float) -> tuple[int, int]:
    hb = min(3, int(h * 4)) if h < 1.0 else 3
    eb = min(3, int(e * 4)) if e < 1.0 else 3
    return hb, eb


def corpus_checks(examples: list[dict], grounding_ids: set[str]) -> list[str]:
    problems: list[str] = []
    n = len(examples)
    if n < 240 or n > 260:
        problems.append(f"count {n} not in 240-260")
    pet_ids = {e.get("pet", {}).get("pet_id") for e in examples}
    if pet_ids != {"pete"}:
        problems.append(f"pet_id set {pet_ids}")
    dist = Counter(e["semantic_intent"] for e in examples)
    for intent, target in INTENT_TARGETS_FILE.items():
        got = dist.get(intent, 0)
        if abs(got - target) / max(target, 1) > 0.22:
            problems.append(f"intent_off:{intent} got={got} target={target}")
    cells: Counter[tuple[int, int]] = Counter()
    low_mood = high_mood = proactive = with_hist = 0
    for e in examples:
        st = e["pet"]["state"]
        cells[hunger_energy_cell(float(st["hunger"]), float(st["energy"]))] += 1
        m = float(st["mood"])
        if m <= 0.4:
            low_mood += 1
        if m >= 0.95:
            high_mood += 1
        if (e.get("pet") or {}).get("proactive_pete") is True:
            proactive += 1
        if e["pet"].get("history"):
            with_hist += 1
    for cell, c in cells.items():
        if c < 10:
            problems.append(f"cell_under:{cell} count={c}")
    if low_mood < 30:
        problems.append(f"low_mood:{low_mood}<30")
    if high_mood < 20:
        problems.append(f"high_mood:{high_mood}<20")
    if proactive < 70:
        problems.append(f"proactive:{proactive}<70")
    if with_hist < 25:
        problems.append(f"history:{with_hist}<25")
    for i, e in enumerate(examples):
        ok, errs = validate_one(e, grounding_ids)
        if not ok:
            problems.append(f"row_{i+1}:{','.join(errs)}")
    return problems


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    data = repo / "data"
    path = data / "pete_seed_v2.jsonl"
    grounding = data / "pet_world_grounding.toml"
    if not path.exists():
        print(f"Missing {path}", file=sys.stderr)
        return 1
    gids = load_grounding_ids(grounding)
    examples = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    problems = corpus_checks(examples, gids)
    if problems:
        print("FAIL", len(problems), "issues")
        for p in problems[:80]:
            print(" ", p)
        return 1
    print("OK", len(examples), "examples pass corpus + row validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
