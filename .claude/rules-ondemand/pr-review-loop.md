# PR submitted → review loop

**Live today (CCv3 `main`):** Two label-gated PR bots: **Greptile** (`greptile-apps[bot]`) on open and
every push (`.greptile/config.json`), and **CodeRabbit** (`coderabbitai[bot]`) when the PR carries
`review:coderabbit` or `review:deep` (`.coderabbit.yaml`, `auto_incremental_review: false`). Only PR-bot
reviews on the current head count toward READY. `pr_watch` / `review-status.mjs` decide READY; only
Dave merges (`/land`). Follow the live steps below.

**Approved target (Wiring Plan 2026-10-25, D2–D4): partially built.** Label-gated CodeRabbit, READY
counting (DW-91) and label routing at ready (P3c) are live. Greptile-at-ready stays under "Target
(approved, not built)" at the end.

The in-session `/review` skill (Claude subagents) is an opt-in self-check. It **never** counts toward
READY (D4). Neither does a CodeRabbit CLI or plugin run (see `coderabbit-cli.md`; at most 2
`cr review --agent` runs per PR, guarded by `coderabbit-guard`).

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

- Greptile reviews on open and on every push (`.greptile/config.json`). CodeRabbit reviews only when
  the PR has `review:coderabbit` or `review:deep` (no automatic review on every push). Wait for each
  routed bot's review of the exact head. Use `pr_status` or `review-status.mjs`, not a 👍 emoji or a
  bot comment.
- Proof of a Greptile review is a `greptile-apps` check run on the head that ended `success`. A check
  that ended `neutral` with "Review was cancelled" was superseded by a push: it is not a review.
- Proof of a CodeRabbit review is a `coderabbitai[bot]` review object on the head whose body includes
  "Actionable comments posted: N", or its summary comment naming the head. A green `CodeRabbit` commit
  status or rate-limit notice alone is not a review.
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

Do not raise the review tier (`@greptileai review this at apex`, 10 credits) without Dave's yes. Do not
use `review:deep` until the Apex-billing root cause is found (D3).

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
6. Wait for the review of the new head (today the push triggers it).
7. Post the outcome to the user: finding count, fixed count, dismissed count, confidence, CI status.
8. For FourthBot, add a Sync row in the Grok↔Claude comms hub.

Never merge the PR. That is a separate, confirmed decision.

## Before you call a PR ready, or land it

Run `node scripts/github/review-status.mjs <N>`. Say "ready" only when it prints READY. READY means:
Greptile reviewed the CURRENT head commit (check run `success` and a summary naming that head),
confidence at least 4/5; when the PR has `review:coderabbit` or `review:deep`, a CodeRabbit PR-bot
review on that head (not CLI output); 0 threads unresolved from any reviewer; every commit status other
than CodeRabbit's is `success`; every check run other than Greptile's is completed with `success`,
`neutral` or `skipped`; and `mergeable_state` is clean. A merge was once called safe 92 s before a
reviewer found a real defect on the new head.

That sentence is what `review-status.mjs` implements today. It does not close three gaps observed on
2026-10-25 (Phase 0 baseline). They are not gated live. The target READY definition at the end of this
file is meant to close them. Do not treat this list as a live gate:

