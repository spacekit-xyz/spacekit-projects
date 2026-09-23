Locale-specific pet companion training data (Phase 2).

Place JSONL shards here, e.g.:
  es/train_pet_chat.jsonl
  fr/train_pet_chat.jsonl

Train a brain per locale (or one multilingual encoder + single brain) and load the matching
blob at inference. Declarative rescore tables can mirror the English domain file as needed;
see growformer docs for retrieval extensibility.
