---
name: fleetops-refresh
description: Rewrites Dave's FleetOps Notion page (a designed HTML embed plus a short summary) from the lane export. Use when Dave says "refresh FleetOps" or asks for a FleetOps refresh.
---

# FleetOps refresh

FleetOps is Dave's lane dashboard. It is a Notion page:
https://app.notion.com/p/41b76fd7ac828067959afa940d32dc54 (page id `41b76fd7ac828067959afa940d32dc54`).
It is registered in `.claude/artifacts.json` as `fleetops-dashboard`. The old claude.ai Dashboard artifact is retired. Never write to it.

The page has three parts, all rendered by one script from the same data:
- a short native summary at the top (data age, one headline sentence, 4 numbers), readable on the phone with no tap;
- `## 📊 FleetOps live board`: one self-contained HTML file shown as an embed (inline on desktop, a file card on the phone that opens full screen);
- `## 📘 How to use and update`: the rules for Dave and for sessions.

A refresh renders a new HTML file and a new page body, uploads the file, and replaces the whole page body. The page holds no child page and no database. A frame height that Dave dragged resets on each refresh.

The nightly task `CCv3-Lane-Snapshot` runs the export at 23:55 Central. It writes the 7 files to `~/.claude/state/lane-dash` and uploads nothing. The task also writes `flow.json` and `factory.json` for the Fleet app. They are not page sources: never read them here. The task `CCv3-FleetOps-Auto`, when enabled, runs the export every 30 minutes and leaves the pending flag on when the data changed. It writes nothing to Notion.

## Either account

The page lives in Dave's Notion workspace, not in a claude.ai account. The `notion` MCP server of this machine reaches it from a session on either claude.ai account. It is set in user scope (`~/.claude.json`), not in `.claude/machine-config/mcp.json`. Use only its tools `notion-fetch`, `notion-create-attachment`, `notion-update-page` and `notion-get-file-download-urls`. Never use the claude.ai Notion connector: it belongs to one claude.ai account. If the `notion` server is missing in this session, skip the refresh (step 5): take no lock, write no failed state, report it.

## Rules

- Dave's tap ("Auto refresh: Yes, with these limits"): a session may run steps 3 to 9 on its own when the Stop-gate line says FleetOps data is "not uploaded" and to run this skill. The limits: one refresh an hour per machine (the lock refuses with exit 4 inside the hour), one writer (the lock in step 5), never in a headless run, data only, no spend. If this is a headless run (`claude -p`), skip the refresh.
- Step 2 (the export) still needs Dave's ask: ask with AskUserQuestion before step 2, unless Dave's own message asked for the refresh. An "older than 36 hours" line or a "refresh failed" line is not a reason to run this skill: tell Dave in one line.
- The lock: step 5 takes it and step 9 releases it. Every stop in steps 6 to 8 (a failed check, a refusal, an error, a leak in 7.4, a failure in 7.5) runs the failed release before the report. `<n>` is the step number, such as 6.1 or 7.3:
  `node R/scripts/coordination/fleetops-html.mjs --lock-release failed --session <sid8> --step <n>`
  It writes `publish.json` with state `failed`, the export key and the step, and removes the lock. The Stop gate then shows one "refresh failed" line for that export, and no run line. The lock refuses a retry of that export (exit 5). A new export clears it.
  Keep the lock alive: before step 6 and before step 8 run `node R/scripts/coordination/fleetops-html.mjs --lock-touch --session <sid8>`. It sets a new time on your lock. Exit 3 means you lost the lock: stop and report, release nothing.
- A stop during a restart runs the failed release with that step number. A restart keeps the lock, so a stop at step 3.3, 4 or 5.1 after the restart began needs the release too.
- Exits of `--lock-touch`, `--lock-rekey` and `--lock-release`:
  - 0: done.
  - 1: an error. After a touch or a rekey, run the failed release with the step number, then stop. After a release, report the error: the lock may still be there.
  - 3: this session does not hold the lock. After a touch or a rekey, stop, report it and release nothing. After a release, report it: another session holds the lock.
  - 6: busy, a takeover runs. Nothing changed. Wait 2 seconds and run the same command once more. A second 6 from a touch or a rekey: run the failed release with the step number, then stop. A second 6 from a release: report it.
- The page leaves this machine. The renderer masks every listed id (`board-mask.mjs`), counts listed ids on the text a viewer sees, and refuses to write when one is left. Never upload or write text that the renderer did not print. Never edit the page by hand.
- Lane titles, lane goals and holder names go on the page (Dave decided).
- A refresh changes data only. A design change goes through the template in `scripts/coordination/fleetops/` and a pull request.
- Never pass `allow_deleting_content: true`. If a write asks for it, stop and report: someone added a child page or database.
- Use only `node` (run from your shell tool), the Read and Write tools, and the four `notion` server tools above. Put no credential anywhere.

