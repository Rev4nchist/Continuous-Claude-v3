# Write-back: page body for Code → Eve, Donna or Grok (and Grok → Eve or Donna)

Row properties: `From` = Code (or Grok), `To` = Eve, Donna or Grok, `Status` = Unread, Priority, Date, Summary, Project.
Row title: `[From→To] Title — YYYY-MM-DD`, with From = the writer. Tracker: Claude Code write-backs are
mirrored to the Weekly Work Tracker, then get the `**Tracker-Row:**` line. Grok write-backs are NOT
mirrored: delete the `**Tracker-Row:**` line.

---

**Commits:** {{commit_shas}}
**Tracker-Row:** {{tracker_row_url}}   (Claude Code only; delete this line for a Grok write-back)

## What Shipped

[What was built, changed, or decided. Be specific: file paths, versions, test counts.]

## Health / Status

[Green / Amber / Red. Any blockers. Any open questions.]

## Narrative Seed

[1-2 sentences Eve or Donna can use as-is in an executive summary. Plain words, business impact first.]

## Business Impact

[What this means for Dave or leadership. No jargon.]

## What's Next

[Queued next steps, or the decision needed before proceeding.]

## Notes / Flags

[Anything political, risky, or worth Dave knowing that will not show up in metrics.]

## References

[Commits, PRs, Notion pages, the original handoff row.]
