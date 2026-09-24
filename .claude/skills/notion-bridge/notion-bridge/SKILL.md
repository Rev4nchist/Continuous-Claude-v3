---
name: notion-bridge
description: Read/write the Bridge HQ page and handoff queues between Eve, Donna, and Claude Code. Use when the user says "update the bridge", "handoff to Code", "bridge sync", or "what's in the queue".
---

# Notion Claude Bridge Skill
## v1.7 | 2026-09-24 | Handoffs database replaces child pages + HQ one-liners (was v1.6 ntn transport split)

This skill governs all read/write operations on the Claude Bridge system — the shared knowledge and communication layer between Claude.ai (Eve), Claude.ai (Donna), and Claude Code. Always load `references/bridge-schema.md` before any write operation.

---

## System Architecture

```
Claude.ai (Eve) <──── Notion Claude Bridge ────> Claude Code
     |                         |                       |
Personal strategic       HQ Knowledge Page        Execution layer
Ideas, decisions,        (shared memory)          Builds, implements,
project direction              |                  writes back results
                    Claude Bridge Bucket
Claude.ai (Donna)  (Projects + Tasks)
     |                        |
Work strategic         Claude Bridge Archive
Fourth AI projects     (completed sprints, swept on bridge sync)
SPARK, RFP, etc.
```

---

## ⚠️ Hardcoded IDs — Never Deviate

| Resource | ID / URL |
|----------|----------|
| **Claude Bridge Bucket** | Page ID: `30e76fd7-ac82-81e1-b30e-d170600896a7` |
| **Claude Bridge HQ Page** | `https://www.notion.so/30e76fd7ac8281e99fe1c0b257088b34` |
| **Claude Bridge Archive** | `https://www.notion.so/30e76fd7ac8281258cd9d281aa873298` |
| **Life Buckets DB** | `9ec76fd7-ac82-8342-8bc3-87129f7cf1dc` |
| **Projects DB** | `33b76fd7-ac82-8234-a202-8719384ac5b1` |
| **Tasks DB** | `c3176fd7-ac82-825c-a03c-073837e5493c` |
| **AI Enablement Weekly Work Tracker DB** | `3d7f2afd6c5046748408e4412a5552b2` |
| **Tracker data_source_id (for creates)** | `6e8d9b17-f8ef-4d56-9f13-00344650ac03` |
| **Default "AI Enablement (generic)" project** | `34b76fd7-ac82-8104-82ca-df3e801695c0` |
| **📬 Handoffs DB (canonical handoffs)** | `ea95daf2b1a24ddabbe64f6d056c9346` |
| **Handoffs data_source_id** | `13b919c8-b7af-4609-b4c6-87e5504809f0` |
| **Implementation Log — Full History** | `3e576fd7ac8281889efdee0a5447c627` |

---

## Transport & Tooling (updated 2026-07-03)

**Bridge writes stay on the Notion MCP.** All Bridge reads/writes (HQ queues, Implementation Log, Sprint State, Tracker mirror) use the `claude.ai Notion` MCP — its enhanced-markdown and selection-string semantics are what the bridge-schema `<td>` tables and page-mention handling depend on. Do NOT migrate bridge writes to the `ntn` CLI without a fresh fidelity spike: selection strings resolve differently (MCP renders links as `[text](url)` while Notion stores `<mention-page/>` XML), so a naive `ntn` swap will break section-targeted edits.

**`ntn` CLI is for deterministic NON-bridge jobs** — scheduled dashboard/digest pushes, Projects-DB upserts, and the living project cards (`scripts/project-cards/`). See the `notion-cli` skill + `notion-cli-safety` rule for the non-interactive contract (absolute exe, stdin from NUL, stdin-JSON payloads, `--yes` on destructive verbs).

**MCP toolset is now 18+** (was 14): added `notion-create-attachment`, `create-view` (incl. dashboard type), `update-view`, `query-data-sources` (SQL), `query-database-view`, `query-meeting-notes`, `duplicate-page`, `move-pages`, `update-data-source`, `get-async-task`.

