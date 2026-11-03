// Failure modes of the TREX baseline adapter (each silently changes the score if it breaks):
//  F1 hunk count omitted      '@@ -12 +12,2 @@' must be one line, not zero or NaN        -> parseOldRanges default count
//  F2 pure insertion / delete '-12,0' is the one line before the insert; '-5,3' is 5..7   -> end = start + count - 1
//  F3 multi-file diff         ranges must land on the right file, with forward slashes    -> file split on 'diff --git'
//  F4 S6/S7 share one range   one engine run, two dataset rows (else the run count is 26+) -> planRuns dedupe
//  F5 fix creates the file    '-0,0' has no pre line; it must not become a line-0 match   -> datasetFindings start >= 1
//  F6 failed engine record    must give no findings file (a failed run is not "zero findings") -> findingsFile null
//  F7 windows backslash       engine file 'a\\b.ts' must still match the defect file       -> normPath in toEvalFinding
//  F8 harness filter          a runs.jsonl row must reach scorecard, not be dropped as stale -> set 'dev', promptSha256 null
//  F9 false alarm rule        minor, and major with confidence 2, are not false alarms     -> majorFindings
//  F10 judge order            line-matched findings are judged before louder ones           -> rankCandidates
//  F11 bench rows missing     a missing bench row or negative must stop, not shrink n       -> buildRows throws
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateRuns, scorecard } from '../review-eval/score.mjs';
import { NEGATIVE_IDS, POSITIVE_IDS, datasetFindings, findingsFile, majorFindings, parseOldRanges, planRuns, runRow, splitRange, toEvalFinding } from './adapter.mjs';
import { buildRows } from './rows.mjs';
import { rankCandidates } from './score.mjs';

const DIFF = [
  'diff --git a/scripts/a.mjs b/scripts/a.mjs', '--- a/scripts/a.mjs', '+++ b/scripts/a.mjs',
  '@@ -12 +12,2 @@', '-x', '+y', '+z',
  '@@ -20,0 +22,3 @@', '+i',
  '@@ -30,3 +33,0 @@', '-a',
  'diff --git a/lib/b.ts b/lib/b.ts', '--- a/lib/b.ts', '+++ b/lib/b.ts',
  '@@ -0,0 +1,5 @@', '+n',
].join('\n');

test('F1 F2 F3 hunk header parsing', () => {
  const r = parseOldRanges(DIFF);
  assert.deepEqual(r['scripts/a.mjs'], [{ start: 12, end: 12 }, { start: 20, end: 20 }, { start: 30, end: 32 }]);
  assert.deepEqual(r['lib/b.ts'], [{ start: 0, end: 0 }]);
  assert.deepEqual(parseOldRanges(''), {});
});

const rows = [
  { id: 'S6', kind: 'positive', base40: 'b', head40: 'h', defectFiles: ['scripts/github/review-router.mjs'], oldRanges: { 'scripts/github/review-router.mjs': [{ start: 34, end: 34 }] } },
  { id: 'S7', kind: 'positive', base40: 'b', head40: 'h', defectFiles: ['hooks/index.tsx'], oldRanges: {} },
  { id: 'S13', kind: 'positive', base40: 'b2', head40: 'h2', defectFiles: ['q.ts', 'new.ts'], oldRanges: { 'q.ts': [{ start: 5, end: 5 }], 'new.ts': [{ start: 0, end: 0 }] } },
  { id: 'N3', kind: 'negative', base40: 'nb', head40: 'nh', defectFiles: [] },
];

test('F4 S6 and S7 share one run and keep two dataset rows', () => {
  const runs = planRuns(rows);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].rowIds, ['S6', 'S7']);
  assert.ok(runs[0].pr >= 9001 && runs[0].pr < 9101);
  assert.ok(runs[2].pr >= 9101);
  const ds = datasetFindings(rows, runs);
  assert.deepEqual(ds.filter((d) => d.pr === runs[0].pr).map((d) => d.row), ['S6', 'S7']);
});

