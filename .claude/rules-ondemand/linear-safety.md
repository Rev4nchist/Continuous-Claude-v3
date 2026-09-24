# Linear Safety Rules

Reads are safe (`linearis … list/read/search`, `linear issue list/view`, read-only MCP tools). Every
write is confirm-first: creating, updating, commenting on, starting or deleting an issue (CLI or MCP).
Before a write, show the issue's current state; before a create, search for duplicates; warn that a
delete cannot be undone. Full command lists: `.claude/skills/linear/SKILL.md`, section "Safety".