**HTML publishing path (spike S2):** `notion-create-attachment` (HTML string ≤ 200 KiB) → insert `<embed src="file-upload://<id>">` → renders as a sandboxed interactive iframe, private to the workspace; attach within 1 hour of upload. The native 3.6 "HTML block" is not exposed in the REST API — attachment + `<embed>` is the agent-available equivalent.

---

## Three-Instance Model

- **Eve (Claude.ai, personal):** Strategic layer — captures ideas, decisions, project direction. Buckets: Claude Bridge, X Research, Minions
- **Donna (Claude.ai, Fourth business):** Work strategic layer — Fourth AI projects, SPARK, RFP, Microsoft AI, competitive intel. Bucket: Fourth AI only
- **Claude Code (CLI):** Execution layer — reads context from HQ, builds accordingly, writes implementation notes back. Operates across all buckets
- **Separation:** Enforced by queue ownership, not page access. Eve never writes to Donna's queues; Donna never writes to Eve's queues.

---

## The Two-Layer System

### Layer 1: Claude Bridge Bucket (Action Layer)
Standard Notion Projects + Tasks, scoped to the Claude Bridge bucket.
- **Projects** = active inter-Claude initiatives
- **Tasks** = discrete handoffs, action items, things one Claude passes to the other

Follow all standard notion-task-manager API rules:
- Relations set in separate update call (never on creation)
- Priority: `High` / `Mid` / `Low` — never `Medium`
- Task title field: `Task` | Project title field: `Project`

### Layer 2: Claude Bridge HQ Page (Knowledge Layer)
Rich Notion page at the URL above. This is where context, decisions, and implementation notes live. Always reference `references/bridge-schema.md` for the exact section structure before writing.

---

## Handoff Format v3: the 📬 Handoffs database (2026-09-24) — CANONICAL

**Supersedes v2 below.** Every handoff is ONE row in the 📬 Handoffs database on Bridge HQ. The row's
page holds the full handoff (the v2 templates still describe the body). HQ queue sections are gone:
each queue is a view of the database, so nothing is copied into HQ by hand. v2's double write (child
page + HQ one-liner) left 14 Eve→Code handoffs with no queue line; v3 cannot drift that way.

| Property | Values |
|---|---|
| `Handoff` (title) | `[From→To] Title — YYYY-MM-DD` |
| `From` | Eve, Donna, Code, Dave |
| `To` | Code, Eve, Donna, Next session |
| `Status` | Pending, In progress (work) · Unread, Read (write-backs) · Done · Superseded |
| `Priority` | High, Mid, Low |
| `Date` | `date:Date:start` = YYYY-MM-DD |
| `Summary` | one sentence |
| `Project`, `Repo` | optional text |
| `Outcome`, `Resume phrase` | session handoffs (To = Next session) only |

Views (tabs on the database, shown inline on HQ): 📥 For Code (To = Code, Pending/In progress),
📤 For Eve and 📤 For Donna (Unread), 🔁 Next session, ✅ Closed.

**Create:** `notion-create-pages` with parent `{"type":"data_source_id","data_source_id":"13b919c8-b7af-4609-b4c6-87e5504809f0"}`,
properties per the table, body from the matching template. **Read a queue:** `notion-query-data-sources`
SQL on `collection://13b919c8-b7af-4609-b4c6-87e5504809f0` (e.g. `"To"='Code' AND "Status" IN ('Pending','In progress')`).
**Find by title:** `notion-search` with that `data_source_url`. **Close:** `notion-update-page`
`update_properties` → Status Done (work) or Read (write-back). Never edit HQ text to change a status.
The Tracker auto-mirror for Code write-backs still applies. Session handoffs (`/create_handoff`) are
rows with To = Next session; never put them in Dave's Scratchpad.

---

## Handoff Format v2: Child Pages + HQ One-Liners (SUPERSEDED 2026-09-24 by v3 above)

*Kept for history and for the page-body templates. Do not write HQ one-liners or create HQ child pages for handoffs.*

