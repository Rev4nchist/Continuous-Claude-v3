# Lane boards

This rule stops your first lane command one time. Read it, then run the same command again.
If you see only a preview of this text, read `C:/Users/dkhay/.claude/rules-ondemand/lane-board.md` in full with the Read tool first.
Run every lane command as `node C:/Users/dkhay/.claude/scripts/lane.mjs <verb>`.

A board is a set of lanes and events keyed by `project_key`. Every project with a registry entry can have one.
Full design: `C:/Users/dkhay/continuous-claude/.claudedocs/2026-11-04-per-project-lanes-plan.md`.

<!-- standard-rules:start -->
## Rules of the coordination standard

Made from `docs/coordination/standard.md`, parts 2 to 7. Change the standard first, then make this section again. The evidence for each rule is in the standard.
`L` means `node C:/Users/dkhay/.claude/scripts/lane.mjs`. Levels: advice (text only), warn (code prints a warning), deny (code blocks the action).

### Lane life cycle

| Id | Rule | Level |
|---|---|---|
| L2.1 | Add a lane for planned work before you start: `L add <id> --title "..." --scope "..."`. A new lane is `backlog`. `add` on an id that exists replaces its title. It replaces the track, the scope, the priority and the band only when you give that flag. When another session holds the lane and the lane is not reclaimable (L2.8: its lease runs, or its holder was active in the last 5 minutes), `add` gets `REFUSED add <id> [not-holder] -- the lane is held by <label>`, exit 4, and nothing is written. A lane with no owner, or with a quiet holder whose lease ended (L2.8), is open to any session with no `--reason`. Run `add` on an id that exists only for a lane you hold. | advice; deny for a lane that another session holds and that is not reclaimable |
| L2.2 | Claim by id: `L claim <id>`. One session wins. The loser gets exit 3 and the holder's label. | deny |
| L2.3 | `claim` refuses a lane that is `blocked`, `done` or has an open dependency. It exits 4 with `REFUSED claim <id> [blocked]`, `[done]` or `[open-dependency]`. A lane that another session holds and that is not reclaimable (L2.8) still gives exit 3 (L2.2). To reopen a `done` lane: `L state <id> ready`, then `L claim <id>`. | deny |
| L2.4 | Do not claim a lane that `next` or the banner offers before you read its scope. Old lanes stay claimable. Both skip a lane with an open dependency. | advice |
| L2.5 | Claim before your first edit. The claim declares your scope. | advice |
| L2.6 | Scope text holds two parts: `OWNS: ...` and `NEVER: ...`. It can end with `RELATES TO: <lane ids>` (M4.12). Declare a wait as a dependency. The only writer is `L seed <file.json>` with an object `{"lanes": [...], "edges": [{"lane": "<id>", "dependsOn": "<id>"}]}`. It replaces every edge of each lane in `lanes`, and the title and the track of each lane (L2.1). No verb writes one edge. Also put `WAITS ON: <lane>` first in the scope text: a new note replaces the old note (M4.16). | advice; deny for a claim with an open dependency (L2.3) |
| L2.7 | Note one status line at each phase: `L note <id> "..."`. The owner's note renews the lease. | advice |
| L2.8 | A lane stays held while its lease is live or its holder is active. A reclaim needs both: a lease that ended (90 minutes after the last renew, or at the end time of a park, L2.9) and a holder quiet for 5 minutes. | deny |
| L2.8a | The hook renews your leases at each prompt. Run `L renew` before a wait that can pass 90 minutes. For a wait of 2 hours or more, park the lane (L2.9). The hook and `L renew` never cut a park. After an idle time of more than 90 minutes, run `L mine` before your next edit. Before you claim a lane another session held, read its note and check its worktree for uncommitted work. | advice |
| L2.9 | Park a lane you hold that waits 2 hours to 7 days: `L park <id> --for 6h --reason "<what it waits on>"`. `--for` takes a time from `2h` to `7d`, or give `--until <time>`. The default is 24 hours. You keep the lane, and the lease runs to the end time. The state goes to `review`; a `blocked` lane stays `blocked`. The note gets the prefix `PARKED until <time> -- <reason>` before the old note. A claim by another session gets exit 3 until the park ends and the holder is quiet 5 minutes (L2.2, L2.8). To resume: `L state <id> active`. Your next `state`, `release` or `done` also ends the park. A park by a session that is not the holder gets `REFUSED park <id> [not-holder]`, exit 4. A park of a `done` lane gets `[not-holder]`, exit 4, because a `done` lane has no owner. A `done` lane that you still hold gets `[done]`, exit 4. An end under 2 hours or over 7 days, or no `--reason`, is a usage error, exit 1. Do not park `re-program`. For a longer wait: `L release <id> --blocked --reason "<text>"`. Only the holder runs it, or a session with `--override` (L2.10); any other session gets `[not-holder]`, exit 4. In one write it sets `blocked`, no owner, no lease, and the note to the text. | advice; deny for `park` or `release --blocked` by a session that is not the holder |
| L2.10 | Only the holder changes a lane with `state`, `release`, `done` in all three forms, or `note`. When another session holds the lane and the lane is not reclaimable (L2.8: its lease runs, or its holder was active in the last 5 minutes), the verb gets `REFUSED <verb> <id> [not-holder] -- the lane is held by <label>`, exit 4, and nothing is written. When the holder is your own earlier session, the hint names `adopt --from` (L2.13). A reclaimable lane (L2.8) has no holder for this rule (Dave, 2026-11-10). A lane with no owner that is not `blocked` is open to any session. A quiet holder whose lease ended, or a `blocked` lane with no owner, needs `--reason "<why>"`. Without it the verb gets `[needs-reason] -- its holder <label> is quiet and the lease ended` or `-- the lane is blocked`, exit 4. `done --merged` and `done --no-pr` need no `--reason` on a `blocked` lane with no owner. Both test the lane and the holder before git and the evidence file, so a session that is not the holder gets no git or evidence error. A `--merged` value that is not 7 to 40 hex characters is a usage error, exit 1, before that test. `note` and `add` (L2.1) never need `--reason`. The event of a change with `--reason` carries the reason to the board. `--override --reason "<why>"` lets `state`, `release` and `done` change a held lane, and sends the old holder a message. The code lets any session use it; in the review-engine program only the seat uses it. `--override` without `--reason` is a usage error, exit 1. `state <id> <to> --if-state <from>` writes only when the lane is in `<from>`, else `[if-state]`, exit 4. The condition is tested on a met lane too (L2.12). `release --blocked` is for the holder, or a session with `--override` (L2.9). These paths do not use this holder test. The kanban sync skips a status or band change on a held lane and still writes its notes. A kanban status or column move of a lane whose park ended drops the `PARKED` prefix from its note. The reminder sync closes only a reclaimable lane on track `reminders`. `remind set` on a lane that another session holds changes only the reminder columns. `seed` writes each lane of its board. With `--as <id>` the command runs as that session. | deny |
| L2.11 | Release a lane you stop without finishing: `L release <id>`. It goes to `ready` and loses its owner. On a lane that another session holds (L2.8), `release` is refused (L2.10). For a hold of more than 7 days: `L release <id> --blocked --reason "<text>"` (L2.9). | advice |
| L2.12 | Mark done only after the merge: `L done <id> --merged <sha>`. A lane with no pull request: `L done <id> --no-pr --evidence <path>`. The path is a file under `.claudedocs/e2e-<lane-id>/`. The command records the SHA of `main` at that time. Both forms meet a dependency. A plain `L done <id>` still works but meets no dependency, and on a met lane it writes nothing. With `--if-state <from>`, `L state <id> done` on a met lane writes nothing only when the lane is in `<from>` (read in code, not run). A wrong `done` opens the dependent lanes until the seat's recheck. | advice; deny for a `--merged` SHA that is not on `main` or an `--evidence` path outside the folder |
| L2.13 | Hand off: before `/create_handoff`, note the lane with the next step. Write the lane id and your session id in the handoff. Keep the lane. On `/resume_handoff`: run `L mine`. If the lane is not listed, run `L adopt --from <old-session-uuid>`. Adopt works only when this session has the old session's chosen name (not an auto word) or names it as previous, and the old session ended or is quiet 5 minutes. It moves every open lane of the old session. If adopt is refused, do not claim: ask Dave. | advice |
| L2.14 | Drop a lane you added by mistake: `L done <id> --note "DROPPED: <why>"`. | advice |

