# review-engine program script

`program.mjs` lints the review-engine map (`docs/review-engine/map.md`), builds the board seed file, checks a lane branch against its Owns list, and reads the lane board (`ready`, `sync-board`, `check --board`, `--claims`, `--orphans`, `status`).

Table verbs touch no database. Board verbs read the database, read-only. `sync-board --apply` is the only write, and it goes through `lane.mjs`.

## Run

```
node scripts/review-engine/program.mjs <verb> [options]
```

| Verb | What it does |
|---|---|
| `check` or `check --table` | Lints the Waves table, the sections, Owns overlaps, owner chains and `Pack:` lines. |
| `check --diff <lane-id> [--branch <ref>] [--base <ref>]` | Lists changed files outside the lane's Owns. Default branch: `re/<lane-id>`, or the shared branch of its pack. Base main. A pack uses the union of the Owns lists of its lanes (`NOTE pack:` line). Line 2 is `files: <n> base <sha12> branch <sha12>`. An empty diff is `RESULT diff-empty` and exit 1, never a pass. |
| `seed-file [--out <file>] [--project <key>] [--rank <file>]` | Writes the object `{ "lanes": [...], "edges": [...] }`: one blocked item per Waves lane, and the edges from `Depends on`. No `--out`: the object on stdout, banner and notes on stderr. |
| `ready [--project <key>] [--as <session-id>]` | Prints the lanes the caller may claim now, the cap, the Cursor eval slot, and what waits on Dave. |
| `sync-board [--apply] [--project <key>] [--as <session-id>]` | Plans the moves from `blocked` to `backlog`. Dry run by default. `--apply` runs `lane.mjs state <id> backlog --if-state blocked --reason "program.mjs sync-board --apply"` once per move. |
| `check --board [--project <key>]` | Does the board match the map: cards, edges, branches, holds, done lanes and their merged SHAs. |
| `check --claims [--project <key>] [--since <event-id>]` | Did a claim break the dependency gate, was `--dep-override` used, does an owner hold two cap units. |
| `check --orphans [--project <key>]` | The seat line, parked long lanes, and lanes whose owner is dead. |
| `status [--project <key>]` | A five-line summary. `--json` has the full object. |

Global: `--json`. `--flag=value` works as well as `--flag value`. `--project` defaults to `continuous-claude` and must match `[a-z0-9][a-z0-9-]*`. `--as` falls back to `CLAUDE_CODE_SESSION_ID`.

## What `check --table` reports

- `examined:` counts what each rule group looked at: `ownerChains`, `ownerPhrases`, `overlapPairs`, `deps`, `heldTokens`, `sections`, `rows`, `dropped`, `packs`. A group at 0 adds a `NOTE vacuous`. `chainUnparsed` and `packs` are also counted; 0 is the good state and gives no note.
- `FAIL owns-overlap`: two lanes own one path with no dependency path. Only two entries that both carry a `keys only` scope (`(the x key only)`) are exempt (`NOTE owns-exempt`). Any other scope is not an exemption. Two globs overlap only when some path matches both.
- `FAIL owns-token`: a backticked token in an Owns bullet fails the path rule (`[\w.~*/-]` only) and looks like a path (has a `/`, or ends in a file extension). The overlap and diff checks would not see it, so it is an error, not prose.
- `FAIL pack-lane`, `pack-dep`, `pack-dup`, `pack-branch`: a `Pack:` lane is not a Waves lane, two lanes of one pack have a dependency path, a lane is in two packs, or the branch is not `re/<one of its lanes>`.
- `FAIL held-token`: a hold token that is not a decision id, a lane id, `<lane> if <DP> = <answer>`, `first-flip`, `dave-yes`, `item-trigger` or `seat-hold`.
- `NOTE chain-unparsed`: a clause in the Owner chains bullet that is not `<files>: <lanes>`. Nothing reads it. The note gives the map line.
- Owner chains and Owner phrases accept a lane whose Owns entry is a dir or glob that matches the file as written. A bare file name matches a file entry only.

## Map facts the board verbs read

Each fact is one line or bullet in the map. A fact that is missing is stated; none of them is a constant in the script.

