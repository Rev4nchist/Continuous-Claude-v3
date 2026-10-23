# Deterministic Scheduled-Tasks Dashboard Sync

A **zero-LLM** replacement for the `claude -p` + Notion-MCP job
(`sync-tasks-dashboard.ps1`). It refreshes only the **"📊 Scheduled tasks —
health & reliability"** section of the CCv3 Reporting Hub
(Notion page `38f76fd7ac8280478e50dd2956ba6e8a`) from `Get-ScheduledTask`.

It also refreshes the **"Last success"** column in the "📚 Reports &
Dashboards" tables (added 2026-07-04): rows whose label prefix maps to a
scheduled task (`REPORT_TASK_MAP` in `DashboardSync.psm1`) get a fresh
timestamp when that task's `LastTaskResult == 0`; link tokens in the cell are
preserved, and rows with non-text tokens (page mentions) or no mapping are
skipped. Everything else on that page (the intro + "Last reviewed", the
report descriptions/status/where cells, "⚠️ Reporting health", "📥 Latest
reports", "📇 FourthOS Project Cards") is hand-maintained and left
**byte-for-byte untouched**.

## Files

| File | Role |
|------|------|
| `sync-tasks-dashboard-deterministic.ps1` | Entry point (preview / `-Write` / `-UseLLM` / `-SelfTest`) |
| `DashboardSync.psm1` | Exported helpers: `Get-TaskInventory`, `Resolve-TaskStatus`, `Build-TasksSectionMarkdown` (+ parsing/formatting helpers) |
| `__tests__/dashboard-sync.Tests.ps1` | Pester 5 tests for the state-machine (no ntn/Notion calls) |

## Modes

| Mode | Invocation | Effect |
|------|-----------|--------|
| **Preview** (default) | `pwsh -File scripts/sync-tasks-dashboard-deterministic.ps1` | Reads the live section (read-only), recomputes every status, PRINTS the proposed new section Markdown + an old→new status diff, and **writes nothing**. |
| **Write** | `... -Write` | Performs a **scoped** update via `ntn api`: PATCHes the "captured" date paragraph and each task table_row cell (Last run / Result / Status). Re-verifies section anchors before mutating. Never touches other sections. |
| **UseLLM** | `... -UseLLM` | One-cycle fallback: shells out to the existing `sync-tasks-dashboard.ps1` (the `claude -p` job). |
| **SelfTest** | `... -SelfTest` | Unit-tests `Resolve-TaskStatus` against the six state-machine cases. No ntn / Notion / `Get-ScheduledTask` calls. |

## Status state-machine (`Resolve-TaskStatus`)

Computed per task from `Get-ScheduledTask` (State / LastTaskResult /
LastRunTime) **plus the current cell/toggle text on the live page** (which is
read first so fixed-pending annotations are honored).

| Condition | Result |
|-----------|--------|
| Task `Disabled` | ⛔ |
| `LastTaskResult == 0`, no annotation | 🟢 |
| Nonzero, no annotation | 🔴 |
| **Fixed-pending** — cell carries "fixed / restored / verifies `<date>`" AND no genuine fresh run since `<date>` | **keep prior glyph (🟡 default) — do NOT revert to 🔴 from the stale pre-fix result** |
| Fixed-pending + fresh terminal run *after* `<date>` returning 0 | 🟢 |
| Fixed-pending + fresh terminal run *after* `<date>` returning nonzero | 🔴 |
| Regression-gate / "expected" annotation + nonzero | 🟡 (expected-nonzero) |
| Regression-gate annotation + 0 | 🟢 |
| Result `0x41301` (running), no annotation | keep prior glyph / 🟢 (in-flight) |

**"Genuine fresh run" exclusions.** Result codes `0x41301` (still running) and
`0x800710E0` (operator refused the launch request) are **not** terminal script
runs and never flip a fixed-pending task. This is exactly the live
AIWeeklyReport / FourthOS-Weekly case: a batch launch attempt was refused on
7/2 (code `0x800710E0`), their real next runs are Thu 7/9, so they hold their
annotated 🟢 / 🟡 rather than being (wrongly) marked 🔴.

## Why not a bridge-style full-page edit?

The prior/bridge approach and `ntn pages edit` do a **full-page content
replace**. On a hand-curated shared page that would clobber the five
human-maintained sections. This script instead:

1. Fetches the page's top-level blocks and isolates the tasks section
   (`heading_2` "Scheduled tasks…" up to the next top-level `divider`).
2. In `-Write`, PATCHes **individual blocks by id** (the captured-date
   paragraph and each `table_row`) — the minimum blast radius. No other block,
   heading, table, or callout is read for mutation.
3. Never calls `ntn pages edit`.

## ntn call contract (enforced in `Invoke-Ntn`)

- Absolute exe:
  `~/AppData/Local/Microsoft/WinGet/Packages/Notion.ntn_Microsoft.Winget.Source_8wekyb3d8bbwe/ntn-x86_64-pc-windows-msvc/ntn.exe`
- **stdin closed** (EOF) so `ntn` cannot hang on open stdin.
- Hard timeout (60s default); nonzero exit → throw (fail-loud).
- `ntn --version` logged once per run.
- Read: `ntn api "v1/blocks/<id>/children"`. Write: `ntn api -X PATCH v1/blocks/<id> -d @body`.
- Structured logs → `.claude/logs/dashboard-sync/<date>-deterministic.log`.

## Testing

```
# state-machine unit tests (no Notion) - either of:
pwsh -File scripts/sync-tasks-dashboard-deterministic.ps1 -SelfTest
pwsh -Command "Import-Module Pester -MinimumVersion 5.0; Invoke-Pester scripts/__tests__/dashboard-sync.Tests.ps1"

# live read-only preview (writes nothing):
pwsh -File scripts/sync-tasks-dashboard-deterministic.ps1
```

## Cutover checklist

1. Run `-SelfTest` (or Pester) → all green.
2. Run **preview** against the live page; confirm the proposed section matches
   intent and the old→new diff is sane (a stable day shows all "same").
3. Run once with `-Write`; open the page and verify **only** the tasks section
   changed and the other five sections are byte-for-byte identical.
4. Repoint the registered `CCv3-Dashboard-Sync` task's action from
   `sync-tasks-dashboard.ps1` to
   `sync-tasks-dashboard-deterministic.ps1 -Write`
   (keep `-UseLLM` available as the fallback).
5. Leave `sync-tasks-dashboard.ps1` in place as the LLM fallback path.

## Known deviations / notes

- **`CCv3-Project-Cards`** appears in `Get-ScheduledTask` but is **not** a row
  in the current section (it feeds the separate "📇 FourthOS Project Cards"
  gallery). Preview lists it under "inventory tasks not in section"; the script
  makes **no** structural change (adding a row is a human decision).
- `LastRunTime` is rendered `yyyy-MM-dd HH:mm`. The live page shows date-only
  for some weekly rows; the script normalizes to include the time. Cosmetic.