### Ownership

| Id | Rule | Level |
|---|---|---|
| O3.1 | One writer per file set at a time. A file that two lanes name has one writer at a time. | advice; deny on Edit and Write inside one checkout for a file that another live session holds (`file-claims` hook) |
| O3.2 | The scope text lists the write set and the never-touch set. A program lane's overlap holds `ready`. | advice; deny (planned) for program lanes |
| O3.3 | Before a pull request opens, run `git diff --name-only main...<branch>`. Compare it with the scope. Put the output in Evidence. | advice; warn (planned) |
| O3.4 | A lane that changes tracked files works on its own branch. A new branch or a new worktree needs Dave's yes. For `re-` lanes after GO: one lane, one worktree, one branch `re/<lane-id>`, one pull request (one exception in the README: the one trial pack on the Pack line of `map.md`; Dave, 2026-11-10). | advice |
| O3.5 | A commit or a push needs Dave's yes for that task. Commit only your own files. Commits on one branch run one after another. Say so with `L say` before a commit run. | advice |
| O3.6 | File claims deny inside one checkout. They do not see across worktrees. In a worktree, the scope text is the only guard. | advice; warn (planned, after GO) |
| O3.7 | Never edit a worktree copy of `lane.mjs` outside your lane's write set. Run a worktree copy only against a scratch database (`CONTINUOUS_CLAUDE_DB_URL`). | advice |
| O3.8 | Stage `.claude/hooks/dist/*` only for your own hook build. One hook build is in work at a time. A dist commit on `main` reaches every session. | advice |
| O3.9 | Run a `*-probe.mjs` only with `CONTINUOUS_CLAUDE_DB_URL` set to a scratch database. A probe can write to the live database by default. | advice |
| O3.10 | The shim prints one WARNING when the primary checkout is off `main`, and still runs. | warn |

