---
paths:
  - ".claude/agents/**"
  - "scripts/check-agent-model-drift.mjs"
  - "opc/scripts/claude_spawn.py"
---

# Agent Model Selection

Every predefined agent (`.claude/agents/*.md`, **and** its `.json` mirror where one exists — 17 of 37 have one) carries an **explicit two-tier** `model:` — no omit, no inherit, never haiku.

## The two tiers

- **`model: opus`** = Opus (inherits the session effort; `~/.claude/settings.json` `modelSettings` pins Opus at high). Reserve for judgment-dense work: planning/design (architect, phoenix, plan-agent), review/soundness gates (critic, plan-reviewer, principal-reviewer, review-agent), orchestration (maestro), deep forensics (sleuth, debug-agent), security (aegis), high-stakes bootstrap (wizard).
- **`model: sonnet`** = Sonnet. The **default** for execution: implementation (kraken, spark), exploration/research (scout, oracle, pathfinder, onboard), test execution (arbiter, atlas, sentinel), checklist review, mechanical ops, docs.

## Sonnet always runs at effort high

Dave's rule (2026-09-30): Sonnet effort is `high`. Never `medium`, `low` or `xhigh`.
- Every Sonnet agent carries `effort: high` in its frontmatter. Without it, the agent gets the
  effort of the spawning session (`--effort`, else `modelSettings`). It does not read the settings
  `effortLevel`. Probe 2026-09-30: parent `--effort high` with user `effortLevel: medium` gave high;
  parent `--effort low` gave low.
- Baseline before the pin: 46 of 99 Sonnet subagent runs medium, 5 low.
- Proof: read `"effort":"<level>"` in the subagent transcript (`~/.claude/projects/<slug>/<session>/subagents/`).
- Opus agents have no pin. They copy the parent, so they run high under an Opus or Sonnet parent at high
  and lower under a parent at lower effort (probed: `--effort low`; [Speculation] a Fable session, `modelSettings` medium). A pin is Dave's decision.
- `~/.claude/settings.json` `modelSettings` pins `claude-sonnet-5` and `claude-sonnet-5-5` at high for
  Sonnet main sessions.
- A workflow `agent()` on Sonnet passes `effort: 'high'`. For Sonnet work through the Agent tool, use a
  predefined Sonnet agent (it carries the pin) rather than an ad-hoc `model: sonnet` call.
- Gate: `node scripts/check-agent-model-drift.mjs` fails when a Sonnet agent lacks `effort: high`.

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
- Fable (or any non-tier model) only when Dave asks for it.
Omitting `model` stays acceptable for a single ad-hoc question where cost does not matter.

## Never use Haiku

**Never set `model: haiku`** — no exceptions. Haiku optimizes cost/latency at the expense of accuracy; the Haiku lane is deliberately collapsed up into Sonnet 5. Tasks often seem "quick" but require tracing relationships across files.

## Never set `CLAUDE_CODE_SUBAGENT_MODEL`

The env var overrides every agent's frontmatter and **flattens the whole tier map to one model**. Keep it unset (verified unset 2026-07-07); a standing guard fails loud if it is ever set.

## Expression mechanics

Use the bare aliases `model: opus` / `model: sonnet` — they resolve to `claude-opus-5-5` / `claude-sonnet-5-5` on this build (no `ANTHROPIC_DEFAULT_*_MODEL` pins). The `.json` mirror's `model` field is read at spawn by `opc/scripts/claude_spawn.py` and is **not** auto-synced from the `.md` (`sync-agent-json.py` preserves it) — edit both in lockstep. The mirror has no `effort`, and `claude_spawn.py` passes no `--effort`, so `effort:` lives only in the `.md`.
