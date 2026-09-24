# Tri-model documentation

Cross-model collaboration for **Claude Code + Codex + Grok** inside Continuous Claude.
Roster doctrine: **Grok builds · Codex reviews/fixes · Claude is hub · human holds Gates 1 & 2.**

**Start here → [CURRENT-STATE.md](./CURRENT-STATE.md)** — the quick system-state report
(machine-refreshed snapshot block + hand-maintained narrative). Refresh it after any
tri-model change: `node scripts/tri-model/sync-current-state.mjs` (`--check` = staleness probe).

## Live docs

| Doc | Purpose |
|-----|---------|
| [CURRENT-STATE.md](./CURRENT-STATE.md) | **Ground truth** — layer status, probe-backed facts, open items |
| [COLLABORATION-PLAN.md](./COLLABORATION-PLAN.md) | Governance design rationale (roster + workroom + phases) — EXECUTED 2026-07-11; kept as the why |
| [../grok-integration/DESIGN-RESEARCH.md](../grok-integration/DESIGN-RESEARCH.md) | Live-probed Grok CLI surface (safety facts source of truth) |
| [../codex-integration/DESIGN-RESEARCH.md](../codex-integration/DESIGN-RESEARCH.md) | Live-probed Codex CLI surface (§13 = 0.144.1 + gpt-5.6; §14 = read-only fork-storm) |
| [cockpit-guide.html](./cockpit-guide.html) | Operator cockpit guide (controls, gates, ask-moments, troubleshooting) |
| [system-overview.html](./system-overview.html) | Interactive visual overview (roster, topology, pipeline, disk bus) |

## Historical records (executed plans — do not treat as pending work)

| Doc | What it was |
|-----|-------------|
| [SESSION-REVIEW-2026-07-11.md](./SESSION-REVIEW-2026-07-11.md) | Combined build order for the governance session — executed same day (PR #19) |
| [BUILD-PLAN-2026-07-11.md](./BUILD-PLAN-2026-07-11.md) | The connection-layer plan as approved (PR #18) — see its erratum |

## Operational surfaces

| Surface | Path |
|---------|------|
| Workroom protocol (doctrine, phases, message schema — **schema owner**) | `.workroom/PROTOCOL.md` |
| Room templates | `.workroom/templates/` |
| `/workroom` skill (disk bus: new/status/post/advance/resume) | `.claude/skills/workroom/SKILL.md` |
| `/game-plan` skill (full pipeline orchestrator) | `.claude/skills/game-plan/SKILL.md` |
| Preflight gate (auth, identity pin, version-pin block) | `scripts/tri-model/preflight.mjs` |
| Static consistency suite | `scripts/tri-model/tri-model-suite.sh` |
| Grok skill / safety rule | `.claude/skills/grok/SKILL.md` · `.claude/rules-ondemand/grok-worker-safety.md` |
| Codex skill / safety rule | `.claude/skills/codex/SKILL.md` · `.claude/rules-ondemand/codex-worker-safety.md` |
| Harness update playbook (the ONLY model/CLI update path) | `.claude/skills/harness-update/SKILL.md` · `.claude/rules-ondemand/harness-update.md` |

## Human-facing mirrors (Notion)

- [Tri-Model Cockpit Guide](https://app.notion.com/p/39a76fd7ac82817abc0bffdfeaec1c54) — operator view, Project Board child (embed of `cockpit-guide.html` + AI digest)
- [Cross-Model Workers in CCv3](https://app.notion.com/p/39676fd7ac8281068c7ee4b6f793f5af) — technical how-to (roster + Game Plan section current as of 2026-07-11)
- Visual map (Claude.ai artifact, may lag the repo): `claude.ai/code/artifact/edadfc5f-fa44-4952-a299-23f586d1c435`

**Placement rule:** durable multi-model plans and contracts live **in this repo** (`docs/` /
`.workroom/`), never only under `~/.grok/sessions/`, `~/.claude/plans/`, or chat. Active
feature state lives in `.workroom/rooms/<id>/` (gitignored runtime; `git add -f` a CONTRACT
deliberately to share one).
