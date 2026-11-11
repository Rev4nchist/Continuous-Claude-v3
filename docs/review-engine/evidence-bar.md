# Review engine: evidence bar

This file holds the section "Evidence bar" of the lane map ([map.md](map.md)). In this file, "this map" means map.md. A lane id names a lane section in map.md. A decision id, for example DP3.1, names an item in [decisions.md](decisions.md). "Capacity plan" is in [capacity.md](capacity.md).

## Evidence bar

The 11-05 bar (11-05 map, re-cr-retire-gate section) is rewritten per gate. No row is lowered unless the row says it is Dave's choice.

### What counts as a sample

- **CLI gate.** A sample is a PR with a same-head pair: an engine record and the pre-pr CodeRabbit CLI output for the same head SHA. All heads of one PR form one cluster. A CLI-only real Major on any head counts as one event for that PR. A CLI Major on a head with no engine record cannot be matched. The gate doc lists each such head, and `re-live-accrual` keeps them under 10% of the CLI-Major heads in the window (T03).
- **CRITICAL gate.** CRITICAL stays on the CodeRabbit PR bot under the interim rule for now (DP1.14, Dave 2026-11-09). The paid sample, its owner and its budget are decided when `re-p4-winner-evidence` is done on the frozen version. Before the flip, a sample is a CRITICAL PR that got the CodeRabbit PR bot under the interim rule, paired with the engine record on the reviewed head. After the flip, the blind sample (`re-gate-summary-sample`) is the sample. A HIGH sample would be new spend, and this map plans none.
- **Which rows count.** Only rows whose record carries the frozen engineVersion (and, for CRITICAL, the frozen bandVersion). CLI gate (path F, DP1.5, decided): the frozen engine SHA. It is the `main` SHA right after `re-critical-model-check` lands (`decisions.md`, "Open after DP1", point b). CRITICAL gate: `re-p4-ab` freezes the version (cli freeze, after DP2.1). `re-p4-winner-evidence` confirms it on the fresh holdout and writes the first holdout.json row. Rows labelled "rehearsal" feed load, capacity and READY report-only data only.
- **Counted weeks.** At least 4 weeks per gate, 2 eligible weeks in a row at the end. The window opens only after every lane that changes the gate's freeze set has landed. Exception: for the CLI gate (path F, decided), the pinned engine copy replaces this rule. The count starts at the first sweep that runs the frozen copy (Dave, DP1.5: "count from the first sweep"), and later engine PRs do not reset it. The frozen SHA must be on record before that sweep; the decisions journal does not name it yet. DECIDED (Dave, 2026-11-10): the counted set of the CLI gate closes on a stated end date, and bar row 3 is scored 30 days after the last merge in that set. OPEN (not decided): the definition of an eligible week for the CLI gate. Only shadow decide defines an eligible week today, in code (shadow.mjs, decideBand).

### Provable-bar table (B4)

The bar reads "at most k CodeRabbit-only real Majors in n sampled PRs". Pick the bound at DP3. Pool bands only when Dave says so at DP3.

| Bound (95%, one-sided) | 0 events | at most 1 | at most 2 | Source |
|---|---|---|---|---|
| 5% | n of 60 or more | n of 95 or more | n of 126 or more | eval B4 (rounded up) |
| 10% | n of 30 or more | n of 47 or more | n of 62 or more | own calc: exact binomial minimum n is 29, 46 and 61; rounded up by 1 |

The 11-05 row "at most 1 real Major per 20 sampled PRs" has an upper bound near 25% (eval finding 9). Both rows above are stricter.

### Pass forecast (E01)

This table gives the chance that the engine passes each row of the provable-bar table. Dave saw the forecast note before he answered DP1.5 on 2026-11-09 (decisions journal). He must see the table again before he answers DP3.1.

- Model: each sampled PR has a CodeRabbit-only real Major with chance p = (share of PRs with a Major) x (share of those Majors that are real) x (1 - engine recall). PRs are independent. P(pass) is the binomial chance of at most k events in n PRs.
- The model counts one Major per PR. That is a lower bound on misses, so the real chance is not higher than the table.
- Source: `measure-pass-forecast.mjs` and `measure-pass-forecast.out.json` in the premortem scratch folder (path in the premortem file). Certainty 3: a read-only calculation, not a replay.
- Each cell shows two values: real share 1.0, then real share 0.5. The real share is not measured.
- Today's measured same-issue recall is 10 of 20 (0.5). Recall 0.8 and 0.9 are targets, not measurements.

Major rate from the pre-pr CLI log: 15 of 103 branches with a CLI review had a Major on some head.

