// Tests for rubric-lint.mjs and the seven rubric files (Part A: no data, no network).
// Each negative test is one change to a valid fixture. It names the check that must catch it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parseVerdict } from '../judge.mjs';
import { BIG_INT_RE, PR_TOKEN_RE, RUBRIC_NAMES, checkDir, checkRubric, parseRubric } from './rubric-lint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const FRONT = {
  rubric: 'demo', version: 1, kind: 'llm', appliesTo: 'finding', gates: true,
  labels: [
    { value: 'good', description: 'A good one.', score: 1 },
    { value: 'bad', description: 'A bad one.', score: 0 },
    { value: 'unsure', description: 'Left out of the mean.', score: null },
  ],
  inputs: ['finding'],
};
const BODY = [
  '## Assess', '- Check one thing.', '## Out of scope', 'Nothing else.', '## Reason contract', 'One value and one reason.',
  '## Examples', '### Pass', '- A good case.', '### Fail', '- A bad case (synthetic).', '',
].join('\n');
const make = (over = {}, body = BODY) => `---\n${JSON.stringify({ ...FRONT, ...over }, null, 2)}\n---\n${body}`;
const without = (k) => { const f = { ...FRONT }; delete f[k]; return `---\n${JSON.stringify(f)}\n---\n${BODY}`; };
const problemsOf = (text, name = 'demo') => checkRubric(parseRubric(text), name);
const has = (problems, code) => problems.some((p) => p.startsWith(code));
const expectCode = (text, code, name) => {
  const problems = problemsOf(text, name);
  assert.ok(has(problems, code), `want a problem starting "${code}", got ${JSON.stringify(problems)}`);
};
const inAssess = (line) => BODY.replace('- Check one thing.', `- ${line}`);
const folder = (names, extra = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rubrics-'));
  made.push(dir);
  for (const n of names) writeFileSync(path.join(dir, `${n}.md`), make({ rubric: n }));
  for (const [n, text] of Object.entries(extra)) writeFileSync(path.join(dir, n), text);
  return dir;
};
// A full-width digit string, built from code points: a typed full-width character can be changed by an editor.
const fullWidth = (digits) => [...digits].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');

test('baseline fixture has no problems (breaks if checkRubric rejects a valid file; guards every negative test)', () => {
  assert.deepEqual(problemsOf(make()), []);
  assert.deepEqual(problemsOf(make().replace(/\n/g, '\r\n')), []);
  assert.deepEqual(problemsOf(make().replace(/\n/g, '\r')), []);
});

test('failure 1: a missing rubric file or an extra .md file is a problem, with or without a case change (breaks if checkDir stops comparing exact names with RUBRIC_NAMES)', () => {
  assert.deepEqual(checkDir(folder(RUBRIC_NAMES)), []);
  const missing = checkDir(folder(RUBRIC_NAMES.slice(1)));
  assert.ok(has(missing, `missing-file: ${RUBRIC_NAMES[0]}`), JSON.stringify(missing));
  const extra = checkDir(folder(RUBRIC_NAMES, { 'other.md': make({ rubric: 'other' }) }));
  assert.ok(has(extra, 'extra-file: other.md'), JSON.stringify(extra));
  const upper = checkDir(folder(RUBRIC_NAMES, { 'Other.MD': make({ rubric: 'other' }) }));
  assert.ok(has(upper, 'extra-file: Other.MD'), JSON.stringify(upper));
  assert.equal(RUBRIC_NAMES.length, 7);
});

test('failure 1b: a symlink entry in the folder is a problem (breaks if checkDir follows or ignores links)', (t) => {
  const dir = folder(RUBRIC_NAMES);
  try { symlinkSync(path.join(dir, `${RUBRIC_NAMES[0]}.md`), path.join(dir, 'link.md')); } catch { t.skip('no right to create a symlink here'); return; }
  assert.ok(has(checkDir(dir), 'symlink: link.md'));
});

