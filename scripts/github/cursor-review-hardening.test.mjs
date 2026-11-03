// Tests for the tolerant findings parse and the path filter in scripts/github/cursor-review.mjs (engine output hardening).
// Run: node --test scripts/github/cursor-review-hardening.test.mjs
// fixtures/cursor-review/cursor-211.json is the real raw output of PR 211 round 1 (2026-11-03), the answer that failed with
// "no findings block and no recognisable headings".
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, parseReviewOutput, runReview } from './cursor-review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(path.join(HERE, 'fixtures', 'cursor-review', `cursor-${n}.json`), 'utf8');
const resultLine = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, result: text, session_id: 's', usage: {} });
const block = (obj) => `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;

test('PR 211 round 1 (real raw output): the block ends "]}" instead of "}]}" and is repaired, not failed', () => {
  // Breaks when: jsonBlock does not repair a closer that does not match the open object, or the repair note is not reported.
  const p = parseReviewOutput(fixture(211));
  assert.equal(p.ok, true);
  assert.equal(p.format, 'json');
  assert.deepEqual(p.findings.map((f) => [f.file, f.line, f.severity]), [['scripts/settings/remove-maestro-registrations.mjs', 14, 'major'], ['scripts/settings/remove-maestro-registrations.mjs', 2, 'minor']]);
  assert.match(p.problems.join(' '), /repaired malformed findings JSON/);
});

test('a valid findings block is never repaired: same findings and no repair note', () => {
  // Breaks when: the repair runs before JSON.parse, or flags every block.
  const p = parseReviewOutput(resultLine(block({ findings: [{ file: 'a.ts', line: 3, severity: 'major', title: 'T', body: 'B' }] })));
  assert.equal(p.ok, true);
  assert.deepEqual(p.findings, [{ file: 'a.ts', line: 3, lineEnd: null, severity: 'major', title: 'T', body: 'B' }]);
  assert.doesNotMatch(p.problems.join(' '), /repaired/);
});

test('a block cut off inside a string stays failed: the repair never invents text', () => {
  // Breaks when: the repair closes an open string, or an unparseable block is read as an empty pass.
  const p = parseReviewOutput(resultLine('Notes\n```json\n{"findings":[{"file":"a.ts","line":3,"severity":"major","title":"T","body":"cut off here\n```'));
  assert.equal(p.ok, false);
  assert.equal(p.clean, false);
  assert.deepEqual(p.findings, []);
});

test('an answer with no parseable output at all stays failed, never a clean pass', () => {
  // Breaks when: an empty or non-JSON agent output returns ok.
  for (const out of ['', 'not json at all', resultLine('')]) {
    const p = parseReviewOutput(out);
    assert.equal(p.ok, false, JSON.stringify(out));
    assert.equal(p.clean, false);
  }
});

test('exists: a finding on a file that is not in the reviewed tree is dropped and named; the round stays ok', () => {
  // Breaks when: parseReviewOutput ignores the exists option, or fails the round when every finding is dropped.
  const text = block({ findings: [{ file: 'real.ts', line: 1, severity: 'major', title: 'Real', body: 'b' }, { file: 'ghost/made-up.ts', line: 9, severity: 'major', title: 'Ghost', body: 'b' }] });
  const p = parseReviewOutput(resultLine(text), { exists: (f) => f === 'real.ts' });
  assert.deepEqual(p.findings.map((f) => f.file), ['real.ts']);
  assert.match(p.problems.join(' '), /ghost\/made-up\.ts/);
  const all = parseReviewOutput(resultLine(text), { exists: () => false });
  assert.equal(all.ok, true);
  assert.deepEqual(all.findings, []);
});

test('runReview drops a finding on a file the head does not hold, records the drop, and still exits ok', async () => {
  // Breaks when: runReview does not pass the tree check to the parser, or a dropped finding fails the run.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cursor-hardening-'));
  try {
    const stdout = resultLine(block({ findings: [{ file: 'real.ts', line: 1, severity: 'major', title: 'Real', body: 'b' }, { file: 'ghost.ts', line: 2, severity: 'major', title: 'Ghost', body: 'b' }] }));
    const deps = {
      now: () => Date.parse('2026-11-03T12:00:00Z'), env: {}, agent: { cmd: 'AGENT', prefixArgs: [] },
      prepare: async () => ({ ref: 'pr-5', base: 'b'.repeat(40), head: 'h'.repeat(40), dir: path.join(dir, 'tree'), files: ['real.ts'], cleanup: () => {} }),
      runner: async () => ({ status: 0, stdout, stderr: '', timedOut: false, durationMs: 5 }),
      treeHas: (file) => file === 'real.ts',
    };
    const r = await runReview({ input: { pr: 5 }, band: 'MID', ledgerPath: path.join(dir, 'ledger.jsonl'), outDir: path.join(dir, 'out'), timeoutMs: 1000 }, deps);
    assert.equal(r.exit, EXIT.OK);
    const rec = JSON.parse(readFileSync(r.findingsPath, 'utf8'));
    assert.deepEqual(rec.findings.map((f) => f.file), ['real.ts']);
    assert.match(rec.problems.join(' '), /ghost.ts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('headHasFile keeps a file in the head tree and drops a directory path (CodeRabbit #275)', async () => {
  // Breaks when: headHasFile accepts any git object (cat-file -e) instead of only a blob, so a finding that names a folder survives.
  const { headHasFile } = await import('./cursor-review.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync: wf, mkdirSync: md } = await import('node:fs');
  const repo = mkdtempSync(path.join(os.tmpdir(), 'hhf-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); md(path.join(repo, 'src'));
    wf(path.join(repo, 'src', 'a.ts'), 'x\n');
    git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
    const has = headHasFile(repo, git('rev-parse', 'HEAD'));
    assert.equal(has('src/a.ts'), true);
    assert.equal(has('src'), false);
    assert.equal(has('src/missing.ts'), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
