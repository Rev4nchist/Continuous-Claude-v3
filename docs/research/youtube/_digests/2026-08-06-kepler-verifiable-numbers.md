---
digest_id: 2026-08-06-kepler-verifiable-numbers
date: 2026-08-06
type: brief
title: "The model may never emit the number — a dissent against Pillar 1's verification lane"
topic: "provenance, deterministic substrate, why evals are not verification"
channels: "AI Engineer"
verdict: watch
videos: 1
citations: 17
corpus_path: docs/research/youtube/ai-engineer
---

# The model may never emit the number

**Scope.** One talk — *How Kepler Built Verifiable AI for Financial Services*, Vinoo Ganesh
[vid:Tt2kX2sgQio] — read against Pillar 1 of the Carly & Christian weekly sponsor update. Already
in the corpus since 2026-07-29 and never cited. Out of scope: the FDE track by the same speaker,
which shipped separately in the 2026-08-06 digest.

**Why it matters more than a normal single talk.** Every other verification row in Pillar 1 —
D-7's 13-role rubric on live traffic, D-8's trajectory check, D-11's pre-build gate — has a model
somewhere in the loop deciding whether the output is good. This talk argues that for any output
carrying a number, that entire shape is category-wrong, and it says so in one line: *"Evals are
not verifiable. You cannot take a non-deterministic LLM and eval your way to something
deterministic"* [vid:Tt2kX2sgQio @1:52].

That is a dissent, not a gap. It deserves a card because Fourth's connectors return numbers.

## 1. What the source actually demonstrates

Nothing is run on stage. This is slides and narration throughout — grade `R`, and `ⓥ` on every
row, because the speaker is Kepler's CEO and the talk describes Kepler's platform.

**The mechanism.** Three tenets: atomic provenance, scope determinism, derivation chains
[vid:Tt2kX2sgQio @9:23].

- The model writes a **reference** to a number and is barred from writing or manipulating the
  number at all [vid:Tt2kX2sgQio @10:47]. Code writes the value. A deterministic check strips any
  figure that cannot be independently verified before it reaches a human [vid:Tt2kX2sgQio @11:15].
- **Scope determinism:** the model decides *what* to compute and never computes
  [vid:Tt2kX2sgQio @12:38]. Stated side effect: it is also cheaper.
- **Derivation chains:** the chain of events behind one figure is stored so the answer can be
  replayed and rewound [vid:Tt2kX2sgQio @14:14, @14:27].
- An explicit allow-list of what the system may and may not produce; it refuses extraction from
  prose or raw tables [vid:Tt2kX2sgQio @14:39, @14:56].

**The argument against model-checks-model.** *"These are not probabilistic systems evaluating each
other's work"* [vid:Tt2kX2sgQio @11:43]. He grounds it in his own numbers: their fine-tuned
extractor beat foundation models at 94%, and he asks who would trade on 94% — a wrong number is
still wrong if you are in the 6% [vid:Tt2kX2sgQio @10:18, @10:33]. Citations, he says, got the
field about halfway [vid:Tt2kX2sgQio @18:47]; showing where a number came from is not the same as
proving it is right [vid:Tt2kX2sgQio @6:09, @6:40].

**The one independent, non-vendor corroboration** in the corpus arrives from a different field for
a different reason: models always claim they succeeded, so vulnerability work is graded by a
deterministic oracle rather than a model's judgment [vid:ZFxh7sqbUZo @7:33, @14:01].

**Asserted, and marked as such.** The pre-SSL analogy, the "inevitable" framing, and the claim
that this generalises to law and drug discovery are all `A`. They carry nothing.

## 2. Gap vs what Pillar 1 says today

Pillar 1's verification lane checks whether an *answer* is good. It has no row anywhere that
checks whether a *number* is right. D-7 grades conversations against a rubric; D-8 reads the path
taken; D-11 gates the build. A connector that restates an hours figure or an invoice total wrongly
passes all three, because all three ask a model.

## 3. Verdicts

| Idea | Verdict | Rationale | Citation |
|---|---|---|---|
| Provenance contract on connector numeric fields — model references, code emits | **PILOT** (card D-13, drafted in the handoff) | One `ⓥ` mechanism source plus one non-vendor row for the underlying principle. Clears PILOT, nowhere near ADOPT. | [vid:Tt2kX2sgQio @10:47], [vid:ZFxh7sqbUZo @7:33] |
| "Evals are not verifiable" as a challenge to D-7 | **WATCH** — record the dissent, do not act | One vendor's framing against a lane with four cards already committed. Worth stating in the read so the sponsor sees the disagreement. | [vid:Tt2kX2sgQio @1:52] |
| Derivation chains replayable per answer | WATCH (folds into D-8) | Same storage question D-8 already carries; no new evidence, just a second voice for queryable-not-flat. | [vid:Tt2kX2sgQio @14:27] |
| Extraction allow-list (never from prose or raw tables) | SKIP for now | Real, but Fourth's connectors read structured APIs, not PDFs. No consumer. | [vid:Tt2kX2sgQio @14:56] |
| "This generalises to every industry" | SKIP | Assertion, seller, no evidence. | [vid:Tt2kX2sgQio @15:36] |

## 4. Integration sketch

Not applied. The card is written out ready to insert in
`thoughts/shared/handoffs/fourthos-session-prep/2026-08-06_06-46_pillar1-kepler-provenance.yaml`,
because another session holds the briefing. Knowing it worked: D-13 appears in the C&CB Pillar 1
docket with a named connector field set, and its `Wrong if` gets answered — either connectors
already pass figures through untouched, or they do not.

## 5. Sources

| Video | Uploaded | Track | Key timestamps |
|---|---|---|---|
| [How Kepler Built Verifiable AI for Financial Services — Vinoo Ganesh](https://youtu.be/Tt2kX2sgQio) | 2026-07-29 | auto | [1:52](https://youtu.be/Tt2kX2sgQio?t=112), [10:47](https://youtu.be/Tt2kX2sgQio?t=647), [12:38](https://youtu.be/Tt2kX2sgQio?t=758), [14:56](https://youtu.be/Tt2kX2sgQio?t=896) |
| [Teaching AI to Find Real Vulnerabilities — Prof. David Brumley, Bugcrowd](https://youtu.be/ZFxh7sqbUZo) | 2026-08-01 | auto | [7:33](https://youtu.be/ZFxh7sqbUZo?t=453), [14:01](https://youtu.be/ZFxh7sqbUZo?t=841) |

**ASR caution.** Auto-captions. "Providence ledger" at [vid:Tt2kX2sgQio @11:29] is *provenance
ledger*; "tenants" is *tenets*; "Polarys"/"Opus 48"/"GLM 52" are mangled product names and are not
quoted anywhere above. The three tenet names come from the transcript [vid:Tt2kX2sgQio @9:23]; the
published description names the third differently ("every extracted number like a pull request"),
which is the analogy he uses later [vid:Tt2kX2sgQio @19:00], not the tenet. Every timestamp here
was re-verified against the corpus file.
