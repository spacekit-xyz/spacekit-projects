# Kitsu the Shiba 3D — Shiba Inu Companion

Kitsu is a Shiba Inu companion for the SpaceKit Agent Hub. A Growformer micro-brain, trained on pet-domain chat, drives his replies. He comes with a 3D video-chat style UI that the Hub loads next to the conversation.

Kitsu grew up in the streets around Asakusa in Tokyo, where the locals called him *the little fox*. He's alert, loyal, mischievous and city-smart. He talks in short, punchy lines with a light Japanese flavor, and he lifts your energy rather than analysing your feelings. He's grounded and modern, not mystical like Pete.

> "Oi! You look sleepy. Walk time!"

The full character bible is in [KITSU.md](KITSU.md): identity, voice, behavior templates, boundaries and the training data map.

Kitsu follows the same layout and deploy flow as [Luna](../luna) and [Pete](../pete).

## Layout

```
kitsu/
├── kitsu.gf.toml              # Growformer train + inference manifest
├── deploy.toml                # Agent Hub deploy manifest
├── KITSU.md                   # Character bible
├── agent/                     # Trained brain goes here (agent/kitsu-3d.bin, not committed)
├── data/
│   ├── kitsu_seed_v2.jsonl            # 250-row structured intent seed
│   ├── kitsu_voice_dataset_v1.jsonl   # 200-row voice set
│   ├── kitsu_backstory_lore_v1.jsonl  # Origin story and identity lore
│   ├── kitsu_*_v1.jsonl               # Japanese lore stories, feeding, compliments, freeform, routing fixes
│   ├── kitsu_fragments_v2.jsonl       # Fragment library used to compose replies at inference
│   ├── inference_pets.toml            # Inference rules and compose settings
│   ├── inference_guardrails.jsonl     # Guardrails (loaded at inference only)
│   ├── pet_world_grounding.toml       # Lexicon grounding, including Tokyo / Japan nodes
│   ├── knowledge_graph_pet_overlay.toml  # Topic routing
│   └── archive/                       # Older shards, excluded from training
├── scripts/                   # Data generators and seed validator
└── ui/shiba-video-chat.html   # Companion UI shown in the Agent Hub
```

## Prerequisites

- The SpaceKit CLI (`spacekit`) on your `PATH`
- Python 3, to regenerate or validate training data
- To deploy, the Growformer agent WASM built from `spacekit-standard-library`

## Train

Trained brains (`*.bin`) are not committed. Train your own:

```bash
python3 scripts/generate_kitsu_seed_v2.py            # regenerate the 250-row seed
python3 scripts/generate_kitsu_voice_dataset.py      # regenerate the voice set
python3 scripts/generate_kitsu_backstory_lore.py     # regenerate lore
python3 scripts/validate_kitsu_seed_v2.py            # check the seed
spacekit agent --train-brain --project kitsu.gf.toml # writes agent/kitsu-3d.bin
```

## Try it

```bash
spacekit agent infer --project kitsu.gf.toml --prompt "hey kitsu"
spacekit agent infer --project kitsu.gf.toml --prompt "where are you from"
spacekit agent infer --project kitsu.gf.toml --prompt "I don't feel like doing anything today"
```

## Deploy to the Agent Hub

1. Open `deploy.toml` and set:
   - `[artifacts].wasm` to the path of your `spacekit_growformer_agent.wasm`
   - `[storage].url` to your storage node
   - `[agent].owner_did` to your DID, or remove it to use your `spacekit init` identity
2. Deploy:

```bash
spacekit storage deploy --package deploy.toml
```

The agent appears in the Hub with tag **PETS**, thinking label "Sniffing", and the `kitsu_3d` companion UI.

## License

Apache 2.0 — see [LICENSE](LICENSE).
