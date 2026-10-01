---
name: memory-stats
description: Report hit rate, score distribution, and quality of the proactive memory-recall surface. Use when you want to audit how well memory-awareness is performing — what intents match, what doesn't, what scores typically look like. Reads .claude/logs/memory-recall.jsonl.
metadata:
  user-invocable: true
---

# Memory Stats

Audit the proactive memory-recall surface using the observability log written
by the `memory-awareness` UserPromptSubmit hook.

## What This Skill Does

The `memory-awareness` hook fires on every non-trivial user prompt and, as of
Wave 3 of the memory-hardening-2026-05-16 work, appends one JSON line per
fire to `.claude/logs/memory-recall.jsonl`. This skill is the lens for
reading that log: hit rate, score distribution, which intents consistently
miss, and whether the floor filter is too tight or too loose.

## When to Use

- Auditing whether memory-awareness is actually surfacing useful learnings
- Tuning `PROACTIVE_INJECTION_FLOOR` in `memory-awareness.ts`
- Finding "intent dead zones" — queries that consistently return zero hits
- Investigating why a recall didn't fire when you expected one
- Reviewing source breakdown (local index vs global DB vs merged)

## Log Schema

Each line in `.claude/logs/memory-recall.jsonl`:

```json
{
  "timestamp": "2026-05-16T15:30:00.000Z",
  "session_id": "abc-123",
  "subagent": null,
  "intent": "how does the memory hook work",
  "results_count": 5,
  "top_score": 0.087,
  "kept_after_floor": 3,
  "source": "local|db|merged|empty"
}
```

Field reference:

| Field | Meaning |
|-------|---------|
| `timestamp` | ISO-8601 UTC when the hook fired |
| `session_id` | Claude Code session id (matches `~/.claude/projects/...` files) |
| `subagent` | `CLAUDE_AGENT_ID` if invoked from a subagent, else `null` |
| `intent` | The extracted-intent string the hook actually queried with |
| `results_count` | Total unique results across local + DB after merge/dedupe |
| `top_score` | Max score in the merged-but-unfiltered result set |
| `kept_after_floor` | How many results survived `PROACTIVE_INJECTION_FLOOR` (0.05) |
| `source` | `local` (only local hit), `db` (only DB hit), `merged` (both contributed to top 3), or `empty` (zero results) |

A "hit" is any entry where `kept_after_floor > 0`. A "miss" is `kept_after_floor == 0`.

## Quick Recipes

All recipes assume you are in a project root with `.claude/logs/memory-recall.jsonl`.

### 1. Total fires (this week)

```bash
wc -l .claude/logs/memory-recall.jsonl
```

### 2. Hit rate

```bash
# fires that surfaced at least one learning
hits=$(jq -c 'select(.kept_after_floor > 0)' .claude/logs/memory-recall.jsonl | wc -l)
total=$(wc -l < .claude/logs/memory-recall.jsonl)
echo "hits=$hits total=$total"
awk -v h="$hits" -v t="$total" 'BEGIN{ if(t>0) printf("hit rate: %.1f%%\n", 100*h/t) }'
```

### 3. Top empty intents (consistently miss)

```bash
# Intents that returned zero results, most-recent first
jq -r 'select(.kept_after_floor == 0) | .intent' .claude/logs/memory-recall.jsonl \
  | sort | uniq -c | sort -rn | head -20
```

### 4. Score distribution (histogram of top_score)

```bash
# Bucket top_score into 0.01-wide bins
jq -r 'select(.top_score > 0) | .top_score' .claude/logs/memory-recall.jsonl \
  | awk '{ bucket = int(\$1 * 100) / 100; print bucket }' \
  | sort | uniq -c | sort -k2 -n
```

### 5. Source distribution

```bash
# How often each source wins (local vs db vs merged vs empty)
jq -r '.source' .claude/logs/memory-recall.jsonl \
  | sort | uniq -c | sort -rn
```

### 6. Recent fires (live tail while testing)

```bash
tail -f .claude/logs/memory-recall.jsonl | jq -c '{t: .timestamp, i: .intent, kept: .kept_after_floor, src: .source}'
```

### 7. Find fires where local was suppressed pre-Wave-3

```bash
# After Wave 3 these should be rare; before Wave 3 a local hit short-circuited
# the DB query entirely. Look for cases where merge would have helped.
jq -c 'select(.source == "merged" and .results_count > 1)' .claude/logs/memory-recall.jsonl \
  | head -20
```

### 8. Per-session breakdown

```bash
jq -r '"\(.session_id) \(.kept_after_floor)"' .claude/logs/memory-recall.jsonl \
  | awk '{ s[\$1]++; if(\$2>0) h[\$1]++ } END { for(k in s) printf("%s fires=%d hits=%d\n", k, s[k], h[k]+0) }' \
  | sort
```

### 9. Average top_score on hits

```bash
jq -r 'select(.kept_after_floor > 0) | .top_score' .claude/logs/memory-recall.jsonl \
  | awk '{ sum+=\$1; n++ } END { if(n>0) printf("avg top_score on hits: %.4f (n=%d)\n", sum/n, n) }'
```

### 10. Floor-trim audit (entries that just barely missed)

```bash
# Fires where merge had results but the floor (0.05) killed them all.
# If many of these contain useful-looking intents, consider lowering the floor.
jq -c 'select(.kept_after_floor == 0 and .results_count > 0 and .top_score > 0)' \
  .claude/logs/memory-recall.jsonl | head -20
```

## Interpreting Output

| Signal | Meaning | Action |
|--------|---------|--------|
| Hit rate >40% | Healthy — most prompts find learnings | None |
| Hit rate 10-40% | Normal — most prompts are novel | None |
| Hit rate <10% | Either the corpus is small or the floor is too tight | Compare top_score distribution vs floor (0.05) |
| Many `source: empty` | Memory corpus is sparse for this project's topics | Run `/remember` on real learnings as you work |
| Many `source: local` and 0 `db` | OPC DB unreachable or `getOpcDir` failing | Check `$CLAUDE_OPC_DIR` and DB connectivity |
| `top_score > 0` but `kept_after_floor == 0` | Floor (0.05) trimmed everything; either too tight or correctly noisy | Inspect intents — if they look useful, lower the floor |

## Related

- Hook source: `.claude/hooks/src/memory-awareness.ts` — `PROACTIVE_INJECTION_FLOOR`, `mergeResults`, `LOCAL_SCORE_NORMALIZE`
- Companion log: `.claude/logs/agent-recall.jsonl` (written by `agent-recall-injector` for subagent recalls — same schema family, different scope)
- Canonical memory reference: `.claude/skills/memory/SKILL.md`

## Caveats

- The log only contains entries that survived the early skip checks (prompt length >= 15, not a slash command, not a subagent). Skipped fires are not logged.
- Local scores are normalized by `LOCAL_SCORE_NORMALIZE` (0.1) before merge, so a raw similarity of 0.5 surfaces as 0.05 — exactly at the floor. This is intentional.
- The log will grow without bound. Rotate or truncate periodically: `> .claude/logs/memory-recall.jsonl` to clear, or move to an archive file.
