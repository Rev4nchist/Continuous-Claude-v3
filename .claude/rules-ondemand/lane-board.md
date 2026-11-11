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
- `next` and the "Claimable (claim by id)" list never offer a lane on track `reminders`, a lane whose due time is ahead, or a lane with an open dependency.
- The `CCv3-Reminder-Tick` task runs every 5 minutes (`remind tick`). It fires due reminders and shows a toast for P0 and P1.
- It can sync the To-Do Board through one headless `claude -p`, only when a row changed or the Done poll is due. A Done card in Notion acks the reminder. The sync is off until `remind sync on`, polls Done every 2 hours, and is capped at 12 runs a day. Code: `scripts/coordination/reminder-tick.mjs`, `reminder-sync.mjs`.
- The `CCv3-Lane-Snapshot` task runs the lane export every day at 23:55 local (Central) time (`export-dash-data.mjs`, no model, hidden, runs on battery). It adds one row per Chicago day to `~/.claude/state/lane-dash/snapshots.json`. A run that starts after midnight (laptop asleep at 23:55) lands on the next day, and the missed day has no row. It reads the primary checkout's current branch; the log names it. Log: `~/.claude/logs/lane-snapshot/<date>.log`. After the export it runs `export-factory-data.mjs`, which writes `factory.json` (counts from the pre-PR, review, CodeRabbit and handoff files) for the Fleet app. Never upload it to FleetOps. Code: `.claude/scripts/scheduled/scheduled-lane-snapshot.ps1`.

## Dependencies

- `claim <id>` on a lane held by a live session exits 3. Otherwise it refuses a done lane, a blocked lane and a lane with an open dependency: `REFUSED claim <id> [<token>] -- <text>`, exit 4.
- `claim <id> --dep-override --reason "<text>"` skips the open-dependency refusal only. A kanban card cannot override it.
- `done <dep> --merged <sha>` or `done <dep> --no-pr --evidence <path>` meets a dependency. A plain `done <dep>` meets none and prints a hint.
- `board` prints `waits on: <ids>`. `board --json` has `waits_on`. A missing key means unknown: migration 0006 is not applied.

## Owner check and park

- Live holder: `state`, `release`, `done`, `note`, `add` give `[not-holder]`, exit 4. No holder: open; `park` refuses.
- Quiet holder or unowned blocked lane: `--reason`. `--override --reason`: any held lane; seat only.
- `state <id> <to> --if-state <from>`: write only from `<from>`. Exit 1 only for `--if-state` on `release`, `done`, `park`; `--blocked` on `state`, `done`; `--override` on `note`, `add`, `park`, `claim`. Other flags: no effect.
- `release <id> --blocked --reason`: holder only; no owner.
- `park <id> --for 2h..7d --reason`: holder only, default 24h. The lease is the park; `board` shows `parked to` only above 90m. Never park `re-program`.
- A park ends: holder's `state`, `release`, `done`; new `park`; the end time; `state <id> <to> --override --reason` (lease 90m); `release --override`.
- Owner gone: `release <id> --override --reason handover; claim <id>` in ONE command.
- No owner test: kanban, `reminder-sync.mjs`, `seed`, `--as`, `remind`.

## Phone page

- `continuous-claude` has the page `RtrTNVfAq9uowmb2tfbzid` (`.claude/artifacts.json`). Any other board has a published, interactive page only when its registry entry carries `laneArtifact` (a `https://claude.ai/artifact/<id>` url). Dave starts one with `/publish-board <key>`. `project register` only prints a hint.
- The page opens on **By band**: P0 this week, P1 next, P2 later, Unsorted, open lanes only, in the shared sort order. P0 shows `n/5`; above 5 it turns amber with "over the cap of 5". The cap is soft. The **Columns** button shows the drag board; on the editable page each card has Do next, Done and Move to (Top or Bottom of a column). The choice is kept in the browser (`lb-view`, `lb-group`). The read-only page has both views too, but none of these buttons. Columns starts with a read-only Scheduled and reminders column (a future `due_at`, or a live reminder whose time has come and is not acked, on any track; open on the phone when it has cards; held lanes stay in In progress) and ends with a read-only Done column (done in the last 7 days, at most 30). Neither is saved or takes a rank. The Now column is retired. On a touch screen a tap on Move to or Do next does not move focus, open a collapsed column or scroll the page to the card: the card leaves the view and the live region says where it went. Fields are 16px so iOS does not zoom; a failed save pins its status line under the header. On the phone a tap on a By band row opens that lane's card in Columns. The column and its Details open. The view choice is not saved. Waiting on Dave sits above Later. Later shows 15 cards, then "Show N more". The Lanes list shows the state word under each title. A lane with an open dependency shows "waits on: <ids>" on its card and its By band row (two ids, then "+N more"). Details lists every id. "Dependencies unknown" at the top means migration 0006 is not applied. On a desktop browser (a mouse, wider than 720px) Columns is one wide board that scrolls sideways, and a drag near its left or right edge scrolls it; a touch screen keeps the grid.
- In Lanes, state chips and band chips combine; a second click on a band chip clears it. Group by Track or Band regroups the same rows. A card shows `rank N` (`lane.priority`) and a band chip. Dave sets a band with `node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`, or with the Band select in a card's Details (P0, P1, P2 or none); the sync applies a card band as a `band` lane event only after Dave's yes (kanban-sync). A drag, Do next and Move to change rank only and never write a band (By band keeps band first, so a Do next card is first in its own band). Done is a card status that the sync applies after Dave's yes. A card status `ready` on a lane with an open dependency gives `refused: open dependency`. The sync consumes the card, so set the status again after the dependency is met. A later state change on a met lane, such as one from the page, un-meets it.
- First banding: `node C:/Users/dkhay/.claude/scripts/lane.mjs band-backfill --dry-run`, then apply with the `to apply:` line it prints (`--apply --p0 id,id|none --expect N`) only after Dave's yes and his P0 picks. Only lanes with band IS NULL get the map; a lane named in `--p0` gets P0 whatever band it has. A second run with the same `--p0` list changes 0 rows. One summary line goes to the board inbox, not one per lane.
- A board with no `laneArtifact` renders `lane-board-<key>.html` on this machine, read-only (a Priorities section from lane state and priority). Never publish it.
- After a lane change on any board, the hooks render its page. Publish a board's page only to its own url, with no `capabilities`. Never to another board's url: each page keeps its own db.
- Your held copy of a page is old: other sessions publish all day. Order: read the live url (Artifact tool, action `read`, without `path`: a read with `path` does not count; do not open the saved file), render, publish at once. A refused publish counts as the read: publish the same file again. Render again only if you changed the lane DB since.
- `kanban-sync` reads one board's page at a time and passes `--project <key>`.
- The Stop gate (`lane-board-stop-gate`) may add one line to its block reason: "FleetOps data is stale (<when>). Tell Dave in one line. Run the fleetops-refresh skill only if he asks." <when> is "exported <time>, not uploaded" or "exported <time>, older than 36 hours". Stale means `~/.claude/state/lane-dash/refresh.json` has `pending: true`, or its `exported_at` is over 36 hours old. The line never causes a block. It rides only on a block that already happens. It shows at most once an hour per machine (marker `~/.claude/state/lane-dash/.refresh-shown.json`). A new export (new `key`) shows it at once. A headless run never gets it. `kanban-sync` step 8 reports the same condition. Never run `fleetops-refresh` unless Dave asks.
