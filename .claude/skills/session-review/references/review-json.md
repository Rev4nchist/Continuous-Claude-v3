# review.json

Input of `scripts/render-html.mjs`. The main session writes it after the markdown report.
Every field is optional except `run` and `sessions`. A missing section is hidden. The renderer never throws.
Run `validateReview` (exported by the renderer, and run by the CLI) to list problems.

## Rules

- Only redacted, truncated digest text may enter this file. No raw transcript text.
- Scores run 0.0 to 1.0, the same as `scorers/`. `null` means N/A. The heatmap has five bands:
  to 0.2, to 0.4, to 0.6, to 0.8, above 0.8. A mean skips `null`.
- Every `uuid` comes from a digest. A cite is a label plus a `uuid`. The page shows the first 8 characters.
- The renderer cuts each string at 400 characters and escapes it. Keep text short.
- A link renders only when `url` starts with `https://`. Otherwise the text shows with no link.
- `example: true` adds an EXAMPLE banner. Use it for fixtures only.

## Fields

```
{
  "example": false,
  "run": { "run_ts", "date": "YYYY-MM-DD", "zone", "note",
           "sessions_sampled", "sessions_eligible", "overflow_count",
           "skipped": { "self", "review_run", "headless", "no_human" },
           "chains", "wall_ms", "active_ms", "cost_usd" /* null = unavailable */, "cost_source", "review_cost" },
  "top_finding": { "text", "target" },          // else the first improvement
  "scorers": ["goal", ...],                      // column order; else taken from the sessions
  "unstable": ["efficiency"],                    // scorers that failed the stability check
  "sessions": [{ "label": "name #sid8", "chain_id", "window", "goal", "outcome", "partial",
                 "scores": { "goal": 0.8, "tests": null },
                 "notes": [{ "scorer", "uuid", "text" }],
                 "corrections": [{ "uuid", "class" }],
                 "hook_blocks": [{ "guard", "response": "workaround | fix" }],
                 "evidence": { "check", "is_error", "before_claim", "after_last_edit" },
                 "active_ms", "wall_ms" /* null = live */, "cost_usd", "cost_source" }],
  "improvements": [{ "title", "class", "target_hint", "target_surface": "rule|hook|skill|agent|stage|other",
                     "target_file", "severity": "high|medium|low", "chains", "summary",
                     "evidence": [{ "label", "uuid" }],
                     "expected_saving_min", "expected_saving_usd", "verdict": "ADOPT|WATCH|SKIP" }],
  "watch": [{ "label", "uuid", "class", "target_hint", "note" }],
  "factory": { "stations": [{ "id": "01", "name", "signal", "ran", "had_evidence", "passed" }],
               "lane_signals": [{ "text", "url" }], "pr_signals": [{ "text", "url" }], "example_line" },
  "harness": [{ "class", "count", "target", "note" }],
  "trend": { "label", "points": [{ "run_ts", "mean" }], "regressions": [{ "scorer", "previous", "current", "changed" }] }
}
```

## Sections on the page

`summary` (always), `heatmap`, `improvements`, `factory`, `harness`, `sessions`, `watch`, `trend`.

- Improvements show in the order given. Rank them first, by the rank key in SKILL.md.
- Station state comes from the three booleans: not ran is "Did not run", ran and not passed is "Failed",
  passed with no evidence is "No evidence", else "Passed". Use id `R` for the Coordinate rail.
- `trend.points` come from the ledger: one mean per run, oldest first. Fewer than one valid point hides the section.
- The first session card is open. The others are closed.
