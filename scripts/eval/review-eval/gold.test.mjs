// Tests for gold.mjs (the gold row schema, the validator and the loader). Every test names the source change that would break it.
// All values are made up: no real gold or holdout PR id appears here.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { LINK_TYPES } from './linktype.mjs';
import { GOLD_DIR, GOLD_ROW, GoldError, SEVERITIES, SOURCES, SPLITS, SUITES, loadGold, validateRow } from './gold.mjs';
import * as goldModule from './gold.mjs';

const sha = (c) => c.repeat(40);
// Built with fromCharCode: a typed escape for this character has been turned into the raw character before.
const BOM = String.fromCharCode(0xfeff);
const row = (over = {}) => ({
  id: 'g-test-1', source: 'B', suite: 'capability', split: 'dev',
  target: { pr: 9001, round: 1, sha40: sha('a') }, file: 'src/made-up.mjs', line: 12,
  severity: 'major', linkType: 'same-file',
  labels: [{ by: 'agent-claude', verdict: 'real', judgeVersion: 'j-test-1' }],
  provenance: { note: 'made-up fixture' }, ...over,
});
const without = (k) => { const r = row(); delete r[k]; return r; };
const starts = (problems, prefix) => problems.some((p) => p.startsWith(prefix));
const expectProblem = (over, prefix) => {
  const problems = validateRow(row(over));
  assert.ok(starts(problems, prefix), `want a problem starting "${prefix}", got ${JSON.stringify(problems)}`);
};

const made = [];
const folder = (files = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gold-'));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
};
const loadErr = (dir) => { try { loadGold(dir); } catch (e) { return e; } return null; };
const ctlErr = (dir) => { try { goldModule.loadCleanControls(dir); } catch (e) { return e; } return null; };
const cRow = (over = {}) => row({ source: 'C', target: { repo: 'made-up-org/made-up-repo', pr: 9001, round: 1, sha40: sha('a') }, ...over });
const control = (over = {}) => ({
  id: 'c-test-1', split: 'dev', target: { pr: 9002, round: 1, sha40: sha('d') }, provenance: { note: 'made-up fixture' }, ...over,
});
const ctlFile = (body) => folder({ 'clean-controls.json': body });
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('SOURCES, SUITES and SPLITS are fixed lists in order (breaks if a value is renamed, added or removed)', () => {
  assert.deepEqual(SOURCES, ['A', 'B', 'C', 'CR']);
  assert.deepEqual(SUITES, ['regression', 'capability']);
  assert.deepEqual(SPLITS, ['dev', 'holdout', 'reserve']);
});

test('SLICES is the frozen list ["security"] (breaks if a slice value is added, renamed or the list is left unfrozen)', () => {
  assert.deepEqual(goldModule.SLICES, ['security']);
  assert.ok(Object.isFrozen(goldModule.SLICES));
});

test('SEVERITIES is the match.mjs fold targets without info (breaks if SEV changes its fold targets or the info filter goes)', () => {
  assert.deepEqual(SEVERITIES, ['critical', 'major', 'minor']);
});

test('a valid PR-form row has no problems (breaks if the validator rejects a valid row; guards every failure fixture)', () => {
  assert.deepEqual(validateRow(row()), []);
});

test('a valid range-form row has no problems, with sha or ref sides (breaks if the range form is not accepted or a ref side is refused)', () => {
  assert.deepEqual(validateRow(row({ target: { range: `${sha('b')}..${sha('c')}` } })), []);
  assert.deepEqual(validateRow(row({ target: { range: `refs/eval/seed/s1..${sha('c')}` } })), []);
});

test('optional parts are valid: no line, empty labels, a label with no judgeVersion (breaks if line, an empty labels array or judgeVersion becomes required)', () => {
  const noLine = row(); delete noLine.line;
  assert.deepEqual(validateRow(noLine), []);
  assert.deepEqual(validateRow(row({ labels: [] })), []);
  assert.deepEqual(validateRow(row({ labels: [{ by: 'dave', verdict: 'noise' }] })), []);
});

test('MAP bad source: D and a lowercase a are refused (breaks if the source check is removed or made case-insensitive)', () => {
  expectProblem({ source: 'D' }, 'source:');
  expectProblem({ source: 'a' }, 'source:');
});

test('MAP bad suite: security is refused (breaks if the suite check is removed or widened)', () => {
  expectProblem({ suite: 'security' }, 'suite:');
});

test('MAP bad split: test is refused (breaks if the split check is removed)', () => {
  expectProblem({ split: 'test' }, 'split:');
});

test('MAP target with neither form is refused and names both forms (breaks if the neither-form branch is removed)', () => {
  for (const target of [{}, { foo: 1 }]) {
    const hit = validateRow(row({ target })).find((p) => p.startsWith('target:'));
    assert.ok(hit, `no target problem for ${JSON.stringify(target)}`);
    assert.match(hit, /pr, round, sha40/);
    assert.match(hit, /range/);
  }
});

test('MAP label with no by is refused (breaks if by is no longer required)', () => {
  expectProblem({ labels: [{ verdict: 'real' }] }, 'labels[0].by:');
});

test('a target with both forms is refused (breaks if the exactly-one rule becomes at-least-one)', () => {
  expectProblem({ target: { pr: 9001, round: 1, sha40: sha('a'), range: `${sha('b')}..${sha('c')}` } }, 'target:');
});

test('a partial PR form reports the missing key (breaks if the PR form stops checking all three keys)', () => {
  expectProblem({ target: { pr: 9001, sha40: sha('a') } }, 'target.round:');
});

test('pr and round must be positive integers, not strings (breaks if the integer check is removed or Number() coercion is added)', () => {
  for (const pr of [0, -1, 1.5, '9001']) expectProblem({ target: { pr, round: 1, sha40: sha('a') } }, 'target.pr:');
  expectProblem({ target: { pr: 9001, round: 0, sha40: sha('a') } }, 'target.round:');
});

test('sha40 must be 40 lowercase hex (breaks if the sha regex loses its anchors or its case rule)', () => {
  for (const s of [sha('a').toUpperCase(), 'a'.repeat(39), 'a'.repeat(41)]) {
    expectProblem({ target: { pr: 9001, round: 1, sha40: s } }, 'target.sha40:');
  }
});

