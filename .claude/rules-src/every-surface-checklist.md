---
paths:
  - ".claude/rules-src/**"
  - ".claude/rules-ondemand/**"
  - ".claude/hooks/**"
  - ".claude/skills/**"
  - ".claude/agents/**"
  - ".claude/templates/**"
  - ".claude/settings.json"
  - ".claude/settings.json.template"
  - ".claude/project-registry.json"
  - "scripts/sync-to-active.sh"
  - "scripts/sync-claude.sh"
  - "scripts/coordination/**"
  - "apps/agentic-os/drizzle/**"
  - ".claude/artifacts.json"
  - "COORDINATION.md"
---

# Every-Surface Checklist

The most common defect in this repo is a change that works on the path you tested and is missing
everywhere else (Theo calls this "hit every surface" [vid:e1snsuY4lTI @32:54]). CCv3 has many
two-copy surfaces. Before you say "done", walk this list and name which rows applied.

| Surface | The two copies | Rule |
|---|---|---|
| Rules | `.claude/rules-src/*.md` (repo, canonical) and `~/.claude/rules/*.md` (active, auto-loaded) | Edit `rules-src` only. Never create `.claude/rules/` in the repo: Claude Code auto-loads it as project scope and every rule is paid for twice. |
| On-demand rules | `.claude/rules-ondemand/*.md` + `manifest.json` (repo) and `~/.claude/rules-ondemand/` (active, NOT auto-loaded) | Loaded by the `rule-router` hook at the action. A new or renamed trigger updates the manifest AND the index `rules-src/on-demand-rules.md`; prove it with `node scripts/rules/rule-router-probe.mjs`. Gate: `node scripts/rules/ondemand-index-check.mjs` (pre-commit). |
| Hooks | `.claude/hooks/src/*.ts` (repo-only, never synced) and `hooks/dist/*.mjs` (built, synced) | `npm run build` in `.claude/hooks`, then sync. A src edit without a build changes nothing. |
| Hook gates | `settings.json` matcher AND the hook's own `tool_name` check | Two gates. Widening one does nothing until the other matches. Guard: `hook-matcher-runtime-consistency.test.ts`. |
| Settings | template and rendered `~/.claude/settings.json` | Never synced. Render the template. Do not commit the render. |
| CLAUDE.md / RULES.md | `.claude/templates/*.template` (repo, canonical) and `~/.claude/` (live) | Edit the template only. Forward sync installs it; a live-only edit is quarantined, then overwritten. |
| Agents | `.claude/agents/<name>.md` and `.json` mirror | `model:` lives in both; `sync-agent-json.py` does not copy it. `effort:` lives only in the `.md`; the `.json` has none. |
| Skills | `.claude/skills/<name>/SKILL.md` (repo) and `~/.claude/skills/` (active) | Repo is the source. Description is the ONLY prompt-time trigger (the skill-activation-prompt hook was retired 2026-08-19); one line: "Does X. Use when Y." Gate: `node scripts/skills/audit-skills.mjs`. A new skill also needs `node scripts/architecture/build-system-map.mjs --apply` before pre-pr (CI test G13). `skill-rules.json` feeds vet-skill, plan-mode-discovery and session-start-init-check, not routing. |
| Registry | `.claude/project-registry.json` (repo) and `~/.claude/` mirror | Edit repo only; the active mirror is never auto-deleted. |
| Lane CLI and shim | `lane.mjs` in `scripts/coordination/` (primary checkout) and the shim `.claude/scripts/lane.mjs` (synced to `~/.claude/scripts/`) | Model-run text calls the shim path, never a relative `lane.mjs`; hooks keep the absolute primary path. Gate: `node scripts/coordination/lane-path-guard.mjs`. |
| Resolver twins | `scripts/coordination/lane-board.mjs` and `.claude/hooks/src/shared/lane-board.ts` | Change both in one commit; the drift test `lane-board-resolver.test.ts` fails if they differ. Keep them pure: no cache, no DB. |
| Lane schema | `apps/agentic-os/drizzle/**` and the live `agentic_os` tables | Confirm-first with Dave. Expand before contract. Prove on `scratch-db.mjs`, then apply by the runbook. |
| DB writers | every client that writes `agentic_os.lane` | Each sets `lane.client_version` before it writes, or the board trigger denies it (42501) once a second board exists. |
| Hooks and hint text | `.claude/hooks/src/lane-*.ts`, `session-register.ts`, `shared/session-names.ts` | Hint text uses `laneCliCmd()` from the twins. Build, then pipe a real payload into `dist/lane-context.mjs`. |
| Hook registrations | `.claude/settings.json.template` and live `~/.claude/settings.json` | Never synced. After Dave says yes, run `apply-registrations.mjs --apply --only <hook>`, then `render-settings.mjs --check`. |
| Phone board | `scripts/coordination/render-board.mjs` output and the artifact in `.claude/artifacts.json` | `continuous-claude` keeps its page in `artifacts.json`; any other board has one only with `laneArtifact` in its registry entry (`/publish-board`). Render from the primary checkout, publish to that board's own URL, read back the meta stamp. |
| Lane consumers | Agentic OS app, the `/os` pane in `ccv3-mods`, the `kanban-sync` skill | Each reads one board and passes `--project` or the session cwd. An unregistered folder shows "no lane board". |
| Registration paths | `lane.mjs project register`, `/init-project`, the `project-registry` skill | One writer for a board: `project register`, from the primary checkout. A second board only after the release steps pass. |
| Docs and onboarding | `CONTEXT.md`, `COORDINATION.md`, `rules-ondemand/lane-board.md`, `docs/harness/lane-board-claude-md-pointer.md` | Update all four when board behaviour changes. A project `CLAUDE.md` pointer needs Dave's yes per project. |
| Worktree copies | `.claude/worktrees/*/scripts/coordination/` | Stale copies of the lane CLI. Do not edit or run them; use the shim. |
| Shared store link | the real `.claude/hooks/node_modules` (primary) and the link `.claude/worktrees/node_modules` | One link serves every nested worktree. Apply it once, from the primary, with Dave's yes. Check: `node scripts/worktree/shared-deps.mjs --check`. |
| Reverse states | register / unregister, claim / release, start / stop, enable / disable | If you add one direction, test the other in the same change. |

## Rule-router records

Triggers: `~/.claude/rules-ondemand/manifest.json`. Fires: `~/.claude/logs/rule-router.jsonl`.
False fires: `~/.claude/logs/rule-router-false-fires.jsonl`.
Weekly audit (`CCv3-RuleRouter-Audit`, Mondays): `docs/self-improvement/audits/rule-router-<date>.md`.
`CCv3-RuleRouter-Review` judges unrecorded fires each Monday and posts a review to Dave's Notion Scratchpad.

## What does NOT sync (do not expect it to)

`hooks/src/*.ts`, `settings.json`, `settings.local.json`, `.env`, `knowledge-tree.json`,
`extraction-state.json`, and any `CLAUDE.md` / `RULES.md` other than the two templates. Forward sync: `bash scripts/sync-to-active.sh`
(auto on commit). Reverse sync is manual-only: `bash scripts/sync-claude.sh --to-repo`; it aborts
if the repo has uncommitted changes in synced dirs. Drift check: `/sync-drift`.

## Before "done"

- Bad: "Matcher widened to PowerShell." (the runtime gate still said `!== 'Bash'`; nothing changed)
- Good: "Matcher widened AND `COMMAND_TOOLS` check updated in `package-install-guard.ts:41`; rebuilt; synced; probe fires on a PowerShell `pip install`."