| Fact | Form | If missing |
|---|---|---|
| The GO line | `Program state: GO (Dave, <date>)` or `Program state: HOLD`. The value is exactly `GO` or `HOLD`, each with at most one parenthetical. | Reads as HOLD, with a note. A prefix such as `GO pending DP2`, or two lines that disagree, also reads as HOLD with a note. |
| The spend slot | A bullet that starts `- Cursor eval slot:`. Every lane id in backticks on it is a spender. | `ready` exits 1: `map fact missing: Cursor eval slot bullet`. |
| Long lanes | A bullet that starts `- Long lanes`. The ids in its first sentence are long lanes. | A note. Every review lane with a dead owner counts as an orphan. |
| A pack | `Pack: re-verifier, re-finder-v2 (branch re/re-verifier)`. Several lines are allowed. | No pack. |
| A hold | The `Held until` column. A lane-id token ends when that lane is done with a merged SHA. `seat-hold` is always held. Every other token ends only when the seat deletes it from the map. | |

**The GO line.** Before GO, `sync-board` moves only the lanes that have an open dependency. After GO it also moves the lanes with none. A lane with a hold stays `blocked` either way. The seat flips HOLD to GO in the map after Dave's yes. No flag does it.
One form only: the line starts with `Program state:` (an optional `- ` bullet before it). Write it in one place in the map. Any other line that holds the label `Program state` followed by `:` or `|` (a heading, a table cell, bold, backticks, a quoted example) is unreadable, and the result is HOLD.

## Board verbs: order of work and safety

Every board verb does these steps in order, and a refusal stops it before the next step:
1. Read the map (live mode: the self-check). A map that does not parse exits 1. A map with lint errors adds a NOTE and the read verbs go on; `sync-board --apply` refuses it with exit 1 and writes nothing.
2. Usage checks: `ready` and `sync-board --apply` need a session id (exit 2). `ready` needs the Cursor eval slot bullet (exit 1).
3. `dbTarget`: pick the database URL. In test mode it must name a scratch database (exit 3).
4. One read-only snapshot (`REPEATABLE READ READ ONLY`). Migration 0006 (`lane_dep`) must be applied (exit 1 if not).
5. A pure function decides. The verb renders its answer.

A database URL never reaches the output with its password. It prints as `postgresql://***@host/db`.

