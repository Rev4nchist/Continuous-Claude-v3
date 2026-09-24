# Tool-Tier Policy — Hooks, MCPs, Skills
Created: 2026-04-26 | Author: architect | Branch: feature/system-coherence
Inputs: agent-skill-map.md (post-`f9c7c59`), `~/.claude/settings.json` (registered hooks), `~/.mcp.json`, `~/.claude/mcp.json`, `~/.claude.json` mcpServers block, `.claude/rules/cli-integration-strategy.md`, `.claude/rules/hook-dev-lifecycle.md`

> Status: **Design only**. Companion to `composition-design.md`. No code changes proposed.

---

## 1. Three Tiers — definitions

CCv3 has three places to put a capability. Each has a clear ownership rule. Confusion happens when one capability lives in two places.

### 1.1 Hooks — own enforcement and always-on context injection

**Definition.** Code that runs automatically as part of the Claude Code event loop. The model does not invoke a hook; the runtime fires it on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, or `SessionEnd`. (`Stop` fires once per assistant turn and was first used on this machine by `ccdd14b`; `SubagentStop` exists too but is deliberately unused — subagents dominate hook firings here.) Hooks talk to the model only via two channels: (1) `permissionDecision: allow|deny` (gate) and (2) `additionalContext` (injector). They are the *only* tier that can deny a tool call.

**Frontmatter `kind` field** (Phase 3 of the system-coherence plan, see `i-have-a-new-abstract-quail.md` lines 142-147):

| `kind` | Behavior | Examples |
|--------|----------|----------|
| `gate` | PreToolUse with allow/deny decision | `package-install-guard.ts`, `plan-to-ralph-enforcer.ts`, `agent-model-guard.ts`, `explore-to-scout.ts`, `no-haiku-enforcer.ts`, `ralph-delegation-enforcer.ts` |
| `injector` | PostToolUse or PreToolUse adding `additionalContext` | `tldr-context-inject.ts`, `tldr-read-enforcer.ts`, `react-perf-context.ts`, `pre-tool-knowledge.ts`, `memory-awareness.ts`, `epistemic-reminder.ts`, `signature-helper.ts` |
| `orchestrator` | Multi-step state mgmt across hook events | `maestro-state-manager.ts`, `maestro-detector.ts`, `ralph-task-monitor.ts`, `ralph-progress-inject.ts`, `ralph-watchdog.ts`, `plan-exit-tracker.ts`, `roadmap-reconcile.ts`, `roadmap-completion.ts` |
| `telemetry` | Logs/observes only; never blocks | `hook-health-monitor.ts`, `mcp-activity-tracker.ts`, `telemetry-tracker.ts`, `periodic-extract.ts`, `session-outcome.ts`, `heartbeat.mjs`, planned `hook-trace.ts` |

(103 source files in `.claude/hooks/src/*.ts`. ~70 are registered in `~/.claude/settings.json`. The plan tracks the 60 zombie `.mjs` files for Phase 2 cleanup.)

**Hook contract:**

- *Always-on*. The user does not type to invoke a hook. It fires when the runtime says it fires.
- *Fast*. Hook timeouts in `settings.json` range from 2s to 60s. Most are 5s.
- *Fail-open by default*. A hook that crashes should not break the session. The plan-to-ralph-enforcer comment explicitly says "Fails open on ALL errors" (`.claude/hooks/src/plan-to-ralph-enforcer.ts:18`).
- *Bounded scope*. One hook = one concern. The plan endorses this in Decision 1: "Stay specialized. One hook per concern. Latency irrelevant; reliability is paramount."

### 1.2 MCPs — own external service access

**Definition.** Model Context Protocol servers that expose tools to the model. The model calls MCP tools by name (e.g. `notion-fetch`, `linear-create-issue`). MCPs are the only tier that can wrap a credentialed external service that the main session does not have a CLI for.

**MCP inventory across all three configs (post-cleanup):**

