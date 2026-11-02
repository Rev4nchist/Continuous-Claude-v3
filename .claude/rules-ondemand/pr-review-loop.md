# PR submitted → review loop

**Live today (CCv3 `main`):** **CodeRabbit** (`coderabbitai[bot]`) reviews a PR that carries
`review:coderabbit` or `review:deep` (`.coderabbit.yaml`, `auto_incremental_review: false`: a push
does not start a review). **Greptile** (`greptile-apps[bot]`) stays installed, but its automatic
review is off (`.greptile/config.json` `"autoReview": []`, Dave, 2026-10-26). While it is off,
`review-status.mjs` requires CodeRabbit wherever the labels would require Greptile. Only PR-bot
reviews on the current head count toward READY. One exception: a small fix after a Minor-only
review can carry that review (see "What READY checks" below). `pr_watch` / `review-status.mjs`
decide READY; only Dave merges (`/land`). Follow the live steps below.

**Dependabot PRs** need no bot review (CodeRabbit refuses bot-authored PRs). This holds only when
the PR author is the `dependabot[bot]` Bot account and every commit is by `dependabot[bot]` and
signed by GitHub. A person's commit on that branch ends the exception. All other READY items apply,
except the PR body proof (see "Proof in the PR body").

**Approved target (Wiring Plan 2026-10-25, D2–D4): partially built.** Label-gated CodeRabbit, READY
counting (DW-91) and label routing at ready (P3c) are live. See "Target" at the end.

The in-session `/review` skill (Claude subagents) is an opt-in self-check. It **never** counts toward
READY (D4). Neither does a CodeRabbit CLI or plugin run (see `coderabbit-cli.md`; `pre-pr.mjs` caps its own
runs at 2 per branch, and `cr-fix.mjs` runs count separately; `coderabbit-guard` is built but not registered).

When a PR opens (`gh pr create` or `POST .../pulls`), call the `pr_watch` tool with the PR number
(`pr: <N>`) in the same turn. Do not wait to be asked. Only if that tool does not exist, or the PR is
not in `Rev4nchist/Continuous-Claude-v3`, start a `/loop` instead. Interval 5 minutes.

`pr_watch` is a ccv3-mods tool. The session checks the PR every 5 minutes with
`scripts/github/review-status.mjs` and tells Dave with a toast at READY, merged or closed. Those three
give you no line. You get one report line only when a reviewed head has findings, a confidence below
4/5 or a failed check (REVIEWED: act per "When the review lands"); when the PR body proof is wrong
(PROOF); when no review comes in 60 minutes (STALLED); and when a bot did not finish a review
(LIMITED). Use `pr_status` to read the state; it reads the same status once. `CCV3_MOD_PRLOOP_QUIET=1`
stops the report lines too. It never merges. Dave uses `/watch <N>` to watch
and `/land <N>` to land: pressing Land in `/land` is his merge yes.

`pr_watch` also reports a draft as "waiting on /pathway" (a toast, no line to you) and a
`review:none` PR with no router state as "has no router state for this head. Re-run the
review-router workflow for this head. Do not request a bot review." Before a CodeRabbit round past
the PR's budget, it asks Dave in the checkpoint pane. Read its line before you post any review request.

## Before you open a PR

CodeRabbit allows 8 PR reviews per hour for the one Rev4nchist identity. The rate drops to 6, 4, 2 and 1
per hour as the 7-day count passes 40, 50, 60 and 70. Each opening review and each `@coderabbitai review`
costs one. Aim for 1 review per PR. Warn at a 7-day count of 30. Wait at 40. Facts:
`.claudedocs/2026-10-27-coderabbit-review-budget.md`.

A small PR needs no bot review when its CLI run is clean. Small means 3 files or fewer and 30 added
lines or fewer (rule RS of `pr-checkpoint.mjs`). The checkpoint pane then recommends `none`, at any
7-day count. A Major, a Critical or a missing CLI result on a small PR recommends CodeRabbit 1+0.

