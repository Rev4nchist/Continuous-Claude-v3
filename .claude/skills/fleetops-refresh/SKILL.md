---
name: fleetops-refresh
description: Refreshes the data on Dave's FleetOps lane dashboard from the lane export. Use when Dave says "refresh FleetOps" or asks for a FleetOps refresh.
---

# FleetOps refresh

FleetOps is Dave's lane dashboard: https://claude.ai/artifact/Vnf8urTCv7awKXwNT423F8. It is a Claude Dashboard artifact, registered in `.claude/artifacts.json` as `fleetops-dashboard`. A refresh changes only its 7 data files. It never changes the page. For a page change, read the Dashboard type's `SKILL.md` on that artifact first.

The nightly task `CCv3-Lane-Snapshot` runs the export at 23:55 Central. It writes the 7 files to `~/.claude/state/lane-dash` and uploads nothing. This skill does the upload. The export also writes `flow.json` for the Fleet app. It is not a dashboard source: never copy or upload it.

## Rules

- Anyone who can open the dashboard can read the 7 files. They hold lane titles. Dave decided that.
- Ask Dave with AskUserQuestion before step 2 (the export), unless Dave's own message asked for the refresh.
- A refresh writes to a shared dashboard. Ask Dave with AskUserQuestion before step 4. Skip the question when Dave's own message asked for the refresh.
- Never render, screenshot or browse the real dashboard. Read only its `check` and `runs` documents.
- Never change `files/index.html` in a refresh.
- Use only `Artifact`, `ArtifactData` and `node`. Put no credential anywhere.

## Steps

1. Read `~/.claude/state/lane-dash/refresh.json`. If it is missing, treat the data as stale. A missing file means no export has run yet; go to step 2 after Dave's ask.
   - `pending: true` means the files are newer than the last upload. Go to step 3. If Dave asked for a fresh export, go to step 2 instead.
   - `pending: false` and `exported_at` under 1 hour old: tell Dave nothing is stale. Stop, unless Dave asked for a refresh.
2. Export new files. Do this only when nothing is pending and the data is stale, or Dave asked for a fresh export.
   `node C:/Users/dkhay/continuous-claude/scripts/coordination/export-dash-data.mjs`
   It needs Docker Postgres. On exit 1, stop and report the one-line message. Then read `refresh.json` again.
3. Copy and check the files. Keep the `key` from `refresh.json`.
   1. Copy `lanes tiles assignments projects targets meta snapshots` (each `<id>.json`) from `~/.claude/state/lane-dash` to a new folder in your scratchpad. A nightly run can replace the originals during your upload. Upload only the copies.
   2. Check the copies. Pass your scratchpad folder as the argument. Each file must parse, have an `exportedAt` equal to `key`, and `tiles` must have rows. The command exits 1 when a check fails.
      `node -e "const fs=require('fs'),p=process.argv[1],h=process.env.USERPROFILE;const key=JSON.parse(fs.readFileSync(h+'/.claude/state/lane-dash/refresh.json','utf8')).key;let bad=0;for(const i of ['lanes','tiles','assignments','projects','targets','meta','snapshots']){const d=JSON.parse(fs.readFileSync(p+'/'+i+'.json','utf8'));const ok=d.exportedAt===key&&(i!=='tiles'||(d.rows||[]).length>0);if(!ok)bad++;console.log(i,d.exportedAt,(d.rows||[]).length,ok?'ok':'BAD')}process.exit(bad?1:0)" <your scratchpad folder>`
   3. Stop if the command exits 1 or a file is missing. Then start again from step 1.
4. Upload and switch the 7 sources.
   1. `ArtifactData list` on collection `datasets`. Check the 7 ids exist and each `source.kind` is `file`. If one is missing, stop and report. Never write a document that does not exist. Keep each `version` and each old `source`, `updated`, `edit` and `schedule`. The old `source.url` is `/_blob/<assetId>`.
   2. For each id, call `Artifact` with `url` = the dashboard url, `asset: true` and `file_path` = the scratchpad copy. Make one call per file. Keep each result `url` exactly as given.
   3. Get the time: `node -p "new Date().toISOString()"`.
   4. Send one `ArtifactData batch` with 7 `update` entries, each with its `if_version`. Each entry sets:
      - `source`: `{kind: "file", url: <new url>, name: "<id>.json", format: "json"}`
      - `updated`: `{at: <time>, by: "claude"}`
      - `edit`: `{via: "claude", at: <time>}`
      - `schedule`: `Exported nightly at 23:55 Central by CCv3-Lane-Snapshot. Uploaded on request by a Claude session.`
      - `staleAfterHours`: `48`
      A version conflict writes nothing. Read `refresh.json` again. If `key` changed, a newer export exists: start again from step 1. If it is the same, run `list` again and resend the whole batch.
5. Check the dashboard. Read collection `data/users/me`, doc `runs`, then doc `check`.
   - `runs` is the main signal. Fix a `failed` or `refused` dataset only from your own result.
   - `check` can stay empty or unchanged after a data-only write. That is normal. Read it 5 times at most.
   - On `failed` in `check`, fix only what the code confirms. Fix 2 times at most.
   - Never say the page works from a missing document.
   - If `runs` shows a failed or refused dataset, or `check` shows a failure you could not fix, roll back and stop. Do not go on to step 6.
     1. `ArtifactData list` on `datasets`. For each id whose `source.url` is still the url you uploaded in step 4, send one `update` pinned with its current `version`. It restores the old `source`, `updated`, `edit` and `schedule` from step 4.1. Never touch a source someone else changed.
     2. Delete the new uploads you made in step 4.
     3. Leave the pending flag on. Report the failing ids.
6. Clear the pending flag. Do this only when step 5 found no failure. Use the `key` from your last read of `refresh.json`.
   `node C:/Users/dkhay/continuous-claude/scripts/coordination/export-dash-data.mjs --clear-refresh <key>`
   - A key mismatch means a newer export ran. Start again from step 1.
   - The message `export lock is held` means an export runs now. Wait 1 minute and run this step again.
7. Delete the old uploads. Do this last, after step 5 passed. Use `Artifact` with `action: "delete"`, `url` = the dashboard url, and `path` = the old asset id (the part after `/_blob/`). Delete only the 7 ids you replaced.
8. Report. Give the export time, the `tiles` row count, the 7 sources you switched, and what `runs` and `check` said. Say the page was not rendered.

## When it goes wrong

- An upload or `ArtifactData` write is refused because you are not an editor: say so. Do not retry.
- Some uploads worked and the batch failed for a reason other than a version conflict: the old sources still work. Delete the new uploads. Then report.
- A delete failed after the batch worked: the sources point at the new files. Report the stray asset ids.
- Docker is down in step 2: the old data stays on the dashboard. Report it.