test('a bad range is refused (breaks if the split, the three-dot test or a side regex is loosened)', () => {
  const bad = [`${sha('b')}.${sha('c')}`, `${sha('b')}...${sha('c')}`, `..${sha('c')}`, `${'d'.repeat(7)}..${sha('c')}`, 'main..HEAD', `${sha('b')} ..${sha('c')}`];
  for (const range of bad) expectProblem({ target: { range } }, 'target.range:');
});

test('a target that is null, an array or a string is refused (breaks if the object guard is removed)', () => {
  for (const target of [null, [], 'x']) expectProblem({ target }, 'target: expected an object');
});

test('unknown keys are refused at row, target and label level (breaks if the key check is removed at any of the three levels)', () => {
  expectProblem({ spilt: 'dev' }, 'row: unknown field "spilt"');
  expectProblem({ target: { pr: 9001, round: 1, sha40: sha('a'), base: 'x' } }, 'target: unknown field "base"');
  expectProblem({ labels: [{ by: 'dave', verdict: 'real', score: 1 }] }, 'labels[0]: unknown field "score"');
});

test('an unknown key name is printed JSON-quoted and capped at 40 characters (breaks if the cap or the quoting is removed)', () => {
  const long = 'k'.repeat(100);
  const hit = validateRow(row({ [long]: 1, 'a"b\nc': 2 })).filter((p) => p.startsWith('row: unknown field'));
  assert.equal(hit.length, 2, JSON.stringify(hit));
  assert.ok(hit.every((p) => !p.includes('k'.repeat(41))), 'key longer than 40 characters printed');
  assert.ok(hit.some((p) => p === `row: unknown field ${JSON.stringify('k'.repeat(40))}`), JSON.stringify(hit));
  assert.ok(hit.some((p) => p === `row: unknown field ${JSON.stringify('a"b\nc')}`), JSON.stringify(hit));
});

test('source, suite and split quote the bad value (breaks if the quote of a non-answer value is dropped)', () => {
  assert.ok(validateRow(row({ source: 'D' })).includes('source: "D" is not one of A, B, C, CR'));
  assert.ok(validateRow(row({ suite: 'security' })).includes('suite: "security" is not one of regression, capability'));
  assert.ok(validateRow(row({ split: 'test' })).includes('split: "test" is not one of dev, holdout, reserve'));
});

// A problem names the field and the expected shape. It never prints the bad value of an answer field.
const MARK = 'zqmarker7731';
const noEcho = (over, path, marker = MARK) => {
  const problems = validateRow(row(over));
  const hit = problems.filter((p) => p.startsWith(`${path}:`));
  assert.ok(hit.length, `no problem for ${path}: ${JSON.stringify(problems)}`);
  assert.ok(!problems.join('\n').includes(marker), `value "${marker}" printed: ${JSON.stringify(problems)}`);
  return hit;
};
const lab = (over) => ({ labels: [{ by: 'dave', verdict: 'real', ...over }] });

test('labels[].verdict never prints the bad value and states the type and the expected set (breaks if quote() returns to checkEnum for verdict)', () => {
  const hit = noEcho(lab({ verdict: MARK }), 'labels[0].verdict');
  assert.equal(hit[0], 'labels[0].verdict: a string that is not one of real, noise, unclear');
  noEcho(lab({ verdict: 'Real' }), 'labels[0].verdict', '"Real"');
});

test('labels[].by never prints the bad value (breaks if quote() returns to the by check)', () => {
  const hit = noEcho(lab({ by: `Bad ${MARK}` }), 'labels[0].by');
  assert.match(hit[0], /^labels\[0\]\.by: a string, expected /);
});

test('labels[].judgeVersion never prints the bad value (breaks if quote() returns to the judgeVersion check)', () => {
  noEcho(lab({ judgeVersion: ` ${MARK} ` }), 'labels[0].judgeVersion');
  noEcho(lab({ judgeVersion: { deep: MARK } }), 'labels[0].judgeVersion');
});

test('severity never prints the bad value (breaks if quote() returns to the severity check)', () => {
  const hit = noEcho({ severity: MARK }, 'severity');
  assert.equal(hit[0], 'severity: a string that is not one of critical, major, minor');
});

test('linkType never prints the bad value (breaks if quote() returns to the linkType check)', () => {
  noEcho({ linkType: MARK }, 'linkType');
});

test('target.pr and target.round never print the bad value (breaks if quote() returns to the integer check)', () => {
  const hit = noEcho({ target: { pr: MARK, round: 1, sha40: sha('a') } }, 'target.pr');
  assert.equal(hit[0], 'target.pr: a string, expected a positive integer');
  noEcho({ target: { pr: 7731555.5, round: 1, sha40: sha('a') } }, 'target.pr', '7731555');
  noEcho({ target: { pr: 9001, round: -7731555, sha40: sha('a') } }, 'target.round', '7731555');
});

test('target.sha40 never prints the bad value (breaks if quote() returns to the sha40 check)', () => {
  noEcho({ target: { pr: 9001, round: 1, sha40: MARK } }, 'target.sha40');
});

test('target.range never prints the bad value (breaks if quote() returns to the range check)', () => {
  noEcho({ target: { range: `${MARK}..${sha('c')}` } }, 'target.range');
});

test('file never prints the bad value (breaks if quote() returns to the file check)', () => {
  noEcho({ file: `../${MARK}.mjs` }, 'file');
  noEcho({ file: `${MARK}\\x.mjs` }, 'file');
});

test('line never prints the bad value (breaks if quote() returns to the line check)', () => {
  noEcho({ line: MARK }, 'line');
  noEcho({ line: -7731555 }, 'line', '7731555');
});

test('id never prints the bad value (breaks if quote() returns to the id check)', () => {
  noEcho({ id: `${MARK} x` }, 'id');
});

test('provenance never prints the bad value, for a string, an array or an empty object (breaks if quote() returns to the provenance check)', () => {
  noEcho({ provenance: MARK }, 'provenance');
  noEcho({ provenance: [MARK] }, 'provenance');
  noEcho({ provenance: {} }, 'provenance');
});

test('every required key reports "required" when deleted (breaks if a required key becomes optional)', () => {
  for (const k of GOLD_ROW.required) {
    assert.ok(starts(validateRow(without(k)), `${k}: required`), `${k} not required`);
  }
});

test('severity is exact lowercase critical, major or minor; nothing is folded (breaks if severity is folded or lowercased instead of refused)', () => {
  for (const severity of ['Major', 'nitpick', 'trivial', 'info']) expectProblem({ severity }, 'severity:');
  for (const severity of SEVERITIES) assert.deepEqual(validateRow(row({ severity })), []);
});

