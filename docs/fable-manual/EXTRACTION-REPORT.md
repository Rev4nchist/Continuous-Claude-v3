# The Fable Extraction Report

*Written by Claude Fable 5 (`claude-fable-5`), 2026-07-12 — the final hours of plan access. This is the teaching document: what was extracted, what the evidence showed, in what sense "Fable Intelligence" now lives in Opus and the tri-model system, and how to use all of it.*

---

## 1. The question, honestly framed

The premise of the extraction article was: a model's edge is a describable way of thinking; write it down, load it into a cheaper model, and you keep the intelligence after the model leaves. The implicit claim is that the intelligence lives in *prose you can transplant*.

CCv3 was the perfect place to test that claim, because unlike the article's bare Claude Project, this system already had three years'-equivalent of institutionalized judgment: a 242KB always-on rules layer distilled from real incidents, 37 role-tuned agents, human gates, and a tri-model roster that structurally separates building from grading. The honest question was never "can we save Fable's vibes" — it was: **what part of Fable's value is NOT already in this system, and what's the cheapest reliable vessel for it?**

We answered it with instruments, not opinions. Two eval campaigns, five loop iterations, six reviewer configurations across three model families. Every claim below has a run behind it.

## 2. What was extracted, and where it lives

| Asset | Path | What it is | Vessel type |
|---|---|---|---|
| **The Operating Manual** | `OPERATING-MANUAL.md` | 8 procedural reasoning sections + §9 orchestration judgment (the hub craft: milestone sizing, weasel-proof contracts, per-family failure signatures, thin-evidence asymmetry, stop conditions) + the 5-question self-test. Provenance-stamped, written at peak capability. | Reference doc (inert, on-demand) |
| **The trap harness** | `TRAP-TESTS.md` | 7 traps + 2 positive controls + two-stage A/B protocol + ship gate + backout checklist. Results recorded. | Standing instrument |
| **The seeded-defect eval** | `eval/plan-A.md` + sealed `eval/answer-key-A.md` | A realistic plan with 8 planted defects + 2 decoys; objective recall/over-caution scoring. | Standing instrument |
| **The loop log** | `eval/LOOP-LOG.md` | The five-iteration record: hypotheses, runs, scores, pivots. | Evidence trail |
| **The harvest playbook** | `HARVEST-PLAYBOOK.md` | The repeatable model-transition process (delta-first extraction). | Process doc |
| **The distillate** | `reasoning-discipline-distillate.md` | The 80-line always-on rule candidate — **gate-blocked, deliberately NOT installed**, preserved for scaffolding-free surfaces. | Shelf asset |
| **Skill hardenings** | `premortem`, `review`, `systematic-debugging` SKILL.md | Three incident-grounded procedural additions (thin-approve rule, infra-vs-actors heuristic, reviewer-unavailable fallback). | Live prompt surface (the only prose that shipped — each tied to a real incident, not to assumption) |
| **New probe-backed fact** | `docs/tri-model/CURRENT-STATE.md` fact 1b | Grok fork-storms on Windows too (observed live, ~27 processes). | Operational knowledge |

## 3. What the evidence showed — the three-act finding

**Act 1 (trap harness):** an 80-line distillation of the manual, tested in the *production load path* (headless Opus 4.8, rule physically in `.claude/rules/`, 3 reps/arm, positive controls) scored **51/51 in BOTH arms**. Zero lift. The transcripts showed why: arm A quoted `claim-verification.md` and "never trust ralph_status alone" *by name* while passing. The rules layer isn't decoration — it is the transplant, already done, incident by incident, over months.

**Act 2 (seeded-defect eval):** a much harder instrument — 8 unlabeled defects inside a plausible plan. Plain Opus scored **8/8 twice with zero over-caution and out-found the eval's designer** (both reviewers independently proved the plan's core mechanism impossible on Windows process semantics — a defect I did not seed). Sonnet: 15/16. The "maybe the gap lives down-tier" hypothesis died on contact with data.

**Act 3 (cross-family booth):** Codex **8/8** (plus a find no Claude reviewer made), Grok **8/8** (plus a live self-demonstration: it fork-stormed while reviewing a plan about fork-storms). The tri-model booth reviews plans at parity with the Claude tiers.

