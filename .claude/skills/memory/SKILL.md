---
name: memory
description: Recall or store persistent learnings across sessions. Use when the user says "remember this", "store a learning", "what did we do before with X", or "/recall", or before implementing something similar to past work.
metadata:
  user-invocable: true
---

# Memory System

Unified interface for storing and retrieving learnings across sessions. This skill is the canonical source — the former `memory-rules.md` rule was folded in on 2026-09-24; one line of it lives in `rules/on-demand-rules.md`.

## When to Use

Trigger signals:
- "What did we do before with X?"
- "Remember this for next time"
- Starting implementation similar to past work
- Debugging an error that may have been solved before
- Making an architectural or design decision
- Discovering a recurring codebase pattern
- User corrects a behavior or states a preference
- Approach fails and is worth flagging for future sessions

Agents (kraken, architect, phoenix, spark) now receive relevant learnings automatically via the `agent-recall-injector.ts` hook — no manual preflight recall required. Manual `/recall` is still available for higher-quality hybrid RRF results.

---

## Recall: Query the Archival Memory

### Quick Invocation

```
/recall <query>
```

Or direct CLI (use this form from agent context where slash commands are not available):

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "your search terms"
```

**IMPORTANT:** Always run from the `opc/` directory (via `$CLAUDE_OPC_DIR`) so the correct environment variables load. From slash-command context, `$CLAUDE_PROJECT_DIR/opc` is equivalent.

### When to Recall

Query memory proactively when:
- Starting work on something that may have been done before
- Encountering an error or tricky situation
- Making architectural or design decisions
- Looking for patterns or approaches that worked previously
- Before storing a new learning (dedup check)

If the memory-awareness hook showed a `MEMORY MATCH` in session context, the learning is likely relevant — follow up with a full `/recall` to get complete content instead of the preview.

### Options

```bash
# Default: Hybrid RRF search (text + vector combined) — RECOMMENDED
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "authentication patterns"

# More results
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "error handling" --k 10

# Pure vector search (higher similarity scores, 0.4-0.6 range)
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "database schema" --vector-only

# Text-only search (fast, no embeddings)
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "YAML format" --text-only

# Query as-of a specific date (temporal — excludes entries superseded before that date)
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "hook patterns" --valid-at 2026-04-01

# Disable decay weighting (returns raw RRF ranks)
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "hook patterns" --no-decay

