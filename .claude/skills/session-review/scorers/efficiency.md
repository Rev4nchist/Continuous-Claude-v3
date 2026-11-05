# Scorer: efficiency

## What to assess

Did the session take a direct path? Count slips from the digest. Each distinct pattern is one slip.

Inputs: `tools.repeated_failures[]`, `tools.rework_files[]`, `tools.errors_by_class`,
`context.compactions[]`, `time.idle_gaps_over_30m`, `time.active_ms`, `tools.calls_by_name`.

Definitions:
- Environment flailing: the same failed lookup run 3 or more times (a port, an env var, a path, a
  tool location). Source: `repeated_failures` with `n >= 3`.
- Rework loop: 3 or more edits to one file after a failed check. Source: `rework_files`.
- Idle tool calls: long gaps (`idle_gaps_over_30m`) with the agent waiting, or polling a result that
  an earlier call already returned. Check an excerpt before you count this.
- Compaction caused by a loop: a compaction that follows a flailing or rework pattern.

Active time alone is not a slip. A long job with a direct path scores 1.0.

## Scale

- 1.0: direct path. No slip.
- 0.8: one slip.
- 0.4: failing. Two or three slips, or one rework loop of 6 or more edits.
- 0.2: highly inefficient. Four or more slips, or a loop that forced a compaction.

## N/A when

Never. A session with no tool calls scores 1.0.
