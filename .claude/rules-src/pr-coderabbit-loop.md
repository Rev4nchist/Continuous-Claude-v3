# PR submitted → CodeRabbit review loop

When a PR opens (`gh pr create` or `POST .../pulls`), start a `/loop` in the same turn. Interval 5
minutes. Do not wait to be asked.

## Loop prompt

Check CodeRabbit on the PR via the REST API. Use `GH_CONFIG_DIR` for the repo's account.

- `gh api repos/<O>/<R>/pulls/<N>/reviews`
- `gh api repos/<O>/<R>/pulls/<N>/comments`
- `gh api repos/<O>/<R>/issues/<N>/comments` — filter to `author.login == coderabbitai[bot]`
- GraphQL `reviewThreads` → `isResolved`, for thread state

## Stop conditions

- A CodeRabbit review or walkthrough comment exists. Stop, then act (below).
- 60 minutes pass with none. Stop. Report: "no CodeRabbit activity; check the app is installed on
  the repo."

## When the review lands

1. Read every actionable finding.
2. Fix real findings on the PR branch. Commit and push.
3. Reply one line per false positive to dismiss it. Give the reason.
4. Never resolve a thread you did not act on.
5. Re-run the loop once more, for the follow-up review after your push.
6. Post the outcome to the user: finding count, fixed count, dismissed count, CI status.
7. For FourthBot, add a Sync row in the Grok↔Claude comms hub.

Never merge the PR. That is a separate, confirmed decision.

## Thread state — verify, do not trust the bot's text

Never mark a thread resolved from CodeRabbit's own comment text. On 2026-09-01, a bot message said
a thread "remains open" and that was wrong. Verify `isResolved` via the GraphQL `reviewThreads`
query before you report or act on thread state.

## Enforced by hook

The `pr-opened-coderabbit-loop` PostToolUse hook (matcher `Bash|PowerShell`) watches every `gh pr
create` and `gh api .../pulls -X POST` call. When the response looks like a real success (a PR URL
or a `number` field), it injects `additionalContext` naming the PR and pointing back at this rule,
so starting the loop does not depend on remembering to. It fires once per PR URL per session (a
small state file under `os.tmpdir()` dedupes) and fails open on any error.
