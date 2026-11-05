# Review engine phase 1 results (2026-11-04)

Plan: `C:\Users\dkhay\continuous-claude\.claudedocs\2026-11-04-review-engine-combined-plan.md` (phase 1 = measure).
Branch: `feat/review-engine-p1` (pushed to fork, no PR yet), worktree `C:\Users\dkhay\continuous-claude\.claude\worktrees\review-p1`.
Commits: `8f3ad079` (instrumentation), `628b8100` (harness runs the engine, body withheld). Full suite: 1794 pass, 0 fail.

## 1. Answer first

- The eval harness never ran the engine before today. `replay.mjs` called `cursor-review.mjs` `runReview`. Every earlier score (1 of 10) measured an older prompt.
- The engine itself, on the 10-Major holdout, 2 runs, PR body withheld: **same-issue recall 10 of 20 (50%)**.
  - within-hunk 8 of 10
  - same-file 2 of 4
  - cross-file-dynamic **0 of 6**
- With today's PR body in CONTEXT.md the score was 13 of 20. Our PR bodies list the fixed review findings, so the body leaks answers. Eval runs now withhold it.
- The engine throws away most of what it finds. Funnel over 20 runs: raw 23, **withdrawn 75**, dropped 1, posted 22.
- All 4 Majors missed in both runs (203, 207, 221, 235) have a withdrawn item at their place in at least one run. 221 and 235 match on file only.
- Only 9 of 75 withdrawn items (12%) sit at a real Major line. About 80% sit where CodeRabbit flagged nothing. So the phase 4 verifier must be a cheap refute-only filter, not a second full review.
- Cross-file reach is the weakest class, at 0 of 6. That points at phase 5 (IMPACT.md reference map).

## 2. Scorecard

| | Run 1 | Run 2 | Pooled |
|---|---|---|---|
| Same-issue recall (body withheld) | 5/10 | 5/10 | 10/20 (50%) |
| Same-issue recall (body included) | 7/10 | 6/10 | 13/20 (65%) |

Per key, found by line (run 1 / run 2):

| Key | linkType | Body included | Body withheld |
|---|---|---|---|
| 200:4406017695 | within-hunk | FOUND/FOUND | FOUND/FOUND |
| 200:4406157937 | within-hunk | FOUND/FOUND | FOUND/FOUND |
| 203:4407064990 | cross-file-dynamic | FOUND/FOUND | miss/miss |
| 206:4407781182 | same-file | FOUND/FOUND | miss/FOUND |
| 206:4408111287 | same-file | FOUND/miss | FOUND/miss |
| 207:4407827505 | cross-file-dynamic | miss/miss | miss/miss |
| 211:4412999830 | within-hunk | FOUND/FOUND | FOUND/FOUND |
| 221:7d3b6b2c... | cross-file-dynamic | miss/miss | miss/miss |
| 227:4426579552 | within-hunk | FOUND/FOUND | FOUND/FOUND |
| 235:r1-80 | within-hunk | miss/miss | miss/miss |

Labels: same-issue labels are agent labels (`by:'claude'`) in the run dirs' `labels.jsonl` (gitignored). Judge agreement n=0 (NOTE). The linkType labels have 2 raters (Claude, Grok): n=22, raw 0.773, kappa 0.649 (`scripts/eval/review-eval/linktype-labels.json`).

## 3. What phase 1 built

- **Funnel:** the prompt asks for `withdrawn[]`. Each record carries raw, withdrawn, dropped by reason and posted.
- **Trace:** the engine call uses stream-json. `local-review/trace.mjs` writes trace.json (filesRead, greps, tool stats, cursor-agent version `2026.10.22-27dcf5f`), condensed.md and the gzipped stream.
- **tldr removed** from the review path. It has no JS call graph, and an error exits 0.
- **Judge gate:** it was vacuous, because it counted only Dave labels and there are none. It now prints n, raw and kappa, as a NOTE below n=30.
- **perClassRecall** by linkType. `cursorEvalBudget` raised from 80 to 120. Used: **75 of 120**.
- **Harness to engine bridge:**
  - `engine-run.mjs` calls `reviewHead` at the round head and base, with the current band config and `trusted:false`.
  - Separate run dirs per run.
  - `freeze --engine` records the engine prompt shas: full `23bcd1d0...`, delta `32f81c13...`.
  - `modelVerified` comes from the stream init event.
  - `bodyMode` withheld is the default in eval runs.

## 4. Known gaps and caveats

- n = 10 Majors. Plan rule: no keep or kill call before 50 or more gold Majors (phase 3).
- The CodeRabbit-derived answer key misses bugs CodeRabbit missed. "At no CodeRabbit finding" is not the same as noise.
- 221 and 235 have no lines in the dataset, so they match on file only.
- The xhigh model display name used for the CRITICAL model check is a guess. No CRITICAL run has been seen.
- The interim CodeRabbit rule (Dave yes 11-04) is not built. Lane `review-engine-cr-interim-rule`.
- Shadow retro has not run. It goes through the old `runReview` path (pinned) and spends one Cursor run per CodeRabbit round, at most 6 per day.

## 5. Artifacts (`C:\Users\dkhay\continuous-claude\.claude\cache\e2e\`)

- `2026-11-04-p1-holdout-nobody-report.md`, `-nobody-sidebyside.md`, `-nobody-run-{1,2}/`, `-nobody-run-{1,2}-scorecard.{md,json}`
- `2026-11-04-p1-holdout-report.md`, `-holdout-run-{1,2}/` (body included)
- `2026-11-04-p1-e2e-pr222.*` (first real trace), `2026-11-04-stream-json-precheck.jsonl`
- `2026-11-04-p1-linktype-rater2.*`, `2026-11-04-p1-scorecard-offline.*`, `-holdout-nobody-full-suite.txt`