1. Run `node scripts/github/pre-pr.mjs --body <draft.md>` from the repo root. Use a clean branch and a
   draft body with the Evidence block. The script runs the gates for the files you changed. It checks the
   Evidence against the head. It runs one `cr review --agent`. Fix the findings, commit, and run it again.

   The PR body must be a file: `-F body=@<file>` or `--body-file <file>`. The hook denies an inline body, stdin and `--fill`.

   The review takes 10 to 30 minutes. Run the script in the background (Bash `run_in_background`). Read
   its log when the exit notice arrives. A foreground call can be cut off.

   The script runs `cr review --agent --committed --base <base>`. It first runs the free `cr usage --agent`.
   The time limit is 30 minutes. Set it with `--cr-timeout-min` or `PRE_PR_CR_TIMEOUT_MIN`. The floor is
   15 minutes. A lower value is ignored with a warning.

   A review passes only when its stream ends with a `complete` event. An unfinished stream, a failed
   outcome or unreviewed files fail the step. The findings stay in the log.

   The stamp records `cr_skipped`, `cr_skip_reason` and `cr_finished_runs`. The hook accepts a skip for
   these reasons only:

   - `cli-missing`: `cr` cannot start because it is not installed. No run is spent.
   - `cap`: the 2 CLI runs of the branch are used. It needs `cr_finished_runs` of at least 1.
     That count holds only runs that finished with a PASS.
   - `rate-limited`: no included review is left. It needs a positive `cr_retry_minutes` in the stamp.

   The hook denies every other reason:

   - `cli-error`: `cr usage` or `cr` failed with an exit code, a timeout or an auth error.
     A retry costs nothing. Fix the CLI and run again.
   - `flag`: you used `--skip-cr`. Use that flag to test the script, not to open a PR.
   - `no-changes`: the CLI saw an empty scope. Check `--base` and commit your work.

   Only one CodeRabbit step runs per branch at a time, across all worktrees. A second run fails while
   the first holds the lock. The run count is keyed on the branch name and its first own commit.
   A merge of main keeps the count. A rebase rewrites that commit and starts a new count.
2. Open the PR as a draft (`gh pr create --draft`), then call `pr_watch`. Call `pr_checkpoint` with
   `pr` and `body` (the file that `pre-pr.mjs --body` checked). The tool opens the checkpoint pane
   and returns at once. Wait for Dave's press in the pane. Then the mod adds the `review:` label and
   marks the PR ready. A headless run gets a text plan and records nothing. Never run `gh pr ready`,
   never add a `review:` label by hand, and never run `pr-checkpoint.mjs --confirm` or `--apply` from a
   shell. Lock A of the ccv3-mods `pr-checkpoint` hook denies a Write-tool edit of `pathway.json`.
   Lock B of the same hook denies any shell text that names it.
   To return a PR to draft, run `gh pr ready --undo`.
3. Batch every fix into one push. After the push, run `node scripts/github/cr-fix.mjs --pr <N>` in the
   PR checkout. It stops when local HEAD is not the PR head, or when CodeRabbit already reviewed the head. It reviews only the commits after the carry source.
   The carry source is the newest CodeRabbit review, or a newer clean summary-only round (see "What READY checks").
   Paste the one line of the script (`CLI fix review: <from>..<head> clean`) in the PR body. A body
   edit does not change the head. For a Major or Critical: fix, commit, push, and run it again.
   Then post one `@coderabbitai review`, only when the `pr_watch` line says a round is left or says Dave
   allowed the round. After a Minor-only round, a fix of 30 lines or fewer with a clean line needs no new
   review: READY carries the earlier one. Never push while a review runs: the push supersedes it and the review is lost.
4. Bundle small fixes in one area into one PR.
5. Do not stack PRs by default. `base_branches` is `main`, so a stacked PR gets no review. READY pins the
   review to the head, so each restack needs a new review.
6. When the week is busy, post `@coderabbitai rate limit` before a review request. It costs no review.
   The warn and wait counts are in the first paragraph of this section.

### PR review budget per class

The review router sets the class. This budget counts CodeRabbit PR reviews: the opening review and each
`@coderabbitai review`. It does not count CLI runs.

- The budget of a PR is in its checkpoint record (`pathway.json` `budget`, kept by the mod). The numbers
  below are the defaults in `review-router.config.json` `budget`.
- docs: 0 PR reviews. The router adds no label.
- normal, steering and infra: 1 PR review (1+1). The extra review is for a round after a Major.
- r3: 1 PR review, and at most 2 more after fix pushes (1+2).
- A Minor-only round needs no extra review when the fix is 30 lines or fewer: READY carries the review.
- A PR outside the risk list gets at most 2 cloud rounds. The risk list is the critical and parser globs and class r3.
  The budget gives this: normal, steering and infra are 1+1, and the extra round follows a Major. Only r3 (1+2) and
  Dave's press in the pane ("Dave allowed round N") go past 2. A saved `pathway.json` keeps its old budget.
  Rounds 3 and later on such PRs found no real defect in the 2026-10-30 study.
- Put all fixes of a round in one push. Then post one `@coderabbitai review`, if a round is left.
- Do not click GitHub "Update branch" unless the merge needs it. Each click makes a new head and a new review.
- `pr_watch` counts the rounds used. At budget + 1 it asks Dave in the checkpoint pane. A PR at its
  budget gets no more `@coderabbitai review` until the line says "Dave allowed round N". Wait for his
  press in the pane. Do not ask him in chat.

The `pre-pr-gate` PreToolUse hook enforces step 1. It denies `gh pr create` and `gh api .../pulls` with
POST in `Rev4nchist/Continuous-Claude-v3`. It allows the call only when `.claude/cache/pre-pr/stamp.json`
names the head and is under 24 hours old. It denies a stamp that skipped the CLI review for a reason that
step 1 does not list.

