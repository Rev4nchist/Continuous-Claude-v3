# Notion Platform Spike Report — 2026-07-03

Phase N0 of the approved plan "Notion Platform Integration + Helm Notion-First Pivot"
(`~/.claude/plans/review-ccv3-system-wondrous-cascade.md`). All four spikes ran live against
Dave's workspace (`David Hayes's Notion`, id `a512f781-a8e7-400d-b2e2-b76690fde865`).

## Verdict summary

| Spike | Question | Verdict |
|---|---|---|
| S1 | Can `ntn` install + auth on Windows for interactive AND scheduled use? | **PASS** (headless-task sub-check finalizes in N3 verification) |
| S1b | Can the CLI token actually read our target pages? | **PASS** — no integration-grant ceremony |
| S2 | Is there an agent-writable HTML-block path? | **PASS** — attachment + `<embed>` = sandboxed interactive HTML, private to workspace |
| S3 | Does CLI Markdown round-trip a real complex page losslessly? | **PASS** — byte-identical on the 13 KB Reports duplicate |
| S4 | Does the Projects-DB upsert loop work end-to-end via CLI? | **PASS** — create → filtered query-by-RepoKey → row returned |

## S1 — CLI on Windows

- **Install**: `winget install Notion.ntn` (native x64; the `curl|bash` path is macOS/Linux — Retired premortem finding confirmed by docs). Installed **ntn 0.18.1 (latest)**.
- **Absolute exe path** (for Task Scheduler actions — winget's shim was NOT added as a Links alias):
  `C:\Users\david.hayes\AppData\Local\Microsoft\WinGet\Packages\Notion.ntn_Microsoft.Winget.Source_8wekyb3d8bbwe\ntn-x86_64-pc-windows-msvc\ntn.exe`
- **Auth**: `ntn login` = device-code browser flow (`ntn login` prints URL + verification code → `ntn login poll` waits). Credentials in system keychain; config at `%APPDATA%\notion` (⚠ roaming dir — if `NOTION_KEYRING=0` file auth is ever used, pin `NOTION_HOME` local + ACL per premortem S1c).
- **`ntn doctor` after login**: 6 pass / 1 warn — the warn is **"no Workers access"** (Workers not enabled for this account; the parked Workers charter should note enablement is a prerequisite).
- **PAT nuance**: `ntn api v1/users` → `403 restricted_resource: Personal access tokens cannot list users`. This endpoint is NOT a valid auth probe. Use `ntn doctor` ("Public API authenticated") or a `pages get` on a known page instead.
- Session-shell note: a shell opened before install won't have `ntn` on PATH — use the absolute path or a fresh shell.

## S1b — Page access

- `ntn pages get 38f76fd7…` (CCv3 Reporting Hub) and `30e76fd7…` (Bridge HQ): both returned full page Markdown immediately. The CLI's user-scoped PAT sees what Dave sees — the classic integration-connection grant step does NOT apply.
- Bonus: the returned dialect is the SAME Notion-flavored Markdown the MCP uses (`<table header-row="true"><tr><td>`, `<callout>`, `{toggle="true"}` headings, `<empty-block/>`). One dialect everywhere.

## S2 — HTML "block" write path (the decisive one)

- The authoritative MCP resource `notion://docs/enhanced-markdown-spec` has **no native HTML block type**, but documents the agent path:
  `<embed src="…">` — "renders an HTML attachment file inline in a sandboxed iframe. Always use `<embed>` for HTML attachment files."
- **Proven flow (MCP)**: `notion-create-attachment` (inline HTML string ≤ 200 KiB) → returns `file-upload://<id>` → `notion-update-page` insert `<embed src="file-upload://<id>">` → attachment bound to the page. Verified on the scratch page; CLI read-back shows the persisted attachment-backed embed block.
  - ⚠ Attach within **1 hour** of upload or the temporary upload expires.
  - CLI alternative for larger/binary files: `ntn files create` + File Upload API.
- **Privacy**: the HTML lives as a workspace attachment — no public hosting involved. The premortem's public-Pages leak concern is moot on this path.
- Scratch page for visual confirmation (interactive JS button test): https://app.notion.com/p/39276fd7ac8281c697b8dc65e42168cb
- Sizing: Helm draft files are 66–75 KiB → fit under the 200 KiB inline cap.
- Note: Notion 3.6's *native* "HTML block" (created by Notion Agents in-app) is not exposed in the REST block reference (31 types, no `html`; unsupported types round-trip as `<unknown>`). The attachment+embed path is the agent-available equivalent today.

## S3 — Markdown fidelity on a real page

- Duplicated the real Reports page (`notion-duplicate-page`, async) → `ntn pages get` (13,320 chars) → appended marker → `ntn pages edit --content …` → re-get → **diff: byte-identical** except a trailing-newline artifact. Callouts, HTML tables, links, dividers, bold, emoji all preserved.
- **Two operational traps found live:**
  1. **stdin hang** — `pages edit` with an open-but-empty stdin BLOCKS (it accepts piped content and waits for EOF). First attempt hung 3 min; same command with `</dev/null` completed instantly. ⇒ **every scheduled/automated `ntn` call MUST redirect stdin from NUL** (premortem non-interactive contract, now with a proven mechanism).
  2. **Full-page replace is the slow path** — MCP docs warn resubmitting unchanged content hits async processing limits. For N3, prefer regenerating only the scheduled-tasks section (targeted content update) or keep the job-owned page minimal.
