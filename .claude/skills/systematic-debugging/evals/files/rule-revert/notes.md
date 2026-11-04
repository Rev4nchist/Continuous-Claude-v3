# agent-limits keeps reverting

Target: the line `Max parallel agents: 4` in ~/.claude/rules/agent-limits.md (active copy).
I edit it by hand in ~/.claude. I have not touched the repo copy.

- 09-26 10:12  set 4 -> 6. Works.
- 09-26 16:40  back to 4.
- 09-28 09:05  set 4 -> 6 again.
- 09-28 14:22  back to 4.
- 09-30 08:50  set 4 -> 6 again.
- 09-30 11:31  back to 4.

Other Claude Code sessions were running on all three days.
repo-agent-limits.md in this folder = ~/continuous-claude/.claude/rules-src/agent-limits.md today (repo copy).
