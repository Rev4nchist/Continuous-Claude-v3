# Handoff — Claude Managed Agents (CMA) integration

**Date:** 2026-06-28 (work done 2026-06-27) · **Branch:** `feature/cma-managed-agents` (pushed to `fork`) ·
**Outcome:** **PARTIAL_PLUS** — Parts A+B shipped & pushed; Part C (live agent) fully staged but **blocked on a valid Console API key**.

## Goal
Understand Claude Managed Agents (CMA — Anthropic's cloud-hosted agent harness) and set up the
`anthropics/launch-your-agent` workflow inside this harness, then prove it with one live, scheduled agent:
a **weekly Thursday git-history → Notion digest**.

## What CMA is (one paragraph)
A cloud-hosted agent harness (REST API `api.anthropic.com/v1`, beta header `managed-agents-2026-04-01`,
toolset `agent_toolset_20260401`). You define an Agent (model + system + tools + vaults + skills); Anthropic
runs the loop in a sandboxed Linux container server-side. It reaches the world only via the internet,
its sandbox FS, and the **MCP connectors + vault credentials** you wire — **never the local disk**. Bills
consumption on `ANTHROPIC_API_KEY` ($0.08/session-hour + tokens), **separate from the Claude Code subscription**.
NOT ZDR/HIPAA-eligible. The mental-model correction that drove the design: a managed agent is *not* "Claude Code
on a timer on your laptop" — so the digest agent reads **GitHub** (vault token), not the local repos.

## Status by phase
| Phase | State | Where |
|-------|-------|-------|
| **A — wizard skills** | ✅ DONE, committed `ac7b715`, on fork | `.claude/skills/launch-your-agent/`, `.claude/skills/wrap-up/` (vendored `anthropics/launch-your-agent@05e9627`, G8-audited, Windows-ported, registered in `skill-rules.json`) |
| **B — durable infra** | ✅ DONE, committed `e05c515`, on fork | `.claude/skills/cma/SKILL.md`, `.claude/rules/cma-safety.md`, `.claude/agents/cma-operator.md`, registry in `.claude/rules/cli-integration-strategy.md` |
| **C — live weekly-git-digest** | ⛔ STAGED (keyless), blocked | build kit at `docs/cma/weekly-git-digest/` (see its `LAUNCH.md`) |

`/launch-your-agent`, `/wrap-up`, `/cma`, and the `cma-operator` agent are all live and usable now.

## THE BLOCKER (start here next session)
The env `ANTHROPIC_API_KEY` is a real Console key shape (`sk-ant-api03-`, 108 chars) but the API returns
**`401 invalid x-api-key`** (verified, beta-header-independent) — it's revoked/expired. CMA needs a fresh,
valid Console key. No live work (G1 probe, Part C launch) can proceed until it's replaced.

## What Dave must provide to unblock Part C
1. **Valid Console API key** — platform.claude.com → API keys → create; `setx ANTHROPIC_API_KEY "sk-ant-…"`; restart shell. (Smoke test in `docs/cma/weekly-git-digest/LAUNCH.md` §0.)
2. **Notion** — an internal integration token + a **dedicated child page** under Claude Bridge HQ (`30e76fd7ac8281e99fe1c0b257088b34`), shared with the integration (its 32-char page id = `NOTION_PARENT_PAGE_ID`).
3. **GitHub** — a fine-grained PAT, `contents:read` + `pull_requests:read`, on the target repos, with an expiry.
4. **Confirm** — IANA timezone (default `America/New_York`) and the final `REPOS` list; accept that commit history transits a non-ZDR cloud (scope to non-sensitive repos).

## To resume (exact steps)
1. `git checkout feature/cma-managed-agents` (it's the clean CMA branch; on `fork`).
2. Read this file + `docs/cma/weekly-git-digest/README.md` + `LAUNCH.md`.
3. Get the 4 items above. Fill the `<FILL: …>` markers in `first_prompt.txt`, `build-sheet.json`, `deployment.json`.
4. Run `LAUNCH.md` step-by-step: smoke test (must be 200) → env → agent → vault+tokens → ONE validation run (~cents, confirm spend first) → grade → schedule cron → manual test fire.
5. After the first good run: save eval case 1, build the post-cron monitor (G10), set a workspace spend cap.

## Part-C gate checklist (G1-G11)
Tracked in `docs/cma/weekly-git-digest/build-sheet.json` → `gate_status_part_c`. Summary: **G6 (web_search off)**
and **G8 (supply-chain audit)** are DONE; **G4/G5/G7/G9 are DESIGNED** into `system.md`/`outcome.md`/`agent.json`/
`LAUNCH.md` (verify in the first live run); **G1/G2/G3/G11 are PENDING Dave's inputs**; **G10 (monitor)** is a
post-first-run TODO. Do not create a billable session until all are green.

## Premortem mitigations baked in (Claude + Codex, 6 net-new Codex findings)
- **Duplicate posts on retry** → deterministic run-key + Notion **upsert** (not blind append), read-back verify. (`system.md` 5-6, `outcome.md` 4)
- **Secret leakage** → tokens in a **write-only vault**, env-var-injected, `networking.limited` allowlist, secret-scan before any Notion write, never inline. (`cma-safety.md`, `system.md` Never)
- **Exfil channel** → `web_search` **disabled** + networking limited to GitHub+Notion only. (`agent.json`, `environment.json`)
- **Live-page blast radius** → integration shared with a **dedicated child page**, never the HQ root. (`LAUNCH.md` §0 G2)
- **Unattended cost** → `max_iterations:3`, workspace spend cap, documented pause/delete, spend ledger. (`cma-safety.md`, `LAUNCH.md`)
- **DST/window drift** → pinned tz + relative dates + ISO window in the run-key. (`system.md` 1, `deployment.json`)
- **GitHub token scope creep** → fine-grained `contents:read`+`pull_requests:read` + expiry + pre-run permission check.

## Key files
- Plan (with full mitigation matrix + gate): `C:/Users/david.hayes/.claude/plans/i-need-to-understand-modular-journal.md`
- Safety rule (binding): `.claude/rules/cma-safety.md` · Operator ref: `.claude/skills/cma/SKILL.md` · Call shapes: `.claude/skills/launch-your-agent/references/cma-api.md`
- Memory: `cma-integration-status.md` (in the project memory dir)

## Branch hygiene notes
- **`feature/cma-managed-agents`** (this branch) = clean CMA-only (commits `ac7b715`, `e05c515`, + this build kit/handoff commit). Pushed to `fork`. This is the branch to resume on.
- **`feature/cma-integration`** (local only) also carries 2 NON-CMA commits (reporting `6592d46`, viz `9fa9219`) + had unrelated uncommitted working-tree changes (`hooks/dist/*`, `ROADMAP.md`, viz PNGs) — those are NOT CMA work; route them to their own branches before reusing that branch. Nothing here depends on them.
