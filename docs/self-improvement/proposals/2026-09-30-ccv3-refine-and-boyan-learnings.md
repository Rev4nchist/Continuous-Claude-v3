<!-- Source: workflow wf_137e95ed-a25 (9 agents: 4 audits, claim verification, transcript metrics, synthesis, critic, revision). Read-only; nothing applied. -->

# CCv3 refinement proposal: today's work and the Boyan learnings (2026-09-30)

> **Outcome (2026-09-30):** rows 1-5 shipped in PR #68. A3.1-A3.3, A3.5-A3.7 and B2 landed; the
> measured always-loaded set is 25,648 of 26,000 chars (`context-budget-guard.mjs --repo`), which
> replaces the estimates in A3 below. A3.8 and A3.9 are not done.

## 1. Summary

- **Part A** lists 57 edits on 6 surfaces, and 18 are "must". Most come from 3 root causes:
  - the hidden sync skip (facts 4 and 7)
  - the CodeRabbit rate-limit loop (facts 9 and 10)
  - the effort pin that does not reach subagents (fact 2)
- **Part B** adopts one Boyan lever fully: agent precision. It adopts a second lever in a narrow form: move detail out of files that always load.
  - Subagents use 55.4% of all tokens. Most of these tokens are cache reads, and the report does not compute cost (token-report).
  - 27 of 37 agent descriptions have no "when not to use". 0 of 37 have a read scope (agents audit).
