# Spec: CCV3-CR-INSTALL (DW-91)

Base: `Rev4nchist/Continuous-Claude-v3` `main` @ `718012f0` (re-read at launch).
Authority: card Acceptance AC1–AC13 (2026-10-24 Dev PM per PM / David 1A–7A + 8–9); Wiring Plan Phase 2.
Risk: **medium-high** (PreToolUse guard gates tool use).
Packs path: `artifacts/ccv3-cr-install/` (this folder). Front door after Ready: pinned `architect` → plan.md (DevBot).

## Prerequisites (David / outside this PR)
- AC1 App + seat on CCv3 + greymatter-sec-sandbox; usage billing Off (`cr usage --agent` → inactive).
- AC2 Agentic API key only as Cursor CA secret (Gate 8).
- AC3 `cr auth login` on rog-strix (David); Dev QA `cr doctor` with local approval; evidence under `artifacts/ccv3-cr-install/`.

## PR scope (DevBot / one PR)
### Config
- AC4 `.coderabbit.yaml` at CCv3 root: labels `review:coderabbit` / `review:deep`; `auto_incremental_review: false`; `knowledge_base.mcp.usage: disabled`. Sandbox copy via DW-83 at this card's Gate 17 SHIP (SHA on DW-83).

### Rule
- AC5 `.claude/rules-ondemand/coderabbit-cli.md` + manifest registration; content tests for: ≤2 runs/PR; bg timeout ≥15m (team 35); incomplete outcomes; stop on awaiting_confirmation/action_required; findings advisory; never --use-credits/--api-key/`code new`/`code push`.
- AC6 No `npx skills add coderabbitai/skills` / no `coderabbit skills` install (content test).
- AC7 Ban `coderabbit:autofix` skill; allow read-only autofix subagent (content test).

### Hook
- AC8 PreToolUse `coderabbit-guard.ts` (+ dist) registered in `settings.json.template` for Bash, PowerShell, Skill, Agent/Task; vitest one test per BLOCK/ALLOW pattern listed on card.
- AC9 Run cap: runs 1–2 allowed, run 3 blocked per repo+branch; failed/rate-limited count; no secrets in counter state.

### READY gate
- AC10 `scripts/github/review-status.mjs` counts `coderabbitai[bot]` review **on head** toward READY with Greptile; tests for head-only, rate-limit non-count, CLI/plugin never count, Greptile-only unchanged.

### Docs / Phase 1 rename
- AC11 Update `pr-review-loop.md` and **`pr-opened-review-loop`** (Phase 1 #154 renamed from `pr-opened-coderabbit-loop`) so they no longer say CodeRabbit is uninstalled; both PR bots by label; only PR-bot counts toward READY; CLI/plugin advisory. Tests updated/pass.

### Verification / gates
- AC12 Hooks vitest + review-status tests green on Linux (CA log OK until Actions CI exists) AND Windows pwsh + Git Bash on ROG; `npm run build` dist committed; logs under `artifacts/ccv3-cr-install/verify/`.
- AC13 Cross-family xreview; Gate 17 Dev Reviewer SHIP; human merge; one task one PR; origin Rev4nchist → its main; no force-push; builder `claude-fable-5-1`; reviewer `grok-4.7` High / `composer-2.5`; no secrets; never `--use-credits`.

## Explicit non-goals
Router / Greptile-at-ready / scanner CI (DW-80). review-status summary-in-comment false-negative card (defer unless asked). Minions yaml. Skill installs. Usage billing.

## Ready gate (Dev PM)
Refuse Ready until: Dave says go + packs present (this folder) + Acceptance mirrored + tip SHA re-read + App/seat/login prerequisites acknowledged on card Blocker cleared by PM/Dave.

## Pin waive (2026-10-25 ~8:22 / ~8:28 PM CT)
AC13 fable + Gate 19 opus **waived for this build** (Dave via PM). Opus CA refused under on-demand OFF (Anthropic pool empty). Builder = `composer-2.5` this once. On-demand stays off. Independent reviewer = `grok-4.7` High Cursor CA only (cross-family: not composer reviewing composer).
