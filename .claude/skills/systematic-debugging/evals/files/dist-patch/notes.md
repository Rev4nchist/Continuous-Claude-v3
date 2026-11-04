# rule-router cooldown patch

I patched `COOLDOWN_MS` in ~/.claude/hooks/dist/rule-router.mjs (the active copy) from 60000 to 0, so on-demand rules fire on every matching call.
I did not touch the repo or rebuild anything. I edited the built file directly.

- 10-12 08:30  patched. Rules fire on every call.
- 10-14 afternoon  rules stopped firing again. Cooldown is 60000 in the file.
- 10-15 09:10  patched again.
- 10-17 around 2pm  stopped working. Same 60000.
- 10-18 10:00  patched a third time.
- 10-20 late morning  stopped working. Same 60000.

Several Claude Code sessions run on this machine all day.
repo-rule-router.mjs in this folder = ~/continuous-claude/.claude/hooks/dist/rule-router.mjs today (repo build, first 12 lines).
