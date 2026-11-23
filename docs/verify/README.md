# Verify maps

One map per live surface: what you changed, the command to run, the artifact to keep, and which gate runs it today.
The testing rule is in `docs/testing-standard.md`. A map adds the per-surface detail.

| Surface | Map |
|---|---|
| Hooks (source, dist, fixtures, registration) | [hooks.md](hooks.md) |
| The lane CLI, the shim and coordination scripts | [lane-cli.md](lane-cli.md) |
| The Agentic OS app, the `/os` pane, the phone board, kanban sync, FleetOps | [agentic-os.md](agentic-os.md) |

A map is advice, not a deny. It never blocks a commit. When a gate covers a row, the map names the gate.
