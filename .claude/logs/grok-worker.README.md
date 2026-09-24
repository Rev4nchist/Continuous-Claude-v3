# grok-worker.jsonl — Grok Task-Execution Telemetry

One row per `/grok` run (the `grok-worker` agent). Sibling of `codex-worker.jsonl` (that tracks GPT-5.5/Codex task execution; this tracks xAI Grok task execution). The `.jsonl` is gitignored (`.claude/logs/*.jsonl`) — machine-local runtime data; this README is committed.

## Schema (one JSON object per TURN)

**One row per turn** — an implement-then-resume interaction is TWO rows (one `implement`, one `resume`), never a combined `mode:"implement+resume"`.

```json
{
  "ts": "2026-07-11T14:32:00Z",           // ISO 8601 UTC
  "mode": "ask" | "implement" | "resume",  // exactly one
  "model": "grok-4.5",                     // always in {grok-4.5, grok-composer-2.5-fast}
  "tools_guard": true,                     // true = ask mode ran with --tools "read_file,list_dir,grep" (the ONLY
                                            // verified read-only boundary — --sandbox is decorative); false =
                                            // implement/resume ran with the full write toolset, worktree-isolated
  "scope": "ask" | "worktree" | "resume:<sessionId>",  // ask=no worktree; worktree=implement; resume embeds the captured session id
  "task_summary": "add --limit flag to query.mjs",
  "exit_code": 0,                          // grok CLI return code
  "git_diff_stat": "1 file changed, 22 insertions(+), 3 deletions(-)",  // "" for ask
  "session_id": "abc123-...",              // implement/resume only: the Grok sessionId from --output-format json; "" for ask
  "usage_limited": false,                  // true if the run hit the X Premium+ subscription rate/usage limit (reactive detect)
  "via": "claude-code" | "ralph" | "scheduled"
}
```

`session_id` is captured from the `--output-format json` response's `.sessionId` field. It is threaded into `resume` (as `grok -r <sessionId>`) and embedded in the resume row's `scope` as `resume:<sessionId>`.

Optional richer fields for a future version, if `--json-schema` structured output or richer event parsing is added: `wall_clock_s`, `tokens`, `files_changed`, `worktree_path`.

## Why this metric

`/grok` spends X Premium+ subscription quota (no dollar price observed). This log is how usage patterns and the review-gate audit trail (was a write run's diff actually reviewed-and-applied vs discarded) are reconstructed. A run blocked by the subscription rate/usage limit is flagged `usage_limited:true` (reactive — Grok exposes no queryable quota surface to preflight; detected from a non-zero exit whose log matches `rate.?limit|usage limit|quota`).

## Query patterns

### Implement runs, by exit code
```bash
jq -c 'select(.mode=="implement")' .claude/logs/grok-worker.jsonl
```

### Runs by mode
```bash
jq -s 'group_by(.mode) | map({mode: .[0].mode, runs: length})' .claude/logs/grok-worker.jsonl
```

### Non-zero exits (failed runs)
```bash
jq -c 'select(.exit_code != 0)' .claude/logs/grok-worker.jsonl
```

### Runs blocked by the subscription usage/rate limit
```bash
jq -c 'select(.usage_limited == true)' .claude/logs/grok-worker.jsonl
```

## Related

- Safety contract: `.claude/rules-ondemand/grok-worker-safety.md`
- Engine: `.claude/agents/grok-worker.md` · Skill: `.claude/skills/grok/SKILL.md`
- Design + evidence: `docs/grok-integration/DESIGN-RESEARCH.md`
- Sibling (Codex): `.claude/logs/codex-worker.README.md`