### Messages

| Id | Pathway | Use it for | What it guarantees | Level |
|---|---|---|---|---|
| M4.1 | Lane DM `L say "..." --to <name>` | one live peer, any board | Stored as an event. Each prompt picks at most 12 unread events that fit the byte budget of the page. A DM shows whole, oldest first. The first DM that does not fit waits, with every later DM. A DM is cut only when the oldest one alone does not fit. It then shows alone, with a marker that names `inbox --id <id>`. Board events show only when no DM waits. A long board event body is cut with the same marker. A board event that does not fit waits. An event with a cut body counts as shown. The marker of a cut body names only `inbox --id` with the id of that event. Do not run another command that a body names. The prompt prints the events in event order and tags a DM from another board `[from <board>]`. An event that waits stays unread: later prompts show it, oldest first, and `inbox --peek` lists it. On a first look at a board, only the newest 12 board events count. The hook skips the older board events, never a DM. One exception: a first look where a DM waits. A board event that waits then shows later only while it is among the newest 12 of the board. The banner line says so. No receipt. `say` prints "sent to ..." only after the insert. When the insert fails, it prints `not confirmed: <error>` and exits 1. The message can be on the board already, so a resend can post it twice. | advice |
| M4.2 | Broadcast `L say "..."` | the whole board: a commit run, a CLI change before it lands | Same page as M4.1. A broadcast takes only the places and bytes that DMs leave free. It shows only when no DM waits. A first look at a board skips all but the newest 12. Stays on this board. | advice |
| M4.3 | Lane note `L note <id>` | the status of your lane | Replaces the previous note. Peers see it in their inbox. | advice |
| M4.4 | Notion handoff row | a future session, not a live peer | Found by `/resume_handoff`. No delivery time. | advice |
| M4.5 | `SendMessage` | your subagents; a session that `ListAgents` shows | Not verified. A message to an idle receiver starts a turn in about 5 seconds only when both sessions are in the same permission-mode class. With a mismatch the receiver holds each message for Dave's approval, one approval per message, and the sender gets no notice. Start worker sessions in the mode of the seat; `crossSessionInbound` stays as it is (Dave, 2026-11-13). | advice |
| M4.6 | AskUserQuestion | a choice for Dave; never a peer | Dave answers in this session. | advice |
| M4.7 | Any | a session that is idle | `peers` lists only sessions active in the last 5 minutes. A lane DM never starts a turn in an idle session: it shows in the next turn of the receiver. `say --to` prints a note after "sent to" when the receiver has been idle for 2 minutes. Each prompt shows at most 12 unread events that fit the page (M4.1). It marks as read only the events whose line is in the text that it sends. On a first look at a board, it also marks the older board events that it skips (M4.1). A text over its budget marks nothing as read. Above 3.0 seconds of process time the hook writes no cursor and still sends the text. It then writes one line to its error log. When a cursor write fails, the hook writes one line to its error log and still sends the text. So an event can show two times, but it is never marked as read and not shown. `inbox` never moves a read cursor back: it keeps the higher event id. `inbox --id <N>` prints one event in full and writes no cursor. `inbox --id=<N>`, with an equals sign, is a usage error, and nothing runs. | advice |
| M4.8 | Any | a reply | A held or unanswered message is not a reply. Do other work, not the shared resource. No reply after that: ask Dave. | advice |
| M4.9 | Any | message form | Plain text with names, SHAs and paths. Write a session as "name #sid8". | advice |
| M4.10 | Any | a message that must arrive | Also write it in your lane note. Ask Dave when no reply comes. | advice |