test('linkType takes only the LINK_TYPES values (breaks if gold.mjs stops using LINK_TYPES)', () => {
  expectProblem({ linkType: 'cross-file' }, 'linkType:');
  for (const linkType of LINK_TYPES) assert.deepEqual(validateRow(row({ linkType })), []);
});

test('line must be a positive integer when present, and null is refused (breaks if the integer check is removed or null is allowed)', () => {
  for (const line of [0, -1, 2.5, null, '3']) expectProblem({ line }, 'line:');
});

test('an unsafe integer is refused for line, pr and round (breaks if posInt goes back to Number.isInteger)', () => {
  expectProblem({ line: 1e21 }, 'line:');
  expectProblem({ target: { pr: 2 ** 53, round: 1, sha40: sha('a') } }, 'target.pr:');
  expectProblem({ target: { pr: 9001, round: 1e21, sha40: sha('a') } }, 'target.round:');
});

test('file must be a clean repo-relative POSIX path (breaks if one path rule is dropped)', () => {
  const bad = ['', ' a.mjs', '/abs.mjs', 'C:/x.mjs', 'a\\b.mjs', '../x.mjs', 'a/../b.mjs',
    './x.mjs', 'a//b.mjs', 'src/', 'src/./a.mjs', '.', 'a/b\nc.mjs', 'a\tb.mjs', 'a\u0000b.mjs'];
  for (const file of bad) expectProblem({ file }, 'file:');
});

test('a dot-leading name is a valid file path (breaks if the segment rule refuses every dot-leading segment)', () => {
  for (const file of ['.claude/x.mjs', '.eslintrc.json', 'a/.hidden/b.mjs', 'a/..b/c.mjs']) {
    assert.deepEqual(validateRow(row({ file })), [], file);
  }
});

test('a row with an inherited id, or a Date, Map or class instance, is refused (breaks if isPlain accepts any non-array object)', () => {
  const inherited = Object.create({ id: 'g-inherited' });
  Object.assign(inherited, without('id'));
  assert.deepEqual(validateRow(inherited), ['row: expected an object']);
  assert.deepEqual(validateRow(new Date()), ['row: expected an object']);
  for (const target of [new Map(), new Date(), new (class T {})()]) expectProblem({ target }, 'target: expected an object');
  assert.deepEqual(validateRow(Object.assign(Object.create(null), row())), []);
});

test('id must be a string with no whitespace that starts alphanumeric (breaks if the id regex or the string check is removed)', () => {
  for (const id of ['', 'a b', ' x', 5]) expectProblem({ id }, 'id:');
});

test('label rules: array, object, verdict, by and judgeVersion (breaks if any one label rule is removed)', () => {
  expectProblem({ labels: 'x' }, 'labels:');
  expectProblem({ labels: ['x'] }, 'labels[0]:');
  expectProblem({ labels: [{ by: 'dave', verdict: 'defect' }] }, 'labels[0].verdict:');
  for (const by of ['', 'Dave']) expectProblem({ labels: [{ by, verdict: 'real' }] }, 'labels[0].by:');
  expectProblem({ labels: [{ by: 'dave', verdict: 'real', judgeVersion: '' }] }, 'labels[0].judgeVersion:');
});

test('provenance must be a non-empty plain object (breaks if the non-empty plain-object rule is loosened)', () => {
  assert.ok(starts(validateRow(without('provenance')), 'provenance:'));
  for (const provenance of [null, [], {}, 'x']) expectProblem({ provenance }, 'provenance:');
});

test('a non-object row returns the one row problem and never throws (breaks if the guard is removed and a property read throws)', () => {
  for (const bad of [null, [], 'x', 5]) assert.deepEqual(validateRow(bad), ['row: expected an object']);
});

test('the validator reports every problem, not only the first (breaks if it returns at the first problem)', () => {
  const problems = validateRow(row({ source: 'D', split: 'test' }));
  assert.ok(starts(problems, 'source:') && starts(problems, 'split:'), JSON.stringify(problems));
});

test('loadGold of a missing folder is empty, not an error (breaks if a missing folder throws)', () => {
  assert.deepEqual(loadGold(path.join(os.tmpdir(), 'no-such-dir-gold', 'gold')), { rows: [], files: [], skipped: [] });
});

test('loadGold reads files in plain code-unit order (breaks if the explicit sort is removed: NTFS lists a before B)', () => {
  const dir = folder({ 'a.json': [row({ id: 'g-a' })], 'B.json': [row({ id: 'g-b' })] });
  const out = loadGold(dir);
  assert.deepEqual(out.files, ['B.json', 'a.json']);
  assert.deepEqual(out.rows.map((r) => r.id), ['g-b', 'g-a']);
});

test('the two non-row files are skipped unread (breaks if NON_ROW_FILES is ignored and they are validated as rows)', () => {
  const dir = folder({ 'escape-baseline.json': [{ band: 'x' }], 'clean-controls.json': { prs: [] } });
  const out = loadGold(dir);
  assert.deepEqual(out.skipped, ['clean-controls.json', 'escape-baseline.json']);
  assert.deepEqual(out.rows, []);
});

test('a file that is not JSON throws GoldError naming the file (breaks if the parse error is not caught and named)', () => {
  const err = loadErr(folder({ 'bad.json': '{nope' }));
  assert.ok(err instanceof GoldError);
  assert.match(err.message, /bad\.json: not valid JSON/);
});

test('a parse error never prints file content, only the position (breaks if e.message is put back into the problem)', () => {
  const body = `[{"verdict": ${MARK}word}]`;
  const err = loadErr(folder({ 'bad.json': body }));
  assert.ok(err instanceof GoldError);
  assert.ok(!err.message.includes(MARK), err.message);
  assert.ok(err.problems.every((p) => !p.includes('verdict')), err.message);
  assert.match(err.problems[0], /^bad\.json: not valid JSON( at position \d+( \(line \d+ column \d+\))?)?$/);
  const late = loadErr(folder({ 'late.json': `[{"a": 1}, {"b": 2} ${MARK}]` }));
  assert.ok(!late.message.includes(MARK), late.message);
});

test('a file that starts with a BOM is reported and not stripped (breaks if the BOM check is removed or the BOM is stripped)', () => {
  const err = loadErr(folder({ 'bom.json': `${BOM}${JSON.stringify([row()])}` }));
  assert.ok(err instanceof GoldError);
  assert.deepEqual(err.problems, ['bom.json: has a BOM']);
});

