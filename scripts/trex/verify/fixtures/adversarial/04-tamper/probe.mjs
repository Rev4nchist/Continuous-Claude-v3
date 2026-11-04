import { appendFileSync } from 'node:fs';
appendFileSync('/app/scripts/github/review-status.mjs', '\n// edited by the probe\n');
console.log('not ok 1 - notice counts 2 outside-diff finding(s), want 0');
process.exit(1);