# Include superseded entries in results
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "hook patterns" --include-superseded
```

| Flag | Description |
|------|-------------|
| `--k N` | Return N results (default: 5) |
| `--vector-only` | Pure vector search (higher precision, slower) |
| `--text-only` | Text search only (fast, no embeddings) |
| `--valid-at <ISO>` | Query memory as-of a date; excludes entries superseded before that point |
| `--no-decay` | Disable decay weighting; returns raw RRF ranks |
| `--decay-lambda N` | Override decay rate (default 0.02, ≈35-day half-life) |
| `--include-superseded` | Include entries marked as replaced by a newer entry |

### Backend Architecture

| Backend | Location | Status |
|---------|----------|--------|
| PostgreSQL (primary) | Via `DATABASE_URL` | Has 100+ real learnings with BGE embeddings |
| SQLite (fallback) | `~/.claude/cache/memory.db` | May be empty — don't rely on it |

**DO NOT manually inspect databases** — use the recall script. It auto-selects the correct backend.

Embedding details: entries have BGE embeddings (default `bge-large-en-v1.5`, 1024-dim). The dimension is configurable via `EMBEDDING_DIMENSION` env var.

**Temporal columns (Phase 1):** `archival_memory` rows now carry `valid_from` (NOT NULL, defaults to `created_at`) and `valid_until` (nullable, NULL = still valid). Superseded entries are excluded from default recall; opt-in with `--include-superseded`. Filter handoff-derived learnings with `metadata->>'source' = 'handoff'` — these are indexed automatically from session handoffs.

**Type enforcement (Phase 1):** All 7 canonical types are enforced at write time. `incremental_extract.infer_learning_type()` assigns types on extraction. NULL-type writes from non-CLI paths are rejected. `session_learning` is no longer a valid type.

### Understanding Scores

| Search Mode | Score Range | Interpretation |
|-------------|-------------|----------------|
| Hybrid RRF (default) | 0.01 – 0.03 | Normal — RRF combines rankings |
| Pure vector | 0.4 – 0.6 | Cosine similarity |
| Text search | 0.01 – 0.05 | BM25 normalized |

**Low RRF scores (0.02) are good results** — do not confuse with low relevance. RRF is a ranking fusion metric, not a similarity score.

### Proactive Injection (memory-awareness hook)

The `memory-awareness` UserPromptSubmit hook calls `recall_learnings.py` automatically and surfaces matches as a `MEMORY MATCH` block in session context. The hook uses **text-only mode + a TypeScript-side score floor**, and merges results from both local cache and the PostgreSQL DB (deduped by id, top 3 returned):

| Setting | Value | Why |
|---------|-------|-----|
| Mode | `--text-only` | BGE cold start exceeds the 2 s hook timeout; ts_rank is fast and never times out |
| `--k` | 5 | Fetch 5; filter; show top 3 — gives the floor headroom to drop weak rows |
| `PROACTIVE_INJECTION_FLOOR` | `0.05` (enforced in `memory-awareness.ts`) | Filters ts_rank noise; admits strong FTS hits + ILIKE substring matches |
| Timeout | 5000 ms | Absorbs `uv run` cold-start (~4-5 s on first fire, <2 s warm) |
| Sources merged | local + DB | Both queried; deduplicated by `id`; ranked; top 3 returned |

ts_rank scales 0.0001–0.1 with the ILIKE fallback hitting 0.1, so the 0.05 floor lets through ranked-strong matches and substring matches while suppressing the long tail of weak FTS hits. To tune, edit `PROACTIVE_INJECTION_FLOOR` in `.claude/hooks/src/memory-awareness.ts`.

For higher-quality recall (hybrid RRF + vector signal), call `/recall` manually — that path uses the embedding stack and is not bound by the hook timeout.

If matches stop showing up, run `recall_learnings.py --text-only --query "<intent>"` and inspect scores to confirm the bar — the hook is silent on filtered results.

**Observability:** Every injection decision is appended to `.claude/logs/memory-recall.jsonl`. Use `/memory-stats` to audit hook performance (hit rate, score distribution, false-positive rate).

### What's Stored

The `archival_memory` table contains:
- **What worked** — successful approaches and solutions
- **What failed** — pitfalls to avoid
- **Decisions** — architectural choices and rationale
- **Patterns** — reusable approaches

### Output Format

```
## Memory Recall: "<query>"

### 1. [TYPE] (confidence: high, id: abc123)
<full content>

### 2. [TYPE] (confidence: medium, id: def456)
<full content>
```

### Example Queries

- `hook development patterns` — find past hook implementations
- `TypeScript type errors` — recall how similar errors were fixed
- `database migration` — find migration patterns used before
- `test failures pytest` — recall debugging approaches
- `YAML handoff format` — recall format decisions

---

## Store: Capture Learnings

### When to Store (Proactive Triggers)

Manual stores should be **rare and high-value**. 98% of entries are auto-extracted by hooks — only store manually when the insight will not be captured automatically.

Store learnings immediately when:

| Trigger | Example | Type |
|---------|---------|------|
| Fix non-trivial bug | 3+ attempts or multi-file fix | `ERROR_FIX` |
| Architectural decision | Chose X over Y with reasoning | `ARCHITECTURAL_DECISION` |
| Discover codebase pattern | Recurring structure across files | `CODEBASE_PATTERN` |
| Approach fails | Tried X, didn't work | `FAILED_APPROACH` |
| User corrects behavior | "I prefer Y" / "Don't do X" | `USER_PREFERENCE` |
| Windows-specific gotcha | Platform issue with concrete workaround | `WORKING_SOLUTION` |

Store at the moment of insight, not as post-processing. After completing debugging or multi-file changes, ask: **"Is there something here worth remembering for next time?"** If yes, store immediately while context is fresh.

### When NOT to Store

- Trivial fixes (<3 lines, obvious solution)
- Information already in `CLAUDE.md`, `RULES.md`, or any `.claude/rules/` file
- Generic programming knowledge (everyone knows)
- Test data or verification entries
- Session status updates ("started working on X")
- Plan fragments or task lists (use task files instead)

### Quality Bar

**GOOD** — specific, actionable, non-obvious:

```
Type: ERROR_FIX
Content: "Hook context injection fails with PreToolUse — additionalContext is ignored.
         Use PostToolUse with hookSpecificOutput.additionalContext instead.
         Confirmed in: path-rules-hook-fix, react-perf-hook-fix."
