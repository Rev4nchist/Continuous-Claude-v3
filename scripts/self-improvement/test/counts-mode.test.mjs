// counts-mode.test.mjs: the --counts mode of failure-audit.mjs and ask-rate.mjs (card coord-seat-counts, part B), run through the real CLI.
// Run: node --test "scripts/self-improvement/test/*.test.mjs"
// The fixtures are built in a temp folder: <root>/<project>/<session>.jsonl. Names B1..B4 are the failure list of the design note
// .claudedocs/coordination/2026-11-16-coord-seat-counts-design.md. The default (no flag) output must stay as it was (B3).
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(here, '..', 'failure-audit.mjs');
const RATE = path.join(here, '..', 'ask-rate.mjs');
const SECRET = 'zebra-quartz-typed-secret';
const PROJECT = 'C--proj-folder-name-xyz';
const SESSION = 'abcd1234-0000-4000-8000-000000000001';
const t0 = Date.now() - 60_000;
const at = (s) => new Date(t0 + s * 1000).toISOString();

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'counts-mode-'));
  const dir = path.join(tmp, PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'assistant', timestamp: at(0), entrypoint: 'cli', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Previous assistant words are here.' }, { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', options: [] }] } }] } },
    { type: 'user', timestamp: at(5), entrypoint: 'cli', message: { role: 'user', content: `that is not what i asked, ${SECRET}` } },
    { type: 'assistant', timestamp: at(9), entrypoint: 'cli', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function audit(extra = []) {
  const out = path.join(tmp, `a-${extra.join('').replace(/\W/g, '')}.md`);
  const json = out.replace(/\.md$/, '.json');
  const r = spawnSync(process.execPath, [AUDIT, '--root', tmp, '--days', '36500', '--out', out, '--json', json, ...extra], { encoding: 'utf8' });
  return { code: r.status, err: r.stderr || '', md: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, json: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null };
}
function rate(extra = []) {
  const out = path.join(tmp, `r-${extra.join('').replace(/\W/g, '')}.md`);
  const json = out.replace(/\.md$/, '.json');
  const r = spawnSync(process.execPath, [RATE, '--root', tmp, '--project', PROJECT, '--days', '36500', '--out', out, '--json', json, ...extra], { encoding: 'utf8' });
  return { code: r.status, err: r.stderr || '', md: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, json: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null };
}

test('B1: failure-audit --counts keeps the counts and drops every incident, text, previous text and session reference', () => {
  const r = audit(['--counts']);
  assert.equal(r.code, 0, r.err);
  const all = r.md + JSON.stringify(r.json);
  for (const bad of [SECRET, 'Previous assistant words', 'abcd1234', PROJECT, '## Incidents']) assert.ok(!all.includes(bad), `counts output holds "${bad}"`);
  assert.equal(r.json.classTotals.misread, 1);
  assert.equal(r.json.corrections, 1);
  assert.equal(r.json.incidents, undefined);
  assert.ok(r.md.includes('## By class') && r.md.includes('misread'));
});

test('B2: --counts with --dump is refused with exit 1 and no dump file is written', () => {
  const dump = path.join(tmp, 'dump.jsonl');
  const r = audit(['--counts', '--dump', dump]);
  assert.equal(r.code, 1);
  assert.ok(!fs.existsSync(dump));
  assert.equal(r.md, null);
});

test('B3: guard: without --counts both scripts still print what they printed (incidents and text; top sessions and scope)', () => {
  const a = audit();
  assert.equal(a.code, 0, a.err);
  assert.ok(a.md.includes('## Incidents') && a.md.includes(SECRET));
  assert.ok(Array.isArray(a.json.incidents) && a.json.incidents.length === 1);
  const b = rate();
  assert.equal(b.code, 0, b.err);
  assert.ok(b.md.includes('Top sessions') && b.md.includes(PROJECT) && b.md.includes('abcd1234'));
});

test('B4: ask-rate --counts drops the session prefixes, the project folder name and the exclude list; the counts stay', () => {
  const r = rate(['--counts', '--exclude', 'deadbeef']);
  assert.equal(r.code, 0, r.err);
  const all = r.md + JSON.stringify(r.json);
  for (const bad of ['abcd1234', PROJECT, 'Top sessions', 'deadbeef']) assert.ok(!all.includes(bad), `counts output holds "${bad}"`);
  assert.equal(r.json.interactive.asks, 1);
  assert.equal(r.json.interactive.sessions, 1);
  assert.equal(r.json.byEntrypoint.cli.top, undefined);
  assert.ok(r.md.includes('Asks per interactive session'));
});
