#!/usr/bin/env node
/**
 * Fail when any hook timeout is above 120 seconds, or when zero timeouts were read.
 * Timeouts are seconds. A millisecond value (3000) fails this gate.
 *
 *   node scripts/settings/timeout-ratchet.mjs
 *   node scripts/settings/timeout-ratchet.mjs --file path.json
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIMIT = 120;

export function collectTimeouts(settings) {
  const found = [];
  const hooks = settings?.hooks || {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group?.hooks || []) {
        if (typeof hook?.timeout !== 'number') continue;
        const line = [hook.command, ...(hook.args || [])].join(' ');
        const name = (line.match(/([A-Za-z0-9._-]+)\.mjs/) || [])[1] || line || event;
        found.push({ event, name, timeout: hook.timeout });
      }
    }
  }
  return found;
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const file = flag(argv, '--file') || join(HERE, '..', '..', '.claude', 'settings.json.template');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const found = collectTimeouts(settings);
  const over = found.filter((row) => row.timeout > LIMIT);
  process.stdout.write(`timeouts: ${found.length}\n`);
  process.stdout.write(`over ${LIMIT}: ${over.length}\n`);
  for (const row of over) process.stdout.write(`  ${row.event} ${row.name} ${row.timeout}\n`);
  if (found.length === 0) {
    process.stdout.write('RESULT: FAIL - read 0 timeouts\n');
    process.exit(1);
  }
  if (over.length) {
    process.stdout.write('RESULT: FAIL - timeout above 120 seconds\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: OK\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
