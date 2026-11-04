// rule-router hook (built from hooks/src/rule-router.ts)
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COOLDOWN_MS = 60000;
const MANIFEST = join(homedir(), '.claude', 'rules-ondemand', 'manifest.json');

function recentlyFired(rule, now, last) {
  return last[rule] !== undefined && now - last[rule] < COOLDOWN_MS;
}
