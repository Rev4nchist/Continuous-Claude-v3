/**
 * ask-ledger.test.mjs -- card coord-ask-ledger (Ask Loop card 1). Design note: .claudedocs/coordination/2026-11-16-coord-ask-ledger-design.md.
 *
 * No database and no live transcript: every test builds transcript files in a temp folder and runs scripts/coordination/ask-ledger.mjs on them.
 * The file name has no `.db.` part. It sits in the COORDINATION_TESTS list of pre-pr.mjs and in the CI step that lists the same files
 * (test CO1 in pre-pr.test.mjs ties the two lists together).
 *
 * One test per failure of the design note (section 4). Each test names the source line whose revert makes it fail.
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
let n = 0;
const folder = () => { const d = path.join(tmp, `case${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const jl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const useEntry = (session, id, sec, questions) => ({ type: 'assistant', sessionId: session, timestamp: at(sec), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const resultEntry = (session, id, sec, questions, answers) => ({ type: 'user', sessionId: session, timestamp: at(sec), toolUseResult: { questions, answers }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered.' }] } });
const lastEntry = (session, sec) => ({ type: 'user', sessionId: session, timestamp: at(sec), message: { role: 'user', content: 'later' } });

function run(args, { cwd } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: cwd || tmp, env: { ...process.env } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function ledger(dir, extra = []) {
  const r = run(['--dir', dir, '--no-id-list', ...extra]);
  assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
  return JSON.parse(r.out);
}
function put(dir, name, rows) { fs.writeFileSync(path.join(dir, name), jl(rows)); }

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ledger-')); });
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

  it('2: a tap is tap, an answer that equals no label is typed, a multiSelect of labels is tap', () => {
    const d = folder();
    const a = [q('Tap', ['Yes (Recommended)', 'No'])];
    const b = [q('Typed', ['Yes', 'No'])];
    const c = [q('Multi', ['One', 'Two', 'Three'], { multiSelect: true })];
    put(d, 's2.jsonl', [
      useEntry('s2', 'a', 0, a), resultEntry('s2', 'a', 10, a, { [a[0].question]: 'Yes (Recommended)' }),
      useEntry('s2', 'b', 20, b), resultEntry('s2', 'b', 40, b, { [b[0].question]: 'do the third thing instead' }),
      useEntry('s2', 'c', 50, c), resultEntry('s2', 'c', 60, c, { [c[0].question]: 'One, Three' }),
    ]);
    const by = Object.fromEntries(ledger(d).rows.map((r) => [r.class, r]));
    assert.equal(by.Tap.answerKind, 'tap');
    assert.equal(by.Tap.recommendedTaken, true);
    assert.equal(by.Typed.answerKind, 'typed');
    assert.equal(by.Typed.typedLen, 'do the third thing instead'.length);
    assert.equal(by.Typed.recommendedTaken, null);
    assert.equal(by.Multi.answerKind, 'tap');
  });

  it('3: no typed text, no question text and no option label in the output', () => {
    const d = folder();
    const a = [q('Privacy', ['Keep going (Recommended)', 'Stop now'])];
    put(d, 's3.jsonl', [useEntry('s3', 'p', 0, a), resultEntry('s3', 'p', 9, a, { [a[0].question]: 'zebra-quartz-typed-secret' })]);
    const r = run(['--dir', d, '--no-id-list']);
    assert.equal(r.code, 0);
    for (const bad of ['zebra-quartz-typed-secret', 'Question text for Privacy', 'Keep going', 'Stop now']) assert.ok(!r.out.includes(bad), `output holds "${bad}"`);
    assert.ok(!r.err.includes('zebra-quartz-typed-secret'));
  });

  it('4: recommended-taken share is of taps; typed share is of all answered rows', () => {
    const d = folder();
    const rows = [];
    const mk = (id, sec, ans) => { const qs = [q('Mix', ['Go (Recommended)', 'Other way'])]; rows.push(useEntry('s4', id, sec, qs), resultEntry('s4', id, sec + 5, qs, { [qs[0].question]: ans })); };
    mk('m1', 0, 'Go (Recommended)'); mk('m2', 20, 'Other way'); mk('m3', 40, 'my own words');
    put(d, 's4.jsonl', rows);
    const c = ledger(d).byClass.Mix;
    assert.equal(c.count, 3);
    assert.equal(c.recommendedTakenShare, 0.5);
    assert.equal(c.typedShare, 1 / 3);
  });

  it('5: a call with no result is an open row to the window end; a result with no answer is declined', () => {
    const d = folder();
    const a = [q('Open', ['A', 'B'])];
    const b = [q('Declined', ['A', 'B'])];
    put(d, 's5.jsonl', [useEntry('s5', 'o', 0, a), useEntry('s5', 'x', 100, b), resultEntry('s5', 'x', 130, b, {}), lastEntry('s5', 500)]);
    const by = Object.fromEntries(ledger(d).rows.map((r) => [r.class, r]));
    assert.equal(by.Open.answerKind, 'open');
    assert.equal(by.Open.answeredAt, null);
    assert.equal(by.Open.waitSec, 500);
    assert.equal(by.Declined.answerKind, 'declined');
    const w = ledger(d, ['--until', at(900)]).rows.find((r) => r.class === 'Open');
    assert.equal(w.waitSec, 900);
  });
});

describe('failing loud and staying quiet', () => {
  it('6: no transcript, or no question in the window, exits 2 and names the folder and the window', () => {
    const empty = folder();
    const r1 = run(['--dir', empty, '--no-id-list']);
    assert.equal(r1.code, 2);
    assert.equal(r1.out, '');
    assert.match(r1.err, /no question/i);
    assert.ok(r1.err.includes(empty.replace(/\\/g, '/')) || r1.err.includes(empty));
    const d = folder();
    put(d, 's6.jsonl', [lastEntry('s6', 1)]);
    const r2 = run(['--dir', d, '--no-id-list', '--since', '2026-11-14T00:00:00Z']);
    assert.equal(r2.code, 2);
    assert.match(r2.err, /2026-11-14T00:00:00/);
    const r3 = run(['--dir', path.join(tmp, 'does-not-exist'), '--no-id-list']);
    assert.equal(r3.code, 2);
  });

  it('7: two runs on the same input give the same bytes', () => {
    const d = folder();
    const a = [q('Same', ['A', 'B'])];
    put(d, 'b.jsonl', [useEntry('b', 'u2', 5, a), resultEntry('b', 'u2', 9, a, { [a[0].question]: 'A' })]);
    put(d, 'a.jsonl', [useEntry('a', 'u1', 5, a), resultEntry('a', 'u1', 8, a, { [a[0].question]: 'B' })]);
    const one = run(['--dir', d, '--no-id-list']);
    const two = run(['--dir', d, '--no-id-list']);
    assert.equal(one.code, 0);
    assert.equal(one.out, two.out);
    assert.deepEqual(JSON.parse(one.out).rows.map((r) => r.session), ['a', 'b']);
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
  it('10: a header that is long or holds a symbol is class OTHER; a listed id stops the run with exit 3 and no output', () => {
    const d = folder();
    const long = 'x'.repeat(41);
    const qs = [q(long, ['A']), q('has <b> tag', ['A']), q('Fine header', ['A']), q('PR #7654321', ['A'])];
    put(d, 's10.jsonl', [useEntry('s10', 'h', 0, qs), resultEntry('s10', 'h', 5, qs, { [qs[0].question]: 'A', [qs[1].question]: 'A', [qs[2].question]: 'A', [qs[3].question]: 'A' })]);
    // A number after "#" never reaches a class.
    assert.deepEqual(ledger(d).rows.map((r) => r.class), ['OTHER', 'OTHER', 'Fine header', 'PR #N']);
    // A fixture root with a one-id list. The session id of the fixture is that id: it reaches a row, so the final pass must stop the run.
    const root = folder();
    fs.mkdirSync(path.join(root, '.claudedocs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'eval', 'review-eval'), { recursive: true });
    fs.writeFileSync(path.join(root, DATASET_REL), JSON.stringify({ prs: [{ pr: 7654321 }], findings: [{ pr: 7654321, comment_id: 1234567890 }] }));
    fs.writeFileSync(path.join(root, EVAL_CONFIG_REL), JSON.stringify({}));
    const e = folder();
    const one = [q('Clean', ['A'])];
    put(e, 'id.jsonl', [useEntry('1234567890', 'i', 0, one), resultEntry('1234567890', 'i', 3, one, { [one[0].question]: 'A' })]);
    const bad = run(['--dir', e, '--root', root]);
    assert.equal(bad.code, 3);
    assert.equal(bad.out, '');
    assert.ok(!bad.err.includes('1234567890') && !bad.err.includes('7654321'), 'an id reached stderr');
    const e2 = folder();
    put(e2, 'ok.jsonl', [useEntry('s10', 'i', 0, one), resultEntry('s10', 'i', 3, one, { [one[0].question]: 'A' })]);
    assert.equal(run(['--dir', e2, '--root', root]).code, 0);
  });

  it('11: a line that is not JSON is skipped and counted; its text never shows', () => {
    const d = folder();
    const a = [q('Skip', ['A'])];
    put(d, 's11.jsonl', ['{ not json secret-parse-text', useEntry('s11', 'z', 0, a), resultEntry('s11', 'z', 2, a, { [a[0].question]: 'A' })]);
    const r = run(['--dir', d, '--no-id-list']);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.equal(j.badLines, 1);
    assert.equal(j.rows.length, 1);
    assert.ok(!r.out.includes('secret-parse-text') && !r.err.includes('secret-parse-text'));
  });

  it('12: an entry repeated in the file (resume, compaction) gives one row per toolUseId', () => {
    const d = folder();
    const a = [q('Dup', ['A'])];
    const u = useEntry('s12', 'dup', 0, a);
    const r = resultEntry('s12', 'dup', 6, a, { [a[0].question]: 'A' });
    put(d, 's12.jsonl', [u, r, u, r]);
    // A copy of the file whose result is later (a replay): the earliest result stays, whatever the file order.
    put(d, 's12-copy.jsonl', [u, resultEntry('s12', 'dup', 90, a, { [a[0].question]: 'A' })]);
    const j = ledger(d);
    assert.equal(j.rows.length, 1);
    assert.equal(j.rows[0].waitSec, 6);
  });
});

describe('--out and the metrics meter', () => {
  it('13: --out must stay inside the cache folder by its real path: a ".." or a junction cannot leave', () => {
    const d = folder();
    const a = [q('Out', ['A'])];
    put(d, 's13.jsonl', [useEntry('s13', 'o1', 0, a), resultEntry('s13', 'o1', 4, a, { [a[0].question]: 'A' })]);
    const cache = path.join(folder(), 'ask-ledger');
    fs.mkdirSync(cache, { recursive: true });
    const outside = folder();
    const args = (out) => ['--dir', d, '--no-id-list', '--cache-dir', cache, '--out', out];
    const good = run(args(path.join(cache, 'ledger.json')));
    assert.equal(good.code, 0, good.err);
    assert.ok(fs.existsSync(path.join(cache, 'ledger.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'ledger.json'), 'utf8')).rows.length, 1);
    const dots = run(args(path.join(cache, '..', 'escape.json')));
    assert.equal(dots.code, 1);
    assert.ok(!fs.existsSync(path.join(cache, '..', 'escape.json')));
    const link = path.join(cache, 'link');
    let linked = true;
    try { fs.symlinkSync(outside, link, 'junction'); } catch { linked = false; }
    if (linked) {
      const viaLink = run(args(path.join(link, 'escape2.json')));
      assert.equal(viaLink.code, 1);
      assert.ok(!fs.existsSync(path.join(outside, 'escape2.json')));
    }
    const abs = run(args(path.join(outside, 'abs.json')));
    assert.equal(abs.code, 1);
    assert.ok(!fs.existsSync(path.join(outside, 'abs.json')));
  });

  it('14: guard: paired and open counts of metric7 equal the ledger rows (one question per call)', async () => {
    const d = folder();
    const rows = [];
    const mk = (id, sec, ans) => { const qs = [q('Meter', ['A', 'B'])]; rows.push(useEntry('s14', id, sec, qs)); if (ans) rows.push(resultEntry('s14', id, sec + 7, qs, { [qs[0].question]: ans })); };
    mk('g1', 0, 'A'); mk('g2', 20, 'my words'); mk('g3', 40, null);
    rows.push(lastEntry('s14', 300));
    put(d, 's14.jsonl', rows);
    const facts = await ingestFile(path.join(d, 's14.jsonl'));
    const j = ledger(d);
    assert.equal(facts.asks.length, j.rows.filter((r) => r.answerKind === 'tap' || r.answerKind === 'typed').length);
    assert.equal(facts.openAsks.length, j.rows.filter((r) => r.answerKind === 'open').length);
  });
});
