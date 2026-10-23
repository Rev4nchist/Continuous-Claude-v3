# Plan: Cowork — Multi-Agent, Cross-Machine Coordination Room for CCv3

**Branch:** main · **Date:** 2026-05-22 · **Trigger:** /maestro (ultrathink) · **Mode:** plan
**Supersedes:** Path C (Adversarial Ledger) from `we-have-recently-integrated-refactored-moon.md` — generalized into Cowork.

---

## Context

CCv3 has accumulated rich coordination infrastructure that does *almost* what the user wants but with five disconnected pieces and zero cross-machine story:

- `sessions` / `file_claims` tables — single-machine, no heartbeat loop, no TTL on claims
- `agent_messages` LISTEN/NOTIFY infra — declared in schema, **nothing subscribes**
- `.claude/cache/agents/<name>/latest-output.md` — overwritten each run, no persistence
- Notion bridge (Eve/Donna) — works but has documented API quirks, free-form schema
- `thoughts/shared/handoffs/*.md` — git-synced YAML, one-shot human readable, not structured for agent loops
- Path C `agent_handoffs` (planned, never built) — scoped to review/premortem only, single-machine

The user's vision — a shared "room" where Claude Code, Eve, and Donna claim work, post results, and continue across sessions and machines — is the right consolidation. **Build it once, generalize Path C into it, give it the cross-machine + browser-relay primitives the existing pieces lack.**

Recommended choices locked (via AskUserQuestion):
1. **Neon** for cowork tables only. Memory stays local pgvector (548 rows, BGE-tuned, no risk).
2. **Cowork generalizes Path C** — review/premortem become room types. `agent_handoffs` is never built standalone.
3. **Hand-written Python argparse** CLI (store_learning.py pattern). CLI-Anything is the wrong tool — it wraps desktop GUI apps.
4. **Browser access via Notion-relay** — Claude.ai cannot connect to arbitrary custom MCPs. A worker mirrors Neon room state to Notion (read-write), Eve/Donna keep using the existing bridge. This is platform reality, not a workaround.

---

## What's Missing in the Original Proposal (the "what am I missing" answer)

Surface critique before we commit. Eight gaps in the verbatim proposal:

| # | Gap | Why it matters | What this plan does |
|---|-----|----------------|---------------------|
| 1 | **CLI-Anything is the wrong tool** | Designed for wrapping desktop GUI apps (GIMP, Blender). Not for Postgres APIs. | Hand-write Python argparse — same pattern as `store_learning.py`. ~300 lines total. |
| 2 | **Claude.ai browser cannot add custom MCPs** | The web UI only allows Anthropic-vetted connectors (Notion, Linear, Slack). Hosting an MCP on Railway gives Claude Code access but Eve/Donna are still locked out. | Cowork stays in Neon as the source of truth; a Notion-relay worker mirrors active rooms to a Notion page Eve/Donna already read. |
| 3 | **Stale claims have no TTL today** | `file_claims` has no release fn and no expiry. A crashed session blocks a file forever. Cowork without TTL inherits this bug at scale. | Every claim has a `claim_ttl` timestamp. Stale claims auto-release on every list/read query. |
| 4 | **No persistent agent identity** | `from_agent` would be a free-form string today. No way to know whether "claude-code" on laptop is the same identity as "claude-code" on desktop. | `cowork_agents` table with stable IDs like `claude-code:dave-laptop` and `eve:claude-ai`. Session IDs are ephemeral and join via presence table. |
| 5 | **No idempotency on result posting** | Network blips → duplicate result rows. | Every post is content-addressed by `sha256(body)`. Same hash = same post, dedup at insert. |
| 6 | **No realtime signal — polling is silent default** | LISTEN/NOTIFY exists in schema but nothing subscribes. Without explicit decision, agents poll. | v1 = explicit polling (5-10s) when an agent is *waiting*. v2 = LISTEN/NOTIFY upgrade. Realtime is opt-in, not assumed. |
| 7 | **No session-resume protocol** | If Claude Code disconnects mid-task, no one knows which rooms it was in or what it was working on. | Presence table with heartbeat. >5 min stale = agent dropped. New session can `cowork agent presence --room R` to see "claude-code:dave-laptop disconnected at 14:32 with task #47 claimed." |
| 8 | **Notion bridge sharp edges replicate if we mirror naively** | `notion-fetch` link rendering, `replace_content_range` selection mismatch on links, polling latency. | Relay writes a *structured-block* page per room (no inline links to other Notion pages), reads Eve input from a fixed-section convention. Avoids the failure modes already documented in memory. |

