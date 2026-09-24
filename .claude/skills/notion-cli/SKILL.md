---
name: notion-cli
description: Script Notion reads/writes from the CLI (ntn) — API calls, page I/O, DB queries, file uploads. Use when the user says "ntn", "notion cli", "notion api from terminal", or wants to script Notion from Bash/PowerShell. Not for semantic search, view/DB creation, or Bridge ops — use Notion MCP.
---

# Notion CLI (`ntn`)

Native Notion CLI (Developer Platform, 2026). Installed **2026-07-03**, verified on Windows 11.
Spike evidence: `docs/notion-platform-spike-report.md` (continuous-claude repo).

## Install & auth (Windows)

- Install: `winget install Notion.ntn` (native x64). NOT `curl|bash` (that's macOS/Linux). npm alt: `npm i -g ntn` (Node 22+).
- **Absolute exe path** (scheduled tasks MUST use this; winget adds no Links alias):
  `C:\Users\david.hayes\AppData\Local\Microsoft\WinGet\Packages\Notion.ntn_Microsoft.Winget.Source_8wekyb3d8bbwe\ntn-x86_64-pc-windows-msvc\ntn.exe`
- Login: `ntn login` prints a URL + verification code → user approves in browser → `ntn login poll` completes. Credentials in Windows keychain; config `%APPDATA%\notion`.
- Health: `ntn doctor` (the real auth probe). **Do NOT probe with `ntn api v1/users`** — personal access tokens get 403 on it by design.
- Page access: the user-scoped token sees everything Dave sees — no integration-connect grants needed.
- Env for automation: `NOTION_API_TOKEN` (overrides keychain), `NOTION_WORKSPACE_ID`, `NOTION_KEYRING=0` (file auth — if used, pin `NOTION_HOME` to a LOCAL non-roaming dir + ACL-restrict; default config dir is roaming).
- Updates are MANUAL only for job stability: `winget upgrade Notion.ntn`. Jobs log `ntn --version` per run (0.18.1 at integration).

## The non-interactive contract (hard rules for every scripted call)

1. **stdin `< NUL`** (`</dev/null` in bash) — `ntn` reads piped content when stdin is open and will HANG waiting for EOF (proven live: `pages edit` blocked 3 min, instant with stdin closed).
2. Hard timeout on every call; nonzero exit = fail loud, never retry-loop silently.
3. Payloads via **stdin JSON** or `--data` — never inline `path=value` fields whose value contains `:` or spaces (the parser reads `C:` as a `Header:Value` separator).
4. `--json`/`--plain` for machine-readable output; absolute exe path; `--yes` where supported.

## Command crib

```bash
NTN=".../ntn.exe"   # absolute path above

# API (httpie-style; GET default, body => POST, -X to override)
"$NTN" api ls                                   # list endpoints
"$NTN" api v1/pages/<id> </dev/null             # GET
"$NTN" api v1/pages </dev/null <<'EOF'          # POST body via stdin JSON (canonical)
{ "parent": {"data_source_id": "..."}, "properties": { ... } }
EOF
"$NTN" api "v1/pages/<id>/markdown" --spec -X PATCH   # inspect any endpoint schema
# syntax: field=str  field:=json  query==val  Header:Value  (avoid for real payloads)

# Pages — Markdown I/O (same Notion-flavored dialect as the MCP: <table><td>, <callout>, toggles)
"$NTN" pages get <id> </dev/null                # full page as Markdown (+ --json)
"$NTN" pages create --parent page:<id> --content "<md>"
"$NTN" pages edit <id> --content "<md>"         # FULL-PAGE replace; byte-identical round-trip proven
                                                # --allow-deleting-content gates child-page deletion
"$NTN" pages trash <id> --yes                   # destructive — confirm first (rule)

# Data sources (databases)
"$NTN" datasources resolve <database-id>        # -> data_source_id
"$NTN" datasources query <ds-id> --filter '{"property":"RepoKey","rich_text":{"contains":"..."}}'

# Files (larger/binary uploads; MCP create-attachment covers <=200KiB text)
"$NTN" files create < file.html
"$NTN" files list

# Diagnostics
"$NTN" doctor        # auth/keychain/network/config health
```

## CLI vs MCP decision table

| Task | Use | Why |
|---|---|---|
| Scheduled/deterministic reads & writes (job-owned pages, DB upserts) | **ntn** | No LLM in the loop, no quota, seconds not minutes |
| Full-page Markdown get/regenerate | **ntn** (`pages get/edit`) | Proven lossless round-trip |
| Section edits by selection string, small targeted diffs | **MCP** (`notion-update-page` update_content) | Search-and-replace semantics; full replace is the slow path |
| Semantic search, meeting notes, comments | **MCP** | No CLI equivalent |
| Create databases, views (dashboard/chart), SQL across sources | **MCP** | `create-database`/`create-view`/`query-data-sources` are MCP-only |
| Publish interactive HTML (≤200 KiB) | **MCP** `create-attachment` → `<embed src="file-upload://…">` | The agent HTML-block path; attach within 1 h; renders sandboxed iframe, JS runs |
| Bridge HQ / queue operations | **MCP** per notion-bridge skill | Battle-tested selection-string conventions; do not migrate |
| Row upserts into a known data source | **ntn** (`api v1/pages` stdin JSON) | Resolve `data_source_id` each run; query-by-key 0/1/>1 → create/update/fail-loud |

## HTML publishing pattern (the "HTML block" for agents)

1. MCP `notion-create-attachment` with inline HTML (≤200 KiB) → returns `file-upload://<id>` (temporary — attach within 1 hour).
2. Page write includes `<embed src="file-upload://<id>">Caption</embed>`.
3. Notion renders the attachment inline in a **sandboxed iframe — interactive, JS executes**, private to the workspace.
Notion 3.6's native in-app HTML block is not in the public REST API (31 block types, no `html`); this attachment+embed path is the agent-available equivalent.

## Workers — PARKED charter (build nothing yet)

Hosted TS runtime in Notion's sandbox: `ntn workers new/deploy/exec`, scheduled **syncs**, webhooks, encrypted env, runs/logs. **Cannot see the local disk** — never a replacement for local collectors. Account currently has **no Workers access** (`ntn doctor` warning) — enablement is a prerequisite. Candidate future uses: (1) webhook that notifies when Eve writes to the Code queue; (2) weekly rollup sync over the Helm Projects DB; (3) OAuth-connected tools. Revisit after Helm v0 ships.

## Known workspace IDs (safety rule references these)

Bridge HQ `30e76fd7ac8281e99fe1c0b257088b34` · Reports hub `38f76fd7ac8280478e50dd2956ba6e8a` · Bridge Archive `30e76fd7ac8281258cd9d281aa873298` — mutating any of these via `ntn` is confirm-first (see `.claude/rules-ondemand/notion-cli-safety.md`).

## Report Runs registry — the report-history spine

Every scheduled report (VP Weekly, FourthOS Sponsor, Team Dashboard, System Health, Project Portfolio, Self-Improvement) upserts one **append-all-attempts** row into the **Report Runs** database. This is the uniform history surface for both humans (Notion views under the Reports hub) and AI — prefer it over per-pipeline file globs when you need "what did report X do recently / did it fail".

- **DB** `4e4c9460-8818-4352-a056-88badbaa94ce` · **data source** `c7d2d9e3-d388-4640-a66e-88f7dd50f854` (child of the Reports hub). All IDs (DB + DS + 6 child pages + 7 views) pinned in `scripts/report-registry/report-runs.ids.json`.
- **AI history read (deterministic, no LLM):** `"$NTN" datasources query c7d2d9e3-d388-4640-a66e-88f7dd50f854 --json` then filter by the `Report Type` select and sort `Run Date` desc. Row shape: `{Report Run, Run ID, Report Type, Run Date, Period, Status, Artifact URL, Docx/Deck, Summary, Source}`. Run ID = `<type>|<period>|<ISO-ts>` (unique per run).
- **Writes are job-owned** (see `notion-cli-safety.md`): pipelines upsert via `scripts/report-registry/upsert.mjs` keyed by unique Run ID; humans read the views, don't hand-edit rows. `check-drift.mjs` flags any report type with no fresh row.

## `ntn api` — Notion 2025-09-03 specifics (learned in practice, 2026-07-06)

`ntn` has no `create-database`/`create-view` verb, but raw `ntn api` reaches the REST API. Pin `NOTION_API_VERSION=2025-09-03` (already done in `scripts/project-cards/lib/notion.mjs`). Introspect any endpoint with `ntn api <path> --spec`.

- **Create a database (data-source model):** `ntn api v1/databases -X POST -d @body.json`. Body = `{parent:{type:"page_id",page_id}, title:[…], initial_data_source:{properties:{…}}}` — the column schema lives under **`initial_data_source.properties`** (NOT flat top-level `properties` like the old API). Response returns the `database.id` AND `data_sources:[{id}]` — persist **both** (the DS id for row upserts, the DB id for view repair). `ntn datasources resolve <db-id>` also yields the DS id.
- **Create a row:** `ntn api v1/pages -X POST` with `parent:{type:"data_source_id", data_source_id}`.
- **Trash a row/page:** PATCH `v1/pages/<id>` with `{"in_trash":true}` — the field is **`in_trash`, NOT `archived`** (2025-09-03 rejects `archived` with a 400).
- **Views are MCP-only** (`notion-create-view`) — a raw `ntn api` can create the DB but not its linked views; do views in a connector-live `claude -p` (`ANTHROPIC_API_KEY` unset). Filtering a linked view by a **select** property works; relation-property filters may not be settable via MCP.
- **`url`-typed properties reject non-URLs** (a Windows path → 400 that drops the whole write). Guard: only set a `url` property when the value matches `^https?://`, else omit it.

## HTML embeds are sandboxed → non-self-contained pages render degraded

`create-attachment` + `<embed>` renders in a **sandboxed iframe with no base URL**. HTML that pulls **external CDN assets** (Google Fonts, Alpine.js, chart libs) may render **degraded or broken** (functional JS like Alpine especially). Before embedding a deck, check for external `<link>`/`<script src>`; if it's not self-contained, **prefer link-only** to the live hosted page over a broken inline preview. Fonts-only degrade gracefully (fallback); functional CDN JS does not. This is the `notion-dashboard` size-gate's link-only fallback, correctly triggered by *self-containment*, not just size.
