-- Continuous Claude Unified Schema
-- 4 tables: sessions, file_claims, archival_memory, handoffs

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================================================
-- COORDINATION LAYER
-- =============================================================================

-- Sessions: Cross-terminal awareness
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    working_on TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    last_heartbeat TIMESTAMP DEFAULT NOW(),
    last_activity_at TIMESTAMP,
    memory_extracted_at TIMESTAMP
);

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
CREATE TABLE IF NOT EXISTS archival_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    agent_id TEXT,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding vector(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archival_session ON archival_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_archival_agent ON archival_memory(session_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_archival_created ON archival_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_archival_content_fts ON archival_memory
    USING gin(to_tsvector('english', content));

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