test('F5 a hunk at line 0 gives a lineless finding, never line 0', () => {
  const ds = datasetFindings(rows, planRuns(rows));
  const fresh = ds.find((d) => d.path === 'new.ts');
  assert.equal(fresh.startLine, null);
  assert.equal(ds.find((d) => d.path === 'q.ts').startLine, 5);
  assert.ok(ds.every((d) => d.severity === 'major' && d.verdict === 'real'));
});

test('F6 a failed record gives no findings file', () => {
  assert.equal(findingsFile(null), null);
  assert.equal(findingsFile({ status: 'failed', findings: [] }), null);
  assert.deepEqual(findingsFile({ status: 'ok', findings: [], runs: [{ durationMs: 5 }] }).findings, []);
});

test('F7 a Windows path and a startLine reach the harness shape', () => {
  const f = toEvalFinding({ file: 'scripts\\github\\x.mjs', startLine: 10, endLine: 12, severity: 'MAJOR', title: 't', confidence: 4 });
  assert.deepEqual([f.file, f.line, f.lineEnd, f.severity], ['scripts/github/x.mjs', 10, 12, 'major']);
  assert.equal(toEvalFinding({ file: 'a', title: 't' }).line, null);
});

test('F8 a runs.jsonl row survives evaluateRuns and scorecard with a line match', () => {
  const runs = planRuns(rows);
  const ds = datasetFindings(rows, runs).filter((d) => d.row === 'S6');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trexb-'));
  const fp = path.join(dir, 'f.json');
  writeFileSync(fp, JSON.stringify({ findings: [{ file: 'scripts/github/review-router.mjs', line: 36, lineEnd: 36, severity: 'minor', title: 'near' }] }));
  const row = runRow({ run: runs[0], record: { status: 'ok', runId: 'r1', findings: [{}], runs: [] }, findingsPath: fp, ts: '2026-11-03T00:00:00Z' });
  const ev = evaluateRuns({ runs: [row], dataset: ds, readFindings: (p) => JSON.parse(readFileSync(p, 'utf8')) });
  const card = scorecard({ runs: ev.runs, matches: ev.matches, sets: { zeroMajorPrs: [] }, frozenPromptSha256: 'f'.repeat(64) });
  assert.equal(card.devRecall.lenient.found, 1);
  assert.equal(card.excludedRuns, 0);
  assert.equal(row.set, 'dev');
});

test('F9 only major or critical with confidence >= 3 is a false alarm', () => {
  const found = majorFindings([
    { severity: 'minor', confidence: 5 }, { severity: 'major', confidence: 2 }, { severity: 'Major', confidence: 3 }, { severity: 'critical' },
  ]);
  assert.equal(found.length, 2);
});

test('F10 line-matched findings are judged first', () => {
  const quiet = { severity: 'minor', line: 5, confidence: 3 };
  const loud = { severity: 'critical', line: 90, confidence: 5 };
  const lines = new Set([quiet]);
  assert.equal(rankCandidates([loud, quiet], lines)[0], quiet);
  assert.equal(rankCandidates([quiet, loud], new Set())[0], loud);
});

test('F11 the row lists have the right size and bench gaps stop the build', () => {
  assert.equal(POSITIVE_IDS.length, 15);
  assert.equal(NEGATIVE_IDS.length, 11);
  assert.equal(new Set(NEGATIVE_IDS).size, 11);
  assert.deepEqual(splitRange('ac03ec78^1..ac03ec78'), { base: 'ac03ec78^1', head: 'ac03ec78' });
  assert.throws(() => splitRange('abc'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trexb-'));
  writeFileSync(path.join(dir, 'proofs-trex.json'), JSON.stringify({ rows: [] }));
  writeFileSync(path.join(dir, 'negatives.json'), JSON.stringify({ negatives: [] }));
  assert.throws(() => buildRows({ benchDir: dir, git: () => 'a'.repeat(40) }), /S1 is missing/);
});
