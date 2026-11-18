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

The page lives in Dave's Notion workspace, not in a claude.ai account. The `notion` MCP server of this machine reaches it from a session on either claude.ai account. It is set in user scope (`~/.claude.json`), not in `.claude/machine-config/mcp.json`. Use only its tools `notion-fetch`, `notion-create-attachment`, `notion-update-page` and `notion-get-file-download-urls`. Never use the claude.ai Notion connector: it belongs to one claude.ai account. If the `notion` server is missing in this session, stop and report it.

## Rules

- Ask Dave with AskUserQuestion before step 2 (the export), unless Dave's own message asked for the refresh.
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
5. Preflight. `notion-fetch` the page id. If the call fails, stop and report "Notion MCP not connected to the FleetOps workspace". Write nothing.
6. Upload and write, in this one turn (an upload expires after 1 hour if it is not placed).
   0. Read `refresh.json` again. If its `key` is not the manifest `exportedAt`, a newer export ran: start again from step 3 with new copies. This keeps an older render from overwriting a newer one.
   1. Read `out/fleetops.html` with the Read tool and `allow_large: true`, so the whole file comes back in one read (it is about 55 KB). Call `notion-create-attachment` with `content` = that text unchanged and `filename` = `FleetOps live board.html`. Keep the `file-upload://<id>` it returns.
      - Compare the returned `content_length` with `htmlBytes` in `out/manifest.json`. If they differ, the copy is not exact: do not place the upload (it expires by itself), stop and report.
   2. Read `out/page.md`. Replace the single line `{{FLEETOPS_EMBED}}` with `<embed source="file-upload://<id>" />`. Change nothing else.
   3. Call `notion-update-page` with `command: "replace_content"`, `page_id` = the page id, `new_str` = that text, `allow_async: false`. Do not pass `allow_deleting_content`. A refusal that lists child pages or databases: stop and report the list. Do not retry.
7. Read back.
   1. `notion-fetch` the page id again. The result is JSON: take its `text` field as plain text (real line breaks and quotes, not `\n` and `\"`). Save the part between `<content>` and `</content>` (blank lines at its ends may stay) to `<your scratchpad folder>/out/readback.md` with the Write tool.
   2. `node R/scripts/coordination/fleetops-html.mjs --check <your scratchpad folder>/out/readback.md --stamp <exportedAt>`
      It prints `check: listed N, stamp yes|no, embeds M, h2 K` and exits 0 only when no listed id is in the decoded text, the stamp is present, the embed is there and both sections are there.
   3. Check the uploaded file itself. Call `notion-get-file-download-urls` with the `notion-file-block://...` source of the embed from the read-back. The signed url carries a token and expires in about 5 minutes: never put it on a command line or in a message. Write it alone to `<your scratchpad folder>/out/upload-url.txt` with the Write tool, then run at once:
      `node R/scripts/coordination/fleetops-html.mjs --verify-upload @<your scratchpad folder>/out/upload-url.txt --manifest <your scratchpad folder>/out/manifest.json`
      The script reads the url from the file and deletes the file.
      It prints `verify-upload: sha ok|MISMATCH, bytes N` and exits 0 only when the uploaded file is byte-identical to the rendered file. A MISMATCH means the copy into the upload was not exact: run steps 6 and 7 again once. A second MISMATCH: follow step 7.5.
   4. Fail with a listed id above 0: this is a leak. Replace the page body at once with the single line `FleetOps is being rebuilt.` Tell Dave the page history in Notion still holds the leaked version and that he must remove it there. Leave the pending flag on. Stop.
   5. Fail for another reason: leave the pending flag on and report what differed. Notion keeps the page history; Dave can restore an older version.
8. Clear the pending flag. Only when step 7 passed. Use the `key` from your last read of `refresh.json`.
   `node R/scripts/coordination/fleetops-auto-tick.mjs --record-upload <your scratchpad folder>`
   - It exits 1 and stores nothing when a copy has an `exportedAt` that is not the `key` of `refresh.json`. A newer export ran while you wrote: the page may now hold older data than another session placed. Start again from step 3 with new copies (not step 1), so the newest export ends on the page.
   `node R/scripts/coordination/export-dash-data.mjs --clear-refresh <key>`
   - A key mismatch means a newer export ran. Start again from step 3 with new copies.
   - The message `export lock is held` means an export runs now. Wait 1 minute and run this step again.
9. Report. Give the export time in CST, the masked count from step 4, the check line from step 7, and the page link.

## When it goes wrong

- Docker is down in step 2: the old data stays on the page. Report it.
- The `notion` server is missing in this session: report it. Do not use another Notion connector.
- The upload worked and the page write failed: the unplaced upload expires by itself in 1 hour. Report it.
- The write worked and the read-back failed: follow step 7.4 or 7.5. Never clear the flag.
