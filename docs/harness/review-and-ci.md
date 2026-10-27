# Pull request review and CI

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text is unchanged except where a line starts with "Status on 2026-10-26" or names PR #165.*

Each pull request to `main` passes automated checks before the operator merges it.

- Greptile does not review automatically. `.greptile/config.json` sets `autoReview: []` (PR #165,
  2026-10-26). A manual `@greptileai review` comment still runs and spends credits.
- CodeRabbit reviews a pull request only when it carries the `review:coderabbit` or
  `review:deep` label (`.coderabbit.yaml`). The `coderabbit-guard` hook, not yet registered live,
  caps CLI runs at 2 per branch.
- `scripts/github/review-status.mjs` prints READY only when Greptile reviewed the current head,
  any required CodeRabbit review is on that head, no review thread is open and all checks pass
  (`.claude/rules-ondemand/pr-review-loop.md`).
- `scripts/github/land-pr.ps1` merges a ready pull request and syncs `~/.claude` from a
  temporary worktree of `main`, so another session's branch cannot leak into the sync.
- GitHub Actions run two checks: a full-history gitleaks scan and the no-work-user ratchet.
  A gitleaks pre-commit hook (`.githooks/pre-commit`) catches secrets before the commit.

Status on 2026-10-26: on `main`, `review-status.mjs` still requires a Greptile review for READY. A
change that lets a CodeRabbit review stand in for it is in progress on another branch
(`feat/ccv3-router-followups`, not merged). Until it lands, a pull request with no Greptile review
cannot reach READY. The only override is `land-pr.ps1 -IgnoreReview`, which also skips the CI gate.

The operator merges. No tool merges without the operator's yes.

Measured result: Windows hook spawns opened a visible terminal and took keyboard focus. With
`detached: true`, Windows ignores `windowsHide`. PR #148 added `lib/spawn-hidden.ts`, a small
relay that runs the command under a hidden console. A WinEvent trace showed the old shape created
and focused a Windows Terminal window, and the new shape created only a hidden console.
