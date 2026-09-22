#!/usr/bin/env python3
"""Build train/eval JSONL for the Cairn auto-tag growformer brain."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# (note_text, tags) — tags are lowercase, 3–6 items, Cairn/wiki note vocabulary.
SAMPLES: list[tuple[str, list[str]]] = [
    (
        "Meeting with design on [[Cairn]] wiki links — need auto-tag before publish.",
        ["meeting", "design", "cairn", "wiki", "planning"],
    ),
    (
        "Research notes on WordNet ego-network extraction and sharded growformer training.",
        ["research", "wordnet", "graph", "growformer", "training"],
    ),
    (
        "TODO: wire spacekit agent infer into Cairn tagger adapter instead of mock heuristics.",
        ["todo", "cairn", "spacekit", "growformer", "integration"],
    ),
    (
        "Daily journal — tired but finished the wordnet lookup graph fallback path.",
        ["journal", "personal", "wordnet", "progress"],
    ),
    (
        "Spec draft: narrow agents (tagger, summarizer, linker) backed by micro-brains.",
        ["spec", "cairn", "architecture", "agents", "draft"],
    ),
    (
        "Bug: infer reloads full brain every CLI call; use agent load for warm path.",
        ["bug", "spacekit", "performance", "growformer"],
    ),
    (
        "Interview prep — system design for note graphs, backlinks, and semantic search.",
        ["interview", "design", "graph", "search", "learning"],
    ),
    (
        "Retro: batch train.sh doesn't resume; document manual shard merge steps.",
        ["retro", "wordnet", "training", "documentation"],
    ),
    (
        "Reading list — papers on continual learning routers and frozen specialist stacks.",
        ["reading", "research", "learning", "growformer"],
    ),
    (
        "Client call recap — they want export to markdown with preserved [[wiki-links]].",
        ["meeting", "client", "cairn", "export", "wiki"],
    ),
    (
        "Feature idea: suggest links between notes using token overlap + growformer ranker.",
        ["idea", "cairn", "linker", "feature", "search"],
    ),
    (
        "Architecture sketch — lookup_graph fast path for single-token wordnet queries.",
        ["architecture", "wordnet", "performance", "design"],
    ),
    (
        "Personal: grocery list and weekend hike plan. Not work.",
        ["personal", "journal", "planning"],
    ),
    (
        "Finance spreadsheet — Q3 runway model updated after vendor quote.",
        ["finance", "planning", "work", "spreadsheet"],
    ),
    (
        "Health log — sleep average 6.2h, trying earlier cutoff on weeknights.",
        ["health", "personal", "journal"],
    ),
    (
        "Travel itinerary — flights booked for conference; hotel still pending.",
        ["travel", "planning", "conference"],
    ),
    (
        "Code snippet — Rust helper to parse JSON tag arrays from growformer infer output.",
        ["code", "rust", "growformer", "cairn", "integration"],
    ),
    (
        "Published blog post on building micro-brains instead of calling external LLM APIs.",
        ["writing", "published", "growformer", "spacekit"],
    ),
    (
        "Team standup — blocked on redb lock during parallel train + infer.",
        ["meeting", "team", "bug", "spacekit", "work"],
    ),
    (
        "Product note — Cairn should show suggested tags inline with accept/dismiss chips.",
        ["product", "cairn", "design", "ui", "feature"],
    ),
    (
        "Reference card — growformer JSONL fields: text, semantic_intent, expected_response.",
        ["reference", "growformer", "training", "documentation"],
    ),
    (
        "Learning log — tried growformer-llm tinystories; too heavy for tag suggestions alone.",
        ["learning", "growformer", "evaluation", "cairn"],
    ),
    (
        "Project charter — auto-tag brain v1: 100+ labeled notes, JSON array output.",
        ["project", "cairn", "planning", "growformer", "spec"],
    ),
    (
        "Draft essay on knowledge gardens vs folders; still rough.",
        ["writing", "draft", "notes", "idea"],
    ),
    (
        "Sprint planning — prioritize summarizer brain after tagger ships.",
        ["planning", "team", "cairn", "roadmap"],
    ),
    (
        "Graph experiments — adjacency index for wordnet edges capped at 32 neighbors.",
        ["research", "wordnet", "graph", "code"],
    ),
    (
        "Onboarding doc for new contributors — how to run batch_train on language/wordnet.",
        ["documentation", "training", "wordnet", "team"],
    ),
    (
        "Idea inbox — voice memo transcription pipeline into Cairn notes.",
        ["idea", "cairn", "feature", "audio"],
    ),
    (
        "Security review — ensure infer with local brain skips storage node when entitled.",
        ["work", "security", "spacekit", "review"],
    ),
    (
        "Morning pages — unstructured thoughts about focus and deep work blocks.",
        ["journal", "personal", "productivity"],
    ),
    (
        "API design — agents.invoke('tagger', { content }) returns string[].",
        ["spec", "cairn", "api", "integration"],
    ),
    (
        "Comparison table — growformer brain vs embedding RAG for sentiment battery.",
        ["research", "evaluation", "growformer", "reference"],
    ),
    (
        "Fix list — repack brain to embed inference TOML; preload topic graph in WASM.",
        ["todo", "performance", "growformer", "spacekit"],
    ),
    (
        "Conference notes — CL-1 router over frozen LM checkpoints; oracle equals best single.",
        ["meeting", "research", "growformer", "learning"],
    ),
    (
        "Recipe — sourdough starter refresh schedule for colder kitchen.",
        ["personal", "reference", "cooking"],
    ),
    (
        "Design mock — tag chips under note title, linker panel on right rail.",
        ["design", "cairn", "ui", "mockup"],
    ),
    (
        "Postmortem — training merged 8k lemmas into 42 lattice programs; fixed autogamy threshold.",
        ["retro", "wordnet", "training", "bug"],
    ),
    (
        "Book notes — chapter on spaced repetition and evergreen notes.",
        ["reading", "learning", "notes", "reference"],
    ),
    (
        "Vendor evaluation — hosted LLM vs on-device growformer for tagging latency.",
        ["work", "evaluation", "cairn", "performance"],
    ),
    (
        "Hackathon pitch — semantic wiki with DID anchoring and narrow agents.",
        ["idea", "cairn", "spacekit", "presentation"],
    ),
    (
        "Migration plan — move mock tagger heuristics behind feature flag for brain infer.",
        ["planning", "cairn", "integration", "todo"],
    ),
    (
        "Wordnet eval — cheerful lookup via wordnet_graph.json; 14-group brain partial train.",
        ["research", "wordnet", "evaluation", "progress"],
    ),
    (
        "Parent-teacher conference summary — math strong, reading practice at home.",
        ["personal", "family", "journal"],
    ),
    (
        "OKR draft — ship auto-tag brain and wire Cairn UI by end of month.",
        ["planning", "work", "cairn", "project"],
    ),
    (
        "Lint cleanup — clippy warnings in growformer lookup_graph module.",
        ["code", "todo", "growformer", "maintenance"],
    ),
    (
        "Brain merge notes — overlay shard training into base wordnet-brain.bin.",
        ["reference", "training", "wordnet", "documentation"],
    ),
    (
        "Quiet day — cleared inbox, no major output.",
        ["journal", "personal"],
    ),
    (
        "Workshop outline — teaching micro-brain training with *.gf.toml projects.",
        ["planning", "teaching", "growformer", "spacekit"],
    ),
    (
        "Link suggestion heuristic — token overlap works; growformer linker should beat it on paraphrase.",
        ["research", "cairn", "linker", "search"],
    ),
    (
        "Release checklist — copy release spacekit binary, run infer smoke on wordnet + auto-tag.",
        ["planning", "release", "spacekit", "qa"],
    ),
    (
        "Garden planning — tomatoes north bed, herbs in pots near kitchen door.",
        ["personal", "planning", "garden"],
    ),
    (
        "Incident log — storage node redb lock blocked infer; documented workaround.",
        ["bug", "spacekit", "documentation", "incident"],
    ),
    (
        "Thought experiment — one brain per agent vs multi-topic single brain for Cairn.",
        ["idea", "architecture", "cairn", "growformer"],
    ),
    (
        "Peer review feedback — add eval JSONL and build_corpus script to auto-tag project.",
        ["review", "cairn", "documentation", "qa"],
    ),
    (
        "Minimal JSONL example row for auto_tag action_target and expected_response array.",
        ["reference", "growformer", "training", "example"],
    ),
    (
        "Weekly review — shipped lookup_graph; next is auto-tag project scaffold.",
        ["retro", "planning", "progress", "cairn"],
    ),
    (
        "Contract test — anchor note hash on-chain; verify from Cairn adapter.",
        ["code", "cairn", "spacekit", "testing"],
    ),
    (
        "Noise note — asdf qwer typos only, should still get generic tags.",
        ["draft", "notes"],
    ),
    (
        "Long meeting transcript paste — budget, hiring, roadmap, risks, action items.",
        ["meeting", "planning", "work", "team"],
    ),
    (
        "Snippet collection — useful bash one-liners for cargo target dir overrides.",
        ["reference", "code", "shell"],
    ),
    (
        "Philosophy scratch — tools for thinking vs tools for publishing.",
        ["journal", "idea", "writing"],
    ),
    (
        "Performance trace — 11s infer cold start vs sub-second with loaded agent.",
        ["performance", "spacekit", "growformer", "benchmark"],
    ),
    (
        "UI copy — button labels Auto-tag, Summarize, Suggest links for narrow agents.",
        ["design", "cairn", "ui", "copy"],
    ),
    (
        "Data labeling — normalize tags to lowercase hyphenated tokens before train export.",
        ["training", "cairn", "documentation", "qa"],
    ),
    (
        "Stretch goal — multilingual tags after English v1 stable.",
        ["planning", "cairn", "roadmap", "i18n"],
    ),
    (
        "Backup reminder — copy wordnet-brain before resuming shard 14 merge.",
        ["todo", "wordnet", "training", "backup"],
    ),
    (
        "Random bookmark — interesting article on zettelkasten linking conventions.",
        ["reading", "reference", "wiki", "notes"],
    ),
    (
        "Empty-ish stub — title only: Quarterly review",
        ["draft", "planning", "work"],
    ),
    (
        "Mixed content — #cairn #growformer meeting notes with [[Pet]] link and todos.",
        ["meeting", "cairn", "growformer", "wiki", "todo"],
    ),
]


def in_eval(text: str) -> bool:
    return int(hashlib.sha256(text.encode()).hexdigest(), 16) % 5 == 0


def tags_json(tags: list[str]) -> str:
    return json.dumps(tags, ensure_ascii=False, separators=(",", ":"))


def row(task_id: str, text: str, tags: list[str]) -> dict:
    return {
        "task_id": task_id,
        "text": text,
        "semantic_intent": "auto_tag",
        "domain": "cairn",
        "action_target": "auto_tag",
        "policy_regime": "default",
        "language_channel": "english",
        "expected_response": tags_json(tags),
        "expected_code": None,
    }


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main() -> None:
    train_rows: list[dict] = []
    eval_rows: list[dict] = []
    idx = 0

    for text, tags in SAMPLES:
        base = row(f"at_{idx:04d}", text, tags)
        if in_eval(text):
            eval_rows.append(base)
        else:
            train_rows.append(base)
        idx += 1

        # Prompt variants (train only) — mirrors infer phrasing.
        for j, prefix in enumerate(
            [
                f"tag: {text}",
                f"auto-tag this note: {text}",
                f"suggest tags for: {text}",
            ],
            start=1,
        ):
            variant = row(f"at_{idx:04d}_v{j}", prefix, tags)
            train_rows.append(variant)
            idx += 1

    write_jsonl(DATA / "train_auto_tag.jsonl", train_rows)
    write_jsonl(DATA / "eval_auto_tag.jsonl", eval_rows)

    print(f"Wrote {len(train_rows)} train + {len(eval_rows)} eval rows → {DATA}", file=sys.stderr)
    print(f"  train: {DATA / 'train_auto_tag.jsonl'}", file=sys.stderr)
    print(f"  eval:  {DATA / 'eval_auto_tag.jsonl'}", file=sys.stderr)


if __name__ == "__main__":
    main()
