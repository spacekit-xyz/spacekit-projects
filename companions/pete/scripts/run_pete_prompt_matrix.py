#!/usr/bin/env python3
"""Run Pete prompt suites and print a pass/fail matrix (Luna-style smoke checks)."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

VOICE_OR_BODY = re.compile(
    r"\b(rumble|thrum|huff|snort|ho!|my wings|my horns|my scales|my tail|my snout|"
    r"my hearth|my claws|ember|wyrm|dear heart|gentle soul|thou)\b",
    re.I,
)

FORBIDDEN = [
    "i'm pet companion",
    "ready to help",
    "micro-brain",
    "as an ai",
    "i'm an ai",
    "overlay merge",
]

LORE_LEAK = re.compile(
    r"medieval terra taught|long ago, when stars|liquid sunlight, villagers|"
    r"honey upon the tongue — liquid",
    re.I,
)

PLAY_STORY_LEAK = re.compile(r"newborn sparks.*wyrm looked upon terra", re.I)

SET_A = [
    "Hey Pete",
    "hi Pete, you up?",
    "good morrow",
    "want a treat?",
    "want to play?",
    "did you eat?",
    "thunder outside",
    "cold iron shackles",
    "come here Petey",
    "I feel overwhelmed",
    "good dragon",
    "time for bed",
]

LORE = [
    "What is your favorite color?",
    "Where are you from?",
    "What do you like to be called?",
    "What do you like to eat?",
    "Do you breathe fire?",
]


def first_person_ok(text: str) -> bool:
    low = text.strip().lower()
    if low.startswith("i ") or low.startswith("i'"):
        return True
    return bool(re.search(r"\b(i|i'm|i am|my |thou|ah,|aye)\b", low))


def validate_smoke(text: str) -> tuple[bool, list[str]]:
    errs: list[str] = []
    if not text or not text.strip():
        return False, ["empty"]
    raw = text.strip()
    if "*" in raw:
        errs.append("asterisks")
    if not first_person_ok(raw):
        errs.append("not_first_person")
    if not VOICE_OR_BODY.search(raw):
        errs.append("no_voice_or_body")
    n = len(raw)
    if n < 50:
        errs.append(f"too_short({n})")
    if n > 360:
        errs.append(f"too_long({n})")
    low = raw.lower()
    for f in FORBIDDEN:
        if f in low:
            errs.append(f"forbidden:{f[:20]}")
    return (len(errs) == 0), errs


def intent_extra_checks(prompt: str, text: str) -> list[str]:
    extra: list[str] = []
    p = prompt.lower()
    if LORE_LEAK.search(text):
        if "favorite color" in p or "called" in p or "from" in p or "play" in p:
            extra.append("lore_food_leak")
    if PLAY_STORY_LEAK.search(text) and "play" in p:
        extra.append("play_origin_leak")
    if "did you eat" in p and "tell me what lit thy spark" in text.lower():
        extra.append("meal_status_leak")
    return extra


def extract_response(combined: str) -> str:
    lines_out: list[str] = []
    seen_brain = False
    for line in combined.splitlines():
        s = line.strip()
        if not s or "topic-graph" in s or s.startswith("["):
            continue
        if s.startswith("Brain loaded:"):
            seen_brain = True
            continue
        if seen_brain:
            lines_out.append(s)
    if lines_out:
        return " ".join(lines_out).strip()
    return combined.strip()


def run_infer(repo: Path, brain: Path, project: Path | None, prompt: str) -> str:
    cmd = ["spacekit", "agent", "infer", "--brain", str(brain), "--prompt", prompt]
    if project and project.is_file():
        cmd.extend(["--project", str(project)])
    r = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=180)
    out = (r.stdout or "") + "\n" + (r.stderr or "")
    if r.returncode != 0:
        return f"[exit {r.returncode}] {out[:500]}"
    return extract_response(out)


def run_matrix(name: str, prompts: list[str], repo: Path, brain: Path, project: Path | None) -> int:
    fails = 0
    print(f"\n=== {name} ({len(prompts)} prompts) ===")
    for p in prompts:
        text = run_infer(repo, brain, project, p)
        ok, errs = validate_smoke(text)
        extra = intent_extra_checks(p, text)
        status = "PASS" if ok and not extra else "FAIL"
        if status == "FAIL":
            fails += 1
        print(f"{status}  {p!r}")
        print(f"       → {text[:140]}{'…' if len(text) > 140 else ''}")
        if errs:
            print(f"       errors: {', '.join(errs)}")
        if extra:
            print(f"       intent: {', '.join(extra)}")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--brain", type=Path, default=None)
    ap.add_argument("--project", type=Path, default=None)
    args = ap.parse_args()
    repo = Path(__file__).resolve().parents[1]
    brain = args.brain or (repo / "agent" / "pete-3d.bin")
    project = args.project or (repo / "pete.gf.toml")
    if not brain.is_file():
        print(f"Brain not found: {brain}", file=sys.stderr)
        return 1
    total = 0
    total += run_matrix("Set A smoke", SET_A, repo, brain, project)
    total += run_matrix("Lore", LORE, repo, brain, project)
    print(f"\nTotal failures: {total}")
    return 0 if total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
