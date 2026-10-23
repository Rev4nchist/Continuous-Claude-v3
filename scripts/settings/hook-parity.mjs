#!/usr/bin/env node
/**
 * Fail when the same hook is registered twice on one event under matchers
 * that can both fire for one tool. An empty matcher matches every tool.
 * A scan of zero registrations fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookScript } from './render-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function matchersOverlap(a, b) {
  if (!a || !b) return true;
  const left = a.split('|');
  const right = b.split('|');
  for (const x of left) {
    for (const y of right) {
      if (x === y) return true;
      if (safeTest(x, y) || safeTest(y, x)) return true;
    }
  }
  return false;
}

function safeTest(pattern, value) {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return false;
  }
}

export function overlappingPairs(settings) {
  const pairs = [];
  let registrations = 0;
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const byHook = new Map();
    for (const group of groups) {
      const matcher = group?.matcher || '';
      for (const hook of group?.hooks || []) {
        const name = hookScript(hook);
        if (!name) continue;
        registrations++;
        if (!byHook.has(name)) byHook.set(name, []);
        byHook.get(name).push(matcher);
      }
    }
    for (const [name, matchers] of byHook) {
      for (let i = 0; i < matchers.length; i++) {
        for (let j = i + 1; j < matchers.length; j++) {
          if (matchersOverlap(matchers[i], matchers[j])) {
            pairs.push({ event, hook: name, a: matchers[i], b: matchers[j] });
          }
        }
      }
    }
  }
  return { registrations, pairs };
}

function main() {
  const argv = process.argv.slice(2);
  const fileFlag = argv.indexOf('--file');
  const file = fileFlag === -1 ? join(HERE, '..', '..', '.claude', 'settings.json.template') : argv[fileFlag + 1];
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const { registrations, pairs } = overlappingPairs(settings);
  process.stdout.write(`registrations: ${registrations}\n`);
  process.stdout.write(`overlaps: ${pairs.length}\n`);
  for (const pair of pairs) process.stdout.write(`  ${pair.event} ${pair.hook} "${pair.a}" overlaps "${pair.b}"\n`);
  if (registrations === 0) {
    process.stdout.write('RESULT: FAIL - read 0 registrations\n');
    process.exit(1);
  }
  if (pairs.length) {
    process.stdout.write('RESULT: FAIL - overlapping matchers\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: OK\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
