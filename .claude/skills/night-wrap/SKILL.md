---
name: night-wrap
description: Wraps every live session for the night and writes one Morning start handoff that starts them all again. Use only when Dave types /night-wrap in the seat session.
disable-model-invocation: true
---

# Night wrap

`/night-wrap` runs in the seat session (the holder of `re-program`). Dave typing it is his go: no second "go" tap. It brings every live session to a clean stop point with its own handoff, writes the seat handoff, then writes one **Morning start** row that Dave pastes into each session in the morning.

It uses the `/wrap-all` skill (the dry run table and the wrap word) and the `/create_handoff` skill. Rules: `.claudedocs/coordination/seat-standing-rules.md` version 22. Card: `night-wrap-skill`.

## Step 0: are you the seat

Run `node C:/Users/dkhay/.claude/scripts/lane.mjs mine`. The seat holds the lane `re-program`.

Not the seat, or no holder of `re-program`: run only the dry run of Step 2, print it, add the line `only the seat runs /night-wrap`, and stop. Send nothing.

## Step 1: queue first (rules v22 point 1)

1. Read the clock in CST. Run `lane.mjs mine`, `lane.mjs inbox --peek` and `ListAgents`. Read every CUT line in full.
2. Answer every builder message that waits on a seat read. A ruling made now is "for the morning": the builder puts it in its handoff NEXT.
3. A land in flight: finish the cycle (LAND DONE and recheck) or hold it for the morning. Never leave LAND HOLD open overnight.

## Step 2: dry run

```
node C:/Users/dkhay/continuous-claude/scripts/coordination/wrap-all-table.mjs
```

The `wrap-all` skill owns this table. A change to the table is a card of its own.

Read each row. UNKNOWN means the table failed closed: read that session's worktree (`git status`) yourself. A running pre-pr or hook build gives WAIT FOR END. A held FleetOps publish lock gives RELEASE LOCK FIRST.

## Step 3: wrap word, one per builder

Text = the WRAP WORD the table prints, plus three lines for that builder:

- **YOURS:** its own stop point. Let the run end. Finish read-only aegis and critic and put the findings in the handoff. No fix push. No new START.
- **NEXT in the morning:** the seat ruling it waits on, then its next cards in band order.
- **Outcome:** the one the seat recommends (SUCCEEDED, PARTIAL_PLUS, PARTIAL_MINUS, FAILED) with one reason. Dave's `/night-wrap` confirms it (rules v22 point 6): the builder writes it in its handoff and asks no outcome tap.

Write each text to a scratch file with the time filled from `Get-Date` in the same call. Send it by lane DM: `lane.mjs say --to <name> --lane re-program "<text>"`. In the next response send the same text by SendMessage, pasted word for word.

Fallback order when a send fails:

1. `say --to` refuses a session that is quiet over 2 hours. Send SendMessage, and write that session's line in the Morning start row (Step 6).
2. SendMessage is not delivered or the session is not listed: write "no wrap word delivered" in that session's line.
3. A broadcast (`lane.mjs say` with no `--to`) is the last fallback.

## Step 4: collect

Each builder replies `HANDOFF DONE <lane> <head> <Notion url>`. Rule on any review result that arrives (for the morning). After 20 minutes with no reply, send one more SendMessage. Still none: list that session as "no handoff" in the Morning start row, with its lane note.

## Step 5: seat handoff

1. Rewrite the `re-program` lane note: WAITS ON, NEXT, MS.
2. Log the wrap in `.claudedocs/coordination/milestones/re-program.md`.
3. Run `/create_handoff` for the seat (folder `re-plan-eval`). Give the outcome as the seat judges it. Include "Take the lane first", the seat timer (CronCreate, cron `37 * * * *`, the hourly prompt) and every ruling made for the morning. Use the title `/create_handoff` builds: `[Code→Next session] <topic> (<repo>) — YYYY-MM-DD`.

## Step 6: Morning start row

One row in the Handoffs database. `To` = Next session. Title: `[Code→Next session] Morning start: all sessions (continuous-claude) — <tomorrow's date>`. Body, in this order:

1. **Start order.** The seat first, then each builder. For each: the window name (`/rename <name>` if it is a fresh session), the resume line `Resume the handoff in Notion: "<exact title>"` copied from the handoff row, the handoff url, and the outcome.
2. **Seat timer.** The CronCreate line to make again.
3. **Your taps waiting**, in the order they come, each with the session it comes from.
4. **Cards per builder.** In band order, with the seat rulings each builder starts from.
5. **Cleanup for Dave.** Worktrees with no live session (from the table), folders to remove, reminders overdue.

Write the body to a file. Scan it: `node C:/Users/dkhay/continuous-claude/scripts/coordination/scan-listed.mjs <file>`. Gate 0 and strict 0 must hold before the write. Write counts in words. Set the previous Morning start row to Done.

## Step 7: report to Dave

One table: session, stop point, outcome, handoff link. Then the Morning start link. In Next steps, give the one line to paste in the seat window.

## NEVER

- Run `/compact` for another session, kill a session, or remove a folder or worktree.
- Leave a run lock, the publish lock or LAND HOLD held overnight.
- Land or merge a pull request, or set a band, during the wrap. Landing needs Dave's own tap and the land script is not part of this skill.
- Ask Dave an outcome tap per session.
- Write a pull request number or a listed id in the Morning start row without a scan.
