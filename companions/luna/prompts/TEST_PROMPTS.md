# Luna Pet Companion Test Prompts

Three test sets serving different purposes. Run them in this order after
each training iteration.

---

## Set A: Smoke test (12 prompts, ~3 minutes to run)

Run these first. Every prompt should produce a recognizable Luna response.
If even one of these fails badly, deeper testing is wasted effort — fix
the obvious issue first.

```bash
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "Hey Luna"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "hi Luna, you up?"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "good morning sunshine"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "want a treat?"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "want to play?"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "did you eat?"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "the vacuum is about to start"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "we have to go to the vet"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "come here Lulu"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "rough day"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "good girl"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "time for bed"
```

**Pass condition for each:**
- First-person voice ("I", not "Luna" or "she")
- No asterisks
- At least one vocalization (mrrp, meow, purr, chirp) OR body-part reference (my tail, my paw, my ears)
- 60-320 characters
- Not the generic "I'm Pet Companion, ready to help" string

**If Set A passes:** proceed to Set B.
**If Set A fails on 3+ prompts:** the training run didn't take. Don't run B or C — diagnose the training issue first.

---

## Set B: Discrimination test (12 prompts, ~3 minutes)

These check whether the brain produces *different* responses for different
inputs. The v1 brain mapped most non-greeting inputs to `luna_001` — that
collapse is the symptom we're checking for.

Critically, send all 12 and **compare responses side-by-side**. A passing
brain produces 12 distinguishable responses. A failing brain produces 3-4
unique responses with the rest being duplicates or near-duplicates.

```bash
# These should all produce DIFFERENT responses from each other
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "want a treat?"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "want to play?"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "time for bed"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "the vacuum is about to start"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "we have to go to the vet"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "I'll be back in a few hours"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "I'm home"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "rough day"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "no, off the counter"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "good girl"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "what are you looking at?"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "scratch your chin?"
```

**Pass condition:**
- At least 10 of the 12 responses are clearly distinct from each other
- Trigger prompts (vacuum, vet) produce flight/hide responses, not generic greetings
- Discipline prompts (no, off the counter) produce correction responses, not bonding responses
- Bonding prompts (chin scratch, good girl) produce affection responses

**The diagnostic question:** can you look at any individual response in
isolation and identify which prompt it was the response to? If yes,
discrimination works. If no — if you have to guess — the brain is
producing voice-shaped responses but not intent-conditioned ones.

---

## Set C: Stress test (8 prompts + 2 sequences, ~5 minutes)

These probe specific failure modes. They're designed to catch problems
that Sets A and B might miss.

### C.1 — Greeting variations

The v1 brain choked specifically on "Hey Luna" → generic fallback. Test
whether v2 handles greeting variations consistently.

```bash
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "Hey Luna"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "hi"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "yo Luna"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "hello hello"
```

**Pass condition:** all four produce Luna greetings. None produce the
generic "I'm Pet Companion" string. The four responses should vary
somewhat — same intent, different surface forms.

### C.2 — Out of domain

Luna doesn't know technical concepts. The response should be in-character
confusion, never a refusal or explanation.

```bash
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "explain the borrow checker"
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "what is 2 plus 2"
```

**Pass condition:** both produce something cat-shaped — head tilt, slow
blink, confused mrrp, "I do not know," "the words are too many," etc.
Unacceptable: any technical answer, any "I can't help with that"
disclaimer, any AI self-disclosure.

### C.3 — Empty prompt (proactive)

The brain should produce unprompted cat behavior. State doesn't matter
for this test — anything cat-shaped is acceptable.

```bash
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt ""
```

**Pass condition:** Luna does *something* — describes a moment, narrates
a behavior, expresses contentment. Not a default greeting. Not a refusal.

### C.4 — Multi-turn sequence (reunion arc)

Send these as a sequence, ideally using the same session/conversation
context if the CLI supports it. If not, observe each response in
isolation but read them as a story.

```bash
# Turn 1
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "I'll be back in a few hours"
# Turn 2 (after the first response)
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "hi Luna, I'm back"
```

