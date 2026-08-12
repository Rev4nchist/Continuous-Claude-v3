# Agent Memory Recall

**This content has been consolidated into the canonical memory skill.**

See: `.claude/skills/memory/SKILL.md`

## Summary (for continuity)

Before starting implementation tasks, agents (kraken, architect, phoenix,
spark) should check the archival memory for relevant prior learnings.
Especially useful when implementing features similar to past work, working
with hooks/skills/wizard code, or debugging errors that may have been solved
before.

If the memory-awareness hook showed a `MEMORY MATCH` in context, follow up
with `/recall` for the full content. Canonical skill covers commands,
options, and scoring guidance.