| Server | Config file | Type | Purpose |
|--------|-------------|------|---------|
| `git` | `~/.claude/settings.json` | stdio (uvx) | Local git ops (used rarely; bash `git` is preferred) |
| `fetch` | `~/.claude/settings.json` | stdio (uvx) | Generic URL fetch fallback |
| `pageindex` | `~/.claude/settings.json` + `~/.mcp.json` + `~/.claude/mcp.json` | stdio (npx) | Document search (long PDFs) |
| `nia` | `~/.mcp.json` + `~/.claude/mcp.json` | stdio (uv) | External-source semantic indexing |
| `context7` | `~/.mcp.json` + `~/.claude/mcp.json` | stdio (npx) | Real-time library/SDK docs |
| `github` | `~/.mcp.json` + `~/.claude/mcp.json` | stdio (npx) | GitHub API (issues, PRs, search) |
| `playwright` | `~/.mcp.json` + `~/.claude/mcp.json` | stdio (npx) | Browser automation (Tier 1) |
| `shadcn` / `shadcnspace-mcp` | `~/.mcp.json` + `~/.claude/mcp.json` | stdio | Component-library blocks |
| `next-devtools` | `~/.mcp.json` + `~/.claude/mcp.json` | stdio (npx) | Next.js devtools |
| `excalidraw` | `~/.claude/mcp.json` | stdio (node) | Architecture diagram canvas |
| `idearalph` | `~/.claude/mcp.json` | stdio (node) | IdeaRalph startup-ideation co-founder |
| `Neon` | `~/.claude.json` mcpServers | http | Neon Postgres ops |
| `linear` | `~/.claude.json` mcpServers | http | Linear issue tracker |
| `sentry` | `~/.claude.json` mcpServers | http (sse) | Sentry error monitoring |
| `exa` | `~/.claude/mcp.json` | http | Exa code-context search |
| (claude.ai bundled) | n/a | bundled | TurboTax, PageIndex, claude.ai Notion bridge, Notion (cloud), Sentry MCP (cloud) |

(Disabled / future: `firecrawl`, `morph`, `perplexity`, `ast-grep`, `repoprompt`, `qlty` — these have entries with `disabled: true`.)

**MCP contract:**

- *External resource access*. The line is "needs auth, lives off the local box, has a vendor-maintained API". When in doubt, ask: does this service have its own auth model? If yes, MCP.
- *Vendor-shipped is preferred*. `cli-integration-strategy.md` step 3 says: "Accessible via MCP? Use **MCP integration**. Best when the tool vendor ships an MCP server."
- *CLI is sometimes better*. Same rule continues: "CLI is often better than MCP for scripted/batch operations (32x fewer tokens)." Match the volume — high-volume scripted = CLI; low-volume interactive = MCP.

### 1.3 Skills — own multi-step workflows and behavior contracts

**Definition.** Markdown documents the model reads when matched. Activated by the `skill-activation-prompt` hook (which uses `skill-rules.json` + LLM validation), or the `guardrail-enforcer` (which blocks until certain skills load on certain prompt classes), or by user-invoked slash commands like `/build`, `/fix`, `/maestro`.

**Skill contract:**

- *User-prompted*. Skills usually trigger on a user prompt that matches their `metadata.keywords` or `intentPatterns`. (Some auto-load via `react-perf-context` or similar context-injection hooks.)
- *Multi-step*. A skill should justify its load by encoding more than one step. A one-step skill is usually redundant with a hook injection.
- *Behavior contract*. The skill body is what the model reads to do the work — it is the playbook, not the tool. Tools are spawned by the skill (Bash, Task, Edit), but the logic lives in the markdown.

(109 active skills post-`f9c7c59` — see `agent-skill-map.md` Counts table.)

---

## 2. Decision Matrix — where does a new capability go?

When adding any new capability, walk this matrix top-to-bottom. The first row that matches dictates the tier.