Tags: hooks,context-injection,scope:global
Confidence: high
```

**BAD** — generic, no actionable insight:

```
Type: CODEBASE_PATTERN
Content: "The project uses TypeScript"
Tags: typescript
Confidence: medium
```

Ask before storing: "Would a future session actually benefit from this, or can they find it in 10 seconds?"

**L0 quality gate:** The extraction pipeline auto-blocks NOISE entries (quality score <3) before they reach PostgreSQL. If a learning does not appear in recall, the quality scorer may have filtered it — this is intentional.

### Recall Before Storing

Always check for duplicates first:

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
  --query "<topic>" --k 3 --text-only
```

If a similar entry exists at high confidence, skip the store.

### Store Command

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/store_learning.py \
  --session-id "<short-identifier>" \
  --type <TYPE> \
  --content "<what you learned>" \
  --context "<what it relates to>" \
  --tags "tag1,tag2,scope:global|scope:project" \
  --confidence high|medium|low
```

**IMPORTANT:** Use `cd <absolute-path>` — not the subshell form `(cd opc && ...)`. The subshell form can cause path-doubling errors.

### Learning Types

These 7 types are the canonical, enforced set. Writes using any other type (including the deprecated `session_learning`) are rejected by the store pipeline. `incremental_extract.infer_learning_type()` auto-assigns types during extraction.

| Type | Use For |
|------|---------|
| `WORKING_SOLUTION` | Fix or approach that worked (default) |
| `ERROR_FIX` | How a specific error was resolved |
| `CODEBASE_PATTERN` | Recurring structure in this codebase |
| `FAILED_APPROACH` | What didn't work (avoid repeating) |
| `ARCHITECTURAL_DECISION` | Design choice with rationale |
| `USER_PREFERENCE` | User's stated preferences |
| `OPEN_THREAD` | Incomplete work to resume later |

### Auto-Type Detection (for `/remember`)

If no `--type` is specified via `/remember`, the type is inferred from content:

- Contains "error", "fix", "bug" → `ERROR_FIX`
- Contains "decided", "chose", "architecture" → `ARCHITECTURAL_DECISION`
- Contains "pattern", "always", "convention" → `CODEBASE_PATTERN`
- Contains "failed", "didn't work", "don't" → `FAILED_APPROACH`
- Default → `WORKING_SOLUTION`

### Scope Detection

| Content Signals | Scope | Tag |
|-----------------|-------|-----|
| File paths, "this codebase", specific modules | Project | `scope:project` |
| "In general", "always", generic patterns | Global | `scope:global` |
| Mixed or unclear | Default to project | `scope:project` |

### Use `/remember` for Interactive Storage

Short form:

```
/remember <what you learned>
```

With explicit type:

```
/remember --type WORKING_SOLUTION <what you learned>
/remember --type ARCHITECTURAL_DECISION Session affinity uses terminal PID
/remember --type FAILED_APPROACH Don't use subshell for store_learning command
```

`/remember` wraps the store command, sets `session-id` to `manual-$(date +%Y%m%d-%H%M)`, and annotates context as `manual entry via /remember`.

Use `/memory-curate` to audit and prune low-value entries.

---

## Recall Reasoning (Artifact Index)

Search the artifact index for handoffs, plans, and post-mortems — distinct from `archival_memory` queries.

### When to Use

- Find what worked or failed in past sessions
- Look up architectural decisions tied to specific handoffs
- Review post-mortems from completed work

### Usage

```bash
uv run python scripts/artifact_query.py "<query>" [--outcome SUCCEEDED|FAILED] [--limit N]
```

### Interpreting Results

- `✓` = `SUCCEEDED` (follow this pattern)
- `✗` = `FAILED` (avoid this pattern)
- `?` = `UNKNOWN` (not yet marked)

---

## Examples

**Example 1: Recall before starting similar work**

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
  --query "hook development patterns" --k 3 --text-only
```

