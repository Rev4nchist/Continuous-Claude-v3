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

## Phone page

- `continuous-claude` has the page `RtrTNVfAq9uowmb2tfbzid` (`.claude/artifacts.json`). Any other board has a published, interactive page only when its registry entry carries `laneArtifact` (a `https://claude.ai/artifact/<id>` url). Dave starts one with `/publish-board <key>`. `project register` only prints a hint.
- The page opens on **By band**: P0 this week, P1 next, P2 later, Unsorted, open lanes only, in the shared sort order. P0 shows `n/5`; above 5 it turns amber with "over the cap of 5". The cap is soft. The **Columns** button shows the drag board. The choice is kept in the browser (`lb-view`, `lb-group`). The read-only page has both views too.
- In Lanes, state chips and band chips combine; a second click on a band chip clears it. Group by Track or Band regroups the same rows. A card shows `rank N` (`lane.priority`) and a band chip. Dave sets a band with `node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`; a drag changes rank only.
- A board with no `laneArtifact` renders `lane-board-<key>.html` on this machine, read-only (a Priorities section from lane state and priority). Never publish it.
- After a lane change on any board, the hooks render its page. Publish a board's page only to its own url, with no `capabilities`. Never to another board's url: each page keeps its own db.
- `kanban-sync` reads one board's page at a time and passes `--project <key>`.
