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
node C:/Users/dkhay/.claude/scripts/lane.mjs board
```

Use the shim path in every command, from any folder. The shim runs the primary checkout's
`C:/Users/dkhay/continuous-claude/scripts/coordination/lane.mjs`. A relative path fails outside this repo and runs a stale copy
inside a worktree.

A board belongs to a project. The registry decides the board from your current folder. A folder
with no registry entry has no board. Make one with
`node C:/Users/dkhay/.claude/scripts/lane.mjs project register <path>` from the primary checkout.
Details: `.claude/rules-ondemand/lane-board.md`.

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
| `remind set\|list\|snooze\|ack\|clear` | timed reminders on lanes; due ones show at session start; `next` never offers them |

You do not have to remember to run these. The `lane-context` hook injects the board at
session start and any unread updates on every prompt, and renews your leases while you work.

## Band and rank

A lane has a **band** (`P0`, `P1`, `P2`, or NULL = Unsorted) and a **rank** (`lane.priority`, the order inside a band).
P0 means this week. The cap of 5 is soft: the phone page warns above it and blocks nothing. Dave sets a band with
`node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`. Nothing sets one automatically.
The one-off first banding is `node C:/Users/dkhay/.claude/scripts/lane.mjs band-backfill --dry-run`, then the `to apply:` line it prints (`--apply --p0 id,id|none --expect N`) after Dave's yes. Only lanes with band IS NULL get the map (priority 1..9 P1, 10..40 P2, the rest Unsorted); a lane named in `--p0` gets P0 whatever band it has; done lanes are skipped; `updated_at` does not move; a second run with the same `--p0` list changes 0 rows; a wrong `--expect` rolls back.

One sort key orders open lanes everywhere: band, then `due_at` (NULL last), then rank, then id
(`scripts/coordination/lane-sort.mjs`, with twins in the hooks and the app). `lane.mjs next`, the board and the phone page share it.

The phone page shows Priorities in two views. **By band** is the default: four groups (P0 this week, P1 next, P2 later, Unsorted),
open lanes only, with `n/5` on P0 and an amber "over the cap of 5" above 5. **Columns** is the drag board. The choice persists in the browser.
The Lanes list has state chips and band chips (they combine) and can group by Track or by Band. The read-only page of another board has the same views.
A kanban drag changes rank only. The kanban sync never writes a band, and a lane that is done after the sync takes no rank (a pending card that reopens a done lane gives it one).

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
| CLI | `C:/Users/dkhay/continuous-claude/scripts/coordination/lane.mjs`, called through the shim `~/.claude/scripts/lane.mjs` |
| Context-injection hook | `.claude/hooks/src/lane-context.ts` |
| Correctness gate (10 properties) | `scripts/coordination/lane-race-probe.mjs` |
| Board renderer | `scripts/coordination/render-board.mjs` |
| Published board | generated artifact `RtrTNVfAq9uowmb2tfbzid` (`https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid`) |

The old triage artifact `9eb25020-1959-47b9-b51f-6589e0c0515a` is retired. It holds saved
triage decisions. Never publish the lane board over it.

Each board can have its own phone page. `continuous-claude` has the one above. Another board has a page when its entry in
`.claude/project-registry.json` carries `laneArtifact` (the page url). Dave starts one with `/publish-board <key>`; `project register`
only prints that hint. To refresh the `continuous-claude` page, run from the primary checkout:

```
node C:/Users/dkhay/continuous-claude/scripts/coordination/render-board.mjs --project continuous-claude
```

Then publish `lane-board.html` with the Artifact tool, passing
`url=https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid`. The URL keeps the same link instead of
minting a second board. For another board, render with `--project <key>`, publish `lane-board-<key>.html` to that board's `laneArtifact`
url and pass no `capabilities`. A board with no `laneArtifact` renders `lane-board-<key>.html` with no artifact. It shows a read-only Priorities section drawn from lane state and priority.

Before trusting the claim path after any change to it:

```
node scripts/coordination/lane-race-probe.mjs --racers 24
```

24 real concurrent processes race one lane. It checks both reclaim negatives — a live
holder with a lapsed lease must still be denied, and a lease alone must still protect a
claim — because reclaiming on either condition alone is the bug that made the file lock
steal files from sessions that were merely mid-turn.
