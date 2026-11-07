# Lane board pointer for a project CLAUDE.md

A registered project may carry this block in its own `CLAUDE.md`. It tells a model where the lane commands live.
Apply it per project only with Dave's yes. This file is a template: no project `CLAUDE.md` is edited by it.

```
<!-- lane-board:start -->
Concurrent sessions share this folder. Claim a lane first: `node C:/Users/dkhay/.claude/scripts/lane.mjs next`.
Lane rules load on your first lane command; this project's board follows the registry.
<!-- lane-board:end -->
```

The markers let a script replace the block without touching the rest of the file.

Bands: a lane has a band (`P0`, `P1`, `P2`, or none) set with `node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`. The phone page opens on **By band**. The block above needs no change for it.
