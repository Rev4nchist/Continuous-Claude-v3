import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../rule-router-audit.mjs', import.meta.url));
const now = Date.now();
const ts = (min) => new Date(now - 3600_000 + min * 60_000).toISOString();
const fire = (min, session, agent, rule = 'git-merge') => ({ ts: ts(min), session, agent, tool: 'Bash', rules: [rule], kind: 'inject', what: 'x' });
const rearm = (min, session) => ({ ts: ts(min), session, agent: 'main', rules: [], kind: 'rearm', what: 'SessionStart compact', source: 'compact', removed: 1 });

function audit(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'rr-audit-'));
  const log = join(dir, 'log.jsonl');
  const manifest = join(dir, 'manifest.json');
  const out = join(dir, 'out.md');
  writeFileSync(log, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(manifest, JSON.stringify({ rules: [{ id: 'git-merge' }] }));
  const r = spawnSync(process.execPath, [script, '--log', log, '--manifest', manifest, '--out', out], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, report: readFileSync(out, 'utf8') };
}

test('a second fire with no re-arm between is a dedupe break', () => {
  const r = audit([fire(1, 's1', 'main'), fire(2, 's1', 'main')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /1 dedupe breaks/);
});

test('a re-arm (compact) between two fires of the main agent is not a break', () => {
  const r = audit([fire(1, 's1', 'main'), rearm(2, 's1'), fire(3, 's1', 'main')]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /0 dedupe breaks/);
});

test('a re-arm does not excuse a repeat by a subagent (the router re-arms the main agent only)', () => {
  const r = audit([fire(1, 's1', 'sub1'), rearm(2, 's1'), fire(3, 's1', 'sub1')]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /1 dedupe breaks/);
});

test('a re-arm in one session does not excuse a repeat in another', () => {
  const r = audit([fire(1, 's1', 'main'), fire(2, 's2', 'main'), rearm(3, 's2'), fire(4, 's1', 'main')]);
  assert.equal(r.code, 1);
});
