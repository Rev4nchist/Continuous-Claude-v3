# Dynamic Recall

**This content has been consolidated into the canonical memory skill.**

See: `.claude/skills/memory/SKILL.md`

## Summary (for continuity)

You have access to a semantic memory system (PostgreSQL + pgvector, 100+
learnings with BGE embeddings) that stores learnings, decisions, and patterns
from past sessions. Query it proactively before starting work that may have
prior precedent, when hitting tricky errors, or when making architectural
decisions.

Canonical skill covers: CLI invocation (hybrid RRF default, `--k`,
`--vector-only`, `--text-only`), backend architecture, score interpretation
(RRF 0.01-0.03 is good — don't confuse with low relevance), and example
queries.