Two additional considerations that aren't gaps in the proposal but matter for shipping:

- **Don't replace `file_claims` or local `sessions`.** Those serve fine-grained intra-session locking and single-machine hook coordination. Cowork is the *cross-machine coordination layer above them*.
- **Cost is negligible.** Cowork tables are pure text+JSON. Neon free tier (3 GB storage, 191 compute-hrs/mo) handles this with three orders of magnitude headroom.

---

## Architecture (single paragraph)

Neon-hosted Postgres holds five tables: `cowork_rooms`, `cowork_agents`, `cowork_tasks`, `cowork_events`, `cowork_presence`. A hand-written Python CLI (`opc/scripts/cowork/cli.py`) is the canonical interface — Claude Code (via wrapper), and Ralph all call it the same way. Optimistic locking via `UPDATE... WHERE status='open'` handles claim contention. Every post is content-addressed (`sha256(body)`) for idempotency. Stale claims auto-release after a 30-minute TTL, checked on every read. A FastAPI service on Railway wraps the CLI for HTTP access; an MCP server alongside it lets Claude Code reach the room remotely (`type: http` + Bearer, gong pattern). A Notion-relay worker mirrors each open room to a structured Notion page so Eve/Donna read/write through the existing bridge with no platform changes. `/review --via-cowork` and `/premortem --via-cowork` become room types (subsumes Path C).

```
   ┌─ Eve (claude.ai) ──── reads/writes ──┐
   │                                       ▼
   │                              [Notion: per-room mirror page]
   │                                       ▲
   │                                       │ sync (worker)
   ▼                                       │
   Notion HQ ◀────────┐                    │
                       │                    │
                       ▼                    ▼
              ┌──────────────────────────────────────┐
              │     Neon Postgres — cowork.* tables  │  ← source of truth
              └──────────────────────────────────────┘
                       ▲                    ▲                    ▲
                       │                    │                    │
              cowork CLI            cowork CLI            cowork-api (Railway)
              (Dave laptop)        (Dave desktop)         + MCP server
                       │                    │                    │
                       ▼                    ▼                    ▼
               Claude Code            Claude Code            Other clients
               (wrapper)(wrapper) via MCP
```

---

## Schema (Neon Postgres)