Every handoff is two things:

1. **A child Notion page** — the full handoff content as structured Markdown. Rich, complete, designed for easy human reading and AI parsing. Created as a child of Bridge HQ page (`30e76fd7-ac82-81e9-9fe1-c0b257088b34`).
2. **A one-liner entry in HQ** — status emoji + title + Notion link + one sentence summary. Nothing else in the HQ queue body.

### HQ One-Liner Format

```
[emoji] [HANDOFF] YYYY-MM-DD — [Title] → [Child Page Title](notion-url)
	From: [Source] | Priority: [High/Mid/Low] | [One sentence summary]
```

Example:
```
[HANDOFF] 2026-02-22 — /codex-review Skill Setup → [Eve→Code] /codex-review Setup — 2026-02-22](url)
	From: Eve | Priority: High | Install Codex CLI + create skill file
```

### Child Page Naming Convention

Child page titles always include queue direction:
- `[Eve→Code] Title — YYYY-MM-DD`
- `[Code→Eve] Title — YYYY-MM-DD`
- `[Donna→Code] Title — YYYY-MM-DD`
- `[Code→Donna] Title — YYYY-MM-DD`

This makes queue ownership unambiguous even though all child pages sit at the same HQ child level.

### Child Page Templates

Templates live at `references/handoff-templates/`:
- `eve-to-code.md` — Task brief (Eve passing work to Code)
- `donna-to-code.md` — Task brief (Donna passing work to Code)
- `code-to-eve.md` — Implementation summary (Code writing back to Eve)
- `code-to-donna.md` — Implementation summary (Code writing back to Donna)

### Status Sync Rule

**Both locations stay in sync.** The emoji on the HQ one-liner must match the Status field in the child page header. When status changes (Pending → In Progress → Done), update BOTH:
- The emoji prefix on the HQ one-liner
- The `**Status:**` field in the child page header block

### Status Values

| Queue Direction | Values |
|----------------|--------|
| Eve/Donna → Code | Pending, In Progress, Done |
| Code → Eve/Donna | Unread, Read (surfaced to Dave) |

---

## Core Workflows

> **v3 (2026-09-24):** where a workflow below says "create a child page under Bridge HQ" + "insert an HQ one-liner", do ONE thing instead: create a row in the 📬 Handoffs database (see "Handoff Format v3"). Where it says to read a queue section, query the database. Status changes are property updates, never HQ text edits.

### Eve Writing a Handoff to Claude Code
```
1. notion-fetch: Claude Bridge HQ page (read current state)
2. Identify appropriate section:
   - Tactical work item → Handoff Queue: Eve → Code
   - Strategic decision → Key Decisions Log
   - Context shift → Active Context
3a. notion-create-pages: Create child page under Bridge HQ with full handoff content (use eve-to-code template)
3b. notion-update-page: Insert HQ one-liner into Eve → Code queue section (insert_content_after targeting section blockquote)
4. Optionally: create a Task in Claude Bridge Bucket as action trigger
5. Report back to Dave with HQ page URL
```

### Donna Writing a Handoff to Claude Code
```
1. notion-fetch: Claude Bridge HQ page (read current state)
2. Identify appropriate section:
   - Tactical work item → Handoff Queue: Donna → Code
   - Business decision → Key Decisions Log
3a. notion-create-pages: Create child page under Bridge HQ with full handoff content (use donna-to-code template)
3b. notion-update-page: Insert HQ one-liner into Donna → Code queue section (insert_content_after targeting section blockquote)
4. Optionally: create a Task in Claude Bridge Bucket as action trigger
5. Report back to Dave with HQ page URL
```

### Claude Code Reading Handoffs
```
1. notion-fetch: Claude Bridge HQ page
2. Read: Active Context + Handoff Queue: Eve → Code + Handoff Queue: Donna → Code
3. For each pending item: notion-fetch the linked child page for full spec
4. Execute the work
5. Write back to the appropriate Code → [requester] queue (see below)
6. Add to Implementation Log after completion
7. Update Sprint State callout if status changed
```

