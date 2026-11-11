# Lane board pointer for a project CLAUDE.md

A registered project may carry this block in its own `CLAUDE.md`. It tells a model where the lane commands live.
Apply it per project only with Dave's yes. This file is a template: no project `CLAUDE.md` is edited by it.

```
<!-- lane-board:start -->
Concurrent sessions share this folder. Claim a lane by id first: `node C:/Users/dkhay/.claude/scripts/lane.mjs board --by priority`, then `claim <id>`.
Lane rules load on your first lane command; this project's board follows the registry.
<!-- lane-board:end -->
```

The markers let a script replace the block without touching the rest of the file.

The block needs no change for reminders, dependencies, the owner check or `park`. `claim` refuses a lane with an open dependency and `next` skips it. `state`, `release`, `done`, `note` and `add` refuse a lane that another session holds (its lease runs, or it was active in the last 5 minutes). The verbs are in `.claude/rules-ondemand/lane-board.md`.

Bands: a lane has a band (`P0`, `P1`, `P2`, or none) set with `node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`, or with the Band select in a phone card's Details (the sync applies it after Dave's yes; a drag never writes a band). The phone page opens on **By band**. The block above needs no change for it.

Scheduled and reminders: the Columns view starts with a read-only column of lanes with a future `due_at` and due reminders. The Now column is retired. The block above needs no change for either.
