# Plan: move the nightly jobs from app-vm-01 to batch-02

## Goal

Retire `app-vm-01`. Run the nightly jobs on the new host `batch-02`.

## Current state

The jobs run from the crontab on `app-vm-01` (copy in `evals/files/jobs/crontab.old`).

## Jobs to move

1. `send_digest.py` (02:00): emails the daily digest to every subscriber.
2. `rotate_logs.sh` (03:00): compresses and prunes `/var/log/app`.
3. `refresh_reports.py` (04:00): rebuilds the reporting tables.

## Steps

1. Friday 17:00: deploy the job code to `batch-02`.
2. Friday 17:30: apply migration `0007_add_sent_index.sql` (in `evals/files/migrations/`).
3. Friday 18:00: install the three jobs in the crontab on `batch-02` and enable it.
4. Monday 09:00: check the logs on `batch-02`. Disable the crontab on `app-vm-01`.
5. Monday 12:00: shut down `app-vm-01`.

## Testing

Run each job once by hand on `batch-02` on Friday afternoon.

## Out of scope

Changes to the job code.