test('failure 2a: front matter that is not valid JSON, or has extra text beside the JSON, or is absent, throws (breaks if parseRubric accepts loose front matter)', () => {
  assert.throws(() => parseRubric(`---\n{ not json }\n---\n${BODY}`), /front matter/);
  assert.throws(() => parseRubric(`---\n${JSON.stringify(FRONT)}\nrubric: demo\n---\n${BODY}`), /front matter/);
  assert.throws(() => parseRubric(`---\n[1, 2]\n---\n${BODY}`), /front matter/);
  assert.throws(() => parseRubric(BODY), /front matter/);
  assert.throws(() => parseRubric(`---\n${JSON.stringify(FRONT)}\n${BODY}`), /front matter/);
});

test('failure 2b: each missing required key is a problem (breaks if a key leaves the required list)', () => {
  for (const k of Object.keys(FRONT)) expectCode(without(k), `missing-key: ${k}`);
});

test('failure 2c: an unknown key is a problem and its name is never printed (breaks if checkRubric allows extra keys, or echoes the key text)', () => {
  const problems = problemsOf(make({ ownerSecretKey: 'x' }));
  assert.ok(has(problems, 'unknown-key: position'), JSON.stringify(problems));
  assert.ok(!JSON.stringify(problems).includes('ownerSecretKey'));
});

test('failure 2d: wrong rubric name, version, kind, appliesTo or gates is a problem (breaks if a value check is removed)', () => {
  expectCode(make({ rubric: 'other' }), 'bad-value: rubric');
  expectCode(make({ version: 2 }), 'bad-value: version');
  expectCode(make({ kind: 'model' }), 'bad-value: kind');
  expectCode(make({ appliesTo: 'run' }), 'bad-value: appliesTo');
  expectCode(make({ gates: 'yes' }), 'bad-value: gates');
  expectCode(make({ inputs: 'finding' }), 'bad-value: inputs');
  expectCode(make({ inputs: [1] }), 'bad-value: inputs');
  for (const appliesTo of ['finding', 'miss', 'test', 'record', 'truth']) assert.deepEqual(problemsOf(make({ appliesTo })), [], appliesTo);
});

test('failure 3a: a score outside 0..1 that is not null is a problem (breaks if the range check goes)', () => {
  for (const score of [1.5, -0.1, '0.5']) {
    const labels = [...FRONT.labels.slice(1), { value: 'x', description: 'd', score }];
    expectCode(make({ labels }), 'bad-score');
  }
});

test('failure 3b: two labels with the same value is a problem and the value is never printed (breaks if the uniqueness check goes, or echoes the value)', () => {
  const labels = [...FRONT.labels, { value: 'good', description: 'Again.', score: 0.5 }];
  const problems = problemsOf(make({ labels }));
  assert.ok(has(problems, 'dup-label: labels[3]'), JSON.stringify(problems));
  assert.ok(!JSON.stringify(problems).includes('good'));
});

test('failure 4: an llm or hybrid rubric with no null-score label is a problem; a deterministic one may have one or none (breaks if the null-label rule goes or widens)', () => {
  const scored = FRONT.labels.filter((l) => l.score !== null);
  expectCode(make({ labels: scored }), 'no-null-label');
  expectCode(make({ labels: scored, kind: 'hybrid' }), 'no-null-label');
  assert.deepEqual(problemsOf(make({ labels: scored, kind: 'deterministic' })), []);
  assert.deepEqual(problemsOf(make({ kind: 'deterministic' })), []);
});

test('failure 4b: gates true needs at least one non-null score; gates false does not (breaks if the scored-label rule goes or widens)', () => {
  const allNull = FRONT.labels.map((l) => ({ ...l, score: null }));
  expectCode(make({ labels: allNull, gates: true }), 'no-scored-label');
  expectCode(make({ labels: allNull, gates: true, kind: 'deterministic' }), 'no-scored-label');
  assert.deepEqual(problemsOf(make({ labels: allNull, gates: false })), []);
});

