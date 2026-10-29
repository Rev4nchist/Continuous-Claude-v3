# Composition Design — CCv3 Agent x Skill Pairing
Created: 2026-04-26 | Author: architect | Branch: feature/system-coherence
Inputs: `.claude/docs/agent-skill-map.md` (post-cleanup), commit `f9c7c59` archive READMEs, Phase 5b brief

> REMOVED: the `maestro` agent, the `/maestro` skill and the maestro hooks (`maestro-detector`, `maestro-enforcer`, `maestro-state-manager`, `maestro-cleanup`, `session-start-recovery`) no longer exist. This design doc is a 2026-04 snapshot. Treat every maestro reference below as history, not as a live component.

> Status: **Design only** per the plan Phase 5 gate. No code or skill body changes proposed for execution in this document. All recommendations are intent for a follow-up Phase 5c plan that the user must approve before any execution.

---

## 1. Thesis

**Skills own behavior. Agents own isolation.** — endorsed.

A *skill* is data the running model reads (the SKILL.md body, plus `references/`). It changes the model behavior in the current context window without paying for a new conversation, new system prompt, or new tool spin-up. A *skill body is cheap to load* and *expensive to relocate* — its cost is context tokens, not a process boundary. That makes it the right shape for: pipelines, decision trees, methodology guides, contracts, prompt scaffolds, anything the *currently running model* needs to know to do the next step well.

An *agent* is a sub-conversation with its own context budget, its own tools, and its own system prompt. The cost of an agent is high: a full prompt load, a new tool ACL, a serialized handoff back to the parent. The benefit is *isolation* — the parent context stays clean while the child explores 30 files, runs 50 grep searches, or drafts a 4,000-line research dump. Agents are the right shape for: long-running exploration, parallelism (independent tasks in flight at once), context quarantine (keep noise out of the parent), tool-availability mismatch (the agent has tools the main session should not or does not have).

This pair-of-axioms is not novel — it matches the spirit of the existing `proactive-delegation.md` rule (delegate to agents, keep main context = coordination only) and the `use-scout-not-explore.md` rule (use scout when accuracy matters; main context for trivial lookups). What this document adds is *one explicit decision tree* that says when to spawn an agent vs run a skill vs combine the two, and *one explicit pairing table* that names the companion skill for every agent.

### Counter-position considered and rejected

A reviewer might propose **Agents own behavior, skills are documentation.** This collapses if you look at the skill-rules.json activation traffic — most user prompts route to a skill (e.g. `tdd`, `databases`, `code-review`) without ever spawning an agent. If skills were docs only, those activations would be wasted. The data says skills *do* drive behavior in the main session every day; that is the whole reason `guardrail-enforcer.ts` blocks prompts until the right skill loads.

A second reviewer might propose **Every agent should always have a companion skill.** This is too strong. Single-purpose agents (`herald` for changelogs, `agentica-agent` for Agentica SDK work, `memory-extractor` for perception extraction) carry their full behavior in their own prompt and do not benefit from a separate skill. Forcing a skill on every agent creates ceremonial duplication.

The endorsed thesis is the conservative middle: skills own behavior *by default*; agents are added when isolation pays its cost.

---

## 2. Decision Tree

When new work arrives, route it through this tree before spawning anything.

