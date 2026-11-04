# bun trigger vanishes from the on-demand manifest

I added one entry to ~/.claude/rules-ondemand/manifest.json (the active copy) so that a rule loads when a `bun install` or `bun add` command runs. The entry is the same text each time: a regex `bun (install|add)` and the rule file `package-install-guard.md`.

- 10-26 09:40  added it. Worked all morning.
- 10-28  checked at 09:00, entry there. Checked at 19:00, entry gone.
- 10-29 08:15  added the same entry again.
- 10-30  checked at 09:00, entry there. Checked at 19:00, entry gone.
- 10-31 08:20  added it again. At 20:00 I set the file read-only (attrib +R).
- 11-01  checked at 09:00, entry there, read-only flag still on. Checked at 19:00, entry gone and the read-only flag was gone too.

Things I tried: restarted Claude Code twice, no change. `git status` in ~/continuous-claude is clean, and the repo manifest has no bun entry because I never edited it. I did not run any sync by hand. Several Claude Code sessions are open on this machine most days.

router-fires.log in this folder is the rule-router fire log for 11-01. I am not sure it is useful.
