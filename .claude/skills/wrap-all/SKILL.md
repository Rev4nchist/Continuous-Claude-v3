---
name: wrap-all
description: Brings every live session on a lane board to a clean handoff point, so Dave can compact or hand off all sessions at once. Use only when Dave types /wrap-all.
disable-model-invocation: true
---

# Wrap all sessions

`/wrap-all` runs in the seat session (the holder of `re-program`). It brings every live session on the board to a stop point and a Notion handoff. Dave then compacts or hands off all sessions at once.

Only the seat sends. Any other session that runs `/wrap-all` gets the dry run and the line `only the seat sends; run /wrap-all in the seat session`. With no holder of `re-program`, the skill says so and sends nothing.

## Step 0: the dry run (always first, sends nothing)

```
node C:/Users/dkhay/continuous-claude/scripts/coordination/wrap-all-table.mjs
```

It reads the live sessions, their lane notes, the run lock, the FleetOps publish lock and the worktrees. It prints one row per session: running work, uncommitted files, commits behind `fork/main`, and a stop point. It prints the `fork/main` sha its behind counts use and the time of the last fetch. It runs no fetch, no `say`, no SendMessage and no delete.

Stop points in the table:

| Stop point | Meaning |
|---|---|
| READY TO WRAP | Idle and clean. The session writes its handoff. |
| WAIT FOR END | A pre-pr or hook build runs. It finishes and sends its END word. |
| SAVE PATCH | Uncommitted tracked files. Save them as a patch in the lane e2e folder. |
| MERGE MAIN BY V7.10 | Behind `fork/main`. Merge by V7.10 and push. |
| RELEASE LOCK FIRST | The session holds the FleetOps publish lock. It finishes the step or runs the failed release with its step number. |

A session that is not the seat stops here.

## Steps for the seat (after Dave says go)

1. Send the WRAP WORD (the table output prints its text) to each live holder by lane DM and by SendMessage. A lane DM does not wake an idle session.
2. Each session reaches its stop point. No new PRE-PR START, HOOK BUILD START or paid run. A running pre-pr finishes and sends its END word. A pending merge of main is done by V7.10 and pushed.
3. Each session rewrites its lane note with `WAITS ON` and `NEXT`, writes its Notion handoff (`/create_handoff`) and replies `HANDOFF DONE <lane> <head> <Notion url>`. Counts go in words in a handoff, because the listed-id scan reads plain numbers.
4. The seat tracks the replies. It rechecks any land in flight (merged on GitHub, sha on `main`, sync cursor).
5. A FleetOps refresh or other lock in progress ends cleanly. The seat checks `publish.lock` in the table and waits for it to be free.
6. The seat writes its own handoff last. It names the seat timer (cron, minute and prompt) so a new seat session can re-create it. The seat re-creates nothing for other sessions.
7. The seat gives Dave one table: session, stop point, handoff link.

## Failures this skill stops

- **A START word sent before the run lock granted.** Builders wrote `PRE-PR START` and then the lock answered WAIT (exit 75): nothing ran, and the START had to be voided. Run `pre-pr.mjs --preflight` first: it takes no lock and fails fast. Write the START in your lane note and send the seat one line after PREFLIGHT PASS and the V7.3 reads, and before the run. When the run lock answers WAIT (exit 75), write VOID in the note: nothing ran. The wrap word forbids new STARTs and never asks for one.
- **A folder removed before the seat named it.** A worktree was removed with a session still using it. `/wrap-all` removes no folder and no worktree. The table lists worktrees with no live session, and the seat names each one before anyone removes it. A junction is unlinked first, never deleted with a recursive remove.
- **A FleetOps refresh cut at step 6.1.** A wrap stopped a session in the middle of the upload and left the publish lock failed. The holder finishes the step or runs the failed release with its step number. The table shows RELEASE LOCK FIRST until the lock is free.

## NEVER

- Run `/compact` for another session.
- Kill a session.
- Force-delete a folder.
- Send the WRAP WORD from a session that is not the seat, or when no session holds `re-program`.
