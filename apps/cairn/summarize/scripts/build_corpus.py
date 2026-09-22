#!/usr/bin/env python3
"""Build train/eval JSONL for the Cairn summarizer growformer brain."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# (note_text, summary) — one or two sentences, plain text output.
SAMPLES: list[tuple[str, str]] = [
    (
        "Meeting with design on [[Cairn]] wiki links — need auto-tag before publish.",
        "Design meeting on Cairn wiki links; auto-tag is needed before publishing.",
    ),
    (
        "Research notes on WordNet ego-network extraction and sharded growformer training.",
        "Notes on WordNet ego-network extraction and training a sharded growformer brain.",
    ),
    (
        "TODO: wire spacekit agent infer into Cairn tagger adapter instead of mock heuristics.",
        "Task to replace Cairn's mock tagger with spacekit agent infer against a growformer brain.",
    ),
    (
        "Daily journal — tired but finished the wordnet lookup graph fallback path.",
        "Personal journal entry: tired, but the WordNet lookup graph fallback is done.",
    ),
    (
        "Spec draft: narrow agents (tagger, summarizer, linker) backed by micro-brains.",
        "Draft spec for Cairn narrow agents (tagger, summarizer, linker) using micro-brains.",
    ),
    (
        "Bug: infer reloads full brain every CLI call; use agent load for warm path.",
        "Performance bug: each infer reloads the brain; should use a warm loaded agent.",
    ),
    (
        "Interview prep — system design for note graphs, backlinks, and semantic search.",
        "Interview prep on note graphs, backlinks, and semantic search system design.",
    ),
    (
        "Retro: batch train.sh doesn't resume; document manual shard merge steps.",
        "Retro on batch training not resuming; manual shard merge steps need documenting.",
    ),
    (
        "Reading list — papers on continual learning routers and frozen specialist stacks.",
        "Reading list focused on continual learning routers and frozen specialist stacks.",
    ),
    (
        "Client call recap — they want export to markdown with preserved [[wiki-links]].",
        "Client wants markdown export that keeps wiki-style links intact.",
    ),
    (
        "Feature idea: suggest links between notes using token overlap + growformer ranker.",
        "Idea for a linker that beats token overlap using a growformer ranker.",
    ),
    (
        "Architecture sketch — lookup_graph fast path for single-token wordnet queries.",
        "Sketch of a lookup_graph fast path for single-token WordNet queries.",
    ),
    (
        "Personal: grocery list and weekend hike plan. Not work.",
        "Personal note mixing groceries and a weekend hike plan.",
    ),
    (
        "Finance spreadsheet — Q3 runway model updated after vendor quote.",
        "Q3 runway spreadsheet updated after receiving a vendor quote.",
    ),
    (
        "Code snippet — Rust helper to parse JSON tag arrays from growformer infer output.",
        "Rust helper snippet for parsing JSON tag arrays from growformer infer.",
    ),
    (
        "Published blog post on building micro-brains instead of calling external LLM APIs.",
        "Published post arguing for micro-brains over external LLM APIs.",
    ),
    (
        "Team standup — blocked on redb lock during parallel train + infer.",
        "Standup note: blocked by a redb lock while training and infer ran in parallel.",
    ),
    (
        "Product note — Cairn should show suggested tags inline with accept/dismiss chips.",
        "Product idea: inline suggested tags with accept/dismiss chips in Cairn.",
    ),
    (
        "Sprint planning — prioritize summarizer brain after tagger ships.",
        "Sprint plan to ship the summarizer brain right after the tagger.",
    ),
    (
        "Graph experiments — adjacency index for wordnet edges capped at 32 neighbors.",
        "Experiments on a WordNet adjacency index capped at 32 neighbors per edge.",
    ),
    (
        "Security review — ensure infer with local brain skips storage node when entitled.",
        "Security review: local-brain infer should skip the storage node when entitled.",
    ),
    (
        "Morning pages — unstructured thoughts about focus and deep work blocks.",
        "Morning pages on focus and scheduling deep work blocks.",
    ),
    (
        "API design — agents.invoke('tagger', { content }) returns string[].",
        "API sketch: agents.invoke('tagger') returns a string array of tags.",
    ),
    (
        "Fix list — repack brain to embed inference TOML; preload topic graph in WASM.",
        "Fix list: embed inference TOML in the brain and preload topic graph in WASM.",
    ),
    (
        "Conference notes — CL-1 router over frozen LM checkpoints; oracle equals best single.",
        "Conference notes on CL-1 routing over frozen checkpoints.",
    ),
    (
        "Design mock — tag chips under note title, linker panel on right rail.",
        "UI mock with tag chips under titles and a linker panel on the right rail.",
    ),
    (
        "Postmortem — training merged 8k lemmas into 42 lattice programs; fixed autogamy threshold.",
        "Postmortem on over-merged WordNet training and fixing autogamy thresholds.",
    ),
    (
        "Vendor evaluation — hosted LLM vs on-device growformer for tagging latency.",
        "Evaluation comparing hosted LLM tagging latency to on-device growformer.",
    ),
    (
        "Hackathon pitch — semantic wiki with DID anchoring and narrow agents.",
        "Hackathon pitch for a semantic wiki with DID anchoring and narrow agents.",
    ),
    (
        "Migration plan — move mock tagger heuristics behind feature flag for brain infer.",
        "Plan to gate mock tagger heuristics behind a growformer infer feature flag.",
    ),
    (
        "Wordnet eval — cheerful lookup via wordnet_graph.json; 14-group brain partial train.",
        "WordNet eval notes: cheerful lookup works; brain training is partial at 14 groups.",
    ),
    (
        "OKR draft — ship auto-tag brain and wire Cairn UI by end of month.",
        "OKR to ship auto-tag and wire the Cairn UI by month end.",
    ),
    (
        "Performance trace — 11s infer cold start vs sub-second with loaded agent.",
        "Benchmark: 11s cold infer vs sub-second with a loaded agent.",
    ),
    (
        "UI copy — button labels Auto-tag, Summarize, Suggest links for narrow agents.",
        "Copy draft for Cairn agent buttons: Auto-tag, Summarize, Suggest links.",
    ),
    (
        "Thought experiment — one brain per agent vs multi-topic single brain for Cairn.",
        "Architecture thought experiment: one brain per agent vs one multi-topic brain.",
    ),
    (
        "Weekly review — shipped lookup_graph; next is auto-tag project scaffold.",
        "Weekly review: lookup_graph shipped; next up is the auto-tag scaffold.",
    ),
    (
        "Long meeting transcript paste — budget, hiring, roadmap, risks, action items.",
        "Long meeting covering budget, hiring, roadmap, risks, and action items.",
    ),
    (
        "Mixed content — #cairn #growformer meeting notes with [[Pet]] link and todos.",
        "Mixed meeting notes tagged cairn/growformer with a Pet wiki link and todos.",
    ),
    (
        "This notes app runs on the Spacekit network: storage node holds your notes.",
        "Overview of the Spacekit notes app and its storage node backing.",
    ),
    (
        "- Connect integrations in one click\n- CRM and outreach tools feeding live data\n- Seven skills: mapping, scoring, warm paths, outreach, deck review, CRM tracking, weekly report\n- Brief template: stage, round size, traction, target investor",
        "Product overview: one-click integrations, CRM/outreach sync, seven fundraising skills, and a reusable raise brief template.",
    ),
    (
        "1. Ship auto-tag brain\n2. Wire Cairn UI agents panel\n3. Train summarizer + linker\n4. Deploy to local storage",
        "Sprint checklist: ship auto-tag, wire agents UI, train summarize/linker brains, deploy locally.",
    ),
    (
        "• Morning: standup and code review\n• Afternoon: wordnet shard merge\n• Evening: document training resume steps",
        "Daily plan: standup and review in the morning, shard merge afternoon, training docs in the evening.",
    ),
    (
        "ALICE was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. Suddenly a white rabbit with pink eyes ran close by her. The rabbit took a watch out of its waistcoat-pocket, looked at it, and hurried on — Alice ran after it and saw it pop down a large rabbit-hole.",
        "Alice, bored on the riverbank, follows a waistcoat-wearing White Rabbit down a rabbit-hole after it checks its watch.",
    ),
]


def in_eval(text: str) -> bool:
    return int(hashlib.sha256(text.encode()).hexdigest(), 16) % 5 == 0


def row(task_id: str, text: str, summary: str) -> dict:
    return {
        "task_id": task_id,
        "text": text,
        "semantic_intent": "summarize",
        "domain": "cairn",
        "action_target": "summarize",
        "policy_regime": "default",
        "language_channel": "english",
        "expected_response": summary,
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

    for text, summary in SAMPLES:
        base = row(f"sm_{idx:04d}", text, summary)
        if in_eval(text):
            eval_rows.append(base)
        else:
            train_rows.append(base)
        idx += 1

        for j, prefix in enumerate(
            [
                f"summarize: {text}",
                f"tl;dr: {text}",
                f"brief summary of: {text}",
            ],
            start=1,
        ):
            variant = row(f"sm_{idx:04d}_v{j}", prefix, summary)
            train_rows.append(variant)
            idx += 1

    write_jsonl(DATA / "train_summarize.jsonl", train_rows)
    write_jsonl(DATA / "eval_summarize.jsonl", eval_rows)

    print(f"Wrote {len(train_rows)} train + {len(eval_rows)} eval rows → {DATA}", file=sys.stderr)


if __name__ == "__main__":
    main()
