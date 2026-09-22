# Fintech Sentiment (Growformer)

This directory holds **training data** and a **domain-tuned inference rules file** for a small sentiment micro-brain aimed at consumer-finance wording (payments, fees, holds, fraud alerts, support friction). The runnable project manifest is `../fintech-sentiment-analysis.gf.toml`; see the [project README](../README.md) for training and deployment.

## Quick start

From the project directory (`sentiment/fintech/`):

```bash
spacekit agent --train-brain --project fintech-sentiment-analysis.gf.toml
spacekit agent infer --project fintech-sentiment-analysis.gf.toml --prompt 'I love the fee transparency'
```

If you omit `--brain` on infer, the brain from `[infer].brain` in the project file is used.

## Project manifest

| Item | Path (relative to `sentiment/fintech/`) |
|------|-----------------------------------------|
| Project TOML | `fintech-sentiment-analysis.gf.toml` |
| Training `data_dir` | `data/` |
| Brain output | `agent/fintech-brain.bin` (created on train, not committed) |
| Inference rules | `data/inference_fintech.toml` via `[inference].toml` |
| Plugins | `plugins/example-brain-plugins.toml` (`[train].brain_plugins_toml`) — lattice uses **`[sentiment]`** only |

## Files in `data/`

| File | Role |
|------|------|
| `train_sentiment_fintech.jsonl` | Main synthetic fintech sentiment corpus |
| `train_sentiment_fintech_exp.jsonl` | Extra / experimental lines (merged when present in `data_dir`) |
| `inference_fintech.toml` | Numeric gates + `[rules]` lists (contrast, sarcasm, lexical polarity, objective-fact shortcuts) tuned for money/support language |

## JSONL schema (training)

Each line is one example. Typical fields:

- **`task_id`** — stable id  
- **`text`** — user utterance  
- **`semantic_intent`** — label (e.g. `positive_mild`, `negative_strong`, `sarcastic`, `mixed`, …)  
- **`domain`** / **`action_target`** — `sentiment` for this brain  
- **`policy_regime`**, **`language_channel`** — metadata  
- **`expected_response`** — short rationale for the label  
- **`expected_code`** — usually `null` for sentiment-only tasks  

## Inference TOML resolution

At runtime, rule lists and gates load from the inference TOML resolved for the process. Order (native) includes **`--inference-toml`**, **`--project` … `*.gf.toml`** **`[inference]`** table, then **`GROWFORMER_INFERENCE_TOML`** (legacy: **`GROWFORMER_SENTIMENT_INFERENCE_TOML`**), then default search paths. See `growformer/README.md` for the full chain and **`GROWFORMER_INFERENCE_DEFAULTS_TOML`** merge behavior.

This fintech workflow points **`[inference].toml`** at **`inference_fintech.toml`** so you get the extended contrast markers, finance-flavored sarcasm cues, bipolar tokens (e.g. `declined` / `waived`), and larger **`objective_fact_rules`** (including byte-scale units) without changing the global default `data/sentiment/inference_sentiment.toml`.

## Engine behavior (pointers)

- **Single-group `[topic-lex]` override**: when retrieval leaves one sentiment group and the sub-lattice contains a topic key from **`sentiment_lexical_topic_key`**, routing can follow that lexical signal (e.g. strong positive verbs vs. fee/dispute tokens). Implemented in `service.rs` alongside operation-topic logic.  
- **MetaCognition skip for `growformer_gen_*`**: when **`topic_hint`** is set, confidence is high enough, and the group has a non-empty **`topic_subindex`**, MetaCognition can be skipped to avoid false **metacog_degradation** from embedding mismatch on synthetic lattice rows.

## Intended use and limitations

**Fit:** sentiment / tone for support-style fintech text, triage copy, and evaluation of sarcasm and contrast in money-related utterances.

**Not for:** credit or fraud scoring, AML/KYC decisions, eligibility, or any automated regulatory action. The data is **synthetic**; it does not replace domain validation or human review in production.

**Caveats:** synthetic data under-covers long multi-turn escalation, code-switching, and regional phrasing. Labels are sentiment-focused, not risk-focused.

## Model card (short)

- **Overview:** Synthetic short utterances modeling frustration, satisfaction, confusion, and sarcasm around payments, transfers, disputes, auth, and support.  
- **Composition:** Strict JSONL schema; categories include strong/mild positive and negative, sarcastic, and mixed where labeled. No PII or real account data.  
- **Annotation:** Ground tone in the described financial event; **`expected_response`** carries a brief justification.  
- **Ethics:** Avoid using trained models for profiling, socioeconomic inference, or substituting compliance judgment.

For the default (non-fintech) rule baseline shared across projects, see `data/sentiment/inference_sentiment.toml` — it is kept in broad parity with the non–byte-scale additions from the fintech file where those rules are generally useful outside finance.