```
Start: a piece of work needs to happen.
|
+- Q1: Is this a single-step lookup or a one-line answer?
|        e.g. what port does NorthStar use; show me the file
|   YES -> Main session. No skill, no agent. Matches the
|         Do-Not-Over-Delegate guidance in
|         .claude/rules-ondemand/proactive-delegation.md.
|   NO -> continue
|
+- Q2: Does the work fit in <3 file reads + 1 short edit, with all
|        tools the main session already has?
|   YES -> Main session, with relevant skill auto-loaded by the
|         skill-activation-prompt hook. (Skills own behavior.)
|   NO -> continue
|
+- Q3: Are there 3+ files, multi-step exploration, or multiple
|        tool boundaries (e.g. WebFetch + Bash + Grep + Read)?
|   YES -> continue to Q4
|   NO -> main session + skill is enough
|
+- Q4: Does the work need parallelism (two independent tracks
|        in flight at the same time, e.g. research X AND profile Y)?
|   YES -> spawn one agent per track, with its companion skill loaded
|         in the agent prompt (skill -> agent pattern, see section 4)
|   NO -> continue to Q5
|
+- Q5: Does the work pollute the parent context with noise the
|        parent does not need? (e.g. reading 30 files to find one
|        function call site; running 100 grep variants)
|   YES -> spawn one agent (typically scout, debug-agent, or sleuth)
|         and keep the parent context clean
|   NO -> continue to Q6
|
+- Q6: Does the work require tools the main session should not or
|        does not have? (e.g. an agent with restricted Edit/Write
|        ACL for security review)
|   YES -> spawn agent (typically a reviewer: critic, judge,
|         liaison, plan-reviewer)
|   NO -> main session + skill
|
+- Q7: Is this a multi-phase orchestration with checkpoints
        (recon -> interview -> plan -> execute -> verify)?
   YES -> spawn workflow orchestrator skill (build, fix,
         release, maestro, ralph) — the skill itself
         spawns child agents per phase
   NO -> fall through to main + skill
```

### Routing matrix (compressed form of the tree)

| Inputs | Route |
|--------|-------|
| 1-line answer, 0-2 files | Main session, no skill |
| Single skill domain, <3 files | Main + skill |
| 3+ files, sequential | Main + skill (or skill -> agent if context noisy) |
| 3+ files, parallel tracks | Skill -> agent (one per track) |
| Need tool quarantine (review-only ACL) | Skill -> reviewer-agent |
| Long exploration (>10 files) | Skill -> scout/sleuth |
| Multi-phase pipeline | Workflow-orchestrator skill (build/fix/release/etc.) |
| Autonomous loop | `ralph` skill (it spawns its own agents) |

### Concrete drivers

The tree above is meant to be checked in this order — *every* yes short-circuits the rest:

1. **Number of files touched.** 3+ is the dividing line. (Matches `proactive-delegation.md` Reading 3+ files -> scout.)
2. **Parallelism need.** Two independent tracks -> two agents. One sequential pipeline -> orchestrator skill.
3. **Context isolation need.** If the parent context will be more useful *without* the noise, isolate. If the parent needs to see the noise, keep it inline.
4. **Tool ACL mismatch.** If the work needs a tool the parent should not run with (e.g. a reviewer that should *not* edit), use an agent with a restricted tool list.

---

## 3. Pairing Table — every agent and its companion skill

Source: `.claude/agents/*.md` on disk (32 files post-`f9c7c59`), `.claude/skills/*/SKILL.md`, the agent x skill map, and direct reads of agent frontmatter.

