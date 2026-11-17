---
name: fleetops-refresh
description: Rewrites Dave's FleetOps Notion page from the lane export. Use when Dave says "refresh FleetOps" or asks for a FleetOps refresh.
---

# FleetOps refresh

FleetOps is Dave's lane dashboard. It is a Notion page:
https://app.notion.com/p/41b76fd7ac828067959afa940d32dc54 (page id `41b76fd7ac828067959afa940d32dc54`).
It is registered in `.claude/artifacts.json` as `fleetops-dashboard`. The old claude.ai Dashboard artifact is retired. Never write to it.

A refresh renders the page body from the 7 export files and replaces the whole body. The page is built from native Notion blocks only. It has no embed, no child page and no database.

The nightly task `CCv3-Lane-Snapshot` runs the export at 23:55 Central. It writes the 7 files to `~/.claude/state/lane-dash` and uploads nothing. The task also writes `flow.json` and `factory.json` for the Fleet app. They are not page sources: never read them here.

The task `CCv3-FleetOps-Auto`, when Dave enables it, runs the export every 30 minutes. It clears the pending flag when the data did not change. It writes nothing to Notion.

## Either account

The page lives in Dave's Notion workspace, not in a claude.ai account. The `notion` MCP server of this machine reaches it from a session on either claude.ai account. It is set in user scope (`~/.claude.json`), not in `.claude/machine-config/mcp.json`. Use only its tools `notion-fetch` and `notion-update-page`. Never use the claude.ai Notion connector: it belongs to one claude.ai account. If the `notion` server is missing in this session, stop and report it.

## Rules

- Ask Dave with AskUserQuestion before step 2 (the export), unless Dave's own message asked for the refresh.
- The page leaves this machine. The renderer masks every listed id (`board-mask.mjs`) and refuses a page with one left. Never write page text that the renderer did not print. Never edit the page by hand.
- Lane titles, lane goals and holder names go on the page (Dave decided).
- Never pass `allow_deleting_content: true`. If a write asks for it, stop and report: someone added a child page or database.
- Use only `node` and the `notion` server tools `notion-fetch` and `notion-update-page`. Put no credential anywhere.

## Steps

`R` means the primary checkout, `C:/Users/dkhay/continuous-claude`. Never run a worktree copy of the scripts.

1. Read `~/.claude/state/lane-dash/refresh.json`. If it is missing, treat the data as stale. A missing file means no export has run yet; go to step 2 after Dave's ask.
   - `pending: true` means the files are newer than the last page write. Go to step 3. If Dave asked for a fresh export, go to step 2 instead.
   - `pending: false` and `exported_at` under 1 hour old: tell Dave nothing is stale. Stop, unless Dave asked for a refresh.
2. Export new files. Do this only when nothing is pending and the data is stale, or Dave asked for a fresh export.
   `node R/scripts/coordination/export-dash-data.mjs`
   It needs Docker Postgres. On exit 1, stop and report the one-line message. Then read `refresh.json` again.
3. Copy and check the files. Keep the `key` from `refresh.json`.
   1. Copy `lanes tiles assignments projects targets meta snapshots` (each `<id>.json`) from `~/.claude/state/lane-dash` to a new folder in your scratchpad. A nightly run can replace the originals while you work. Use only the copies.
   2. Check the copies. Pass your scratchpad folder as the argument. Each file must parse, have an `exportedAt` equal to `key`, and `tiles` must have rows. The command exits 1 when a check fails.
      `node -e "const fs=require('fs'),p=process.argv[1],h=process.env.USERPROFILE;const key=JSON.parse(fs.readFileSync(h+'/.claude/state/lane-dash/refresh.json','utf8')).key;let bad=0;for(const i of ['lanes','tiles','assignments','projects','targets','meta','snapshots']){const d=JSON.parse(fs.readFileSync(p+'/'+i+'.json','utf8'));const ok=d.exportedAt===key&&(i!=='tiles'||(d.rows||[]).length>0);if(!ok)bad++;console.log(i,d.exportedAt,(d.rows||[]).length,ok?'ok':'BAD')}process.exit(bad?1:0)" <your scratchpad folder>`
   3. Stop if the command exits 1 or a file is missing. Then start again from step 1.
4. Render.
   `node R/scripts/coordination/fleetops-notion.mjs <your scratchpad folder> --out <your scratchpad folder>/out`
   - It writes `out/page.md` and `out/manifest.json` and prints one line: how many ids it masked. It sends nothing.
   - Exit 1 means a missing or mixed file, an id list it cannot read, or a listed id left after the mask. Nothing is written. Stop and report the line.
   - Read `out/manifest.json`. Keep `exportedAt` and `h2Count`.
5. Preflight. `notion-fetch` the page id. If the call fails, stop and report "Notion MCP not connected to the FleetOps workspace". Write nothing.
6. Write. Read `out/page.md` with the Read tool. Send its text unchanged with `notion-update-page`: `command: "replace_content"`, `page_id` = the page id, `new_str` = the text, `allow_async: false`. Do not pass `allow_deleting_content`.
   - A refusal that lists child pages or databases: stop and report the list. Do not retry.
7. Read back.
   1. `notion-fetch` the page id again. Save the text between `<content>` and `</content>` to `<your scratchpad folder>/out/readback.md` with the Write tool.
   2. Check it. The command prints the H2 count and the listed-id count, and exits 1 when the count of ids is not 0 or the export stamp is missing.
      `node --input-type=module -e "import {readFileSync} from 'node:fs';import {readIdList,countListed} from 'file:///C:/Users/dkhay/continuous-claude/scripts/coordination/board-mask.mjs';const [f,stamp]=process.argv.slice(1);const t=readFileSync(f,'utf8');const n=countListed(t,readIdList('C:/Users/dkhay/continuous-claude'));const h2=(t.match(/^(## |<toggle heading=.h2.>)/gm)||[]).length;console.log('h2',h2,'listed',n,'stamp',t.includes(stamp));process.exit(n===0&&t.includes(stamp)?0:1)" <your scratchpad folder>/out/readback.md <exportedAt>`
   3. Pass: exit 0 and `h2` equals the manifest `h2Count`.
   4. Fail with a listed id above 0: this is a leak. Run step 6 again at once with the previous good body if you have it. Otherwise replace the body with the single line `FleetOps is being rebuilt.` Then tell Dave. Leave the pending flag on.
   5. Fail for another reason: leave the pending flag on and report what differed. Notion keeps the page history; Dave can restore an older version.
8. Clear the pending flag. Do this only when step 7 passed. Use the `key` from your last read of `refresh.json`.
   First record the write. The timed task uses it to see that the data did not change.
   `node R/scripts/coordination/fleetops-auto-tick.mjs --record-upload <your scratchpad folder>`
   - It exits 1 and stores nothing when a copy has an `exportedAt` that is not the `key` of `refresh.json`. A newer export ran: start again from step 1.
   Then clear the flag:
   `node R/scripts/coordination/export-dash-data.mjs --clear-refresh <key>`
   - A key mismatch means a newer export ran. Start again from step 1.
   - The message `export lock is held` means an export runs now. Wait 1 minute and run this step again.
9. Report. Give the export time in CST, the masked count from step 4, the H2 count, the read-back result, and the page link.

## When it goes wrong

- Docker is down in step 2: the old data stays on the page. Report it.
- The Notion server is missing in this session: report it. Do not use another Notion connector.
- The write worked and the read-back failed: follow step 7.4 or 7.5. Never clear the flag.
