# PR submitted → Greptile review loop

The review bot is Greptile (`greptile-apps[bot]`). CodeRabbit was uninstalled from this repo on
2026-10-09: a leftover CodeRabbit status never blocks or grants READY, and any open thread still counts.
Plan: `docs/self-improvement/proposals/2026-10-09-greptile.md`.

When a PR opens (`gh pr create` or `POST .../pulls`), call the `pr_watch` tool with the PR number
(`pr: <N>`) in the same turn. Do not wait to be asked. Only if that tool does not exist, or the PR is
not in `Rev4nchist/Continuous-Claude-v3`, start a `/loop` instead. Interval 5 minutes.

`pr_watch` is a ccv3-mods tool. The session checks the PR every 5 minutes with
`scripts/github/review-status.mjs`, tells Dave with a toast, and tells you with one report line at
READY, merged or closed; when a reviewed head has findings, a confidence below 4/5 or a failed check
(act per "When the review lands"); when Greptile did not finish a review; and when no review comes in
60 minutes. It never merges. `pr_status` reads the same status once. Dave uses `/watch <N>` to watch
and `/land <N>` to land: pressing Land in `/land` is his merge yes.

## Waiting for the review

- Greptile reviews on open and on every push (`.greptile/config.json`). Wait for the review of the
  exact head. Use `pr_status` or `review-status.mjs`, not a 👍 emoji or a bot comment.
- Proof of a review is a `greptile-apps` check run on the head that ended `success`. A check that
  ended `neutral` with "Review was cancelled" was superseded by a push: it is not a review.
- Greptile also writes a summary block into the PR body: the last reviewed commit and a confidence
  score. When you edit a PR body, keep the `<!-- greptile_comment -->` ... `<!-- /greptile_comment -->`
  block byte for byte. Any edit by a person after Greptile's summary makes the gate report
  UNAVAILABLE until Greptile rewrites it (one `@greptileai` comment). Edits by apps are fine.
- Batch fixes into one push. Every push is a new review and costs a credit. After 5 fix rounds
  without READY, stop and report to Dave.

## No review on the head

If no Greptile check appears on the head after 15 minutes, or the last one was cancelled, failed or
skipped: post ONE comment `@greptileai` on the PR, then wait again. If that also produces no review,
report to Dave. With his merge yes, post the reason on the PR, then run
`land-pr.ps1 -Pr <N> -IgnoreReview` (PR #111 precedent).

Do not raise the review tier (`@greptileai review this at apex`, 10 credits) without Dave's yes.

## When the review lands

1. Read every finding. Greptile marks each with a severity badge:
   - P0: must fix before merge. Never dismiss a P0 without Dave's yes.
   - P1: fix, or dismiss with a one-line reason.
   - P2: fix if cheap, or dismiss with a reason.
   - Any level: a security, privacy or data finding that is new to you or unclear. Ask Dave before you
     fix or dismiss it.
2. Fix real findings on the PR branch. Commit and push once.
3. For each real finding you fixed, reply `@greptileai Fixed in <sha>: <what changed>` and add a 👍
   reaction to the finding. Then resolve the thread through GraphQL `resolveReviewThread`. Greptile
   never resolves GitHub threads itself.
4. For each false positive, reply `@greptileai <reason>` and add a 👎 reaction to the finding.
   Then resolve the thread.
   Greptile learns from tagged replies and from 👍 and 👎 reactions. React only on a finding you
   judged: 👍 means real and fixed, 👎 means false positive. Add a reaction with
   `gh api repos/<O>/<R>/pulls/comments/<comment_id>/reactions -f content='+1'` (`-1` for 👎).
5. Never resolve a thread you did not act on.
6. Wait for the review of the new head (the push triggers it).
7. Post the outcome to the user: finding count, fixed count, dismissed count, confidence, CI status.
8. For FourthBot, add a Sync row in the Grok↔Claude comms hub.

Never merge the PR. That is a separate, confirmed decision.

## Before you call a PR ready, or land it

Run `node scripts/github/review-status.mjs <N>`. Say "ready" only when it prints READY: Greptile
reviewed the CURRENT head commit, confidence at least 4/5, 0 threads unresolved, checks green,
`mergeable_state` clean. A merge was once called safe 92 s before a reviewer found a real defect on
the new head.

When Dave says merge for a reviewed PR, land it with `pwsh -File scripts/github/land-pr.ps1 -Pr <N>`. It re-checks, merges
through REST pinned to the head SHA (GitHub refuses if the head moved), fast-forwards `main`, and
removes the worktree and branches. It syncs `~/.claude` itself, always from a temporary detached
worktree of `main`: other sessions share the primary checkout and can switch it mid-sync. If it
prints "skipped" or "NOT confirmed synced", sync by hand the same way, never from the primary
checkout: `git worktree add --detach <tmp> main`, then in `<tmp>` run
`scripts/sync-to-active.sh --changed` with Git Bash and `SYNC_MAIN_DETACHED=1`
(`C:\Program Files\Git\bin\bash.exe`; `bash` on PATH is WSL), then `git worktree remove <tmp>`.
Never hand-copy a synced file into `~/.claude`: the next sync quarantines it.
Every step is idempotent; re-run after a partial failure.

## Repos still on CodeRabbit

A repo without `.greptile/config.json` may still use CodeRabbit (`coderabbitai[bot]`). There:

- Proof of a review is a CodeRabbit review object on the head whose body has
  "Actionable comments posted: N", or its summary comment naming the head commit. A green
  `CodeRabbit` commit status alone is not a review.
- "Review rate limited" or "Review limit reached" is not a review. Do not post `@coderabbitai review`
  after that notice; it is refused. Never request the paid on-demand review. Report to Dave; with his
  merge yes, land with `-IgnoreReview`.
- Steps 1-8 of "When the review lands" apply, without the `@greptileai` tag.

## Loop prompt (fallback, for a repo without pr_watch)

Check the review bot on the PR via the REST API. Use `GH_CONFIG_DIR` for the repo's account.

- `gh api repos/<O>/<R>/commits/<head>/check-runs`: the reviewer's check on the head
- `gh api repos/<O>/<R>/pulls/<N>/comments`: inline findings
- GraphQL `reviewThreads` → `isResolved`, for thread state

Stop when a review of the head lands (act per "When the review lands") or after 60 minutes (report).

## Thread state — verify, do not trust the bot's text

Never mark a thread resolved from a bot's own comment text. On 2026-09-01, a bot message said a
thread "remains open" and that was wrong. Verify `isResolved` via the GraphQL `reviewThreads` query
before you report or act on thread state.

## Enforced by hook

The `pr-opened-coderabbit-loop` PostToolUse hook (old name, kept so `settings.json` does not change;
matcher `Bash|PowerShell`) watches every `gh pr create` and `gh api .../pulls -X POST` call. When the
response looks like a real success (a PR URL or a `number` field), it injects `additionalContext`
naming the PR and pointing back at this rule, so starting the loop does not depend on remembering to.
It fires once per PR URL per session (a small state file under `os.tmpdir()` dedupes) and fails open
on any error.
