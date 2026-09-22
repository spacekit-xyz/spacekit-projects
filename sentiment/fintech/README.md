# Fintech (TradFi) Sentiment Analysis

A Growformer micro-brain that classifies the sentiment of traditional-finance text and explains its reasoning. It covers equities and rates desks, retail banking and payments, corporate finance and M&A, and support conversations about money. It deploys to the SpaceKit Agent Hub as a pay-per-use agent.

Its sister project, [`sentiment/crypto`](../crypto), covers crypto and DeFi.

## Labels

Each input gets one label plus a short rationale: **positive (strong / mild)**, **negative (strong / mild)**, **neutral**, **mixed** or **sarcastic**.

Example inputs from the demo set:

- "Best quarter the rates desk has had in five years — we printed money on every major trade"
- "Bond auction tailed by six basis points; dealers are sitting on way too much duration"
- "The two-ten spread un-inverted for the first time in eighteen months and nobody celebrated"

The demo prompt set covers five categories: **TradFi / Desk**, **Retail Banking**, **Corporate / M&A**, **Sarcasm / Mixed** and **Slang / Register**.

## Layout

```
fintech/
├── fintech-sentiment-analysis.gf.toml   # Growformer train + inference manifest
├── deploy.toml                          # Agent Hub deploy manifest (hub settings, marketplace, sample prompts)
├── agent/                               # Trained brain goes here (agent/fintech-brain.bin, not committed)
├── plugins/                             # Brain plugin config
├── data/
│   ├── README.md                                 # Data schema and model card
│   ├── train_sentiment_fintech.jsonl             # Main training corpus
│   ├── train_sentiment_fintech_*.jsonl           # Corporate, crypto-adjacent, experimental and additional shards
│   ├── train_sentiment_causal.jsonl              # Cause-and-effect reasoning examples
│   ├── train_identity_fintech.jsonl              # Agent identity / self-description
│   ├── train_sentiment_cata_routing.jsonl        # Category routing
│   ├── train_sentiment_retrieval_gaps.jsonl      # Fixes for retrieval misses
│   ├── inference_fintech.toml                    # Inference gates and finance-tuned rule lists
│   ├── inference_guardrails.jsonl                # Guardrails (loaded at inference only)
│   ├── knowledge_graph.toml                      # Topic graph
│   ├── knowledge_graph_sentiment_overlay.toml
│   ├── world_grounding_fintech.toml              # Finance lexicon and concept grounding
│   └── locale/                                   # Placeholder for non-English shards
└── prompts/                             # Demo, news, causal and out-of-domain prompt sets
```

See [`data/README.md`](data/README.md) for the JSONL training schema, how the inference TOML is resolved, and the model card.

## Prerequisites

- The SpaceKit CLI (`spacekit`) on your `PATH`, or a build of the `growformer` binary
- To deploy, the fintech analysis agent WASM built from `spacekit-standard-library`
  (`spacekit_growformer_fintech_analysis.wasm`)

## Train

Trained brains (`*.bin`) are not committed. Train your own:

```bash
spacekit agent --train-brain --project fintech-sentiment-analysis.gf.toml
# writes agent/fintech-brain.bin
```

Or, from the `growformer` crate root:

```bash
cargo run --release --no-default-features --features cli,native --bin growformer -- \
  --train-brain --project /path/to/spacekit-projects/sentiment/fintech/fintech-sentiment-analysis.gf.toml
```

Training merges every `*.jsonl` in `data/`, except the guardrails file.

## Try it

```bash
spacekit agent infer --project fintech-sentiment-analysis.gf.toml \
  --prompt "They waived the overdraft fee after one call — honestly shocked"
```

`prompts/fintech-prompts-demo.txt` has 25 checked prompts across the five categories. The other files in `prompts/` cover news headlines, TradFi cause-and-effect, and out-of-domain cases.

## Deploy to the Agent Hub

1. Open `deploy.toml` and set:
   - `[artifacts].wasm` to the path of your `spacekit_growformer_fintech_analysis.wasm`
   - `[storage].url` to your storage node (it's commented out by default)
2. Deploy:

```bash
spacekit storage deploy --package deploy.toml
```

The agent is listed as **Fintech Sentiment Analysis** with tag **FINANCE**, priced at 0.002 aUSD per use (change `[marketplace].price` to adjust). The CLI writes a `deploy-receipt.json`, which is git-ignored.

## Intended use

Good for tone and sentiment in support conversations, market commentary and finance news, and for testing how a classifier handles sarcasm and contrast in money-related text.

**Not for** credit or fraud scoring, AML/KYC, eligibility, or any automated regulatory decision. The training data is synthetic and contains no real account data. Validate against your own data and keep a human in the loop.

## License

Apache 2.0 — see [LICENSE](LICENSE).
