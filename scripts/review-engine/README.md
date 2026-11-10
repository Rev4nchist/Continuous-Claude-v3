# review-engine program script

`program.mjs` lints the review-engine map (`docs/review-engine/map.md`), builds the board seed file and checks a lane branch against its Owns list. Part 1 is built. Part 2 verbs are stubs.

## Run

```
node scripts/review-engine/program.mjs <verb> [options]
```

| Verb | What it does |
|---|---|
| `check` or `check --table` | Lints the Waves table, the sections, Owns overlaps and owner chains. |
| `check --diff <lane-id> [--branch <ref>] [--base <ref>]` | Lists changed files outside the lane's Owns. Default branch `re/<lane-id>`, base main. Line 2 is `files: <n> base <sha12> branch <sha12>`. An empty diff is `RESULT diff-empty` and exit 1, never a pass. |
| `seed-file [--out <file>] [--project <key>]` | Writes one blocked seed item per Waves lane. No `--out`: JSON array on stdout, banner on stderr. |
| `check --board`, `--claims`, `--orphans`, `seed-file --edges-out`, `ready`, `status`, `sync-board [--apply]` | Part 2. Exit 5. They read and write nothing. |

Global: `--json`. `--flag=value` works as well as `--flag value`.

## What `check --table` reports

- `examined:` counts what each rule group looked at: `ownerChains`, `ownerPhrases`, `overlapPairs`, `deps`, `heldTokens`, `sections`, `rows`, `dropped`. A group at 0 adds a `NOTE vacuous`. `chainUnparsed` is also counted; 0 is the good state and gives no note.
- `FAIL owns-overlap`: two lanes own one path with no dependency path. Only two entries that both carry a `keys only` scope (`(the x key only)`) are exempt (`NOTE owns-exempt`). Any other scope is not an exemption. Two globs overlap only when some path matches both.
- `FAIL owns-token`: a backticked token in an Owns bullet fails the path rule (`[\w.~*/-]` only) and looks like a path (has a `/`, or ends in a file extension). The overlap and diff checks would not see it, so it is an error, not prose.
- `NOTE chain-unparsed`: a clause in the Owner chains bullet that is not `<files>: <lanes>`. Nothing reads it. The note gives the map line.
- Owner chains and Owner phrases accept a lane whose Owns entry is a dir or glob that matches the file as written. A bare file name matches a file entry only.

## Live mode

Run from the primary checkout. The script refuses (exit 3) when:
- it runs in a linked worktree;
- any `.mjs` under `scripts/review-engine/` (not tests, not fixtures) differs from main, or is absent on main;
- `--map`, `--map-ref` or `--repo` is set without `--test-mode`.

It compares git blob ids, not bytes, so `core.autocrlf` does not matter. It reads the map from the resolved main commit. Line 1 of the output is `map main@<sha12> docs/review-engine/map.md`.

## Test mode

For a worktree, a changed script or a map file under test. Add `--test-mode`.

```
node scripts/review-engine/program.mjs check --table --test-mode --map <file>
node scripts/review-engine/program.mjs check --table --test-mode --map-ref main [--repo <dir>]
```

- It skips the self-check.
- Line 1 of the output is `TEST MODE: self-check skipped; map <source>`. `--json` has `testMode: true`. Seed `note` and `rationale` both start with `TEST MODE seed; ` (`lane.mjs seed` overwrites `rationale` on an existing card but keeps the stored `note`).
- Saved test mode output is not evidence of a live run.
- Part 1 touches no database. `dbTarget` in `lib/source.mjs` is the seam for part 2. In test mode it accepts only a `lanes_pr1_*` database in `CONTINUOUS_CLAUDE_DB_URL`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Pass. |
| 1 | Check failed: lint errors, files outside Owns, an empty diff, or a map that does not parse. `seed-file` writes nothing, leaves an older `--out` file unchanged (the output says it is stale) and honours `--json`. |
| 2 | Usage error: bad verb or flag, unknown lane, missing ref or branch. |
| 3 | Refused: self-check mismatch, linked worktree, test-mode flag without `--test-mode`, unsafe database. |
| 5 | Part 2, not built. |

Code 4 is not used. `lane.mjs` uses it for a claim refusal.

## Tests

```
node --test scripts/review-engine/map-parse.test.mjs scripts/review-engine/map-check.test.mjs scripts/review-engine/seed-file.test.mjs scripts/review-engine/program-cli.test.mjs scripts/review-engine/rule-trigger.test.mjs
```

`rule-trigger.test.mjs` needs the built hook (`.claude/hooks/dist/rule-router.mjs`).
