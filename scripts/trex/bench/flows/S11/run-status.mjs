#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluate } from '../../../../github/review-status.mjs';

const result = evaluate(JSON.parse(readFileSync(process.argv[2], 'utf8')));
console.log(JSON.stringify({
  ready: result.ready,
  required: result.routing.required,
  reasons: result.reasons,
}));
process.exit(result.ready ? 0 : 1);
