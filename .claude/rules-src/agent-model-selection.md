# Agent Model Selection

Every predefined agent (`.claude/agents/*.md` **and** its `.json` mirror) carries an **explicit two-tier** `model:` — no omit, no inherit, never haiku.

## The two tiers

- **`model: opus`** = Opus 4.8 (high effort is its shipped default; effort is a **global** `~/.claude/settings.json` `effortLevel`, not a per-agent field). Reserve for judgment-dense work: planning/design (architect, phoenix, plan-agent), review/soundness gates (critic, plan-reviewer, principal-reviewer, review-agent), orchestration (maestro), deep forensics (sleuth, debug-agent), security (aegis), high-stakes bootstrap (wizard).
- **`model: sonnet`** = Sonnet 5. The **default** for execution: implementation (kraken, spark), exploration/research (scout, oracle, pathfinder, onboard), test execution (arbiter, atlas, sentinel), checklist review, mechanical ops, docs.

Tier by **judgment density**, not task size. Canonical map (37 agents, 12 Opus / 25 Sonnet): `~/.claude/plans/agent-skill-two-tier-model-policy` and the review artifact.

## Never omit/inherit for a predefined agent

`inherit` (or an omitted `model:`) resolves to the **session model** (currently Opus) — silently reproducing Opus-on-everything, the exact anti-goal. Predefined agents MUST be explicit. Omitting is acceptable only for a genuinely ad-hoc, chat-level `Agent` call.

## Never use Haiku

**Never set `model: haiku`** — no exceptions. Haiku optimizes cost/latency at the expense of accuracy; the Haiku lane is deliberately collapsed up into Sonnet 5. Tasks often seem "quick" but require tracing relationships across files.

## Never set `CLAUDE_CODE_SUBAGENT_MODEL`

The env var overrides every agent's frontmatter and **flattens the whole tier map to one model**. Keep it unset (verified unset 2026-07-07); a standing guard fails loud if it is ever set.

## Expression mechanics

Use the bare aliases `model: opus` / `model: sonnet` — they resolve to Opus 4.8 / Sonnet 5 on this build (no `ANTHROPIC_DEFAULT_*_MODEL` pins). The `.json` mirror's `model` field is read at spawn by `opc/scripts/claude_spawn.py` and is **not** auto-synced from the `.md` (`sync-agent-json.py` preserves it) — edit both in lockstep.
