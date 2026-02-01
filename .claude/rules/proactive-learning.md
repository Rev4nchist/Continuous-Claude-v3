# Proactive Learning Capture

Store learnings at the moment of insight, not as post-processing.

## When to Store (Moderate Triggers)

Store learnings IMMEDIATELY when:

| Trigger | Example | Type |
|---------|---------|------|
| Fix non-trivial bug | 3+ attempts or multi-file fix | `ERROR_FIX` |
| Discover codebase pattern | Recurring structure across files | `CODEBASE_PATTERN` |
| Make architectural decision | Choose between approaches | `ARCHITECTURAL_DECISION` |
| Approach fails | Tried X, didn't work | `FAILED_APPROACH` |
| User corrects behavior | "I prefer Y" / "Don't do X" | `USER_PREFERENCE` |

## When NOT to Store

- Trivial fixes (<3 lines, obvious)
- Information already in docs
- Generic patterns (everyone knows)
- Test data / verification entries

## How to Store

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/store_learning.py \
  --session-id "<task-identifier>" \
  --type <TYPE> \
  --content "<what you learned>" \
  --context "<what it relates to>" \
  --tags "tag1,tag2" \
  --confidence high|medium|low
```

Or use `/remember` skill for interactive storage.

## Scope Detection

| Content Signals | Scope | Tag |
|-----------------|-------|-----|
| File paths, "this codebase", specific modules | Project | `scope:project` |
| "In general", "always", generic patterns | Global | `scope:global` |
| Mixed or unclear | Default to project | `scope:project` |

## Examples

**After fixing a tricky bug:**
```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/store_learning.py \
  --session-id "hook-debugging" \
  --type ERROR_FIX \
  --content "TypeScript hooks fail silently if dist/ doesn't exist. Always run npm run build after editing src/." \
  --context "hook development" \
  --tags "hooks,typescript,build,scope:global" \
  --confidence high
```

**After discovering a pattern:**
```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/store_learning.py \
  --session-id "codebase-exploration" \
  --type CODEBASE_PATTERN \
  --content "All session hooks use shared/types.ts for input/output interfaces. Import from './shared/types.js' in dist." \
  --context "hook development patterns" \
  --tags "hooks,patterns,scope:project" \
  --confidence high
```

## Self-Prompt

After completing debugging or multi-file changes, ask yourself:
> "Is there something here worth remembering for next time?"

If yes → store it immediately while context is fresh.
