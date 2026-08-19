# Skill router decision: RETIRE skill-activation-prompt (2026-08-19)

Follow-up to the Theo-derived instruction-file refit (commit `69f1dcd`). Question: does
`skill-rules.json` + the `skill-activation-prompt` UserPromptSubmit hook earn its keep now
that skill descriptions carry the triggers?

## Decision

**Retire.** Unregistered `hooks/dist/skill-activation-prompt.mjs` from UserPromptSubmit in
BOTH settings.json copies (`~/.claude/settings.json` and the repo copy), via Node atomic
read-modify-write, confirmed by Dave in-session. Source (`hooks/src/skill-activation-prompt.ts`),
tests, and `skill-rules.json` are all kept.

## Evidence

Probe harness: `node scripts/skills/trigger-probe.mjs` (45 cases in
`scripts/skills/trigger-cases.json`). Two runs on 2026-08-19
(`2026-08-19-skill-trigger-baseline.json`, `-after.json`), identical numbers:

| Channel | Hits | False-fire prompts |
|---|---|---|
| Hook (skill-rules.json keywords/intents) | 14/45 (31%) | 22/45 |
| Native description router | 45/45 | 0/45 |

**Marginal contribution of the hook beyond the native router: zero.** Every one of the
hook's 14 hits was a prompt the native router also hit — the hook's hit set is a strict
subset. It added no hit and injected wrong suggestions (mot, debug-agent,
systematic-debugging, memory-vs-recall confusions, ...) into 22 of 45 prompts.

Methodology caveat: the native channel is one headless `claude -p` self-report naming the
skill it would invoke per prompt. Even if native were imperfect on some cases, the
subset relationship makes the hook's marginal value zero on this dataset regardless.

## Corrected premise: the ghost purge was already moot

The backlog (`state-of-rework/_maps/backlog.json` QW-08) claimed 26 arscontexta ghost
entries. Verified 2026-08-19: **0 arscontexta entries** in either copy of
skill-rules.json (repo and `~/.claude`, both 58 skills / 18 agents). Dir-less ghosts:
repo copy 1 (`frontend-design`, a plugin skill), global copy 3 (`frontend-design`,
`vercel-cli`, `find-skills`). So the measured 31% / 22-false-fire state is the
POST-cleanup state — purging ghosts could not have repaired it. The repair path
(regenerate keywords from descriptions) converges on a hand-lagged copy of the exact
data the native router already consumes at 45/45, which fails single-source-of-truth.

## What the retire removes (beyond skill matching)

The hook also carried, all lost at prompt time:

- Context-% tiered warnings (70/80/90 → handoff nudge). Partially covered: the
  statusline shows context %, and `auto-handoff-stop.py` reads the same
  `claude-context-pct-*` temp file at Stop. Re-home into a tiny hook if missed.
- Resource-limit advisory (`readResourceState`).
- Agentica pattern-inference banner — spawned `uv run python` on every prompt in
  project dirs, on a machine with a documented spawn-latency pathology.
- Workflow-detected banners (fix/build/commit/...) and the zero-match
  `npx skills find` suggestion.

Removing the per-prompt `node` + `uv python` spawn is itself a win on this machine.

## What stays alive

`skill-rules.json` still has live consumers and is NOT deleted: `vet-skill` /
`skill-install-registrar` (registration), `plan-mode-discovery`,
`session-start-init-check`, and 4 test files (`skill-rules-integrity`,
`frontend-routing-audit`, `skill-backward-compat`, `skill-router-integration`).
The hook source and its tests remain in the repo; re-registration is one settings entry.

## Verification

- Unregister: `grep -c skill-activation-prompt` → 0 in both settings.json copies; both parse as JSON.
- Hook suite after the change: `cd .claude/hooks && npx vitest run` → **117 files, 2306 passed, 7 skipped, 0 failed** (18.5s).
- `every-surface-checklist.md` Skills row updated (rules-src, canonical): description is the ONLY prompt-time trigger; skill-rules.json's remaining consumers named.

## Follow-ups (not done here)

- If the context-% prompt-time warning is missed, extract it into a standalone ~30-line
  UserPromptSubmit hook (no skill matching).
- `docs/hooks/README.md` and the system-visualization architecture map still describe the
  hook as active; refresh on next docs pass.
- Global skill-rules.json ghosts (`vercel-cli`, `find-skills` missing dirs in `~/.claude/skills`)
  are now cosmetic — no prompt-time consumer — but a future vet-skill run should not re-learn them.

Model + harness: claude-fable-5 via Claude Code.
