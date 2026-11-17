/**
 * ask-ledger.test.mjs -- card coord-ask-ledger (Ask Loop card 1). Design note: .claudedocs/coordination/2026-11-16-coord-ask-ledger-design.md.
 *
 * No database and no live transcript: every test builds transcript files in a temp folder and runs scripts/coordination/ask-ledger.mjs on them.
 * The file name has no `.db.` part. It sits in the COORDINATION_TESTS list of pre-pr.mjs and in the CI step that lists the same files
 * (test CO1 in pre-pr.test.mjs ties the two lists together). ASK_LEDGER_CLI points the tests at another copy of the script (a mutation run).
 *
 * One test per failure of the design note (section 4). Most tests run with --root <a folder with no listed-id list>: the script then
 * takes its absent-list path and the final listed-id pass has no list to count. Test 10 uses a real fixture list.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestFile } from './coord-drill-2/metrics.mjs';
import { DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.ASK_LEDGER_CLI ? path.resolve(process.env.ASK_LEDGER_CLI) : path.join(HERE, 'ask-ledger.mjs');

const t0 = Date.parse('2026-11-14T15:00:00.000Z');
const at = (sec) => new Date(t0 + sec * 1000).toISOString();
const q = (header, labels, extra = {}) => ({ question: `Question text for ${header}?`, header, multiSelect: false, options: labels.map((l) => ({ label: l, description: 'd' })), ...extra });

let tmp;
let EMPTY;
let n = 0;
const folder = () => { const d = path.join(tmp, `case${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const jl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const useEntry = (session, id, sec, questions) => ({ type: 'assistant', sessionId: session, timestamp: at(sec), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const resultEntry = (session, id, sec, questions, answers) => ({ type: 'user', sessionId: session, timestamp: at(sec), toolUseResult: { questions, answers }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered.' }] } });
const lastEntry = (session, sec) => ({ type: 'user', sessionId: session, timestamp: at(sec), message: { role: 'user', content: 'later' } });

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: tmp, env: { ...process.env } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function ledger(dir, extra = []) {
  const r = run(['--dir', dir, '--root', EMPTY, ...extra]);
  assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
  return JSON.parse(r.out);
}
function put(dir, name, rows) { fs.writeFileSync(path.join(dir, name), jl(rows)); }
function listRoot() {
  const root = folder();
  fs.mkdirSync(path.join(root, '.claudedocs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'eval', 'review-eval'), { recursive: true });
  fs.writeFileSync(path.join(root, DATASET_REL), JSON.stringify({ prs: [{ pr: 7654321 }], findings: [{ pr: 7654321, comment_id: 1234567890 }] }));
  fs.writeFileSync(path.join(root, EVAL_CONFIG_REL), JSON.stringify({}));
  return root;
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ledger-')); EMPTY = path.join(tmp, 'empty-root'); fs.mkdirSync(EMPTY); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('rows and answers', () => {
  it('1: a call with 3 questions gives 3 rows, qIndex 0..2', () => {
    const d = folder();
    const qs = [q('Alpha', ['A', 'B']), q('Beta', ['A', 'B']), q('Gamma', ['A', 'B'])];
    put(d, 's1.jsonl', [useEntry('s1', 'tu1', 0, qs), resultEntry('s1', 'tu1', 30, qs, { [qs[0].question]: 'A', [qs[1].question]: 'B', [qs[2].question]: 'A' })]);
    const j = ledger(d);
    assert.equal(j.rows.length, 3);
    assert.deepEqual(j.rows.map((r) => r.qIndex), [0, 1, 2]);
    assert.deepEqual(j.rows.map((r) => r.class), ['Alpha', 'Beta', 'Gamma']);
    assert.ok(j.rows.every((r) => r.waitSec === 30 && r.session === 's1' && r.toolUseId === 'tu1'));
  });

  it('2: a tap is tap, an answer that equals no label is typed, a multiSelect of labels (a label may hold ", ") is tap', () => {
    const d = folder();
    const a = [q('Tap', ['Yes (Recommended)', 'No'])];
    const b = [q('Typed', ['Yes', 'No'])];
    const c = [q('Multi', ['One', 'Two', 'Yes, land it'], { multiSelect: true })];
    const e = [q('MultiComma', ['One', 'Yes, land it', 'Yes'], { multiSelect: true })];
    const f = [q('MultiBad', ['One', 'Yes, land it'], { multiSelect: true })];
    put(d, 's2.jsonl', [
      useEntry('s2', 'a', 0, a), resultEntry('s2', 'a', 10, a, { [a[0].question]: 'Yes (Recommended)' }),
      useEntry('s2', 'b', 20, b), resultEntry('s2', 'b', 40, b, { [b[0].question]: 'do the third thing instead' }),
      useEntry('s2', 'c', 50, c), resultEntry('s2', 'c', 60, c, { [c[0].question]: 'One, Two' }),
      useEntry('s2', 'e', 70, e), resultEntry('s2', 'e', 80, e, { [e[0].question]: 'Yes, land it, Yes' }),
      useEntry('s2', 'f', 90, f), resultEntry('s2', 'f', 99, f, { [f[0].question]: 'Yes, land' }),
    ]);
    const by = Object.fromEntries(ledger(d).rows.map((r) => [r.class, r]));
    assert.equal(by.Tap.answerKind, 'tap');
    assert.equal(by.Tap.recommendedTaken, true);
    assert.equal(by.Typed.answerKind, 'typed');
    assert.equal(by.Typed.typedLen, 'do the third thing instead'.length);
    assert.equal(by.Typed.recommendedTaken, null);
    assert.equal(by.Multi.answerKind, 'tap');
    assert.equal(by.MultiComma.answerKind, 'tap');
    assert.equal(by.MultiBad.answerKind, 'typed');
  });

  it('3: no typed text, no question text and no option label in the output', () => {
    const d = folder();
    const a = [q('Privacy', ['Keep going (Recommended)', 'Stop now'])];
    put(d, 's3.jsonl', [useEntry('s3', 'p', 0, a), resultEntry('s3', 'p', 9, a, { [a[0].question]: 'zebra-quartz-typed-secret' })]);
    const r = run(['--dir', d, '--root', EMPTY]);
    assert.equal(r.code, 0);
    for (const bad of ['zebra-quartz-typed-secret', 'Question text for Privacy', 'Keep going', 'Stop now']) assert.ok(!r.out.includes(bad), `output holds "${bad}"`);
    assert.ok(!r.err.includes('zebra-quartz-typed-secret'));
  });

  it('4: shares, wait percentiles and the other row fields are computed from the rows', () => {
    const d = folder();
    const rows = [];
    const mk = (id, sec, wait, ans) => { const qs = [q('Mix', ['Go (Recommended)', 'Other way'])]; rows.push(useEntry('s4', id, sec, qs), resultEntry('s4', id, sec + wait, qs, { [qs[0].question]: ans })); };
    mk('m1', 0, 10, 'Go (Recommended)'); mk('m2', 100, 400, 'Other way'); mk('m3', 600, 50, 'my own words');
    put(d, 's4.jsonl', rows);
    const j = ledger(d);
    const c = j.byClass.Mix;
    assert.equal(c.count, 3);
    assert.equal(c.recommendedTakenShare, 0.5);
    assert.equal(c.typedShare, 1 / 3);
    assert.equal(c.waitP50Sec, 50);
    assert.equal(c.waitP90Sec, 400);
    assert.equal(c.waitsOver300, 1);
    assert.equal(c.open, 0);
    const r = j.rows[0];
    assert.match(r.qHash, /^[0-9a-f]{12}$/);
    assert.equal(r.qHash, j.rows[1].qHash);
    assert.equal(r.optionCount, 2);
    assert.equal(r.multiSelect, false);
    assert.equal(r.hasRecommended, true);
  });

  it('5: a call with no result is open and stops at the end of the data; a result with no answer is declined', () => {
    const d = folder();
    const a = [q('Open', ['A', 'B'])];
    const b = [q('Declined', ['A', 'B'])];
    put(d, 's5.jsonl', [useEntry('s5', 'o', 0, a), useEntry('s5', 'x', 100, b), resultEntry('s5', 'x', 130, b, {}), lastEntry('s5', 500)]);
    const j = ledger(d);
    const by = Object.fromEntries(j.rows.map((r) => [r.class, r]));
    assert.equal(by.Open.answerKind, 'open');
    assert.equal(by.Open.answeredAt, null);
    assert.equal(by.Open.waitSec, 500);
    assert.equal(j.byClass.Open.open, 1);
    assert.equal(j.byClass.Open.waitsOver300, 1);
    assert.equal(by.Declined.answerKind, 'declined');
    // Like metric7: a later --until does not stretch the wait past the end of the data; an earlier one cuts it.
    assert.equal(ledger(d, ['--until', at(900)]).rows.find((r) => r.class === 'Open').waitSec, 500);
    assert.equal(ledger(d, ['--until', at(300)]).rows.find((r) => r.class === 'Open').waitSec, 300);
  });
});

describe('failing loud and staying quiet', () => {
  it('6: no transcript, or no question in the window, exits 2 and names the folder and the window', () => {
    const empty = folder();
    const r1 = run(['--dir', empty, '--root', EMPTY]);
    assert.equal(r1.code, 2);
    assert.equal(r1.out, '');
    assert.match(r1.err, /no question/i);
    assert.ok(r1.err.includes(empty.replace(/\\/g, '/')) || r1.err.includes(empty));
    const d = folder();
    put(d, 's6.jsonl', [lastEntry('s6', 1)]);
    const r2 = run(['--dir', d, '--root', EMPTY, '--since', '2026-11-14T00:00:00Z']);
    assert.equal(r2.code, 2);
    assert.match(r2.err, /2026-11-14T00:00:00/);
    assert.equal(run(['--dir', path.join(tmp, 'does-not-exist'), '--root', EMPTY]).code, 2);
    assert.equal(run(['--dir', path.join(d, 's6.jsonl'), '--root', EMPTY]).code, 2); // a file, not a folder
  });

  it('7: two runs on the same input give the same bytes, and the rows are sorted by time, session, id', () => {
    const d = folder();
    const a = [q('Same', ['A', 'B'])];
    // File order is b.jsonl then a.jsonl on purpose; the sort has to put session a first, and the earlier ask of the later file first of all.
    put(d, 'a.jsonl', [useEntry('b', 'u2', 5, a), resultEntry('b', 'u2', 9, a, { [a[0].question]: 'A' })]);
    put(d, 'b.jsonl', [useEntry('a', 'u1', 5, a), resultEntry('a', 'u1', 8, a, { [a[0].question]: 'B' }), useEntry('a', 'u0', 1, a), resultEntry('a', 'u0', 2, a, { [a[0].question]: 'A' })]);
    const one = run(['--dir', d, '--root', EMPTY]);
    const two = run(['--dir', d, '--root', EMPTY]);
    assert.equal(one.code, 0);
    assert.equal(one.out, two.out);
    assert.deepEqual(JSON.parse(one.out).rows.map((r) => `${r.session}:${r.toolUseId}`), ['a:u0', 'a:u1', 'b:u2']);
  });

  it('8: a transcript in a subagents folder is not counted', () => {
    const d = folder();
    const a = [q('Main', ['A', 'B'])];
    put(d, 'main.jsonl', [useEntry('m', 'k1', 0, a), resultEntry('m', 'k1', 4, a, { [a[0].question]: 'A' })]);
    fs.mkdirSync(path.join(d, 'sess', 'subagents'), { recursive: true });
    const s = [q('Sub', ['A', 'B'])];
    put(path.join(d, 'sess', 'subagents'), 'agent-1.jsonl', [useEntry('sub', 'k2', 0, s), resultEntry('sub', 'k2', 4, s, { [s[0].question]: 'A' })]);
    assert.deepEqual(ledger(d).rows.map((r) => r.class), ['Main']);
  });

  it('9: --since is inclusive and --until is exclusive, on the time asked', () => {
    const d = folder();
    const rows = [];
    for (const [id, sec] of [['w1', 0], ['w2', 100], ['w3', 200]]) { const qs = [q(`W${id}`, ['A'])]; rows.push(useEntry('s9', id, sec, qs), resultEntry('s9', id, sec + 1, qs, { [qs[0].question]: 'A' })); }
    put(d, 's9.jsonl', rows);
    assert.deepEqual(ledger(d, ['--since', at(100), '--until', at(200)]).rows.map((r) => r.class), ['Ww2']);
    assert.deepEqual(ledger(d, ['--since', at(0), '--until', at(201)]).rows.map((r) => r.class), ['Ww1', 'Ww2', 'Ww3']);
  });
});

describe('class, ids and bad input', () => {
  it('10: a long or symbol header is class OTHER; a number after "#" is masked; a header with a listed id is OTHER; a listed id in a row stops the run', () => {
    const d = folder();
    const long = 'x'.repeat(41);
    const qs = [q(long, ['A']), q('has <b> tag', ['A']), q('Fine header', ['A']), q('PR #7654321', ['A']), q('PR 7654321', ['A'])];
    const ans = Object.fromEntries(qs.map((x) => [x.question, 'A']));
    put(d, 's10.jsonl', [useEntry('s10', 'h', 0, qs), resultEntry('s10', 'h', 5, qs, ans)]);
    assert.deepEqual(ledger(d).rows.map((r) => r.class), ['OTHER', 'OTHER', 'Fine header', 'PR #N', 'PR 7654321']);
    const root = listRoot();
    const withList = run(['--dir', d, '--root', root]);
    assert.equal(withList.code, 0, withList.err);
    assert.deepEqual(JSON.parse(withList.out).rows.map((r) => r.class), ['OTHER', 'OTHER', 'Fine header', 'PR #N', 'OTHER']);
    // A listed id in a session id reaches a row: the run stops with exit 3, no stdout, no --out file, no id in stderr.
    const e = folder();
    const one = [q('Clean', ['A'])];
    put(e, 'id.jsonl', [useEntry('1234567890', 'i', 0, one), resultEntry('1234567890', 'i', 3, one, { [one[0].question]: 'A' })]);
    const cache = path.join(folder(), 'ask-ledger');
    const out = path.join(cache, 'ledger.json');
    const bad = run(['--dir', e, '--root', root, '--cache-dir', cache, '--out', out]);
    assert.equal(bad.code, 3);
    assert.equal(bad.out, '');
    assert.ok(!fs.existsSync(out), 'a file was written after exit 3');
    assert.ok(!bad.err.includes('1234567890') && !bad.err.includes('7654321'), 'an id reached stderr');
    const e2 = folder();
    put(e2, 'ok.jsonl', [useEntry('s10', 'i', 0, one), resultEntry('s10', 'i', 3, one, { [one[0].question]: 'A' })]);
    assert.equal(run(['--dir', e2, '--root', root]).code, 0);
  });

  it('10b: no listed-id list gives one note and goes on; an unreadable list stops with exit 3 and no output', () => {
    const d = folder();
    const a = [q('Note', ['A'])];
    put(d, 's10b.jsonl', [useEntry('s10b', 'n', 0, a), resultEntry('s10b', 'n', 2, a, { [a[0].question]: 'A' })]);
    const absent = run(['--dir', d, '--root', EMPTY]);
    assert.equal(absent.code, 0);
    assert.match(absent.err, /no listed-id list/);
    const broken = listRoot();
    fs.writeFileSync(path.join(broken, DATASET_REL), '{ not json 4242');
    const r = run(['--dir', d, '--root', broken]);
    assert.equal(r.code, 3);
    assert.equal(r.out, '');
    assert.ok(!r.err.includes('4242'));
    const empty = listRoot();
    fs.writeFileSync(path.join(empty, DATASET_REL), JSON.stringify({ prs: [], findings: [] }));
    assert.equal(run(['--dir', d, '--root', empty]).code, 3);
  });

  it('11: a line that is not JSON is counted; a JSON line with no time is ignored; a null question, a file that cannot be read and a string toolUseResult do not stop the run', () => {
    const d = folder();
    const a = [q('Skip', ['A'])];
    const b = [q('Str', ['A'])];
    put(d, 's11.jsonl', [
      '{ not json secret-parse-text', JSON.stringify({ type: 'summary', note: 'no time here' }),
      useEntry('s11', 'z', 0, [null, ...a]), resultEntry('s11', 'z', 2, a, { [a[0].question]: 'A' }),
      useEntry('s11', 'y', 10, b), { type: 'user', sessionId: 's11', timestamp: at(12), toolUseResult: 'rejected by the user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: 'no' }] } },
    ]);
    fs.mkdirSync(path.join(d, 'folder-named.jsonl')); // readFileSync throws on it
    const r = run(['--dir', d, '--root', EMPTY]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.equal(j.badLines, 1);
    assert.equal(j.unreadable, 1);
    assert.deepEqual(j.rows.map((x) => `${x.class}:${x.qIndex}:${x.answerKind}`), ['Skip:1:tap', 'Str:0:declined']);
    assert.ok(!r.out.includes('secret-parse-text') && !r.err.includes('secret-parse-text'));
  });

  it('12: a question repeated in more files (resume, copy) is one row; the EARLIEST use and result win in either file order', () => {
    const d = folder();
    const a = [q('Dup', ['A'])];
    put(d, 's12.jsonl', [useEntry('s12', 'dup', 0, a), resultEntry('s12', 'dup', 6, a, { [a[0].question]: 'A' })]);
    // One copy sorts before s12.jsonl and one after it; each holds a later use and a later result.
    put(d, 'a12.jsonl', [useEntry('s12', 'dup', 40, a), resultEntry('s12', 'dup', 90, a, { [a[0].question]: 'A' })]);
    put(d, 'z12.jsonl', [useEntry('s12', 'dup', 30, a), resultEntry('s12', 'dup', 95, a, { [a[0].question]: 'A' })]);
    const j = ledger(d);
    assert.equal(j.rows.length, 1);
    assert.equal(j.rows[0].askedAt, t0);
    assert.equal(j.rows[0].waitSec, 6);
  });
});

describe('--out and the metrics meter', () => {
  it('13: --out must stay inside the cache folder by its real path: ".." , a sibling folder, a junction and a link file cannot leave', () => {
    const d = folder();
    const a = [q('Out', ['A'])];
    put(d, 's13.jsonl', [useEntry('s13', 'o1', 0, a), resultEntry('s13', 'o1', 4, a, { [a[0].question]: 'A' })]);
    const base = folder();
    const cache = path.join(base, 'ask-ledger');
    fs.mkdirSync(cache, { recursive: true });
    const sibling = path.join(base, 'ask-ledger-x'); // shares the name prefix of the cache folder
    fs.mkdirSync(sibling);
    const outside = folder();
    const args = (out) => ['--dir', d, '--root', EMPTY, '--cache-dir', cache, '--out', out];
    const good = run(args(path.join(cache, 'ledger.json')));
    assert.equal(good.code, 0, good.err);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'ledger.json'), 'utf8')).rows.length, 1);
    const dots = run(args(path.join(cache, '..', 'escape.json')));
    assert.equal(dots.code, 1);
    assert.ok(!fs.existsSync(path.join(base, 'escape.json')));
    const sib = run(args(path.join(sibling, 'escape.json')));
    assert.equal(sib.code, 1);
    assert.ok(!fs.existsSync(path.join(sibling, 'escape.json')));
    const abs = run(args(path.join(outside, 'abs.json')));
    assert.equal(abs.code, 1);
    assert.ok(!fs.existsSync(path.join(outside, 'abs.json')));
    const link = path.join(cache, 'link');
    let junction = true;
    try { fs.symlinkSync(outside, link, 'junction'); } catch { junction = false; }
    if (junction) {
      assert.equal(run(args(path.join(link, 'escape2.json'))).code, 1);
      assert.ok(!fs.existsSync(path.join(outside, 'escape2.json')));
    }
    const victim = path.join(outside, 'victim.json');
    fs.writeFileSync(victim, 'keep');
    let fileLink = true;
    try { fs.symlinkSync(victim, path.join(cache, 'filelink.json'), 'file'); } catch { fileLink = false; }
    if (fileLink) {
      assert.equal(run(args(path.join(cache, 'filelink.json'))).code, 1);
      assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    }
  });

  it('14: guard: the paired and open counts of metric7 equal the ledger rows (one question per call)', async () => {
    const d = folder();
    const rows = [];
    const mk = (id, sec, ans) => { const qs = [q('Meter', ['A', 'B'])]; rows.push(useEntry('s14', id, sec, qs)); if (ans !== null) rows.push(resultEntry('s14', id, sec + 7, qs, ans === '' ? {} : { [qs[0].question]: ans })); };
    mk('g1', 0, 'A'); mk('g2', 20, 'my words'); mk('g3', 40, null); mk('g4', 60, '');
    rows.push(lastEntry('s14', 300));
    put(d, 's14.jsonl', rows);
    const facts = await ingestFile(path.join(d, 's14.jsonl'));
    const j = ledger(d);
    // metric7 pairs every result, so a declined row is paired too.
    assert.equal(facts.asks.length, j.rows.filter((r) => ['tap', 'typed', 'declined'].includes(r.answerKind)).length);
    assert.equal(facts.openAsks.length, j.rows.filter((r) => r.answerKind === 'open').length);
    // The open wait is the same as metric7: from the ask to the end of the data.
    assert.equal(facts.openAsks[0][1] - facts.openAsks[0][0], j.rows.find((r) => r.answerKind === 'open').waitSec * 1000);
  });
});

describe('label split (card coord-seat-counts, item D1: the CLI minor of the ask-ledger pull request)', () => {
  it('15: a multiSelect answer whose labels share a ", " prefix chain is read with backtracking (a tap, not typed)', () => {
    const d = folder();
    const labels = ['One', 'One, Two', 'Two, Three', 'Two'];
    const c = [q('Chain', labels, { multiSelect: true })];
    const e = [q('ChainBad', labels, { multiSelect: true })];
    const f = [q('ChainComma', labels, { multiSelect: true })];
    put(d, 's15.jsonl', [
      useEntry('s15', 'c', 0, c), resultEntry('s15', 'c', 5, c, { [c[0].question]: 'One, Two, Three' }), // One + Two, Three: greedy takes "One, Two" and fails on "Three"
      useEntry('s15', 'e', 10, e), resultEntry('s15', 'e', 15, e, { [e[0].question]: 'One, Three' }), // no way to split into labels: typed
      useEntry('s15', 'f', 20, f), resultEntry('s15', 'f', 25, f, { [f[0].question]: 'One, ' }), // ends in a comma and a space: typed
    ]);
    const by = Object.fromEntries(ledger(d).rows.map((r) => [r.class, r]));
    assert.equal(by.Chain.answerKind, 'tap');
    assert.equal(by.ChainBad.answerKind, 'typed');
    assert.equal(by.ChainComma.answerKind, 'typed');
  });
});
