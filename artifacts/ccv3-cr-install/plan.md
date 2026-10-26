# Plan: CCV3-CR-INSTALL (DW-91 / Phase 2) (CA-ready)

**Goal:** Bring CodeRabbit back as a label-gated PR bot that counts toward READY. The CLI/plugin stays advisory only, capped at 2 runs per PR by a PreToolUse guard.
Slug: `ccv3-cr-install` · Risk: **medium-high** (the PreToolUse guard gates tool use) · Card DW-91 (Notion: read-only for the CA; do not edit it)
Repo: `Rev4nchist/Continuous-Claude-v3` **only** (never upstream/parcadei)
Base: `main` @ `718012f0d83b90301b659a19656bc91560efafcb`. Verified with the GitHub API (cursor-github) on 2026-10-25 ~8:20 PM CT. Commit time 2026-10-25 8:11 PM CT (Phase 1 #154 merge).
Branch: `feat/ccv3-cr-install` · PR title: `feat(review): label-gated CodeRabbit PR bot + CLI guard + READY counting (DW-91)`
PR: **draft** to Rev4nchist `main`. Push only with `git push origin HEAD`. No force-push. No merge (David merges).
Builder: `composer-2.5` (Dave via PM 2026-10-25 ~8:28 PM CT: on-demand OFF; AC13 fable/opus waived; included pool). On-demand OFF. Greptile ON (do not mute it and do not touch `.greptile/config.json`). Independent reviewer after: `grok-4.7` High only (cross-family; not composer — builder is composer-2.5).

## Out of scope
- **AC1–AC3:** David's evidence for Done, not CA work: App/seat + usage Off (`cr usage --agent`), Agentic API key as a CA secret, `cr auth login` on ROG + `cr doctor`. The CA must never read, mint, or echo a CodeRabbit key.
- A review-status.mjs false-negative (summary-in-comment) card or fix. **Do not invent one.**
- Merging. DW-80/Phase 3 (router, Greptile-at-ready, scanner CI). MCP context. `--use-credits`/billing. Minions config. Skill installs (`npx skills add coderabbitai/skills`, `coderabbit skills`).
- The live ROG settings change. A6 is already verified: they point at `pr-opened-review-loop.mjs`.

## 0. Re-ground (CA)
1. `git fetch origin && git rev-parse origin/main` must equal `718012f0d83b90301b659a19656bc91560efafcb`. If it has moved, run `git diff 718012f0..origin/main --stat -- .claude scripts` and rebase. Note it in the PR body.
2. Read `AGENTS.md` (Testing table), `.claude/rules-ondemand/pr-review-loop.md`, `.claude/hooks/src/pr-opened-review-loop.ts`, `scripts/github/review-status.mjs` (+ `.test.mjs`), and one existing guard pattern: `.claude/hooks/src/package-install-guard.ts` + its test.
3. Baseline: `cd .claude/hooks && npm ci && npm run build && npx vitest run 2>&1 | tail -30` and `node ../../scripts/hooks/suite-count-ratchet.mjs --json`. Save the output to `artifacts/.../verify/` (in repo: `.claude/cache/e2e/2026-10-25-dw91-baseline.txt`).

## 1. File / touch list (paths confirmed at tip unless marked NEW)
| # | Path | Change | AC |
|---|---|---|---|
| 1 | `.coderabbit.yaml` (NEW, repo root) | `reviews.auto_review` gated on labels `review:coderabbit` / `review:deep`; `auto_incremental_review: false`; `knowledge_base.mcp.usage: disabled`. Validate keys against the current CodeRabbit schema (docs.coderabbit.ai). No secrets | AC4 |
| 2 | `.claude/rules-ondemand/coderabbit-cli.md` (NEW) | Advisory CLI/plugin rule: ≤2 runs/PR; background timeout ≥15m (team 35m); treat incomplete outcomes as incomplete; stop on `awaiting_confirmation`/`action_required`; findings advisory, never READY; never `--use-credits`, `--api-key`, `code new`, `code push`; no skill installs; ban the `coderabbit:autofix` skill; read-only autofix subagent allowed | AC5–7 |
| 3 | `.claude/rules-ondemand/manifest.json` | Register `coderabbit-cli` (mode inject; command triggers `^(cr|coderabbit)\b`). Copy the shape of the `pr-review-loop` entry (~line 171) | AC5 |
| 4 | `.claude/rules-src/on-demand-rules.md` | **Discover then edit:** add an index line only if `node scripts/rules/ondemand-index-check.mjs` requires it | AC5 |
| 5 | Rule content test (NEW) | **Discover:** find where existing rules-ondemand content tests live (`git grep -l "rules-ondemand" -- '*test*'`). Add one assertion per AC5–7 clause there | AC5–7 |
| 6 | `.claude/hooks/src/coderabbit-guard.ts` (NEW) | PreToolUse. **BLOCK:** `--use-credits`, `--api-key`, `cr\|coderabbit code new\|push`, Skill `coderabbit:autofix`, skill installs, 3rd run. **ALLOW:** plain `cr review --agent` (runs 1–2), read-only autofix subagent (Agent/Task). Run counter per repo+branch in the TMPDIR state file. Failed or rate-limited runs still count. No tokens/args stored. Use the shared guard-log helper as the other guards do | AC8–9 |
| 7 | `.claude/hooks/src/__tests__/coderabbit-guard.test.ts` (NEW) | One vitest per BLOCK/ALLOW pattern on the card + run-cap tests (1 ok, 2 ok, 3 blocked, failed run counts, state has no secrets) + dist e2e | AC8–9 |
| 8 | `.claude/hooks/dist/coderabbit-guard.mjs` (NEW) + `dist/.build-inputs.json` | From `npm run build`; commit both | AC8/12 |
| 9 | `.claude/settings.json.template` | Add the `coderabbit-guard.mjs` command to the PreToolUse `Bash` (~l.122), `PowerShell` (~l.159) and `Task` (~l.27) blocks, plus a new `Skill\|Agent` matcher (or extend Task → `Task\|Agent`). Keep the diff minimal; do not touch line 711 (`pr-opened-review-loop.mjs`) | AC8 |
| 10 | `scripts/github/review-status.mjs` | Count a `coderabbitai[bot]` review whose `commit_id == head` toward READY alongside Greptile. Rate-limit/"review skipped" never counts. CLI/plugin output never counts. Greptile-only path byte-identical | AC10 |
| 11 | `scripts/github/review-status.test.mjs` | Tests: head-only, stale-commit ignored, rate-limit non-count, CLI never counts, Greptile-only unchanged | AC10 |
| 12 | `.claude/rules-ondemand/pr-review-loop.md` | Remove "CodeRabbit uninstalled". Both PR bots are label-gated. Only PR-bot reviews count toward READY. CLI/plugin is advisory. Move "CodeRabbit label-gated return" out of "Target (not built)". **Keep the headings `## No review on the head` / `## When the review lands` byte-identical** (`pr-loop/model.ts`, `pr-loop.test.ts`, `review-status.mjs` quote them) | AC11 |
| 13 | `.claude/hooks/src/pr-opened-review-loop.ts` (+ test, + dist) | Update the `loopText`/`buildContext` wording to the two label-gated PR bots. **Name stays `pr-opened-review-loop`.** Do not change the import guard or the statePath | AC11 |
| 14 | `.claude/docs/architecture/quick-ref/hook-catalog.md`, `.claude/docs/architecture/SYSTEM-OVERVIEW.md` | Add a `coderabbit-guard` row (PreToolUse). Update the review table: CodeRabbit is live, label-gated | AC11 |
| 15 | `scripts/hooks/suite-baseline.json` | Only if the ratchet requires a bump for the new tests | AC12 |

**Do not touch:** `.greptile/config.json`, `.claude/plugins/ccv3-mods/**` (other than reading it), `.claude/skills/**`, `.claude/agents/**`, dated proposals, Sentry hooks, line 711 of the template.

## 2. AC11 reminder
The hook is **`pr-opened-review-loop`** (renamed in #154). Never reintroduce `pr-opened-coderabbit-loop`. `git grep -n "pr-opened-coderabbit-loop"` should show only the existing dated proposals and "Renamed from" notes.

## 3. Acceptance checks (CA runs them; save logs to `.claude/cache/e2e/2026-10-25-dw91-*.txt`, then mirror them to `artifacts/ccv3-cr-install/verify/`)
```bash
cd .claude/hooks && npm ci && npm run build && npx tsc --noEmit
npx vitest run src/__tests__/coderabbit-guard.test.ts src/__tests__/pr-opened-review-loop.test.ts src/__tests__/settings-template-validation.test.ts
npx vitest run                                   # 0 new failures vs baseline
cd ../..
node --test scripts/github/review-status.test.mjs
node scripts/hooks/suite-count-ratchet.mjs && node scripts/hooks/suite-shape-guard.mjs
node scripts/ratchets/no-codex.mjs && node scripts/ratchets/no-work-user.mjs
node scripts/rules/ondemand-index-check.mjs && node scripts/rules/context-budget-guard.mjs --repo
node scripts/settings/hook-parity.mjs && node scripts/hook-manifest-check.mjs --repo
git grep -n "pr-opened-coderabbit-loop"           # AC11
git grep -nE "use-credits|api-key" -- .coderabbit.yaml   # must be empty
# e2e guard (real payloads into dist)
G=.claude/hooks/dist/coderabbit-guard.mjs
echo '{"session_id":"g1","tool_name":"Bash","tool_input":{"command":"cr review --agent --use-credits"}}' | node $G   # expect block
echo '{"session_id":"g1","tool_name":"Bash","tool_input":{"command":"cr review --agent"}}' | node $G                 # expect allow (x2), 3rd block
echo '{"session_id":"g1","tool_name":"Skill","tool_input":{"skill":"coderabbit:autofix"}}' | node $G                # expect block
```
Plus Semgrep (`semgrep_scan` on changed `.ts`/`.mjs`) with 0 new high findings, and the gitleaks and no-work-user CI checks green on the PR.
**Windows (ROG via Claude Bridge, not CA):** pwsh 7 + Git Bash (`C:\Program Files\Git\bin\bash.exe`), the same vitest + build + review-status test + Pester windows-gates. Logs go to `verify/`.

## 4. CA brief (copy-paste)
```
Repo: Rev4nchist/Continuous-Claude-v3 ONLY (never parcadei/upstream).
Base: main @ 718012f0d83b90301b659a19656bc91560efafcb — verify with git rev-parse origin/main; if moved, rebase + note in PR.
Model: composer-2.5 (included pool). AC13 fable/opus waived this build. On-demand OFF. Greptile ON (don't touch .greptile/config.json).
Task: DW-91 CCV3-CR-INSTALL. Follow artifacts/ccv3-cr-install/plan.md §1 file list exactly.
Branch: feat/ccv3-cr-install
PR: ONE DRAFT PR to Rev4nchist main, title
  "feat(review): label-gated CodeRabbit PR bot + CLI guard + READY counting (DW-91)"
Push: git push origin HEAD only. No force-push. No merge. No other remotes.
Scope:
 1 .coderabbit.yaml (labels review:coderabbit/review:deep; auto_incremental_review:false; knowledge_base.mcp.usage: disabled)
 2 .claude/rules-ondemand/coderabbit-cli.md + manifest.json entry + content tests (AC5-7)
 3 .claude/hooks/src/coderabbit-guard.ts + test + dist; register in settings.json.template
   for Bash, PowerShell, Task/Agent, Skill. Block --use-credits/--api-key/code new|push/
   coderabbit:autofix skill/skill installs/3rd run per repo+branch. Allow cr review --agent
   (runs 1-2) and read-only autofix subagent. No secrets in counter state.
 4 scripts/github/review-status.mjs: coderabbitai[bot] review on HEAD counts toward READY with
   Greptile; rate-limit/CLI never count; Greptile-only unchanged; tests.
 5 Docs: pr-review-loop.md, hook-catalog.md, SYSTEM-OVERVIEW.md, pr-opened-review-loop.ts text.
AC11: hook name is pr-opened-review-loop (NOT pr-opened-coderabbit-loop). Keep headings
  "## No review on the head" / "## When the review lands" byte-identical.
Do NOT: create a review-status false-negative card/fix; do AC1-AC3 (David's); read/mint/echo
  any CodeRabbit key; run cr with --use-credits; install skills; touch Notion; message anyone.
Verify: run plan.md §3 commands; save logs to .claude/cache/e2e/2026-10-25-dw91-*.txt;
  Semgrep changed code; gitleaks + no-work-user CI green. No secrets in PR body.
PR body: AC4-AC12 checklist with evidence, builder family line (claude-fable-5-1),
  Windows verify pending (ROG), reviewer grok-4.7 High next.
Two failed retries on the same step → stop and report.
```

## 5. Risks / rollback
- **Guard over-blocks** (e.g. matches `cr` inside other words, or matches `git commit -m "...--api-key..."`). Mitigation: anchor regexes on command segments and add negative tests. Rollback: drop the template entries (one revert commit). The hook is inert when unregistered.
- **Guard under-blocks via PowerShell quoting or chained commands.** Mitigation: segment-split as `package-install-guard` does; tests for `;`, `&&`, and pwsh.
- **review-status false READY** from a stale or rate-limited CodeRabbit review. Mitigation: head-SHA match + rate-limit tests. Greptile-only path unchanged.
- **`.coderabbit.yaml` schema drift.** An invalid key triggers silent defaults (it could auto-review everything and burn the seat). Validate against the published schema. The label gate must be explicit.
- **Ratchet/parity failures** from the new hook (suite-baseline, hook-parity, manifest-check). Bump only via the documented scripts.
- **Rollback overall:** draft PR, not merged, so close it. After merge: `git revert` of the merge commit by David. Remove `.coderabbit.yaml` to silence the bot.
