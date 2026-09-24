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
- Hooks: edit `.claude/hooks/src/*.ts`, then `npm run build` in `.claude/hooks`. Only `dist/*.mjs` runs.
- Hook tests: `npm test` in `.claude/hooks` (vitest, not jest).
- Forward sync to active: `bash scripts/sync-to-active.sh`. It runs on commit. Reverse sync is manual only.
- Before "done", walk `.claude/rules-src/every-surface-checklist.md`.
- Testing: what "done" means per surface in this repo: @AGENTS.md

## Git

- Push to `fork` (Rev4nchist). Never push to `origin` (parcadei).
- Commit and push through `pwsh -File scripts/git-safe.ps1 -C <repo> ...`.
- Stage only the files you touched. No feature work on `main`.
