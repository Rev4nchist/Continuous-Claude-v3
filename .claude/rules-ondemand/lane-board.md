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

## Phone page

- `continuous-claude` has the page `RtrTNVfAq9uowmb2tfbzid` (`.claude/artifacts.json`). Any other board has a published, interactive page only when its registry entry carries `laneArtifact` (a `https://claude.ai/artifact/<id>` url). Dave starts one with `/publish-board <key>`. `project register` only prints a hint.
- A board with no `laneArtifact` renders `lane-board-<key>.html` on this machine, read-only (a Priorities section from lane state and priority). Never publish it.
- After a lane change on any board, the hooks render its page. Publish a board's page only to its own url, with no `capabilities`. Never to another board's url: each page keeps its own db.
- `kanban-sync` reads one board's page at a time and passes `--project <key>`.