| # | Agent | Companion skill | Rationale | Verdict |
|---|-------|-----------------|-----------|---------|
| 1 | `aegis` | `security` | aegis runs vulnerability analysis; the `security` skill is the workflow that calls it (see `.claude/skills/security/SKILL.md` lines 23-25). One-to-one map; the skill is the user entry point and aegis is the engine. | Keep as-is |
| 2 | `agentica-agent` | none (self-contained) | Builds Agentica-SDK Python agents; its body carries the full methodology. The `agentica` skill exists but is a thin reference. | Optional |
| 3 | `arbiter` | `tdd`, `test` | arbiter executes unit/integration tests; both `tdd` and `test` skills route to it. arbiter is the *engine*; the two skills are different *entry points* (one workflow, one bare command). | Keep as-is |
| 4 | `architect` | (none direct) | architect designs features and integrations; its prompt body is the methodology. The map shows architect mentioned-by `build, refactor, migrate, maestro` — those are the workflow skills that invoke architect, not a companion skill. | Acceptable. Considered creating a `design` skill, rejected as ceremonial — the workflow orchestrators already cover the entry points. |
| 5 | `atlas` | `test` (secondary) | E2E and acceptance test runner; `test` skill mentions atlas as secondary to arbiter. | Keep as-is |
| 6 | `braintrust-analyst` | `braintrust-tracing` | RETIRED 2026-09-30 (see `archive/braintrust-2026-10/`). The agent read the skill methodology before pulling spans. | Retired |
| 7 | `critic` | `code-review` (guardrail) | critic is the implementation-feature reviewer; `code-review` skill is the framework that fires `critic + review-agent`. | Keep as-is |
| 8 | `debug-agent` | `systematic-debugging` (guardrail) | Confirmed pair via the guardrail-enforcer hook. | Keep as-is — but see **Recommendation R1** below for de-duplication with sleuth |
| 9 | `deployer` | `vercel-cli`, `railway-cli`, `sentry-cli` | Deployer is the Vercel+Railway+Sentry+Linear orchestrator; it loads the relevant CLI skill for the platform in play. Three skills, one agent — that is correct, not bloat. | Keep as-is |
| 10 | `herald` | none | Single-purpose changelog/release-notes writer; no methodology to externalize. | Keep as-is |
| 11 | `judge` | none currently — see **R2** | Refactoring/transformation reviewer; pairs naturally with the `refactor` workflow but has no dedicated review skill. | **R2:** consider a `refactor-review` skill or fold judge into `refactor` plan-reviewer step |
| 12 | `kraken` | `tdd` | Kraken implements via TDD; `tdd` skill is the methodology contract. The map confirms (`tdd` mentions kraken+arbiter). | Keep as-is — gold-standard pairing |
| 13 | `liaison` | none currently — see **R2** | Integration/API reviewer with restricted tools (Read, Grep, Glob only). No companion skill. | **R2:** consider folding liaison into `release` or pairing with a thin `integration-review` skill |
| 14 | `maestro` | `maestro` | Self-named pair. The skill is the orchestration prompt; the agent is the one running. | Keep as-is |
| 15 | `memory-extractor` | `memory` (read-only consumer) | Extracts perception changes from session JSONL; consumes memory-system contracts but does not need a workflow skill of its own. | Keep as-is |
| 16 | `onboard` | `onboard` | Self-named pair (acknowledged as dual-entity with circular references in the agent x skill map gaps section). The relationship is fine in practice — the agent reads the skill on each invocation. | Keep as-is. Document the agent-loads-skill direction in the skill body. |
| 17 | `oracle` | `exa`, `opencli`, `github-search` | Three tool skills wrap the three main research surfaces oracle uses. Oracle picks the right skill per query. | Keep as-is — gold-standard pairing |
| 18 | `pathfinder` | none currently | External-repo cloning and analysis; companion to oracle, no separate methodology skill. | Keep as-is. Pathfinder is rare-use; do not invent ceremony. |
| 19 | `phoenix` | none currently — see **R3** | Refactor/migration planner; mentioned by `refactor + migrate` skills. The workflow skills are its entry points. | **R3:** clarify in the map that `refactor` and `migrate` ARE the companions |
| 20 | `plan-agent` | `plan-agent` (skill exists) | Confirmed: agent loads `skills/plan-agent/SKILL.md` (corrected in commit `f9c7c59`, A1 fix). | Keep as-is — pairing fixed |
| 21 | `plan-reviewer` | none currently | Reviews plans from architect/phoenix; tools restricted to Read. | Keep as-is — single-purpose reviewer |
| 22 | `profiler` | none currently | Performance profiling; specialized agent. | Keep as-is |
| 23 | `react-perf-reviewer` | `react-perf` | Confirmed pair; the `react-perf-context` hook auto-loads `react-perf` skill on `.tsx` reads. | Keep as-is |
| 24 | `review-agent` | `code-review` (guardrail) | Synthesis reviewer; the same `code-review` skill that pairs with `critic`. | Keep as-is |
| 25 | `scout` | none directly | Scout is invoked by `build, fix, explore, migrate, maestro` workflow skills; its own prompt is the methodology. | Keep as-is |
| 26 | `scribe` | `create_handoff`, `continuity_ledger` | Two narrow skills; scribe is the agent that writes them. | Keep as-is |
| 27 | `sentinel` | `browser-dev-cycle` (de facto) | Sentinel is the QA/E2E browser agent; `browser-dev-cycle` skill describes the tool tier policy it follows. The pairing is not named in skill-rules.json but is functional. | **R4:** add explicit cross-reference between sentinel prompt and `browser-dev-cycle/SKILL.md` |
| 28 | `sleuth` | `systematic-debugging` (guardrail) | Same companion as debug-agent. See R1. | Keep as-is — but R1 below addresses dedup |
| 29 | `spark` | none directly | Lightweight fixes; tool-light agent for trivial work. | Keep as-is |
| 30 | `surveyor` | none directly | Migration scope assessor; mentioned by `migrate` skill as scout-like first phase. | Keep as-is |
| 31 | `ui-compliance-reviewer` | `ui-audit` | Confirmed pair. | Keep as-is |
| 32 | `validate-agent` | none directly | Validates *other agent output* quality post-completion; meta-reviewer. Nameclash resolved by R5: hook renamed to `agent-model-guard.ts`. | Keep as-is |

