# Memory Subsystem

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MEMORY LAYER                            │
├─────────────────────────────────────────────────────────────┤
│  recall_learnings.py  →  Search stored learnings            │
│  store_learning.py    →  Persist new learnings              │
│  memory_daemon.py     →  Auto-extract from sessions         │
│  EmbeddingService     →  BGE-large embeddings (1024d)       │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│  PostgreSQL + pgvector                                      │
│  └─ archival_memory table                                   │
│     └─ id, session_id, type, content, context, tags         │
│     └─ embedding (vector 1024), confidence, created_at      │
└─────────────────────────────────────────────────────────────┘
```

## Commands

### Recall Learnings
```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
  --query "search terms" \
  --k 5              # number of results
  --text-only        # fast, no embeddings
  --vector-only      # pure semantic search
```

### Store Learning
```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/store_learning.py \
  --session-id "identifier" \
  --type WORKING_SOLUTION \
  --content "what you learned" \
  --context "what it relates to" \
  --tags "tag1,tag2" \
  --confidence high
```

## Learning Types

| Type | Use For |
|------|---------|
| `WORKING_SOLUTION` | Fixes, approaches that worked |
| `FAILED_APPROACH` | What didn't work (avoid repeating) |
| `ARCHITECTURAL_DECISION` | Design choices, rationale |
| `ERROR_FIX` | How specific errors were resolved |
| `CODEBASE_PATTERN` | Patterns discovered in code |
| `USER_PREFERENCE` | User's preferred approaches |
| `OPEN_THREAD` | Incomplete work to resume |

## Search Modes

| Mode | Flag | Score Range | Best For |
|------|------|-------------|----------|
| Hybrid RRF | (default) | 0.01-0.03 | General queries |
| Vector | `--vector-only` | 0.4-0.6 | Semantic similarity |
| Text | `--text-only` | 0.01-0.05 | Keyword matching |

Note: Low RRF scores (0.02) are normal - it's a ranking fusion, not similarity.

## Integration Points

| Hook | Purpose |
|------|---------|
| memory-awareness | Injects relevant memories into context |
| memory-extractor | Extracts learnings from session thinking |

## Database Access

```bash
# Direct query (debug only)
docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c \
  "SELECT id, type, content FROM archival_memory ORDER BY created_at DESC LIMIT 5;"
```

## When to Use

| Situation | Action |
|-----------|--------|
| Starting similar task | Recall first |
| Solved tricky problem | Store immediately |
| Made design decision | Store with rationale |
| Found what doesn't work | Store as FAILED_APPROACH |

## Deep Dive

For comprehensive documentation with Mermaid diagrams and full data flows:
→ `~/continuous-claude/docs/memory-architecture.md`
