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
---

# Every-Surface Checklist

The most common defect in this repo is a change that works on the path you tested and is missing
everywhere else (Theo calls this "hit every surface" [vid:e1snsuY4lTI @32:54]). CCv3 has many
two-copy surfaces. Before you say "done", walk this list and name which rows applied.

| Surface | The two copies | Rule |
|---|---|---|
| Rules | `.claude/rules-src/*.md` (repo, canonical) and `~/.claude/rules/*.md` (active, auto-loaded) | Edit `rules-src` only. Never create `.claude/rules/` in the repo: Claude Code auto-loads it as project scope and every rule is paid for twice. |
| On-demand rules | `.claude/rules-ondemand/*.md` + `manifest.json` (repo) and `~/.claude/rules-ondemand/` (active, NOT auto-loaded) | Loaded by the `rule-router` hook at the action. A new or renamed trigger updates the manifest AND the index `rules-src/on-demand-rules.md`; prove it with `node scripts/rules/rule-router-probe.mjs`. |
| Hooks | `.claude/hooks/src/*.ts` (repo-only, never synced) and `hooks/dist/*.mjs` (built, synced) | `npm run build` in `.claude/hooks`, then sync. A src edit without a build changes nothing. |
| Hook gates | `settings.json` matcher AND the hook's own `tool_name` check | Two gates. Widening one does nothing until the other matches. Guard: `hook-matcher-runtime-consistency.test.ts`. |
| Settings | `~/.claude/settings.json` and the repo copy | Never synced. Edit both, via Node atomic RMW, never the Edit tool. |
| CLAUDE.md / RULES.md | `~/.claude/` (live, NEVER_SYNC) and `.claude/templates/*.template` (repo) | Edit live, copy to template in the same change. |
| Agents | `.claude/agents/<name>.md` and `.json` mirror | `model:` lives in both; `sync-agent-json.py` does not copy it. |
| Skills | `.claude/skills/<name>/SKILL.md` (repo) and `~/.claude/skills/` (active) | Repo is the source. Description is the ONLY prompt-time trigger (the skill-activation-prompt hook was retired 2026-08-19: 0 hits beyond the native router, 22/45 false fires); keep it one line, with "Use when ...". Ratchet: `node scripts/skills/audit-descriptions.mjs`. `skill-rules.json` still feeds vet-skill, plan-mode-discovery, and session-start-init-check, not prompt routing. |
| Registry | `.claude/project-registry.json` (repo) and `~/.claude/` mirror | Edit repo only; the active mirror is never auto-deleted. |
| Reverse states | register / unregister, claim / release, start / stop, enable / disable | If you add one direction, test the other in the same change. |

## What does NOT sync (do not expect it to)

`hooks/src/*.ts`, `settings.json`, `settings.local.json`, `CLAUDE.md`, `RULES.md`, `.env`,
`knowledge-tree.json`, `extraction-state.json`. Forward sync: `bash scripts/sync-to-active.sh`
(auto on commit). Reverse sync is manual-only: `bash scripts/sync-claude.sh --to-repo`; it aborts
if the repo has uncommitted changes in synced dirs. Drift check: `/sync-drift`.

## Before "done"

- Bad: "Matcher widened to PowerShell." (the runtime gate still said `!== 'Bash'`; nothing changed)
- Good: "Matcher widened AND `COMMAND_TOOLS` check updated in `package-install-guard.ts:41`; rebuilt; synced; probe fires on a PowerShell `pip install`."
