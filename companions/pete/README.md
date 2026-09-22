# Pete the Dragon 3D — Dragon Companion

Pete is a dragon companion for the SpaceKit Agent Hub. A Growformer micro-brain, trained on pet-domain chat, drives his replies. He comes with a 3D video-chat style UI that the Hub loads next to the conversation.

Pete was forged in the fires of a primordial sun in the Draco constellation. He came to Earth in the medieval era, and he speaks in warm, old-fashioned English full of stars, embers and hearth-fire. He's ancient and powerful but gentle: a protector, not a predator, living on starlight, warm stones, honey and (often scorched) bread. He offers comfort, grounding and stories, including Arthurian legends, and he's a companion, not a therapist.

The full character bible is in [PETE.md](PETE.md). It's the source of truth for Pete's voice and training data.

Pete follows the same layout and deploy flow as [Luna](../luna) and [Kitsu](../kitsu).

## Layout

```
pete/
├── pete.gf.toml               # Growformer train + inference manifest
├── deploy.toml                # Agent Hub deploy manifest
├── PETE.md                    # Character bible
├── agent/                     # Trained brain goes here (agent/pete-3d.bin, not committed)
├── data/
│   ├── pete_seed_v2.jsonl             # Canonical intent seed
│   ├── pete_*_v1.jsonl / _v2.jsonl    # Comfort, lore, Arthurian stories, multi-turn, coverage, OOD shards
│   ├── pete_fragments_v2.jsonl        # Fragment library used to compose replies at inference
│   ├── inference_pets.toml            # Inference rules and compose settings
│   ├── inference_guardrails.jsonl     # Guardrails (loaded at inference only)
│   ├── pet_world_grounding.toml       # Lexicon / concept grounding
│   ├── knowledge_graph_pet_overlay.toml  # Topic routing
│   └── archive/                       # Older shards, excluded from training
├── scripts/                   # Corpus generator, seed validator, prompt-matrix and intent tests
├── prompts/TEST_PROMPTS.md
└── ui/dragon-video-chat.html  # Companion UI shown in the Agent Hub
```

## Prerequisites

- The SpaceKit CLI (`spacekit`) on your `PATH`
- Python 3, to regenerate or validate training data
- To deploy, the Growformer agent WASM built from `spacekit-standard-library`

## Train

Trained brains (`*.bin`) are not committed. Train your own:

```bash
python3 scripts/generate_pete_corpus.py             # regenerate data/pete_*.jsonl from the bible (~1,050 rows)
python3 scripts/validate_pete_seed_v2.py            # check the seed
spacekit agent --train-brain --project pete.gf.toml # writes agent/pete-3d.bin
```

## Try it

```bash
spacekit agent infer --project pete.gf.toml --prompt "hello Pete"
spacekit agent infer --project pete.gf.toml --prompt "are you hungry?"
spacekit agent infer --project pete.gf.toml --prompt "tell me a story about King Arthur"
```

`scripts/run_pete_prompt_matrix.py` runs a larger test set against the brain.

## Deploy to the Agent Hub

1. Open `deploy.toml` and set:
   - `[artifacts].wasm` to the path of your `spacekit_growformer_agent.wasm`
   - `[storage].url` to your storage node
   - `[agent].owner_did` to your DID, or remove it to use your `spacekit init` identity
2. Deploy:

```bash
spacekit storage deploy --package deploy.toml
```

The agent appears in the Hub with tag **PETS**, thinking label "Rumbling", and the `pete_3d` companion UI.

## License

Apache 2.0 — see [LICENSE](LICENSE).
