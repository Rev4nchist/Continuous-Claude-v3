# Branch Coordination — `agentic-os`

**Coordination lives in the database, not in this file.** This page is a pointer, kept
short on purpose.

The rules for a session on a lane board are in `docs/coordination/standard.md`: rule ids, levels and evidence.
`.claude/rules-ondemand/lane-board.md` holds the rule text and loads at a session's first lane command.

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
| `board` | every lane, grouped by track, with who holds what. A lane with an open dependency shows `waits on: <ids>`; `--json` has `waits_on` (a missing key means unknown) |
| `next` | the highest-priority lane you may claim. It skips a lane with an open dependency |
| `claim <id>` | **atomic** — one winner; a loser is told who won, by session id. A lane held by another session (lease runs, or active in the last 5 minutes) exits 3, checked first. Then a done, blocked or open-dependency lane prints `REFUSED claim <id> [<token>] -- <text>` and exits 4. `--dep-override --reason "<text>"` skips the open-dependency refusal only |
| `note <id> "..."` | update the status line the other session reads. Refused (`[not-holder]`, exit 4) only when another session holds the lane: its lease runs, or it was active in the last 5 minutes |
| `state <id> <to>` | set the state. Only the holder may: a lane that another session holds (lease runs, or active in the last 5 minutes) gives `REFUSED state <id> [not-holder] -- ...`, exit 4. A lane with no holder opens for any session. A quiet holder or an unowned blocked lane needs `--reason "<why>"` (`[needs-reason]`). `--if-state <from>` writes only if the lane is in `<from>`; the owner checks run first, then `[if-state]`. `--override --reason "<why>"` also changes a held lane |
| `release <id>` | state `ready`, no owner. The holder, any session for a lane with no holder, or a session for a quiet holder's lane or an unowned blocked lane with `--reason` (without it: `[needs-reason]`, exit 4). A lane another session holds gives `[not-holder]`, exit 4. `release <id> --blocked --reason "<why>"` (the holder, or `--override`; else `[not-holder]`, even with `--reason`) goes to `blocked` with no owner in one statement: the long hold |
| `park <id> [--for 2h..7d] --reason "<why>"` | the holder keeps the lane and the lease runs to the end time. Give `--until <time>` or `--for`, never both (exit 1). Default 24h, from 2h to 7 days. See "Owner check and park" |
| `compact <id> "..."` | log a compaction as an event only; the status line stays (the PreCompact hook runs this) |
| `say "..." [--to <sid>]` | message the branch, or one peer |
| `inbox` | unread updates since you last looked |
| `done <id>` | land it and release the lane. The holder, or any session for a lane with no holder (a quiet holder needs `--reason`, else `[needs-reason]`); a lane another session holds gives `[not-holder]`, exit 4; an unowned `blocked` lane needs `--reason` for a plain `done`. Only `--merged <sha>` or `--no-pr --evidence <path>` meets a dependency; a plain `done` meets none and prints a hint |
| `seed <file>` | bulk add or update lanes from JSON. The object form `{ lanes, edges }` replaces the edges of its lanes in one transaction and refuses a cycle (`seed refused: cycle a -> b -> a`); the array form never touches the edges |
| `peers` | who else is live right now |
| `remind set\|list\|snooze\|ack\|clear` | timed reminders on lanes; due ones show at session start; `next` never offers them |
| `remind tick` | the 5-minute `CCv3-Reminder-Tick` job: fires due reminders on every board, toasts P0/P1, and mirrors changed ones to the Notion To-Do Board (one headless `claude -p`, only when a row changed or the Done poll is due). The Notion sync is off until `remind sync on`, polls Done every 2 hours, and is capped at 12 runs a day. |
| `export-dash-data.mjs` | the nightly `CCv3-Lane-Snapshot` job: runs the lane export at 23:55 local (Central) time, hidden, on battery too, no model. It writes the lane-dash files to `~/.claude/state/lane-dash` and adds one row per Chicago day to `snapshots.json`, so daily snapshots add up. The export has eight documents, including `flow.json` for the Fleet app. Then the wrapper runs `export-factory-data.mjs` (no database, four local files), which writes `factory.json` beside them: pre-PR, review, CodeRabbit and handoff counts. A failure of one never hides the other; exit 5 means only the factory failed. A run that starts after midnight (laptop asleep at 23:55) lands on the next day, and the missed day has no row. It reads the primary checkout's current branch; the log names it. A manual export running at 23:55 makes the nightly run exit 1. Log: `~/.claude/logs/lane-snapshot/<date>.log` (14 days kept). Limit 2 min in the wrapper, 5 min in the task. Code: `.claude/scripts/scheduled/scheduled-lane-snapshot.ps1`. |

