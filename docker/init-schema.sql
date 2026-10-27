-- Continuous Claude Unified Schema (the one canonical copy; docker-compose mounts this file)
-- Tables: sessions, file_claims, archival_memory, handoffs, pageindex_trees, pageindex_nodes.
-- The agentic_os schema (lanes, coordination events) comes from apps/agentic-os drizzle migrations.
-- Every statement is idempotent, so re-running this file upgrades an older database.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================================================
-- COORDINATION LAYER
-- =============================================================================

-- Sessions: Cross-terminal awareness
--
-- The lifecycle columns are the table's only record of an END. `ended_at` NOT
-- NULL means a SessionEnd hook observed the session finishing and is
-- trustworthy; NULL means UNKNOWN -- still running, killed outright before the
-- hook could fire, or simply older than the writer -- and must never be rendered
-- as "crashed". There is deliberately no `status` column: status is derivable
-- from these facts plus the clock, and a stored one rots the first time a writer
-- misses an update.
--
-- Already-provisioned databases get the same shape from
-- scripts/coordination/migrations/003-sessions-lifecycle.sql, which also carries
-- the full rationale.
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    working_on TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    last_heartbeat TIMESTAMP DEFAULT NOW(),
    last_activity_at TIMESTAMP,
    memory_extracted_at TIMESTAMP,
    ended_at TIMESTAMP,
    end_reason TEXT
);

-- The dashboard's liveness query runs every 5 seconds, forever. Without this it
-- is a Seq Scan that discarded 2,450 rows to return 3 (measured 2026-07-28);
-- with it, an Index Scan touching 5 buffers instead of 48.
--
-- GREATEST of all three timestamps is "the most recent thing known about this
-- session". Including ended_at is what lets a session that idled for an hour and
-- was then closed still appear as recently-ended. For a live session ended_at is
-- NULL and this reduces exactly to GREATEST of the other two, so the live path is
-- unchanged -- Postgres GREATEST ignores NULLs.
--
-- Partial because every caller carries the `s-%` exclusion and those rows are the
-- majority of the table.
CREATE INDEX IF NOT EXISTS sessions_last_signal_idx
    ON sessions (GREATEST(last_heartbeat, last_activity_at, ended_at) DESC)
    WHERE id NOT LIKE 's-%';

-- File Claims: Cross-terminal file locking
--
-- The lease columns are NOT optional extras. resolveFileClaim() -- the statement
-- every Edit/Write runs through -- references expires_at, fence, lease_class and
-- coordination_fence_seq unconditionally. A database created without them does
-- not degrade gracefully: every claim errors on the missing column, the hook
-- reports "Coordination DB unreachable", and it then PERMITS every edit. The
-- lock is silently absent on a machine that looks healthy, and the message
-- blames the container. They belong here, in the file docker-compose actually
-- mounts, so a fresh container is born lease-capable.
--
-- Already-provisioned databases get the same shape from
-- scripts/coordination/migrations/001-file-claims-leases.sql.

-- Lease generation counter. Monotonic, globally unique, NOT contiguous:
-- Postgres evaluates nextval() in a VALUES list before it detects an ON CONFLICT,
-- so renewals and blocked attempts burn values they never use.
CREATE SEQUENCE IF NOT EXISTS coordination_fence_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS file_claims (
    file_path TEXT NOT NULL,
    project TEXT NOT NULL,
    session_id TEXT,
    claimed_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '10 minutes',
    fence BIGINT DEFAULT nextval('coordination_fence_seq'),
    lease_class TEXT DEFAULT 'file',
    PRIMARY KEY (file_path, project)
);

-- For the sweep direction ("what is expired right now"), which any reaper or
-- board will want. Partial so it stays small.
CREATE INDEX IF NOT EXISTS file_claims_expires_at_idx
    ON file_claims (expires_at) WHERE expires_at IS NOT NULL;

-- =============================================================================
-- MEMORY LAYER
-- =============================================================================

-- Archival Memory: Long-term learnings with embeddings
--
-- project_id/scope are written by every store (opc/scripts/core/db/memory_service_pg.py)
-- and valid_from/valid_until are read by every recall (opc/scripts/core/recall_learnings.py,
-- bi-temporal supersede). A table without them fails every store and recall, so they
-- belong here. The ALTERs below bring an older table up to the same shape when this file
-- is re-run (opc/scripts/setup/docker_setup.py run_migrations); on a new table they no-op.
CREATE TABLE IF NOT EXISTS archival_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    agent_id TEXT,
    project_id TEXT,
    scope TEXT CHECK(scope IN ('PROJECT', 'GLOBAL')) DEFAULT 'PROJECT',
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding vector(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ
);