test('failure 5: a missing, misordered or incomplete heading is a problem (breaks if the heading check goes)', () => {
  expectCode(make({}, BODY.replace('## Assess\n', '')), 'headings');
  const swapped = BODY.replace('## Assess\n- Check one thing.\n## Out of scope\nNothing else.\n', '## Out of scope\nNothing else.\n## Assess\n- Check one thing.\n');
  assert.notEqual(swapped, BODY);
  expectCode(make({}, swapped), 'headings');
  expectCode(make({}, BODY.replace('### Fail', '### Other')), 'headings');
  expectCode(make({}, BODY.replace('### Pass', '### Other')), 'headings');
  expectCode(make({}, BODY.replace('### Pass\n- A good case.\n', '### Pass\n')), 'headings');
  expectCode(make({}, BODY.replace('### Fail\n- A bad case (synthetic).\n', '### Fail\n')), 'headings');
});

test('failure 5b: a heading inside a ``` or ~~~ fence is not a heading (breaks if either fence is not tracked)', () => {
  for (const fence of ['```', '~~~']) {
    assert.deepEqual(problemsOf(make({}, BODY.replace('- Check one thing.\n', `- Check one thing.\n${fence}\n## Fake\n${fence}\n`))), [], fence);
  }
});

test('failure 6a: the false-positive label values are exactly the values the real parseVerdict accepts (breaks if a label or judge.mjs changes alone)', () => {
  const { front } = parseRubric(readFileSync(path.join(HERE, 'false-positive.md'), 'utf8'));
  const values = front.labels.map((l) => l.value).sort();
  const accepted = (v) => parseVerdict(JSON.stringify({ sameIssue: 'yes', real: v })).ok;
  for (const v of values) assert.ok(accepted(v), `parseVerdict rejects the label "${v}"`);
  const probes = ['real', 'noise', 'unclear', 'maybe', 'fake', 'true', 'false', 'unknown', ''];
  assert.deepEqual(probes.filter(accepted).sort(), values);
});

test('failure 6b: miss-cause holds the in_diff_logic class (breaks if the class is renamed or dropped)', () => {
  const { front } = parseRubric(readFileSync(path.join(HERE, 'miss-cause.md'), 'utf8'));
  assert.ok(front.labels.some((l) => l.value === 'in_diff_logic'));
});

test('rule 7: every PR reference form in the file is a problem (breaks if PR_TOKEN_RE misses one form)', () => {
  const sha7 = 'a1b2c3d';
  const sha40 = 'ab12'.repeat(10);
  const forms = [
    `see ${'#'}${9001}`, `see pull/${9002}`, `see pulls/${9012}`, `see PR ${9003}`, `see pr ${9004}`, `see PR${9005}`,
    `see PR-${9006}`, `see PR: ${9007}`, `see PR_${9008}`, `see pr_${9123}`, `see issues/${9010}`, `see issue/${9013}`,
    `see pull request ${9011}`, `see ${sha7}`, `see ${sha40}`, `see ${sha7.toUpperCase()}`, `see v2-4-g${sha7}`,
  ];
  for (const token of forms) {
    assert.ok(PR_TOKEN_RE.test(token), `PR_TOKEN_RE misses "${token}"`);
    expectCode(make({}, inAssess(token)), 'pr-token');
  }
  const labels = [{ ...FRONT.labels[0], description: forms[0] }, ...FRONT.labels.slice(1)];
  expectCode(make({ labels }), 'pr-token');
});

test('rule 7: plain words and near misses are not PR tokens (breaks if PR_TOKEN_RE grows too wide)', () => {
  for (const ok of ['effaced and deadbeef', 'the PR title', 'pull request', 'a pull request here', 'version 12', 'abcdef', '1234567', 'e2e test', 'issue tracker']) {
    assert.ok(!PR_TOKEN_RE.test(ok), `PR_TOKEN_RE hits "${ok}"`);
  }
  assert.ok(!PR_TOKEN_RE.global && !BIG_INT_RE.global, 'a global regex keeps state between tests');
});

