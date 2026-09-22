# Luna 3D — Cat Companion

Luna is a cat companion for the SpaceKit Agent Hub. A Growformer micro-brain, trained on pet-domain chat, drives her replies. She comes with a 3D video-chat style UI that the Hub loads next to the conversation.

Luna talks in the first person as a cat: short, a little regal, easily distracted, fond of sun patches and salmon. She ends lines with cat sounds (*Mrrp*, *Trill*, *Chirp*). She's a comfort companion, not a therapist. Guardrails keep her from giving advice outside the pet domain.

> "I put a cardboard box on my head and walk into the wall with dignity. Comedy is healing. Trill."

Luna is the reference companion. [Pete](../pete) and [Kitsu](../kitsu) follow the same project layout and deploy flow.

## Layout

```
luna/
├── luna.gf.toml               # Growformer train + inference manifest
├── deploy.toml                # Agent Hub deploy manifest (artifacts, hub settings, marketplace, sample prompts)
├── agent/                     # Trained brain goes here (agent/luna-v3-3d.bin, not committed)
├── data/
│   ├── luna_seed_v2.jsonl             # Canonical 250-row intent seed
│   ├── luna_*_v1.jsonl                # Conversational, comfort, lore, multi-turn, cheer-up shards
│   ├── luna_fragments_v2.jsonl        # Fragment library used to compose replies at inference
│   ├── inference_pets.toml            # Inference rules and compose settings
│   ├── inference_guardrails.jsonl     # Guardrails (loaded at inference only)
│   ├── pet_world_grounding.toml       # Lexicon / concept grounding
│   ├── knowledge_graph_pet_overlay.toml  # Topic routing
│   ├── plugins/                       # Brain plugin config
│   └── archive/                       # Older shards, excluded from training
├── scripts/                   # Corpus generators, seed validator, prompt-matrix test runner
├── prompts/TEST_PROMPTS.md    # Smoke, discrimination and out-of-domain test sets
└── ui/cat-video-chat-v2.html  # Companion UI shown in the Agent Hub
```

Training merges every `*.jsonl` in `data/` (sorted by filename), except the guardrails file. Move a shard into `data/archive/` to leave it out.

## Prerequisites

- The SpaceKit CLI (`spacekit`) on your `PATH`
- Python 3, to regenerate or validate training data
- To deploy, the Growformer agent WASM built from `spacekit-standard-library`
  (`target/wasm32-unknown-unknown/release/spacekit_growformer_agent.wasm`)

## Train

Trained brains (`*.bin`) are not committed. Train your own:

```bash
python3 scripts/validate_luna_seed_v2.py            # optional: check the seed
spacekit agent --train-brain --project luna.gf.toml # writes agent/luna-v3-3d.bin
```

To regenerate the data shards, run the generators in `scripts/` (for example `generate_luna_seed_v2.py`, `generate_luna_coverage_v1.py`, `generate_luna_state_variants.py`, `generate_luna_cheer_spain_v1.py`).

## Try it

```bash
spacekit agent infer --project luna.gf.toml --prompt "Hey Luna"
spacekit agent infer --project luna.gf.toml --prompt "cheer me up"
spacekit agent infer --project luna.gf.toml --prompt "what's your favorite snack"
```

For a fuller check, work through the sets in [`prompts/TEST_PROMPTS.md`](prompts/TEST_PROMPTS.md) or run `scripts/run_luna_prompt_matrix.py`.

## Deploy to the Agent Hub

1. Open `deploy.toml` and set:
   - `[artifacts].wasm` to the path of your `spacekit_growformer_agent.wasm`
   - `[storage].url` to your storage node (defaults to `http://localhost:3030`)
   - `[agent].owner_did` to your DID, or remove it to use your `spacekit init` identity
2. Deploy:

```bash
spacekit storage deploy --package deploy.toml
```

This uploads the brain, inference files and companion UI, registers the agent with the Hub (tag **PETS**, thinking label "Purring"), and lists it in the marketplace. The sample prompts in `deploy.toml` appear in the Hub UI. The CLI writes a `deploy-receipt.json`, which is git-ignored.

## License

Apache 2.0 — see [LICENSE](LICENSE).