### Claude Code Writing Back
```
1. notion-fetch: Claude Bridge HQ page (read current)
2. notion-create-pages: Create child page under Bridge HQ with implementation summary (use code-to-eve or code-to-donna template)
3b. Mirror to Weekly Work Tracker (auto-mirror): Before inserting the HQ one-liner, also create a Tracker row in the AI Enablement Weekly Work Tracker database. This feeds /weekly-report at report time. See "Auto-Mirror Protocol" below for field mapping + dedup rules.
4. notion-update-page: Insert HQ one-liner into appropriate Code → [requester] queue section
5. notion-update-page: Add entry to Implementation Log
6. Update Sprint State callout(s) if applicable
```

### Eve Reading Claude Code's Work
```
1. notion-fetch: Claude Bridge HQ page
2. Read: Handoff Queue: Code → Eve — check for one-liners
3. For each unread item: notion-fetch the linked child page for full details
4. Surface relevant items naturally in Dave conversation
5. Clear/archive queue items after surfacing (or mark as read)
```

### Donna Reading Claude Code's Work
```
1. notion-fetch: Claude Bridge HQ page
2. Read: Handoff Queue: Code → Donna — check for one-liners
3. For each unread item: notion-fetch the linked child page for full details
4. Surface relevant items naturally in Dave conversation
5. Clear/archive queue items after surfacing (or mark as read)
```

### Bridge Sync (Dave types "bridge sync")
```
1. notion-fetch: Claude Bridge HQ page (full read)
2. Audit all sections for staleness
3. Auto-sweep completed items:
   - Move DONE handoff queue one-liners → Archive subpage
   - Sweep Done sprint callouts + detail lines → Archive subpage
   - Archive uses reverse-chronological sprint blocks (narrative + Lessons field)
4. Update Active Context to reflect current reality
5. Update Sprint State (remove swept callouts)
6. Report summary to Dave: what's current, what's stale, what needs action
```

### Archive Lookup (looking for past work)
```
1. notion-fetch: Claude Bridge Archive page
2. Search for the relevant sprint block or handoff
3. Archive URL: https://www.notion.so/30e76fd7ac8281258cd9d281aa873298
```

---

## Auto-Mirror Protocol: Every Code→{Eve,Donna} Writeback Creates a Tracker Row

After every Code-direction writeback child page, create one row in the **AI Enablement Weekly Work Tracker** DB. The Tracker is the structured data layer `/weekly-report` pulls from; Bridge remains the narrative + communication layer.

### Field mapping (child page → Tracker row)

| Tracker property | Source in child page | Default if absent |
|---|---|---|
| Title | Child page title with `[Code→X]` prefix and `— YYYY-MM-DD` suffix stripped | — |
| Date | Today (UTC) | — |
| Type | Infer from child page Type field OR title keywords (fix→Fix, feat→Feature, rebuild→Fix, integrate→Integration, deploy→Deploy, else Ship) | `Ship` |
| Impact | Parse **Priority:** line (`High`→`High`, `Mid`→`Mid`, `Low`→`Low`) | `Mid` |
| Source | Always `Code` (these are Code writebacks) | `Code` |
| Dashboard Section | `Deep Dive` for project ships; `Integration` for MCP/plugin work; `Decision` if the child page is a decision log | `Deep Dive` |
| Project | Best-effort match against Projects DB by title keyword | Default "AI Enablement (generic)" row |
| Commits | Extract SHAs from `**Commits:**` field via regex `[0-9a-f]{7,40}`, comma-joined | `""` |
| Writeback URL | URL of the child page just created | — |
| Published in Report | `false` | `false` |

### Dedup guard (CRITICAL — prevents duplicate rows)

Before creating a Tracker row, query Tracker filtered on `Writeback URL == <child_page_url>`. If a row already exists, skip the create and log `SKIP_DUP` — this makes the auto-mirror idempotent. The server-side helper `find_existing_by_writeback_url` in `ai-reporting-mcp/collectors/tracker_collector.py` does this; from a Notion MCP session, query via `notion-query-database-view` or `notion-search` scoped to the Tracker data source with the Writeback URL as the filter value.

