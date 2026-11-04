// Tests for author-input.mjs. Every test imports the real function. Git is a canned function and the records are small objects.
// The probe-set test reads the committed probe-set.json: it pins the 16 records and 35 findings the verify arm authors.
// Nothing here starts a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLOW_TIMEOUT_MAX_MS, MAX_BODY_CHARS, buildAuthorInput, checkVerifyAnswer, lintVerifyAnswer, renderFindings, selectHunks, verifyRowIds,
} from './author-input.mjs';

const PROBE_SET = JSON.parse(readFileSync(new URL('./probe-set.json', import.meta.url), 'utf8'));

// ---------- the committed probe set ----------

test('verifyRowIds gives the 16 records that hold an unblocked finding, S rows first', () => {
  const ids = verifyRowIds(PROBE_SET);
  assert.equal(ids.length, 16);
  assert.deepEqual(ids, ['S1', 'S3', 'S8', 'S9', 'S11', 'S12', 'S13', 'S15', 'N3', 'N9', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16']);
  for (const blocked of ['S4', 'S5', 'S10', 'N7']) assert.ok(!ids.includes(blocked), `${blocked} holds only blocked findings`);
});

test('verifyRowIds counts 35 unblocked findings: group A 3, group B 13, group C 19', () => {
  const rows = PROBE_SET.rows.filter((r) => r.blocked === null);
  const by = (g) => rows.filter((r) => r.group === g).length;
  assert.deepEqual([rows.length, by('A'), by('B'), by('C')], [35, 3, 13, 19]);
  assert.equal(rows.filter((r) => r.row === 'S15').length, 10);
  assert.equal(rows.filter((r) => r.row === 'N16').length, 4);
  assert.equal(rows.filter((r) => r.row === 'N14').length, 1, 'the two N14 mods-host findings are left out');
});

// ---------- selectHunks ----------

const numbered = (from, n, mark) => Array.from({ length: n }, (_, i) => `${mark} line ${from + i}`);
/** A one-hunk diff: new lines 1..count, with `added` the [first, last] new-line range that is added. */
function diffOf(count, [a, b]) {
  const body = [];
  for (let n = 1; n <= count; n += 1) body.push(n >= a && n <= b ? `+code ${n}` : ` ctx ${n}`);
  return ['diff --git a/x.mjs b/x.mjs', 'index 1..2 100644', '--- a/x.mjs', '+++ b/x.mjs', `@@ -1,${count - (b - a + 1)} +1,${count} @@ head`, ...body, ''].join('\n');
}

test('selectHunks returns the hunk that holds the cited lines', () => {
  const out = selectHunks(diffOf(20, [8, 12]), 9, 10);
  assert.equal(out.length, 1);
  assert.match(out[0], /\+code 9/);
  assert.match(out[0], /^@@ /);
});

test('selectHunks returns nothing when the cited lines are far from every hunk', () => {
  assert.deepEqual(selectHunks(diffOf(20, [8, 12]), 400, 410), []);
});

test('selectHunks cuts a long hunk to a window around the cited lines and says so', () => {
  const out = selectHunks(diffOf(400, [1, 400]), 200, 205, { context: 5 });
  assert.equal(out.length, 1);
  assert.match(out[0], /\+code 200/);
  assert.match(out[0], /\+code 205/);
  assert.ok(!/\+code 100\b/.test(out[0]) && !/\+code 300\b/.test(out[0]), 'lines far from the cited range are cut');
  assert.match(out[0], /window/);
});

test('selectHunks keeps removed lines next to the cited range', () => {
  const diff = ['@@ -1,6 +1,4 @@', ' keep 1', '-gone A', '-gone B', ' keep 2', '+new 3', ' keep 4', ''].join('\n');
  const out = selectHunks(diff, 2, 3, { context: 1 });
  assert.match(out.join('\n'), /-gone A/);
  assert.match(out.join('\n'), /\+new 3/);
});

// ---------- buildAuthorInput ----------

const ROW = (over = {}) => ({
  pid: 'aaaa000000000001', row: 'N3', group: 'B', file: 'src/a.mjs', startLine: 9, endLine: 10, title: 'Leaks the path', severity: 'major', confidence: 4,
  head: 'h'.repeat(40), mergeBase: 'b'.repeat(40), pre: null, fix: null, blocked: null, surface: 'node', ...over,
});
const FINDING = (over = {}) => ({ id: 'aaaa000000000001', file: 'src/a.mjs', startLine: 9, endLine: 10, severity: 'major', title: 'Leaks the path', body: 'The path leaks after the first space. A correct scrub removes the whole path.', confidence: 4, status: 'open', ...over });
const gitFor = ({ atBase = true, diff = diffOf(20, [8, 12]) } = {}) => (args) => {
  if (args[0] === 'diff') return { status: 0, stdout: diff, stderr: '' };
  if (args[0] === 'ls-tree') return { status: 0, stdout: atBase ? `100644 blob ${'c'.repeat(40)}\t${args.at(-1)}\0` : '', stderr: '' };
  return { status: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
};
const setOf = (rows, findings, git = gitFor()) => buildAuthorInput({ probeSet: { rows }, records: [{ id: rows[0].row, record: { findings } }], git });

test('buildAuthorInput joins the record body by id and builds the range from merge base to head', () => {
  const out = setOf([ROW()], [FINDING()]);
  const r = out.N3;
  assert.equal(r.range, `${'b'.repeat(40)}..${'h'.repeat(40)}`);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].body, /whole path/);
  assert.equal(r.findings[0].fileAtBase, true);
  assert.match(r.findings[0].hunks[0], /\+code 9/);
  assert.deepEqual(r.citedFiles, ['src/a.mjs']);
});

test('buildAuthorInput leaves a blocked finding out and builds no row for a record with only blocked findings', () => {
  const out = setOf([ROW({ pid: 'aaaa000000000002', blocked: 'mods-host' })], [FINDING({ id: 'aaaa000000000002' })]);
  assert.deepEqual(Object.keys(out), []);
});

test('buildAuthorInput throws when a probe-set row has no finding in the record', () => {
  assert.throws(() => setOf([ROW()], [FINDING({ id: 'ffff', title: 'Other', file: 'other.mjs' })]), /aaaa000000000001/);
});

test('buildAuthorInput marks a file that is absent at the merge base', () => {
  const out = setOf([ROW()], [FINDING()], gitFor({ atBase: false }));
  assert.equal(out.N3.findings[0].fileAtBase, false);
});

test('buildAuthorInput throws when git cannot diff, so a bad range never gives an empty hunk silently', () => {
  const git = (args) => (args[0] === 'diff' ? { status: 128, stdout: '', stderr: 'bad object' } : gitFor()(args));
  assert.throws(() => setOf([ROW()], [FINDING()], git), /bad object/);
});

// ---------- renderFindings ----------

function rowInput(n, over = {}) {
  const rows = Array.from({ length: n }, (_, i) => ROW({ pid: `aaaa00000000000${i}`, startLine: 9, endLine: 10 }));
  const findings = rows.map((r, i) => FINDING({ id: r.pid, title: `Finding ${i}`, ...over }));
  return buildAuthorInput({ probeSet: { rows }, records: [{ id: 'N3', record: { findings } }], git: gitFor({ diff: diffOf(400, [1, 400]) }) }).N3;
}

test('renderFindings names the pid, the file names, the lines, the severity and the body of every finding', () => {
  const text = renderFindings(rowInput(2), { maxChars: 20_000 });
  for (const i of [0, 1]) {
    assert.ok(text.includes(`aaaa00000000000${i}.yaml`));
    assert.ok(text.includes(`aaaa00000000000${i}.declare.json`));
  }
  assert.match(text, /src\/a\.mjs/);
  assert.match(text, /lines 9-10/);
  assert.match(text, /Severity: major/);
  assert.match(text, /whole path/);
  assert.match(text, /\+code 9/);
  assert.match(text, /exists at the merge base: yes/);
});

test('renderFindings stays inside maxChars for ten findings and cuts diff lines first, never the body', () => {
  const long = `${'The scrub drops text. '.repeat(40)}Correct scrub keeps nothing.`;
  const input = rowInput(10, { body: long });
  const text = renderFindings(input, { maxChars: 14_000 });
  assert.ok(text.length <= 14_000, `got ${text.length}`);
  assert.equal(text.split('Correct scrub keeps nothing.').length - 1, 10, 'every body is whole');
  assert.match(text, /diff lines cut/);
});

test('renderFindings cuts a body over MAX_BODY_CHARS and says so', () => {
  const text = renderFindings(rowInput(1, { body: 'x'.repeat(MAX_BODY_CHARS + 500) }), { maxChars: 20_000 });
  assert.match(text, /body cut/);
  assert.ok(!text.includes('x'.repeat(MAX_BODY_CHARS + 1)));
});

test('renderFindings says when the cited lines are outside the diff', () => {
  const input = buildAuthorInput({ probeSet: { rows: [ROW({ startLine: 400, endLine: 410 })] }, records: [{ id: 'N3', record: { findings: [FINDING({ startLine: 400, endLine: 410 })] } }], git: gitFor() }).N3;
  assert.match(renderFindings(input, { maxChars: 20_000 }), /outside the diff/);
});

// ---------- checkVerifyAnswer ----------

const PID = 'aaaa000000000001';
const YAML = (over = {}) => `id: ${PID}
title: the scrub removes a spaced path
description: d
goal: g
paths: [src/a.mjs]
driver: cli
mode: scripted
profile: container
steps:
  - action:
      cmd: [node, --input-type=module, -e, "const m = await import('/app/src/a.mjs'); const out = m.scrub('a b'); if (out !== '') { console.log('not ok 1 - scrub left ' + out); process.exit(1); } console.log('ok 1');"]
    checks:
      - {text: the probe passes, exit: 0}
limits: {timeoutMs: 60000, retries: 0, maxSteps: 5}
severity: P1
${over.extra ?? ''}`;
const DECLARE = (over = {}) => JSON.stringify({ pid: PID, fireMatch: 'scrub left [a-z]+', correct: 'A correct scrub removes the whole path.', newCode: false, ...over });
const input = () => setOf([ROW({ pid: PID })], [FINDING({ id: PID })]).N3;
const answerFiles = (over = {}) => [{ path: `${PID}.yaml`, text: over.yaml ?? YAML() }, { path: `${PID}.declare.json`, text: over.declare ?? DECLARE() }];
const MANIFEST = { flows: [{ id: PID, file: `${PID}.yaml`, risk: 'spaced path' }], cannotVerify: [] };
const check = (over = {}, inp = input()) => checkVerifyAnswer({ files: over.files ?? answerFiles(over), manifest: over.manifest ?? MANIFEST, input: inp });

test('checkVerifyAnswer accepts a good answer and writes the full C1 declare', () => {
  const r = check();
  assert.deepEqual(r.problems, []);
  const declare = JSON.parse(r.files.find((f) => f.path === `${PID}.declare.json`).text);
  assert.deepEqual(Object.keys(declare).sort(), ['citedFile', 'correct', 'endLine', 'fireMatch', 'newCode', 'pid', 'row', 'startLine']);
  assert.equal(declare.row, 'N3');
  assert.equal(declare.citedFile, 'src/a.mjs');
  assert.equal(declare.startLine, 9);
  assert.equal(declare.endLine, 10);
  assert.equal(declare.newCode, false);
});

test('checkVerifyAnswer overrides a citedFile or line the model wrote: the harness values win', () => {
  const r = check({ declare: DECLARE({ citedFile: 'evil.mjs', startLine: 1, endLine: 2, row: 'N3' }) });
  assert.deepEqual(r.problems, []);
  const declare = JSON.parse(r.files.find((f) => f.path.endsWith('.declare.json')).text);
  assert.equal(declare.citedFile, 'src/a.mjs');
  assert.equal(declare.startLine, 9);
});

test('checkVerifyAnswer rejects a fireMatch that buildFireMatch rejects, with its reason', () => {
  for (const [fireMatch, code] of [['.*', 'matches-empty'], ['ab', 'too-few-literals'], ['(', 'invalid-regex']]) {
    const r = check({ declare: DECLARE({ fireMatch }) });
    assert.ok(r.problems.some((p) => p.includes(code)), `${fireMatch}: ${r.problems.join(' | ')}`);
  }
});

test('checkVerifyAnswer rejects a declare with no fireMatch string', () => {
  const r = check({ declare: JSON.stringify({ pid: PID, correct: 'x', newCode: false }) });
  assert.ok(r.problems.some((p) => /fireMatch/.test(p)));
});

test('checkVerifyAnswer rejects a declare whose pid differs, a missing correct sentence and a non-boolean newCode', () => {
  assert.ok(check({ declare: DECLARE({ pid: 'zzzz' }) }).problems.some((p) => /pid/.test(p)));
  assert.ok(check({ declare: DECLARE({ correct: '  ' }) }).problems.some((p) => /correct/.test(p)));
  assert.ok(check({ declare: DECLARE({ correct: 'line one\nline two' }) }).problems.some((p) => /correct/.test(p)));
  assert.ok(check({ declare: DECLARE({ newCode: 'yes' }) }).problems.some((p) => /newCode/.test(p)));
});

test('checkVerifyAnswer rejects a declare that is not JSON', () => {
  assert.ok(check({ declare: '{not json' }).problems.some((p) => /declare/.test(p) && /JSON/.test(p)));
});

test('checkVerifyAnswer needs newCode true when the cited file is absent at the merge base', () => {
  const inp = setOf([ROW({ pid: PID })], [FINDING({ id: PID })], gitFor({ atBase: false })).N3;
  assert.ok(check({}, inp).problems.some((p) => /newCode/.test(p) && /absent/.test(p)));
  assert.deepEqual(check({ declare: DECLARE({ newCode: true, fireMatch: 'scrub left [a-z]+' }) }, inp).problems, []);
});

test('checkVerifyAnswer rejects new-code fireMatch text that is a literal of the probe source (G9)', () => {
  const yaml = YAML().replace("'not ok 1 - scrub left ' + out", "'not ok 1 - scrub left ZETA-9001'");
  const r = check({ yaml, declare: DECLARE({ newCode: true, fireMatch: 'scrub left ZETA-9001' }) });
  assert.ok(r.problems.some((p) => /literal|source/.test(p)), r.problems.join(' | '));
  // The same literal on old code is allowed: G9 applies to new code only.
  assert.deepEqual(check({ yaml, declare: DECLARE({ newCode: false, fireMatch: 'scrub left ZETA-9001' }) }).problems, []);
});

test('checkVerifyAnswer needs one yaml and one declare per finding unless cannotVerify names the pid', () => {
  const noDeclare = check({ files: [answerFiles()[0]] });
  assert.ok(noDeclare.problems.some((p) => /declare/.test(p)));
  const none = check({ files: [], manifest: { flows: [], cannotVerify: [] } });
  assert.ok(none.problems.some((p) => p.includes(PID) && /no flow/.test(p)));
  const skipped = check({ files: [], manifest: { flows: [], cannotVerify: [{ pid: PID, risk: 'needs a network', why: 'no egress' }] } });
  assert.deepEqual(skipped.problems, []);
});

test('checkVerifyAnswer rejects a file that is not <pid>.yaml or <pid>.declare.json', () => {
  const r = check({ files: [...answerFiles(), { path: 'fixtures/x.json', text: '{}' }] });
  assert.ok(r.problems.some((p) => /fixtures\/x\.json/.test(p)));
  const r2 = check({ files: [{ path: 'other.yaml', text: YAML() }, answerFiles()[1]] });
  assert.ok(r2.problems.some((p) => /other\.yaml/.test(p)));
});

test('checkVerifyAnswer rejects a yaml whose id is not the pid', () => {
  assert.ok(check({ yaml: YAML().replace(`id: ${PID}`, 'id: some-other-id') }).problems.some((p) => /id/.test(p) && p.includes(PID)));
});

test('checkVerifyAnswer enforces one cli step, container profile, retries 0 and a 60 s timeout', () => {
  const two = YAML().replace('limits:', `  - action: {cmd: [node, -e, "1"]}\n    checks:\n      - {text: x, exit: 0}\nlimits:`);
  assert.ok(check({ yaml: two }).problems.some((p) => /one step/.test(p)));
  assert.ok(check({ yaml: YAML().replace('driver: cli', 'driver: hook') }).problems.some((p) => /driver/.test(p)));
  assert.ok(check({ yaml: YAML().replace('profile: container', 'profile: host') }).problems.some((p) => /container/.test(p)));
  assert.ok(check({ yaml: YAML().replace('retries: 0', 'retries: 1') }).problems.some((p) => /retries/.test(p)));
  assert.ok(check({ yaml: YAML().replace('timeoutMs: 60000', `timeoutMs: ${FLOW_TIMEOUT_MAX_MS + 1}`) }).problems.some((p) => /timeoutMs/.test(p)));
});

test('checkVerifyAnswer needs the flow paths to name the cited file', () => {
  assert.ok(check({ yaml: YAML().replace('paths: [src/a.mjs]', 'paths: [src/other.mjs]') }).problems.some((p) => /paths/.test(p) && /src\/a\.mjs/.test(p)));
});

test('checkVerifyAnswer rejects a manifest flow that names an unknown pid', () => {
  const r = check({ manifest: { flows: [...MANIFEST.flows, { id: 'ghost', file: 'ghost.yaml', risk: 'r' }], cannotVerify: [] } });
  assert.ok(r.problems.some((p) => /ghost/.test(p)));
});

// ---------- lintVerifyAnswer (critic major 6: one bad finding must not void its record) ----------

const P1 = 'aaaa000000000001';
const P2 = 'aaaa000000000002';
const P3 = 'aaaa000000000003';
const pairFiles = (pid, over = {}) => [
  { path: `${pid}.yaml`, text: YAML().replace(`id: ${PID}`, `id: ${pid}`) },
  { path: `${pid}.declare.json`, text: DECLARE({ pid, ...over }) },
];
const threeInput = () => {
  const rows = [P1, P2, P3].map((pid) => ROW({ pid }));
  return setOf(rows, [P1, P2, P3].map((id) => FINDING({ id }))).N3;
};
const manifestOf = (pids, cannot = []) => ({ flows: pids.map((p) => ({ id: p, file: `${p}.yaml`, risk: 'r' })), cannotVerify: cannot.map((pid) => ({ pid, risk: 'r', why: 'needs a network' })) });

// Breaks if: one weak fireMatch voids all findings of the record (the old all-or-nothing rule).
test('Fix 6: one bad finding of three: the two clean pairs are kept, the bad pid gets its own problems', () => {
  const files = [...pairFiles(P1), ...pairFiles(P2, { fireMatch: '.*' }), ...pairFiles(P3)];
  const r = lintVerifyAnswer({ files, manifest: manifestOf([P1, P2, P3]), input: threeInput() });
  assert.deepEqual(r.lint.clean, [P1, P3]);
  assert.deepEqual(Object.keys(r.lint.failed), [P2]);
  assert.ok(r.lint.failed[P2].some((p) => p.includes('matches-empty')), r.lint.failed[P2].join('|'));
  assert.deepEqual(r.files.map((f) => f.path).sort(), [`${P1}.declare.json`, `${P1}.yaml`, `${P3}.declare.json`, `${P3}.yaml`]);
  assert.deepEqual(r.fatal, []);
  const declare = JSON.parse(r.files.find((f) => f.path === `${P1}.declare.json`).text);
  assert.equal(declare.row, 'N3', 'the kept declare is the stored C1 declare');
});

// Breaks if: a bad flow (not only a bad declare) is attributed to the record instead of its pid.
test('Fix 6: a flow problem and a missing declare are per-pid problems too', () => {
  const files = [...pairFiles(P1), { path: `${P2}.yaml`, text: YAML().replace(`id: ${PID}`, `id: ${P2}`).replace('driver: cli', 'driver: api') }, ...pairFiles(P3).slice(0, 1)];
  const r = lintVerifyAnswer({ files, manifest: manifestOf([P1, P2, P3]), input: threeInput() });
  assert.deepEqual(r.lint.clean, [P1]);
  assert.ok(r.lint.failed[P2].some((p) => /driver/.test(p)));
  assert.ok(r.lint.failed[P3].some((p) => /no .*declare/.test(p)));
});

// Breaks if: the run stays OK with zero clean pairs.
test('Fix 6: zero clean pairs is fatal and the fatal text names the failed pids', () => {
  const files = [P1, P2, P3].flatMap((p) => pairFiles(p, { fireMatch: '.*' }));
  const r = lintVerifyAnswer({ files, manifest: manifestOf([P1, P2, P3]), input: threeInput() });
  assert.equal(r.lint.clean.length, 0);
  assert.equal(r.files.length, 0);
  assert.equal(r.fatal.length, 1);
  assert.match(r.fatal[0], /no finding passed lint/);
  for (const p of [P1, P2, P3]) assert.ok(r.fatal[0].includes(p));
});

// Breaks if: an answer that lists every finding under cannotVerify is a failure (it costs a repair run and leaves no folder).
test('Fix 6: every finding under cannotVerify is not fatal; the lint record lists them', () => {
  const r = lintVerifyAnswer({ files: [], manifest: manifestOf([], [P1, P2, P3]), input: threeInput() });
  assert.deepEqual(r.fatal, []);
  assert.deepEqual(r.lint.cannotVerify, [P1, P2, P3]);
  assert.deepEqual(r.lint.clean, []);
});

// Breaks if: a stray file or a manifest slip voids the record when a pair is clean.
test('Fix 6: record-level problems (stray file, manifest) are recorded, not fatal, when a pair is clean', () => {
  const files = [...pairFiles(P1), { path: 'notes.md', text: 'x' }];
  const r = lintVerifyAnswer({ files, manifest: manifestOf([P1, 'zzzz']), input: threeInput(), extraProblems: ['the manifest names x.yaml, but no file block wrote it'] });
  assert.deepEqual(r.fatal, []);
  assert.ok(r.lint.record.some((p) => p.includes('notes.md')));
  assert.ok(r.lint.record.some((p) => p.includes('x.yaml')));
  assert.deepEqual(r.lint.clean, [P1]);
});

// ---------- one claim per probe (S11 live smoke) ----------

const TWO_SITES = "const m = await import('/app/src/a.mjs'); const out = m.scrub('a b'); if (out !== '') { console.log('not ok 1 - scrub left ' + out); process.exit(1); } const o2 = m.scrub('c'); if (o2 !== '') { console.log('not ok 1 - scrub left again ' + o2); process.exit(1); } console.log('ok 1');";
const ONE_SITE_TWICE_USED = "const m = await import('/app/src/a.mjs'); const bad = (v) => { console.log('not ok 1 - scrub left ' + v); process.exit(1); }; for (const s of ['a b', 'c d']) { const out = m.scrub(s); if (out !== '') bad(out); } console.log('ok 1');";

// Breaks if: a probe with two "not ok" print sites passes lint. dd440119c9b87d61 had two (the claim and a neighbouring assertion), so base
// and fix failed on the second one and the first live smoke lost a real hit.
test('checkVerifyAnswer rejects a probe with more than one not-ok print site', () => {
  const yaml = YAML().replace(/"const m = await import[^\n]*"\]/, JSON.stringify(TWO_SITES) + ']');
  const r = check({ yaml });
  assert.ok(r.problems.some((p) => /not ok/.test(p) && /one/.test(p) && p.startsWith(`${PID}.yaml`)), r.problems.join('|'));
});

// Breaks if: the lint counts the "not ok 1" text of the checks block, or a helper used twice, as a second print site.
test('checkVerifyAnswer accepts one not-ok print site, including a helper called from a loop, and the checks line that names "not ok 1"', () => {
  const yaml = YAML().replace(/"const m = await import[^\n]*"\]/, JSON.stringify(ONE_SITE_TWICE_USED) + ']').replace('checks:\n', 'checks:\n      - {text: no failing line, "!stdout": "not ok 1"}\n');
  assert.deepEqual(check({ yaml }).problems, []);
});
