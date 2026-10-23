# Model-Harvest Playbook

How to extract durable value from a departing model — or calibrate an arriving one — without shipping token-cost that changes nothing. Distilled from the Fable 5 harvest (2026-07-11/12): two eval campaigns, five loop iterations, one always-on rule *prevented*, one live cross-model discovery. Run this at every model transition (departure, arrival, or major version bump) and after any large prompt-layer change.

## The one principle

**Extraction is delta-first.** Never write prompt text for a successor until you have measured the successor's actual gap. Prose written from assumption becomes either duplication (the successor already does it — you pay tokens forever for nothing) or theater (it recites without behaving). The Fable harvest proved both directions: an 80-line distillation of genuinely excellent procedures measured **zero lift** because CCv3's incident-derived rules + current Claude models already saturate the behaviors.

## The procedure

1. **Harvest the irreplaceable first (time-boxed).** If a model is departing, capture what only it can author — self-articulated judgment (operating manual), domain sections no doc covers (e.g., orchestration judgment) — into `docs/`, commit immediately. Docs are inert: no gate needed, no per-session cost. Stamp provenance (exact model id, date, live-session verification).

2. **Build the gap instrument before the transplant.** Two proven shapes, in escalating difficulty:
   - **Trap battery** (`TRAP-TESTS.md`): single-defect, single-turn rigged questions + positive controls. Fast; saturates easily — treat saturation as data, not failure.
   - **Seeded-defect artifact** (`eval/plan-A.md` + sealed key): a realistic plan/diff with N planted defects across distinct classes + good decoys. Scores recall AND over-caution objectively. Much higher ceiling — and even this saturated for all four current reviewer families (47/48 aggregate).
   Rules that made these decisive: ≥2-3 reps per arm, positive controls (an artifact must not win by paranoia), production-faithful load path (headless `claude -p` with the text physically in the rules dir — prompt-prepend is NOT the shipped mechanism), sealed answer key (quarantine it OUT of the repo when reviewers have file access), pre-registered ship gate.

3. **Test every tier and family that has production surface.** Opus tier ≠ Sonnet tier ≠ Codex ≠ Grok. The gap you assume lives down-tier or cross-family may not exist (it didn't: Sonnet 15/16, Codex 8/8, Grok 8/8). Each arm is cheap; the assumption is expensive.

4. **Gate the wiring on measured lift.** Always-on rules, agent-prompt blocks, and template lines ship ONLY when arm B beats arm A on cases A fails, with no positive-control regression. No lift → docs-only ship, outcome recorded as `no_lift` with n-runs and provenance (memory type `ARCHITECTURAL_DECISION` or `FAILED_APPROACH`). Never let a contaminated or single-run A/B freeze a false "it worked" precedent.

5. **Bank the by-catch.** Instrumented runs surface operational facts no prompt text can (here: Grok fork-storms on Windows — observed live during its own review). Route facts to their canonical homes (CURRENT-STATE probe-backed facts, safety rules), not to the harvest docs.

6. **Keep the instrument, retire the assumption.** The eval suite is the permanent asset: re-run it when a new model id joins the roster (pair with `/harness-update`), when effort/tier policy changes, or when someone proposes a new always-on rule. The signal to act on: recall notably below the saturated baseline (≤6/8) or over-caution above 0 — neither of which the current stack has ever shown.

## Cost table (what the Fable harvest actually spent vs saved)

| Item | Cost | Return |
|---|---|---|
| Manual authorship (Fable session) | ~1 session | Permanent §9 hub-judgment doc + self-test |
| Trap harness build + 2-stage A/B | ~12 short runs | Prevented ~1,360 tokens × every future session, forever |
| Seeded-defect eval + 6 reviewer arms | ~6 agent runs | Calibration instrument + Grok fork-storm fact + parity proof for the booth |
| Always-on rule (NOT shipped) | 0 | — (this row is the point) |

## Anti-patterns (each observed or narrowly avoided)

- **Prose-first transplant**: pasting a "brain dump" into always-on context without an A/B. (The article's method; refuted here twice.)
- **Trap-pass victory lap**: declaring transplant success because the treated arm passes — when the untreated arm passes too. Always run the control.
- **Designer-as-scorer without a sealed key**: recall scoring must be against pre-registered defects, mechanically phrased.
- **Skill-hardening as tribute**: rewriting already-procedural skills to feel thorough. Only incident-grounded gaps earn a diff; "no change needed" is a finding.
- **Ignoring the by-catch**: the most valuable single output of this harvest was an unplanned operational fact. Watch the runs, not just the scores.