### Dropped from prior map

The earlier `agent-skill-map.md` listed `principal-reviewer`, `wizard`, `agent-factory`, and `session-analyst` (now archived). Verification today:

- `session-analyst` — archived in `f9c7c59`. Already handled.
- `principal-reviewer` — **does not exist** at `.claude/agents/principal-reviewer.md` and **does not exist** at `~/.claude/agents/principal-reviewer.md`. The agent the map references is fictional. **Recommendation R6** below.
- `wizard` — same: not on disk in either repo or global. Fictional.
- `agent-factory` — same: not on disk in either repo or global. Fictional.

This is a non-trivial finding: the agent x skill map (Phase 5a deliverable) reported phantom agents. The recommendation is to either (a) update the map to remove them, or (b) create those three because they fill real gaps. R6 below picks the default.

---

## 4. Skill -> Agent Matrix — workflow orchestrators

For each of the 14 workflow orchestrator skills, decide whether it should spawn agents and why.

| # | Skill | Spawns agents? | Which agents | Why | Verdict |
|---|-------|----------------|--------------|-----|---------|
| 1 | `build` | YES | scout, oracle, architect, kraken, spark, profiler, arbiter, deployer | Multi-phase greenfield/brownfield pipeline. Each phase needs isolation (research separate from impl separate from test). | Correct — keep |
| 2 | `fix` | YES | sleuth, debug-agent, diagnose, spark, kraken, arbiter | Bug pipelines need investigation isolated from fix. | Correct — keep, but see R1 (sleuth/debug-agent dedup) |
| 3 | `explore` | YES | scout (only) | Single-purpose: scout is the entire workflow. Could arguably be skill-only and have main session do the exploration, but accuracy is the reason scout exists. | Correct — keep |
| 4 | `ralph` | YES (always) | every implementation agent | Ralph is BLOCKED from direct edits; it MUST delegate. Enforced by the `ralph-delegation-enforcer` hook (`.claude/hooks/src/ralph-delegation-enforcer.ts`). | Correct — keep, enforced |
| 5 | `maestro` | YES | architect, kraken, spark, oracle, scout, debug-agent, profiler, scribe | General orchestrator; the skill body is the playbook. | Correct — keep |
| 6 | `refactor` | YES | phoenix, plan-agent, kraken, plan-reviewer, arbiter | Refactor needs scope assessment, plan, plan review, impl, tests. | Correct — keep |
| 7 | `migrate` | YES | oracle, phoenix, plan-agent, kraken, surveyor | Same shape as refactor with surveyor for scope. | Correct — keep |
| 8 | `release` | YES | aegis, atlas, review-agent, herald, scribe, deployer | Release pipeline with security gate. | Correct — keep |
| 9 | `review` | YES | critic, plan-reviewer, review-agent | Code review needs multiple lenses in parallel. | Correct — keep |
| 10 | `security` | YES | aegis | Single-agent invocation; could in theory be skill-only but aegis has tool quarantine value. | Correct — keep |
| 11 | `tdd` | YES | kraken, arbiter | Two-agent loop. | Correct — keep |
| 12 | `test` | YES | arbiter, atlas | Wrapper around test-execution agents. | Correct — keep |
| 13 | `premortem` | NO | — | Risk analysis methodology that runs in main context. | Correct — keep |
| 14 | `plan-mode` | NO directly (calls plan-agent through Plan Mode) | plan-agent (indirect) | Plan mode is a Claude Code primitive; the skill is guidance. | Correct — keep |