## Owner check and park

`state`, `release`, `done`, `note` and `add` change a lane only for its holder. A lane that another session holds gives `REFUSED <verb> <id> [not-holder] -- the lane is held by <label>`, exit 4, and writes nothing. A session holds a lane while its lease runs or while it was active in the last 5 minutes. A parked lane of an ended session stays held until the lease ends. A lane with no holder opens for any session. `park` is the holder's alone: it refuses a lane with no holder (`claim` it first). The rule prevents accidents, not malice.

- **`--reason`:** only `state`, `release` and `done` test it. A lane whose holder is quiet (the lease ended and the session was not active in the last 5 minutes) needs `--reason "<why>"`, and so does an unowned `blocked` lane (`[needs-reason]`). `done --merged` and `done --no-pr --evidence` need it only for a quiet holder. `note` and `add` open such a lane with no `--reason`. The change goes to the board as one event.
- **`--override --reason "<why>"`:** also changes a held lane. The old holder gets a DM and the board gets one event. A usage error without `--reason`. In the program only the seat uses it.
- **`state <id> <to> --if-state <from>`:** writes only if the lane is in `<from>`. The owner checks run first, so `[not-holder]` or `[needs-reason]` can come before `[if-state]`. Only these flag and verb pairs are a usage error (exit 1, nothing written); other foreign flags pass with no effect: `--if-state` on `release`, `done` and `park`; `--blocked` on `state` and `done`; `--override` on `note`, `add`, `park` and `claim`. A bare `--reason`, `--if-state`, `--merged` or `--evidence` is exit 1 on every verb.
- **`release <id> --blocked --reason "<why>"`:** the holder, or any session with `--override`. A quiet or unowned lane gives `[not-holder]`, even with `--reason`. No `--reason` is exit 1. One statement sets state `blocked`, no owner, no lease and the note. Use it for a hold of more than 7 days and for a seat handoff. A later `claim` gets `[blocked]`.
- **`park`:** holder only. Default `--for 24h`; the end must be from 2 hours to 7 days away (else exit 1). The lane keeps its owner and the lease runs to the end. State becomes `review`; a `blocked` lane stays `blocked`. The note starts `PARKED until <time> -- <reason> || <old note>`. A `PARKED` note alone does not prove a park: the prefix can be stale, and a parked `blocked` lane stays `blocked`. The lease, not the note, is the park: a changed note hides the prefix, and the lane stays parked while the lease is ahead. `board` shows `parked to <time>` only while the lease is more than the normal lease (90 minutes, plus 1) ahead; the note plays no part, and its `PARKED` text still prints under the lane. A `claim` of a reclaimable lane cuts the `PARKED` prefix from the note. `renew`, `note`, `compact` and the hook keep the later lease. Another session's `claim` exits 3 and, if you may adopt the holder, names `adopt --from <uuid>`. Never park the master card of a program: a seat handoff is `release --blocked`.
- **End of a park:** the holder's next `state` (`state <id> active` resumes), `release`, `release --blocked` or `done`; a new `park` (the new end); the end time (the next renew gives 90 minutes); a non-holder `state <id> <to> --override --reason "<why>"` to a state other than `ready` or `done` (it caps the lease at 90 minutes and drops the `PARKED` prefix; the owner stays until the lease and the quiet time end); `state --override` to `ready` or `done`, `release --override` or `done --override` (the lane is free).
- **Handover of a parked lane whose owner is gone:** `release <id> --override --reason "handover to <label>"; claim <id>`, in ONE command.
- **Hook sync:** `park` warns when `~/.claude/hooks/dist/lane-context.mjs` or `~/.claude/hooks/dist/prompt-submit.mjs` lacks `GREATEST(lease_expires_at`, and names the one that lacks it. The old hook cuts a park back to 90 minutes.
- **No owner test:** `apply-kanban` (Dave's taps; on a held lane it skips status, column and band changes and applies rank and notes; on an `active` lane it applies only the rank), `reminder-sync.mjs` (closes reclaimable reminder lanes), `seed`, `--as` and `remind`.

You do not have to remember to run these. The `lane-context` hook injects the board at
session start and any unread updates on every prompt, and renews your leases while you work. A renew never shortens a park.

## Band and rank

A lane has a **band** (`P0`, `P1`, `P2`, or NULL = Unsorted) and a **rank** (`lane.priority`, the order inside a band).
P0 means this week. The cap of 5 is soft: the phone page warns above it and blocks nothing. Dave sets a band with
`node C:/Users/dkhay/.claude/scripts/lane.mjs band <id> P0|P1|P2|none`, or with the Band choice in a phone card's Details (P0, P1, P2 or none, which clears it). Only an explicit choice sets one. A drag never does.
The one-off first banding is `node C:/Users/dkhay/.claude/scripts/lane.mjs band-backfill --dry-run`, then the `to apply:` line it prints (`--apply --p0 id,id|none --expect N`) after Dave's yes. Only lanes with band IS NULL get the map (priority 1..9 P1, 10..40 P2, the rest Unsorted); a lane named in `--p0` gets P0 whatever band it has; done lanes are skipped; `updated_at` does not move; a second run with the same `--p0` list changes 0 rows; a wrong `--expect` rolls back.

One sort key orders open lanes everywhere: band, then `due_at` (NULL last), then rank, then id
(`scripts/coordination/lane-sort.mjs`, with twins in the hooks and the app). `lane.mjs next`, the board and the phone page share it.

The phone page shows Priorities in two views. **By band** is the default: four groups (P0 this week, P1 next, P2 later, Unsorted),
open lanes only, with `n/5` on P0 and an amber "over the cap of 5" above 5. **Columns** is the drag board; on the editable page each card has Do next, Done and Move to buttons. The choice persists in the browser.
The Lanes list has state chips and band chips (they combine) and can group by Track or by Band. The read-only page of another board has the same views and none of the card buttons.
Columns also shows two read-only columns. **Scheduled and reminders** (first) holds an open lane with a `due_at` in the future, and a lane with a live reminder (state scheduled, due, needs Dave or failed) whose time has come, on any track, until Dave acks it. A held (active) lane stays in In progress. On the phone the column starts open when it has cards, so a DUE reminder is seen. After a card move on the page, the next sync places a scheduled lane at the end of its saved column, so its rank can change. It is sorted by due time, and each card has a time chip ("in 3h", or "DUE") worked out at render time. The lane shows there and nowhere else in Columns, and By band still lists it. **Done** holds lanes done in the last 7 days, at most 30, newest first, with a Show all that opens the Lanes list. Neither column is saved or takes a rank, and neither adds an action to `apply-kanban`.
The Now column is retired: the page saves three columns (next, later, waiting). An old saved doc keeps `columns.now`, and the code ignores it: those lanes return to their default column. A phone with the old page open still saves safely, and its `now` ids are ignored the same way. A scheduled lane keeps its saved column and returns to it when its time passes. On a touch screen a tap on Move to or Do next does not move focus, open a collapsed column or scroll the page to the card: the card leaves the view and the live region says where it went. Fields are 16px so iOS does not zoom; a failed save pins its status line under the header. On the phone a tap on a By band row opens that lane's card in Columns. The column and its Details open. The view choice is not saved. Waiting on Dave sits above Later. Later shows 15 cards, then "Show N more". The Lanes list shows the state word under each title. A lane with an open dependency shows "waits on: <ids>" on its card and its By band row (two ids, then "+N more"). Details lists every id. "Dependencies unknown" at the top means migration 0006 is not applied. On a desktop browser (a mouse, wider than 720px) Columns is one wide board that scrolls sideways, and a drag near its left or right edge scrolls it; a touch screen keeps the grid.
A kanban drag, Do next and Move to change rank only. By band keeps band first, so a Do next card is first in its OWN band and stays under every lane of a higher band. Done is a card status (`status: done`) that the sync applies after Dave's yes; Undo gives back the status that was pending before, or `null` (no status). A drag, Do next and Move to never write a band. A band chosen in a card's Details is a pending card change: the kanban sync applies it only after Dave's yes, as a `band` lane event, and leaves priority alone (an active lane skips it; a held lane keeps its band until released). A lane that is done after the sync takes no rank (a pending card that reopens a done lane gives it one). A card status `ready` on a lane with an open dependency gives `refused: open dependency`. The sync consumes the card, so set the status again after the dependency is met. A later state change on a met lane, such as one from the page, un-meets it.

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
| Correctness gate (34 properties) | `scripts/coordination/lane-race-probe.mjs` |
| Board renderer | `scripts/coordination/render-board.mjs` |
| Published board | generated artifact `RtrTNVfAq9uowmb2tfbzid` (`https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid`) |

The old triage artifact `9eb25020-1959-47b9-b51f-6589e0c0515a` is retired. It holds saved
triage decisions. Never publish the lane board over it.

Each board can have its own phone page. `continuous-claude` has the one above. Another board has a page when its entry in
`.claude/project-registry.json` carries `laneArtifact` (the page url). Dave starts one with `/publish-board <key>`; `project register`
only prints that hint. To refresh the `continuous-claude` page, first read the live page (Artifact tool, action `read`, no `path`): other sessions publish all day, so your held copy is old. Order: read, render, publish at once. Then run from the primary checkout:

```
node C:/Users/dkhay/continuous-claude/scripts/coordination/render-board.mjs --project continuous-claude
```

Then publish `lane-board.html` with the Artifact tool, passing
`url=https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid`. The URL keeps the same link instead of
minting a second board. For another board, render with `--project <key>`, publish `lane-board-<key>.html` to that board's `laneArtifact`
url and pass no `capabilities`. A board with no `laneArtifact` renders `lane-board-<key>.html` with no artifact. It shows a read-only Priorities section drawn from lane state and priority.

The lane-board Stop gate may add one line to its block reason: "FleetOps data is stale (<when>). Tell Dave in one line. Run the fleetops-refresh skill only if he asks."
<when> is "exported <time>, not uploaded" or "exported <time>, older than 36 hours".
The line never causes a block. It rides only on a block that already happens.
It shows at most once an hour per machine. A new export shows it at once.
Marker: `~/.claude/state/lane-dash/.refresh-shown.json`.
Stale means `refresh.json` has `pending: true`, or its `exported_at` is over 36 hours old.
A missing or corrupt `refresh.json` says nothing.

Before trusting the claim path after any change to it:

```
node scripts/coordination/lane-race-probe.mjs --racers 24
```

24 real concurrent processes race one lane. It also checks the owner rule, `park`, `release --blocked` and the plain `done` race. It checks both reclaim negatives — a live
holder with a lapsed lease must still be denied, and a lease alone must still protect a
claim — because reclaiming on either condition alone is the bug that made the file lock
steal files from sessions that were merely mid-turn.
