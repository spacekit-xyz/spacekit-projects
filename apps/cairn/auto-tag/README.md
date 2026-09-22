# Cairn Auto-Tag (growformer micro-brain)

Suggest **3–6 topical tags** for wiki-style notes. Output is a **JSON string array** (Cairn `tagger` agent shape).

## Quick start

```bash
cd spacekit-projects/apps/cairn/auto-tag

# 1. Build training corpus (~280 rows with prompt variants)
python3 scripts/build_corpus.py

# 2. Train (single group, ~2–5 min on laptop)
chmod +x scripts/train.sh scripts/test_infer.sh
./scripts/train.sh

# 3. Infer
/Users/astor/Projects/2026/spacekit/target/release/spacekit agent infer \
  --project auto-tag.gf.toml \
  --brain agent/auto-tag-brain.bin \
  --prompt "Meeting with design on Cairn wiki links — need auto-tag before publish."
```

Example output:

```json
["meeting","design","cairn","wiki","planning"]
```

## Training format

Each JSONL row:

| Field | Value |
|-------|--------|
| `semantic_intent` | `auto_tag` |
| `action_target` | `auto_tag` |
| `expected_response` | JSON array string, e.g. `["research","wordnet"]` |

Add rows to `scripts/build_corpus.py` → re-run `build_corpus.py` → `./scripts/train.sh`.

## Cairn integration

Replace `mockAgents` tagger branch with infer against this brain:

```typescript
// payload: { content: string }
const out = await spacekit.agent.infer({
  project: 'auto-tag.gf.toml',
  brain: 'agent/auto-tag-brain.bin',
  prompt: payload.content,
});
const tags = JSON.parse(out.trim());
```

For low latency in the UI, load the brain once (`spacekit agent load --name cairn-tagger …`) and infer with `--name cairn-tagger`.

## Files

| Path | Role |
|------|------|
| `auto-tag.gf.toml` | Project manifest |
| `data/train_auto_tag.jsonl` | Training corpus |
| `data/eval_auto_tag.jsonl` | Holdout eval (~20%) |
| `data/knowledge_graph.toml` | Routes to `auto_tag` topic |
| `agent/auto-tag-brain.bin` | Trained brain (after `train.sh`) |

## Related

- Cairn UI agents: `spacekit-projects/apps/cairn/ui/src/CairnApp.tsx`
- WordNet lookup brain pattern: `spacekit-projects/language/wordnet/`
