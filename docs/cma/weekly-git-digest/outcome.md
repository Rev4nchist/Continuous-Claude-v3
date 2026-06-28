# Outcome rubric — weekly-git-digest

The grader checks each run against these binary criteria (the agent's definition of done):

1. `digest.md` exists in `/mnt/session/outputs/` and covers every repository named in the kickoff (a repo with no activity is covered by an explicit "no commits this window" line).
2. Activity is grouped by project/repo, and every repo with commits cites at least its notable commits by short SHA + message, plus any merged PRs.
3. Every commit, SHA, and PR referenced is real and falls inside the computed 7-day window — nothing fabricated; anything uncertain is explicitly marked.
4. A section tagged with this run's run-key (`[key:weekly-git-digest:<ISO-week>:<hash>]`) was published to the configured Notion parent page, verified by reading the blocks back, with **no duplicate** section for the same run-key (upsert, not blind append).
5. No secret (`GITHUB_TOKEN` / `NOTION_TOKEN` / any `Bearer` token) appears anywhere in `digest.md` or the Notion content.
6. The publish targeted only the configured parent page — no other Notion page was modified.
