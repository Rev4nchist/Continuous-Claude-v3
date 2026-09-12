#!/usr/bin/env bash
#
# Cloud Agent start phase for Continuous Claude v3.
#
# Brings the PostgreSQL 16 cluster online on every boot. Idempotent: does
# nothing if the cluster is already running, and waits for readiness.
set -euo pipefail

status="$(pg_lsclusters -h 2>/dev/null | awk '$1=="16" && $2=="main"{print $4}')"
if [ "$status" != "online" ]; then
  echo "Starting PostgreSQL 16 cluster 'main'..."
  sudo pg_ctlcluster 16 main start
else
  echo "PostgreSQL 16 cluster 'main' already online."
fi

for _ in $(seq 1 30); do
  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

pg_isready -h localhost -p 5432
