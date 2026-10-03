-- Row counts from pg_class.reltuples, taken 2026-09-30 on prod.
--   sessions: ~600 rows
--   events:   ~40,000,000 rows

CREATE TABLE sessions (
  id         uuid PRIMARY KEY,
  status     text NOT NULL CHECK (status IN ('active', 'ended', 'stale')),
  started_at timestamptz NOT NULL
);

CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- No other indexes exist.

-- Hot query 1: dashboard header, ~50 req/min, p95 40 ms
SELECT id, started_at FROM sessions WHERE status = 'active';

-- Hot query 2: session detail page, p95 3.8 s
SELECT id, kind, created_at
FROM events
WHERE session_id = $1
ORDER BY created_at DESC
LIMIT 50;

-- Hot query 3: tool search, p95 6.1 s
SELECT id, session_id
FROM events
WHERE payload @> '{"tool": "Bash"}'
LIMIT 100;
