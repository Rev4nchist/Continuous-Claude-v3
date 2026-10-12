# codex-lift.jsonl — Cross-Model Lift Telemetry

Tracks the value Codex actually adds beyond what Claude finds, per `/review` and `/premortem` run.

## Schema (one JSON object per line)

```json
{
  "ts": "2026-05-21T18:42:00Z",     // ISO 8601 UTC timestamp
  "skill": "review" | "premortem",   // which skill wrote the row
  "scope": "PR-#123" | "plans/foo.md" | "HEAD", // what was reviewed
  "claude_only": 3,                  // findings only Claude/critic flagged
  "codex_only": 2,                   // findings only Codex flagged (THE LIFT)
  "both": 4,                         // findings BOTH flagged (high-confidence)
  "via": "runner" | "direct" | "envoy", // transport — "runner" = written by `adversary.mjs lift` (current); "direct"/"envoy" = older rows
  "reviewer_model": "gpt-6.1-sol",   // runner rows: the model the receipt observed
  "reviewer_effort": "xhigh",        // runner rows: the effort the run used
  "codex_run": "<run-id>",           // runner rows: joins to a row in ~/.claude/logs/codex-adversary.jsonl
  "codex_status": "ok"               // runner rows: receipt status (lift rows are written only for "ok")
}
```

Write rows with `node "$HOME/.claude/scripts/codex/adversary.mjs" lift --run <run-id> --skill <name> --scope <text> --claude-only <n> --codex-only <n> --both <n> --project <abs dir>`. Do not hand-write a row with a hardcoded `via`.

## Per-run receipts

Every runner call (not only reviews that reach synthesis) appends one row to `~/.claude/logs/codex-adversary.jsonl` and writes `~/.claude/cache/codex-adversary/runs/<run>/`. Keys:

`ts, run, status, via, mode, scope, project, model_requested, model_observed, effort, effort_requested, provider, cli, bin, session_id, exit_code, final_bytes, final_sha256, json, tokens, duration_s, prompt_bytes, framing, cache, usage_limited, stub, untracked_not_reviewed, cleanup, reason`

`bin` shows which Codex binary ran (`bin=env` means an overridden binary). `json` is 1 when Codex answered in JSON, 0 when it answered in prose. `untracked_not_reviewed` counts untracked files that a `--working-tree` run did not review. `cleanup` records how the runner stopped its own process tree.

`node "$HOME/.claude/scripts/codex/adversary.mjs" verify <run-id>` checks the stored receipt and the saved log of one run. A lift row joins to its receipt row on `codex_run` = `run`. This file lives under `~/.claude/logs/`, outside any repo, so it is never committed.

## Meaning of the counts

For `/review`, "Claude" means the combined critic + plan-reviewer outputs. For `/premortem`, "Claude" means the inline 3-category risk framework output.

## Why this metric

The whole point of cross-model review is the **lift** — issues only the other model catches. If `codex_only` is consistently zero, Codex is duplicating Claude's work and the quota cost isn't justified. If `both` is consistently high but `codex_only` is zero, the same applies. If `codex_only > 0` regularly, the integration is earning its keep.

## Query patterns

### Lift rate over last 50 runs

```bash
tail -n 50 .claude/logs/codex-lift.jsonl | \
  jq -s 'map(.codex_only) | add / length'
```

### Lift by skill

```bash
jq -s 'group_by(.skill) | map({
  skill: .[0].skill,
  runs: length,
  avg_codex_only: (map(.codex_only) | add / length),
  avg_both: (map(.both) | add / length)
})' .claude/logs/codex-lift.jsonl
```

### Runs where Codex caught something Claude missed

```bash
jq -c 'select(.codex_only > 0)' .claude/logs/codex-lift.jsonl
```

### Direct vs Envoy comparison (Phase E pilot)

```bash
jq -s 'group_by(.via) | map({
  via: .[0].via,
  runs: length,
  avg_codex_only: (map(.codex_only) | add / length)
})' .claude/logs/codex-lift.jsonl
```

## Adoption decision threshold

If after 20+ runs `avg(codex_only) < 0.2`, consider:
- Tightening the adversarial-review prompt at `vendor/codex-plugin-cc/prompts/adversarial-review.md`
- Disabling the default Codex pass and making it opt-in (`--codex` flag instead of `--no-codex`)
- Investigating whether Codex output is being filtered out incorrectly during synthesis

## Git status

`codex-lift.jsonl` is NOT committed. `.gitignore` line 35 (`.claude/logs/*.jsonl`) ignores it, as it ignores every jsonl log in this directory. This README is tracked; the data is local to each machine. (An earlier version of this README claimed the file was committed. That was wrong.)