## Steps

`R` means the primary checkout, `C:/Users/dkhay/continuous-claude`. Never run a worktree copy of the scripts.

1. Read `~/.claude/state/lane-dash/refresh.json`. If it is missing, treat the data as stale and go to step 2 after Dave's ask.
   - `pending: true`: the files are newer than the page. Go to step 3. If Dave asked for a fresh export, go to step 2 instead.
   - `pending: false` and `exported_at` under 1 hour old: tell Dave the page is current. Stop, unless Dave asked for a refresh.
   - `pending: false` and `exported_at` 1 hour old or more: go to step 2 after Dave's ask.
2. Export new files.
   `node R/scripts/coordination/export-dash-data.mjs`
   It needs Docker Postgres. On exit 1, stop and report the one-line message. Then read `refresh.json` again.
3. Copy and check the files. Keep the `key` from `refresh.json`.
   1. Copy `lanes tiles assignments projects targets meta snapshots` (each `<id>.json`) from `~/.claude/state/lane-dash` to a new folder in your scratchpad. Use only the copies.
   2. Check the copies. Each file must parse, have an `exportedAt` equal to `key`, and `tiles` must have rows. The command exits 1 when a check fails.
      `node -e "const fs=require('fs'),p=process.argv[1],h=process.env.USERPROFILE;const key=JSON.parse(fs.readFileSync(h+'/.claude/state/lane-dash/refresh.json','utf8')).key;let bad=0;for(const i of ['lanes','tiles','assignments','projects','targets','meta','snapshots']){const d=JSON.parse(fs.readFileSync(p+'/'+i+'.json','utf8'));const ok=d.exportedAt===key&&(i!=='tiles'||(d.rows||[]).length>0);if(!ok)bad++;console.log(i,d.exportedAt,(d.rows||[]).length,ok?'ok':'BAD')}process.exit(bad?1:0)" <your scratchpad folder>`
   3. Stop if the command exits 1 or a file is missing. Then start again from step 1.
4. Render.
   `node R/scripts/coordination/fleetops-html.mjs <your scratchpad folder> --out <your scratchpad folder>/out`
   - It writes `out/fleetops.html`, `out/page.md` and `out/manifest.json`, and prints one line. It sends nothing.
   - Exit 1 means a missing or mixed file, an id list it cannot read, or a listed id left in the text a viewer sees. Nothing is written. Stop and report the line.
   - Read `out/manifest.json`. Keep `exportedAt`.
