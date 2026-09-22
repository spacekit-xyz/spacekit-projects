#!/usr/bin/env python3
"""Build train/eval JSONL for the Cairn link-suggest growformer brain."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

CORPUS: list[dict[str, str]] = [
    {"title": "Cairn Architecture", "content": "Spec draft: narrow agents (tagger, summarizer, linker) backed by micro-brains."},
    {"title": "WordNet Training", "content": "Research notes on WordNet ego-network extraction and sharded growformer training."},
    {"title": "Auto-Tag Integration", "content": "TODO: wire spacekit agent infer into Cairn tagger adapter instead of mock heuristics."},
    {"title": "Lookup Graph Fallback", "content": "Architecture sketch — lookup_graph fast path for single-token wordnet queries."},
    {"title": "Daily Journal", "content": "Daily journal — tired but finished the wordnet lookup graph fallback path."},
    {"title": "Design Wiki Links", "content": "Meeting with design on [[Cairn]] wiki links — need auto-tag before publish."},
    {"title": "Linker Feature Idea", "content": "Feature idea: suggest links between notes using token overlap + growformer ranker."},
    {"title": "Performance Bug", "content": "Bug: infer reloads full brain every CLI call; use agent load for warm path."},
    {"title": "Sprint Roadmap", "content": "Sprint planning — prioritize summarizer brain after tagger ships."},
    {"title": "Security Review", "content": "Security review — ensure infer with local brain skips storage node when entitled."},
    {"title": "Client Export", "content": "Client call recap — they want export to markdown with preserved [[wiki-links]]."},
    {"title": "Interview Prep", "content": "Interview prep — system design for note graphs, backlinks, and semantic search."},
    {"title": "Training Retro", "content": "Retro: batch train.sh doesn't resume; document manual shard merge steps."},
    {"title": "Micro-Brain Blog", "content": "Published blog post on building micro-brains instead of calling external LLM APIs."},
    {"title": "Welcome to Cairn", "content": "This notes app runs on the Spacekit network with narrow agents for tag, summarize, and links."},
]

# (active note content, related titles in corpus)
LINK_SAMPLES: list[tuple[str, list[str]]] = [
    (
        "Research notes on WordNet ego-network extraction and sharded growformer training.",
        ["Lookup Graph Fallback", "Training Retro", "WordNet Training"],
    ),
    (
        "TODO: wire spacekit agent infer into Cairn tagger adapter instead of mock heuristics.",
        ["Auto-Tag Integration", "Cairn Architecture", "Sprint Roadmap"],
    ),
    (
        "Spec draft: narrow agents (tagger, summarizer, linker) backed by micro-brains.",
        ["Cairn Architecture", "Linker Feature Idea", "Auto-Tag Integration"],
    ),
    (
        "Meeting with design on [[Cairn]] wiki links — need auto-tag before publish.",
        ["Design Wiki Links", "Client Export", "Cairn Architecture"],
    ),
    (
        "Feature idea: suggest links between notes using token overlap + growformer ranker.",
        ["Linker Feature Idea", "Cairn Architecture", "Interview Prep"],
    ),
    (
        "Daily journal — tired but finished the wordnet lookup graph fallback path.",
        ["Daily Journal", "Lookup Graph Fallback", "WordNet Training"],
    ),
    (
        "Bug: infer reloads full brain every CLI call; use agent load for warm path.",
        ["Performance Bug", "Auto-Tag Integration", "Security Review"],
    ),
    (
        "Sprint planning — prioritize summarizer brain after tagger ships.",
        ["Sprint Roadmap", "Cairn Architecture", "Auto-Tag Integration"],
    ),
    (
        "Interview prep — system design for note graphs, backlinks, and semantic search.",
        ["Interview Prep", "Linker Feature Idea", "Cairn Architecture"],
    ),
    (
        "Retro: batch train.sh doesn't resume; document manual shard merge steps.",
        ["Training Retro", "WordNet Training", "Lookup Graph Fallback"],
    ),
    (
        "Security review — ensure infer with local brain skips storage node when entitled.",
        ["Security Review", "Performance Bug", "Auto-Tag Integration"],
    ),
    (
        "Client call recap — they want export to markdown with preserved [[wiki-links]].",
        ["Client Export", "Design Wiki Links", "Welcome to Cairn"],
    ),
    (
        "Published blog post on building micro-brains instead of calling external LLM APIs.",
        ["Micro-Brain Blog", "Cairn Architecture", "WordNet Training"],
    ),
    (
        "Architecture sketch — lookup_graph fast path for single-token wordnet queries.",
        ["Lookup Graph Fallback", "WordNet Training", "Training Retro"],
    ),
    (
        "This notes app runs on the Spacekit network with narrow agents for tag, summarize, and links.",
        ["Welcome to Cairn", "Cairn Architecture", "Linker Feature Idea"],
    ),
]


def corpus_block() -> str:
    lines = ["Available notes:"]
    for note in CORPUS:
        lines.append(f"- {note['title']}: {note['content']}")
    return "\n".join(lines)


def titles_json(titles: list[str]) -> str:
    return json.dumps(titles, ensure_ascii=False, separators=(",", ":"))


def in_eval(text: str) -> bool:
    return int(hashlib.sha256(text.encode()).hexdigest(), 16) % 5 == 0


def row(task_id: str, prompt: str, titles: list[str]) -> dict:
    return {
        "task_id": task_id,
        "text": prompt,
        "semantic_intent": "link_suggest",
        "domain": "cairn",
        "action_target": "link_suggest",
        "policy_regime": "default",
        "language_channel": "english",
        "expected_response": titles_json(titles),
        "expected_code": None,
    }


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main() -> None:
    block = corpus_block()
    train_rows: list[dict] = []
    eval_rows: list[dict] = []
    idx = 0

    for content, related in LINK_SAMPLES:
        prompt = f"suggest links for:\n{content}\n\n{block}"
        base = row(f"lk_{idx:04d}", prompt, related)
        if in_eval(content):
            eval_rows.append(base)
        else:
            train_rows.append(base)
        idx += 1

        variant = row(
            f"lk_{idx:04d}_v1",
            f"related notes for:\n{content}\n\n{block}",
            related,
        )
        train_rows.append(variant)
        idx += 1

    write_jsonl(DATA / "train_linker.jsonl", train_rows)
    write_jsonl(DATA / "eval_linker.jsonl", eval_rows)

    print(f"Wrote {len(train_rows)} train + {len(eval_rows)} eval rows → {DATA}", file=sys.stderr)


if __name__ == "__main__":
    main()
