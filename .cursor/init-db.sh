#!/usr/bin/env bash
#
# Idempotent database provisioning for Continuous Claude v3.
#
# Creates the `claude` role, `continuous_claude` database, required extensions,
# and applies the canonical opc schema. Assumes PostgreSQL is already running
# (see start.sh).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DB_NAME="continuous_claude"
DB_USER="claude"
DB_PASS="claude_dev"

# Role
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  echo "Creating role ${DB_USER}"
  sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'"
fi

# Database
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "Creating database ${DB_NAME}"
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
fi

# Extensions (superuser-only) + schema privileges
sudo -u postgres psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO ${DB_USER};
SQL

# Canonical schema (idempotent; owned by the claude role) applied over TCP.
export PGPASSWORD="${DB_PASS}"
export PGOPTIONS='--client-min-messages=warning'
psql -h localhost -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 \
  -f "${REPO_ROOT}/opc/docker/init-schema.sql" >/dev/null

# Compatibility DDL: the recall/supersede code paths expect bi-temporal
# columns (valid_from/valid_until) on archival_memory that the committed
# init-schema.sql does not yet define. Add them idempotently so semantic
# recall works end to end.
psql -h localhost -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
ALTER TABLE archival_memory ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now();
ALTER TABLE archival_memory ADD COLUMN IF NOT EXISTS valid_until timestamptz;
CREATE INDEX IF NOT EXISTS idx_archival_valid_until ON archival_memory(valid_until);
SQL

echo "Database ${DB_NAME} provisioned."
