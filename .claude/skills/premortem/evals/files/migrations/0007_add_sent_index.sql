-- 0007: index digest_log for the per-day lookups in the reports.
-- digest_log has ~40M rows. Build the index without a write lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_digest_log_day
    ON digest_log (day, subscriber_id);
