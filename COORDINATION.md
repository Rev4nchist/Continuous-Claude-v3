# Branch Coordination — `agentic-os`

**Coordination lives in the database, not in this file.** This page is a pointer, kept
short on purpose.

An earlier version of this file *was* the board. It failed within the hour, in three ways
worth remembering, because each one is a requirement the replacement had to meet:

1. **It contended with itself.** Writing it took a 10-minute file claim, so the second
   session to reach for the shared board got denied by the very lock the board existed to
   coordinate.
2. **It was passive.** Nothing carried it into a session that did not think to open it.
3. **It could not arbitrate.** Two sessions could read "lane free" in the same second and
   both start.

## Use this instead

```
node scripts/coordination/lane.mjs board
```

| Command | What it does |
|---|---|
| `board` | every lane, grouped by track, with who holds what |
| `next` | the highest-priority lane you may claim |
| `claim <id>` | **atomic** — one winner; a loser is told who won, by session id |
| `note <id> "..."` | update the status line the other session reads |
| `say "..." [--to <sid>]` | message the branch, or one peer |
| `inbox` | unread updates since you last looked |
| `done <id>` | land it and release the lane |
| `peers` | who else is live right now |

You do not have to remember to run these. The `lane-context` hook injects the board at
session start and any unread updates on every prompt, and renews your leases while you work.

## The rules that are not enforced by code

- **Claim a lane before you start.** The claim is the declaration of scope; a lane's
  `scope` field is how the other session knows what not to touch.
- **Serialize commits.** Same branch, two committers race `.git/index.lock`. Say so on the
  bus before a commit run.
- **Staging `.claude/hooks/dist/*.mjs` deploys the live harness** to every running session
  instantly, via the post-commit `sync-to-active.sh --changed`. Never as drive-by churn.
- **`settings.json` never auto-syncs.** Update the repo copy *and* `~/.claude/`, each via a
  single node read-modify-write — never the Edit tool.

## Where things live

| Thing | Path |
|---|---|
| Schema + the full design rationale | `apps/agentic-os/src/db/schema/lane.ts` |
| CLI | `scripts/coordination/lane.mjs` |
| Context-injection hook | `.claude/hooks/src/lane-context.ts` |
| Correctness gate (10 properties) | `scripts/coordination/lane-race-probe.mjs` |
| Board renderer | `scripts/coordination/render-board.mjs` |
| Published board | artifact `9eb25020-1959-47b9-b51f-6589e0c0515a` |

To refresh the published board: `node scripts/coordination/render-board.mjs <out>.html`,
then publish that file with the Artifact tool passing
`url=https://claude.ai/code/artifact/9eb25020-1959-47b9-b51f-6589e0c0515a` — passing the
URL is what keeps it at the same link instead of minting a second board.

Before trusting the claim path after any change to it:

```
node scripts/coordination/lane-race-probe.mjs --racers 24
```

24 real concurrent processes race one lane. It checks both reclaim negatives — a live
holder with a lapsed lease must still be denied, and a lease alone must still protect a
claim — because reclaiming on either condition alone is the bug that made the file lock
steal files from sessions that were merely mid-turn.