```sql
-- 00NN_cowork.sql — runs against COWORK_DB_URL (Neon), separate from CONTINUOUS_CLAUDE_DB_URL (local)

CREATE TABLE cowork_rooms (
  id            TEXT PRIMARY KEY,                 -- e.g. "review-feat-auth-2026-05-22"
  project       TEXT NOT NULL,                    -- canonical project path
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,                    -- "review","premortem","plan","feature","debug","freeform"
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','paused','closed','archived')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  metadata      JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX ON cowork_rooms (project, status);

CREATE TABLE cowork_agents (
  id TEXT PRIMARY KEY, -- e.g. "claude-code:dave-laptop",":dave-laptop","eve:claude-ai"
  family        TEXT NOT NULL
                  CHECK (family IN ('claude-code','claude-ai','ralph','other')),
  machine       TEXT,                             -- "dave-laptop","dave-desktop","browser"
  capabilities  TEXT[] DEFAULT '{}',              -- ["code-edit","review","plan","research"]
  last_seen     TIMESTAMPTZ DEFAULT NOW(),
  metadata      JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE cowork_tasks (
  id            BIGSERIAL PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES cowork_rooms(id) ON DELETE CASCADE,
  parent_id     BIGINT REFERENCES cowork_tasks(id),
  kind          TEXT NOT NULL,                    -- "task","evidence","decision","dissent","question"
  title         TEXT NOT NULL,
  body          TEXT,
  body_hash     TEXT NOT NULL,                    -- sha256(body) — idempotency key
  refs          JSONB,                            -- file:line citations, URLs, commit shas
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','claimed','in_progress','blocked','completed','failed','cancelled')),
  claimed_by    TEXT REFERENCES cowork_agents(id),
  claimed_at    TIMESTAMPTZ,
  claim_ttl     TIMESTAMPTZ,                      -- auto-released past this
  completed_at  TIMESTAMPTZ,
  result_ref    JSONB,                            -- pointer to deliverable
  cursor        BIGINT NOT NULL,                  -- monotonic per room
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (room_id, body_hash)                     -- idempotent inserts
);
CREATE INDEX ON cowork_tasks (room_id, cursor);
CREATE INDEX ON cowork_tasks (room_id, status);
CREATE INDEX ON cowork_tasks (claimed_by, status) WHERE status IN ('claimed','in_progress');

CREATE TABLE cowork_events (
  id            BIGSERIAL PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES cowork_rooms(id) ON DELETE CASCADE,
  task_id       BIGINT REFERENCES cowork_tasks(id),
  kind          TEXT NOT NULL,                    -- task.created, task.claimed, task.completed,
                                                  -- message, heartbeat, presence.joined, presence.left
  from_agent    TEXT NOT NULL REFERENCES cowork_agents(id),
  to_agent      TEXT REFERENCES cowork_agents(id),  -- nullable = broadcast
  body          TEXT,
  body_hash     TEXT,                             -- nullable for system events
  refs          JSONB,
  ts            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON cowork_events (room_id, ts);
CREATE INDEX ON cowork_events (room_id, kind, ts);

CREATE TABLE cowork_presence (
  agent_id      TEXT NOT NULL REFERENCES cowork_agents(id),
  room_id       TEXT NOT NULL REFERENCES cowork_rooms(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (agent_id, room_id, session_id)
);
CREATE INDEX ON cowork_presence (room_id, last_heartbeat);

-- Per-room cursor sequence is created lazily by lib.py.next_cursor(room_id)
-- via "CREATE SEQUENCE IF NOT EXISTS cowork_cursor_<room_hash>" — see lib.py
```

**Optimistic claim (the critical pattern):**
```sql
UPDATE cowork_tasks
   SET claimed_by = $1, claimed_at = NOW(),
       claim_ttl = NOW() + INTERVAL '30 minutes',
       status = 'claimed'
 WHERE id = $2 AND status = 'open'
RETURNING *;
-- row count == 0 → someone else got it. Return error_code='claim_taken'.
```

**Stale claim auto-release (run on every list/read):**
```sql
UPDATE cowork_tasks
   SET status = 'open', claimed_by = NULL, claim_ttl = NULL
 WHERE status IN ('claimed','in_progress') AND claim_ttl < NOW();
```

---

## CLI Surface

JSON output by default. Error envelope: `{"ok": false, "error_code": "<enum>", "message": "..."}`. Stable error codes: `claim_taken`, `room_not_found`, `task_not_found`, `agent_not_registered`, `permission_denied`, `db_unavailable`.

