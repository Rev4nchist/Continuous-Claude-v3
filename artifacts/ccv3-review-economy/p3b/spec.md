# Spec: CCV3-P3B-READY

## Acceptance
- **AC1 Routing table.** `requiredBots` returns, by labels: `review:deep` (wins over `review:deep-held`) → greptile + coderabbit; `review:deep-held` → coderabbit, `held` set; `review:coderabbit` → coderabbit; only `risk:docs` → none; any other `risk:*` without `review:*` → greptile (`source: labels`); no `review:*`/`risk:*` → greptile (`source: default`). One fixture per row.
- **AC2 Back-compat.** Every existing JSON field keeps its meaning. New fields: `routing`, `routedReviewed`. A no-label PR evaluates exactly as before.
- **AC3 Draft.** `pull.draft` → not READY, reason "PR is a draft (no bot review on drafts)" (G-R1).
- **AC4 Greptile states.** `failure` + head summary → reviewed, low confidence blocks; `failure` + 4/5 or 5/5 summary → blocks with its own reason; `neutral` → `greptile: 'cancelled'`, cancelled reason; `unavailable` stays true for older mod copies.
- **AC5 Wiring Plan fixtures.** G-R4 (summary names an older SHA), G-R5 (3/5; one open thread), G-R8 (CodeRabbit rate limit on a labelled PR) → not READY.
- **AC6 pr_watch.** CodeRabbit-only PR with an open thread → REVIEWED naming CodeRabbit; no CodeRabbit review after 60 min → STALLED naming CodeRabbit; deep PR with Greptile findings and no CodeRabbit review yet → REVIEWED naming only Greptile; deep PR with no findings → PENDING; docs-only never waits; payload without `routedReviewed` → old behaviour and Greptile texts.
- **AC7 PR-open hook.** Reply POST and review POST → `{}`; collection POST (quoted or `--method POST`) → additionalContext. Built dist piped a real payload (E2E file below).
- **AC8 Skip-list.** `review-skip-sync.mjs` exits 0 when both configs equal `REVIEW.md`, 1 on a missing or extra path, 2 when the section is absent; runs in `ccv3-checks`.

## Evidence
- `node --test scripts/github/review-status.test.mjs` 101/0; `review-skip-sync.test.mjs` 13/0; hook vitest `pr-opened-review-loop` 29/0; `claude plugin test .claude/plugins/ccv3-mods` 196/0 (rerun by the orchestrator).
- `.claude/cache/e2e/2026-10-26-p3b-pulls-path.txt` (built hook, reply POST → `{}`, collection POST → context).
- Hooks `tsc --noEmit`: 206 errors on branch and on main, none new. Plugin `tsc` not run (no `.claude-plugin/types/` on this machine).