test('a read error is reported as cannot read with its code, not as bad JSON (breaks if readFileSync goes back into the JSON try)', () => {
  // readRowFile is no longer exported: a directory named clean-controls.json reaches the same internal reader.
  const dir = folder();
  mkdirSync(path.join(dir, 'clean-controls.json'));
  assert.deepEqual(ctlErr(dir).problems, ['clean-controls.json: cannot read (EISDIR)']);
});

test('a symlinked .json file is reported and not followed (breaks if links are dropped silently or followed)', (t) => {
  const outside = folder({ 'real.json': [row()] });
  const dir = folder();
  try {
    symlinkSync(path.join(outside, 'real.json'), path.join(dir, 'link.json'), 'file');
  } catch (e) {
    t.skip(`this account cannot create a file symlink (${e.code})`);
    return;
  }
  const err = loadErr(dir);
  assert.ok(err instanceof GoldError, 'a symlinked row file was dropped silently');
  assert.deepEqual(err.problems, ['link.json: is a link, not a file']);
});

test('a file with one row object instead of an array is refused (breaks if a top-level object is accepted)', () => {
  assert.throws(() => loadGold(folder({ 'one.json': row() })), /one\.json: expected a JSON array/);
});

test('a row problem carries the file name and row index (breaks if the file or index prefix is lost)', () => {
  const err = loadErr(folder({ 'x.json': [row(), row({ id: 'g-2', split: 'test' })] }));
  assert.ok(err instanceof GoldError);
  assert.ok(starts(err.problems, 'x.json[1] split:'), JSON.stringify(err.problems));
});

test('a duplicate id across files is refused and names the first (breaks if the cross-file duplicate check is removed)', () => {
  const dir = folder({ 'a.json': [row()], 'b.json': [row()] });
  assert.throws(() => loadGold(dir), /b\.json\[0\] id: duplicate of a\.json\[0\]/);
});

test('other files and a folder named like a row file are ignored (breaks if the isFile check or the .json filter is removed)', () => {
  const dir = folder({ 'notes.md': '# notes', 'x.jsonl': '{bad' });
  mkdirSync(path.join(dir, 'sub.json'));
  writeFileSync(path.join(dir, 'sub.json', 'y.json'), '{nope');
  assert.deepEqual(loadGold(dir), { rows: [], files: [], skipped: [] });
});

test('an empty array is a valid row file (breaks if an empty array is treated as an error)', () => {
  const out = loadGold(folder({ 'e.json': [] }));
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.files, ['e.json']);
});

test('two bad files give one GoldError naming both (breaks if the loader throws at the first file)', () => {
  const err = loadErr(folder({ 'a.json': '{nope', 'b.json': { not: 'an array' } }));
  assert.ok(err instanceof GoldError);
  assert.equal(err.name, 'GoldError');
  assert.ok(starts(err.problems, 'a.json:') && starts(err.problems, 'b.json:'), JSON.stringify(err.problems));
});

test('GOLD_DIR is the gold folder beside the harness, and nothing is read there (breaks if the default folder moves)', () => {
  assert.ok(GOLD_DIR.endsWith(path.join('review-eval', 'gold')));
});

// --- Contract gold-schema-seat-answer.md rule 3: source CR and the optional slice ---

test('rule 3: source CR is valid and D is still refused (breaks if CR is removed from SOURCES or the list is widened)', () => {
  assert.deepEqual(validateRow(row({ source: 'CR' })), []);
  expectProblem({ source: 'cr' }, 'source:');
  expectProblem({ source: 'D' }, 'source:');
});

test('rule 3: slice is optional; security is valid; any other value or type is refused (breaks if slice becomes required or its value set widens)', () => {
  assert.deepEqual(validateRow(row()), [], 'a row with no slice');
  assert.deepEqual(validateRow(row({ slice: 'security' })), []);
  for (const slice of ['Security', 'perf', '', null, 5, ['security'], {}]) expectProblem({ slice }, 'slice:');
});

test('rule 3: a bad slice quotes a string and never prints an object or array (breaks if checkEnum quotes a non-string answer)', () => {
  assert.ok(validateRow(row({ slice: 'perf' })).includes('slice: "perf" is not one of security'));
  noEcho({ slice: { deep: MARK } }, 'slice');
  noEcho({ slice: [MARK] }, 'slice');
  noEcho({ source: { deep: MARK } }, 'source');
});

test('review fix 1: a long bad source, suite, split or slice string is quoted through the 40-character cap (breaks if checkEnum quotes the full string)', () => {
  const long = 'z'.repeat(100);
  for (const field of ['source', 'suite', 'split', 'slice']) {
    const hit = validateRow(row({ [field]: long })).filter((p) => p.startsWith(`${field}:`));
    assert.equal(hit.length, 1, field);
    assert.ok(hit[0].includes('z'.repeat(40)), `${field}: the capped text is missing: ${hit[0]}`);
    assert.ok(!hit[0].includes('z'.repeat(41)), `${field}: more than 40 characters printed: ${hit[0]}`);
  }
});

test('rule 3: suite keeps two values and capability and regression stay valid (breaks if a third suite is added)', () => {
  for (const suite of SUITES) assert.deepEqual(validateRow(row({ suite })), []);
});

// --- Contract rule 5: target.repo ---

test('rule 5: a source C row with a repo is valid (breaks if repo is not an allowed key of the PR form)', () => {
  assert.deepEqual(validateRow(cRow()), []);
});

test('rule 5: a source C row with no repo is refused (breaks if repo stops being required for C)', () => {
  const target = { pr: 9001, round: 1, sha40: sha('a') };
  const hit = validateRow(cRow({ target })).find((p) => p.startsWith('target.repo:'));
  assert.equal(hit, 'target.repo: required when source is C');
});

test('rule 5: repo is refused for source A, B and CR and its value is not printed (breaks if repo is accepted for a non-C source)', () => {
  for (const source of ['A', 'B', 'CR']) {
    const target = { repo: `${MARK}/made-up`, pr: 9001, round: 1, sha40: sha('a') };
    const hit = noEcho({ source, target }, 'target.repo');
    assert.equal(hit.length, 1, `${source}: ${JSON.stringify(hit)}`);
    assert.match(hit[0], /refused/);
  }
});