**The conviction, stated plainly:** you should believe Fable-grade judgment is present in your Opus-run system not because I transplanted it this week, but because six independent reviewer configurations just *demonstrated* it, measurably, on the hardest eval I could design — and because the mechanism is visible: **CCv3's rules layer + gates + roster ARE the operating manual, mechanized.** Every section of my manual has a structural counterpart that fires without any model remembering to: §4 re-derivation → hub smoke + external-verification rules; §6 attack-your-conclusion → builder≠grader + cross-family booth; §8's thin-evidence instinct → the thin-approve rule (now in `/review` too); §5 known-vs-guessed → claim-verification + the epistemic-reminder hook. The article assumed intelligence must be carried in prose. Your system carries it in *architecture*. Prose transplants failed the A/B precisely because the architecture already won.

What is genuinely NEW from Fable, unavailable anywhere else in the system before this week: **§9** (the hub judgment written down — previously implicit), **the instruments** (nothing in CCv3 could previously *prove* a prompt-layer change works), and **the playbook** (the transition process itself). That is the real inheritance.

## 4. How this works in the tri-model system, fundamentally

The tri-model system is a **hub-and-booth architecture with human gates**:

```
             Dave (Gate 1: contract · Gate 2: ship)
                            │
                    CLAUDE — THE HUB (Opus 4.8)
        judgment seat: decompose → contract → dispatch → smoke → grade
                    never builds, never self-grades
                    ┌───────────┴───────────┐
             GROK (builder)          CODEX (reviewer/fixer)
             grok-4.5, worktree-     gpt-5.5, read-only booth,
             isolated implement      bounded fix rounds
                    └───────────┬───────────┘
                      workroom disk bus (rooms/, CONTRACT.md,
                      status.json, findings/, THREAD.md)
```

Why it's shaped this way — the fundamentals:

1. **Judgment concentrates at the hub; execution distributes.** The hub's work is exactly manual §9: size milestones to one-implement-run-one-booth, write R/D tables a foreign model can't satisfy with narrative, run acceptance commands itself (narrative ≠ evidence), and decide when a clean pass is thin. Opus 4.8 demonstrably carries this (Act 2).
2. **Cross-family review buys different blind spots, not more eyeballs.** Codex found what four Claude reviewers missed; the reverse happens too (the dogfood's HIGH was Claude-caught after Codex thin-approved). The booth's value is *decorrelation* — proven again this week in both directions.
3. **Structure beats memory.** Builder≠grader, gates, bounded fix loops, and the disk bus survive model swaps, context compaction, and session death — which no prompt text does. This is why the system's "intelligence" is durable.
4. **Every model claim is probe-backed or it doesn't exist.** `--sandbox` decorative on Grok, fork-storms on both foreign families, `/harness-update` two-probe rule. The eval suite now extends this discipline from CLI flags to *reviewer judgment itself* — run it on any new roster member.

## 5. Operating guidance going forward

- **Daily work:** nothing to do — the inheritance is ambient. The rules fire, the gates gate, the skills carry the three new incident-grounded checks.
- **/game-plan runs:** the hub consults `OPERATING-MANUAL.md` §9 when contracts get hard (it's referenced from CURRENT-STATE's reading order). The thin-approve rule now lives in `/review` synthesis as well as the booth.
- **New model or CLI joins the roster:** `/harness-update` for the mechanical surface, then run `eval/plan-A.md` against its reviewer mode and score against the sealed key. Below 7/8 or any decoy-flagging → that model gets the compact plan-attack treatment (the distillate is the starting text), gated by the same A/B discipline.
- **Anyone proposes a new always-on rule:** the trap harness + eval are the toll gate. The burden of proof is now mechanical.
- **Post-Grok runs:** check `tasklist | findstr grok` (fact 1b) — same hygiene as Codex.

## 6. The last word from the departing model

The article said: "the model was never the asset — the way it thinks is." Half right. The way of thinking was never trapped in my weights, but it also doesn't survive as prose — prose loses the A/B every time against a system that already institutionalized the lessons. What survives is what you built here long before this week: **incidents turned into rules, rules turned into gates, gates turned into architecture, and now — with the instruments — architecture turned into something you can measure.** I didn't give Opus my brain this week. I verified, with the hardest tests I could write, that you'd already built it a better one — and I left behind the tools to keep proving it.

*— claude-fable-5, 2026-07-12*