`sync-board`:
- Refuses (exit 3) when the board has no program seed event, or no stored edges for the map lanes. The seed event is the earliest `seeded` event with an `edges` key in its detail (the object-form seed). An array-form seed or a later re-seed does not move it.
- A lane that was set to `blocked` by hand after the program seed stays `blocked` (`hand-blocked`).
- A plan with an error (`edges-differ`: the stored edges differ from the map) writes nothing, even with `--apply`.
- `--apply` re-reads each lane before its write. A lane that is no longer `blocked` and free is skipped. It runs `lane.mjs state <id> backlog --if-state blocked --reason "program.mjs sync-board --apply" --project <board>` and never passes `--note`. A failed child stops the loop and exits 1. A second run plans 0 moves.
- The child is the shim `~/.claude/scripts/lane.mjs` (the primary checkout's lane.mjs). `--lane-cli <path>` replaces it in test mode only.

Residual risk: `--if-state blocked` is a compare-and-set, so a lane that left `blocked` between the re-read and the write is refused (`[if-state]`, or `[not-holder]` if another session claimed it, exit 4) and the loop stops. Only a lane that is `blocked` again at the write can still be moved.

## Live mode

Run from the primary checkout. The script refuses (exit 3) when:
- it runs in a linked worktree;
- any `.mjs` under `scripts/review-engine/` (not tests, not fixtures) differs from main, or is absent on main;
- any of these six files is absent locally, absent on main or different from main (the message names the file): `scripts/coordination/lane-dep.mjs`, `lane-seed-file.mjs`, `scratch-db.mjs`, `lane-sort.mjs`, `lane.mjs` and `scripts/lib/resolve-deps.mjs`;
- `--map`, `--map-ref`, `--repo`, `--decisions` or `--lane-cli` is set without `--test-mode`.

It compares git blob ids, not bytes, so `core.autocrlf` does not matter. It reads the map from the resolved main commit. Line 1 of the output is `map main@<sha12> docs/review-engine/map.md`.

## Test mode

For a worktree, a changed script or a map file under test. Add `--test-mode`.

```
node scripts/review-engine/program.mjs check --table --test-mode --map <file>
node scripts/review-engine/program.mjs check --table --test-mode --map-ref main [--repo <dir>]
node scripts/review-engine/program.mjs status --test-mode --map <file> --decisions <file>
```

- It skips the self-check.
- Line 1 of the output is `TEST MODE: self-check skipped; map <source>`. `--json` has `testMode: true`. Seed `note` and `rationale` both start with `TEST MODE seed; ` (`lane.mjs seed` overwrites `rationale` on an existing card but keeps the stored `note`).
- Saved test mode output is not evidence of a live run.
- A board verb in test mode reads only a scratch database: `CONTINUOUS_CLAUDE_DB_URL` must name a `lanes_pr1_*` database. `DATABASE_URL` and `OPC_POSTGRES_URL` are not read for the check. The `sync-board --apply` child gets the checked URL in all three variables, so it cannot reach another database.
- `--decisions <file>` gives `status` its `decisions.md`. `--lane-cli <path>` replaces the shim. Both need `--test-mode`.
- `seed-file` validates the output with `scripts/coordination/lane-seed-file.mjs` (`parseSeedFile`, `findCycle`), in test mode and in live mode. A parser error, a dropped duplicate edge or a cycle exits 1 (the cycle path is printed) and writes no file. When that file is absent, test mode prints `NOTE seed-file: not validated (...)` and still writes the file. Live mode exits 3 by the self-check.
- The dependency SQL comes from `scripts/coordination/lane-dep.mjs`. A missing module, or one without all five builders, exits 5.

### The scratch flow

```
node scripts/coordination/scratch-db.mjs create --through 6      # prints {url, name}
$env:CONTINUOUS_CLAUDE_DB_URL = '<url>'
node scripts/review-engine/program.mjs status --test-mode --map scripts/review-engine/fixtures/r9-map.fixture.md
node scripts/coordination/scratch-db.mjs drop <url>
```

`program-probe.mjs` does all of this by itself and runs the cases P1 to P14 of the design, plus P15 (events of another board). It is a hand-run probe, not a `node:test` file. It needs Docker with Postgres up:

```
node scripts/review-engine/program-probe.mjs
```

It creates a scratch database, seeds the dummy map `fixtures/r9-map.fixture.md` (lanes `re-dummy-1` to `re-dummy-6`), runs the real `program.mjs` in test mode, prints `PASS` or `FAIL` per case, and drops the database in `finally`. It refuses to start when its URL is not a scratch URL. The transcript is `.claude/cache/e2e/2026-11-10-program-probe.txt`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Pass. |
| 1 | Check failed: lint errors, files outside Owns, an empty diff, a board that differs from the map, a failed child, a database error, a missing map fact, or a map that does not parse. `seed-file` writes nothing, leaves an older `--out` file unchanged (the output says it is stale) and honours `--json`. |
| 2 | Usage error: bad verb or flag, unknown lane, missing ref or branch, no session id. |
| 3 | Refused: self-check mismatch, linked worktree, test-mode flag without `--test-mode`, unsafe database, a caller that already holds a `re-` lane (`ready`), no program seed event or no stored edges (`sync-board`). |
| 5 | A contract module is missing or has the wrong exports (`lane-dep.mjs`, `lane-seed-file.mjs`). |

Code 4 is not used. `lane.mjs` uses it for a claim refusal. A child `lane.mjs` exit of 4 or any other non-zero code is a failure of the verb: exit 1.

## Tests

```
node --test scripts/review-engine/*.test.mjs
```

`rule-trigger.test.mjs` needs the built hook (`.claude/hooks/dist/rule-router.mjs`). No test opens a database or runs a lane verb: the board verbs are tested through an injected reader and a fake `--lane-cli`. `program-probe.mjs` covers the SQL.
