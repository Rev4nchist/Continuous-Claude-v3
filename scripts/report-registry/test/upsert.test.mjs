// upsert.test.mjs — pure tests for the registry upsert key logic (mocked
// transport; no ntn spawn). Verifies the append-all-attempts contract:
//   distinct runId -> create (append); same runId -> update in place;
//   >1 match -> dedup-warn + update newest. Plus validation + property mapping.
// Run: node --test "scripts/report-registry/test/*.test.mjs"
//      (NOT the bare directory form — on this Node/Windows combo it collects 1 file and fails)
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  validateRun, buildProperties, upsertReportRun, readInput,
  wantsRefresh, runScopedRefresh,
} from '../upsert.mjs';
import { captureConsole } from '../emit-run.mjs';

const DS = 'c7d2d9e3-d388-4640-a66e-88f7dd50f854';

const baseRun = {
  runId: 'VP Weekly|2026-W27|2026-07-09T06:00',
  type: 'VP Weekly',
  period: '2026-W27',
  runDate: '2026-07-09T06:00:00',
  status: 'OK',
  source: 'AIWeeklyReport',
  summary: 'headline',
};

// Capturing mock transport set.
function mocks({ matches = [] } = {}) {
  const calls = { query: [], create: [], update: [], trash: [] };
  return {
    calls,
    dsId: DS,
    query: (dsId, opts) => { calls.query.push({ dsId, opts }); return matches; },
    create: (dsId, props) => { calls.create.push({ dsId, props }); return { id: 'new-page' }; },
    update: (pageId, props) => { calls.update.push({ pageId, props }); return { id: pageId }; },
    trash: (pageId) => { calls.trash.push({ pageId }); return { id: pageId, in_trash: true }; },
  };
}

// --- validation ---------------------------------------------------------------

test('validateRun throws on missing required field', () => {
  const { runId, ...noRunId } = baseRun;
  assert.throws(() => validateRun(noRunId), /missing required field "runId"/);
});

test('validateRun throws on invalid type', () => {
  assert.throws(() => validateRun({ ...baseRun, type: 'Bogus' }), /invalid type/);
});

test('validateRun throws on invalid status', () => {
  assert.throws(() => validateRun({ ...baseRun, status: 'Green' }), /invalid status/);
});

test('validateRun throws on invalid source (unknown Source select)', () => {
  assert.throws(() => validateRun({ ...baseRun, source: 'Bogus-Source' }), /invalid source/);
});

test('validateRun accepts a well-formed run', () => {
  assert.equal(validateRun(baseRun), baseRun);
});

// --- property mapping ----------------------------------------------------------

test('buildProperties maps title + all typed fields; omits absent optionals', () => {
  const p = buildProperties(baseRun);
  assert.equal(p['Report Run'].title[0].text.content, 'VP Weekly — 2026-W27 — 2026-07-09T06:00:00');
  assert.equal(p['Run ID'].rich_text[0].text.content, baseRun.runId);
  assert.equal(p['Report Type'].select.name, 'VP Weekly');
  assert.equal(p.Status.select.name, 'OK');
  assert.equal(p.Source.select.name, 'AIWeeklyReport');
  assert.equal(p['Run Date'].date.start, baseRun.runDate);
  assert.equal(p.Period.rich_text[0].text.content, '2026-W27');
  assert.equal(p.Summary.rich_text[0].text.content, 'headline');
  // Absent optionals are not sent.
  assert.equal(p.Commit, undefined);
  assert.equal(p['Artifact URL'], undefined);
  assert.equal(p['Docx/Deck'], undefined);
  assert.equal(p.Attempt, undefined);
});

test('buildProperties includes urls, commit, attempt when present', () => {
  const p = buildProperties({
    ...baseRun, artifactUrl: 'https://x/y', docxUrl: 'https://x/z.docx',
    commit: 'abc123', attempt: 2,
  });
  assert.equal(p['Artifact URL'].url, 'https://x/y');
  assert.equal(p['Docx/Deck'].url, 'https://x/z.docx');
  assert.equal(p.Commit.rich_text[0].text.content, 'abc123');
  assert.equal(p.Attempt.number, 2);
});

