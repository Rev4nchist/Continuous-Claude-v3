import { nothing } from './does-not-exist.mjs';
console.log('not ok 1 - notice counts 2 outside-diff finding(s), want 0', nothing);
process.exit(1);