```
cowork room create   --project P --title T --kind K [--id ID]
cowork room list     [--project P] [--status open|closed|all]
cowork room show     --id R [--with-events]
cowork room close    --id R

cowork agent register   --id ID --family F --machine M [--capabilities C,...]
cowork agent presence   --room R                            # who's here right now
cowork agent heartbeat  --room R                            # called by hook on a 60s timer

cowork task post      --room R --kind K --title T [--body B] [--refs JSON] [--parent PID]
cowork task list      --room R [--status S] [--mine] [--since-cursor C]
cowork task claim     --id ID [--ttl 30m]
cowork task progress  --id ID [--note N]                    # extend ttl, log event
cowork task complete  --id ID [--result JSON]
cowork task release   --id ID                               # release a claim
cowork task block     --id ID --reason R                    # mark blocked, request help

cowork event tail     --room R [--since-cursor C] [--follow] [--kind K]
cowork message        --room R --to AGENT --body B

cowork doctor                                               # health check: db conn, stale claims, ghost agents
```

---

## Components to Build (6 phases, ~6-8 sessions total)

### Phase 0: Foundation (1 session, ~3 hrs)
- `neonctl auth` → re-authenticate (credentials currently stale per scout)
- Create Neon project `cowork` (free tier, smallest compute)
- Set `COWORK_DB_URL` as Windows user env var on both machines
- Apply schema at `opc/scripts/core/db/migrations/00NN_cowork.sql`
- Verify connectivity: `psql $COWORK_DB_URL -c 'select 1'` from both machines

### Phase 1: CLI + first room (1 session, ~4 hrs)
- `opc/scripts/cowork/lib.py` — DB connection, error envelope, optimistic claim, stale-release, body_hash, cursor sequence creation
- `opc/scripts/cowork/cli.py` — argparse dispatching to subcommands (single file, ~400 lines)
- `.claude/skills/cowork/SKILL.md` — triggers, usage patterns
- `.claude/rules/cowork-safety.md` — don't fake heartbeats, always release on session end, body_hash collisions
- Smoke test on one machine: two terminals, register agents, create room, post tasks, claim contention, complete

### Phase 2: Integrate review + premortem (1 session, ~3 hrs)
- `.claude/skills/review/SKILL.md` — add `--via-cowork` branch (room kind=`review`)
- `.claude/skills/premortem/SKILL.md` — add `--via-cowork` branch (room kind=`premortem`)
- `.claude/agents/cowork-coordinator.md` — replaces never-built `ledger-coordinator` from Path C
- Update `.claude/rules/cli-integration-strategy.md` — add cowork inventory row, mark Path C `agent_handoffs` as superseded

### Phase 3: Heartbeat + session-end claim release (1 session, ~2 hrs)
- `.claude/hooks/src/cowork-heartbeat.ts` — fires every 60s on Notification/PostToolUse, writes presence rows for any room the session has joined. Pattern: same as existing session registration in `db-utils-pg.ts:390-444` but targets Neon and adds presence/heartbeat.
- `.claude/hooks/src/cowork-session-end.ts` — on SessionEnd, release all claims still held by this session_id. Critical for cleanup.
- Build, register in settings.json (per `.claude/rules/hook-dev-lifecycle.md`), sync to active

### Phase 4: Cross-machine validation (1 session, ~2 hrs)
- Run smoke from second machine (Dave Desktop)
- Verify: both machines see same rooms, claims block correctly, presence shows both agents
- Stress: kill claim holder mid-task, verify TTL releases after 30 min, verify next claim succeeds
- Add row to `.claude/rules/cross-terminal-db.md` documenting cowork as cross-machine layer

### Phase 5: Railway API + Claude Code MCP (1 session, ~4 hrs)
- `services/cowork-api/` — FastAPI wraps every CLI subcommand as HTTP endpoint. Bearer-token auth from `COWORK_API_TOKEN` env var (generated per machine).
- Deploy to Railway with `COWORK_DB_URL` (Neon) and `COWORK_API_TOKEN` env vars
- `services/cowork-api/mcp_server.py` — MCP server (stdio transport for now) wrapping the HTTP API. JSON-RPC tool definitions: `cowork_room_list`, `cowork_task_post`, etc.
- Register in `~/.claude/mcp.json` — initially `type: stdio` (most reliable per CCv3 history with Nia). Defer `type: http` until Claude Code's HTTP+Bearer transport is verified working.
- Pattern reference: `services/mcp_excalidraw/` (existing custom MCP) and `gong` config in `~/.claude.json` (Railway-hosted)