- A command must name exactly one body file: `-F body=@<file>`, `--body-file <file>`, or `-F <file>` on
  `gh pr create`. The file must hash to the stamp's `body_sha256`. The hook denies a second body source,
  a repeated body flag and `--input`.
- The checkout decides the target. Only a CCv3 signal overrides it: a CCv3 `--repo`, `-R` or `GH_REPO`
  value, a CCv3 `repos/<owner>/<repo>/` endpoint text or a CCv3 PR URL anywhere in the command. Such a
  command must run in a CCv3 checkout.
- The hook never names a foreign repo. A gated command in a CCv3 checkout is always gated, whatever
  `-R` it holds. To act on another repo, run the command from that repo's checkout.
- Accepted residual: from a foreign checkout, a CCv3 `-R` hidden by shell syntax (`v""3`, `-dR`) is
  not seen. The hook guards against mistakes, not a hostile agent.
- When `refs/remotes/fork/<branch>` exists, it must equal the stamped head.
- The hook reads the command text with its continuation lines joined.
- If the hook cannot check the stamp, it denies a PR-create command. A git timeout, a git error or an
  unreadable remote causes this. The deny text says so. Run the command again.
- The deny text names the command to run.
- The checkpoint rules of the same hook: a non-draft create, a shell `gh pr ready`, a hand `review:` label
  (also `gh pr create --label`), a shell `pr-checkpoint --confirm` or `--apply`, and a non-literal `--repo`.
  `checkpoint.enforce` in `review-router.config.json` decides. It is `true` (enforced): the hook denies
  each of these commands. Spike S6 passed live on PR #217. The mod added the label at 00:22:23Z and
  marked the PR ready at 00:22:25Z. The CodeRabbit check started at 00:22:59Z. With `false` (warn
  mode) the hook allows the command and logs a `warn` row to the guard decision log. The stamp rules
  above are enforced in both modes.
- Residual risks, accepted: GraphQL with the query text in a file (`-F query=@file`) shows the hook no
  label or ready text. `gh pr ready --undo` and `-F "draft=true"` inside quotes read as a ready and a
  non-draft create (the hook does not lex quotes). Lock A of the ccv3-mods `pr-checkpoint` hook closes the Write-tool route.
  Lock A denies a Write, Edit, MultiEdit or NotebookEdit of `pathway.json`. Lock B of the same hook
  denies any shell text that names `pathway.json`. An indirect script that builds the path from parts is accepted.
  Lock B also denies a gh write shape whose text names `pathway-confirmed`, the router's marker.
  A gh write shape is any of these.
  A comment is one. A `pr edit` or `pr create` with a body is one.
  An `api` call with POST, PATCH or PUT is one. A `body=` field is one.
  A GraphQL mutation is one. The `--input` flag is one.
  A gh read that names the marker is allowed. A node or
  PowerShell script that posts the marker, or a body file that holds it, is accepted. A confirmed label is tied to
  HEAD, not to a PR number, in this hook: `gh pr edit <other> --add-label review:deep` passes while that
  pathway stands. Lock B also checks the PR number against its store record.
  The hook does not read a subcommand built from a variable (`gh pr $sub 201`).
  The hook reads the mode from the cwd checkout. Sometimes that cwd has no readable
  `review-router.config.json`. Then the hook enforces a command in three cases. Case one: the command names CCv3.
  Case two: the command is a self-confirm. Case three: the command runs in a CCv3 checkout.
  A readable config keeps its own `enforce` value.
- Residual risk, accepted (Dave, 2026-10-30): `review-status.mjs` trusts the `CLI fix review:` line in the PR body.
  Anyone who can edit the body can write that line. This is the same trust as a label, which needs write access.
- Residual risk, accepted: a router comment written before the consumed line existed has no `consumed` id.
  A stale marker on such a PR can count once more at the next same-head ready. After that run the router saves the id, and the marker is bound.
- `SKIP_PRE_PR_GATE=1` is Dave-only. An agent never sets it, never suggests it, and never copies it
  from a deny message. It works only as a leading assignment. Each use writes an `override` line to the
  guard decision log.

The gate stops accidents, not evasion. It cannot see a `gh` alias, `hub`, `curl` or a GraphQL
`createPullRequest` call. It cannot see a GitHub MCP tool call, a script that wraps `gh`, or a forged
stamp. A PR opened one of those ways skips the checks. It wastes the reviews this section protects.



## Review band and review models (review matrix, 2026-11-01)

Spec: `.claudedocs/2026-11-01-review-matrix.md`. Dave chose option A.