test('rule 5: a bad repo shape is refused for source C and the value is not printed (breaks if one repo rule is dropped)', () => {
  const bad = ['nohash', 'a/b/c', 'a /b', ' a/b', 'a/b ', '/b', 'a/', '/', '', 'a/b\nc', 'a\tb/c', 5, null, ['a/b'], { x: 1 }];
  for (const repo of bad) {
    const hit = validateRow(cRow({ target: { repo, pr: 9001, round: 1, sha40: sha('a') } })).filter((p) => p.startsWith('target.repo:'));
    assert.equal(hit.length, 1, `${JSON.stringify(repo)}: ${JSON.stringify(hit)}`);
    assert.match(hit[0], /expected owner\/name/);
  }
  noEcho(cRow({ target: { repo: `${MARK} x/y`, pr: 9001, round: 1, sha40: sha('a') } }), 'target.repo');
});

test('rule 5: owner/name accepts lower-case dots, dashes and underscores inside a part (breaks if the repo check is stricter than one slash, no space, two parts)', () => {
  for (const repo of ['a/b', 'my-org.x/repo_name.js']) {
    assert.deepEqual(validateRow(cRow({ target: { repo, pr: 9001, round: 1, sha40: sha('a') } })), [], repo);
  }
});

const repoHits = (repo) => validateRow(cRow({ target: { repo, pr: 9001, round: 1, sha40: sha('a') } })).filter((p) => p.startsWith('target.repo:'));

test('review fix 4: repo parts are letters, digits, dot, dash and underscore only, and never "." or ".." (breaks if REPO_RE goes back to any non-space character)', () => {
  const bad = ['a/..', '../b', './b', 'a/.', 'a/b\u0000', 'a\u0000/b', 'a/b\u007f', 'a@b/c', 'a/b@c', 'org/re po', 'a/b:c'];
  for (const repo of bad) assert.equal(repoHits(repo).length, 1, JSON.stringify(repo));
});

test('seat B2: one repo has one key: upper case, a .git suffix, and a dot or dash at the start or end of a part are refused (breaks if REPO_RE or repoOk accepts one of these forms again)', () => {
  const bad = ['Org/repo', 'org/Repo', 'ORG/REPO', 'org/repo.git', 'org/x.git', 'org/.git', '.org/repo', 'org-/repo', 'org/-repo', 'org/repo.', '-org/repo', 'org./repo', 'org/..b'];
  for (const repo of bad) {
    const hit = repoHits(repo);
    assert.equal(hit.length, 1, `${JSON.stringify(repo)} was accepted`);
    assert.match(hit[0], /lower-case/);
  }
});

test('seat B2: lower-case parts with inner dots, dashes and underscores stay valid (breaks if the part rule is stricter than start and end)', () => {
  for (const repo of ['org-1/repo.name_x', 'a/b', 'a_/_b', 'org/repo.github', 'org/my.git.x', 'o.r-g/r-e.p_o']) {
    assert.deepEqual(validateRow(cRow({ target: { repo, pr: 9001, round: 1, sha40: sha('a') } })), [], repo);
  }
});

test('rule 5: the range form never has repo (breaks if repo is allowed beside range)', () => {
  expectProblem({ target: { repo: 'a/b', range: `${sha('b')}..${sha('c')}` } }, 'target: unknown field "repo"');
});

test('rule 5 DECISION: source C with the range form is refused with one target problem (breaks if C may use the range form, which has no repo)', () => {
  const problems = validateRow(cRow({ target: { range: `${sha('b')}..${sha('c')}` } }));
  assert.deepEqual(problems, ['target: source C needs the PR form with repo; the range form has no repo']);
});

test('rule 5 DECISION: a missing or invalid source adds no repo-rule problem, but a repo that is present still gets its shape checked (breaks if the repo rule runs on an unknown source)', () => {
  const target = { repo: 'a/b', pr: 9001, round: 1, sha40: sha('a') };
  assert.deepEqual(validateRow(row({ source: 'D', target })), ['source: "D" is not one of A, B, C, CR']);
  const noSource = row({ target }); delete noSource.source;
  assert.deepEqual(validateRow(noSource), ['source: required']);
  const badShape = validateRow(row({ source: 'D', target: { ...target, repo: 'nohash' } }));
  assert.ok(starts(badShape, 'target.repo: ') && starts(badShape, 'source:') && badShape.length === 2, JSON.stringify(badShape));
  assert.deepEqual(validateRow(row({ source: 'D' })), ['source: "D" is not one of A, B, C, CR'], 'no repo and bad source: no repo problem');
});

test('rule 5: a target with only repo has neither form (breaks if repo counts as a PR-form key)', () => {
  expectProblem({ source: 'C', target: { repo: 'a/b' } }, 'target: expected exactly one');
});

// --- Contract rule 1 and rule 4: no code change; pin the required keys by name ---

test('rule 1: suite and linkType are required on every row, by name (breaks if either is dropped from GOLD_ROW.required)', () => {
  assert.ok(starts(validateRow(without('suite')), 'suite: required'));
  assert.ok(starts(validateRow(without('linkType')), 'linkType: required'));
});

test('rule 4: a label with no judgeVersion is valid, a present one must be a clean string (breaks if judgeVersion becomes required)', () => {
  expectProblem({ labels: [{ by: 'dave', verdict: 'real', judgeVersion: 5 }] }, 'labels[0].judgeVersion:');
});

// --- Contract rule 2: loadCleanControls ---

test('rule 2: a valid clean-controls file loads in file order (breaks if the order changes or a valid control is refused)', () => {
  const a = control({ id: 'c-a' });
  const b = control({ id: 'c-b', split: 'holdout', target: { range: `${sha('b')}..${sha('c')}` }, provenance: { why: 'made up' } });
  const out = goldModule.loadCleanControls(ctlFile([b, a]));
  assert.deepEqual(out, [b, a]);
});

test('rule 2: a missing folder or a missing file gives an empty list, no throw (breaks if a missing file throws)', () => {
  assert.deepEqual(goldModule.loadCleanControls(path.join(os.tmpdir(), 'no-such-dir-gold', 'gold')), []);
  assert.deepEqual(goldModule.loadCleanControls(folder({ 'gold-b.json': [row()] })), []);
});

