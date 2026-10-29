# PR submitted → review loop

**Live today (CCv3 `main`):** **CodeRabbit** (`coderabbitai[bot]`) reviews a PR that carries
`review:coderabbit` or `review:deep` (`.coderabbit.yaml`, `auto_incremental_review: false`: a push
does not start a review). **Greptile** (`greptile-apps[bot]`) stays installed, but its automatic
review is off (`.greptile/config.json` `"autoReview": []`, Dave, 2026-10-26). While it is off,
`review-status.mjs` requires CodeRabbit wherever the labels would require Greptile. Only PR-bot
reviews on the current head count toward READY. `pr_watch` / `review-status.mjs` decide READY; only
Dave merges (`/land`). Follow the live steps below.

**Dependabot PRs** need no bot review (CodeRabbit refuses bot-authored PRs). This holds only when
the PR author is the `dependabot[bot]` Bot account and every commit is by `dependabot[bot]` and
signed by GitHub. A person's commit on that branch ends the exception. All other READY items apply,
except the PR body proof (see "Proof in the PR body").

**Approved target (Wiring Plan 2026-10-25, D2–D4): partially built.** Label-gated CodeRabbit, READY
counting (DW-91) and label routing at ready (P3c) are live. See "Target" at the end.

The in-session `/review` skill (Claude subagents) is an opt-in self-check. It **never** counts toward
READY (D4). Neither does a CodeRabbit CLI or plugin run (see `coderabbit-cli.md`; at most 2
`cr review --agent` runs per PR, counted by `pre-pr.mjs`; `coderabbit-guard` is built but not registered).

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

## Before you open a PR

CodeRabbit allows 8 PR reviews per hour for the one Rev4nchist identity. The rate drops to 6, 4, 2 and 1
per hour as the 7-day count passes 40, 50, 60 and 70. Each opening review and each `@coderabbitai review`
costs one. Aim for 2 reviews per PR. Facts: `.claudedocs/2026-10-27-coderabbit-review-budget.md`.

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
2. Open the PR as a draft (`gh pr create --draft`). Run `/checkpoint`: Dave picks the review pathway,
   and the mod adds the `review:` label and marks the PR ready. Never run `gh pr ready`, never add a
   `review:` label by hand, and never run `pr-checkpoint.mjs --confirm` or `--apply` from a shell.
   To return a PR to draft, run `gh pr ready --undo`.
3. Batch every fix into one push. Then post one `@coderabbitai review`. Never push while a review runs:
   the push supersedes it and the review is lost.
4. Bundle small fixes in one area into one PR.
5. Do not stack PRs by default. `base_branches` is `main`, so a stacked PR gets no review. READY pins the
   review to the head, so each restack needs a new review.
6. When the week is busy, post `@coderabbitai rate limit` before a review request. It costs no review.
   Keep the 7-day count under 40.

### PR review budget per class

The review router sets the class. This budget counts CodeRabbit PR reviews: the opening review and each
`@coderabbitai review`. It does not count CLI runs.

- docs: 0 PR reviews. The router adds no label.
- normal: 1 PR review, and at most 1 more after a fix push.
- steering, infra and r3: 1 PR review, and at most 2 more after fix pushes.
- Put all fixes of a round in one push. Then post one `@coderabbitai review`.
- Do not click GitHub "Update branch" unless the merge needs it. Each click makes a new head and a new review.
- A PR at its budget gets no more `@coderabbitai review` without Dave's yes. Ask him instead.

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
  `checkpoint.enforce` in `review-router.config.json` decides. It is `false` for the first week
  (warn mode): the hook allows the command and logs a `warn` row to the guard decision log. The stamp
  rules above are enforced in both modes.
- Residual risks, accepted: GraphQL with the query text in a file (`-F query=@file`) shows the hook no
  label or ready text. `gh pr ready --undo` and `-F "draft=true"` inside quotes read as a ready and a
  non-draft create (the hook does not lex quotes). A hand-written `pathway.json` (the Write tool) or an
  indirect script is accepted until the lock of spec section 3.6 (spike S2). A confirmed label is tied to
  HEAD, not to a PR number: `gh pr edit <other> --add-label review:deep` passes while that pathway stands.
  The hook does not read a subcommand built from a variable (`gh pr $sub 201`). The hook reads the mode
  from the cwd checkout. A cwd with no `review-router.config.json` is warn mode. Before PR C flips
  `enforce`, it must read the mode from the CCv3 checkout that the command names.
- `SKIP_PRE_PR_GATE=1` is Dave-only. An agent never sets it, never suggests it, and never copies it
  from a deny message. It works only as a leading assignment. Each use writes an `override` line to the
  guard decision log.

The gate stops accidents, not evasion. It cannot see a `gh` alias, `hub`, `curl` or a GraphQL
`createPullRequest` call. It cannot see a GitHub MCP tool call, a script that wraps `gh`, or a forged
stamp. A PR opened one of those ways skips the checks. It wastes the reviews this section protects.



## Waiting for the review

- CodeRabbit reviews when the PR has `review:coderabbit` or `review:deep`. A push does not start a
  new review: after a fix push, post one `@coderabbitai review` for the new head. Greptile does not
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
- Batch fixes into one push. Every review uses a bot allowance or credit. After 5 fix rounds
  without READY, stop and report to Dave.

## No review on the head

If no review from a required bot appears on the head after 15 minutes, or the last one was
cancelled, failed or skipped: post ONE review request for that bot (`@coderabbitai review`), then
wait again. After a CodeRabbit "Review rate limited" or "Review limit reached" notice, do not post
the request; report to Dave. If the request also produces no review, report to Dave. With his merge
yes, post the reason on the PR, then run `land-pr.ps1 -Pr <N> -IgnoreReview` (PR #111 precedent).

While Greptile auto review is off, post `@greptileai` only when Dave asks: each review bills a
credit. Do not raise the review tier (`@greptileai review this at apex`, 10 credits) without Dave's
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
     thread, so no thread count shows them. READY (`review-status.mjs`) adds N over every CodeRabbit
     review of the PR.
     A push does not clear them. READY fails while that total is above the number of handled bullets.
   - Fix each one, or list it in the PR body under the heading `Outside-diff: handled`. Write one
     top-level bullet per finding, with the fix commit or the reason. READY needs one bullet per finding.
     If a later review lists the same finding again, write one more bullet for it.
2. Fix real findings on the PR branch. Commit and push once.
3. For each real finding you fixed, reply `Fixed in <sha>: <what changed>` and add a 👍 reaction to
   the finding. Then resolve the thread through GraphQL `resolveReviewThread`. The bots never
   resolve GitHub threads themselves. On a Greptile finding, start the reply with `@greptileai`.
4. For each false positive, reply `<reason>` (with `@greptileai` on a Greptile finding) and add a
   👎 reaction to the finding. Then resolve the thread.
   The bots learn from replies and from 👍 and 👎 reactions. React only on a finding you
   judged: 👍 means real and fixed, 👎 means false positive. Add a reaction with
   `gh api repos/<O>/<R>/pulls/comments/<comment_id>/reactions -f content='+1'` (`-1` for 👎).
5. Never resolve a thread you did not act on.
6. Request the review of the new head (`@coderabbitai review`; a push does not start one) and wait.
7. Post the outcome to the user: finding count, fixed count, dismissed count, Greptile confidence
   (when Greptile reviewed), CI status.
8. For FourthBot, add a Sync row in the Grok↔Claude comms hub.

Never merge the PR. That is a separate, confirmed decision.

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
output; while Greptile auto review is off, CodeRabbit replaces Greptile in that list; a Dependabot PR
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