### Creating the row

Use `notion-create-pages`:
- `parent.type` = `data_source_id`
- `parent.data_source_id` = `6e8d9b17-f8ef-4d56-9f13-00344650ac03`
- `properties` map per the table above
- Relation format: `"Project": "[\"https://www.notion.so/<project-page-id>\"]"`
- Select format: plain string matching option name
- Checkbox: `"__NO__"` for false
- Date: expanded `"date:Date:start": "YYYY-MM-DD"`

### After row creation

Update the child page itself to add a `**Tracker-Row:**` field pointing to the new Tracker row URL. Use `notion-update-page` with `command: "update_content"` and insert the line after the existing header fields. This closes the traceability loop: from Bridge child page → Tracker row and back.

### When the user says "bridge sync"

Bridge sync currently sweeps completed Bridge queue items + sprint callouts to Archive. It does NOT touch Tracker rows. Tracker rows stay live until `/weekly-report` Phase 5 marks them `Published in Report`. Do not delete Tracker rows during bridge sync.

---

## Writing Rules for HQ Page

### Always:
- Fetch the page first before writing — never write blind
- Add new Decision Log entries at the **top** of the section (newest first)
- Add new Implementation Log entries at the **top** (newest first)
- Include date stamps on all log entries (YYYY-MM-DD format)
- Keep HQ queue entries as one-liners only — full content goes in child pages

### Never:
- Overwrite the other Claude's entries without reason
- Delete Implementation Log history
- Edit Dave's manual additions without his instruction
- Write to Active Context without confirming it's actually still current
- Write long-form handoff content directly into HQ queue sections (use child pages)
- Eve: never write to Donna's queue sections
- Donna: never write to Eve's queue sections

### Section Update Triggers:
| Event | Section to Update |
|-------|-----------------|
| Dave makes architectural decision | Key Decisions Log |
| Eve passing work to Code | Handoff Queue: Eve → Code (child page + one-liner) |
| Donna passing work to Code | Handoff Queue: Donna → Code (child page + one-liner) |
| Code completing work for Eve | Handoff Queue: Code → Eve (child page + one-liner) + Implementation Log |
| Code completing work for Donna | Handoff Queue: Code → Donna (child page + one-liner) + Implementation Log |
| Any Code→{Eve,Donna} writeback | Tracker row via auto-mirror + child page `**Tracker-Row:**` field |
| Overall project focus shifts | Active Context |
| Sprint milestone hit | Current Sprint State |
| Bridge sync requested | Auto-sweep completed items to Archive, then audit all sections |
| Looking for past work | Fetch Archive page (not HQ) |

---

## HQ Page Section Reference

Load `references/bridge-schema.md` for the full section map with exact selection strings for `replace_content_range` and `insert_content_after` operations.

---

## Safety Rules

1. Always fetch HQ page before writing — read current state first
2. Never delete Implementation Log entries
3. Never create a new Life Bucket without Dave's explicit instruction
4. Always return the HQ page URL after any write operation
5. If HQ page content is ambiguous or conflicting — ask Dave before writing
6. Handoff Queue items should be cleared/marked after the receiving Claude has acted on them
7. When queues are empty, they show: `*Queue clear — no pending items. Completed handoffs in Claude Bridge Archive.*`
8. To add to an empty queue, use `insert_content_after` targeting the section blockquote intro line

---

## Claude Code-Specific API Notes

Claude Code uses the `claude.ai Notion` cloud MCP server (streamable-http). The rendering behavior differs from Claude.ai's native Notion integration. These rules apply ONLY to Claude Code sessions.

### 1. Selection Strings Must Avoid Link/Mention Syntax

`notion-fetch` renders page links as markdown: `[Page Title]({{url}})`. But Notion internally stores them as `<mention-page url="..."/>` XML tags. **Selection strings that include rendered link text will fail.**

