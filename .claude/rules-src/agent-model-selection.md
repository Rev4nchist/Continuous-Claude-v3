---
paths:
  - ".claude/agents/**"
  - "scripts/check-agent-model-drift.mjs"
  - "opc/scripts/claude_spawn.py"
---

# Agent Model Selection

Every predefined agent (`.claude/agents/*.md`, **and** its `.json` mirror where one exists — 17 of 37 have one) carries an **explicit two-tier** `model:` — no omit, no inherit, never haiku.

## The two tiers

- **`model: opus`** = Opus, pinned `effort: high` like Sonnet (see below). Reserve for judgment-dense work: planning/design (architect, phoenix, plan-agent), review/soundness gates (critic, plan-reviewer, principal-reviewer, review-agent), orchestration (maestro), deep forensics (sleuth, debug-agent), security (aegis), high-stakes bootstrap (wizard).
- **`model: sonnet`** = Sonnet. The **default** for execution: implementation (kraken, spark), exploration/research (scout, oracle, pathfinder, onboard), test execution (arbiter, atlas, sentinel), checklist review, mechanical ops, docs.

## Agents always run at effort high

Dave's rules (2026-09-30): Sonnet effort is `high`, never `medium`, `low` or `xhigh`. Opus agents are
pinned `high` too, so review and planning quality does not depend on the main session's model.
- Every agent (Opus and Sonnet) carries `effort: high` in its frontmatter. Without it, an agent gets the
  effort of the spawning session (`--effort`, else `modelSettings`). It does not read the settings
  `effortLevel`. Probe 2026-09-30: parent `--effort high` with user `effortLevel: medium` gave high;
  parent `--effort low` gave low.
- Baseline before the pin: 46 of 99 Sonnet subagent runs medium, 5 low.
- Proof: read `"effort":"<level>"` in the subagent transcript (`~/.claude/projects/<slug>/<session>/subagents/`).
- `~/.claude/settings.json` `modelSettings` pins `claude-sonnet-5`, `claude-sonnet-5-5` and
  `claude-opus-5-5` at high for main sessions. Opus 5.5 needs its own entry: a top-level `effortLevel`
  in user settings does not count for it, and it defaults to medium.
- A workflow `agent()` on Sonnet passes `effort: 'high'`. For Sonnet work through the Agent tool, use a
  predefined Sonnet agent (it carries the pin) rather than an ad-hoc `model: sonnet` call.
- Gate: `node scripts/check-agent-model-drift.mjs` fails when any agent lacks `effort: high`. The pin covers
  Agent-tool spawns (read from the `.md`). It does not cover `opc/scripts/claude_spawn.py`: it passes no `--effort`.

Tier by **judgment density**, not task size. Canonical map (37 agents, 12 Opus / 25 Sonnet): `~/.claude/plans/agent-skill-two-tier-model-policy` and the review artifact.

## Never omit/inherit for a predefined agent

`inherit` (or an omitted `model:`) resolves to the **session model** (currently Opus) — silently reproducing Opus-on-everything, the exact anti-goal. Predefined agents MUST be explicit. Omitting is acceptable only for a genuinely ad-hoc, chat-level `Agent` call.

## Workflow `agent()` calls and ad-hoc `Agent` calls choose too

These inherit the session model unless they name one, so a wide fan-out silently runs the
session's top model on mechanical work. Dave has asked for this more than once ("assign the
correct model for subagent work"). Pick by the same judgment-density rule:
- `model: 'sonnet'` for mechanical and execution stages: reading batches, inventories, file edits
  from a precise spec, test runs, formatting.
- `model: 'opus'` for judgment stages: checking findings against the code, adversarial review,
  synthesis, ranking, design.
- Fable (or any non-tier model) only when Dave asks for it. Exception: Fable is the **advisor**
  (`advisorModel: "fable"`, Dave 2026-10-08). The main model consults it at decision points, with the
  full transcript, and subagents inherit it. It is never a model for `agent()` or `Agent` calls.
Omitting `model` stays acceptable for a single ad-hoc question where cost does not matter.

## Never use Haiku

**Never set `model: haiku`** — no exceptions. Haiku optimizes cost/latency at the expense of accuracy; the Haiku lane is deliberately collapsed up into Sonnet 5. Tasks often seem "quick" but require tracing relationships across files. Re-checked against Haiku 5.5 on 2026-10-08: the ban stands, and read-only work stays on Sonnet 5.5 (`docs/self-improvement/proposals/2026-10-08-model-makeup.md`).

## Never set `CLAUDE_CODE_SUBAGENT_MODEL`

The env var overrides every agent's frontmatter and **flattens the whole tier map to one model**. Keep it unset (verified unset 2026-07-07); a standing guard fails loud if it is ever set.

## Expression mechanics

Use the bare aliases `model: opus` / `model: sonnet` — they resolve to `claude-opus-5-5` / `claude-sonnet-5-5` on this build (no `ANTHROPIC_DEFAULT_*_MODEL` pins). The `.json` mirror's `model` field is read at spawn by `opc/scripts/claude_spawn.py` and is **not** auto-synced from the `.md` (`sync-agent-json.py` preserves it) — edit both in lockstep. The mirror has no `effort`, and `claude_spawn.py` passes no `--effort`, so `effort:` lives only in the `.md`.
