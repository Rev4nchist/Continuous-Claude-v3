---
name: notion-dashboard
description: Build and refresh machine-maintained Notion dashboard pages with HTML embeds and DB views. Use when the user says "notion dashboard", "mobile cockpit", "refresh mobile cockpit", or wants a new auto-refreshed Notion page.
---

# Notion Dashboard (machine-refreshed pages)

## The two-phase publish pattern (proven — do not fight it)

| Capability | Tool | Notes |
|---|---|---|
| Page create, markdown sections, tables, callouts | `ntn` CLI (deterministic) | Block-level `ntn api` PATCH only — **never `ntn pages edit` full-page replace** on a page holding embeds/views (they don't round-trip; destroys them) |
| Interactive HTML `<embed>` bind | Notion MCP only | `notion-create-attachment` (≤200 KiB) → `notion-update-page` with `<embed src="file-upload://id">`; **attach within 1 hour, upload+bind in ONE MCP prompt**. Headless: `env -u ANTHROPIC_API_KEY claude -p --allowedTools "mcp__claude_ai_Notion__*"` |
| Linked DB views | Notion MCP only (`create-view`) | Filters on relation properties may not be settable via MCP — a manual in-app filter tweak can be the honest fallback |
| DB queries | `ntn datasources query` / `queryDataSource` | Walk `next_cursor` to exhaustion; pin `NOTION_API_VERSION=2025-09-03` (enables `after` on children PATCH; avoids per-call spec fetch 403s) |

## Section-ownership contract

Machine-owned sections are replaced by heading match; human sections are NEVER touched. Publisher must:
1. Use block-level splice (`replaceSectionBlocks` in `scripts/project-cards/lib/notion.mjs`) — heading → next same-or-higher heading.
2. Read back the page after an MCP embed bind and verify the embed exists under the heading BEFORE advancing published state (never trust the model's self-reported success marker alone).
3. Never feed page content into the MCP prompt (prompt-injection surface via human sections) — instruct by heading string only.
4. Demote inner `##` in machine markdown to `###` so digests can't corrupt splice boundaries.

## FourthOS Mobile Cockpit (reference instance)

- Page: `39376fd7-ac82-817e-b2b7-faa3da23078c` (child of Daily Cockpit `34076fd7…2c47`), workspace-private.
- Sections: intro callout (machine) · `## 🚨 Attention Queue` embed (machine) · `## ✅ Act now` native views (setup-owned) · `## 🤖 AI digest (machine-written)` markdown mirror so **Notion AI can answer questions** (it cannot read embeds) · `## 📓 Capture` (human — sweep never touches).
- Engine: `scripts/project-cards/` — `lib/queue.mjs` (single ranked queue) → `mobile-brief.mjs` (HTML) + `lib/digest.mjs` (markdown). Single source of truth: embed and digest can never disagree.
- Refresh: CCv3-Project-Cards task, daily 07:45 + 17:45. On-demand: `node scripts/project-cards/sweep.mjs --target mobile-cockpit` (that IS the "refresh mobile cockpit" command). Whole sweep holds `.sweep.lock` (30-min stale) — concurrent runs exit 0.
- Per-step status in `logs/sweep.jsonl` (`mobileCockpit: {digestStatus, embedStatus, contentHash, runId, failureCode}`); digest write is independent of the embed bind, so the page stays AI-answerable when MCP flakes. Rollback: `out/mobile-cockpit.html.prev` + `prevAttachmentId` in state.

## Capture triage (PM Portal layer, added 2026-07-04)

The Mobile Cockpit is also a PM portal: lines jotted under `## 📓 Capture` are filed by a **deterministic regex triage** (`lib/triage.mjs` — capture text is UNTRUSTED and never reaches an LLM/MCP prompt; it may appear escaped + 60-char-capped in receipts/digest as data).

**Grammar:** `t `/`todo:` task · `n `/`note:`/bare note · `i `/`idea:` idea · `later:` resurfaces after `PM_NOTES_AGE_DAYS` (default 3, env-overridable) · `b:`/`blocker:` surfaces immediately · `d `/`decision:` decision · leading `? ` question · `//` or `#` scratch (never touched). Modifiers: `@alias` (capture-aliases.json → Projects row), `!p1-3`, `due:today|tomorrow|mon..sun|YYYY-MM-DD|+Nd`. Unparseable/rich/multi-line/foreign-actor lines are left in place and flagged in the receipt.

**Section ownership (revised):** intro callout, Attention Queue embed, AI digest, Triage log = machine. Act now + Notes views = setup-owned. Capture = human writes / **triage consumes only lines it fully parsed AND filed** (create-then-persist-then-verify-then-delete; conflict-checked against `last_edited_time` before every delete; every consuming run writes a receipt, last 10 kept).

**Safety rails:** CaptureId stamp on every created row (duplicate guard + ID-exact UAT cleanup) · replay-hash ring (blockId+date) · actor allowlist (`TRIAGE_ACTOR_ALLOWLIST`) · `--target triage` exits 3 on failure, lock-skip logs `skipped:'lock'` · setup registry in `state.json.mobileCockpit.setup`.

**Refresh:** triage runs FIRST in every sweep (07:45/17:45) and via `node scripts/project-cards/sweep.mjs --target triage` ("refresh mobile cockpit" also works). UAT: `experiment/uat-triage.mjs` (nonce'd scenarios, logs/uat.jsonl).

## Building a NEW machine-refreshed page (checklist)

1. Create page via `ntn pages create --parent page:<id>` with the section skeleton (first `#` line becomes the page TITLE, not a block — intro updates must target the callout).
2. Verify `public_url: null` (sharing audit) after creation.
3. Create views via headless MCP with `--allowedTools "mcp__claude_ai_Notion__*"`; expect filter limitations.
4. Add a pure builder + a `--target` step in `sweep.mjs` following `publishMobileCockpit()`; hash-gate; size-assert <150 KiB.
5. Verify: dry-run, live run, read-back (machine sections replaced, human sections byte-identical), then on-device check.