### Anti-pattern check

The map flagged this concern: **maestro fires on itself** — the `maestro-detector` hook recommends maestro on complexity signals, even while a maestro session is active. That is an *over-spawning* risk. Proposed fix lives in section 5 (R7).

No other workflow orchestrators exhibit re-entrancy. `ralph` has its own delegation enforcer that prevents recursive ralph spawn.

---

## 5. Migration Recommendations

Each item below is a *recommendation* with explicit blast radius, risk, and reversibility. None of these execute in this design phase. They are the input to a Phase 5c plan that the user approves separately.

### R1 — Dedup `sleuth` vs `debug-agent` [DONE — Option A]

**Problem.** Both agents investigate bugs. Both load `systematic-debugging` skill. The `fix` skill uses sleuth for deep forensics and debug-agent as general fallback but this distinction lives only in `fix/SKILL.md` prose. In practice the routing is ambiguous and both get recommended for the same prompt class.

**Resolution (Option A applied, commit `76482f2`).** Both agents kept. Frontmatter `description` fields rewritten to make the split observable:
- sleuth = "Deep bug forensics with file-level reproduction. Use when the bug is multi-file, intermittent, or needs evidence-grade root cause analysis with traced code paths."
- debug-agent = "General root-cause analysis for unclear or single-file bugs. Use as the default investigator when the failure mode is not yet localized."

Each agent's frontmatter cross-references the other ("Pairs with the systematic-debugging skill. For multi-file forensics or evidence-grade reproduction, prefer sleuth." / "For unclear or single-file bugs, prefer debug-agent."). `fix/SKILL.md` prose aligned. No agent removal.

**Blast radius:** 2 frontmatter changes + 1 doc paragraph in `fix/SKILL.md`.
**Reversibility:** `git revert 76482f2`.

### R2 — `judge` and `liaison` discoverability

**Problem.** Both are reviewers with restricted tools; neither is referenced by any workflow skill in the map. They can only be reached by name.

**Options.**
- **Option A (preferred):** Add explicit Companion-Agent-Yes rows to the relevant workflow skills. Specifically: add `judge` to `refactor` as the post-impl review step (currently only `plan-reviewer` runs there); add `liaison` to `release` for integration review. No new skills needed.
- **Option B:** Create `refactor-review` and `integration-review` skills. More files, more ceremony, no clear win.

**Blast radius (A):** 2 line edits in `refactor/SKILL.md` + 1 line in `release/SKILL.md`.
**Risk (A):** None — review steps are additive.
**Reversibility:** Trivial revert.

### R3 — `phoenix` companion

**Problem.** Phoenix plans refactors and migrations. The map says no companion skill. But `refactor + migrate` workflow skills *are* its companions — they are what call it.

**Recommendation.** Update the agent x skill map Companion-Agent-No entry for phoenix to Companion-Agent-Yes (refactor + migrate workflow skills). This is a doc fix, not an agent change.

**Blast radius:** 1 row in `agent-skill-map.md`.
**Risk:** None.

### R4 — `sentinel` x `browser-dev-cycle`

**Problem.** Sentinel is the QA/E2E agent; `browser-dev-cycle` is the tool-tier guidance skill. They function as a pair but have no formal cross-reference.

**Recommendation.** Add a Companion skill: `browser-dev-cycle` line near the top of `sentinel.md` and a Companion agent: sentinel (when full E2E driving needed) line in `browser-dev-cycle/SKILL.md`.

**Blast radius:** 2 single-line edits.
**Risk:** None.

### R5 — Resolve `validate-agent` x `agent-validate` nameclash [DONE]

**Problem.** `.claude/agents/validate-agent.md` (the agent that validates other agent outputs) and `.claude/hooks/src/agent-validate.ts` (the hook that validates agent file existence before spawn) had nearly identical names but different concerns. Note: the hook never blocked haiku — that was always `no-haiku-enforcer.ts`. The renamed file `agent-model-guard.ts` is historical naming and behaves identically to its predecessor (existence check on `subagent_type`).

**Resolution (Option A applied):** Hook renamed to `agent-model-guard.ts`. Hook behavior unchanged; file name moved. `~/.claude/settings.json` registration updated to `agent-model-guard.mjs` via Node.js atomic write.

