# Plan: account export + session store move

Owner: platform team. Target: ship next sprint.

1. Move the session store from Postgres (`sessions` table) to a single Redis instance.
   Sessions keep a 30-day TTL. No replica; Redis runs on the same VM as the API.
2. Add `GET /api/export?accountId=<id>` that returns every user row for that account as CSV.
   The handler loads all rows into memory, builds the CSV string, then sends it.
   Auth: any logged-in user may call it. The handler takes `accountId` from the query string.
3. Cache each export response for 24 hours, keyed by `accountId`.
4. Largest account today: 2.1 million users. Median account: 40 users.
5. Testing: manual check in staging by one engineer.
