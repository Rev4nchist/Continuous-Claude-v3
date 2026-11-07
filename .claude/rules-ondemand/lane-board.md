# Lane boards

A board is a set of lanes and events keyed by `project_key`. Every project with a registry entry can have one.
Full design: `C:/Users/dkhay/continuous-claude/.claudedocs/2026-11-04-per-project-lanes-plan.md`.

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
- The read cursor is `<uuid>` on `continuous-claude` and `<uuid>@<board>` elsewhere.

## Reminders

- A reminder is a lane with a due time. Version 1 only notifies: nothing runs on its own.
- Verbs: `node C:/Users/dkhay/.claude/scripts/lane.mjs remind set|list|snooze|ack|clear`. Needs migration 0005.
- `remind set <id> --at <time>`: a new id needs `--title`. Without `--pri` an existing lane keeps its band and a lane with no band gets P1. P0 only with a literal `--pri P0` (soft cap 5).
- `remind set` never changes the title or band of a lane another session holds. Set the band first with `band`.
- SessionStart prints a "Reminders due" block. `ack` closes it, `snooze --for 2h` moves it.
- `next` and "Claimable next" never offer a lane on track `reminders`, or a lane whose due time is still ahead.
- The `CCv3-Reminder-Tick` task runs every 5 minutes (`remind tick`): it fires due reminders, shows a toast for P0 and P1, and syncs the To-Do Board through one headless `claude -p` only when a row changed. A Done card in Notion acks the reminder. The Notion sync is off until `remind sync on`, polls Done every 2 hours, and is capped at 12 runs a day. Code: `scripts/coordination/reminder-tick.mjs`, `reminder-sync.mjs`.

## Phone page

- `continuous-claude` has the page `RtrTNVfAq9uowmb2tfbzid` (`.claude/artifacts.json`). Any other board has a published, interactive page only when its registry entry carries `laneArtifact` (a `https://claude.ai/artifact/<id>` url). Dave starts one with `/publish-board <key>`. `project register` only prints a hint.
- The page opens on **By band**: P0 this week, P1 next, P2 later, Unsorted, open lanes only, in the shared sort order. P0 shows `n/5`; above 5 it turns amber with "over the cap of 5". The cap is soft. The **Columns** button shows the drag board; on the editable page each card has Do next, Done and Move to (Top or Bottom of a column). The choice is kept in the browser (`lb-view`, `lb-group`). The read-only page has both views too, but none of these buttons. Columns ends with a read-only Done column (done in the last 7 days, at most 30, never saved, no rank).
- In Lanes, state chips and band chips combine; a second click on a band chip clears it. Group by Track or Band regroups the same rows. A card shows `rank N` (`lane.priority`) and a band chip. Dave sets a band with `node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`; a drag, Do next and Move to change rank only (By band keeps band first, so a Do next card is first in its own band). Done is a card status that the sync applies after Dave's yes.
- First banding: `node C:/Users/dkhay/.claude/scripts/lane.mjs band-backfill --dry-run`, then apply with the `to apply:` line it prints (`--apply --p0 id,id|none --expect N`) only after Dave's yes and his P0 picks. Only lanes with band IS NULL get the map; a lane named in `--p0` gets P0 whatever band it has. A second run with the same `--p0` list changes 0 rows. One summary line goes to the board inbox, not one per lane.
- A board with no `laneArtifact` renders `lane-board-<key>.html` on this machine, read-only (a Priorities section from lane state and priority). Never publish it.
- After a lane change on any board, the hooks render its page. Publish a board's page only to its own url, with no `capabilities`. Never to another board's url: each page keeps its own db.
- Your held copy of a page is old: other sessions publish all day. Order: read the live url (Artifact tool, action `read`, without `path`: a read with `path` does not count; do not open the saved file), render, publish at once. A refused publish counts as the read: publish the same file again. Render again only if you changed the lane DB since.
- `kanban-sync` reads one board's page at a time and passes `--project <key>`.