### Phase 6: Notion-relay worker (1-2 sessions, ~6 hrs)
- `services/cowork-notion-relay/` — Python worker, runs as scheduled task or Railway cron
- For each room with `status='open'` updated in last hour: render a structured Notion page in the Bridge HQ → "Active Cowork Rooms" subsection
- Page format: NO inline mention-page links (avoids documented `notion-fetch` quirk). Plain `<table>` HTML blocks per task, fixed `### Eve Input` section at bottom for inbound.
- Poll the `### Eve Input` section every 2 min; new content becomes `cowork message` or `cowork task post` events with `from_agent='eve:claude-ai'`.
- Update `.claude/skills/notion-bridge/notion-bridge/SKILL.md` — document cowork relay convention, the read-only-mirror semantics, and how Eve writes to the room

### Phase 7 (deferred): Realtime upgrade
- Replace polling with Postgres LISTEN/NOTIFY where reliable
- WebSocket layer in Railway API for browser long-poll alternative
- Only if Phase 1-6 friction warrants it

---

## Critical Files

**NEW:**
- `opc/scripts/core/db/migrations/00NN_cowork.sql` — schema
- `opc/scripts/cowork/lib.py` — DB ops, error envelope, optimistic claim, stale-release
- `opc/scripts/cowork/cli.py` — argparse subcommand dispatcher
- `.claude/hooks/src/cowork-heartbeat.ts` — presence heartbeat
- `.claude/hooks/src/cowork-session-end.ts` — claim release on SessionEnd
- `.claude/skills/cowork/SKILL.md` — usage skill
- `.claude/agents/cowork-coordinator.md` — room coordinator agent
- `.claude/rules/cowork-safety.md` — safety + conventions
- `services/cowork-api/` — FastAPI + MCP server
- `services/cowork-notion-relay/` — Notion mirror worker

**EDIT:**
- `.claude/skills/review/SKILL.md` — add `--via-cowork` branch
- `.claude/skills/premortem/SKILL.md` — add `--via-cowork` branch
- `.claude/rules/cli-integration-strategy.md` — cowork inventory row, mark Path C superseded
- `.claude/rules/cross-terminal-db.md` — document cowork as cross-machine layer (Neon) on top of local coordination (Docker)
- `.claude/skills/notion-bridge/notion-bridge/SKILL.md` — document cowork relay
- `~/.claude/mcp.json` — register cowork MCP

