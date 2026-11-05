# PR and Commit Style

Dave reads every title and description. Write them so a reader who was not in the session
knows why the change exists. Source: Theo's PR skill [vid:e1snsuY4lTI @15:14, @16:04].

## Title says why, not what

The title usually becomes the commit message. Follow the repo's convention (`feat(msys): ...`,
`fix(hooks): ...`; look at `git log --oneline -20`). Then say why the change matters, in plain words.

- Bad: `perf(server): negotiate permessage-deflate on the websocket`
- Good: `perf(server): cut websocket frame size 70% with gzip`

## Description opens with the problem, then the fix

First sentence: the problem, in the words of the original ask. Second: what changed. Then evidence.
Do not lead with an implementation inventory.

- Bad: "Removed implicit workspace carryover from every new-thread entry point. New threads inherit
  only the project from context; branch, worktree, audio..."
- Good: "My 'new worktree' default was ignored when starting a thread on an existing worktree. Now
  the preference always applies. Verified: 3 new threads on 2 worktrees, all honoured the setting."

Then: **Evidence** (the block below; READY reads it), **Scope not included** (what
you deliberately left out), **Model + harness** one-liner at the end (`claude-fable-5 via Claude
Code`), because Dave runs several harnesses and tracks which produced what.

For a Summary visual and a Merge Danger block, use the vendored Pocock template
(`~/.claude/skills/_vendor/pocock-skills/skills/pr/SKILL.md`) inside this structure. This file wins on conflict.
Its Evidence section (Before/After) is replaced by the Evidence block below: Before is RED, After is GREEN.

## Evidence block (READY reads it)

Every PR in `Rev4nchist/Continuous-Claude-v3` carries this block in the PR body. `review-status.mjs`
fails READY without it.

~~~markdown
## Evidence

Proof type: <bugfix | feature | refactor | ui | harness | docs>

RED: `<command>` @ <red-sha>
```text
<failing output: the runner's summary line and the first failure>
```

GREEN: `<command>` @ <head-sha>
```text
<passing output: the runner's summary line>
```
~~~

- Pick the type from the table in `pr-review-loop.md` "Proof in the PR body". Name one type.
- RED: the commit where the check fails. GREEN: the head of the PR. After each commit, before pre-pr,
  run the check again and update the GREEN line.
- A refactor writes `BEFORE:` in place of `RED:`, with the passing output. A docs PR writes only the
  Proof type line.
- Each field has a command in backticks, `@`, a commit SHA (7 to 40 hex characters) and a fenced
  output block that is not empty. Start the field name at the start of the line. A numbered list
  item (`1. RED:`) does not parse.
- Under the block, name the artifact file in `.claude/cache/e2e/`.

## Keep the PR the size of the ask

Review-bot comments and side-findings do not grow the PR. Fix real findings and CI failures; reply
with a one-line reason when you dismiss a false positive; note the rest as follow-ups. A PR three
times its original ask is a failure even if every comment was addressed.

## Commits

- One logical change per commit. Same title rule.
- Commit only your own work. Other sessions share this tree; stage the files you touched, never `git add -A`.
- Commit and push through `pwsh -File scripts/git-safe.ps1 -C <repo> ...` (retries the MSYS crash). Use `commit -F <msgfile>` for the body, never `-m` with backticks.
- `gh pr create` and `gh pr merge` hang on this machine: use `gh api` (REST), e.g. `gh api repos/<O>/<R>/pulls -X POST -f title=... -f head=... -f base=main -F body=@<file>`.
- End the body with the `Co-Authored-By` / `Claude-Session` trailers the session prompt specifies.