5. Preflight and lock.
   1. Check that this session can load the `notion` server tools of the Rules section (load them with ToolSearch if they are deferred). `notion-fetch` the page id. If a tool is missing or the call fails, skip the refresh: report "Notion MCP not connected to the FleetOps workspace". Write nothing. Take no lock. Write no failed state.
   2. Take the lock, with the `exportedAt` of the manifest as the key and the <first 8 characters of CLAUDE_CODE_SESSION_ID> as `<sid8>`:
      `node R/scripts/coordination/fleetops-html.mjs --lock-acquire <exportedAt> --session <sid8>`
      - Exit 3: another session writes the page. Stop and report its one line. Write no failed state. Release nothing: the lock is not yours.
      - Exit 4: the last refresh on this machine was under 1 hour ago (Dave's limit: one refresh an hour). Skip quietly: no failed state, nothing to report beyond its one line.
      - Exit 5: this export already failed. The lock refuses a retry. Skip quietly: no failed state, nothing to report beyond its one line.
      - Exit 1: an I/O error. Stop and report its one line. Write no failed state.
      - Add `--force` only when Dave's own message asked for this refresh. It skips exits 4 and 5, never a live lock. A Stop-gate line is never a reason for `--force`.
      - A restart (step 6.0 or 8) already holds the lock: run `node R/scripts/coordination/fleetops-html.mjs --lock-rekey <exportedAt> --session <sid8>` in place of the acquire. Exit 3 means you lost the lock: stop and report, release nothing.
      From here every stop in steps 6 to 8 ends with the failed release (see Rules). A lock over 20 minutes old counts as dead and the next session takes it over.
6. Upload and write, in this one turn (an upload expires after 1 hour if it is not placed). First run `node R/scripts/coordination/fleetops-html.mjs --lock-touch --session <sid8>` (exit 3: you lost the lock; stop and report, release nothing).
   0. Read `refresh.json` again. If its `key` is not the manifest `exportedAt`, a newer export ran. Keep the lock (no release). Start again from step 3 with new copies; step 5.2 rekeys the lock to the new `exportedAt`. Restart at most once: on a second newer export, run the failed release with step 6.0. This keeps an older render from overwriting a newer one.
   1. Read `out/fleetops.html` with the Read tool and `allow_large: true`, so the whole file comes back in one read (it is about 55 KB). Call `notion-create-attachment` with `content` = that text unchanged and `filename` = `FleetOps live board.html`. Keep the `file-upload://<id>` it returns.
      - Compare the returned `content_length` with `htmlBytes` in `out/manifest.json`. If they differ, the copy is not exact: do not place the upload (it expires by itself), run the failed release with step 6.1, and report.
   2. Read `out/page.md`. Replace the single line `{{FLEETOPS_EMBED}}` with `<embed source="file-upload://<id>" />`. Change nothing else.
   3. Call `notion-update-page` with `command: "replace_content"`, `page_id` = the page id, `new_str` = that text, `allow_async: false`. Do not pass `allow_deleting_content`. A refusal that lists child pages or databases: run the failed release with step 6.3, and report the list. Do not retry.
7. Read back.
   1. `notion-fetch` the page id again. The result is JSON: take its `text` field as plain text (real line breaks and quotes, not `\n` and `\"`). Save the part between `<content>` and `</content>` (blank lines at its ends may stay) to `<your scratchpad folder>/out/readback.md` with the Write tool.
   2. `node R/scripts/coordination/fleetops-html.mjs --check <your scratchpad folder>/out/readback.md --stamp <exportedAt>`
      It prints `check: listed N, stamp yes|no, embeds M, h2 K` and exits 0 only when no listed id is in the decoded text, the stamp is present, the embed is there and both sections are there.
   3. Check the uploaded file itself. Call `notion-get-file-download-urls` with the `notion-file-block://...` source of the embed from the read-back. The signed url carries a token and expires in about 5 minutes: never put it on a command line or in a message. Write it alone to `<your scratchpad folder>/out/upload-url.txt` with the Write tool, then run at once:
      `node R/scripts/coordination/fleetops-html.mjs --verify-upload @<your scratchpad folder>/out/upload-url.txt --manifest <your scratchpad folder>/out/manifest.json`
      The script reads the url from the file and deletes the file.
      It prints `verify-upload: sha ok|MISMATCH, bytes N` and exits 0 only when the uploaded file is byte-identical to the rendered file. A MISMATCH means the copy into the upload was not exact: run steps 6 and 7 again once. A second MISMATCH: follow step 7.5 (it runs the failed release).
   4. Fail with a listed id above 0: this is a leak. Replace the page body at once with the single line `FleetOps is being rebuilt.` Tell Dave the page history in Notion still holds the leaked version and that he must remove it there. Leave the pending flag on. Run the failed release with step 7.4. Stop.
   5. Fail for another reason: leave the pending flag on, run the failed release with step 7.5, and report what differed. Notion keeps the page history; Dave can restore an older version.
8. Clear the pending flag. Only when step 7 passed. First run `node R/scripts/coordination/fleetops-html.mjs --lock-touch --session <sid8>` (exit 3: you lost the lock; stop and report, release nothing). Use the `key` from your last read of `refresh.json`.
   `node R/scripts/coordination/fleetops-auto-tick.mjs --record-upload <your scratchpad folder>`
   - It exits 1 and stores nothing when a copy has an `exportedAt` that is not the `key` of `refresh.json`. A newer export ran while you wrote: the page may now hold older data than another session placed. Keep the lock (no release), then start again from step 3 with new copies (not step 1), so the newest export ends on the page. Step 5.2 rekeys the lock. Restart at most once: on a second mismatch, run the failed release with step 8.
   `node R/scripts/coordination/export-dash-data.mjs --clear-refresh <key>`
   - A key mismatch means a newer export ran. Keep the lock, then start again from step 3 with new copies (the same restart rule: at most once, then the failed release with step 8).
   - The message `export lock is held` means an export runs now. Wait 1 minute and run this step again. Try at most 3 times; after the third try run the failed release with step 8, and report.
9. Release the lock and report. Release only after step 8 passed:
   `node R/scripts/coordination/fleetops-html.mjs --lock-release ok --session <sid8>`
   It removes `publish.lock` and writes `publish.json` with state `ok` (the one-an-hour limit reads it). Exit 3 means this session no longer holds the lock (a dead-lock takeover): say so in the report. Exit 1: stop and report its one line.
   Then report. Give the export time in CST, the masked count from step 4, the check line from step 7, and the page link.

## When it goes wrong

- Docker is down in step 2: the old data stays on the page. Report it.
- The `notion` server is missing in this session, or the preflight fetch fails (step 5.1): skip the refresh and report it. No lock, no failed state. Do not use another Notion connector.
- The upload worked and the page write failed: run the failed release with step 6.3. The unplaced upload expires by itself in 1 hour. Report it.
- A lock command prints `lock conflict`: another session moved a fresh lock aside. The file `publish.lock.taken.<session>` stays in `~/.claude/state/lane-dash`. Stop and report. Dave can delete that file when no refresh runs.
- The write worked and the read-back failed: follow step 7.4 or 7.5 (each runs the failed release). Never clear the flag.
