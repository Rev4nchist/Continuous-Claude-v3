# hooks timeout keeps reverting

Target: the PreToolUse hook `timeout` in ~/.claude/settings.json (active copy).
I edit it by hand in ~/.claude. I have not touched the repo copy.

- 09-26 10:12  set 5 -> 30. Works.
- 09-26 16:40  back to 5.
- 09-28 09:05  set 5 -> 30 again.
- 09-28 14:22  back to 5.
- 09-30 08:50  set 5 -> 30 again.
- 09-30 11:31  back to 5.

Other Claude Code sessions were running on all three days.
repo-settings.json in this folder = ~/continuous-claude/.claude/settings.json today (repo copy).
