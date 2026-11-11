# CLAUDE.md: continuous-claude (CCv3)

The global `~/.claude/CLAUDE.md`, `RULES.md` and `~/.claude/rules/` already load. Add only repo-specific content here.

Glossary, loaded in every session. Use these exact terms: @CONTEXT.md

## Start here

- Refinement work: `docs/harness-strategy/README.md`.
- Sessions share this tree. Claim a lane by id: `node C:/Users/dkhay/.claude/scripts/lane.mjs claim <id>`.
- Before you claim a lane, run the `kanban-sync` skill. It copies Dave's kanban changes into the lane DB.

## Repo facts

- Edit rules in `.claude/rules-src/`. Never create `.claude/rules/` in this repo; it loads every rule twice.
- Forward sync after a merge: on `main`, run `scripts/sync-to-active.sh --changed` in Git Bash.
- Before "done", walk `.claude/rules-src/every-surface-checklist.md`.
- Testing: what "done" means per surface in this repo: @AGENTS.md
