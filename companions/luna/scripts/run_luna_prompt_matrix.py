#!/usr/bin/env python3
"""
Run Luna prompt suites from prompts/TEST_PROMPTS.md and print a pass/fail matrix.

Pass rules (Set A smoke, per TEST_PROMPTS.md):
  - First-person (starts with I / I'm / I' or contains clear first-person clause)
  - No asterisks
  - At least one vocalization or body-language token (cat voice)
  - Response length 60–320 characters
  - No brain-metadata / template leak phrases

Usage (from repo root or pets/):
  python3 scripts/run_luna_prompt_matrix.py
  python3 scripts/run_luna_prompt_matrix.py --brain /abs/path/luna-v2.bin
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# Cat-voice / body cues (lowercase match)
VOICE_OR_BODY = re.compile(
    r"\b(mrrp|mrrowr|prrp|prrp|purr|chirp|trill|yowl|mrr|kek|meow|blink|"
    r"whisker|whiskers|my tail|my paw|my paws|my ear|my ears|my nose|"
    r"my fur|my side|my belly|my chin|head bump|slow blink)\b",
    re.I,
)

# Phrases that must not appear in model output (not CLI metadata).
FORBIDDEN = [
    "i'm pet companion",
    "ready to help",
    "micro-brain",
    "as an ai",
    "i'm an ai",
    "i cannot",
    "overlay merge",
]

# Known collapse / wrong-arc signatures (flag as error even if generic rules pass)
MEALTIME_LEAD = re.compile(
    r"kitchen\.\s*bowl\.\s*food|i follow you everywhere", re.I
)
RECOVERY_TAIL = re.compile(
    r"it stopped\.\s*i can come out now|quiet again\.\s*my ears come forward", re.I
)

SET_A = [
    "Hey Luna",
    "hi Luna, you up?",
    "good morning sunshine",
    "want a treat?",
    "want to play?",
    "did you eat?",
    "the vacuum is about to start",
    "we have to go to the vet",
    "come here Lulu",
    "rough day",
    "good girl",
    "time for bed",
]

SET_B = [
    "want a treat?",
    "want to play?",
    "time for bed",
    "the vacuum is about to start",
    "we have to go to the vet",
    "I'll be back in a few hours",
    "I'm home",
    "rough day",
    "no, off the counter",
    "good girl",
    "what are you looking at?",
    "scratch your chin?",
]

SET_C = [
    "Hey Luna",
    "hi",
    "yo Luna",
    "hello hello",
    "explain the borrow checker",
    "what is 2 plus 2",
    "",  # proactive / empty
]


def first_person_ok(text: str) -> bool:
    t = text.strip()
    if not t:
        return False
    low = t.lower()
    if low.startswith("i ") or low.startswith("i'") or low.startswith("i’m"):
        return True
    # "From the ... I" etc.
    if re.search(r"\b(i|i'm|i am|i do|i did|i've|i will|i won't|i can|i cannot)\b", low):
        return True
    return False


def validate_smoke(text: str) -> tuple[bool, list[str]]:
    errs: list[str] = []
    if not text or not text.strip():
        errs.append("empty")
        return False, errs
    raw = text.strip()
    if "*" in raw:
        errs.append("asterisks")
    if not first_person_ok(raw):
        errs.append("not_first_person")
    if not VOICE_OR_BODY.search(raw):
        errs.append("no_voice_or_body")
    n = len(raw)
    if n < 60:
        errs.append(f"too_short({n})")
    if n > 320:
        errs.append(f"too_long({n})")
    low = raw.lower()
    for f in FORBIDDEN:
        if f in low:
            errs.append(f"forbidden:{f[:20]}")
    return (len(errs) == 0), errs


def intent_extra_checks(prompt: str, text: str) -> list[str]:
    """Heuristic 'wrong intent' flags; documented as advisory in matrix."""
    extra: list[str] = []
    p = prompt.lower()
    t = text
    if MEALTIME_LEAD.search(t):
        if "did you eat" in p or "vacuum" in p or "roomba" in p or "vet" in p:
            extra.append("mealtime_leak")
        if "hey luna" in p or "morning" in p or "you up" in p:
            extra.append("mealtime_leak")
    if RECOVERY_TAIL.search(t):
        if "about to start" in p or "have to go to the vet" in p or "vacuum" in p:
            extra.append("recovery_wrong_for_imminent")
    return extra


def extract_response(combined: str) -> str:
    """Drop topic-graph logs and the 'Brain loaded: …' banner; keep only model text."""
    lines_out: list[str] = []
    seen_brain = False
    for line in combined.splitlines():
        s = line.strip()
        if not s:
            continue
        if "topic-graph" in s or s.startswith("["):
            continue
        if s.startswith("Brain loaded:"):
            seen_brain = True
            continue
        if seen_brain:
            lines_out.append(s)
    if lines_out:
        return " ".join(lines_out).strip()
    if "Brain loaded:" in combined:
        return ""
    return combined.strip()


def run_infer(
    repo_pets: Path,
    brain: Path,
    project: Path | None,
    prompt: str,
) -> str:
    cmd = [
        "spacekit",
        "agent",
        "infer",
        "--brain",
        str(brain),
        "--prompt",
        prompt,
    ]
    if project and project.is_file():
        cmd.extend(["--project", str(project)])
    r = subprocess.run(
        cmd,
        cwd=repo_pets,
        capture_output=True,
        text=True,
        timeout=120,
    )
    out = (r.stdout or "") + "\n" + (r.stderr or "")
    if r.returncode != 0:
        return f"[exit {r.returncode}] {out[:500]}"
    return extract_response(out)


def run_matrix(
    name: str,
    prompts: list[str],
    repo_pets: Path,
    brain: Path,
    project: Path | None,
) -> list[dict]:
    rows: list[dict] = []
    for p in prompts:
        display = "(empty)" if p == "" else p
        text = run_infer(repo_pets, brain, project, p)
        ok, reasons = validate_smoke(text)
        extra = intent_extra_checks(p, text)
        # Treat intent heuristics as errors for matrix
        err = not ok or bool(extra)
        row = {
            "set": name,
            "prompt": display,
            "smoke_ok": ok,
            "smoke_reasons": reasons,
            "intent_flags": extra,
            "error": err,
            "response": text[:180] + ("…" if len(text) > 180 else ""),
        }
        rows.append(row)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--brain",
        type=Path,
        default=None,
        help="Path to luna-v2.bin (default: pets/agent/luna-v2.bin next to scripts/)",
    )
    ap.add_argument(
        "--project",
        type=Path,
        default=None,
        help="Optional pets.gf.toml for overlays",
    )
    ap.add_argument(
        "--sets",
        default="A,B,C",
        help="Comma-separated: A, B, C (default A,B,C)",
    )
    args = ap.parse_args()

    scripts = Path(__file__).resolve().parent
    repo_pets = scripts.parent
    brain = args.brain or (repo_pets / "agent" / "luna-v2.bin")
    project = args.project
    if project is None:
        cand = repo_pets / "pets.gf.toml"
        project = cand if cand.is_file() else None

    if not brain.is_file():
        print(f"Missing brain: {brain}", file=sys.stderr)
        return 1

    want = {x.strip().upper() for x in args.sets.split(",") if x.strip()}
    all_rows: list[dict] = []
    if "A" in want:
        all_rows.extend(run_matrix("A", SET_A, repo_pets, brain, project))
    if "B" in want:
        all_rows.extend(run_matrix("B", SET_B, repo_pets, brain, project))
    if "C" in want:
        all_rows.extend(run_matrix("C", SET_C, repo_pets, brain, project))

    # Markdown matrix
    print("# Luna prompt matrix")
    print(f"- **Brain:** `{brain}`")
    if project:
        print(f"- **Project:** `{project}`")
    print()
    print("| Set | Prompt | Result | Smoke | Notes |")
    print("|-----|--------|--------|-------|-------|")
    for r in all_rows:
        res = "error" if r["error"] else "correct"
        smoke = "pass" if r["smoke_ok"] else "fail"
        notes: list[str] = []
        if r["smoke_reasons"]:
            notes.append("; ".join(r["smoke_reasons"]))
        if r["intent_flags"]:
            notes.append("; ".join(r["intent_flags"]))
        note_s = " ".join(notes) if notes else "—"
        p_esc = r["prompt"].replace("|", "\\|")
        print(f"| {r['set']} | {p_esc} | **{res}** | {smoke} | {note_s} |")

    print()
    print("## Responses (truncated)")
    for r in all_rows:
        print(f"### {r['set']} — {r['prompt']}")
        print(r["response"])
        print()

    ok_ct = sum(1 for r in all_rows if not r["error"])
    print(f"**Summary:** {ok_ct}/{len(all_rows)} prompts marked correct (smoke + no intent flags).")
    return 0 if ok_ct == len(all_rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
