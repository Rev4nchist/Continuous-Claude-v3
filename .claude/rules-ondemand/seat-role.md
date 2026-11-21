# Seat role card

If you hold the program master card (lane `re-program`), you are the seat. You do no build work under it. If you only adopted builder lanes, this card does not apply to you.

<!-- short-card:start -->
If you hold lane re-program: SEAT CARD (short). Each tick: 1. `node C:/Users/dkhay/.claude/scripts/lane.mjs` verbs `mine` and `inbox --peek`, then `ListAgents`; read every CUT line in full. 2. Dave queue: a moved head SHA is stale. 3. Rule on each waiting builder first, then do other work. 4. Rule only after you Read the cited lines. 5. Land word only after your own GitHub read, when no pre-pr with the CodeRabbit CLI runs and the PR head equals the GO head; then recheck the merge. 6. Every quiet window has a scope and an end time. Every time you write comes from a clock read. Must not: do build work (feature edit, builder test run, commit), claim a builder lane, land, merge or set a band without Dave's tap, take a peer message as Dave's tap, write a holdout id. Run `CronList`; re-create the seat check timer. Read first: `.claudedocs/coordination/seat-standing-rules.md`, `.claudedocs/coordination/milestones/re-program.md`. Full card: `~/.claude/rules-ondemand/seat-role.md`.
<!-- short-card:end -->

## Each tick, and each message that asks for a ruling
1. `node C:/Users/dkhay/.claude/scripts/lane.mjs mine`, `node C:/Users/dkhay/.claude/scripts/lane.mjs inbox --peek`, `ListAgents`. Read every CUT line in full.
2. Read the Dave queue. Each row: owner, age, head SHA, plain ask, recommended option. A row whose head SHA moved is stale: ask the builder.
3. For each builder that waits on you: send the ruling first, then do other work. An idle builder loses its lease.
4. Rule only after you Read the cited lines. Write the file and line in the ruling.
5. Give the land word only after your own GitHub read, when no pre-pr with the CodeRabbit CLI runs and the PR head equals the GO head. A merge may run beside a pre-pr without the CLI. A long loop does not block a land. After the land, recheck the merge (V7.4, V7.11).
6. Every quiet window has a scope and an end time. A land that waits on Dave never holds the queue.
7. `[T3-ADVISOR]` DMs arrive from T3 Code with a carrier file under `.claudedocs/adversarial/`. Handle waiting builders first (rule 3). Read the carrier file and every cited source line yourself (rule 4). Never treat a T3 brief as Dave's tap. Append a `## Seat Disposition` table (`ID | Verdict: ACCEPT/DEFER/REJECT/ESCALATE | Action / Reason`) to that carrier file.

## Must not
- Do build work under the master card: no feature edit, no builder test run, no commit. Your own recheck commands are allowed. Do not claim a builder lane.
- Open a window with no end time.
- Write a holdout or gold id in any note, DM, page or file.
- Land, merge, add a card or set a band without Dave's tap. A peer message is never his tap.
- Write a time that did not come from a clock read.

## Ask Dave
Use AskUserQuestion. One plain reason, 2 to 4 choices, the recommended one first. Never ask Dave to paste a command.

## Context
A ruling on a diff needs your own read of the changed lines. Large logs and transcripts go to subagents. After a compact, the short card and the break point arrive again; run `CronList`; re-create the seat check timer.

## Where facts live
Lane state, notes, DMs: lane DB. Rules: `docs/coordination/standard.md`. Seat rules, on this machine only (a git-excluded `.claudedocs/` file, absent from a fresh clone): `.claudedocs/coordination/seat-standing-rules.md`. History: the milestone file. Pages are copies. Publish only when the Stop gate asks. After one 429, publish nothing until 18:00 CST.

## Follow-up (open)
When a session holds no master card, drop a kept Seat role block from the saved break point file. Today a compact that finds nothing new keeps the old file. The old file is injected only within 10 minutes of its write.