test('buildProperties OMITS url props holding a non-URL filesystem path (T6.1 #2)', () => {
  // A deploy-fail path can leave a local path in artifactUrl/docxUrl. A Notion url
  // property would 400 on that and drop the whole row, so it must be omitted.
  const p = buildProperties({
    ...baseRun,
    artifactUrl: '~/continuous-claude/ai-report-card/output/archive/2026-W27',
    docxUrl: 'docs/self-improvement/INDEX.md',
  });
  assert.equal(p['Artifact URL'], undefined);
  assert.equal(p['Docx/Deck'], undefined);
  // The rest of the row still lands.
  assert.equal(p['Run ID'].rich_text[0].text.content, baseRun.runId);
  assert.equal(p.Status.select.name, 'OK');
});

test('buildProperties keeps http(s) urls, omits only the non-URL one', () => {
  const p = buildProperties({
    ...baseRun, artifactUrl: 'https://example.com/report', docxUrl: '/tmp/local/report.docx',
  });
  assert.equal(p['Artifact URL'].url, 'https://example.com/report');
  assert.equal(p['Docx/Deck'], undefined);
});

// --- upsert key logic (the append-all-attempts contract) -----------------------

test('0 matches -> CREATE (append), queries by Run ID equals', () => {
  const m = mocks({ matches: [] });
  const res = upsertReportRun(baseRun, m);
  assert.equal(res.action, 'created');
  assert.equal(res.pageId, 'new-page');
  assert.equal(m.calls.create.length, 1);
  assert.equal(m.calls.update.length, 0);
  assert.deepEqual(m.calls.query[0].opts.filter, {
    property: 'Run ID', rich_text: { equals: baseRun.runId },
  });
});

test('1 match -> UPDATE in place (same runId retried)', () => {
  const m = mocks({ matches: [{ id: 'existing-1', properties: {} }] });
  const res = upsertReportRun(baseRun, m);
  assert.equal(res.action, 'updated');
  assert.equal(res.pageId, 'existing-1');
  assert.equal(m.calls.create.length, 0);
  assert.equal(m.calls.update.length, 1);
  assert.equal(m.calls.update[0].pageId, 'existing-1');
});

test('>1 match -> dedup-warn + UPDATE the newest by Run Date + TRASH the older', () => {
  const m = mocks({ matches: [
    { id: 'older', properties: { 'Run Date': { date: { start: '2026-07-09T06:00:00' } } } },
    { id: 'newer', properties: { 'Run Date': { date: { start: '2026-07-09T07:00:00' } } } },
  ] });
  const res = upsertReportRun(baseRun, m);
  assert.equal(res.action, 'updated');
  assert.equal(res.duplicates, 2);
  assert.equal(m.calls.update[0].pageId, 'newer');
  // orphan cleanup (T6.1 #6): the older duplicate is trashed, the newest kept.
  assert.equal(m.calls.trash.length, 1);
  assert.equal(m.calls.trash[0].pageId, 'older');
});

test('>1 match -> trashes ALL older duplicates, keeps only the newest', () => {
  const m = mocks({ matches: [
    { id: 'oldest', properties: { 'Run Date': { date: { start: '2026-07-09T05:00:00Z' } } } },
    { id: 'mid', properties: { 'Run Date': { date: { start: '2026-07-09T06:00:00Z' } } } },
    { id: 'newest', properties: { 'Run Date': { date: { start: '2026-07-09T07:00:00Z' } } } },
  ] });
  const res = upsertReportRun(baseRun, m);
  assert.equal(res.pageId, 'newest');
  assert.equal(m.calls.update.length, 1);
  assert.equal(m.calls.update[0].pageId, 'newest');
  const trashed = m.calls.trash.map((t) => t.pageId).sort();
  assert.deepEqual(trashed, ['mid', 'oldest']);
});