test('review fix 2: a regular file where the gold folder should be is a GoldError in both loaders (breaks if ENOTDIR is treated as a missing folder or escapes as a raw Error)', () => {
  const file = path.join(folder({ 'plain.txt': 'x' }), 'plain.txt');
  const controls = ctlErr(file);
  assert.ok(controls instanceof GoldError, `loadCleanControls: ${controls}`);
  assert.deepEqual(controls.problems, ['clean-controls.json: cannot read (ENOTDIR)']);
  const gold = loadErr(file);
  assert.ok(gold instanceof GoldError, `loadGold: ${gold}`);
  assert.deepEqual(gold.problems, ['plain.txt: not a folder']);
});

test('rule 2: loadCleanControls reads clean-controls.json only (breaks if it reads other .json files in the folder)', () => {
  assert.deepEqual(goldModule.loadCleanControls(folder({ 'gold-b.json': '{nope', 'escape-baseline.json': '{nope' })), []);
});

test('rule 2: a bad split is refused with the file and row index (breaks if the control split check is removed)', () => {
  const err = ctlErr(ctlFile([control(), control({ id: 'c-2', split: 'test' })]));
  assert.ok(err instanceof GoldError);
  assert.deepEqual(err.problems, ['clean-controls.json[1] split: "test" is not one of dev, holdout, reserve']);
});

test('rule 2: a control target with neither form is refused (breaks if the control target uses no target check)', () => {
  const err = ctlErr(ctlFile([control({ target: { foo: 1 } })]));
  assert.ok(starts(err.problems, 'clean-controls.json[0] target:'), JSON.stringify(err.problems));
  assert.match(err.problems[0], /range/);
});

test('rule 2: a control target with a bad sha or a bad range is refused (breaks if the control uses a looser target check)', () => {
  assert.ok(starts(ctlErr(ctlFile([control({ target: { pr: 9002, round: 1, sha40: 'abc' } })])).problems, 'clean-controls.json[0] target.sha40:'));
  assert.ok(starts(ctlErr(ctlFile([control({ target: { range: 'main..HEAD' } })])).problems, 'clean-controls.json[0] target.range:'));
});

test('rule 2: a missing provenance is refused, and an empty one too (breaks if provenance stops being required or open-but-non-empty)', () => {
  const noProv = control(); delete noProv.provenance;
  assert.deepEqual(ctlErr(ctlFile([noProv])).problems, ['clean-controls.json[0] provenance: required']);
  assert.ok(starts(ctlErr(ctlFile([control({ provenance: {} })])).problems, 'clean-controls.json[0] provenance:'));
});

test('rule 2: provenance is open, any key is accepted (breaks if provenance gets a key check)', () => {
  assert.equal(goldModule.loadCleanControls(ctlFile([control({ provenance: { anyKey: 1, other: [2] } })])).length, 1);
});

// --- Merged-head controls (Dave, 2026-11-14): a control with no CodeRabbit round uses its merged head ---

const HEAD_MARK = 'merged-head-no-round';
const headControl = (over = {}) => control({ target: { pr: 9002, round: null, sha40: sha('d') }, provenance: { why: 'made up', head: HEAD_MARK }, ...over });

test('merged head: a control with round null, a valid sha40 and provenance.head merged-head-no-round loads (breaks if the control round check refuses null in every case)', () => {
  const c = headControl();
  assert.deepEqual(goldModule.loadCleanControls(ctlFile([c, control({ id: 'c-old' })])), [c, control({ id: 'c-old' })], 'an old control with a round still loads beside it');
});

test('merged head: a gold row with round null is refused by validateRow, also with the merged-head provenance (breaks if the null round leaks from controls into gold rows)', () => {
  const problems = validateRow(row({ target: { pr: 9001, round: null, sha40: sha('a') }, provenance: { head: HEAD_MARK } }));
  assert.deepEqual(problems, ['target.round: null, expected a positive integer']);
});

test('merged head: a control with round null and no sha40, or a bad sha40, is refused for the sha40 only (breaks if null round skips the sha40 check)', () => {
  const noSha = ctlErr(ctlFile([headControl({ target: { pr: 9002, round: null } })]));
  assert.deepEqual(noSha.problems, ['clean-controls.json[0] target.sha40: required']);
  const badSha = ctlErr(ctlFile([headControl({ target: { pr: 9002, round: null, sha40: 'abc' } })]));
  assert.deepEqual(badSha.problems, ['clean-controls.json[0] target.sha40: a string, expected 40 lowercase hex characters']);
});

test('merged head: a control with round null and no merged-head provenance is refused, and the problem holds no value (breaks if null round is allowed without the marker)', () => {
  for (const provenance of [{ why: 'made up' }, { why: 'made up', head: MARK }, MARK]) {
    const err = ctlErr(ctlFile([headControl({ provenance })]));
    assert.ok(err instanceof GoldError, JSON.stringify(provenance));
    assert.ok(err.problems.includes('clean-controls.json[0] target.round: null, expected a positive integer'), JSON.stringify(err.problems));
    assert.ok(!err.message.includes(MARK), err.message);
  }
});

test('merged head: a marked control with round 0, -1 or "1" is refused with the positive-integer problem, and one with a positive integer round loads (breaks if the marker excepts any round value other than exactly null)', () => {
  for (const [round, found] of [[0, 'a number'], [-1, 'a number'], ['1', 'a string']]) {
    const err = ctlErr(ctlFile([headControl({ target: { pr: 9002, round, sha40: sha('d') } })]));
    assert.ok(err instanceof GoldError, JSON.stringify(round));
    assert.deepEqual(err.problems, [`clean-controls.json[0] target.round: ${found}, expected a positive integer`], JSON.stringify(round));
  }
  const withRound = headControl({ target: { pr: 9002, round: 3, sha40: sha('d') } });
  assert.deepEqual(goldModule.loadCleanControls(ctlFile([withRound])), [withRound]);
});

test('rule 2: an unknown top-level key is refused, including the gold-row keys (breaks if the control key check is removed or allows source, suite, file)', () => {
  for (const key of ['kind', 'source', 'suite', 'file', 'severity', 'labels']) {
    const err = ctlErr(ctlFile([control({ [key]: 'x' })]));
    assert.deepEqual(err.problems, [`clean-controls.json[0] control: unknown field "${key}"`], key);
  }
});

test('rule 2: a missing required key is refused for each of id, split, target, provenance (breaks if a control key becomes optional)', () => {
  for (const k of ['id', 'split', 'target', 'provenance']) {
    const c = control(); delete c[k];
    assert.deepEqual(ctlErr(ctlFile([c])).problems, [`clean-controls.json[0] ${k}: required`], k);
  }
});

