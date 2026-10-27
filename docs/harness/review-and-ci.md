# Pull request review and CI

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text moved word for word. Edits made while PR 168 was reviewed fix facts that were stale or wrong, and lines that start with "Status on 2026-10-26" are dated notes.*

Each pull request to `main` passes automated checks before the operator merges it.

- Greptile does not review automatically. `.greptile/config.json` sets `autoReview: []` (PR #165,
  2026-10-26). A manual `@greptileai review` comment still runs and spends credits.
- CodeRabbit reviews a pull request only when it carries the `review:coderabbit`,
  `review:deep` or `review:deep-held` label (`.coderabbit.yaml`). The `coderabbit-guard` hook, not yet
  registered live, caps CLI runs at 2 per pull request.
- `scripts/github/review-status.mjs` prints READY only when the required bot reviews are on the
  current head, no review thread is open and all checks pass. The PR labels pick the required bots:
  `review:coderabbit` or `review:deep-held` need CodeRabbit only, `review:deep` needs both, a PR whose
  only risk label is `risk:docs` needs neither, and any other PR needs Greptile
  (`.claude/rules-ondemand/pr-review-loop.md`).
- `scripts/github/land-pr.ps1` merges a ready pull request and syncs `~/.claude` from a
  temporary worktree of `main`, so another session's branch cannot leak into the sync.
- GitHub Actions run four workflows: a full-history gitleaks scan, the no-work-user ratchet,
  `ccv3-checks` (the `ratchets`, `trivy` and `semgrep` jobs) and `review-router` (classifies the pull
  request and posts the routing comment). A gitleaks pre-commit hook (`.githooks/pre-commit`) catches secrets before the commit.

Status on 2026-10-26: a label relaxes the Greptile requirement only when the review router has
classified the current head. A stale or unrouted label keeps Greptile required. A change that lets
CodeRabbit stand in for Greptile on every path is in progress on another branch
(`feat/ccv3-router-followups`, not merged). The only override is `land-pr.ps1 -IgnoreReview`, which
also skips the CI gate.

The operator merges. No tool merges without the operator's yes.

Measured result: Windows hook spawns opened a visible terminal and took keyboard focus. With
`detached: true`, Windows ignores `windowsHide`. PR #148 added `lib/spawn-hidden.ts`, a small
relay that runs the command under a hidden console. A WinEvent trace showed the old shape created
and focused a Windows Terminal window, and the new shape created only a hidden console.