| Row | Recall 0.5 | Recall 0.8 | Recall 0.9 |
|---|---|---|---|
| 5%, 0 events in 60 | 1% / 11% | 17% / 42% | 42% / 65% |
| 5%, at most 1 in 95 | 0.6% / 14% | 23% / 60% | 60% / 85% |
| 5%, at most 2 in 126 | 0.4% / 16% | 29% / 72% | 72% / 94% |
| 10%, 0 events in 30 | 10% / 33% | 41% / 64% | 64% / 80% |
| 10%, at most 1 in 47 | 13% / 49% | 60% / 85% | 85% / 95% |
| 10%, at most 2 in 62 | 16% / 61% | 73% / 94% | 94% / 99% |

Major rate from the PR-bot dataset: 12 of 40 PRs have a real Major.

| Row | Recall 0.5 | Recall 0.8 | Recall 0.9 |
|---|---|---|---|
| 5%, 0 events in 60 | 0% / 1% | 2% / 16% | 16% / 40% |
| 5%, at most 1 in 95 | 0% / 0.5% | 2% / 22% | 22% / 58% |
| 5%, at most 2 in 126 | 0% / 0.3% | 2% / 27% | 27% / 71% |
| 10%, 0 events in 30 | 1% / 10% | 16% / 40% | 40% / 64% |
| 10%, at most 1 in 47 | 0.4% / 12% | 22% / 59% | 59% / 84% |
| 10%, at most 2 in 62 | 0.3% / 15% | 27% / 72% | 72% / 93% |

Reading for the v1 engine (recall 0.5): a 5% row passes with a chance of 16% or less, and a 10% row with a chance of 61% or less. At real share 1.0 no row passes with a chance above about 16%. Even odds at the 5% bound need recall near 0.9 or higher. The stop rule that follows from this is DP2.8. Dave asked for it at DP1.5.

### re-retire-prepr-cli bar

Rows 1, 2 and 4 rest on model labels. Gold A and Gold B stay the only outcome truth (E04). The gate doc says so beside each of these rows.