test('rule 2: a file that is not an array is refused, and names the control shape (breaks if an object is accepted)', () => {
  for (const body of [control(), { prs: [] }, 'x', 5, null]) {
    assert.deepEqual(ctlErr(ctlFile(JSON.stringify(body))).problems, ['clean-controls.json: expected a JSON array of clean controls']);
  }
});

test('rule 2: a duplicate id inside the file is refused and names the first (breaks if the duplicate check is removed)', () => {
  const err = ctlErr(ctlFile([control(), control({ split: 'reserve' })]));
  assert.deepEqual(err.problems, ['clean-controls.json[1] id: duplicate of clean-controls.json[0]']);
});

test('rule 2: a control item that is not an object is refused (breaks if the item guard is removed)', () => {
  assert.deepEqual(ctlErr(ctlFile([null, 'x'])).problems, ['clean-controls.json[0] control: expected an object', 'clean-controls.json[1] control: expected an object']);
});

test('rule 2 DECISION: a control refuses target.repo, because a clean control is one of our own PRs (map.md:678) (breaks if repo is accepted on a control)', () => {
  const target = { repo: `${MARK}/made-up`, pr: 9002, round: 1, sha40: sha('d') };
  const err = ctlErr(ctlFile([control({ target })]));
  assert.equal(err.problems.length, 1, JSON.stringify(err.problems));
  assert.match(err.problems[0], /^clean-controls\.json\[0\] target\.repo: refused/);
  assert.ok(!err.message.includes(MARK), err.message);
});

test('rule 2: control problems never print an answer value (breaks if quote() returns to a control check)', () => {
  const err = ctlErr(ctlFile([control({ id: `${MARK} x`, provenance: MARK, target: { pr: MARK, round: 1, sha40: MARK } })]));
  assert.ok(err.problems.length >= 3, JSON.stringify(err.problems));
  assert.ok(!err.message.includes(MARK), err.message);
});

test('rule 2: a bad file is reported with the loadGold messages: not JSON with a position, BOM, link (breaks if the controls reader is not the loadGold reader)', (t) => {
  const bad = ctlErr(ctlFile(`{${MARK}: 1}`));
  assert.match(bad.problems[0], /^clean-controls\.json: not valid JSON at position \d+/);
  assert.ok(!bad.message.includes(MARK), bad.message);
  assert.deepEqual(ctlErr(ctlFile(`${BOM}${JSON.stringify([control()])}`)).problems, ['clean-controls.json: has a BOM']);
  const outside = folder({ 'real.json': [control()] });
  const dir = folder();
  try {
    symlinkSync(path.join(outside, 'real.json'), path.join(dir, 'clean-controls.json'), 'file');
  } catch (e) {
    t.skip(`this account cannot create a file symlink (${e.code})`);
    return;
  }
  assert.deepEqual(ctlErr(dir).problems, ['clean-controls.json: is a link, not a file']);
});

test('rule 2: loadGold still skips clean-controls.json and escape-baseline.json, even with a control file that holds rows of the control shape (breaks if loadGold validates the control file as gold rows)', () => {
  const dir = folder({ 'clean-controls.json': [control()], 'escape-baseline.json': [{ band: 'x' }], 'a.json': [row()] });
  const out = loadGold(dir);
  assert.deepEqual(out.skipped, ['clean-controls.json', 'escape-baseline.json']);
  assert.deepEqual(out.files, ['a.json']);
  assert.equal(out.rows.length, 1);
});

// --- Reader finding 1: the JSON error position ---

test('reader finding 1: a broken JSON file reports "not valid JSON" with a position and no file content (breaks if POSITION_RE loses a backslash, so it never matches)', () => {
  // V8 prints a position for this shape. Another shape ("Unexpected token ...") quotes the source and has no position; see the MARK test above.
  const err = loadErr(folder({ 'pos.json': `{${MARK}: 1}` }));
  assert.ok(err instanceof GoldError);
  assert.match(err.problems[0], /not valid JSON/);
  assert.match(err.problems[0], /position \d+/);
  assert.ok(!err.message.includes(MARK), err.message);
});

test('review fix 3: text inside the file that looks like a position is never reported as the position (breaks if POSITION_RE loses its end anchor)', () => {
  // V8 quotes the source text in this message shape and gives no position, so the words in the file must not leak out.
  // A position-bearing message ("... in JSON at position 23 (line 1 column 24)") quotes nothing and stays reported (see finding 1 below).
  // The source is short, so V8 quotes all of it: "Unexpected token 'x', "x at position 999" is not valid JSON".
  const err = loadErr(folder({ 'pos.json': 'x at position 999' }));
  assert.ok(err instanceof GoldError);
  assert.equal(err.problems.length, 1);
  assert.ok(!err.message.includes('999'), err.message);
  assert.match(err.problems[0], /^pos\.json: not valid JSON/);
});

// --- Seat check of PR 508: B1 (file name case), R1 and R2 (range), R3 (folder read errors) ---

const EXT_MSG = (n) => `${JSON.stringify(n)}: the extension must be lower-case .json`;
const NAME_MSG = (n, exact) => `${JSON.stringify(n)}: the name must be exactly ${exact} (lower case)`;

test('seat B1: a row file with an upper-case or mixed-case extension is a problem, not a silent drop (breaks if the .json filter goes back to a case-sensitive endsWith)', () => {
  for (const name of ['GOLD-A.JSON', 'gold-a.Json', 'gold-a.jSON']) {
    const err = loadErr(folder({ [name]: [row()] }));
    assert.ok(err instanceof GoldError, `${name} was dropped with no sign`);
    assert.deepEqual(err.problems, [EXT_MSG(name)], name);
  }
});

test('seat B1: a bad-case file is never read as rows, and a good file beside it is not hidden (breaks if the variant is loaded, or the loader stops at the good file)', () => {
  const err = loadErr(folder({ 'ok.json': [row()], 'BAD.JSON': [row({ id: 'g-other' })], 'worse.JSON': '{nope' }));
  assert.ok(err instanceof GoldError);
  assert.deepEqual(err.problems, [EXT_MSG('BAD.JSON'), EXT_MSG('worse.JSON')]);
});