- `bandOf()` in `review-router.mjs` computes the band from the changed files. The numbers live in the `matrix` block of `review-router.config.json`.
- Bands: LOW, MID, ELEVATED, HIGH, CRITICAL. HIGH is 5 or more control-plane files (`matrix.control_plane`). CRITICAL is a `risk:high` label or an r3 path.
- LOW, MID and ELEVATED: `/pathway` recommends `none`. HIGH and CRITICAL: it recommends `coderabbit` at `matrix.bot_budget`.
- Dave can still press CodeRabbit on a lower band. That is an escalation.
- A parser file in a HIGH PR keeps rule R2: one review, no loop.
- A config without a `matrix` block keeps the rules R1 to R5 and RS.
- The router ledger line names the band. The state comment and the labels do not carry it yet.

**Never run a review in fast mode.** (Dave, 2026-11-01)

- Claude review agents (critic, aegis, principal-reviewer) never run in fast mode.
- Cursor review runs pass `--model` with an explicit value.
- Use only `grok-4.7-high` (or `grok-4.7-xhigh` for CRITICAL). The wrapper allowlist also admits `grok-4.7-low`, `grok-4.7-medium` and `composer-2.5`, but no band may use them now (bake-off, 2026-11-01).
- Never use Auto. Never use a model name that contains `fast`.
- Never fall back to the CLI default model. If the model is not allowed, stop the run.

## Waiting for the review

- CodeRabbit reviews when the PR has `review:coderabbit` or `review:deep`. A push does not start a
  new review: after a fix push, post one `@coderabbitai review` for the new head, only when the
  `pr_watch` line says a round is left. A Minor-only round with a fix of 30 lines or fewer needs
  none: READY carries the earlier review. Greptile does not
  review by itself while its `autoReview` is `[]`. Wait for each required bot's review of the exact
  head. Use `pr_status` or `review-status.mjs`, not a 👍 emoji or a bot comment.
- Proof of a CodeRabbit review is a `coderabbitai[bot]` review object on the head whose body includes
  "Actionable comments posted: N", or its summary comment naming the head. A green `CodeRabbit` commit
  status or rate-limit notice alone is not a review.
- When Greptile does review (auto review on, or on request): proof is a `greptile-apps` check run on
  the head that ended `success`. A check that ended `neutral` with "Review was cancelled" was
  superseded by a push: it is not a review.
- Greptile writes its summary in a `<!-- greptile_summary -->` comment, or in a
  `<!-- greptile_comment -->` block in the PR body. When you edit a PR body, keep that block byte
  for byte. An edit by a person after a body summary makes the gate report UNAVAILABLE until
  Greptile rewrites it. Edits by apps are fine.
- Batch fixes into one push. Every review uses a bot allowance or credit. At the PR's budget, stop.
  `pr_watch` asks Dave in the checkpoint pane. Report the open findings to Dave.

## No review on the head

Never request a review on a draft or on a `review:none` PR. A draft waits on `/pathway`. A
`review:none` PR with no router state needs the review-router workflow re-run for that head.

On a coderabbit or both PR with no CodeRabbit review 30 minutes after ready, `pr_watch` asks Dave in
the pane. The mod posts one `@coderabbitai review` only when he presses Yes. Do not post it yourself.
Never post a review request while the CodeRabbit commit status is pending: a review is running. The
mod asks nothing in that state.

For a draft, `review-status.mjs` says "no CodeRabbit PR-bot review of the head commit. Draft: run
/pathway; do not request a review". Follow it.

On a PR with a checkpoint record, a missing, skipped or failed CodeRabbit review is a round. Follow the
`pr_watch` line. Post `@coderabbitai review` only when it says a round is left or Dave allowed it.

On a PR with no checkpoint record (opened before the checkpoint, or by another route), watch for two cases.
Case one: no review from a required bot appears on the head after 30 minutes.
Case two: the last review was cancelled, failed or skipped.
In either case, post ONE review request for that bot (`@coderabbitai review`), then wait again.

After a CodeRabbit "Review rate limited" or "Review limit reached" notice, do not post
a plain request. When the next slot is over 15 minutes away, follow "Paid PR reviews (Dave, 2026-10-30)".
Otherwise wait. If the request also produces no review, report to Dave. With his merge
yes, post the reason on the PR, then run `land-pr.ps1 -Pr <N> -IgnoreReview` (PR #111 precedent).

Review waiver: after Dave's explicit yes to waive the bot review, post a PR comment that starts with
`Review waived by Dave`, then the reason. Post it only after that yes. `pr_watch` then stops queueing the
opening-review question for that PR. The comment is not proof of Dave's yes (the agents post as the same
account), so it hides no alert and changes no status text. Do not word it any other way: the watcher
matches the exact phrase.

On a both PR, `pr_watch` asks Dave once in the pane for Greptile on the final head. Post `@greptileai`
only when he asks: each review bills a credit. Do not raise the review tier (`@greptileai review this at apex`, 10 credits) without Dave's
yes. Do not use `review:deep` until the Apex-billing root cause is found (D3).