| Capability shape | Tier | Why | Example |
|------------------|------|-----|---------|
| **Always-on context injection** triggered by tool use | Hook (PostToolUse `additionalContext`) | The user does not request it; it has to fire automatically on every Edit/Read/Grep | `tldr-context-inject` (injects call graph before agent calls), `react-perf-context` (auto-loads react-perf skill on `.tsx` reads), `epistemic-reminder` (warns after Grep), `pre-tool-knowledge` (knowledge tree context before agent spawn) |
| **Per-tool gate** (allow/deny) | Hook (PreToolUse `permissionDecision`) | Only hooks can deny | `plan-to-ralph-enforcer` (blocks Edit/Write after plan approval unless Ralph), `package-install-guard` (blocks malicious package installs), `agent-model-guard` / `no-haiku-enforcer` (blocks haiku model), `explore-to-scout` (forces scout instead of Explore) |
| **State across hook events** | Hook (orchestrator with state file) | Multi-event coordination needs a shared state file in `$TEMP` | `maestro-state-manager` + `maestro-detector` (track maestro phase progress), `plan-exit-tracker` + `plan-to-ralph-enforcer` (plan-approved state file), `ralph-task-monitor` + `ralph-watchdog` |
| **External authenticated service** with vendor-maintained API | MCP | Auth, rate limits, API surface lives elsewhere | Notion (claude.ai bundled), Linear (`mcp.linear.app`), Sentry (`mcp.sentry.dev`), Neon (`mcp.neon.tech`), GitHub (npx server) |
| **External authenticated service** with batch/scripted use | CLI + skill + safety rule | 32x token savings, predictable structured output | `vercel`, `railway`, `gh`, `linearis`, `sentry-cli`, `neonctl`, `tldr`, `opencli`, `qlty` |
| **Web platform with browser login** | OpenCLI adapter | Reuses Chrome cookies, zero API keys | Twitter, Reddit, HN, LinkedIn (44 platforms; see `opencli list`) |
| **User-prompted multi-step workflow** | Skill | Skill body is the playbook the model reads | `build`, `fix`, `release`, `tdd`, `refactor`, `maestro`, `ralph`, `security`, `test`, `review` |
| **One-step methodology guide** | Skill (lightweight) | The skill body is short but the trigger is real | `databases` (guardrail), `code-review` (guardrail), `systematic-debugging` (guardrail), `notion-bridge`, `tldr-code` |
| **Reusable library called by other components** | `.claude/hooks/src/lib/` (Phase 3) | Imported by hooks; not registered as a hook itself | `daemon-client.ts`, `skill-router.ts`, `transcript-parser.ts`, `skill-validation-prompt.ts`, `hook-trace.ts` |
| **Per-platform conventional script** | Plain script under `scripts/` | Not a hook, not an MCP — just a CLI helper | `scripts/cdp.mjs`, `scripts/sync-to-active.sh`, `scripts/dev-cleanup.mjs`, `scripts/audit_hook_state.mjs` (planned Phase 2) |

### Edge cases

- **Reusable subroutine called by both hooks and skills.** Put it in `lib/` (the hook side imports it directly; the skill side calls it via Bash with a small wrapper). Never duplicate the logic in two places.
- **A skill that needs to deny a tool.** Skills cannot deny tools. If a skill requires a deny, that needs a paired hook that the skill can reference. Example: `databases` skill warns about destructive queries; `package-install-guard` hook actually denies the install.
- **An MCP that has a CLI equivalent.** Pick one. The pattern in `cli-integration-strategy.md` says CLI for high-volume; MCP for interactive. Document the policy in the skill that wraps the tool.

---

## 3. Audit Table — existing overlaps and resolutions

This table catalogs *real* overlap-cases in the current codebase and documents the resolution. None of these are theoretical — each has at least one file in two tiers.