### Milestone messages

| Id | Rule | Level |
|---|---|---|
| M4.11 | At each milestone, send one lane DM (M4.1) to each session that holds a related lane: `L say "..." --to <name> --lane <your lane>`. A session that holds two related lanes gets one DM. Milestones: you claim, adopt or reclaim the lane (send the scope); your write set changes; a commit, a revert or a pull request that the receiver builds on or must read; a decision by Dave on the receiver's files; a finding in the receiver's files; a block that waits on the receiver; an earlier item is now false; your lane is done, released, parked or handed off. Send decisions and findings with your next commit DM, or within 30 minutes. A subagent sends none: its parent sends (S1.5). A headless run sends the first and the last only (S1.4). | advice |
| M4.12 | A lane is related to yours when both scopes name one file path, or one lane waits on the other, or Dave says so. A phrase such as "every other file" names no path. Write the ids last in your scope text: `RELATES TO: <lane ids>`. Only `add` and `seed` write the scope. Both replace the title. `seed` also replaces the track. `add` replaces the track only with `--track` (L2.1, L2.6). So run `L add <id> --title "<same title>" --scope "<full scope>"`. With no `--track`, the track stays. When a related lane belongs to a program, send to the seat of that program only. The seat passes the items to its sessions (M4.14). A lane with no holder, or a reclaimable lane (L2.8), gets no DM. `say --to` fails for a session that is quiet for more than 2 hours: tell Dave (M4.16). | advice |
| M4.13 | Form of a milestone DM. The first sentence says what the message is. Then at most 5 numbered items. Each item gives the fact, its path or SHA, and the lane or file of the receiver that it bears on. The last sentence is "Reply once (M4.14)" for a decision, a finding or a request, and "No reply needed" for status. "No reply needed" means "do not block on a reply". It does not mean "send no more". Never put a holdout or gold PR id, or a secret, in a DM or in its file copy. | advice |
| M4.14 | The receiver of a DM that carries a decision, a finding or a request replies one time: read, conflict or no conflict, and where each item goes. It records the items in a file that the next holder of its lane can read. A DM that carries only status needs no reply. | advice |
| M4.15 | Budget: one DM for each milestone and each receiver. Put all items of one milestone in one DM. Routine progress goes in your lane note (L2.7), not in a DM. Send no reply to a reply that says "no conflict". A reply that says "conflict" gets one answer. After that, ask Dave (M4.8). An idle receiver gets at most 12 unread events at each prompt that fit the page, DMs first (M4.1). The rest wait for later prompts. A working receiver gets the newest DMs that fit 4,000 bytes, at most 5, between tool calls, each whole. One that is alone and too long shows cut. Notes and broadcasts take only the prompt places and bytes that DMs leave free. They never show between tool calls. | advice |
| M4.16 | The file is the carrier. Append each milestone to `.claudedocs/coordination/milestones/<lane-id>.md` in the primary checkout: the time from a clock, the receiver, the items. The DM gives the items and this path. Keep `MS: <path>` last in your lane note. A new note replaces the old one, so write `WAITS ON` and `NEXT` again in each note (L2.13). A new note on a parked lane also replaces the `PARKED` prefix. The lane stays parked, because the lease is the park (L2.9). A kanban status or column move of a lane whose park ended drops the prefix too (L2.10). The reply (M4.14) is the only receipt. No reply by your next milestone: write `NOT READ: <holder>` in the file and tell Dave. An idle session reads no message until Dave types in it (M4.7). | advice |

### Shared pages

