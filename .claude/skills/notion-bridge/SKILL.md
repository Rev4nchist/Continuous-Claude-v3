---
name: notion-bridge
description: Use when reading or writing Claude Bridge between Eve, Donna and Claude Code — handing work off, reading or closing a handoff, writing back results, session handoffs, "bridge sync", or logging decisions and implementation notes. Handoffs are rows in the 📬 Handoffs database on Bridge HQ.
---

# Notion Claude Bridge
## v2.0 | 2026-09-24 | Handoffs database (replaces child pages + HQ one-liners)

Claude Bridge is how three assistants and Dave pass work. It has two parts:

- **📬 Handoffs database** (the action layer). Every handoff is ONE row. The row's page holds the
  full handoff. Queues are views of the database, so nothing is copied onto HQ by hand.
- **🌉 Claude Bridge HQ page** (the knowledge layer). Active Context, Key Decisions pointer,
  architecture notes, Sprint State, the latest Implementation Log entries, and the protocol.

| Instance | Role | Writes |
|---|---|---|
| **Eve** (claude.ai, personal) | Strategy: ideas, decisions, project direction | Handoffs From = Eve; Active Context; Key Decisions |
| **Donna** (Cowork, Fourth business) | Work strategy: Fourth AI projects, SPARK, RFP, competitive intel | Handoffs From = Donna; Key Decisions |
| **Claude Code** (CLI) | Execution: builds, writes results back | Handoffs From = Code; Implementation Log; architecture notes |
| **Dave** | Owner | Anything; his edits win |

Why v2.0 (2026-09-24): the v1 protocol needed a child page AND a hand-written HQ one-liner for each
handoff. The one-liner step was skipped 14 times (Eve→Code, 08-30 to 09-24), so those handoffs never
reached Code. A database view cannot miss a row.

---

## Hardcoded IDs — never deviate

| Resource | ID |
|---|---|
| **Claude Bridge HQ page** | `30e76fd7ac8281e99fe1c0b257088b34` |
| **📬 Handoffs database** | `ea95daf2b1a24ddabbe64f6d056c9346` |
| **Handoffs data source** (for creates and queries) | `13b919c8-b7af-4609-b4c6-87e5504809f0` (`collection://13b919c8-b7af-4609-b4c6-87e5504809f0`) |
| 📌 Key Decisions Log — Full History | `30f76fd7ac828100b7ccfaf7f0fe3f80` |
| 📚 Implementation Log — Full History | `3e576fd7ac8281889efdee0a5447c627` |
| 🗄️ Claude Bridge Archive (sprints before 2026-09-24) | `30e76fd7ac8281258cd9d281aa873298` |
| Cross-Project Alignment Register | `661e97cac8104650b89ff6360f4e4c05` |
| Claude Bridge Bucket (Life Bucket) | `30e76fd7-ac82-81e1-b30e-d170600896a7` |
| Life Buckets DB / Projects DB / Tasks DB | `9ec76fd7-ac82-8342-8bc3-87129f7cf1dc` / `33b76fd7-ac82-8234-a202-8719384ac5b1` / `c3176fd7-ac82-825c-a03c-073837e5493c` |
| AI Enablement Weekly Work Tracker DB (Code write-backs only) | `3d7f2afd6c5046748408e4412a5552b2`, data source `6e8d9b17-f8ef-4d56-9f13-00344650ac03` |
| Default "AI Enablement (generic)" project | `34b76fd7-ac82-8104-82ca-df3e801695c0` |

**Never put a handoff in Dave's Scratchpad** (`1f576fd7ac82807ab8c3f03b2002d40c`). That page holds
research he has not introduced to his AI surfaces yet.

---

## The Handoffs database