| # | Overlap | Tier 1 (involved) | Tier 2 (involved) | Resolution | Verdict |
|---|---------|-------------------|-------------------|------------|---------|
| 1 | **Package install** | `package-install-guard` hook | `nia` MCP `index` tool | Hook is the **gate** (security; blocks malicious installs at PreToolUse:Bash). MCP is the **indexer** (read-only catalog of indexed sources). Different concerns, no real conflict. The hook never runs on `nia.index()` because nia.index does not invoke `pip`/`npm`. Document in `package-install-safety.md` rule (already done). | Resolved — distinct concerns |
| 2 | **TLDR code analysis** | 9 TLDR hooks (auto-injection: `tldr-context-inject`, `tldr-read-enforcer`, `session-start-tldr-cache`, `smart-search-router`, `impact-refactor`, `arch-context-inject`, `edit-context-inject`, `post-edit-diagnostics`, `signature-helper`) | `tldr-code` skill (user-prompted teaching layer); `tldr-stats` skill (newly wired in `f9c7c59`) | Hooks own automatic injection. Skill is the user-prompted teaching layer that documents CLI commands. The recently-added "Canonical entry point" callout in `tldr-code/SKILL.md:15` codifies this split: extend the skill OR a hook, never add new `tldr-*` sub-skills. | Resolved — codified post-`f9c7c59` |
| 3 | **Notion bridge** | `notion-bridge` skill (multi-step bridge protocol — read Active Context, write to handoff queue, update sprint state) | claude.ai Notion MCP (14 tools: search, fetch, create-pages, update-page, etc.) | Skill orchestrates; MCP provides the underlying tools. Skill body says "Always load `references/bridge-schema.md` before any write operation" — that workflow logic lives in the skill, not the MCP. | Resolved — skill calls MCP tools |
| 4 | **Memory recall and store** | `memory-awareness` hook (proactive injection on UserPromptSubmit; `MEMORY MATCH` preview block) | `memory` skill (canonical user-invocable interface; documents `recall_learnings.py` and `store_learning.py`) | Skill is the manual interface and contract; hook is the proactive injection. Phase 4 plan tightens the hook (raise threshold to 0.85 RRF, preview-then-inject pattern) to reduce noise — does not change the split. | Resolved — distinct entry points |
| 5 | **Skill activation** | `skill-activation-prompt` hook (UserPromptSubmit; reads `skill-rules.json`, suggests skill via `additionalContext`) | `find-skills` skill (user-invocable: "which skill should I use for X?") | Hook fires automatically on every prompt. Skill is the user-invocable variant for cases where the hook missed. Phase 4 plan adds embed-and-match fallback to the hook to reduce skill-routing brittleness. | Resolved — hook is automatic, skill is manual |
| 6 | **Browser automation** | `playwright` MCP (Tier 1 for navigate/click/snapshot) | `browser-dev-cycle` skill (decision tree across 5 tiers); `browser_*` Playwright MCP tools; `cdp.mjs` CLI script (Tier 2: perf, network, a11y); `playwright-cli` (Tier 1.5); test runner (Tier 4); `sentinel` agent (driven QA) | Skill is the multi-tier policy. Each tier has its own tool. Match the question to the tier per the table in `browser-automation.md` rule. No real conflict — pure documentation/routing concern. | Resolved — `browser-automation.md` rule codifies tiers |
| 7 | **GitHub access** | `github` MCP (npx, query API tools) | `gh` CLI + `gh` skill | CLI for batch / scripted ops (32x fewer tokens). MCP for interactive single-issue lookups. The `cli-integration-strategy.md` rule pins this. | Resolved — both kept, split by use-case |
| 8 | **Sentry deploy/release** | `sentry` MCP (cloud) | `sentry-cli` + `sentry-cli` skill + 3 hooks (`sentry-error-context`, `sentry-deploy-release`, planned `sentry-monitor-context`) | Hook injects deploy context after `vercel deploy` Bash. CLI runs the deploy. MCP for query/triage. Three tools, no overlap. `sentry-safety.md` rule gates destructive CLI ops. | Resolved — distinct concerns |
| 9 | **Linear** | `linear` MCP (cloud) | `linearis` CLI + `linear-cli` + `linearis` skill + `deployer` agent + `linear-branch-context` hook | Hook injects context when a Linear issue ID appears in a branch name. CLI for batch / scripted ticket ops. MCP for one-off lookups. Same shape as Sentry. `linear-safety.md` rule gates destructive ops. | Resolved — distinct concerns |
| 10 | **Knowledge tree** | `tree-invalidate` hook (PostToolUse:Edit/Write — marks tree stale), `session-start-init-check` hook (auto-regen on session start), `pageindex-watch` hook | `knowledge-tree` skill (user-invocable: "where to add tests?") | Hooks keep the tree fresh; skill answers tree queries. Both speak the same `.claude/knowledge-tree.json` contract. Skill body cites the hook architecture explicitly. | Resolved — hook=freshness, skill=query |
| 11 | **ROADMAP sync** | 4 hooks (`roadmap-reconcile`, `roadmap-completion`, `git-commit-roadmap`, `prd-roadmap-sync`) | `roadmap` skill | Hooks auto-update ROADMAP.md from commits/tasks/PRDs. Skill is the manual edit/query interface. | Resolved — auto vs manual |
| 12 | **Memory sub-skills** | n/a (no hook overlap) | `memory` (canonical), `recall`, `remember`, `recall-reasoning`, `memory-curate` | Five skills for one concept. Per `memory/SKILL.md:10`, the four sub-skills are pointer stubs to the canonical. Verification recommended (R9 in composition design). | Documentation pattern; verify |

### Resolution patterns observed

Looking at #1-12, three resolution patterns emerge:

