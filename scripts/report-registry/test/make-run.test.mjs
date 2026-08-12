// make-run.test.mjs — pure tests for the report-run.json EMIT contract.
// Verifies buildRun: required-field + enum validation, runId derivation
// (type|period|runDate, runDate defaulting to now), optional-field omission,
// and the tempRunPath + writeRun path/write behavior. No ntn spawn.
// Run: node --test scripts/report-registry/test/make-run.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRun, tempRunPath, writeRun, parseFlags,
} from '../make-run.mjs';
import { SOURCES } from '../config.mjs';

const base = {
  type: 'Project Portfolio',
  period: '2026-07-05',
  status: 'OK',
  source: 'Project-Cards',
};

// --- validation ----------------------------------------------------------------

test('buildRun throws on a missing required field', () => {
  assert.throws(() => buildRun({ ...base, source: '' }), /missing required field "source"/);
  assert.throws(() => buildRun({ ...base, type: undefined }), /missing required field "type"/);
});

test('buildRun throws on an invalid type', () => {
  assert.throws(() => buildRun({ ...base, type: 'Bogus' }), /invalid type/);
});

test('buildRun throws on an invalid status', () => {
  assert.throws(() => buildRun({ ...base, status: 'Green' }), /invalid status/);
});

test('buildRun throws on an invalid source (T6.1 #4)', () => {
  assert.throws(() => buildRun({ ...base, source: 'Bogus-Source' }), /invalid source/);
});

test('buildRun accepts every known Source select value', () => {
  // Derived from SOURCES (config.mjs) rather than a hardcoded literal list: the
  // literal silently rotted when VP Weekly / AIWeeklyReport was retired 2026-07-25.
  // Deriving it means retiring or adding a type can never break this test.
  assert.ok(SOURCES.length > 0, 'SOURCES must be non-empty');
  for (const source of SOURCES) {
    assert.doesNotThrow(() => buildRun({ ...base, source }));
  }
});

// --- runId derivation ----------------------------------------------------------

test('buildRun derives runId = type|period|runDate and echoes runDate', () => {
  const run = buildRun({ ...base, runDate: '2026-07-05T13:30:00.000Z' });
  assert.equal(run.runId, 'Project Portfolio|2026-07-05|2026-07-05T13:30:00.000Z');
  assert.equal(run.runDate, '2026-07-05T13:30:00.000Z');
  assert.equal(run.period, '2026-07-05');
});

test('buildRun defaults runDate to now when omitted (runId timestamp === runDate)', () => {
  const run = buildRun(base);
  assert.match(run.runDate, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(run.runId, `Project Portfolio|2026-07-05|${run.runDate}`);
});

// --- optional-field handling ---------------------------------------------------

test('buildRun omits absent optionals, includes present ones', () => {
  const bare = buildRun(base);
  assert.equal('artifactUrl' in bare, false);
  assert.equal('summary' in bare, false);
  assert.equal('docxUrl' in bare, false);
  assert.equal('commit' in bare, false);
  const full = buildRun({
    ...base, artifactUrl: 'https://x/y', summary: 'hi', docxUrl: 'https://x/z.docx', commit: 'abc',
  });
  assert.equal(full.artifactUrl, 'https://x/y');
  assert.equal(full.summary, 'hi');
  assert.equal(full.docxUrl, 'https://x/z.docx');
  assert.equal(full.commit, 'abc');
});

test('buildRun drops empty-string optionals (no blank fields emitted)', () => {
  const run = buildRun({ ...base, summary: '   ', artifactUrl: '' });
  assert.equal('summary' in run, false);
  assert.equal('artifactUrl' in run, false);
});

// --- path + write --------------------------------------------------------------

test('tempRunPath honors $TEMP and slugs the source', () => {
  const prev = process.env.TEMP;
  process.env.TEMP = 'C:/tmpdir';
  try {
    assert.equal(tempRunPath('Project-Cards'), join('C:/tmpdir', 'report-run-Project-Cards.json'));
    // path-hostile source is sanitized
    assert.equal(tempRunPath('a/b c'), join('C:/tmpdir', 'report-run-a-b-c.json'));
  } finally {
    if (prev === undefined) delete process.env.TEMP; else process.env.TEMP = prev;
  }
});

test('writeRun writes valid JSON to the given out path and returns it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mkrun-'));
  const out = join(dir, 'run.json');
  try {
    const run = buildRun({ ...base, summary: 'roundtrip' });
    const path = writeRun(run, { out });
    assert.equal(path, out);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(parsed, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI flag parsing -----------------------------------------------------------

test('parseFlags handles --k v, --k=v, and bare boolean flags', () => {
  assert.deepEqual(
    parseFlags(['--type', 'Project Portfolio', '--period=2026-07-05', '--verbose']),
    { type: 'Project Portfolio', period: '2026-07-05', verbose: true },
  );
});

test('parseFlags: a following flag is NOT consumed as a value (omitted value -> boolean)', () => {
  // `--status --period X`: status's value was omitted; it becomes boolean true, which
  // buildRun's enum check then rejects loud rather than writing a garbage status.
  assert.deepEqual(
    parseFlags(['--status', '--period', '2026-07-05']),
    { status: true, period: '2026-07-05' },
  );
});

test('parseFlags throws on a --key=--value form (T6.1 #9 guard)', () => {
  assert.throws(() => parseFlags(['--period=--oops']), /"--"-leading value/);
});