| Property | Type | Values / rule |
|---|---|---|
| `Handoff` | title | `[From→To] Title — YYYY-MM-DD` |
| `From` | select | Eve, Donna, Code, Dave |
| `To` | select | Code, Eve, Donna, Next session |
| `Status` | select | see below |
| `Priority` | select | High, Mid, Low (never "Medium") |
| `Date` | date | the day it was written (`date:Date:start` = `YYYY-MM-DD`) |
| `Summary` | text | one sentence: what the receiver must know or do |
| `Project`, `Repo` | text | optional; `Repo` is an absolute path |
| `Outcome` | select | SUCCEEDED, PARTIAL_PLUS, PARTIAL_MINUS, FAILED (session handoffs only) |
| `Resume phrase` | text | session handoffs only: `Resume the handoff in Notion: "<exact title>"` |
| `Created` | created time | automatic |

**Status lifecycle**

| Row kind | Open | Closed |
|---|---|---|
| Work (someone → Code, or Eve ↔ Donna) | `Pending` → `In progress` | `Done` |
| Write-back (Code → Eve or Donna) | `Unread` | `Read` (after it was surfaced to Dave) |
| Any row replaced by a newer one | | `Superseded` (say which one in `Summary`) |

**Views** (tabs on the database, shown inline on HQ): 📥 For Code (To = Code, Pending or In
progress) · 📤 For Eve (To = Eve, Unread) · 📤 For Donna (To = Donna, Unread) · 🔁 Next session ·
✅ Closed. A closed row leaves the queue views by itself.

**Ownership:** the sender writes the row and its page. The receiver changes `Status` only. Eve never
edits Donna's rows; Donna never edits Eve's rows. Dave may edit anything.

---

## Workflows

### Hand work to someone (Eve → Code, Donna → Code, Eve ↔ Donna)
1. `notion-create-pages` with parent `{"type":"data_source_id","data_source_id":"13b919c8-b7af-4609-b4c6-87e5504809f0"}`.
2. Properties: `Handoff`, `From`, `To`, `Status` = `Pending`, `Priority`, `date:Date:start`, `Summary`.
3. Content: the task-brief template (`references/handoff-templates/task-brief.md`).
4. Tell Dave the row URL. Nothing is written on the HQ page.

### Read your queue
- **SQL** (`notion-query-data-sources`, data source URL above):
  - Code: `SELECT * FROM "collection://13b919c8-b7af-4609-b4c6-87e5504809f0" WHERE "To" = 'Code' AND "Status" IN ('Pending','In progress') ORDER BY "date:Date:start" DESC`
  - Eve / Donna: `... WHERE "To" = 'Eve' AND "Status" = 'Unread'` (or `'Donna'`)
- **By title:** `notion-search` with `data_source_url` = the data source URL and the title words.
- Then `notion-fetch` each row to read its page in full. SQL text drops links and mentions; read the page.

### Pick up and finish work (Claude Code)
1. Set the row `Status` = `In progress` (`notion-update-page`, `command: update_properties`).
2. Do the work.
3. Write back (next workflow), then set the original row `Status` = `Done`.

### Write back (Code → Eve or Donna)
1. Create a row: `From` = Code, `To` = the requester, `Status` = `Unread`, `Priority`, `Date`,
   `Summary`. Content: the write-back template (`references/handoff-templates/write-back.md`).
2. Mirror it to the Weekly Work Tracker (see "Tracker auto-mirror" below).
3. Add an Implementation Log entry on HQ (see "HQ page").

### Surface write-backs (Eve, Donna)
Read your 📤 view. Tell Dave what matters, in plain words. Then set each surfaced row to `Read`.

### Session handoff (Claude Code → the next Code session)
Row with `To` = `Next session`, `Status` = `Pending`, plus `Repo`, `Outcome`, `Resume phrase`.
Content: `references/handoff-templates/next-session.md`. In Claude Code, `/create_handoff` writes it
and `/resume_handoff` reads it (title search), sets `In progress`, and sets `Done` when finished.

### "bridge sync" (any instance, when Dave asks)
1. Query your queue. Report: open items, oldest first, with age in days.
2. Close what is finished (`Done`, `Read`, or `Superseded`). Ask Dave about anything open more than
   30 days.