1. **Auto vs manual.** Hook fires automatically; skill is the user-invocable variant for the same domain. (Memory, knowledge tree, ROADMAP, skill activation.) Each tier has its own contract; they don't overlap, they complement.
2. **Tier by volume.** CLI for batch, MCP for interactive single calls. (GitHub, Sentry, Linear.) Pinned by `cli-integration-strategy.md`.
3. **Gate vs index.** Hook owns the deny path; the MCP/CLI owns the doing-the-work path. (Package install, sentry safety rules, neon safety rules, linear safety rules.)

When evaluating a *new* overlap, ask which pattern fits. If none fit cleanly, the overlap is probably a real conflict — see anti-patterns below.

---

## 4. Anti-Patterns

These are the shapes that break the tier model. Catching them early is cheap; catching them after they ship multiplies cost.

### A1. Skill that duplicates a hook

**Symptom.** A skill body explains "to do X, run command Y", where command Y is something a hook would inject automatically.

**Real example.** The four archived TLDR sub-skills (`tldr-router`, `tldr-overview`, `tldr-deep` — see `.claude/skills/_archived/2026-04-26-tldr-cleanup/README.md`). Each instructed users to run a CLI subcommand that the 9 TLDR hooks already invoke automatically. The skills had no activation path because they were redundant; they were archived in `f9c7c59`.

**Codified rule.** From `tldr-code/SKILL.md:15`: "Don’t add new `tldr-*` sub-skills; extend this one or extend a hook."

**Generalize.** If a hook already does the work automatically, do not add a skill that asks the user to do it manually. Extend the hook.

### A2. MCP server when a CLI suffices

**Symptom.** Adding an MCP for a tool that has a vendor-shipped CLI, when the use case is scripted/batch.

**Real example.** Considered for the `qlty` lint tool — vendor ships both. The `qlty` MCP server in `~/.claude/settings.json` is `disabled: true`; the `qlty` skill points at the CLI instead. 32x token savings according to `cli-integration-strategy.md`.

**Codified rule.** `cli-integration-strategy.md` Decision Tree step 1: "Native CLI exists? Install it, create skill + rule, use Pattern 1 (Direct Bash + Skill + Rule). This is the gold standard." MCP is step 3, after CLI and OpenCLI.

### A3. Hook that does too much (orchestrator masquerading as gate)

**Symptom.** A single hook handles allow/deny + state mgmt + injection across multiple events. Hard to test, hard to reason about, slow.

**Real example.** `session-start-parallel.ts` (251 lines, currently archived per Decision 3 of the plan). Phase 4 splits it into `session-start-context-loaders.ts` and `session-start-memory-loaders.ts`, each ≤120 lines.

**Codified rule.** Plan Decision 1: "Stay specialized. One hook per concern. Latency irrelevant; reliability is paramount."

### A4. Skill body that hard-codes paths to hook-managed state

**Symptom.** A skill reads or writes `$TEMP/claude-*-<sessionId>.json` directly, racing with the hook that owns it.

**Risk.** Concurrent writes corrupt session state; the hook can be wrong about active phase.

**Mitigation.** If a skill needs to know hook state, the hook must expose it via `additionalContext` (read-only signal to the model) or via a documented API in `lib/`. Skills do not write to `$TEMP/claude-*` files.

**Verified absent.** Grep across all 109 active skills shows none read `$TEMP/claude-*-` paths. Good.

### A5. Two hooks that both gate the same tool with conflicting decisions

**Symptom.** PreToolUse:Bash has `package-install-guard` (allow if safe) and another hook that says deny. The order in `settings.json` decides who wins.

**Risk.** Order-dependent allow/deny is fragile.

**Mitigation.** When two gate-hooks target the same tool, document the priority and the joint contract. Prefer composing into one hook rather than ordering two.

**Real example.** `agent-model-guard.ts` and `no-haiku-enforcer.ts` both block haiku at PreToolUse:Agent — the map flags this as "Redundant enforcement". R5 in composition design proposes consolidation.

### A6. MCP that requires a vendor app to be running, treated as always-available

**Symptom.** A skill assumes the MCP works, but the MCP only works if a desktop app is running.

**Historical example.** The `paper` MCP (retired 2026-09-23) required the Paper.design desktop app to be running. With the app closed, every tool call failed.

**Mitigation.** Skills that depend on such MCPs should explicitly check availability before using, and say so at the top of the skill body.

### A7. Adding a skill for a single-step instruction

**Symptom.** A skill body that boils down to "run this one command".

**Why bad.** Skills cost context tokens to load. A one-liner does not justify the load. Either fold into a related skill, or move to a rule (`.claude/rules/*.md`), or codify in a hook.

