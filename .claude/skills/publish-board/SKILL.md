---
name: publish-board
description: Publishes the first interactive phone page for one lane board and records its url. Use only when Dave types /publish-board with a board key.
disable-model-invocation: true
---

# Publish a board's phone page

`/publish-board <key>` makes the first published, interactive lane page for the board `<key>`. A publish is outward-facing and confirm-first. `project register` never does it: it only prints `Phone page: run /publish-board <key>`.

Later republishes do not use this skill. The Stop gate text and [kanban-sync](../kanban-sync/SKILL.md) step 7 do them: render, `Artifact read` the url, publish with `url` and NO `capabilities`. Never pass `force`.

## Preconditions (stop if any one fails)

- `<key>` is an active entry in `.claude/project-registry.json` where the board equals the key. It is not `continuous-claude` (that board keeps its page in `.claude/artifacts.json`).
- The board has no page yet. `node C:/Users/dkhay/.claude/scripts/lane.mjs project which --json --project <key>` shows `entry.artifact` null. If it has a url, stop: use kanban-sync step 7.
- Dave said yes to a publish for THIS board, in this session. A yes for another board does not count.
- You run in the primary checkout `C:/Users/dkhay/continuous-claude`, never in a worktree copy (a worktree renders a stale template).
- Lane text goes into the page. It holds no secrets or personal data. The page is private to Dave's account and is not a security boundary.

## Steps

1. Render. From the primary checkout:

   ```
   node C:/Users/dkhay/continuous-claude/scripts/coordination/render-board.mjs --project <key> --interactive
   ```

   It writes `lane-board-<key>.html`. The `--interactive` flag is needed because the board has no `laneArtifact` yet. Check the file holds `<meta name="lane-board" content="board=<key>;...">`.

2. Publish with `Artifact publish`:
   - `file_path`: `lane-board-<key>.html`.
   - NO `url`: this is the one publish that creates the artifact.
   - `capabilities`: `{ "db": {}, "sample": {} }`. This is the only publish that passes capabilities. The exact `sample` shape is unproven: the parent session probes it on a scratch artifact before the first pilot. If the tool rejects it, stop and report. Do not retry with `{}`: `{}` removes db access.
   - Favicon: the same as every board page, the one in the `agentic-os-lane-board` entry of `.claude/artifacts.json` (🛤️).
   - Title: `Lane Board · <key>`. Visibility: private (the default).

3. Read back. `Artifact read` the returned url (path `index.html`). The stamp must say `board=<key>`. Then `ArtifactData get` the doc `kanban/board` on the new url. The expected answer is `No document`: the db is declared and empty. `invalid_argument` means the db was not declared: stop and report.

4. Record the url. Add `"laneArtifact": "<returned url>"` to the board's entry in `.claude/project-registry.json` of the PRIMARY checkout, through a normal PR. Never edit the live `~/.claude/project-registry.json` by hand: forward sync copies it. Land and sync this edit before the next `project register` or `unregister` edit. The url must be exactly `https://claude.ai/artifact/<id>`. It must differ from every other board's url.

5. Report: the url, the stamp, the `No document` answer, and the registry PR.

## Warning window

Until the registry line lands on main and syncs, the hooks do not know the page. The Stop gate and the republish reminder stay silent for this board. After the line lands but before the sync, every lane command prints a mirror-stale warning on stderr, and `project register` and `unregister` refuse (the repo and live registries differ). Sync with `scripts/sync-to-active.sh --changed` on main. `node scripts/harness-doctor.mjs` then shows `registry:artifact-url` with the new count.

## If something goes wrong

- A publish without `url` mints a second artifact. If you published twice, name the stray url for Dave: agents cannot delete artifacts.
- A dead url (Dave deleted the page): ask Dave for a one-line PR that removes the `laneArtifact` line, then run this skill again.