3. Eve: refresh Active Context on HQ. Nobody moves pages: closed rows stay in ✅ Closed.
4. Report in one short list: current, stale, needs Dave.

---

## HQ page (knowledge layer)

Load `references/bridge-schema.md` before editing HQ. Sections, top to bottom: intro, 📋 Active
Context (toggle), 📌 Key Decisions Log (pointer only), 📬 Handoffs (the inline database), 🧠
Architecture & Technical Notes (toggle), ⚡ Current Sprint State (callouts), 📚 Implementation Log
(latest 3 entries), 🔧 Bridge Protocol, then the child pages.

Rules:
- `notion-fetch` HQ before any edit. Never write blind.
- **Never `replace_content` HQ** unless the new content keeps the `<database url=...>` tag and every
  `<page url=...>` tag. Dropping a `<page>` tag deletes that child page; dropping the `<database>` tag
  removes the Handoffs database from the page. Prefer `update_content` with small `old_str`/`new_str`.
- Key Decisions: add to the 📌 Key Decisions Log page, newest first. Never inline on HQ.
- Implementation Log (Claude Code): add the new entry at the top of the HQ section AND at the top of
  the 📚 full-history page; keep only the latest 3 on HQ.
- Sprint State uses callout blocks (`<callout>`), never tables.
- Always date entries `YYYY-MM-DD`. Always return the page or row URL after a write.

---

## Tracker auto-mirror (Claude Code write-backs only)

Every Code → Eve or Code → Donna write-back also gets one row in the AI Enablement Weekly Work Tracker
(data source `6e8d9b17-f8ef-4d56-9f13-00344650ac03`), which feeds `/weekly-report`.

| Tracker property | Source | Default |
|---|---|---|
| Title | handoff title without the `[Code→X]` prefix and date suffix | — |
| Date | today | — |
| Type | fix / feat / rebuild / integrate / deploy keywords → Fix / Feature / Fix / Integration / Deploy | `Ship` |
| Impact | the row's `Priority` | `Mid` |
| Source | `Code` | `Code` |
| Dashboard Section | `Deep Dive` (project ship), `Integration` (MCP/plugin), `Decision` (decision log) | `Deep Dive` |
| Project | best match in the Projects DB | the default generic project |
| Commits | SHAs found in the page (`[0-9a-f]{7,40}`), comma-joined | `""` |
| Writeback URL | the handoff row URL | — |
| Published in Report | `__NO__` | `__NO__` |

**Dedup first:** query the Tracker for `Writeback URL` = the row URL; if a row exists, skip. Then add
a `**Tracker-Row:** <url>` line to the handoff page. `bridge sync` never touches Tracker rows.

---

## Notion MCP notes

- Create rows: `notion-create-pages` with a `data_source_id` parent (not `page_id`, not `database_id`).
- Change status and other properties: `notion-update-page`, `command: update_properties`. Select values
  must match an option exactly. Dates use `date:Date:start`.
- Read: `notion-query-data-sources` (SQL or a view URL), `notion-search` with `data_source_url`,
  `notion-fetch` for full page content.
- HQ text edits: `notion-fetch` renders links as `[text](url)` but Notion stores `<mention-page>`
  tags. End `old_str` before any link or mention, or target plain text near it.
- Transport: Bridge reads and writes use the claude.ai Notion MCP. The `ntn` CLI is for deterministic
  non-Bridge jobs only (see the `notion-cli` skill).

## Safety rules

1. Fetch before you write; return the URL after you write.
2. Only the sender writes a handoff's content; the receiver changes its status.
3. Never delete a handoff row, an Implementation Log entry, or a Key Decisions entry. Close rows with
   a status instead.
4. Never create a new Life Bucket without Dave's explicit instruction.
5. If HQ content is ambiguous or conflicting, ask Dave before writing.

---
*notion-bridge v2.0 | 2026-09-24 | previous: v1.6 (2026-07-03, child pages + HQ one-liners; ntn transport split)*
*References: `references/bridge-schema.md` (HQ section map) · `references/handoff-templates/` (task-brief, write-back, next-session)*