**Real example.** Considered absent — most skills justify their load. Watch for this when adding new `*-cli` skills.

---

## 5. Open Questions for User

1. **Hook frontmatter `kind` field.** Section 1.1 lists the four kinds (gate, injector, orchestrator, telemetry) per the plan Phase 3 (`i-have-a-new-abstract-quail.md` line 142-147). The frontmatter validator (Phase 3 deliverable) checks `kind` matches actual behavior (gates have `permissionDecision`, injectors have `additionalContext`, orchestrators read state files). Confirm this scheme is the canonical source of truth, not a parallel `subdir/` reorg.
2. **MCP cleanup.** Several MCP entries are `disabled: true` (`firecrawl`, `morph`, `perplexity`, `ast-grep`, `repoprompt`, `qlty`). Should they be deleted, or kept as future-use placeholders? Default proposal: delete from active configs; preserve in a `~/.claude/_archived/mcp.json` for revival.
3. **Three MCP config files** (`~/.claude/settings.json` mcpServers, `~/.mcp.json`, `~/.claude/mcp.json`, `~/.claude.json` mcpServers). The MEMORY.md note from 2026-03-09 documented the priority order: `~/.mcp.json` > `~/.claude/mcp.json` > `~/.claude/settings.json`. Is consolidating to one file desirable, or does the layered approach serve a real need?
4. **`paper` MCP availability.** Closed 2026-09-23: the `paper` MCP and the `paper-design` skill were retired.
5. **Out of scope confirmation.** This document does not propose changes to: any existing hook source code, any skill that uses an MCP, the `cli-integration-strategy.md` rule (which already codifies the CLI-first decision tree), or the canonical-skill consolidation pattern for memory.

---

## 6. Success Criteria

This tool-tier policy is *successful* when:

- [ ] Every new capability landing in CCv3 fits one row of the matrix in section 2.
- [ ] No hook source files mix two `kind` categories (Phase 3 frontmatter validator passes).
- [ ] Every MCP server config has a documented purpose in section 1.2.
- [ ] Every skill listed in `agent-skill-map.md` falls under one of the contracts in section 1.3.
- [ ] The audit table in section 3 has zero new entries on the next agent x skill map regen.
- [ ] No anti-patterns from section 4 show up in the next 4 weeks of session-end extraction reports.

---

## 7. References

These rules already codify pieces of this policy. This document does not duplicate their content; it cites them.

- `.claude/rules/cli-integration-strategy.md` — CLI vs MCP vs OpenCLI decision tree (sections 1-6) and current 21-tool inventory
- `.claude/rules/hook-dev-lifecycle.md` — full hook workflow (scaffold, build, register, test, sync, verify) and event-type contracts
- (`nia-first-external.md` was removed 2026-09-23: the Nia MCP server was down and the rule was followed about 1 time in 260.)
- `.claude/rules/opencli-first.md` — OpenCLI for structured web data (44 platforms)
- `.claude/rules/plan-to-ralph-enforcement.md` — gate-hook example with bypass-permissions interaction caveat
- `.claude/rules/package-install-safety.md` — gate-hook example with 4-layer security check
- `.claude/rules/sentry-safety.md`, `.claude/rules/linear-safety.md`, `.claude/rules/neonctl-safety.md`, `.claude/rules/railway-deploy.md` — destructive-CLI gating patterns (skill body + rule + agent quarantine)
- `.claude/rules/browser-automation.md` — 5-tier browser tool decision tree
- `.claude/rules/windows-platform.md` — Windows-specific quirks affecting hook + MCP config (`.claude.json` race window, `python3` alias, `npx` cmd /c wrapper)
- `.claude/rules/agent-model-selection.md`, `.claude/rules/no-haiku.md` — model-selection gate hook context
- `.claude/rules/proactive-delegation.md` — agent vs skill routing rules

Companion design doc:
- `.claude/docs/composition-design.md` — Agent x skill pairing decisions; references this policy for the hook/MCP/skill split

Plan and inventory:
- `C:/Users/david.hayes/.claude/plans/i-have-a-new-abstract-quail.md` — Phase 5 deliverables
- `.claude/docs/agent-skill-map.md` — full agent x skill cross-product
- `~/.claude/settings.json` — registered hooks
- `~/.mcp.json`, `~/.claude/mcp.json`, `~/.claude.json` mcpServers — MCP server configs