- Implication for N3: `ntn pages edit` full-regeneration is viable for a job-owned page; block-level PATCH (`PATCH /v1/pages/{id}/markdown` exists, plus `/v1/blocks/*`) is available if the page ever gains human-owned sections.

## S4 — Projects DB round-trip

- Created `Helm Projects (spike)` DB via MCP `notion-create-database` with the premortem upsert schema (RepoKey RICH_TEXT as immutable key, Tier/Attention SELECT, Dirty NUMBER, LastCommit DATE). Data source: `9db65090-9349-4dcb-8799-460e34fd9c41`.
- `ntn datasources resolve <db-id>` → data source id. Row created via `ntn api v1/pages` with **stdin JSON** (parent `data_source_id`). Filtered `ntn datasources query --filter '{"property":"RepoKey","rich_text":{"contains":…}}'` returned the row with all properties.
- **Trap found live**: `ntn` inline field syntax parses `C:` in `…content]=C:/Users/…` as a `Header:Value` separator → **always pass real payloads as stdin JSON**, never inline fields.

## Contract rules for all downstream phases (N1 skill + N3/N4 jobs)

1. Absolute exe path in scheduled actions (winget package path above); log `ntn --version` per run; `ntn update`/`winget upgrade` manual-only.
2. Every automated call: stdin `< NUL` (PowerShell: `-RedirectStandardInput NUL` / cmd `< NUL`), hard timeout, fail-loud on nonzero.
3. Payloads via stdin JSON or `--data`; never inline `path=value` fields containing `:` or spaces.
4. Auth probes: `ntn doctor` or `pages get <known-page>`; NOT `v1/users`.
5. HTML publishing: attachment (≤200 KiB) + `<embed src="file-upload://…">`, attach within 1 h.
6. DB writes: resolve `data_source_id` each run; query-by-RepoKey 0/1/>1 → create/update/fail-loud.

## S5 — CLI-only publish path (2026-07-03 PM, card-engine prerequisite)

Question: can `ntn` bind an uploaded HTML file to an **interactive inline `<embed>`** (the S2 mechanism) **without MCP**, so the daily card sweep needs no `claude -p`/MCP dependency? **Verdict: NO — the sweep's publish step must use MCP.**

Live test (all CLI, throwaway child page under the pilot, since trashed):

1. **Upload works, CLI-only.** `ntn files create --json --filename card.html --content-type text/html < card.html` → returns `{id, status:"uploaded", expiry_time:+1h}`. Clean.
2. **`ntn pages create/edit` markdown does NOT interpret `<embed>`.** Feeding `<embed src="file-upload://<id>">` stored it as **literal paragraph text** (round-trips escaped as `\<embed…\>`). The CLI's Markdown writer does not share the MCP enhanced-markdown `<embed>` dialect.
3. **Raw `ntn api` embed block does NOT resolve `file-upload://`.** `PATCH v1/blocks/<page>/children` with `{type:"embed",embed:{url:"file-upload://<id>"}}` created an embed block whose url stayed the **literal, unresolved** `file-upload://…` string → broken embed.
4. **Raw `ntn api` FILE block DOES bind the upload** (the one CLI-only durable path). `{type:"file",file:{type:"file_upload",file_upload:{id:"<id>"}}}` → Notion persists it to a `prod-files-secure.s3…` URL. **But it renders as a download/preview card, not an inline sandboxed iframe** — loses the "living inline card" identity Dave confirmed on the pilot.
5. **Why the MCP embed is durable and the CLI embed isn't.** The pilot's MCP-produced block is `type:"embed"` with a signed S3 url and **no `expiry_time` on the block** — Notion owns the file binding and re-signs on read. The REST `embed` schema is `{embed:{url}}` with **no `file_upload` field**, so raw REST can't hand Notion a binding to refresh; only the MCP markdown layer resolves `file-upload://id` → hosted embed.

**Decision (matches the pre-authorized plan fallback):** the card sweep's assembly, DB reads/writes, file upload, and state are **CLI/Node (zero-LLM)**; only the final *publish* step (bind upload → interactive embed) runs via **headless `claude -p` + MCP `notion-create-attachment` + `update-page`** (proven S2 path). Dependency footprint of the sweep = Node + ntn for everything except one MCP publish call per changed card.

**CLI-only fallback on file (documented, not chosen):** if interactive inline rendering is ever sacrificed, the raw-API **file block** attach (step 4) is a fully-CLI, MCP-free publish that gives a durable one-click-to-open HTML card.

**New contract rule:** `ntn pages trash` (and other destructive verbs) require `--yes` in non-interactive environments (`error: Cannot confirm in a non-interactive environment`). Add `--yes` to the non-interactive contract for any confirm-gated ntn verb.

## Spike artifacts (left in place for review — delete when done)

- Scratch page: `Helm Spike Scratch — 2026-07-03` (39276fd7-ac82-81c6-97b8-dc65e42168cb) — contains the interactive HTML embed to eyeball
- Reports duplicate: `Reports (1)` (39276fd7-ac82-817d-a189-f6cc64fef5dc) — has `MARKER-S3-ROUNDTRIP-OK` at the bottom
- Test DB: `Helm Projects (spike)` (82979e0a-d671-4b23-b3b9-1ab7423e0e30) with one row