| Id | Rule | Level |
|---|---|---|
| P5.1 | Read the live phone page (Artifact tool, action `read`, no `path`), render, publish at once. Render with the primary checkout's `render-board.mjs --project <key>`, never a worktree copy. | advice |
| P5.2 | Publish a board's phone page only to that board's own url, with no `capabilities`. | advice |
| P5.3 | Before you sync, check the `<meta name="lane-board">` stamp names this board. Stop if it does not. | advice |
| P5.4 | Fix a wrong status at the source (`L note`), never in rendered HTML. `L note` is refused on a lane that another session holds (L2.8) (L2.10). Then send the holder the correction: `L say "..." --to <name>` (M4.1). | advice |
| P5.5 | A board with no `laneArtifact` renders a local page. Never publish it. | advice |
| P5.6 | Never pass `force: true` unless Dave asks to discard that version. | advice |
| P5.7 | After a lane change on a board with a phone page, publish the phone page only when the Stop gate asks. Do not publish before it asks. The gate asks only after `claim`, `release`, `done` or `park`. It does not ask after `say`, `note` or another verb. A pending file from before this change can ask one time. It asks at most one time in 10 minutes for each board. It does not ask from 150 page publishes in a UTC day, counted for all sessions on this machine. The count does not see a cloud session or another machine. Use the three steps the gate prints: read live, render from the primary checkout, publish. If a refusal names the daily publish limit, do not publish again that day. A change that another session left unpublished and not asked about for 10 minutes is asked one time, from the next session that ends a turn on that board. `kanban-sync` step 7 and a milestone portal refresh still publish. | warn (one block) |

### Board contract

| Id | Rule | Level |
|---|---|---|
| B6.1 | A board needs an active registry entry. The longest matching root wins, then a worktree gitdir. | deny (no board: exit 1) |
| B6.2 | Register a folder only with Dave's yes, from the primary checkout, with `L project register`. Remove a board only with Dave's yes: `L project unregister <key>` (never `continuous-claude`). | advice |
| B6.3 | Lane ids are global. `add` refuses an id of another board. A new board's starter lane uses the `<key>-` prefix. | deny (foreign id) |
| B6.4 | `continuous-claude` has the phone page in `.claude/artifacts.json`. Another board has a phone page only with `laneArtifact`. Dave starts one with `/publish-board <key>`. | advice |
| B6.5 | Reserved prefixes: `re-` (review-engine program; GO since 2026-11-11: claim only a lane that `program.mjs ready` prints) and `coord-` (lane tooling lanes). Other sessions claim neither. The seat holds `re-program` and claims no other program lane. For a program lane whose holder is gone, the seat runs `L release <id> --override --reason "<why>"`. Then it names a worker with `L say`, and the worker claims the lane. | advice; deny for a second `re-` lane per owner |
| B6.6 | A database writer sets `lane.client_version` before it writes. Without it, the trigger refuses a change or a delete of a lane on a board other than `continuous-claude` (error 42501). `continuous-claude` lanes are not protected. The setting is a cooperative flag, not security. | deny (other boards only) |

### One service line

| Id | Rule | Level |
|---|---|---|
| V7.1 | During a wave, no session changes verb behaviour, exit codes, banner text or `lane-board.md` without the agreement of the seat. | advice |
<!-- standard-rules:end -->

## Command path

- Run every lane command through the shim: `node C:/Users/dkhay/.claude/scripts/lane.mjs <verb>`.
- Never type a relative path to `lane.mjs`. It fails outside the primary checkout and runs a stale copy in a worktree.
- Off `main`, the shim prints one WARNING and still runs.

## How the board is chosen

- The registry maps your current folder to a board. The board follows the folder, not the session.
- A `cd` into another registered project changes your board mid-session. Your leases stay alive: the renew is keyed on you, not on the board.
- An unregistered folder has no board. Lane commands exit 1 and print the register command. Run it from the primary checkout only, and only with Dave's yes.
- Headless `claude -p` gets no board. Set `LANE_CONTEXT_HEADLESS=1` to opt in.
- `--project <key>` or `LANE_PROJECT=<key>` picks a board by hand.

## Messages and ids

- `say` broadcasts stay on the board. A DM to one session crosses boards and shows tagged `[from <board>]`.
- Lane ids are global across boards. A starter lane for a new board uses the `<key>-` prefix.
- The read cursor is `<uuid>` on `continuous-claude` and `<uuid>@<board>` elsewhere. The row `<uuid>@` records the newest DM shown.
- Each prompt shows up to 12 unread events that fit the byte budget of the page: DMs first, each whole, then the oldest board events. A long body shows cut, with a marker that names `inbox --id <id>`. The rest wait. A first look skips all but the newest 12 board events.

