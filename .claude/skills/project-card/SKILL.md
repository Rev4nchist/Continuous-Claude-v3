---
name: project-card
description: Refresh and publish a living HTML status card for a FourthOS project. Zero-LLM deterministic assembler (scripts/project-cards/) emits a publish manifest; this skill does the one Notion MCP embed-bind step. Use when the user says "/project-card", "refresh card", "living status card", "project card", or after reportable FourthOS work on a project.
---

# /project-card — living project status cards

A two-step contract: a deterministic Node engine assembles + hashes the card and
emits a manifest; you (the skill) perform the single Notion MCP embed-bind that
the CLI cannot do. The engine NEVER calls the MCP or `claude -p` — you do.

## Commands

```bash
# one project (name matched against the FourthOS Projects DB title)
node scripts/project-cards/refresh.mjs "Connector Ecosystem"

# whole roster
node scripts/project-cards/refresh.mjs --all
```

`stdout` is a JSON manifest. Single-name → one object; `--all` →
`{ntnVersion, count, results:[...]}`. Manifest fields:
`projectName, slug, pageId, htmlPath, contentHash, changed, needsPublish,
cardSectionHeading` (`"## 📊 Living Status Card"`).

## Step 1 — refresh (deterministic, no LLM)

Run the command above. The engine queries the live Projects DB + Decisions &
Outputs DB, assembles `out/<slug>.html`, and computes a content hash that
**excludes** the volatile as-of stamp. Decide from the manifest:

- `changed:false && needsPublish:false` → nothing to do. Stop.
- `changed:true` OR `needsPublish:true` → go to Step 2.
- `pageId:null` → the row has no Notion page to host the card (its
  `Project Page` is likely a GitHub URL). Do not publish; report the gap.

## Step 2 — publish the embed (Notion MCP — the one step the CLI can't do)

Read the assembled HTML from `htmlPath` (≤200 KiB), then:

1. `notion-create-attachment` with the HTML string → returns `file-upload://<id>`
   (temporary — bind within 1 hour).
2. `notion-update-page` on `pageId`: insert or replace the job-owned
   `## 📊 Living Status Card` section with:
   - `<embed src="file-upload://<id>">` (the interactive sandboxed card)
   - an as-of caption line beneath it.

The `## 📊 Living Status Card` heading marks the section this skill owns on the
target page — replace its content, don't append duplicates.

After a successful publish, record it in `scripts/project-cards/state.json` for
that slug: set `attachmentId` and `lastPublished` (ISO timestamp). The engine
reads these on the next run so a published, unchanged card becomes a true no-op.

## Card spec contract

- Roster = FourthOS Projects DB rows (data source `852a60e1-…`) + the CCv3
  pilot card.
- Identity = `scripts/project-cards/template.html` (the approved bento pilot).
  Health chip class `green|yellow|red`; Watch block only when Health is
  Yellow/Red or Decision Needed is true.
- Recent progress / Next steps / Evidence come from the project's Decisions &
  Outputs rows (data source `e209f0f0-…`), newest first, 3–5 rows.

## ntn contract (already enforced by the engine)

Absolute exe path, closed stdin, 30 s timeout, `windowsHide`, fail-loud,
`ntn --version` logged per run. See `.claude/rules-ondemand/notion-cli-safety.md` and
`scripts/project-cards/README.md`.

## Reporting discipline

After reportable FourthOS work on a project, run
`/project-card refresh <that project>` so its living card stays current.

## Automated daily sweep

`node scripts/project-cards/sweep.mjs [--dry-run]` runs `refresh.mjs --all`, then
publishes each changed/unpublished card and refreshes the Reporting Hub gallery
via headless `claude -p` (connector needs `ANTHROPIC_API_KEY` unset); `--dry-run`
previews without spawning claude. See `scripts/project-cards/README.md`.
