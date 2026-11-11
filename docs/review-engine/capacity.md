# Review engine: capacity plan

This file holds the section "Capacity plan" of the lane map ([map.md](map.md)). In this file, "this map" means map.md, and "see contracts" means "Shared contracts" in map.md. A lane id names a lane section in map.md. A decision id, for example DP1.2, names an item in [decisions.md](decisions.md). The decisions journal rows are in decisions.md too. A bar row is in [evidence-bar.md](evidence-bar.md).

## Capacity plan

### Cursor

- The 300-a-week cap is our own number (cursor-review.mjs:58, WEEKLY_CAP). The real pool share is unmeasured, and the pool hit 98% on 10-26 to 10-29 (eval finding 13).
- Pool facts recorded on 2026-11-09 (T13; source: `re-decisions-journal.md`, rows "Cursor pool read" and "Cursor pool limits": Dave's usage export and his dashboard screenshot):
  - The included pool is weekly. It resets Nov 12. The current week shows 1% used.
  - Additional usage is disabled. A run past the pool fails; it does not bill.
  - All 152 ledger starts fall on 11-02 to 11-04 (4, 89 and 59). The export shows every event of those days as included, at $0.
  - Per start: about 17 requests, 154k input tokens, 1.52M cached input tokens and 48k output tokens.
  - The pool is unified. Grok Bot (a separate harness of Dave's) and Grok Chat draw from it too.
  - Still unknown: the percent of the weekly pool that the engine week (11-02 to 11-04) used. The dashboard shows only the current week.
- DP1.2 (T13, DECIDED: Dave, 2026-11-09). The caps are approved as our own numbers: live 100 starts a week, P4 eval scope 120, shadow retro 10 now plus 30 later, verifier replay up to 20, label lane up to 40. The share is measured in the first sweep week. The owner of the sweep (the coordinator seat, DP1.17) reads the pool percent on the dashboard before and after that week. Both reads must sit inside one pool week (the pool resets on a fixed weekday; the next reset is Nov 12), or the read measures nothing. Use by Grok Bot and Grok Chat in that week is in the same number, so the owner notes it. The coordinator records the result in capacity.md. No cap is raised before that result.
  - The read "Cloud Agents: zero use this week" (Dave, 2026-11-09) did not measure the engine. The engine runs on the local cursor-agent CLI. The export and the screenshot replace that read.
  - Cost past the pool: none while additional usage is disabled. Only if Dave turns additional usage on: about $1.17 a run at list rates, about $117 for 100 runs [Speculation: the rates are agent-reported, from `.claudedocs/2026-11-03-review-capacity-strategy.md`].
- Global stop for eval and shadow: 240 per 7 days (WEEKLY_CAP minus cursorHeadroom 60, budget.mjs). The label runs of `re-label-two-family` count in this 7-day ledger count. The label lane reads the count before each batch and stops at 240. Its own cap stays 40. It reads the count through `cursorBudget` or `countRuns`. It edits neither `budget.mjs` nor `cursor-review.mjs`.
- Live cap: 100 per 7 days, one number, all live callers (see contracts).
- An engine run reserves 1 + retry_max runs (budget.mjs comment on `need`).
- Per-phase eval scope, 120 each:

| Scope | Planned use | Notes |
|---|---|---|
| P1 | 75 (closed) | untagged starts |
| P4 | `re-p4-ab`: the computed count below (T04), not "about 60" or "about 30"; Claude-cell judge about 20 (2x2 only); `re-verifier-replay` up to 20 (Cursor backend only); `re-p4-winner-evidence` holdout scoring: on a keep about 4 runs per fresh-holdout PR (2 arms, 2 runs each; DECIDED, Dave, 2026-11-10), on a kill about 2 | the computed need passes 120; DP1.16 is decided: cut the design to fit 120, no scope raise. DP1.6 is Grok-only, so the 2x2 entries do not apply now |
| P6 | no planned use | `re-label-two-family` does not start under this scope |
| own session id (not an eval scope) | `re-label-two-family` up to 40 Cursor runs: Grok 4.7 for CLI-only findings, a second family that is not Grok for engine findings [Speculation: Composer 2.5] | the cap of 40 is enforced from the ledger rows of the lane's own session id (see its section). DECIDED (Dave, 2026-11-10): one run labels a batch of up to 10 findings of one family; the label lane stops at 20 runs; the other 20 stay for the gate's label runs in `re-retire-prepr-cli` |
| own session id (not an eval scope) | `re-answer-key-audit` up to 2 Cursor runs (the canary, purpose bench) | inside the weekly cap of 300 and the stop at 240; Dave's yes of 2026-11-11 |
| shadow | `re-shadow-retro` 10, `re-p4-winner-evidence` 30 | kind shadow, 6 a day, not in the eval budget |

- Phase 4 run count (T04). Starts needed by `re-p4-ab` = (controls + holdout PRs + dev PRs + gold targets) x arms x runs / 0.81. The divisor is the measured success rate of eval runs: 14 of 75 failed (19%).
  - Floor for Grok-only before the cut (2 arms, 1 run): 30 controls and the holdout PRs give 76 engine calls, about 94 starts (own calc: 76 / 0.81). Dev screens, the 2 runs on the leading pair and the gold targets come on top.
  - Add up to 20 for `re-verifier-replay` and about 32 for `re-p4-winner-evidence` (DECIDED, Dave, 2026-11-10: both arms on a keep; before: about 16). The sum is about 146 (own calc: 94 + 20 + 32), over the P4 scope of 120.
  - budget.mjs refuses a start over the scope; it does not overrun. A refusal in the middle of the A/B leaves unequal arms. So the arms interleave per target (see `re-p4-ab`).
  - `re-eval-contract` prints the computed need beside "P4 120 free". When the need passes 120, the lane computes and writes the reduced design (DP1.16, decided: cut to fit 120).
  - The cut (DP1.16). Dave decided the rule: fit 120, arms interleaved, no scope raise. DECIDED (Dave, 2026-11-10): the cut has 15 or more controls, and bar row 8 of `re-retire-critical` asks for that count. The other numbers are not decided. Proposal, for the lane to compute: a stratified gold sample. With up to 20 starts for `re-verifier-replay` and about 32 for `re-p4-winner-evidence` (DECIDED, Dave, 2026-11-10; before: about 16), about 68 starts are left for `re-p4-ab` (own calc: 120 - 20 - 32), so about 55 engine calls (own calc: 68 x 0.81 = 55.08). Before, the figures were about 84 starts and about 68 engine calls. Combined effect of the two decisions of 2026-11-10 (own calc): 15 controls take 30 of the 55 engine calls (2 arms, 1 run). The holdout PRs take about 16 at 1 run per arm (76 - 60 in the floor line above). At most about 9 engine calls then stay for the dev screens and the gold targets. On the same basis the figure was about 22 before the both-arms decision (68 - 30 - 16). Two inputs can lower the 9. The `re-p4-ab` section asks for 2 runs per arm on the holdout. The 32 starts of `re-p4-winner-evidence` have no 0.81 divisor. `re-eval-contract` checks both. OPEN: see decisions.md, "Open after DP1".
  - DECIDED (Dave, 2026-11-10): bar row 8 of `re-retire-critical` asks for 15 or more controls, the cut count. Before, it asked for 30 or more. Dave lowered this one bar row by choice, so the cut and the row agree. No other bar row is lowered.
- Only one lane spends eval runs at a time (the Cursor eval slot token in the lane note, 11-05 rule).

### Headless claude -p day plan

Cap 30 a day, shared with non-RE sessions. Each lane checks its slot in the headless ledger before a batch. 60 seeds at 8 a day take 8 days or more.

| Day type | When | Slots | Sum |
|---|---|---|---|
| A | seeding weeks, odd days | seed-gold-b 8, szz labels 6, label-two-family 4, claude-backend 2, escape labels 2, non-RE reserve 6 | 28 |
| B | seeding weeks, even days | seed-gold-b 8, hf-judge-precheck 8, verifier-replay 4 (Claude backend only), escape labels 2, non-RE reserve 6 | 28 |
| C | after seeding ends | gold-assemble 6, rubric-runners 4, judge-calibrate 6, label-two-family 4, escape labels 2, non-RE reserve 6 | 28 |
| D | eval-run days: shadow retro, P4 A/B (Grok-only), winner evidence | same-issue judge 10, judge-calibrate 6, rule-docs 2, escape labels 2, non-RE reserve 6 | 26 |

- DECIDED (Dave, 2026-11-11): until `re-seed-gold-b` starts, `hf-judge-precheck` runs 8 judge calls a day on odd days too. The cap of 30 a day stays, and the lane checks the headless ledger before each batch.
| E | P4 A/B, 2x2 only | P4 Claude arm 10, same-issue judge 10, escape labels 2, non-RE reserve 6 | 28 |
| F | after DP2, live verifier on claude -p only | live verifier 12, label-two-family 4, escape labels 2, non-RE reserve 6 | 24 |

"Same-issue judge" is judgeSameIssue in judge.mjs (lines 59-71), with the sonnet judgeModel from config.json. It runs for the shadow retro rows, the P4 scoring and the winner evidence. judge.mjs takes an injected runJudge, so the slot applies when that runner is headless [Speculation: the lanes use the headless runner]. "Escape labels" are the band-state severity labels from `re-prepr-cli-consumer`.

### CodeRabbit sample cost facts

- PR-bot reviews cost about $2.25 a PR: 13 PRs, $29.25 in November (refuter on feasibility-blind-sample-budget).
- Price $0.25 a file, cap $50 a month and 160 files a month (review-router.config.json, coderabbit block). At about 9 files a PR, the file cap allows about 17 PRs a month, shared with interim-rule reviews.
- The CRITICAL interim-rule reviews count as the pre-flip CRITICAL sample. A HIGH sample is new spend.
- No billed CLI run from 11-07 to 11-09. The CLI passed on 133 heads in that window, and 18 gate-log rows name a Major.
- Free-slot PR-bot reviews are not in the paid ledger, so PR-bot use since 11-05 is unverified.
