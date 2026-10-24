# CCv3 System-Update — Resource Map

Where everything lives. Paths are repo-relative to `continuous-claude/` unless noted. The system **runs from `~/.claude/`**; the repo is the source of truth and forward-syncs to active on commit.

## The deep review (the evidence base)

| Artifact | Path | What |
|----------|------|------|
| Final report | `docs/reviews/2026-06-10/ccv3-fable5-deep-review-2026-06-10.md` | Executive verdict, confirmed ledger, elegance analysis, review-of-the-review |
| Synthesis | `docs/reviews/2026-06-10/wf3/synthesis.json` | `ranked` (priority-scored) · `elegance` (verdict + rationale) · `backlog` (the 4 tiers) |
| WF-2 verdicts | `docs/reviews/2026-06-10/wf2/WF2-VERDICTS.json` | Per-finding CONFIRM/DOWNGRADE/KILL with reachability evidence |
| Plan + premortem | `~/.claude/plans/we-have-been-working-starry-pony.md` | The review plan + 20-finding risk ledger |
| v3 design baseline | `~/.claude/plans/we-have-recently-done-refactored-storm.md` | L0-L5 model, §9 cohesion metrics, §17 open issues (the target shape) |

## This session's deliverable — the visual state-of-rework

| Artifact | Path / URL |
|----------|------------|
| HTML briefing (CCv3 house style) | `docs/architecture/system-visualization/state-of-rework/state-of-rework.html` |
| 4 Excalidraw diagrams | `docs/architecture/system-visualization/state-of-rework/{master-3state,subsystems,dataflow-traces,backlog-map}.excalidraw` |
| 4 SVG renders | same dir, `*.svg` |
| Workflow source maps | `docs/architecture/system-visualization/state-of-rework/_maps/*.json` (subsystems, backlog, target, traces, elegance, narrative + 4 diagram specs) |
| Generators | `scripts/viz/gen-excalidraw.mjs` (spec→.excalidraw), `gen-svg.mjs` (spec→.svg), `build-state-html.mjs` (narrative→briefing; `--site cc\|decks`) |
| Hub card | `docs/architecture/system-visualization/hub.html` |
| **LIVE deck** | https://rev4nchist.github.io/ai-enablement-decks/ccv3-state-of-rework/ |
| **LIVE interactive diagrams** | `…/ccv3-state-of-rework/viewer/?f=master-3state` (also `subsystems`, `dataflow-traces`, `backlog-map`; add `&edit=1` to edit) |

**Regenerate a diagram:** `node scripts/viz/gen-excalidraw.mjs <_maps/spec-NAME.json> <out.excalidraw>` then `gen-svg.mjs` similarly. **Rebuild the briefing:** `node scripts/viz/build-state-html.mjs <state-of-rework-dir>`.

## Key source files for the backlog work

| Concern | Files |
|---------|-------|
| Matcher split-brain (QW-04) | `.claude/settings.json` (repo) + `~/.claude/settings.json` (active) + `settings.json.template`; the 12 hooks: `agent-model-guard`, `no-haiku-enforcer`, `maestro-enforcer`, `navigator-validate`, `task-router`, `agent-error-capture`, `agent-verification`, `ralph-task-monitor`, etc. |
| Memory recall (QW-06, ST-05, SG-01) | `opc/scripts/core/memory_service_pg.py`, `recall_learnings.py`, `store_learning.py`; `.claude/hooks/src/memory-awareness.ts` |
| Intent pollution (QW-07) | `.claude/hooks/src/memory-awareness.ts` (`extractIntent`, `expandGitQuery`) |
| Session-id consolidation (ST-02) | `.claude/hooks/src/shared/session-id.ts`, `session-bus-id.ts`, `shared/index.ts` (barrel) |
| Context bus (ST-01, ST-09) | `.claude/hooks/src/shared/context-bus.ts`, `bus-focus.ts`, `bus-session-populator.ts`, `bus-tool-populator.ts` |
| /code-intel facade (ST-04, C.5) | `scripts/code-intel.mjs`, `.claude/hooks/src/code-intel-enforcer.ts` |
| Sanitizer (ST-07) | `.claude/hooks/src/shared/memory-sanitize.ts`; injectors: `session-start-continuity.ts`, `pre-plan-memory.ts`, `git-memory-check.ts`, `memory-awareness.ts`, `agent-recall-injector.ts` |
| Shell-injection (ST-08) | `smart-search-router.ts`, `daemon-client.ts`, the 4 `store_learning` call sites |

## Resident recall daemon (the foundation)

ST-05 + Session-2 made the memory RECALL hot-path resident (warm recall ~136 ms, was ~10 s). The embedding daemon holds the BGE model + a persistent psycopg pool and answers `recall` in-process; `memory-awareness` routes through it and falls back to the `uv run --text-only` path when the daemon is cold.

| Concern | Files / artifacts |
|---------|-------------------|
| Daemon (model + recall op + watchdog) | `opc/scripts/core/embedding_daemon.py` (ping/recall/embed ops, A1-A4 multi-week resilience), `opc/scripts/core/db/postgres_pool.py` (asyncpg pool, idle-conn lifetime) |
| Recall query (hybrid RRF) | `opc/scripts/core/recall_learnings.py` — the `--json` shape the daemon's `recall` op reproduces in-process |
| TS client + routing | `.claude/hooks/src/shared/embedding-client.ts` (`probeDaemon` / `recallViaDaemon`), `.claude/hooks/src/shared/host-ram.ts` (host-memory-pressure gate), `.claude/hooks/src/memory-awareness.ts` (routes `checkDbMemory` → daemon) |
| Lifecycle (Windows) | `scripts/start-embedding-daemon.ps1`, `scripts/install-embedding-daemon-task.ps1`, `scripts/uninstall-embedding-daemon-task.ps1`; Task Scheduler `CCv3-Embedding-Daemon` (logon trigger) + `CCv3-Embedding-Daemon-Daily` (idempotent daily backstop) |
| Runtime state | `~/.claude/run/ccv3-embedding.json` = `{pid, port, model, dim}`; ping the `port` with a 4-byte-length-prefixed `{"cmd":"ping"}` frame → `{recall_ready, loop_ok, …}` |
| Invariant | BGE model `BAAI/bge-large-en-v1.5`, dim **1024** — NEVER change (vector-space parity). |

## Operational guardrails

| Need | Command |
|------|---------|
| Emit-invariant after hook .ts edit | `bash scripts/audit-braintrust-emits.sh` → must be `Found: 4 \| Invariant: 4` |
| Rebuild hooks | `cd .claude/hooks && npm run build` |
| Run ONE test (never full suite) | `cd .claude/hooks && npx vitest run src/__tests__/<name>.test.ts` |
| Memory recall | `cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/recall_learnings.py --query "<kw>" --k 5 --text-only` |
| Sync repo → active | `bash scripts/sync-to-active.sh` |
| Cross-terminal sessions | `docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c "SELECT id,project,working_on,last_heartbeat FROM sessions WHERE last_heartbeat > NOW() - INTERVAL '5 minutes';"` |

## Branch / git

- **This branch:** `snapshot/ccv3-system-update` (off `main` = `f7f3eba`) — this session's viz work + this library. **Excludes** `feature/cma-integration` (CMA + reporting skills — not ready to push).
- Remotes: push **`fork`** (Rev4nchist), never `origin` (parcadei).
- Decks site repo (separate, public): `C:/Users/david.hayes/Projects/ai-enablement-decks`, remote `origin` = Rev4nchist/ai-enablement-decks, auto-deploys on push.
