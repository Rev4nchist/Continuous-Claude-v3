import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeCheck, filesWanted } from './checks.mjs';

const res = (o = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, files: {}, ...o });
const grade = (check, o) => gradeCheck({ text: 't', ...check }, res(o));
const BAD = { state: 'blocked', reason: 'check_invalid' };

// ---------- exit ----------

test('exit passes on the same code and fails on another (break: compare with the wrong operator)', () => {
  assert.deepEqual(grade({ exit: 0 }, { code: 0 }), { state: 'passed' });
  assert.equal(grade({ exit: 1 }, { code: 0 }).state, 'failed');
});

test('exit fails when the step has no exit code (break: loose == null handling)', () => {
  assert.equal(grade({ exit: 0 }, { code: null }).state, 'failed');
  assert.equal(grade({ exit: 0 }, { code: undefined }).state, 'failed');
});

// ---------- stdout, !stdout ----------

test('stdout passes on a match and fails with a fixed reason on no match', () => {
  assert.equal(grade({ stdout: 'BLOCKED \\(pre-pr-gate\\)' }, { stdout: 'BLOCKED (pre-pr-gate)' }).state, 'passed');
  assert.deepEqual(grade({ stdout: 'abc' }, { stdout: 'xyz' }), { state: 'failed', reason: 'stdout_no_match' });
});

test('stdout anchors match at each line (break: drop the m flag)', () => {
  assert.equal(grade({ stdout: '^not ok ' }, { stdout: 'ok a\nnot ok b' }).state, 'passed');
});

test('!stdout passes only when the regex is absent', () => {
  assert.equal(grade({ '!stdout': 'secret' }, { stdout: 'fine' }).state, 'passed');
  assert.deepEqual(grade({ '!stdout': 'secret' }, { stdout: 'a secret' }), { state: 'failed', reason: 'stdout_matched' });
});

test('a failure reason never holds child output (break: put stdout in the reason)', () => {
  const r = grade({ stdout: 'zzz' }, { stdout: 'SyntaxError: boom' });
  assert.doesNotMatch(JSON.stringify(r), /SyntaxError/);
});

test('an invalid regex is blocked as check_invalid and does not throw (break: build the RegExp outside a guard)', () => {
  assert.deepEqual(grade({ stdout: '(' }, { stdout: 'x' }), BAD);
  assert.deepEqual(grade({ '!stdout': '[' }, { stdout: 'x' }), BAD);
});

// ---------- status, body, !body ----------

test('status compares the number; a result without status is blocked, not failed', () => {
  assert.equal(grade({ status: 200 }, { status: 200 }).state, 'passed');
  assert.equal(grade({ status: 200 }, { status: 500 }).state, 'failed');
  assert.deepEqual(grade({ status: 200 }, {}), BAD);
});

test('body and !body read result.body; a result without body is blocked', () => {
  assert.equal(grade({ body: 'ok' }, { body: 'all ok' }).state, 'passed');
  assert.equal(grade({ body: 'ok' }, { body: 'bad' }).reason, 'body_no_match');
  assert.equal(grade({ '!body': 'err' }, { body: 'fine' }).state, 'passed');
  assert.equal(grade({ '!body': 'err' }, { body: 'err!' }).reason, 'body_matched');
  assert.deepEqual(grade({ body: 'ok' }, { stdout: 'ok' }), BAD);
});

// ---------- file ----------

test('file passes when the key holds text and fails when it holds null', () => {
  assert.equal(grade({ file: 'out.txt' }, { files: { 'out.txt': '' } }).state, 'passed');
  assert.deepEqual(grade({ file: 'out.txt' }, { files: { 'out.txt': null } }), { state: 'failed', reason: 'file_missing' });
});

test('a file that was never collected is blocked, not failed (break: treat undefined as null)', () => {
  assert.deepEqual(grade({ file: 'out.txt' }, { files: {} }), BAD);
});

test('file ~ needs a match and !~ needs no match', () => {
  const files = { 'a.txt': 'hello world' };
  assert.equal(grade({ file: 'a.txt', '~': 'wor' }, { files }).state, 'passed');
  assert.equal(grade({ file: 'a.txt', '~': 'zzz' }, { files }).reason, 'file_no_match');
  assert.equal(grade({ file: 'a.txt', '!~': 'zzz' }, { files }).state, 'passed');
  assert.equal(grade({ file: 'a.txt', '!~': 'hello' }, { files }).reason, 'file_matched');
});

test('file !~ on a missing file fails (break: let an absent file satisfy !~)', () => {
  assert.equal(grade({ file: 'a.txt', '!~': 'x' }, { files: { 'a.txt': null } }).reason, 'file_missing');
});

test('the file key is read as an own property (break: use a plain lookup on a prototype name)', () => {
  assert.deepEqual(grade({ file: 'constructor' }, { files: {} }), BAD);
});