- **Merge-before-bot** (#147, #150, #151): the merge landed before Greptile posted. CodeRabbit often
  ended "Review failed - The pull request is closed."
- **Reviewed but unanswered** (#152): both bots reviewed final head `37ed7905`, and 7 threads had no
  replies, then the merge landed.
- **Green check ≠ review** (#149): the Greptile check ended `success` and no review or summary was posted.

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

The `pr-opened-review-loop` PostToolUse hook (matcher `Bash|PowerShell`) watches every `gh pr create`
and `gh api .../pulls -X POST` call. When the response carries a PR URL, it injects `additionalContext`
that names the PR and points back at this rule. For a CCv3 PR it says to call `pr_watch` first; for
any other repo it gives the `/loop` fallback. Starting the loop therefore does not depend on remembering
to. It fires once per PR URL per session (a small state file under `os.tmpdir()` dedupes) and fails
open on any error. (Renamed from `pr-opened-coderabbit-loop` in Phase 1 hygiene; behaviour unchanged.
It also reads the pre-rename state file, so a session open across the rename does not fire twice.)

## Label routing at ready (live, P3c)

The `review-router` workflow labels a PR when it opens, reopens, becomes ready, gets a push, or
moves to a new base. It runs `scripts/github/review-router.mjs` with `review-router.config.json`
from `main`. It spends no LLM credits. To route one PR again, run the workflow by hand with its
number (Actions, `review-router`, Run workflow).

- A draft PR gets no label and no bot review.
- The router reads the changed paths and sets one class. The highest class of any path wins.
  Order: r3, infra, steering, normal, docs.
- It adds `risk:<class>`. An r3 PR also gets `risk:high`.
- docs gets no review label. normal gets `review:coderabbit`.
- r3, infra, steering and high get `review:deep`. While `deep_enabled` is false, they get
  `review:coderabbit` and `review:deep-held` instead.
- At or above `u2_used` Greptile credits, only r3 keeps `review:deep`. Dave sets the credit count by
  hand in the config. A null count means unknown, and the router skips that step.
- A push can only raise the class. The router never removes a label and never lowers a class.
- A label that a person removed stays removed. The ledger line says `person_override`.
- The router keeps one comment on the PR and updates it. It names a held deep review, a missing
  `builder:*` label and a CodeRabbit rate limit. A missing builder label never blocks.
- That comment is the router's only memory. It holds the class and the full head SHA the router last saw.
  Only a comment by `github-actions[bot]` that starts with the marker counts. A person's copy is ignored.
- READY trusts a label that drops Greptile only when that comment names the current head and no
  `risk:*` label is above its class. Otherwise Greptile stays required, and READY says why.
- Known limit: anyone who can push a branch can run a workflow as `github-actions[bot]`. That person
  can already change labels, so the comment is not a defence against them.
- Each decision is one JSON line in the job summary (tool `router`).
- To test by hand, run `node scripts/github/review-router.mjs <PR> --dry-run`. Add `--assume-ready`
  to see a draft PR as a ready one. Never run it without `--dry-run` on this machine: a live local
  run posts a comment as you, which the router ignores.

## Target (approved, not built)

Approved in the Wiring Plan on 2026-10-25 (D2, D3, D4). **None of this is live.** Each item names the
phase that builds it. Until then the live steps above apply.

- **Greptile at ready, not on every push (Phase 3, DW-80; D3).** `autoReview` moves from open + push to
  ready/label. Greptile stays ON. `review:deep` bills Plus, never Apex, and stays blocked until the
  Apex-billing root cause is known.
- **One final-head review.** After the fix rounds, one explicit review of the final head by each
  routed bot. A fix push no longer triggers an automatic re-review.
- **Target READY (not built).** Meant to close the three Phase 0 gaps above. Every item holds on the
  current head SHA, and that SHA is the merge SHA: CI green (tests, gitleaks, and Semgrep/Trivy
  at HIGH/CRIT 0 or dismissed with a reason); the cross-family xreview CA verdict is SHIP, pinned to that
  SHA (a later commit voids it); every bot the router chose has reviewed that head, with no unresolved
  P0/P1. The router's labels decide which bots: `review:coderabbit` needs a CodeRabbit review on that
  head (a comment that says "Review failed - The pull request is closed." does not count);
  `review:deep` needs that CodeRabbit review and a Greptile review object on that SHA with confidence
  ≥ 4/5 (a check run ending `success` is not enough); no review label (docs) needs no bot review. Then:
  zero unreplied or unresolved bot threads, or an explicit ack; mergeable.
  Then Dave gets a toast. Only Dave merges. `/review`, CodeRabbit CLI or plugin output and DevWork
  Gate 17 notes never grant READY.
