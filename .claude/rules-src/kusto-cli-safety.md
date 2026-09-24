# Kusto.Cli Safety Rules

**Any Kusto command starting with `.` that is not `.show …` needs Dave's explicit confirmation before
it runs.** Default-deny: an unfamiliar `.`-command is confirm-first, never assumed safe. Pure KQL
queries, `.show …`, `#` client directives and `.execute database script with (whatif=true)` are safe.

Before any control command: echo the target (`#dbcontext`, `.show cluster`), show what is about to
change (`.show table X cslschema`, `X | count`), and state the blast radius. `.drop extents` and
`.purge` are irreversible. Never echo a connection string that embeds a secret (`AppKey=`,
`UserToken=`, `AccessToken=`).

The full command families, pre-flight steps and auth modes are in `.claude/skills/kusto-cli/SKILL.md`
(section "Safety").