ALTER TABLE archival_memory ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE archival_memory ADD COLUMN IF NOT EXISTS scope TEXT
    CHECK(scope IN ('PROJECT', 'GLOBAL')) DEFAULT 'PROJECT';
-- valid_from on an existing table must start at each row's created_at, not at the
-- moment of the upgrade, or point-in-time recall (--valid-at) hides every old row.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'archival_memory'
          AND column_name = 'valid_from'
    ) THEN
        ALTER TABLE archival_memory ADD COLUMN valid_from TIMESTAMPTZ;
        UPDATE archival_memory SET valid_from = created_at;
        ALTER TABLE archival_memory ALTER COLUMN valid_from SET DEFAULT NOW();
        ALTER TABLE archival_memory ALTER COLUMN valid_from SET NOT NULL;
    END IF;
END $$;
ALTER TABLE archival_memory ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_archival_session ON archival_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_archival_agent ON archival_memory(session_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_archival_project ON archival_memory(project_id, scope);
CREATE INDEX IF NOT EXISTS idx_archival_scope ON archival_memory(scope);
CREATE INDEX IF NOT EXISTS idx_archival_created ON archival_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archival_valid_from ON archival_memory(valid_from);
CREATE INDEX IF NOT EXISTS idx_archival_valid_until ON archival_memory(valid_until)
    WHERE valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_archival_metadata ON archival_memory USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_archival_content_fts ON archival_memory
    USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS idx_archival_embedding_hnsw ON archival_memory
    USING hnsw(embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- HANDOFFS LAYER
-- =============================================================================

-- Handoffs: Session handoffs/task completions with embeddings for semantic search
CREATE TABLE IF NOT EXISTS handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_name TEXT NOT NULL,
    file_path TEXT UNIQUE NOT NULL,
    format TEXT DEFAULT 'yaml',
    session_id TEXT,
    agent_id TEXT,
    root_span_id TEXT,
    jsonl_path TEXT,
    goal TEXT,
    what_worked TEXT,
    what_failed TEXT,
    key_decisions TEXT,
    outcome TEXT CHECK(outcome IN ('SUCCEEDED','PARTIAL_PLUS','PARTIAL_MINUS','FAILED','UNKNOWN')),
    outcome_notes TEXT,
    content TEXT,
    embedding VECTOR(1024),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    indexed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_name);
CREATE INDEX IF NOT EXISTS idx_handoffs_session_id ON handoffs(session_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_root_span ON handoffs(root_span_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_created ON handoffs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoffs_outcome ON handoffs(outcome);
CREATE INDEX IF NOT EXISTS idx_handoffs_goal_fts ON handoffs
    USING gin(to_tsvector('english', COALESCE(goal, '')));
CREATE INDEX IF NOT EXISTS idx_handoffs_embedding_hnsw ON handoffs
    USING hnsw(embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- PAGEINDEX LAYER (Tree-based RAG)
-- =============================================================================

-- PageIndex Trees: Hierarchical tree indexes for markdown documents
-- Uses LLM reasoning for retrieval (98.7% accuracy vs ~50% for vector similarity)
CREATE TABLE IF NOT EXISTS pageindex_trees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL,
    doc_path TEXT NOT NULL,
    doc_type TEXT CHECK(doc_type IN ('ROADMAP', 'DOCUMENTATION', 'ARCHITECTURE', 'README', 'OTHER')),
    tree_structure JSONB NOT NULL,
    doc_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, doc_path)
);

CREATE INDEX IF NOT EXISTS idx_pageindex_project ON pageindex_trees(project_id);
CREATE INDEX IF NOT EXISTS idx_pageindex_doctype ON pageindex_trees(doc_type);
CREATE INDEX IF NOT EXISTS idx_pageindex_updated ON pageindex_trees(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pageindex_tree_gin ON pageindex_trees USING gin(tree_structure jsonb_path_ops);

-- Flattened nodes for fast FTS + vector search
CREATE TABLE IF NOT EXISTS pageindex_nodes (
    id SERIAL PRIMARY KEY,
    project_id TEXT NOT NULL,
    doc_path TEXT NOT NULL,
    node_id TEXT NOT NULL,
    parent_node_id TEXT,
    title TEXT NOT NULL,
    text TEXT,
    line_num INTEGER,
    depth INTEGER DEFAULT 0,
    fts_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(text, '')), 'B')
    ) STORED,
    embedding vector(1024),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, doc_path, node_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_fts ON pageindex_nodes USING GIN (fts_vector);
CREATE INDEX IF NOT EXISTS idx_nodes_embedding ON pageindex_nodes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON pageindex_nodes (project_id);
CREATE INDEX IF NOT EXISTS idx_nodes_doc ON pageindex_nodes (project_id, doc_path);