## Reminders

- A reminder is a lane with a due time. Version 1 only notifies: nothing runs on its own.
- Verbs: `node C:/Users/dkhay/.claude/scripts/lane.mjs remind set|list|snooze|ack|clear`. Needs migration 0005.
- `remind set <id> --at <time>`: a new id needs `--title`. Without `--pri` an existing lane keeps its band and a lane with no band gets P1. P0 only with a literal `--pri P0` (soft cap 5).
- `remind set` never changes the title or band of a lane another session holds. Set the band first with `band`.
- SessionStart prints a "Reminders due" block. `ack` closes it, `snooze --for 2h` moves it.
- `next` and the "Claimable (claim by id)" list never offer a lane on track `reminders`, a lane whose due time is ahead, or a lane with an open dependency.
- The `CCv3-Reminder-Tick` task runs every 5 minutes (`remind tick`). It fires due reminders and shows a toast for P0 and P1.
- It can sync the To-Do Board through one headless `claude -p`, only when a row changed or the Done poll is due. A Done card in Notion acks the reminder. The sync is off until `remind sync on`, polls Done every 2 hours, and is capped at 12 runs a day. Code: `scripts/coordination/reminder-tick.mjs`, `reminder-sync.mjs`.
- The `CCv3-Lane-Snapshot` task runs the lane export every day at 23:55 local (Central) time (`export-dash-data.mjs`, no model, hidden, runs on battery). It adds one row per Chicago day to `~/.claude/state/lane-dash/snapshots.json`. A run that starts after midnight (laptop asleep at 23:55) lands on the next day, and the missed day has no row. It reads the primary checkout's current branch; the log names it. Log: `~/.claude/logs/lane-snapshot/<date>.log`. After the export it runs `export-factory-data.mjs`, which writes `factory.json` (counts from the pre-PR, review, CodeRabbit and handoff files) for the Fleet app. Never upload it to FleetOps. Code: `.claude/scripts/scheduled/scheduled-lane-snapshot.ps1`.

## Dependencies

- `claim <id>` on a lane held (lease runs, or holder active in last 5m) exits 3. Otherwise it refuses a done lane, a blocked lane and a lane with an open dependency: `REFUSED claim <id> [<token>] -- <text>`, exit 4.
- `claim <id> --dep-override --reason "<text>"` skips the open-dependency refusal only. A kanban card cannot override it.
- `done <dep> --merged <sha>` or `done <dep> --no-pr --evidence <path>` meets a dependency. A plain `done <dep>` meets none and prints a hint.
- `board` prints `waits on: <ids>`. `board --json` has `waits_on`. A missing key means unknown: migration 0006 is not applied.

## Owner check and park

- Held by another session (lease runs, or holder active in last 5m): `state`, `release`, `done`, `note`, `add` give `[not-holder]`, exit 4. The holder always passes this owner check. No holder: open; `park` refuses.
- Quiet holder (lease ended, 5m idle) or unowned blocked lane: `state`, `release`, `done` need `--reason`; `note`, `add` do not. Exception: `done --merged` and `done --no-pr` on an unowned blocked lane need none. `--override --reason`: any held lane; no code test, seat by rule.
- `state <id> <to> --if-state <from>`: write only from `<from>`; owner checks first. Exit 1 for `--if-state` on `release`, `done`, `park`; `--blocked` on `state`, `done`; `--override` on `note`, `add`, `park`, `claim`; a bare `--reason`, `--if-state`, `--merged`, `--evidence`. Other flags: no effect.
- `release <id> --blocked --reason`: holder or `--override`; no owner.
- `park <id> --for 2h..7d --reason`: holder only, default 24h. The lease is the park; `board` shows `parked to` only above 91m. Never park `re-program`.
- A park ends: holder's `state`, `release`, `done`; new `park`; the end time; `state <id> <to> --override --reason` (lease 90m; to `ready`/`done`: free); `release --override`, `done --override`.
- Owner gone: `release <id> --override --reason handover; claim <id>` in ONE command.
- No owner test: kanban, `reminder-sync.mjs`, `seed`, `--as`, `remind`.

## Phone page

