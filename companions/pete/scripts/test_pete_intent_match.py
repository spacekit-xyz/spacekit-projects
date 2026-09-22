#!/usr/bin/env python3
"""Quick local check: which fragment_compose intent rule wins for a prompt."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOML = ROOT / "data" / "inference_pets.toml"

PROMPTS = [
    "who are you?",
    "what do you like to be called",
    "I feel sad",
    "I feel overwhelmed",
    "bad dragon",
    "tell me a story",
    "bad dragon",
]


def parse_rules(text: str) -> list[dict]:
    rules: list[dict] = []
    blocks = re.split(r"\n\[\[fragment_compose\.intent_rules\]\]\n", text)
    for block in blocks[1:]:
        rid = re.search(r'^id = "([^"]+)"', block, re.M)
        intent = re.search(r'^intent = "([^"]+)"', block, re.M)
        match = re.search(r'^match = "([^"]+)"', block, re.M)
        if not (rid and intent and match):
            continue
        patterns = re.findall(r'^\s*"([^"]*)",?\s*$', block, re.M)
        # patterns live inside patterns = [ ... ] after match line
        pat_block = re.search(r"patterns = \[([\s\S]*?)\]", block)
        pats = []
        if pat_block:
            pats = re.findall(r'"([^"]*)"', pat_block.group(1))
        rules.append(
            {
                "id": rid.group(1),
                "intent": intent.group(1),
                "match": match.group(1),
                "patterns": pats,
            }
        )
    return rules


def rule_matches(prompt: str, rule: dict) -> bool:
    lower = prompt.lower()
    kind = rule["match"]
    if kind == "fallback":
        return True
    if kind == "contains_any":
        return any(p.lower() in lower for p in rule["patterns"])
    if kind == "starts_with_any":
        return any(lower.startswith(p.lower()) for p in rule["patterns"])
    return False


def main() -> None:
    text = TOML.read_text(encoding="utf-8")
    rules = parse_rules(text)
    prompts = sys.argv[1:] or PROMPTS
    for prompt in prompts:
        winner = None
        for rule in rules:
            if rule_matches(prompt, rule):
                winner = rule
                break
        print(f"{prompt!r} -> {winner['id'] if winner else '?'} / {winner['intent'] if winner else '?'}")


if __name__ == "__main__":
    main()
