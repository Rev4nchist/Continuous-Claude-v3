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

Then: **Evidence** (the command and its output, or the test count), **Scope not included** (what
you deliberately left out), **Model + harness** one-liner at the end (`claude-fable-5 via Claude
Code`), because Dave runs several harnesses and tracks which produced what.

## Keep the PR the size of the ask

Review-bot comments and side-findings do not grow the PR. Fix real findings and CI failures; reply
with a one-line reason when you dismiss a false positive; note the rest as follow-ups. A PR three
times its original ask is a failure even if every comment was addressed.

## Commits

- One logical change per commit. Same title rule.
- Commit only your own work. Other sessions share this tree; stage the files you touched, never `git add -A`.
- Use `pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>` (MSYS retry) and `-F` for the body, never `-m` with backticks.
- End the body with the `Co-Authored-By` / `Claude-Session` trailers the session prompt specifies.