## When the review lands

1. Read every finding. Greptile marks each with a severity badge (P0-P2); for a CodeRabbit finding,
   use its own severity as the nearest level:
   - P0: must fix before merge. Never dismiss a P0 without Dave's yes.
   - P1: fix, or dismiss with a one-line reason.
   - P2: fix if cheap, or dismiss with a reason.
   - Any level: a security, privacy or data finding that is new to you or unclear. Ask Dave before you
     fix or dismiss it.
   - Read the whole review body. CodeRabbit lists "Outside diff range comments (N)" there. They have no
     thread, so no thread count shows them. READY (`review-status.mjs`) collects the findings from every CodeRabbit
     review body of the PR and counts each marker id once. The body needs no "Actionable comments posted" sentence.
     A push does not clear them. READY fails while a finding has no bullet that names it (gate A, finding identity).
     A body with the heading and no marker ids falls back to the count N: it needs N bullets.
   - Fix each one, or list it in the PR body under the heading `Outside-diff: handled`. Write one
     top-level bullet per finding, with the fix commit or the reason.
     Each bullet names the finding by its CodeRabbit marker id (`cr-comment:v1:` plus exactly 24 hex characters,
     written as a whole token) or by its `path:lines`. A marker of another length counts as no id.
     Filler bullets do not count. A marker in an HTML comment does not count.
     A nitpick needs no bullet.
     READY reads only the quoted lines under the "Outside diff range comments (N)" heading.
     It counts a finding repeated in two reviews once.
     A review body with no markers falls back to the count: N findings need N bullets.
     The READY reason lists each unnamed finding by id and `path:lines`.
   - Read every finding of the NEWEST round: inline, outside-diff and nitpick. Nobody may merge on a round that
     nobody read. READY blocks an open thread and an unhandled outside-diff finding. It has no gate for a
     nitpick, so you are that gate. In the 2026-10-30 study, 14 of 37 later rounds got no fix and no reply.
