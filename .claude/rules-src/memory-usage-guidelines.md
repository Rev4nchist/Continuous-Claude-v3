# Memory Usage Guidelines

**This content has been consolidated into the canonical memory skill.**

See: `.claude/skills/memory/SKILL.md`

## Summary (for continuity)

Manual stores should be rare and high-value. 98% of entries are auto-extracted
by hooks. The L0 quality gate auto-blocks NOISE entries (score <3) before they
reach PostgreSQL — if a learning doesn't appear in recall, the scorer may
have filtered it (intentional).

Ask before storing: "Would a future session actually benefit from this, or
can they find it in 10 seconds?" Always recall first to check for duplicates.

Canonical skill covers: the full DO/DO NOT tables, GOOD vs BAD quality
examples, the store command, and the complete learning-type reference.
