# Sentry Safety Rules

Reads are safe (`sentry-cli info`, `… list`, `sourcemaps explain`, read-only MCP queries). Every write
is confirm-first: creating, finalizing or deleting a release, set-commits, resolving or muting issues,
uploading source maps, recording deploys, creating projects, deleting monitors or artifacts, and any
Sentry MCP write. First check `sentry-cli info` and confirm the project and release version. Full
command lists and the source-map upload checklist: `.claude/skills/sentry-cli/SKILL.md`, section
"Safety".
