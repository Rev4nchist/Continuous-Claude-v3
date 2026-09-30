# CLAUDE.md: continuous-claude (CCv3)

This repo is the canonical source of the harness. `~/.claude` is the active copy that Claude Code reads.
The global `~/.claude/CLAUDE.md`, `RULES.md` and `~/.claude/rules/` already load in every session.
This file adds only what is specific to this repo. Do not repeat global content here.

Glossary, loaded in every session. Use these exact terms: @CONTEXT.md

## Start here

- Refinement work: `docs/harness-strategy/README.md`.
- Concurrent sessions share this tree. Claim a lane first: `node scripts/coordination/lane.mjs next`.

## Repo facts

- Edit rules in `.claude/rules-src/`. Never create `.claude/rules/` in this repo; it loads every rule twice.
- Forward sync after a merge: on `main`, run `scripts/sync-to-active.sh --changed` in Git Bash. Reverse sync is manual only.
- Before "done", walk `.claude/rules-src/every-surface-checklist.md`.
- Testing: what "done" means per surface in this repo: @AGENTS.md