### R6 — Phantom agents in the map [DONE — Option B]

**Problem.** The Phase 5a scout deliverable lists three agents that **do not exist** on disk: `principal-reviewer`, `wizard`, `agent-factory`. This is a documentation defect.

**Resolution (Option B applied, commit `420119f`).** All three agents created on disk to cover the real gaps:
- `wizard.md` — CCv3 setup wizard companion to `wizard.py`.
- `agent-factory.md` — scaffolds new agents; useful when expanding the roster.
- `principal-reviewer.md` — senior-eng review pass; distinct from `critic` (feature review) and `review-agent` (synthesis). Tools restricted to read-only (no Edit/Write).

The agent x skill map (`agent-skill-map.md`) was updated to reflect the new agents in the same change. **Open follow-up:** none of the three are wired into `task-router.ts` or `skill-rules.json` — they are reachable only by explicit `subagent_type` name. Wiring is deferred as a separate task and tracked in `hook-audit-2026-04.md` Phase 5c addendum (LOW severity).

**Blast radius:** 3 new agent files + 1 map update.
**Reversibility:** `git revert 420119f`.

### R7 — `maestro` re-entrancy guard [DONE]

**Problem.** `maestro-detector` hook recommends `/maestro` on complexity signals even when a maestro session is already active.

**Resolution (commit `a429634`).** `isMaestroActive()` check added to `maestro-detector.ts`: if the maestro state file (`.claude/maestro-state.json`) exists with mtime within a 30-minute window, the suggestion is skipped. Fail-open on missing state file. Test coverage added.

**Latent edge case (tracked, low risk).** Long-running maestro sessions that cross the 30-min window without state-file mtime refresh could re-fire the detector. Not addressed in this commit; see `hook-audit-2026-04.md` Phase 5c addendum.

**Blast radius:** ~30 lines in `maestro-detector.ts` + test.
**Reversibility:** `git revert a429634` + rebuild.

### R8 — `neonctl` skill needs no companion agent

**Problem.** Map flags No-neonctl-companion-agent. All other infrastructure CLIs (vercel-cli, railway-cli, sentry-cli) are wrapped by `deployer`.

**Recommendation.** **No new agent.** Two reasons: (1) Neon ops are infrequent compared to Vercel/Railway, so the safety value of an agent wrapper is low; (2) The `databases` skill already provides a guardrail entry point and `neonctl-safety.md` rule already gates destructive commands. Adding `deployer.md` awareness of `neonctl` is the cheapest path: one paragraph in deployer prompt.

**Blast radius:** ~5 lines in `deployer.md`.
**Risk:** None.

### R9 — Memory sub-skill consolidation verification [VERIFY-TASK, NOT YET CLOSED]

**Problem.** Five skills cover memory: `memory` (canonical), `recall`, `remember`, `recall-reasoning`, `memory-curate`. The agent x skill map flags this and notes a canonical-skill consolidation is in place.

**Verification finding (2026-04-27).** The sub-skills are **not** thin pointers — each carries its own body (commands, examples, scoring guidance specific to its surface). The `memory` skill is canonical-by-convention (it is the reference doc the rules link to), not by mechanical inclusion. The arrangement is functional today: `recall` = query helper, `remember` = store helper, `recall-reasoning` = reasoning-search, `memory-curate` = audit/cleanup, and `memory` = the spec all four cite.

**Status.** Reframed as a verify-task, not a code-change item. Decide separately whether to:
- **(a)** leave as-is — keeps skill-router keyword distinctiveness, costs duplication risk if `memory/SKILL.md` and a sub-skill body drift.
- **(b)** thin the sub-skills to one-line pointers — loses keyword surface for skill-router activation but eliminates drift risk.
- **(c)** fold them entirely into `memory/SKILL.md` and delete — most aggressive; requires re-registering skill-router keywords on `memory`.

**No action required for Phase 5c.** This is an open design choice for a future cycle.

**Blast radius:** 0 (option a) up to ~4 file edits (b) or 4 deletions (c).
**Risk:** Option (a) drift risk only. Option (b)/(c) lose router activation surface unless skill-rules.json updated in step.