test('newestRow picks CHRONOLOGICALLY newest across mixed tz formats (not lexicographic)', () => {
  // '...06:00:00-05:00' == 11:00Z is chronologically NEWER than '...10:00:00Z',
  // but lexicographically SMALLER ('06' < '10'). The numeric compare must pick the
  // offset row; a string compare would wrongly pick the Z row.
  const m = mocks({ matches: [
    { id: 'z-row', properties: { 'Run Date': { date: { start: '2026-07-09T10:00:00Z' } } } },
    { id: 'offset-row', properties: { 'Run Date': { date: { start: '2026-07-09T06:00:00-05:00' } } } },
  ] });
  const res = upsertReportRun(baseRun, m);
  assert.equal(res.pageId, 'offset-row');
  assert.equal(m.calls.trash[0].pageId, 'z-row');
});

test('distinct runId does NOT reuse another run row (append, never overwrite)', () => {
  // Two different runs in the same period: each queries its own Run ID; with no
  // match for run B, it creates rather than touching run A's row.
  const m = mocks({ matches: [] });
  upsertReportRun({ ...baseRun, runId: 'VP Weekly|2026-W27|B' }, m);
  assert.equal(m.calls.create.length, 1);
  assert.equal(m.calls.query[0].opts.filter.rich_text.equals, 'VP Weekly|2026-W27|B');
});

// --- idempotent create (T5.1): timeout-retry-dedup -----------------------------

test('transient create failure that LANDED server-side is adopted, not re-created', () => {
  // create throws a transient (timeout) error once; the row committed anyway, so
  // the re-query by Run ID returns it. Expect: ADOPT (update in place), and NO
  // second create POST (the duplicate the naive retry would have made).
  let createCalls = 0;
  let queryCalls = 0;
  const landed = {
    id: 'landed-page',
    properties: { 'Run ID': { rich_text: [{ plain_text: baseRun.runId }] } },
  };
  const calls = { update: [] };
  const m = {
    dsId: DS,
    // 1st query (initial upsert lookup) -> no match; 2nd query (post-failure
    // re-query) -> the row that landed server-side.
    query: () => { queryCalls += 1; return queryCalls === 1 ? [] : [landed]; },
    create: () => { createCalls += 1; throw new Error('ntn exited 1 [api v1/pages -X POST]: request ETIMEDOUT timeout'); },
    update: (pageId, props) => { calls.update.push({ pageId, props }); return { id: pageId }; },
  };
  const res = upsertReportRun(baseRun, m);
  assert.equal(res.action, 'adopted');
  assert.equal(res.pageId, 'landed-page');
  assert.equal(createCalls, 1, 'must NOT re-create after adopting the landed row');
  assert.equal(calls.update.length, 1, 'adopts by updating the landed row in place');
  assert.equal(calls.update[0].pageId, 'landed-page');
});

test('transient create failure that did NOT land is retried, then succeeds', () => {
  // create throws transient once; re-query finds NO row (it never landed) -> the
  // create is retried and the second attempt succeeds. Net: a genuine create.
  let createCalls = 0;
  const m = {
    dsId: DS,
    query: () => [], // never any existing row
    create: () => {
      createCalls += 1;
      if (createCalls === 1) throw new Error('ntn failed after 3 attempts: 429 rate limited');
      return { id: 'fresh-page' };
    },
    update: () => { throw new Error('should not update'); },
  };
  const res = upsertReportRun(baseRun, m);
  assert.equal(res.action, 'created');
  assert.equal(res.pageId, 'fresh-page');
  assert.equal(createCalls, 2, 'retries the create when re-query proves it never landed');
});

