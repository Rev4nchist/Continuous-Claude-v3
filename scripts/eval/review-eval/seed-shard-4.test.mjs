// Shard 4 of 4 of the seed.mjs tests in seed.cases.mjs (see its header). The four shards together run every case once.
globalThis.SEED_SHARD = { index: 3, count: 4 };
await import('./seed.cases.mjs');