2. Fix real findings on the PR branch. Commit and push once.
3. For each real finding you fixed, reply `Fixed in <sha>: <what changed>` and add a 👍 reaction to
   the finding. Then resolve the thread through GraphQL `resolveReviewThread`. The bots never
   resolve GitHub threads themselves. On a Greptile finding, start the reply with `@greptileai`.
   Post each reply with `node scripts/github/reply-thread.mjs <pr> <comment-id> --body-file <file>`.
   Write the file with the Write tool. Never build the reply in a PowerShell hashtable: `-f body=$h[$id]`
   posts the text `System.Collections.Hashtable[<id>]` (14 replies on #225, #227 and #238).
4. For each false positive, reply `<reason>` (with `@greptileai` on a Greptile finding) and add a
   👎 reaction to the finding. Then resolve the thread.
   The bots learn from replies and from 👍 and 👎 reactions. React only on a finding you
   judged: 👍 means real and fixed, 👎 means false positive. Add a reaction with
   `gh api repos/<O>/<R>/pulls/comments/<comment_id>/reactions -f content='+1'` (`-1` for 👎).
5. Never resolve a thread you did not act on.
6. Request the review of the new head (`@coderabbitai review`; a push does not start one) only when the
   `pr_watch` line says a round is left, or after the pane shows "Dave allowed round N". After a
   Minor-only round with a fix of 30 lines or fewer, post nothing: READY carries the earlier review.
   Never post while the CodeRabbit status is pending. Before any request, run the cap check in
   "Paid PR reviews (Dave, 2026-10-30)". Then wait.
7. Post the outcome to the user: finding count, fixed count, dismissed count, Greptile confidence
   (when Greptile reviewed), CI status.
8. For FourthBot, add a Sync row in the Grok↔Claude comms hub.

Never merge the PR. That is a separate, confirmed decision. Before Dave says merge, check three facts: you
read the newest round in full, the fix push is verified (`review-status.mjs` on the pushed head), and the carry
line or a review names that head.

## Paid PR reviews (Dave, 2026-10-30)

Billing facts (CodeRabbit docs, measured on PR #221):

- A reviewed file costs $0.25.
- Round 1 bills every reviewable PR file. A later round bills only the files changed since the last reviewed commit.
- Billing exclusion by `path_filters` is unproven. `cr-paid.mjs` applies the filters and shows both file counts.
- The mode is On demand. Past the included limit, a plain `@coderabbitai review` never bills.
- A seat holder pays with `@coderabbitai review --use-credits`. It covers the current commit only.
- In Automatic mode, an over-limit review bills with no prompt. So run the cap check before EVERY review request.

Post a paid round without asking only when ALL six conditions hold:

1. READY needs a CodeRabbit review of this head, and no carry is possible.
2. The round is inside the PR round budget (`pr-checkpoint`: 1+1, risk list 1+2).
3. The next included slot is more than 15 minutes away (comment `@coderabbitai rate limit`). Otherwise wait.
4. The round costs $5 or less.
5. The paid spend of all sessions today (America/Chicago date) plus this round is $15 or less.
6. For round 2 or later: every finding of the last round is fixed, its threads are resolved, and the `cr-fix` line is clean.

Stop and ask Dave when any of these is true:

- The round is past the budget.
- A fix round brings a new Major in code the fix touched (a spiral).
- The fix since the last reviewed commit is over 30 lines or adds files.
- Either cap would be crossed.
- This would be the third paid round on one PR.

Commands:

1. Run `node scripts/github/cr-paid.mjs check --pr <N>`. It checks conditions 4 and 5, the paid round count and the fix size. It does not check conditions 1, 2, 3 and 6.
2. On ALLOW (exit 0), post exactly the comment it prints: `@coderabbitai review --use-credits`.
3. On ESCALATE (exit 3), stop and ask Dave. Exit 2 gives no verdict, so treat it as ESCALATE.
4. After you post, run `node scripts/github/cr-paid.mjs record --pr <N> --head <sha> --files <K>`. It writes the shared ledger `~/.claude/state/coderabbit-paid.jsonl`.
5. Run `node scripts/github/cr-paid.mjs today` to read today's total.

Packaging rules:

- Open fewer, larger PRs: bundle related work in one area into one PR (Dave, 2026-10-30).
- Larger PRs need fewer rounds: 0 to 10 file PRs average 2.2 rounds, 26 to 60 file PRs average 1.75.
- Round 1 bills every reviewable file, so a round 1 over 20 files goes past the $5 cap and needs Dave.
- `docs/**`, `thoughts/**` and vendored skills are not reviewed.
  Billing exclusion by `path_filters` is unproven. `cr-paid.mjs` leaves them out of its estimate.
- Run the Claude review and the `pre-pr.mjs` CLI review before round 1.
- Push once per fix round.

## Proof in the PR body (live, P4b)

Every PR body names one proof type and shows its evidence. `review-status.mjs` reads it from the PR
body only, never from a comment. Write the Evidence block from `pr-and-commit-style.md` when you open
the PR. After each push, run the GREEN check again on the new head and update the GREEN line only.
Keep the CodeRabbit and Greptile blocks in the body byte for byte.

| Proof type | Use it for | RED (BEFORE for a refactor) | GREEN, on the head |
|---|---|---|---|
| `bugfix` | a defect | A test or probe that reproduces the bug fails on a commit before the fix. | The same command passes. |
| `feature` | new behaviour | The end-to-end check, written first, fails. | The same check passes. Add unit tests only where the end-to-end check cannot reach. |
| `refactor` | behaviour that must not change | BEFORE: the full suite passes on the commit before the change. | The same suite passes. |
| `ui` | an interactive or UI change | The Playwright run at desktop and phone width fails. | The same run passes at both widths. |
| `harness` | a hook, rule, skill or agent | The AGENTS.md "Testing" row shows the old behaviour. | The same row shows the new behaviour (see "Harness proof"). |
| `docs` | text only | None. | None. Valid only when the review router classed this head `docs`. |

Name one type. A PR that mixes types names the type of its riskiest change.

### Harness proof

Use the AGENTS.md "Testing" row for the surface you changed.

- A hook: build it, then pipe a real payload into the built hook. This is the full row, and it runs
  before the merge.
- A rule, skill or agent: run the static gates (`context-budget-guard.mjs --repo`, `audit-skills.mjs`,
  `check-agent-model-drift.mjs`, `check-agent-body.mjs`) and `rule-router-probe.mjs` in the worktree.
  The behaviour run, `claude -p` on a prompt the change targets, needs the change in `~/.claude`.
  Policy: do not sync a branch into `~/.claude`. Run that step after the land and note it on the
  PR. It is not a READY item.

### Closest executable check

Work with no test harness still needs RED and GREEN. Use the closest executable check. It is the
cheapest command that does three things:

1. It runs the real artifact the way a user or the harness runs it.
2. It exits non-zero, or prints a named failure line, when the behaviour is wrong.
3. It gives the same result when you run it again.

Prefer, in this order:

1. An existing probe or gate script.
2. A short script in `.claude/cache/e2e/` that reads the real artifact and checks the change. Keep
   it and name it.
3. A `claude -p` run whose JSON shows the behaviour.

These are not checks: reading the file, a grep hit, "it compiles", a type check alone, an agent's
report. For a pure addition, RED is the same check on the commit before the change. It shows the
missing behaviour. Subagents never commit: the main session supplies the RED commit, and it can be the base.

### What READY checks

- One `Proof type:` line, outside HTML comments, code fences and bot blocks. It uses a known type.
  Write one type only, with at most a parenthetical after it.
- Each field the type needs, once: a command in backticks, `@`, a commit SHA (7 to 40 hex
  characters) and a fenced output block that is not empty. A placeholder like `<command>` fails.
- The GREEN SHA is the head.

CodeRabbit carry. READY accepts the newest CodeRabbit review of an earlier head when all of these
hold. `review-status.mjs --json` then prints `coderabbitCarried: { from, deltaLines }`.

- That review has Minor or nitpick findings only. `review-status.mjs` maps Trivial to minor. An unknown severity counts as Major.
  A review with no "Actionable comments posted" sentence counts 0 inline comments. Its body severity and outside-diff marker checks still apply.
  READY also counts its outside-diff findings, and the PR body must list each one as handled.
  A body with nothing to read blocks the carry.
- A clean round can leave only the summary comment and no review object. That summary is a carry source when it
  meets seven conditions. The CodeRabbit app wrote it. No person edited it. It is not a notice.
  It says "No actionable comments were generated". It covers an earlier commit, not the head. It is newer than the newest
  review object. No review object holds the commit it covers.
  The covered commit comes from the first coverage marker of `kind: reviewed`, even when other markers exist.
  With no coverage marker, it comes from the last "between <sha> and <sha>" line.
  A coverage marker with no reviewed kind, or one that is unreadable, rules the summary out. The "between" line then does not count.
- The head is `ahead` of the reviewed head. The delta is 30 lines or fewer: additions plus
  deletions over the files that are in both the compare and the PR. A merge of main that touches
  other files does not count. A change of main inside a PR file still counts. A compare of 300 files blocks.
- The router state names the head. The class is not r3 and the PR has no `risk:high` label.
- No PR file matches `checkpoint.critical` or `checkpoint.parser` in `review-router.config.json`.
- The PR body holds a `CLI fix review: <from>..<head> clean` line from `cr-fix.mjs`. `from` is the first 7 or more
  hex characters of the carried review's commit. `head` is the start of the current head. A missing, old or
  not-clean line blocks the carry.
- The CodeRabbit status is not pending. CI is green. The proof GREEN line names the head.

Sometimes only the CLI line blocks the carry. Then the reason tells you to run `node scripts/github/cr-fix.mjs --pr <N>`.
It also tells you to put the output line in the PR body. It does not ask for a review. Do not post `@coderabbitai review` for it.

Any other missing fact blocks the carry. Then READY asks for a review of the head as before. A carry does
not clear unresolved threads, outside-diff findings or the Greptile requirement.
READY counts outside-diff findings in every CodeRabbit review body, with or without the review sentence.
A carried round with unhandled outside-diff findings stays NOT READY.

`review-status.mjs --json` prints `coderabbitCarryBlockers`. It is a list of strings that stopped the carry.
It is not a READY reason and does not change READY. The text output lists the strings under the reasons.

`cr-fix.mjs` stops with exit 2 when CodeRabbit already reviewed the head. The head has a review object, or a trusted clean summary that covers it.
It prints "CodeRabbit already reviewed the head; no CLI run needed" and spends no CLI run.
`cr-fix.mjs` lists the merge commits in `<from>..HEAD` after the run. It names each one on stderr, with 7 characters of the sha.
The review still runs, and the exit code does not change. Merged-in code, such as main, is part of that review.
A finding may come from that code and not from your fix commits. Read `.claude/cache/e2e/<date>-cr-fix-<head7>.txt`
to see which commit holds a finding. The `CLI fix review:` line on stdout keeps its form, so the carry still reads `clean`.

READY checks the shape and the head. It does not judge whether RED really failed. The reviewer does.

Exemptions:

- A Dependabot PR, as defined at the top of this file.
- A `docs` PR. It still writes `Proof type: docs`. The review router's comment must name this head
  with class `docs`, and every `risk:*` label must be `risk:docs`. No RED or GREEN is needed.
- A repo other than CCv3. `review-status.mjs` runs the check only for it.
- `land-pr.ps1 -IgnoreReview` skips this check with the rest. Post the reason on the PR.

### Last step before done

Before you say done or fill in GREEN, read
`~/.claude/skills/_vendor/pstack/skills/principle-prove-it-works/SKILL.md` and apply it. Keep the
artifact in `.claude/cache/e2e/`. Never commit it.

## Before you call a PR ready, or land it

Run `node scripts/github/review-status.mjs <N>`. Say "ready" only when it prints READY. READY means:
every bot the labels require reviewed the CURRENT head commit (a CodeRabbit PR-bot review, not CLI
output; a CodeRabbit carry counts, see "What READY checks"; while Greptile auto review is off, CodeRabbit replaces Greptile in that list; a Dependabot PR
as defined above needs none); a Greptile review, when required, has a check run `success`, a summary
naming that head and confidence at least 4/5; 0 threads unresolved from any reviewer; every commit status other
than CodeRabbit's is `success`; every check run other than Greptile's is completed with `success`,
`neutral` or `skipped`; the PR body names one proof type with its evidence, and its GREEN line names
the head (see "Proof in the PR body"; a Dependabot PR needs none); the `Outside-diff: handled` list
covers every outside-diff finding in the CodeRabbit reviews of the PR (see "When the review lands");
and `mergeable_state` is clean. A merge was once called safe 92 s before a
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

Gate C, the pre-merge re-check: `land-pr.ps1` records the time of its last READY check.
Right before the merge call, it runs `node scripts/github/land-recheck.mjs`. That script re-reads the PR, its reviews, its comments and the head's commit statuses.
It reads the comments with their edit history, through the same reader READY uses (`readIssueComments`).
It refuses, and nothing merges, in four cases:

1. The head SHA changed.
2. A CodeRabbit review, or an edit of the CodeRabbit summary comment, is newer than the READY check.
3. A person's `@coderabbitai review` or `@coderabbitai full review` comment is newer than the last CodeRabbit review with a body.
   It is also newer than the CodeRabbit summary comment. That second test counts only a summary that is trusted, covers the head and is not a notice.
   Then a review is in flight.
   A clean on-demand round can end as a summary edit with no new review object. That edit answers the request.
   Trusted is the READY rule (`trustedCodeRabbitSummary`): a summary a person or another app edited, or one with no readable edit history, answers nothing.
4. The CodeRabbit commit status on the head is pending.

Exit 1 is a refusal. Exit 2 is a read error or a bad payload. `land-pr.ps1` treats both as a refusal and prints "Nothing was merged".
`land-pr.ps1` takes the READY time from the local clock minus a 120-second margin, before the READY check reads the PR, and prints the margin.
A review that landed in the 120 seconds before the READY check counts as new, so a local clock that runs ahead of GitHub cannot hide it.
A clock skew can still refuse a PR by seconds. The check fails closed.
`-IgnoreReview` still bypasses the READY check and the re-check. It prints a skip line. Post the reason on the PR.

## Repos still on CodeRabbit

A repo without `.greptile/config.json` may still use CodeRabbit (`coderabbitai[bot]`). There:

- Proof of a review is a CodeRabbit review object on the head whose body has
  "Actionable comments posted: N", or its summary comment naming the head commit. A green
  `CodeRabbit` commit status alone is not a review.
- "Review rate limited" or "Review limit reached" is not a review. Do not post `@coderabbitai review`
  after that notice; it is refused. Request the paid review only under "Paid PR reviews (Dave,
  2026-10-30)". Otherwise report to Dave; with his merge yes, land with `-IgnoreReview`.
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
moves to a new base. It also runs when CodeRabbit posts a rate-limit notice, to update its note. It runs `scripts/github/review-router.mjs` with `review-router.config.json`
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
- After a checkpoint, the state line also holds `pclass`. The router writes `consumed` in its own comment line,
  `<!-- review-router-consumed id=<n> -->`, right after the state line. The state line keeps the shape that an older router reads.
- The router writes `consumed` only after a ready event that a marker confirmed. It is the highest fresh `pathway-confirmed` marker id for the head.
  That id covers an unused marker above the one the ready event used, such as a marker left by a failed ready step.
  An older comment without the line still parses.
- A marker belongs to one ready event. The router skips a marker whose comment id is not above `consumed`.
  Once an id is consumed, the router ignores a marker with no numeric id. Only an owner, member or collaborator marker counts.
- `gh pr ready --undo` followed by a UI "Ready for review" on the same head is not a checkpoint. The old marker does not count again.
  The "Class raised ... run /pathway again" note stays.
- A new `/pathway` run posts a new marker with a higher id. The next ready then counts as a checkpoint.
  `pclass` becomes the current class, and the note clears. A push, a reopen and an open keep the saved `consumed` id.
- READY trusts a label that drops Greptile only when that comment names the current head and no
  `risk:*` label is above its class. Otherwise Greptile stays required (CodeRabbit instead while
  Greptile auto review is off), and READY says why.
- Known limit: anyone who can push a branch can run a workflow as `github-actions[bot]`. That person
  can already change labels, so the comment is not a defence against them.
- Each decision is one JSON line in the job summary (tool `router`).
- To test by hand, run `node scripts/github/review-router.mjs <PR> --dry-run`. Add `--assume-ready`
  to see a draft PR as a ready one. Never run it without `--dry-run` on this machine: a live local
  run posts a comment as you, which the router ignores.

## Target (approved, not built)

Approved in the Wiring Plan on 2026-10-25 (D2, D3, D4). **None of this is live.** Each item names the
phase that builds it. Until then the live steps above apply.

- **Greptile at ready, not on every push (Phase 3, DW-80; D3).** Superseded on 2026-10-26: Dave
  turned Greptile's automatic review off (`autoReview: []`). Greptile stays installed.
  `review:deep` bills Plus, never Apex, and stays blocked until the Apex-billing root cause is known.
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