test('rule 8: an integer of 3 or more digits anywhere in the file, front matter included, is a problem (breaks if the scan stops at the front matter or at a word edge)', () => {
  expectCode(make({}, inAssess(`Check ${1234} items.`)), 'big-int');
  expectCode(make({}, BODY.replace('- A bad case (synthetic).', `- A bad case of ${900} rows.`)), 'big-int');
  expectCode(make({}, inAssess(`Check id${9123} items.`)), 'big-int');
  expectCode(make({}, inAssess(`Check r${9123} items.`)), 'big-int');
  const labels = [{ ...FRONT.labels[0], description: `Range ${1234}.` }, ...FRONT.labels.slice(1)];
  expectCode(make({ labels }), 'big-int');
  assert.deepEqual(problemsOf(make({}, inAssess('Check 12 items, ratio 0.75.'))), []);
});

test('rules 7 and 8 read the text in NFKC form: a full-width integer is a problem (breaks if the scan reads the raw text)', () => {
  expectCode(make({}, inAssess(`Check ${fullWidth('9123')} items.`)), 'big-int');
  expectCode(make({}, inAssess(`see PR ${fullWidth('9123')}`)), 'pr-token');
});

test('no rubric names a model, and the word cursor alone is allowed (breaks if the model-name check goes or grows too wide)', () => {
  for (const name of ['Sonnet', 'opus', 'Haiku', 'Claude', 'GPT', 'Grok']) expectCode(make({}, inAssess(`Ask ${name} to check.`)), 'model-name');
  assert.deepEqual(problemsOf(make({}, inAssess('Move the cursor.'))), []);
});

test('the seven real rubrics hold exactly these label values, appliesTo and gates (breaks if a label, an appliesTo or a gates flag drifts)', () => {
  const want = {
    'missed-bug': { appliesTo: 'truth', gates: true, labels: ['caught', 'partial', 'missed', 'insufficient_evidence'] },
    'miss-cause': { appliesTo: 'miss', gates: false, labels: ['not_in_impact', 'in_impact_not_opened', 'opened_dismissed', 'in_diff_logic', 'policy_difference', 'insufficient_evidence'] },
    'false-positive': { appliesTo: 'finding', gates: true, labels: ['real', 'noise', 'unclear'] },
    severity: { appliesTo: 'finding', gates: true, labels: ['exact', 'off_by_one', 'inverted', 'insufficient_evidence'] },
    citation: { appliesTo: 'finding', gates: true, labels: ['valid', 'invalid', 'insufficient_evidence'] },
    'context-reach': { appliesTo: 'record', gates: false, labels: ['ratio'] },
    'test-value': { appliesTo: 'test', gates: true, labels: ['e2e_behaviour', 'isolated_justified', 'tautological', 'insufficient_evidence'] },
  };
  assert.deepEqual(Object.keys(want).sort(), [...RUBRIC_NAMES].sort());
  for (const [name, w] of Object.entries(want)) {
    const { front } = parseRubric(readFileSync(path.join(HERE, `${name}.md`), 'utf8'));
    assert.deepEqual(front.labels.map((l) => l.value), w.labels, name);
    assert.equal(front.appliesTo, w.appliesTo, name);
    assert.equal(front.gates, w.gates, name);
  }
});

test('the seven real rubric files have no problems (breaks if any file drifts from the format)', () => {
  assert.deepEqual(checkDir(HERE), []);
  for (const name of RUBRIC_NAMES) {
    const problems = checkRubric(parseRubric(readFileSync(path.join(HERE, `${name}.md`), 'utf8')), name);
    assert.deepEqual(problems, [], `${name}.md`);
  }
});
