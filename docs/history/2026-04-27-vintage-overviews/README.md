# Archived: Vintage Overview Docs (2026-04-27)

## Why archived

These docs were written in early 2026 as part of the initial CCv3 setup. They contained substantial overlap with the canonical `architecture/` tree (especially `architecture/subsystems/memory.md`) and carried stale facts that contradicted the current state after Phases 1-5c.

## What's here

- **`CONTINUOUS-CLAUDE-MEMORY.md`** (dated 2026-01-30) — System memory architecture overview. ~70% content overlap with `architecture/subsystems/memory.md`. Hook list contradicted the live state in `architecture/quick-ref/hook-catalog.md`. The unique content (Braintrust component details, "Five Pillars" mega-diagram) is either out-of-date or covered by current docs.

## Reviving

If a future change reveals unique content that should resurface, copy the relevant section into the appropriate canonical doc:
- Memory architecture → `architecture/subsystems/memory.md`
- Hook integration tables → `architecture/quick-ref/hook-catalog.md`
- Five Pillars → `architecture/INDEX.md` (canonical version)

Do not restore the archive itself — fold its content forward into current docs.

## Audit trail

- Archived in commit: see `git log --diff-filter=R -- .claude/docs/_archived/2026-04-27-vintage-overviews/`
- Decision recorded in: `.claude/docs/hook-audit-2026-04.md` Phase 5c addendum (the "Open follow-ups" table referenced this archive candidate)
- Maestro workflow that drove this: documentation alignment session 2026-04-27