**Example 2: Store a tricky bug fix**

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/store_learning.py \
  --session-id "hook-debugging" \
  --type ERROR_FIX \
  --content "TypeScript hooks fail silently if dist/ doesn't exist. Always run npm run build after editing src/." \
  --context "hook development" \
  --tags "hooks,typescript,build,scope:global" \
  --confidence high
```

**Example 3: Store a codebase pattern**

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/store_learning.py \
  --session-id "codebase-exploration" \
  --type CODEBASE_PATTERN \
  --content "All session hooks use shared/types.ts for input/output interfaces. Import from './shared/types.js' in dist." \
  --context "hook development patterns" \
  --tags "hooks,patterns,scope:project" \
  --confidence high
```

**Example 4: Search artifact index for successful auth work**

```bash
uv run python scripts/artifact_query.py "authentication OAuth" --outcome SUCCEEDED
```

**Example 5: Sub-agent recall before implementation**

```bash
# kraken / architect / phoenix / spark runs this before touching code
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
  --query "<task keywords>" --k 3 --text-only
```

---

## Agent Memory Recall (Automatic)

As of Phase 1, spawned agents receive memory context automatically — no manual recall step required.

The `agent-recall-injector.ts` PreToolUse hook fires on `Task` tool calls. It queries `recall_learnings.py --text-only` for terms extracted from the task prompt and injects relevant learnings as `additionalContext` before the agent starts.

| Behavior | Detail |
|----------|--------|
| Trigger | `Task` tool PreToolUse |
| Hook | `.claude/hooks/src/agent-recall-injector.ts` |
| Mode | `--text-only` (same as memory-awareness; fast, no embedding cold-start) |
| Agents skipped | `oracle`, `pathfinder` (external research; past memory is noise) |
| Recursion guard | `CLAUDE_AGENT_ID` env var prevents sub-agents from re-triggering injection |

Agents (kraken, spark, architect, phoenix) no longer need to manually run `recall_learnings.py` as a preflight step — the hook handles it. Manual recall is still available and gives higher-quality results via hybrid RRF.

---

## Temporal Validity & Decay

### Bi-Temporal Columns

Each row in `archival_memory` now has:
- `valid_from` — when the learning became valid (NOT NULL; defaults to `created_at`)
- `valid_until` — when superseded (nullable; NULL = still valid)

Default recall excludes rows where `valid_until IS NOT NULL`. Use `--include-superseded` to opt in.

Query memory as it existed on a specific date:
```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py \
  --query "hook patterns" --valid-at 2026-03-15
```

### Decay-Weighted Retrieval

Decay is **on by default**. Older entries are down-ranked by `exp(-age_days * 0.02)` (≈35-day half-life). Recent learnings surface higher in results without explicit date filtering.

```bash
# Disable decay — pure RRF ranking
--no-decay

# Tune decay rate (lower = slower decay)
--decay-lambda 0.01
```

---

## Superseding Entries

When a learning becomes outdated, mark it superseded rather than deleting it (preserves audit trail):

