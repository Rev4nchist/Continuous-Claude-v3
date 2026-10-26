# Intent: CCV3-P3B-READY (DW-80 split 2/3, Phase 3)

Slug: `ccv3-review-economy/p3b` · Repo: `Rev4nchist/Continuous-Claude-v3` · Base: `main` @ `7da9a5ae` (P3a #157 merge)
Card: https://app.notion.com/p/40576fd7ac8281a58074dc3c3b6310e2 · Parent: DW-80 · Order 60.452
Status: Backlog → build started 2026-10-26 (Dave decision A4: build now, merge after the 2026-10-29 cross-family xreview).
Source: Wiring Plan 2026-10-25 §6.2 (G-R1..G-R8), §6.3 (target READY); DW-80 Acceptance (1)–(2); #155 follow-ups.

## Why
READY assumed Greptile on every PR. Phase 3 routes PRs by label (P3c), so READY must ask the bots the labels name, and must not break today's unlabelled PRs. Three #155 follow-ups also misled the agent: a Greptile check that ended `failure` (below 4/5) or `neutral` (cancelled) read as "no review"; review-thread reply POSTs fired the "PR OPENED" hook; and Greptile and CodeRabbit skipped different path lists.

## What (one PR)
1. `review-status.mjs`: `requiredBots(labels)` and a `routing` field. `review:deep` → Greptile + CodeRabbit; `review:deep-held` or `review:coderabbit` → CodeRabbit; `risk:docs` alone → none; no labels → Greptile (today). `routedReviewed` = every required bot reviewed the head. Draft PRs are never READY.
2. Greptile `failure` with a head summary = reviewed (low confidence blocks); `neutral` = cancelled, with its own reason. A `failure` check whose summary scores 4/5 or 5/5 still blocks (conflicting signals).
3. `pr_watch` (`model.ts`): states and texts follow `routing.required`; findings from any required bot alert at once; READY/STALLED name the right bots; older payloads behave as before.
4. `pr-opened-review-loop`: only a POST to the `.../pulls` collection counts as a PR open.
5. `REVIEW.md` skip-list; `.greptile/config.json` `ignorePatterns` and `.coderabbit.yaml` `path_filters` match it; `review-skip-sync.mjs` ratchet in `ccv3-checks`.

## Out of scope / held
Greptile `autoReview` change (held for the Apex billing root cause, decision A5). Router and labels (P3c). xreview verdict in READY (P5).