- `continuous-claude` has the page `RtrTNVfAq9uowmb2tfbzid` (`.claude/artifacts.json`). Any other board has a published, interactive page only when its registry entry carries `laneArtifact` (a `https://claude.ai/artifact/<id>` url). Dave starts one with `/publish-board <key>`. `project register` only prints a hint.
- The page opens on **By band**: P0 this week, P1 next, P2 later, Unsorted, open lanes only, in the shared sort order. P0 shows `n/5`; above 5 it turns amber with "over the cap of 5". The cap is soft. The **Columns** button shows the drag board; on the editable page each card has Do next, Done and Move to (Top or Bottom of a column). The choice is kept in the browser (`lb-view`, `lb-group`). The read-only page has both views too, but none of these buttons. Columns starts with a read-only Scheduled and reminders column (a future `due_at`, or a live reminder whose time has come and is not acked, on any track; open on the phone when it has cards; held lanes stay in In progress) and ends with a read-only Done column (done in the last 7 days, at most 30). Neither is saved or takes a rank. The Now column is retired. On a touch screen a tap on Move to or Do next does not move focus, open a collapsed column or scroll the page to the card: the card leaves the view and the live region says where it went. Fields are 16px so iOS does not zoom; a failed save pins its status line under the header. On the phone a tap on a By band row opens that lane's card in Columns. The column and its Details open. The view choice is not saved. Waiting on Dave sits above Later. Later shows 15 cards, then "Show N more". The Lanes list shows the state word under each title. A lane with an open dependency shows "waits on: <ids>" on its card and its By band row (two ids, then "+N more"). Details lists every id. "Dependencies unknown" at the top means migration 0006 is not applied. On a desktop browser (a mouse, wider than 720px) Columns is one wide board that scrolls sideways, and a drag near its left or right edge scrolls it; a touch screen keeps the grid.
- In Lanes, state chips and band chips combine; a second click on a band chip clears it. Group by Track or Band regroups the same rows. A card shows `rank N` (`lane.priority`) and a band chip. Dave sets a band with `node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`, or with the Band select in a card's Details (P0, P1, P2 or none); the sync applies a card band as a `band` lane event only after Dave's yes (kanban-sync). A drag, Do next and Move to change rank only and never write a band (By band keeps band first, so a Do next card is first in its own band). Done is a card status that the sync applies after Dave's yes. A card status `ready` on a lane with an open dependency gives `refused: open dependency`. The sync consumes the card, so set the status again after the dependency is met. A later state change on a met lane, such as one from the page, un-meets it.
- First banding: `node C:/Users/dkhay/.claude/scripts/lane.mjs band-backfill --dry-run`, then apply with the `to apply:` line it prints (`--apply --p0 id,id|none --expect N`) only after Dave's yes and his P0 picks. Only lanes with band IS NULL get the map; a lane named in `--p0` gets P0 whatever band it has. A second run with the same `--p0` list changes 0 rows. One summary line goes to the board inbox, not one per lane.
- A board with no `laneArtifact` renders `lane-board-<key>.html` on this machine, read-only (a Priorities section from lane state and priority). Never publish it.
- After a lane change on any board, the hooks render its page. Publish a board's page only to its own url, with no `capabilities`. Never to another board's url: each page keeps its own db.
- Your held copy of a page is old: other sessions publish all day. Order: read the live url (Artifact tool, action `read`, without `path`: a read with `path` does not count; do not open the saved file), render, publish at once. A refused publish counts as the read: publish the same file again. Exception: if the refusal names the daily publish limit, do not publish again that day. Render again only if you changed the lane DB since.
- `kanban-sync` reads one board's page at a time and passes `--project <key>`.
- The Stop gate (`lane-board-stop-gate`) may add one line to its block reason: "FleetOps data is stale (<when>). Tell Dave in one line. Run the fleetops-refresh skill only if he asks." <when> is "exported <time>, not uploaded" or "exported <time>, older than 36 hours". Stale means `~/.claude/state/lane-dash/refresh.json` has `pending: true`, or its `exported_at` is over 36 hours old. The line never causes a block. It rides only on a block that already happens. It shows at most once an hour per machine (marker `~/.claude/state/lane-dash/.refresh-shown.json`). A new export (new `key`) shows it at once. A headless run never gets it. `kanban-sync` step 8 reports the same condition. Never run `fleetops-refresh` unless Dave asks.
