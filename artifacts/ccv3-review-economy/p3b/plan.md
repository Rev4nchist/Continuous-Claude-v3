# Plan: CCV3-P3B-READY

Builder: kraken (Sonnet, high effort) in worktree `C:\Users\dkhay\cc-wt\p3b`, two rounds; orchestrator Claude Code (claude-opus-5-5) reran every suite, fixed the deep-PR alert path (findings from any required bot alert at once), committed and pushed. Reviewer: cross-family xreview CA after 2026-10-29 (Gate 17); PR stays draft until then.

## Steps
1. Failure modes first, one test each (AC1–AC8), then code.
2. `requiredBots` + `routing` + `routedReviewed` + draft block in `review-status.mjs`.
3. Greptile `failure`/`neutral` handling.
4. `model.ts`: `routedReviewed`/`routing` aware, back-compatible.
5. `PULLS_PATH_RE` → collection-only; `npm run build`; E2E payloads; dist churn outside `pr-opened-review-loop` restored.
6. `REVIEW.md` + both bot configs + `review-skip-sync.mjs`; wired into `ccv3-checks` after P3a landed.

## After merge
Forward sync via `land-pr.ps1` (review-status, the hook dist and the plugin reach `~/.claude`). Re-run `node scripts/github/review-status.mjs <open PR>` once to see `routing` live. P3c then adds the router that sets the labels.