**NOT TOUCHED (still serve their purpose):**
- `sessions`, `file_claims` (local Docker) — fine-grained intra-session coordination
- `archival_memory` (local Docker pgvector) — 548 learnings, no cloud migration in this plan
- `thoughts/shared/handoffs/*.md` — human-readable session handoff (cowork doesn't replace narrative)
- `~/.claude/cache/agents/<name>/latest-output.md` — still the agent output convention (cowork events reference these paths via `result_ref`)

---

## Patterns to Reuse

| Pattern | Source | Use in cowork |
|---------|--------|---------------|
| argparse + uv run Python CLI | `opc/scripts/core/store_learning.py` | `opc/scripts/cowork/cli.py` |
| Postgres connection via env var with priority chain | `.claude/hooks/src/shared/db-utils-pg.ts:34-38` | `opc/scripts/cowork/lib.py` |
| Content-addressed body_hash | Path C plan §C.1 | Idempotent task/event inserts |
| Bearer-auth MCP via Railway | `gong` in `~/.claude.json` | `services/cowork-api/mcp_server.py` |
| Stdio MCP via Node SDK | `services/mcp_excalidraw/` | Initial cowork MCP transport |
| Heartbeat upsert | `db-utils-pg.ts:registerSession` lines 390-444 | `cowork-heartbeat.ts` |
| Notion HQ structured-block write | `.claude/skills/notion-bridge/references/bridge-schema.md` | `services/cowork-notion-relay/` |
| Error envelope with stable codes | Envoy `--json` error_code (lifted in Path C plan) | `lib.py.error_envelope()` |

---

## Verification

**Phase 0:** `psql $COWORK_DB_URL -c "\dt cowork_*"` lists all 5 tables on both machines.

**Phase 1:** On one machine, two terminals:
```bash
# Terminal A
cowork agent register --id claude-code:dave-laptop --family claude-code --machine dave-laptop
cowork room create --project continuous-claude --title "smoke" --kind freeform --id smoke-001
cowork task post --room smoke-001 --kind task --title "ping" --body "hello"
cowork task claim --id <task_id>  # should succeed

# Terminal B
cowork agent register --id :dave-laptop --family --machine dave-laptop
cowork task claim --id <task_id>  # should return {"ok":false,"error_code":"claim_taken"}
cowork task list --room smoke-001  # should show claimed task with claimed_by=claude-code:dave-laptop
```

**Phase 2:** `/review --via-cowork` on a small PR. Confirm findings appear as `kind=evidence` rows in `cowork_tasks`, room kind=`review`. `cowork room show --id review-<branch>` returns the full history. shows `via=cowork`.

**Phase 3:** Run a long task with claim. Kill the session (Ctrl+C the terminal). Wait 31 min. `cowork task list --status open` shows the task back as open (auto-released).

**Phase 4:** Repeat Phase 1 smoke from Dave Desktop. Both machines see the same rooms. Race: two machines try `cowork task claim` on the same task within 1s — exactly one succeeds, the other gets `claim_taken`.

**Phase 5:** From Claude Code on Dave Laptop, call MCP tool `cowork_task_post` via the Task tool. Verify row appears in Neon. Verify Bearer auth rejects an unauthorized request to the Railway API.

**Phase 6:** Eve opens the Bridge HQ → Active Cowork Rooms subsection in browser, sees a room mirrored. Eve adds text under `### Eve Input`. Within 2 min, a `cowork_events` row appears with `from_agent='eve:claude-ai'`. Claude Code on either machine tails the room and sees Eve's message.

---

## Out of Scope (explicit)

- Migrating local memory (`archival_memory`, 548 rows) to Neon — defer to a separate plan
- Replacing local `sessions` / `file_claims` tables — still serve fine-grained single-machine work
- Replacing Notion bridge for rich narrative / sprint state — cowork is structured-coordination only
- LISTEN/NOTIFY realtime — Phase 7, deferred until polling friction warrants
- A web UI / dashboard over cowork — CLI + Notion-relay are enough for v1
- Quotas / rate-limiting / cost tracking on the Railway API — not until usage justifies it
- Mobile / native client — Eve-on-mobile reads Notion, that's enough
- Cross-tenant or multi-user — single-Dave system, no auth model beyond Bearer per machine

---

## Open Questions

1. **Room ID convention** — `review-{branch}` / `premortem-{plan-hash}` are clear. For freeform / planning / debug rooms, propose `{kind}-{slug}-{YYYY-MM-DD}` (e.g. `plan-cowork-bootstrap-2026-05-22`). Confirm naming convention before Phase 1.

2. **Second participant.** A second CLI is not on the roster. Claude Code posts its own results into the room. There is no extra client and no side hook.

3. **Notion relay frequency** — 2 min poll feels right for human Eve. Confirm or specify shorter (30s for tighter loops) / longer (5 min for cost).

4. **Claim TTL default** — 30 min proposed. For long-running tasks (Ralph stories that run hours), need `cowork task progress --extend-ttl` to refresh. Confirm 30 min default + extend pattern.

5. **Auth scope** — One `COWORK_API_TOKEN` per machine, shared across all sessions on that machine. Acceptable for single-Dave system. Confirm before Phase 5 (Railway).