```
/supersede <old-id> <new-content> --reason "brief explanation"
```

This sets `valid_until = NOW()` on the old entry and stores a new entry linked via metadata. The old entry remains queryable with `--include-superseded`. Use this when an approach has changed, a bug fix was revisited, or a preference was reversed.

---

## Observability

The memory system emits structured logs for hook performance auditing:

| Log | Path | Contents |
|-----|------|----------|
| Injection log | `.claude/logs/memory-recall.jsonl` | Per-prompt: query, scores, injected/filtered counts, latency |

Audit with:
```
/memory-stats
```

This reads `memory-recall.jsonl` and reports hit rate, score distribution, p95 latency, and false-positive rate (injections with no subsequent `/recall` follow-up).

---

## Quality Gate (Uniform Enforcement)

All extraction hooks (`agent-error-capture`, `browser-learning-extractor`, etc.) now call `scoreExtraction()` and require score ≥ 3 before storing. The Python validator rejects noise-prefix content before the min-length check. The `vibe_trading_data` table (Cohort A) is separate from `archival_memory` — do not recall against it.

---

## Memory Architecture Summary

| Component | Purpose |
|-----------|---------|
| PostgreSQL | Primary storage with pgvector |
| BGE Embeddings | 1024-dim vectors (`bge-large-en-v1.5`) |
| Hybrid Search | RRF combining text + vector (manual `/recall`) |
| Hook-time search | Text-only (`--text-only`); fast, no embedding cold-start |
| Artifact Index | Handoffs/plans with post-mortems |
| L0 Quality Gate | Uniform: score ≥ 3 required across all extraction hooks |
| Type Enforcement | 7 canonical types enforced; NULL-type writes rejected |
| Decay Weighting | `exp(-age_days * 0.02)`, ≈35-day half-life; `--no-decay` to disable |
| Bi-Temporal Columns | `valid_from` / `valid_until`; `--valid-at` for point-in-time queries |
| Agent Auto-Recall | `agent-recall-injector.ts` injects context into Task tool calls |
| Observability | `.claude/logs/memory-recall.jsonl` + `/memory-stats` skill |
| `EMBEDDING_DIMENSION` | Env var to configure vector dimension |

## Three-Tier Reconciliation with Native Auto Memory (07-09 R3, 2026-07-24)

CCv3's Postgres pipeline and Claude Code's native Auto memory (`~/.claude/projects/<project>/memory/`) coexist by ROLE, not by sync:

| Tier | Owner | What lives there |
|------|-------|------------------|
| Rules / standing behavior | `CLAUDE.md` + `.claude/rules/` | How to work — never stored as "memories" |
| Curated always-loaded index | Native `MEMORY.md` + topic files (200-line / 25KB cap on MEMORY.md) | One-line pointers to durable project facts; model-curated, may be rewritten by native memory at any time |
| Full searchable archive | PostgreSQL `archival_memory` (this skill) | Every distilled learning, semantically recallable at scale |

Rules:
- **No bidirectional sync.** Native memory is model-owned and rewritable ("auto-dream" risk) — never treat it as an authoritative mirror of Postgres, and never script writes into it from the extraction pipeline.
- **Auto-extraction writes go to Postgres only** (now LLM-distilled before store — see `opc/scripts/core/distill_learning.py`; verbatim source kept as a context excerpt, `distilled` tag). Native MEMORY.md entries are written by the model in-session, by judgment.
- **Watch the MEMORY.md byte cap**: the cap is 200 lines OR 25KB, whichever hits first (2026-07-24 audit: 114 lines but 19.3KB — bytes, not lines, are the binding constraint here; heavy lines silently truncate).

---

## Proactive Memory Usage

- Before starting work: `/recall <task keywords>`
- After solving problems: `/remember <what worked and why>`
- Before similar tasks: check the artifact index for past approaches that succeeded or failed
- After a correction from the user: store as `USER_PREFERENCE` or `FAILED_APPROACH`