| What you see in fetch output | What Notion stores internally |
|------------------------------|-------------------------------|
| `[Claude Bridge Archive]({{url}})` | `<mention-page url="..."/>` |
| `*Completed handoffs in [Archive](...).*` | `*Completed handoffs in <mention-page .../>.*` |

**Rule:** End selection strings BEFORE any link/mention text. Use the surrounding plain text instead.

```
WRONG: selection_with_ellipsis: "Queue clear...in Claude Bridge Archive.*"
RIGHT: selection_with_ellipsis: "Queue clear...no pending items.*"
   OR: Target the section header/blockquote instead
```

### 2. Prefer `insert_content_after` Over `replace_content_range`

When a section contains page mentions or links, `replace_content_range` selection strings are fragile. Use `insert_content_after` targeting the section header or blockquote intro instead.

| Scenario | Preferred Command | Target |
|----------|-------------------|--------|
| Add handoff one-liner | `insert_content_after` | Section blockquote intro line |
| Add log entry | `insert_content_after` | Section blockquote intro line |
| Update sprint callout | `replace_content_range` | Safe -- callouts have no mentions |
| Update Active Context | `replace_content_range` | Safe -- plain text section |

### 3. Sprint State Uses Callout Blocks, Not Tables

Tables are dead. Notion silently strips Markdown pipe tables and HTML table replacements are fragile. **Sprint State uses callout blocks instead.**

Each sprint item is a callout block + a plain text detail line:
```
::: callout
[emoji] **[Task name]** | Owner: [name] | Status: [status]
:::
[One line of supporting detail]
```

**Rules:**
- ALWAYS use callout blocks for Sprint State — never tables, never Markdown pipes, never raw HTML
- Status emoji goes FIRST in the callout headline, before the task name
- Detail line sits OUTSIDE the callout as a plain text line immediately below
- To add a new sprint item: `insert_content_after` targeting the last detail line in the section
- To update status: `replace_content_range` targeting the callout headline (safe — no links/mentions in callouts)
- On `bridge sync`: sweep Done callouts + their detail lines to Archive

### 4. Handoff Queue Hygiene (v2 — Child Page Format)

Handoff queues in HQ contain **one-liners only**. Full content lives in child pages.

**Creating a handoff (two-step process):**
1. `notion-create-pages` — Create child page under Bridge HQ page ID (`30e76fd7-ac82-81e9-9fe1-c0b257088b34`) using appropriate template from `references/handoff-templates/`
2. `notion-update-page` — Insert one-liner into correct queue section via `insert_content_after` targeting the section blockquote intro

**Child page naming:** `[Queue] Title — YYYY-MM-DD` (e.g., `[Code->Donna] Bridge Format v2 Shipped — 2026-02-22`)

**Status sync:** Update emoji in BOTH the HQ one-liner AND the child page Status field when status changes.

**Don't delete completed entries** — leave them for the receiving Claude to sweep on `bridge sync`.

**Empty queue state:** `*Queue clear — no pending items. Completed handoffs in Claude Bridge Archive.*`

### 5. Practical Workflow for Claude Code

```
1. notion-fetch: Read HQ page (always first)
2. Identify target section from bridge-schema.md
3. For handoff queues:
   -> notion-create-pages: Create child page with full content (use template)
   -> notion-update-page: Insert one-liner via insert_content_after targeting blockquote
4. For sections WITHOUT links (Active Context, sprint callouts):
   -> replace_content_range is safe
5. After ANY write: verify by re-fetching if critical
```

### 6. Error Recovery

If a `notion-update-page` call fails with selection mismatch:
1. Re-fetch the page to see current rendered content
2. Shorten the selection string -- end BEFORE any `[link](url)` text
3. Switch to `insert_content_after` if `replace_content_range` keeps failing
4. Target a broader anchor (section header) rather than specific content

---

*notion-bridge v1.6 | 2026-07-03 | ntn transport split + expanded toolset (prev v1.5 Tracker auto-mirror, v1.4 three-instance model)*
*Reference: bridge-schema.md for HQ page section map | handoff-templates/ for child page templates*
