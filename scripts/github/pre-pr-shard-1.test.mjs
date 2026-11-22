// Shard 1 of 4 of the pre-pr.mjs tests in pre-pr.cases.mjs (see its header). The four shards together run every case once.
globalThis.PRE_PR_SHARD = { index: 0, count: 4 };
await import('./pre-pr.cases.mjs');