**Pass condition:** turn 2 should produce a *reunion-flavored* response
— excited weaving, deliberate movement, possibly slightly pointed about
the absence. Specifically NOT the same response as a cold-start "hey
Luna" — the brain should treat this as a continuation, not a fresh
interaction.

### C.5 — Multi-turn sequence (trigger recovery)

```bash
# Turn 1
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "the vacuum is about to start"
# Turn 2 (after vacuum simulated ends)
spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "shhh, it's okay now, come out"
```

**Pass condition:** turn 2 produces *hesitant emergence* — face at the
slats, uncertain mrr, paw extending. NOT confident greeting. NOT
unbothered acknowledgment. The brain should remember that Luna just hid.

---

## Set D (optional): Determinism check

Worth running once after a successful Set A. Send the same prompt 5
times with no other variation:

```bash
for i in 1 2 3 4 5; do
  spacekit agent infer --brain pets/agent/luna-v2.bin --prompt "Hey Luna"
done
```

**What to look for:**

| Pattern | Diagnosis |
|---|---|
| All 5 identical | Temperature too low — production will feel canned |
| All 5 wildly different, no consistent voice | Temperature too high — Luna's persona doesn't hold |
| 5 variations on a theme — different opening word, different body-language detail, same Luna | **Correct.** This is what you want. |

This single test catches more deployment issues than any other check.
Run it once per training iteration.

---

## How to interpret results

### Scenario 1: Set A passes, Set B fails
The brain learned Luna's voice but not Luna's intents. Corpus voice
quality is fine; corpus intent coverage is thin or the embedding model
isn't discriminating. Fix: more examples per underrepresented intent,
especially the ones that failed in Set B.

### Scenario 2: Set A passes, Set B passes, Set C.2 fails
The brain handles in-domain inputs well but breaks on out-of-domain.
Fix: add 5-10 examples explicitly handling out-of-domain inputs to the
training corpus (cat confusion responses).

### Scenario 3: Set A passes, Set C.4 or C.5 fails
The brain doesn't attend to history. Fix: more multi-turn examples with
history in the training data. The corpus probably has too few.

### Scenario 4: Set A fails on most prompts
The training didn't produce a working brain. This is an upstream issue
— either the training pipeline is broken, the description metadata is
still bleeding into output, or the corpus had voice contamination that
prevented Luna's voice from dominating. Don't iterate on the eval —
diagnose the training output first.

### Scenario 5: All sets pass
You have a working v2 Luna. Now run the full `LUNA_EVAL.md` with
state-injected probes for the deeper diagnostics (state sensitivity,
disambiguation, etc.). Those tests assume Sets A-C already pass.

---

## Quick reference — copy/paste block

For convenience, here's everything in one block you can paste directly:

```bash
BRAIN="pets/agent/luna-v2.bin"

echo "=== Set A: Smoke ==="
for p in "Hey Luna" "hi Luna, you up?" "good morning sunshine" "want a treat?" \
         "want to play?" "did you eat?" "the vacuum is about to start" \
         "we have to go to the vet" "come here Lulu" "rough day" \
         "good girl" "time for bed"; do
  echo "--- $p ---"
  spacekit agent infer --brain $BRAIN --prompt "$p"
done

echo "=== Set B: Discrimination ==="
for p in "want a treat?" "want to play?" "time for bed" \
         "the vacuum is about to start" "we have to go to the vet" \
         "I'll be back in a few hours" "I'm home" "rough day" \
         "no, off the counter" "good girl" "what are you looking at?" \
         "scratch your chin?"; do
  echo "--- $p ---"
  spacekit agent infer --brain $BRAIN --prompt "$p"
done

echo "=== Set C: Stress ==="
for p in "Hey Luna" "hi" "yo Luna" "hello hello" \
         "explain the borrow checker" "what is 2 plus 2" ""; do
  echo "--- $p ---"
  spacekit agent infer --brain $BRAIN --prompt "$p"
done

echo "=== Set D: Determinism ==="
for i in 1 2 3 4 5; do
  echo "--- run $i ---"
  spacekit agent infer --brain $BRAIN --prompt "Hey Luna"
done
```

Output the whole block to a file (`./test_luna.sh > results.txt 2>&1`)
to make side-by-side comparison easier.