test('non-transient create failure throws immediately (no adopt, no retry)', () => {
  let createCalls = 0;
  const m = {
    dsId: DS,
    query: () => [],
    create: () => { createCalls += 1; throw new Error('ntn exited 400 [api v1/pages]: validation_error body failed'); },
    update: () => {},
  };
  assert.throws(() => upsertReportRun(baseRun, m), /validation_error/);
  assert.equal(createCalls, 1, 'a non-transient failure is not retried');
});

// --- input resolution ----------------------------------------------------------

test('readInput handles --emit inline json', () => {
  assert.equal(readInput(['--emit', '{"a":1}']), '{"a":1}');
  assert.equal(readInput(['--emit={"b":2}']), '{"b":2}');
});

// --- event-driven scoped refresh (optimization 02) --------------------------------

test('wantsRefresh defaults ON; --no-refresh opts out; flag never leaks into readInput path pick', () => {
  assert.equal(wantsRefresh([]), true);
  assert.equal(wantsRefresh(['run.json']), true);
  assert.equal(wantsRefresh(['--no-refresh', 'run.json']), false);
  // --no-refresh starts with '--' so readInput's first-non-flag path pick skips it
  assert.equal(readInput(['--no-refresh', '--emit', '{"a":1}']), '{"a":1}');
});

test('runScopedRefresh spawns refresh-pages.mjs with --type and reports ok on exit 0', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  const res = runScopedRefresh('VP Weekly', { spawn });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.match(calls[0].args[0], /refresh-pages\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), ['--type', 'VP Weekly']);
  assert.ok(calls[0].opts.timeout > 0, 'hard-bounded');
});

// Contract #2 of emit-run.mjs ("stderr is SILENT on the success path") depends on
// the child's output being routed through THIS process's console, where
// captureConsole can intercept it. stdio 'inherit' hands the child the parent's
// real fds and makes that structurally impossible — proven live 2026-08-03
// (handoff: emit_run_contract_2_is_false_on_its_own_default_path). This test
// runs a REAL child process with runScopedRefresh's own spawn options, so it
// fails if anyone reverts to 'inherit'.
test('runScopedRefresh routes a REAL child\'s stdout+stderr through console (capturable), not the parent fds', () => {
  const realChild = (cmd, args, opts) => spawnSync(
    process.execPath,
    ['-e', 'console.log("child-stdout-chatter"); console.error("child-stderr-chatter")'],
    opts, // CRITICAL: the exact options runScopedRefresh built, stdio included
  );
  const sink = [];
  const { value: res } = captureConsole(() => runScopedRefresh('VP Weekly', { spawn: realChild }), sink);
  assert.equal(res.ok, true);
  const joined = sink.join('\n');
  assert.match(joined, /child-stdout-chatter/, 'child stdout must be re-emitted in-process so captureConsole can hold it');
  assert.match(joined, /child-stderr-chatter/, 'child stderr must be re-emitted in-process so captureConsole can hold it');
});

test('runScopedRefresh replays a failing child\'s output too (a nonzero exit must not be silent)', () => {
  const realChild = (cmd, args, opts) => spawnSync(
    process.execPath,
    ['-e', 'console.error("child-failure-detail"); process.exit(3)'],
    opts,
  );
  const sink = [];
  const { value: res } = captureConsole(() => runScopedRefresh('VP Weekly', { spawn: realChild }), sink);
  assert.deepEqual(res, { ok: false, status: 3 });
  assert.match(sink.join('\n'), /child-failure-detail/, 'the child\'s failure detail must survive into the capturing caller');
});

test('runScopedRefresh is NON-FATAL on spawn error, nonzero exit, and throw', () => {
  assert.deepEqual(
    runScopedRefresh('VP Weekly', { spawn: () => ({ error: new Error('ENOENT') }) }),
    { ok: false, status: null },
  );
  assert.deepEqual(
    runScopedRefresh('VP Weekly', { spawn: () => ({ status: 2 }) }),
    { ok: false, status: 2 },
  );
  assert.deepEqual(
    runScopedRefresh('VP Weekly', { spawn: () => { throw new Error('boom'); } }),
    { ok: false, status: null },
  );
});