1. CLI-only real Majors under the table row Dave picks, over the counted PRs. The gate doc prints n and the events for each risk band. The pooled figure weights each band by its share of the heads the CLI reviews (T05). A band that the sample does not cover is named, and row 1 does not pass for that band. Tie rule (E04): a CodeRabbit-only Major counts as real unless both label families say noise.
2. Engine precision: point estimate 0.78 or higher and Wilson lower bound 0.65 or higher, on 30 or more labels.
3. 0 escapes linked to a CLI-only finding in the counted weeks. A PR's escapes count only 30 days after its merge, because fix-chains blames a fix to a PR merged in the 30 days before it (T19). A counted PR that is younger than 30 days makes the row NOTE, not PASS. The row is also NOTE when no link writer ran (T06). DECIDED (Dave, 2026-11-10): the counted set closes on a stated end date. Row 3 is scored 30 days after the last merge in that set, and it gates the flip. The bar stays.
4. Labels from a calibrated judge. Route J (11-05 bar; Dave's choice at DP1.8, 2026-11-09): `re-judge-calibrate`, 60 or more labels, TPR and TNR 80% or higher, both families. Route T (the `re-label-two-family` set alone, at kappa 0.6 or higher) is not chosen. It would lower the 11-05 calibration bar.
5. Freeze: the reviewer set does not change for the counted rows. Under path F the pinned engine copy guarantees this.
6. Capacity: live runs stay under the live cap, and the weekly Cursor load stays under 240.
7. Coverage, per risk band (T05): an engine record exists at the pre-pr head for 90% or more of the heads that the CLI reviews today in that band. The demotion is per band (DP1.15, Dave 2026-11-09), so a band under 90% is not demoted and stays out of the band list. The CLI reviewed 139 heads in 54 hours (about 430 a week), and the live cap is 100 starts a week. So this row cannot pass for every band at this cap (DP1.2, decided: the cap stays 100 until the pool share is measured). The flip PR lists only the bands that pass.

`scripts/eval/review-eval/cli-gate.mjs` (`re-label-two-family`) computes rows 1 to 4 and prints the source file of each number (T06).

### re-retire-critical bar

Rows 1, 2, 3 and 9 rest on model labels. Gold A and Gold B stay the only outcome truth (E04). The gate doc says so beside each of these rows.

1. 0 CodeRabbit-only real Critical findings. CodeRabbit-only real Majors under the table row Dave picks.
2. Precision: point 0.78 or higher and Wilson lower bound 0.65 or higher. 20 or more Majors and 30 or more labels in the band (11-05).
3. shadowRecall on CodeRabbit findings: engine at least equal to CodeRabbit on the union set (11-05 row, renamed).
4. CodeRabbit-independent recall (B6): engine same-issue recall on Gold A real Majors, with its CI. Report only until the real-Major floor is set from the `re-szz-miner` yield. Do not score CodeRabbit on Gold A: the miner drops pairs with an earlier CodeRabbit comment, so CodeRabbit scores near 0 there by construction.
5. Seeded (Gold B) and real (Gold A, adjudicated CodeRabbit) Majors reported apart. Gold B never sets the headline.
6. Paired bar: OPEN, see below.
7. Fresh holdout: `re-p4-winner-evidence` scores the frozen version once. 0 lost caught Majors. A lost Major is one that 2 of 2 baseline runs catch and 2 of 2 candidate runs miss (T20, see `re-p4-ab`). DECIDED (Dave, 2026-11-10): on a keep, `re-p4-winner-evidence` runs both arms (v1 and the v2 winner), 2 runs each, on each fresh-holdout PR. The v1 runs are the baseline. The row stays as written. On a kill the row is not applicable, because the candidate equals the baseline.
8. Clean controls: false Majors per clean PR, with its CI, not above the v1 arm on the same 15 or more controls (from `re-p4-ab`, not from stored P1 dirs). DECIDED (Dave, 2026-11-10): the row asks for 15 or more controls, the count of the phase 4 cut (DP1.16). Before, it asked for 30 or more. Dave lowers this one bar row by choice.
9. Judge calibrated: 60 or more labels, TPR and TNR 80% or higher, both families (11-05). Real-label calibration: OPEN, see below.
10. securityEscape 0, waivers 0, escapeRate at or under the frozen per-band baseline (11-05).
11. Capacity: runs per PR p50 and p90, weekly Cursor load under 240.
12. A flip PR changes only coderabbit.* keys and no gate list (test in the gate lane).
13. Hold: the second flip waits 4 weeks after the first flip, in either order. This is a bar row, not a table edge.

### OPEN items

- **Paired-bar sample size (B7).** Let d be the share of items on which the arms differ. A lower bound above -5 pts needs about 1537 x d items: about 307 at d = 0.2 (own calc, normal approximation). The plan has about 50 gold Majors. Options for Dave at DP3:
  - (a) Drop the row. Gate on the per-class recall, lost-caught-Major and clean-control rows only.
  - (b) Keep it as a report row (NOTE), never gating. Recommended.
  - (c) Grow the item set toward about 300, mostly from Gold B seeds. Cost: headless seed slots for several weeks [Speculation].
  - (d) Loosen the margin to -10 pts: about 384 x d items, about 77 at d = 0.2. This lowers the 11-05 bar.
  - Timing (T20): Dave answers this item before DP2.1, because the keep-or-kill needs a gating rule. Ask DP3.5 together with DP2.1.
- **Judge calibration on real labels (B9).** Judge agreement is n=0 on real findings (p1-results.md:42). Calibration is planned on seeded truth only. Options for Dave at DP3:
  - (a) Use the `re-label-two-family` set as the real slice. A judge gates only when it reaches TPR and TNR 80% or higher on the seeded set and on 60 or more real labels. Recommended.
  - (b) Calibrate on seeded truth only, and mark every "real Major" row NOT-GATING.
  - Dave labelling a slice is not an option: he does not label code findings (memory file `dave-no-code-labels.md`).

### Re-promotion triggers

- **CLI band** (band-state.mjs, read by pre-pr): (1) an escape that a model label rates Critical, blamed to a PR merged while the band is demoted; (2) any security-tier escape; (3) the escape rate of demoted-window merges over the per-band baseline in a 4-week window; (4) 2 escapes that a model label rates Major in 4 weeks, blamed to PRs merged in a demoted band (T19). Escape rows come from fix-commit blame, so they keep coming after the flip. None of these needs the blind sample or holdout.json.
  - Labels (T19): one sonnet call labels the whole batch of new escapes of that day. The cap counts calls, not escapes.
  - Fail closed (T19): an escape with no severity label after 2 days counts as Critical for (1) only when the fix touches a security-tier file. Every other unlabelled escape stays in the queue and counts for (3).
  - Baseline (T14): the per-band baseline comes from fix-chains rows only. CodeRabbit-found escapes from escape.mjs are not in it, because that source stops after a flip.
  - Calibration (T19): `re-prepr-cli-consumer` replays the triggers over the last 4 weeks of fix-chains rows before the flip, and sizes the label cap from the result.
- **CRITICAL band** (band-state.mjs, read by pr-checkpoint): the CLI triggers, plus shadow decide exit 3, plus 2 misses in the last 10 sampled PRs (11-05).
- After a flip, the blind sample runs 8 more weeks (11-05). Dave clears band-state by hand.