### R10 — `principal-reviewer` undiscoverability

**Status:** Merges into R6 (the agent does not exist on disk).

---

## 6. Open Questions for User — Phase 5c resolution log

1. **Recommendation R1 (sleuth/debug-agent dedup).** [DONE — Option A] Both agents kept; frontmatter `description` fields rewritten to make routing observable. Commit `76482f2`.
2. **Recommendation R5 (nameclash).** [DONE] Hook renamed to `agent-model-guard.ts`; `~/.claude/settings.json` and 4 mirrored settings files updated. Commit `dd6c602` + pre-push followup.
3. **Recommendation R6 (phantom agents).** [DONE — Option B] All three agents created on disk (`wizard.md`, `agent-factory.md`, `principal-reviewer.md`). Commit `420119f`. Wiring into `task-router.ts`/`skill-rules.json` deferred as a separate follow-up.
4. **Recommendation R7 (maestro re-entrancy).** [DONE] 30-min mtime window guard added to `maestro-detector.ts`. Commit `a429634`.
5. **Out of scope confirmation.** This document does not propose changes to `ralph` enforcement, the `tldr-code` canonical-entry-point arrangement, or any of the 9 TLDR hooks. Confirmed stable.
6. **Phase 5c sequencing.** Executed: R1 → R5 → R6 → R7 in commits `76482f2`, `dd6c602`, `420119f`, `a429634` on branch `feature/system-coherence`. R2/R3/R4/R8 remain as doc-only follow-ups (not blocking). R9 reframed as verify-task (no action required).

---

## 7. Success Criteria — Phase 5c status

- [ ] Every agent on disk has a row in the pairing table that is true. *(Open: pairing table updated for R6 agents but not yet re-validated end-to-end.)*
- [x] No phantom agents in the map (R6 closed — agents created on disk, commit `420119f`).
- [x] No nameclash between hooks and agents (R5 closed — hook renamed `agent-model-guard.ts`, commit `dd6c602`).
- [x] `maestro-detector` does not recommend maestro inside a maestro session (R7 closed — commit `a429634`).
- [ ] Every workflow orchestrator skill that has a companion agent declares it explicitly (R2-R4 closed). *(Open: doc-only follow-ups not yet scheduled.)*
- [ ] Memory sub-skills are confirmed-thin pointers (R9 closed). *(Reframed as verify-task — see R9 above. No action required for Phase 5c.)*
- [x] Sleuth and debug-agent have observably-distinct routing (R1 closed — Option A applied, commit `76482f2`).
- [ ] The decision tree in section 2 is referenced by the next session-onboarding pass (lives in `.claude/docs/` so future agents can read it).

---

## 8. References

- Plan: `~/.claude/plans/i-have-a-new-abstract-quail.md` (Phase 5)
- Companion docs:
  - [`.claude/docs/agent-skill-map.md`](./agent-skill-map.md) — full pairing inventory + routing coverage gaps
  - [`.claude/docs/tool-tier-policy.md`](./tool-tier-policy.md) — hooks vs MCPs vs skills decision rules (companion to this doc's §2 decision tree)
  - [`.claude/docs/hook-audit-2026-04.md`](./hook-audit-2026-04.md) — Phase 2/3/5c audit decisions and open follow-ups
  - [`.claude/docs/architecture/DECISION-TREES.md`](./architecture/DECISION-TREES.md) — task-type detection (links forward to §2 above)
- Archive READMEs (gitignored): `.claude/agents/_archived/2026-04-26-duplicates/README.md`, `.claude/skills/_archived/2026-04-26-tldr-cleanup/README.md`
- Rules: `.claude/rules-ondemand/proactive-delegation.md`, `~/.claude/CLAUDE.md ("Agents and delegation")`, `~/.claude/CLAUDE.md ("Agents and delegation")`, `.claude/rules/agent-model-selection.md`
- Hooks: `.claude/hooks/src/ralph-delegation-enforcer.ts`, `.claude/hooks/src/maestro-detector.ts`, `.claude/hooks/src/agent-model-guard.ts`, `.claude/hooks/src/skill-router.ts`