// ---------- json ----------

const jsonCheck = (path, equals, file = 'r.json') => ({ json: { file, path, equals } });

test('json walks a dotted path with array indexes and compares deeply', () => {
  const files = { 'r.json': JSON.stringify({ a: { b: [{ c: 5 }, { c: { d: [1, 2] } }] } }) };
  assert.equal(grade(jsonCheck('a.b[0].c', 5), { files }).state, 'passed');
  assert.equal(grade(jsonCheck('a.b.1.c', { d: [1, 2] }), { files }).state, 'passed');
  assert.deepEqual(grade(jsonCheck('a.b[0].c', 6), { files }), { state: 'failed', reason: 'json_mismatch' });
});

test('json accepts a leading $ (break: remove the $ strip)', () => {
  assert.equal(grade(jsonCheck('$.x', 1), { files: { 'r.json': '{"x":1}' } }).state, 'passed');
});

test('json equals null matches a null value but not a missing path (break: compare with undefined)', () => {
  const files = { 'r.json': '{"a":null}' };
  assert.equal(grade(jsonCheck('a', null), { files }).state, 'passed');
  assert.deepEqual(grade(jsonCheck('b', null), { files }), { state: 'failed', reason: 'json_path_missing' });
});

test('json does not follow inherited keys (break: read obj[key] without hasOwn)', () => {
  const files = { 'r.json': '{}' };
  assert.equal(grade(jsonCheck('constructor.name', 'Object'), { files }).reason, 'json_path_missing');
  assert.equal(grade(jsonCheck('__proto__', {}), { files }).reason, 'json_path_missing');
});

test('json reports a missing file, bad JSON and an uncollected file apart', () => {
  assert.equal(grade(jsonCheck('a', 1), { files: { 'r.json': null } }).reason, 'file_missing');
  assert.equal(grade(jsonCheck('a', 1), { files: { 'r.json': '{oops' } }).reason, 'json_bad');
  assert.deepEqual(grade(jsonCheck('a', 1), { files: {} }), BAD);
});

test('json with an empty path is blocked as check_invalid', () => {
  assert.deepEqual(grade(jsonCheck('', 1), { files: { 'r.json': '{}' } }), BAD);
});

// ---------- unsupported and malformed kinds ----------

test('judge and playwright are blocked as unsupported_in_p0, even for a step that never ran', () => {
  const want = { state: 'blocked', reason: 'unsupported_in_p0' };
  assert.deepEqual(grade({ judge: { artifact: 'a' } }), want);
  assert.deepEqual(grade({ playwright: 'passed' }), want);
  assert.deepEqual(gradeCheck({ text: 't', playwright: 'passed' }, null), want);
});

test('zero kinds, two kinds, an unknown kind and a non-object are blocked as check_invalid', () => {
  assert.deepEqual(grade({}), BAD);
  assert.deepEqual(grade({ exit: 0, stdout: 'x' }), BAD);
  assert.deepEqual(grade({ colour: 'red' }), BAD);
  assert.deepEqual(gradeCheck(null, res()), BAD);
});

// ---------- step-level states ----------

test('a step that never ran gives not_attempted (break: grade against an empty result)', () => {
  assert.equal(gradeCheck({ text: 't', exit: 0 }, null).state, 'not_attempted');
  assert.equal(gradeCheck({ text: 't', '!stdout': 'x' }, undefined).state, 'not_attempted');
});

test('a timed-out step gives not_attempted with reason timeout, even for !stdout and exit (break: ignore timedOut)', () => {
  const timedOut = { timedOut: true, code: 137, stdout: '' };
  assert.deepEqual(grade({ '!stdout': 'bad' }, timedOut), { state: 'not_attempted', reason: 'timeout' });
  assert.deepEqual(grade({ exit: 137 }, timedOut), { state: 'not_attempted', reason: 'timeout' });
});

test('a refused step result blocks every check with the driver reason (break: grade the refused result)', () => {
  const refused = { code: null, reason: 'host_only' };
  assert.deepEqual(grade({ exit: 0 }, refused), { state: 'blocked', reason: 'host_only' });
  assert.deepEqual(grade({ '!stdout': 'x' }, refused), { state: 'blocked', reason: 'host_only' });
});

// ---------- filesWanted ----------

test('filesWanted lists each file and json file once, in order (break: skip json checks)', () => {
  const checks = [
    { text: 'a', file: 'x.txt' },
    { text: 'b', json: { file: 'r.json', path: 'a', equals: 1 } },
    { text: 'c', file: 'x.txt', '~': 'y' },
    { text: 'd', exit: 0 },
  ];
  assert.deepEqual(filesWanted(checks), ['x.txt', 'r.json']);
  assert.deepEqual(filesWanted([]), []);
});