- **Part B** skips the Sonnet-effort lever (Dave's rule) and `/compact` (already our practice). It puts cache TTL and tool search on WATCH.
- **Part C** finds 6 places where the Boyan reply is wrong, unverified or out of date against our numbers. Fix them before he gets the reply.
- **Budget:** the always-loaded set is at 25,774 of 26,000 chars. A3.1-A3.3 and A3.5-A3.7 fit without B2, at a net of about +95 chars. B2 is necessary only for A3.9. [Speculation] The exact figures depend on the final wording.

## 2. Part A: adjust from today's work

The audits marked some items already correct, so this list leaves them out. Items that more than one audit found are merged. The source audits are in brackets.

### A1. On-demand rules (`.claude/rules-ondemand/`)

| # | File:line | Change | Reason | Pri |
|---|---|---|---|---|
| A1.1 | `pr-coderabbit-loop.md:39-41` | Delete "Wait for the limit to reset and comment `@coderabbitai review`". New text: CodeRabbit refuses `@coderabbitai review` after "Review rate limited" or "Review limit reached". The command works only when auto reviews are paused. Do not post it. Report to Dave. With his merge yes, run `land-pr.ps1 -IgnoreReview` and post the reason on the PR (PR #67 precedent). Never buy the on-demand review. Add a "new push re-triggers review" line only after the CodeRabbit docs confirm it. | Fact 9. The command failed twice on PR 67 (bot replies at 16:35:31Z and 16:59:18Z). `land-pr.ps1:12` already documents `-IgnoreReview`. [rules, claudemd, tooling] | must |
| A1.2 | `pr-coderabbit-loop.md:43-46` and `git-merge-workflow.md:27-29` | Change "syncs `~/.claude`" to "syncs `~/.claude` only when the primary checkout is on main. Otherwise it prints `skipped sync`. Then, on main, run `scripts/sync-to-active.sh --changed` in Git Bash (the Bash tool). Never hand-copy a synced file into `~/.claude`." NEVER_SYNC files (CLAUDE.md, RULES.md, settings.json) are the exception: edit them live and copy them to the template (`every-surface-checklist.md`, CLAUDE.md / RULES.md row). After A6.4 lands, rewrite the line to match the new behavior. | Fact 4. `land-pr.ps1:98-105` skips the sync off main. A hand copy caused the 26-file quarantine. `bash` on PATH is WSL (global CLAUDE.md, "This machine"), so `land-pr.ps1:101` calls `$gitBash`. [rules, claudemd, tooling] | must |
| A1.3 | `pr-coderabbit-loop.md:15-19` | Add a stop condition: a rate-limit notice is not a review. Report "CodeRabbit rate limited, head not reviewed". | Fact 9. The notice meets the `:17` condition "review or walkthrough comment exists". [rules] | should |
| A1.4 | `git-merge-workflow.md:38, 42, 54` | Replace `git reset --hard fork/main` with `git merge --ff-only fork/main` (on main) or `git fetch fork main:main` (off main). Mark `reset --hard` as needing Dave's yes. | The global CLAUDE.md lists `reset --hard` as destructive. `land-pr.ps1:15` says "never a reset". [rules] | should |
| A1.5 | `git-merge-workflow.md:34`, `proactive-delegation.md:144` | Replace the dead `windows-platform.md` reference with `~/.claude/docs/windows/platform-notes.md`. | That file does not exist in any tree. [rules] | should |
| A1.6 | `proactive-delegation.md:33-46` | Add a 3-line block, "Model and effort at spawn". Sonnet work uses a predefined Sonnet agent, which carries `effort: high`. An ad-hoc Agent call names `model`. A workflow `agent()` on Sonnet passes `effort: 'high'`. Never haiku. | Fact 2. This is the only rule that loads at spawn (`manifest.json:283-291`). `agent-model-selection.md` loads only when agent files are in play. [rules] | should |
| A1.7 | `pr-coderabbit-loop.md:35-37` | Until A6.5 is done: on "review of head: NO", read the commit status description to find the cause. Delete this line after A6.5 lands. | Fact 10. `coderabbit-status.mjs:80` gives only a generic reason. [rules] | could |
| A1.8 | `proactive-delegation.md:39` | Change `validator` to `arbiter/atlas`. | No `validator.md` exists. [rules] | could |
| A1.9 | `headless-claude-mcp.md:14-19` | A headless probe sets `--effort` explicitly (Sonnet: high). | Facts 2 and 11. Without the flag, a probe gets the effort from settings. [rules] | could |

### A2. Path-scoped rules (`.claude/rules-src/`)

| # | File:line | Change | Reason | Pri |
|---|---|---|---|---|
| A2.1 | `agent-model-selection.md:14`, `:20-21` | Now: "`modelSettings` does not reach an unpinned agent." Name both effort sources: user `~/.claude/settings.json:837` is `medium`, and this repo's `.claude/settings.json:828` is `high`. Do not write "an agent inherits the spawning session's effort" until the Q6 probe proves it. The same unproven claim is at `:20-21`. Correct it after the probe. | Fact 2. The probe ran an unpinned Sonnet agent under an Opus-medium parent, and the global `effortLevel` is also medium. Both explanations give medium, so the probe cannot tell them apart. **Audit conflict:** the claudemd audit marked `:14` correct. The rules audit showed it wrong. The probe evidence supports only the narrow claim. | must |
| A2.2 | `git-sync-workflow.md:34-37` | The post-commit hook sends the sync output to `/dev/null`, so you never see "Sync skipped". After a commit, check that `~/.claude/state/sync-cursor` equals `git rev-parse main`. After A6.2 lands, name the new log file. | Fact 7. `.git/hooks/post-commit:18`. [rules, tooling] | must |
| A2.3 | `git-sync-workflow.md:122` | Change "Rebuild hooks" from `cd ~/.claude/hooks` to `cd ~/continuous-claude/.claude/hooks`. | `~/.claude/hooks/src` is a stale May copy (46 files differ, 12 are missing). A build there overwrites the synced dist. [rules] | must |
| A2.4 | `git-sync-workflow.md:62-75, 99-114` | Rewrite "Quick Workflow" and "Branching" as one short block: branch, commit, PR, `land-pr.ps1` after Dave's yes, confirm the sync. The rewrite must remove more chars than A2.2 and A2.5 add. | `:69-70`, `:103` and `:112` contradict `:32-37` and "no feature work on main". [rules] | should |
| A2.5 | `git-sync-workflow.md:85-97` | The next sync quarantines a direct edit or a hand copy in `~/.claude`, even when the file is identical to the repo. | Fact 4. [rules] | should |
| A2.6 | `sync-known-gaps.md:64-70` | The guard compares the destination with the manifest hash, not with the source. Diff the quarantine against the repo before you delete it. Optional script fix: skip the quarantine when the destination hash equals the source hash. | Fact 4. The uncommitted 3-line diff in this file is today's `modelSettings` amendment ("Dave, 2026-09-30: Sonnet always runs at high"), made on this branch. Commit that amendment before A2.6 or A2.10 edits the file. [rules] | should |
| A2.7 | `agent-model-selection.md:17-26` | Add the probe result and the proof method: the `"effort":"<level>"` field in the subagent transcript. Use the full baseline: "46 of 99 Sonnet runs medium, 5 low". | Fact 2. [rules] | should |
| A2.8 | `agent-model-selection.md:56` | Replace the stale "Opus 4.8 / Sonnet 5". Note that the `.json` mirror has no `effort` and that `claude_spawn.py:535` passes no `--effort`. | Stale model names. [rules] | should |
| A2.9 | `hook-dev-lifecycle.md:28-42` | Add a failure row: "Hook resolves a file under `~/.claude` only." | Fact 5. `agent-model-guard.ts:35`. [rules] | should |
| A2.10 | `sync-known-gaps.md:24-26` | Add "(commits on main in the primary checkout only)". Change `agents/*.yml` to `agents/*.md` + `*.json`. | No `.yml` agents exist. [rules] | could |
| A2.11 | `every-surface-checklist.md:30` | `effort:` is only in the `.md`. The `.json` has no effort. | Fact 2. [rules] | could |
| A2.12 | `hook-dev-lifecycle.md:71` | Change the path to `.claude/docs/architecture/quick-ref/hook-catalog.md`. | The current path does not exist. [rules] | could |
| A2.13 | `codex-adversarial.md.bak.20260518-224215` | Move (archive) the file out of `rules-src`. | Clutter. It has no active copy. [rules] | could |
| A2.14 | `hook-dev-lifecycle.md:12, 35, 36` | Anchor `cd .claude/hooks && npm run build` to `~/continuous-claude/.claude/hooks`. | The path is relative. Run from `~/.claude`, it builds the stale sources (see A2.3). [rules] | should |

Budget check for path-scoped rules: `git-sync-workflow.md` and `sync-known-gaps.md` load whenever harness files are in play. `context-budget-guard.mjs` does not count them. It counts 5 files only. Record `wc -c` for each changed path-scoped rule before and after the edit. The net change for `git-sync-workflow.md` must be ≤ 0.

### A3. Always-loaded files (budget: 25,774 of 26,000 chars)

| # | File:line | Change | Chars | Pri |
|---|---|---|---|---|
| A3.1 | `CLAUDE.md:19` | Reduce the line to the command only: "Forward sync after a merge: on main, run `scripts/sync-to-active.sh --changed` in Git Bash. Reverse sync is manual only." | about +5 | must |
| A3.2 | `CONTEXT.md:18` | Change "auto on commit" to "on commit to `main` in the primary checkout only". This is the only always-loaded statement of the condition. | about +45 | must |
| A3.3 | `CONTEXT.md` after `:19` | Add the terms **Sync cursor** and **Clobber-guard quarantine** (`sync-to-active.sh:85`, `:150`, `:155`). The quarantine entry says that the next sync moves a file edited or hand-copied in `~/.claude` to `.sync-quarantine/<ts>/`. | about +290 | must |
| A3.5 | `~/.claude/CLAUDE.md:154` and `.claude/templates/CLAUDE.md.template` | After "**Never haiku.**", add "Sonnet effort is always `high`." **Needs Dave's yes**, because this edit changes the approved global core. CLAUDE.md is in NEVER_SYNC (`sync-to-active.sh:131`), so edit the live file directly. Copy the edit to the template in the same change (`every-surface-checklist.md`, CLAUDE.md / RULES.md row). | +32 | should |
| A3.6 | `CLAUDE.md:23-27` | Delete the `## Git` section. Each of its lines repeats `CONTEXT.md:55-56` and `~/.claude/CLAUDE.md:20, 73, 195`. | −212 | must |
| A3.7 | `CONTEXT.md:4-5` | Delete the Theo citation sentence. | −90 | should |
| A3.8 | `CONTEXT.md:20` | Change "Always loaded" to "Always loaded unless it has `paths:`." | +25 | could |
| A3.9 | `AGENTS.md:17` | For a change to a Sonnet agent, confirm `"effort":"high"` in the transcript. | +130 | could |

A3.4 ("Effort pin" term) is removed. A3.5 already states the fact, and the term is used only in `agent-model-selection.md`, which is path-scoped.

Net for A3.1-A3.3 and A3.5-A3.7 is about +70 chars against 226 chars of headroom, which leaves about 156 chars. A3.8 then fits. A3.9 fits only with B2 (−170). [Speculation] The exact figures depend on the final wording. Re-run `node scripts/rules/context-budget-guard.mjs --repo`.

### A4. Architecture docs and Braintrust leftovers (not loaded; read on demand)

| # | File:line | Change | Pri |
|---|---|---|---|
| A4.1 | `.claude/docs/architecture/INDEX.md:14, 25, 36-41, 62` | Remove the Braintrust rows, or mark them RETIRED 2026-09-30 with a pointer to `archive/braintrust-2026-10/`. The global CLAUDE.md sends readers to this file (`~/.claude/CLAUDE.md:208`). | must |
| A4.2 | `quick-ref/agent-picker.md:64`, `subsystems/agents.md:66-67` | Replace "always omit model (inherits)" with "set `model:` explicitly; a Sonnet agent also sets `effort: high`." | must |
| A4.3 | `SYSTEM-OVERVIEW.md:100-139`, `cheatsheet.md:57, 195-196, 314`, `user-guide.md:264, 355`, `hook-catalog.md:21, 35, 62, 97-111, 133-150`, `hooks.md:32, 77-96`, `agents.md:74-88`, `docs/ARCHITECTURE.md:32, 358, 601, 622, 632` | Remove the Braintrust text or mark it RETIRED. `agents.md:80-88` still tells the reader to re-run the archived `audit-braintrust-emits.sh`. | should |
| A4.4 | `.claude/docs/windows/platform-notes.md:127` | Record the real source of fact 6. The PowerShell path guard built into Claude Code (in `claude.exe`, `decisionReason.type: safetyCheck`) reads a regex token such as `\w+` as `/w+` under the drive root. Workaround: run `Remove-Item` as a separate call, or put regex-heavy code in a `.ps1` file and run it with `pwsh -File`. | should |
| A4.5 | `.env.example`, `.claude/settings.json.template`, `.claude/artifacts.json`, `artifact_index.py` trace columns, the dashboard static bundle, the disabled CCv3-Judge-Batch task, `.claude/agents-archive/braintrust-analyst.md` | Remove the remaining Braintrust references (fact 1). The `artifact_index.py` trace columns are a persistent format: **Dave decides**. [Source: tooling and metrics audits; not re-read in this pass.] | should |
| A4.6 | Claude Code feedback | Report the PowerShell path guard false positive (A4.4) with the `safetyCheck` decision reason. | could |

### A5. Agents (`.claude/agents/`)

| # | File:line | Change | Evidence | Pri |
|---|---|---|---|---|
| A5.1 | `critic.md:3, 39-51, 85-87, 191` | Remove the Bash block (cat, rp-cli) and the "write to cache" instructions. Rewrite the description with "when" and "when not". Add a 30-call budget with a partial return. | 280 runs. 49 "No such tool available: Bash" errors and 4 for Write. Max 77 calls and 978 KB. `tools:` at `:5` is Read/Grep/Glob. | must |
| A5.2 | `oracle.md:3, 6, 113, 153, 157, 163` + `oracle.json` | Make `tools:` agree with the body. Add WebFetch and the context7, nia and exa MCP tools, or delete those routes. Correct `:163` "Always available". Add a 40-call budget that stops at 3 sources that agree. | 27 runs. 8 WebFetch errors and 8 Bash denials. `tools: [Read, Bash, WebSearch]`. | must |
| A5.3 | `scout.md:3, 37-100, 209, 214` | Replace rp-cli, morph_search and runtime.harness with Grep/Glob, then tldr, then rg. Add a read scope: never search from `$HOME` or a drive root, and exclude `node_modules`. Replace "Be thorough" with a 40-call budget. | rp-cli is not on PATH. 47 runs, median 102 KB. One transcript ran `grep -rl` over the full home directory. | must |
| A5.4 | `kraken.md:3, 94-107, 276-286` | Make the same tool swap. Add an 80-call budget per phase that writes a checkpoint and returns a partial result. | 106 runs. Median 55 calls, max 559 calls and 2,115 KB. | must |
| A5.5 | `plan-reviewer.md:3, 5, 77-101, 185-187, 242-244` | Add Bash, or use Grep/Glob only. Drop `nia_docs.py`. Add a JSON return contract and a 30-call budget. | `tools:` has no Bash, but the body runs `uv`, `rg` and `tldr`. | should |
| A5.6 | `judge.md`, `liaison.md`, `surveyor.md`, `react-perf-reviewer.md`, `ui-compliance-reviewer.md` | Same fix as A5.1. | Same conflict between `tools:` and the body. Low traffic. | should |
| A5.7 | `debug-agent.md:3, 5, 12-18, 43-70, 132-146, 154` | Drop Edit. Delete the dead script blocks. Use `systematic-debugging`. Add a return contract and a 40-call budget. | 4 scripts are missing at the paths that the body uses. | should |
| A5.8 | `spark.md:3, 38-51, 147` | Remove rp-cli. Add a 15-call budget and a read scope limited to the Files list. | Spark is the fan-out unit (global CLAUDE.md "N parallel sparks" rule). | should |
| A5.9 | `aegis`, `architect`, `onboard`, `pathfinder`, `phoenix`, `plan-agent`, `profiler`, `sleuth` | Replace rp-cli and runtime.harness in one batch. Point MCP scripts at `$CLAUDE_OPC_DIR` (same form as `oracle.md:62`). Remove `perplexity_ask.py` and `init-project.sh`. | The scripts are missing. | could |
| A5.10 | `arbiter.md:3, 183` | Rewrite the description with "when" and "when not". Add a partial return on a Bash timeout. | Already cheap (median 5 calls). | could |
| A5.11 | 12 Sonnet `.json` files + `opc/scripts/claude_spawn.py:319, 594-598` | Add `"effort": "high"` and pass it in `--agents`. First confirm in the docs that `--agents` accepts `effort`. | Fact 2. The `.md` pin does not reach `claude_spawn`. | could |

Read-scope caveat (agents audit): critic reads library source on purpose, and kraken runs binaries from `node_modules/.bin`. The rule "never read `node_modules`" applies to exploration agents only (scout, oracle, spark).

Error-baseline caveat (agents audit): subagent transcripts show TLDR Read intercepts as "PreToolUse:Read hook error" (12 or more each for critic, kraken and scout). These rows are not errors from a mismatched tool scope. Leave them out of the A5 error baselines and the §5 row 6 check.

### A6. Hooks, scripts and skills

| # | File:line | Change | Pri |
|---|---|---|---|
| A6.1 | `.claude/hooks/src/agent-model-guard.ts:35, 37-44, 142-151` | Before the hook denies, look in `~/.claude/agents`, `<cwd>/.claude/agents` and `$CLAUDE_PROJECT_DIR/.claude/agents`. Allow names that contain `:` (plugin agents). Add `claude` to `BUILTIN_AGENTS`: it is not in the set today (`:37-44`), and the tooling audit found 2 real denials (session 20bbd968, 2026-09-18). This hook checks only that the agent exists. It is not a model guard (`:8-11`). First run a headless probe. If Claude Code already rejects an unknown `subagent_type`, delete the hook. | must |
| A6.2 | `scripts/post-commit-hook.sh:12-19` | Run the branch check in the foreground. Off main, print "Sync skipped: ...". Send the output to `~/.claude/logs/post-commit-sync.log`, not `/dev/null`. | must |
| A6.3 | `.git/hooks/post-commit:12-18` | Copy in the fixed A6.2 file. `install-hooks.sh:12, 46` never overwrites a hook that is already installed. | must |
| A6.4 | `scripts/github/land-pr.ps1:98-105` | Off main, sync from a detached temp worktree with `SYNC_ALLOW_BRANCH=1`. Remove the worktree in `finally`. Alternative (Dave decides; it reverses test T3): relax the `sync-to-active.sh:76` guard. | should |
| A6.5 | `scripts/github/coderabbit-status.mjs:63, 78-80, 85-90, 121` | Read `cr.description`. On `/rate limit/i`, give a specific reason and print it. | should |
| A6.6 | `scripts/check-agent-model-drift.mjs:53-78` (or a new `agent-body-consistency.mjs`) | Add a ratchet. Fail when the body uses Bash or Write and `tools:` does not include it. Fail on an rp-cli or runtime.harness path that does not resolve. Baseline: 8 conflicts, 15 rp-cli files, 7 runtime.harness files. | should |
| A6.7 | `.claude/skills/tldr-code/SKILL.md:11, 15, 48` | Rewrite `:15` to list only the 3 live hooks: `tldr-read-enforcer`, `smart-search-router`, `post-edit-diagnostics`. The other 5 (`tldr-context-inject`, `impact-refactor`, `arch-context-inject`, `edit-context-inject`, `signature-helper`) have no src, no dist and no registration. Mark the "95% savings" claim at `:11` and `:48` as "pending T1-T5". | should |
| A6.8 | TLDR measurement (fact 8) | Run the pending T1-T5 measurement plan. Replace the 95% figure with the measured result. | could |
| A6.9 | `~/.claude/hooks/src` | Move (archive) the stale May copy (46 files differ, 12 are missing). **Needs Dave's yes.** | should |

## 3. Part B: Boyan learnings

The claim numbers follow the order of the verification input.
- C1: effort values. TRUE.
- C2: Opus 5.5 at medium ≥ Opus 5 at high. TRUE.
- C3: tools inheritance. PARTIAL.
- C4: lazy load of subdirectory files. TRUE.
- C5: `@` imports are eager, 4 hops. TRUE.
- C6: a mid-session edit applies later. TRUE.
- C7: AGENTS.md. TRUE.
- C8: TTL. TRUE.
- C9: `promptCacheTtl` and `subagentPromptCacheTtl`. The prompt-caching page documents both settings (v2.1.242 or later). The settings reference does not list them.
- C10: the invalidation list. TRUE.
- C11: `/clear` vs `/compact`. TRUE.
- C12: tool deferral. TRUE.
- C13: conditions that turn tool search off. TRUE.
- C14: `AGENTS.local.md` is not read. TRUE.

### B1. Subagent precision: **ADOPT**

- **Verified?** Only partly from docs. C3 is PARTIAL: background subagents get a filtered tool set. The precision rules (`reply-to-boyan.md:35-42`) are practice, not doc claims. The ADOPT verdict rests on our own measurements, not on Boyan's anecdote.
- **Our state:**
  - Subagents use 55.4% of all tokens, 70.1% of messages and 62.3% of cache writes (token-report). About 96% of subagent tokens are cache reads (4.42 B of 4.59 B), and the report does not compute cost.
  - 80% of large Reads (353 of 439 over 20 KB) happen inside subagents.
  - Agents audit: 27 of 37 descriptions have no "when not". 0 of 37 have a read scope. 4 of 37 have a hard budget. 6 of 37 have a return contract.
  - Tool errors: critic 49, oracle 16. These counts do not include TLDR intercept rows.
- **Change:** A5.1-A5.10 plus the A6.6 ratchet. Give each agent the same template:
  - a description with "when" and "when not"
  - `tools:` that agrees with the body
  - a read scope
  - an N-call budget with `status: partial`
  - a JSON return contract

  Start with critic, scout, kraken and oracle. They have 460 of the 904 subagent runs (51%), and 90% of the 511 named-agent runs.

### B2. Move detail out of the root CLAUDE.md: **ADOPT (narrow)**

- **Verified?** Yes. C4 (lazy load of subdirectory files) and C5 (eager `@` imports) are TRUE.
- **Our state:** We already do this with `paths:` rules and the rule-router. The always-loaded set is 25,774 of 26,000 chars. The harness has 4 CLAUDE.md files in subdirectories, mostly `.ralph` copies (metrics scan). `@AGENTS.md` (2,125 chars) and `@CONTEXT.md` (4,024 chars) are eager imports (C5).
- **Change:** Delete `CLAUDE.md:17-18` (hook build and vitest, about 170 chars). These lines repeat `hook-dev-lifecycle.md:12, 14, 46-47`, which already loads on `.claude/hooks/**` (`hook-dev-lifecycle.md:1-3`). The deletion makes room for A3.9. Do not add new CLAUDE.md files to subdirectories. `paths:` rules already do the same job, and a second mechanism adds one more surface to keep in sync.

### B3. Per-agent model and effort: **SKIP** (the Sonnet lever) / **WATCH** (the Opus lever)

- **Verified?** C1 and C2 are TRUE.
- **Our state:**
  - 25 of 25 Sonnet agents pin `effort: high`, and the drift check passes.
  - Subagent messages are 38.6% medium (metrics). The baseline that led to the rule is 46 of 99 Sonnet runs at medium.
  - Opus agents have no pin. Two effort sources exist: user `settings.json:837` (`medium`) and repo `.claude/settings.json:828` (`high`). No probe shows yet which source an unpinned agent gets (Q6).
- **Verdict:** Boyan's "Sonnet at `effort: medium`" (`reply-to-boyan.md:22-23`) is **SKIP** under Dave's rule. For Opus agents, C2 supports medium on Opus 5.5. That lever is **WATCH** until Q6 is answered.
- **Change:** None beyond A1.6, A2.1 and A3.5, which make the high pin visible at spawn time.

### B4. `/compact` over `/clear`: **SKIP** (already practice)

- **Verified?** C11 and C6 are TRUE.
- **Our state:** In 30 days: `/clear` 4 times, `/compact` 15 times, 14 manual compactions and 0 automatic ones. `~/.claude/CLAUDE.md:181` already says "manual compaction only". Only 3 of 324 main sessions changed model, and 3 changed effort.
- **Change:** None.

### B5. Cache hygiene and TTL: **WATCH**

- **Verified?** C8, C9 (on the prompt-caching page) and C10 are TRUE.
- **Our state:** The cache hit ratio is 97.5% for main sessions and 96.6% for subagents. Subagents write only the 5-minute tier (152.9 M tokens). Main sessions write the 1-hour tier (92.3 M tokens). A subagent that stays idle for more than 5 minutes pays for a full rewrite. `promptCacheTtl` and `subagentPromptCacheTtl` are not set anywhere.
- **Why WATCH:** We have not measured how long subagents stay idle. A 1-hour write costs more than a 5-minute write, so the gain depends on those idle gaps.
- **Change:** None now. First measure one week of subagent idle gaps and cache writes. Then decide on a trial of `subagentPromptCacheTtl`.

### B6. Tool search regime: **WATCH**

- **Verified?** C12 and C13 are TRUE.
- **Our state:** `ANTHROPIC_BASE_URL` is not set. `ENABLE_TOOL_SEARCH` is `"auto:5"` in `~/.claude/settings.json:7` and `.claude/settings.json:4`. [Speculation] `auto:5` defers schemas only above a threshold of context share, so a small MCP set can still load at the start.
- **Change:** None until the docs answer Q7. If `auto:5` loads small MCP sets at the start, MCP pruning can matter for us.

## 4. Part C: corrections to the Boyan reply

| # | Line | What the reply says | Problem | Suggested fix |
|---|---|---|---|---|
| C-1 | `reply-to-boyan.md:7-9` | "I don't have instrumented before/after numbers" | We now have 30 days of numbers. | Add: subagents use 55% of tokens (mostly cache reads; cost not computed) and 70% of messages. The cache hit ratio is 97.5% for main sessions and 96.6% for subagents. There were 0 automatic compactions. |
| C-2 | `:22-23` | "Sonnet at `effort: medium` for mechanical work" | This contradicts our policy. Our baseline (46 of 99 Sonnet runs at medium) caused us to pin Sonnet at high. | Say that we pin Sonnet at high. Offer C2 (Opus 5.5 at medium) as the saving. |
| C-3 | `:24-25` | Effort "is the bigger of the two levers — most models default to `high`" | Not verified. No claim in C1-C14 covers model defaults. | Check the model-configuration docs. If they do not confirm it, delete the clause or mark it unverified. |
| C-4 | `:37-38` | "omit it and the agent inherits every tool in the session" | C3 is PARTIAL. Background subagents get a filtered set. | Add "(foreground agents; background agents get a filtered set)". |
| C-5 | `:29-33`, `:151-152` | Isolation is "the real win", "largest and most reliable" | Our data shows that subagents are not a free saving. They use 55.4% of tokens (mostly cache reads; cost not computed), and kraken runs up to 559 calls and 2,115 KB. The saving comes from precision, not from isolation alone. | Reword: isolation keeps the main context clean, but an agent without limits can use more than it saves. The budget and the read scope give the saving. |
| C-6 | `:144-145` | Hooks "don't sit in the prefix. Not much there to reclaim." | Not verified. Hooks that return context add tokens to the conversation. Examples: our inject rules (`on-demand-rules.md:6-7`), MEMORY MATCH and the TLDR Read intercepts (agents audit: 12 or more per agent). | Say: a hook that only gates costs nothing, but a hook that injects context costs tokens. |

The "Keeps the cache" list (`:113-116`) and the managed-policy paths (`:76`) are not verified either, except for the CLAUDE.md edit (C6). Mark them as unverified or cut them.

## 5. Ranked execution order

| # | Item | Size | E2E proof (AGENTS.md table) |
|---|---|---|---|
| 1 | A6.2 + A6.3 post-commit fix | S | Add T9 to `scripts/sync-to-active-cursor.test.sh`. A feature-branch commit must print "Sync skipped", and a main commit must write the log. Save the PASS/FAIL lines to `.claude/cache/e2e/2026-09-30-post-commit.txt`. |
| 2 | A3.1-A3.3, A3.5-A3.7 + B2 (always-loaded set) | S | `node scripts/rules/context-budget-guard.mjs --repo` ≤ 26,000. Then run `claude -p "How does forward sync work in this repo?" --output-format json` with Read, Grep, Glob, Bash and PowerShell disallowed. The answer can then come only from the loaded context. It must say "only from main". A3.5 goes in only after Dave's yes. |
| 3 | A1.1-A1.3 + A2.2-A2.5 + A2.14 (sync and CodeRabbit rules) | S | After the sync, run a headless session that executes `node scripts/github/coderabbit-status.mjs 67` (`--allowedTools` set). Confirm that `~/.claude/logs/rule-router.jsonl` logged the `pr-coderabbit-loop.md` fire. Then confirm that the answer does not suggest `@coderabbitai review`. Record `wc -c` before and after for each path-scoped rule. The net change for `git-sync-workflow.md` must be ≤ 0. |
| 4 | A6.1 agent-model-guard | S | Run the probe first. Then `npm run build` and send 5 payloads: project agent → allow, `plugin-dev:agent-creator` → allow, `scout` → allow, `claude` → allow, unknown → deny. Save to `.claude/cache/e2e/2026-09-30-agent-guard.json`. |
| 5 | A6.6 agent-body ratchet | S | Run it and read the baseline count (8/15/7). Make it fail on purpose with one fixture agent. |
| 6 | A5.1-A5.4 critic, scout, oracle, kraken | M | For each agent, run `claude -p` so that it spawns the agent on a small task. The transcript must have 0 "No such tool" errors (TLDR intercept rows excluded) and stay within the call budget. Then run `check-agent-model-drift.mjs .`, `audit-descriptions.mjs` and the A6.6 ratchet. |
| 7 | Q6 effort probe, then A2.1, A2.7, A1.6, A3.5 (effort visibility) | S | Probe: parent at `--effort high`, global `effortLevel` medium, one unpinned Sonnet agent. Read `"effort"` in the subagent transcript and record the parent setup. Then run `claude -p` with an ad-hoc Sonnet spawn. The subagent transcript must show `"effort":"high"`. |
| 8 | A6.5 coderabbit-status | XS | Add a case to `coderabbit-status.test.mjs`, then run it again on PR 67. The output must name the rate limit. |
| 9 | A6.4 land-pr temp-worktree sync | M | Add a scenario to `sync-to-active-cursor.test.sh`. Then run `land-pr.ps1 -CleanupOnly` with the primary checkout off main. The output must say "synced", and no `.sync-quarantine/<ts>` directory may appear. |
| 10 | A4.1-A4.5 architecture docs and Braintrust leftovers | M | No AGENTS.md row applies. Proof: `grep -rniE braintrust` over `.claude/docs/architecture` and the A4.5 files returns only RETIRED lines, plus the `stale-scan` skill output. The `artifact_index.py` columns wait for Dave. |
| 11 | A6.7 + A6.8 tldr-code skill | S | Skill row: `claude -p` confirms that the skill loads, then `audit-descriptions.mjs`. A6.8: save the T1-T5 output. |
| 12 | A6.9 archive `~/.claude/hooks/src` | XS | After Dave's yes: `Test-Path ~/.claude/hooks/src` is False, the archive path exists, and `npm run build` in the repo `.claude/hooks` passes. Then run `/sync-drift`. |
| 13 | A5.5-A5.8 other agents | M | Same check as row 6. |
| 14 | A2.6 sync-known-gaps | XS | First commit the `modelSettings` amendment. Then use the rule-row proof. |
| 15 | All "could" items (A1.7-A1.9, A2.10-A2.13, A3.8-A3.9, A4.6, A5.9-A5.11) | S | Rule, skill or agent row: `claude -p` plus the ratchets. A5.11 also needs the `--agents` schema check. |

## 6. Unresolved questions

1. Does Claude Code reject an unknown `subagent_type` on its own? If yes, delete `agent-model-guard` instead of widening it (A6.1). Recommendation: run the probe first.
2. On CodeRabbit Essentials, can a new push or `@coderabbitai full review` get past the rate limit? Check the docs before you write that line in A1.1.
3. For the land-pr sync, choose the temp worktree (no test change) or relax the `sync-to-active.sh:76` guard (reverses T3). Recommendation: the temp worktree.
4. Does the `--agents` JSON accept an `effort` key? The answer gates A5.11.
5. There are 10 main-session messages and 49 subagent messages on `claude-haiku-4-5`, although the rule says no haiku. What is the source? [Speculation] Internal calls such as title generation.
6. Does an unpinned agent get the parent session's `--effort`, or the settings `effortLevel`? Which wins, the project `effortLevel` (`.claude/settings.json:828`, high) or the user settings (`~/.claude/settings.json:837`, medium)? The answer gates the full A2.1 text and the Opus lever (B3). Recommendation: run the §5 row 7 probe, then leave Opus agents unpinned if C2 holds.
7. What does `ENABLE_TOOL_SEARCH: "auto:5"` do exactly? Check the docs. The answer gates the B6 verdict.
8. The subagent thread still has 8,246 `claude-opus-5` messages and 3,014 on `opus-5-5`. Are all of them from before the upgrade, or does something still pin `opus-5`?
9. `claude-fable-5-1` has 1,007,399 uncached input tokens in subagents and 285,910 in main sessions. That is several times the total for all other models (metrics note). What causes it? WATCH.

## Critique points not taken

- All 22 points are taken. Point 19 is adapted: the check names the tools to disallow (`--disallowedTools` for Read, Grep, Glob, Bash, PowerShell) instead of `--allowedTools ""`, because the empty-list behavior is not verified. [Speculation]
- Point 12 is taken as the audits give it. This pass did not re-read the A4.5 files, and the row says so.