test('seat B1: a case variant of a non-row file name is a problem, not skipped and not loaded as rows (breaks if NON_ROW_FILES is matched case-sensitively)', () => {
  for (const [name, exact] of [['Clean-Controls.json', 'clean-controls.json'], ['CLEAN-CONTROLS.JSON', 'clean-controls.json'], ['Escape-Baseline.json', 'escape-baseline.json'], ['escape-baseline.JSON', 'escape-baseline.json']]) {
    const err = loadErr(folder({ [name]: [] }));
    assert.ok(err instanceof GoldError, `${name} was accepted`);
    assert.deepEqual(err.problems, [NAME_MSG(name, exact)], name);
  }
});

test('seat B1: a folder named with another case of .json is still ignored, like sub.json (breaks if the case-blind match reports a folder)', () => {
  const dir = folder();
  mkdirSync(path.join(dir, 'SUB.JSON'));
  assert.deepEqual(loadGold(dir), { rows: [], files: [], skipped: [] });
});

test('seat B1: a bad-case file name prints through the 40-character cap (breaks if the name is printed whole)', () => {
  const name = `${'n'.repeat(60)}.JSON`;
  const err = loadErr(folder({ [name]: [] }));
  assert.ok(err instanceof GoldError);
  assert.equal(err.problems.length, 1);
  assert.ok(err.problems[0].includes('n'.repeat(40)) && !err.problems[0].includes('n'.repeat(41)), err.problems[0]);
});

test('seat B1: a symlink with a bad-case extension is reported by name and not followed (breaks if the case check skips links)', (t) => {
  const outside = folder({ 'real.json': [row()] });
  const dir = folder();
  try {
    symlinkSync(path.join(outside, 'real.json'), path.join(dir, 'link.JSON'), 'file');
  } catch (e) {
    t.skip(`this account cannot create a file symlink (${e.code})`);
    return;
  }
  assert.deepEqual(loadErr(dir).problems, [EXT_MSG('link.JSON')]);
});

test('seat B1: a case variant of clean-controls.json is a problem in loadCleanControls, read from the real directory entry (breaks if only the asked-for path is checked)', () => {
  for (const name of ['Clean-Controls.json', 'CLEAN-CONTROLS.JSON', 'clean-controls.Json']) {
    const err = ctlErr(folder({ [name]: [control()] }));
    assert.ok(err instanceof GoldError, `${name} was read or dropped with no sign`);
    assert.deepEqual(err.problems, [NAME_MSG(name, 'clean-controls.json')], name);
  }
});

test('seat B1: loadCleanControls still reads the exact name, and other files with similar names do not matter (breaks if the case-blind scan matches too much)', () => {
  const dir = folder({ 'clean-controls.json': [control()], 'clean-controls.json.bak': '{nope', 'my-clean-controls.json': '{nope' });
  assert.equal(goldModule.loadCleanControls(dir).length, 1);
});

test('seat R1: a range whose base equals its head is refused, in sha and in ref form (breaks if the empty-range check is removed)', () => {
  const same = [`${sha('b')}..${sha('b')}`, 'refs/eval/seed/s1..refs/eval/seed/s1'];
  for (const range of same) {
    const hit = noEcho({ target: { range } }, 'target.range', 'seed/s1');
    assert.match(hit[0], /same/);
  }
  assert.deepEqual(validateRow(row({ target: { range: 'refs/eval/seed/s1..refs/eval/seed/s2' } })), []);
  assert.deepEqual(validateRow(row({ target: { range: `${sha('b')}..${sha('c')}` } })), []);
});

test('seat R2: a ref that ends with / or .lock or holds a . part is refused on either side (breaks if one of the three ref rules is removed or limited to one side)', () => {
  const bad = [
    `refs/heads/x/..${sha('c')}`, `${sha('b')}..refs/heads/x/`,
    `refs/heads/x.lock..${sha('c')}`, `${sha('b')}..refs/heads/x.lock`,
    `refs/heads/./x..${sha('c')}`, `${sha('b')}..refs/heads/./x`, `${sha('b')}..refs/heads/x/.`,
  ];
  for (const range of bad) expectProblem({ target: { range } }, 'target.range:');
  for (const ok of ['refs/heads/x.locker', 'refs/heads/a.b', 'refs/heads/x']) {
    assert.deepEqual(validateRow(row({ target: { range: `${ok}..${sha('c')}` } })), [], ok);
    assert.deepEqual(validateRow(row({ target: { range: `${sha('b')}..${ok}` } })), [], ok);
  }
});

// Reaches readdirSync and statSync with no private export: the node:fs ESM bindings are live after syncBuiltinESMExports.
function failFs(name, dir, code, fn) {
  const real = fs[name];
  const m = mock.method(fs, name, (p, ...rest) => {
    if (p === dir) throw Object.assign(new Error(`boom ${dir}`), { code });
    return real(p, ...rest);
  });
  syncBuiltinESMExports();
  try { return fn(); } finally { m.mock.restore(); syncBuiltinESMExports(); }
}

test('seat R3: a readdirSync or statSync error is a GoldError with the code and no path, in both loaders (breaks if the raw Error escapes or the path is printed)', () => {
  for (const name of ['readdirSync', 'statSync']) {
    const dir = folder({ 'a.json': [row()], 'clean-controls.json': [control()] });
    const want = [`${path.basename(dir)}: cannot read (EACCES)`];
    for (const [what, run] of [['loadGold', loadErr], ['loadCleanControls', ctlErr]]) {
      const err = failFs(name, dir, 'EACCES', () => run(dir));
      assert.ok(err instanceof GoldError, `${what} with ${name}: ${err}`);
      assert.deepEqual(err.problems, want, `${what} with ${name}`);
      assert.ok(!err.message.includes(os.tmpdir()), err.message);
    }
  }
});

test('seat R3: a read error with no code says unknown (breaks if the code fallback is removed)', () => {
  const dir = folder();
  const err = failFs('readdirSync', dir, undefined, () => loadErr(dir));
  assert.deepEqual(err.problems, [`${path.basename(dir)}: cannot read (unknown)`]);
});

// --- Reader finding 2: the export list ---

test('reader finding 2: the module exports exactly the contract names and not readRowFile (breaks if an internal helper is exported again)', () => {
  assert.deepEqual(Object.keys(goldModule).sort(), [
    'GOLD_DIR', 'GOLD_ROW', 'GoldError', 'NON_ROW_FILES', 'SEVERITIES', 'SLICES', 'SOURCES', 'SPLITS', 'SUITES',
    'loadCleanControls', 'loadGold', 'validateRow',
  ]);
});
