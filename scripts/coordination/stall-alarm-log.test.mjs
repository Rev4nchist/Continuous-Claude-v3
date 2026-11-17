/**
 * stall-alarm-log.test.mjs -- card coord-seat-counts, part A. Design note: .claudedocs/coordination/2026-11-16-coord-seat-counts-design.md.
 *
 * No database, no GitHub: state files, logs and the outcome facts (lane events, PR facts) are built in a temp folder and passed in.
 * ALARM_LOG_CLI points the tests at another copy of the script (a mutation run). Test names A1..A11 are the failure list of the note.
 * The file name has no `.db.` part: test CO1 in pre-pr.test.mjs ties the pre-pr list and the CI list together.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.ALARM_LOG_CLI ? path.resolve(process.env.ALARM_LOG_CLI) : path.join(HERE, 'stall-alarm-log.mjs');
const load = () => import(pathToFileURL(SCRIPT).href);

const T = Date.parse('2026-11-16T22:00:00.000Z');
const MIN = 60_000;
const NOTE_AT = '2026-11-16T21:40:00.000Z';

let tmp;
let EMPTY;
let n = 0;
const folder = () => { const d = path.join(tmp, `case${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
const run = (args) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: tmp }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-alarm-log-')); EMPTY = path.join(tmp, 'empty-root'); fs.mkdirSync(EMPTY); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const state = (said) => ({ said, green: {} });
function listRoot() {
  const root = folder();
  fs.mkdirSync(path.join(root, '.claudedocs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'eval', 'review-eval'), { recursive: true });
  write(path.join(root, DATASET_REL), { prs: [{ pr: 7654321 }], findings: [{ pr: 7654321, comment_id: 1234567890 }] });
  write(path.join(root, EVAL_CONFIG_REL), {});
  return root;
}

describe('part A: reading the state file', () => {
  it('A1: each key shape maps to its kind and subject; no sha beyond 8 hex and no note time is stored', () => {
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    write(st, state({
      'ci-failed 624@abcdef1234567890': T + 1, 'pr-green 624@abcdef1234567890': T + 2,
      [`waits coord-ask-ledger ${NOTE_AT}`]: T + 3, [`start PRE-PR coord-ask-ledger ${NOTE_AT}`]: T + 4, [`start HOOK BUILD coord-x ${NOTE_AT}`]: T + 5,
      'error lane board': T + 6, 'error github': T + 7,
    }));
    const r = run(['--append', '--state', st, '--log', log, '--root', EMPTY]);
    assert.equal(r.code, 0, r.err);
    const rows = lines(log).map((l) => JSON.parse(l));
    const by = Object.fromEntries(rows.map((x) => [`${x.kind}${x.sub ? `:${x.sub}` : ''}`, x]));
    assert.deepEqual(Object.keys(by).sort(), ['ci-failed', 'pr-green', 'start-no-end:HOOK BUILD', 'start-no-end:PRE-PR', 'waits-on-seat', 'watch-error']);
    assert.equal(rows.length, 7); // the two watch-error keys are two rows
    assert.equal(by['ci-failed'].subject, '624');
    assert.equal(by['ci-failed'].head8, 'abcdef12');
    assert.equal(by['pr-green'].head8, null);
    assert.equal(by['waits-on-seat'].subject, 'coord-ask-ledger');
    assert.equal(by['start-no-end:HOOK BUILD'].subject, 'coord-x');
    assert.equal(by['start-no-end:PRE-PR'].alarmAt, T + 4);
    const text = fs.readFileSync(log, 'utf8');
    assert.ok(!text.includes('abcdef1234567890') && !text.includes(NOTE_AT), 'a full sha or a note time was stored');
  });

  it('A2: the same alarm is appended once, whatever the number of runs', () => {
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    write(st, state({ [`waits lane-a ${NOTE_AT}`]: T }));
    assert.equal(JSON.parse(run(['--append', '--state', st, '--log', log, '--root', EMPTY]).out).appended, 1);
    const second = run(['--append', '--state', st, '--log', log, '--root', EMPTY]);
    assert.equal(second.code, 0);
    assert.equal(JSON.parse(second.out).appended, 0);
    assert.equal(lines(log).length, 1);
  });

  it('A3: the same key with a later alarm time (a re-alarm after 60 minutes) is a new row', () => {
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    write(st, state({ [`waits lane-a ${NOTE_AT}`]: T }));
    run(['--append', '--state', st, '--log', log, '--root', EMPTY]);
    write(st, state({ [`waits lane-a ${NOTE_AT}`]: T + 61 * MIN }));
    run(['--append', '--state', st, '--log', log, '--root', EMPTY]);
    assert.deepEqual(lines(log).map((l) => JSON.parse(l).alarmAt), [T, T + 61 * MIN]);
  });

  it('A3b: two start alarms of one lane at one time (PRE-PR and HOOK BUILD) are two rows', () => {
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    write(st, state({ [`start PRE-PR lane-a ${NOTE_AT}`]: T }));
    run(['--append', '--state', st, '--log', log, '--root', EMPTY]);
    write(st, state({ [`start PRE-PR lane-a ${NOTE_AT}`]: T, [`start HOOK BUILD lane-a ${NOTE_AT}`]: T })); // the second run adds an alarm of the other kind at the same time
    run(['--append', '--state', st, '--log', log, '--root', EMPTY]);
    assert.deepEqual(lines(log).map((l) => JSON.parse(l).sub).sort(), ['HOOK BUILD', 'PRE-PR']);
  });

  it('A4: the log is appended, never rewritten: old lines stay byte for byte', () => {
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    const old = `{"kind":"waits-on-seat","sub":null,"subject":"old-1","head8":null,"alarmAt":1}\n{ odd spacing  "kind":"x" }\n`;
    write(log, old);
    write(st, state({ [`waits lane-b ${NOTE_AT}`]: T }));
    assert.equal(run(['--append', '--state', st, '--log', log, '--root', EMPTY]).code, 0);
    const now = fs.readFileSync(log, 'utf8');
    assert.ok(now.startsWith(old), 'the old lines changed');
    assert.equal(now.slice(old.length).split('\n').filter(Boolean).length, 1);
  });
});

describe('part A: the log file', () => {
  it('A4b: a log whose last line has no newline keeps both rows readable after an append', () => {
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    write(log, '{"kind":"waits-on-seat","sub":null,"subject":"old-1","head8":null,"alarmAt":1}'); // no final newline
    write(st, state({ [`waits lane-b ${NOTE_AT}`]: T }));
    assert.equal(run(['--append', '--state', st, '--log', log, '--root', EMPTY]).code, 0);
    assert.deepEqual(lines(log).map((l) => JSON.parse(l).subject), ['old-1', 'lane-b']);
  });
});

describe('part A: outcomes from later events', () => {
  const row = (kind, subject, extra = {}) => ({ kind, sub: null, subject, head8: null, alarmAt: T, ...extra });
  const infer = async (rows, facts, opts = {}) => (await load()).inferOutcomes(rows, facts, { windowMin: 30, now: T + 120 * MIN, ...opts }).map((r) => r.outcome);

  it('A5: a lane event counts only after the alarm and inside the window', async () => {
    const ev = (at) => ({ events: [{ laneId: 'lane-a', kind: 'note', at }], prs: {} });
    assert.deepEqual(await infer([row('waits-on-seat', 'lane-a')], ev(T - MIN)), ['none']);
    assert.deepEqual(await infer([row('waits-on-seat', 'lane-a')], ev(T + 31 * MIN)), ['none']);
    assert.deepEqual(await infer([row('waits-on-seat', 'lane-a')], ev(T + 10 * MIN)), ['acted']);
    assert.deepEqual(await infer([row('start-no-end', 'lane-a', { sub: 'PRE-PR' })], ev(T + 30 * MIN)), ['acted']);
    // An event of another lane never counts.
    assert.deepEqual(await infer([row('waits-on-seat', 'lane-a')], { events: [{ laneId: 'lane-b', kind: 'note', at: T + MIN }], prs: {} }), ['none']);
  });

  it('A6: a seeded event is not an action', async () => {
    assert.deepEqual(await infer([row('waits-on-seat', 'lane-a')], { events: [{ laneId: 'lane-a', kind: 'seeded', at: T + MIN }], prs: {} }), ['none']);
  });

  it('A7: an alarm younger than the window with no event yet is open, not none', async () => {
    assert.deepEqual(await infer([row('waits-on-seat', 'lane-a')], { events: [], prs: {} }, { now: T + 5 * MIN }), ['open']);
    // An event inside the window wins over open.
    assert.deepEqual(await infer([row('waits-on-seat', 'lane-a')], { events: [{ laneId: 'lane-a', kind: 'note', at: T + MIN }], prs: {} }, { now: T + 5 * MIN }), ['acted']);
  });

  it('A8: a PR alarm is read from PR facts: merged in the window, closed in the window, or a changed head', async () => {
    const g = (prs, k = 'pr-green', extra = {}) => infer([row(k, '624', extra)], { events: [], prs });
    assert.deepEqual(await g({ 624: { mergedAt: T + 10 * MIN, closedAt: T + 10 * MIN, head8: 'aaaaaaaa' } }), ['acted']);
    assert.deepEqual(await g({ 624: { mergedAt: T + 40 * MIN, closedAt: T + 40 * MIN, head8: 'aaaaaaaa' } }), ['none']);
    assert.deepEqual(await g({ 624: { mergedAt: null, closedAt: null, head8: 'aaaaaaaa' } }), ['none']);
    assert.deepEqual(await g({ 624: { mergedAt: null, closedAt: T + 5 * MIN, head8: 'aaaaaaaa' } }, 'ci-failed', { head8: 'aaaaaaaa' }), ['acted']);
    const head = (headAt) => g({ 624: { mergedAt: null, closedAt: null, head8: 'bbbbbbbb', headAt } }, 'ci-failed', { head8: 'aaaaaaaa' });
    assert.deepEqual(await head(T + 10 * MIN), ['acted']);
    assert.deepEqual(await head(T + 40 * MIN), ['none']); // a push hours later is not an answer to the alarm
    assert.deepEqual(await head(null), ['none']);
    assert.deepEqual(await head(T - MIN), ['none']);
    assert.deepEqual(await g({ 624: { mergedAt: null, closedAt: T + 5 * MIN, head8: 'aaaaaaaa' } }, 'pr-green'), ['none']); // closed, not merged: the green alarm is not answered
    assert.deepEqual(await g({ 624: { mergedAt: null, closedAt: null, head8: 'aaaaaaaa' } }, 'ci-failed', { head8: 'aaaaaaaa' }), ['none']);
    assert.deepEqual(await g({}, 'pr-green'), ['none']); // no fact for this PR: no claim of action
    assert.deepEqual(await infer([row('watch-error', 'github')], { events: [], prs: {} }), ['na']);
  });

  it('A18: a ci-failed row stays acted when a second push comes after the window (the first head change counts, not the newest)', async () => {
    const g = (commits, extra = {}) => infer([row('ci-failed', '624', { head8: 'aaaaaaaa' })], { events: [], prs: { 624: { mergedAt: null, closedAt: null, head8: 'cccccccc', headAt: T + 300 * MIN, commits, ...extra } } });
    const c = (head8, at) => ({ head8, at });
    assert.deepEqual(await g([c('bbbbbbbb', T + 10 * MIN), c('cccccccc', T + 300 * MIN)]), ['acted']); // push inside, a second push hours later
    assert.deepEqual(await g([c('cccccccc', T + 300 * MIN)]), ['none']); // only a push after the window
    assert.deepEqual(await g([c('bbbbbbbb', T - 10 * MIN)]), ['none']); // a push before the alarm
    assert.deepEqual(await g([c('aaaaaaaa', T + 10 * MIN)]), ['none']); // the same head is no change
    assert.deepEqual(await g([]), ['none']); // no commits, and the newest head came after the window (headAt T+300): the old rule says none too
    // A PR of more than 100 commits: the list is cut and has no in-window commit, but the newest head (head8, headAt) is a change inside the window.
    assert.deepEqual(await g([c('cccccccc', T + 300 * MIN)], { head8: 'bbbbbbbb', headAt: T + 10 * MIN }), ['acted']);
    // A row with no head (validRow accepts null) cannot tell a head change: no commit counts.
    const noHead = await infer([row('ci-failed', '624', { head8: null })], { events: [], prs: { 624: { mergedAt: null, closedAt: null, head8: 'bbbbbbbb', headAt: T + 10 * MIN, commits: [c('bbbbbbbb', T + 10 * MIN)] } } });
    assert.deepEqual(noHead, ['none']);
    assert.deepEqual(await g([c('cccccccc', T + 300 * MIN)], { mergedAt: T + 10 * MIN }), ['acted']); // merged inside the window, as before
    assert.deepEqual(await g([c('cccccccc', T + 300 * MIN)], { closedAt: T + 10 * MIN }), ['acted']); // closed inside the window, as before
  });

  it('A19: a pr-green row ignores commits, and a facts file with no commits list keeps the old head rule', async () => {
    const green = await infer([row('pr-green', '624')], { events: [], prs: { 624: { mergedAt: null, closedAt: null, head8: 'bbbbbbbb', commits: [{ head8: 'bbbbbbbb', at: T + 10 * MIN }] } } });
    assert.deepEqual(green, ['none']);
    const old = await infer([row('ci-failed', '624', { head8: 'aaaaaaaa' })], { events: [], prs: { 624: { mergedAt: null, closedAt: null, head8: 'bbbbbbbb', headAt: T + 10 * MIN } } });
    assert.deepEqual(old, ['acted']);
  });

  it('A20: commitHeads keeps only the 8-hex head and the commit time of each commit, in time order', async () => {
    const m = await load();
    const list = [
      { sha: 'cccccccc11223344', commit: { committer: { date: '2026-11-16T22:30:00Z' }, message: 'a message that must not be kept', author: { email: 'x@example.invalid' } } },
      { sha: 'bbbbbbbb11223344', commit: { committer: { date: '2026-11-16T22:10:00Z' } } },
      { sha: 'dddddddd11223344', commit: { committer: { date: 'not a time' } } },
      { sha: 'zz', commit: { committer: { date: '2026-11-16T22:20:00Z' } } },
      null,
    ];
    const out = m.commitHeads(list);
    assert.deepEqual(out, [{ head8: 'bbbbbbbb', at: Date.parse('2026-11-16T22:10:00Z') }, { head8: 'cccccccc', at: Date.parse('2026-11-16T22:30:00Z') }]);
    assert.ok(!JSON.stringify(out).includes('message'), 'no text of a commit is kept');
    assert.deepEqual(m.commitHeads('nope'), []);
  });

  it('A9: the report groups by Chicago day, counts each outcome, and never says "false alarm"', async () => {
    const m = await load();
    const rows = [
      { ...row('waits-on-seat', 'lane-a'), alarmAt: Date.parse('2026-11-16T05:30:00Z'), outcome: 'none' },
      { ...row('waits-on-seat', 'lane-a'), alarmAt: Date.parse('2026-11-16T06:30:00Z'), outcome: 'acted' },
      { ...row('waits-on-seat', 'lane-b'), alarmAt: Date.parse('2026-11-16T07:30:00Z'), outcome: 'open' },
    ];
    const rep = m.report(rows);
    assert.deepEqual(rep.days.map((d) => d.day), ['2026-11-15', '2026-11-16']);
    assert.deepEqual(rep.days[0].kinds['waits-on-seat'], { rows: 1, acted: 0, none: 1, open: 0, na: 0 });
    assert.deepEqual(rep.days[1].kinds['waits-on-seat'], { rows: 2, acted: 1, none: 0, open: 1, na: 0 });
    assert.ok(!/false alarm/i.test(JSON.stringify(rep)), 'the word false alarm is in the report');
    assert.equal(rep.totals['waits-on-seat'].noAction, 1);
  });
});

describe('part A: privacy and failing loud', () => {
  it('A10: a key with note text is skipped and counted; a listed id as lane id stops the run: exit 3, no file', () => {
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    write(st, state({
      'waits some free note text with an id 7654321 2026-11-16T21:40:00.000Z': T, // too many words
      'start PRE-PR some free note text here 2026-11-16T21:40:00.000Z': T, // too many words
      'waits Not_A.Lane-Id 2026-11-16T21:40:00.000Z': T, // the lane token is not a lane id
      'start HOOK BUILD Not_A.Lane-Id 2026-11-16T21:40:00.000Z': T, // the lane token is not a lane id
      'ci-failed 624@not-a-sha': T, 'whatever 1 2': T, 'waits lane-c': T, [`waits lane-d ${NOTE_AT}`]: String(T), [`waits lane-a ${NOTE_AT}`]: T,
    }));
    const ok = run(['--append', '--state', st, '--log', log, '--root', EMPTY]);
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.out).skipped, 8);
    assert.deepEqual(lines(log).map((l) => JSON.parse(l).subject), ['lane-a']);
    assert.ok(!fs.readFileSync(log, 'utf8').includes('free note text'));
    const root = listRoot();
    const log2 = path.join(d, 'alarms2.jsonl');
    write(st, state({ [`waits 1234567890 ${NOTE_AT}`]: T }));
    const bad = run(['--append', '--state', st, '--log', log2, '--root', root]);
    assert.equal(bad.code, 3);
    assert.equal(bad.out, '');
    assert.ok(!fs.existsSync(log2), 'a file was written after exit 3');
    assert.ok(!bad.err.includes('1234567890'));
  });

  it('A11: no state file, no alarm log or an empty one: exit 2 and one line', () => {
    const d = folder();
    const log = path.join(d, 'alarms.jsonl');
    const a = run(['--append', '--state', path.join(d, 'missing.json'), '--log', log, '--root', EMPTY]);
    assert.equal(a.code, 2);
    assert.equal(a.out, '');
    assert.ok(!fs.existsSync(log));
    const r1 = run(['--report', '--log', path.join(d, 'missing.jsonl'), '--root', EMPTY]);
    assert.equal(r1.code, 2);
    write(log, '');
    const r2 = run(['--report', '--log', log, '--root', EMPTY]);
    assert.equal(r2.code, 2);
    assert.equal(r2.out, '');
  });

  it('A12: --report reads the injected facts and prints counts only', () => {
    const d = folder();
    const log = path.join(d, 'alarms.jsonl');
    const rows = [
      { kind: 'waits-on-seat', sub: null, subject: 'lane-a', head8: null, alarmAt: T },
      { kind: 'pr-green', sub: null, subject: '624', head8: null, alarmAt: T },
    ];
    write(log, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const ev = path.join(d, 'events.json');
    const prs = path.join(d, 'prs.json');
    write(ev, [{ laneId: 'lane-a', kind: 'note', at: T + 5 * MIN }]);
    write(prs, { 624: { mergedAt: null, closedAt: null, head8: 'aaaaaaaa' } });
    const r = run(['--report', '--log', log, '--events-file', ev, '--prs-file', prs, '--now', new Date(T + 3 * 60 * MIN).toISOString(), '--root', EMPTY]);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.totals['waits-on-seat'].acted, 1);
    assert.equal(j.totals['pr-green'].none, 1);
    assert.ok(!r.out.includes('lane-a') && !r.out.includes('624'), 'a subject reached the report');
  });
  it('A13: --days, --window and --now are read; a log line that is not the shape of this script is ignored; a doubled row counts once', () => {
    const d = folder();
    const log = path.join(d, 'alarms.jsonl');
    const row = (subject, alarmAt, extra = {}) => ({ kind: 'waits-on-seat', sub: null, subject, head8: null, alarmAt, ...extra });
    const lines2 = [
      row('lane-a', T), row('lane-a', T), // the same alarm twice (two runs of --append at one time)
      row('lane-old', T - 3 * 86_400_000), // older than --days 1
      { kind: 'free text kind', sub: null, subject: 'lane-a', head8: null, alarmAt: T }, // foreign kind
      row('free text subject here', T), // foreign subject
    ];
    write(log, lines2.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const ev = path.join(d, 'events.json');
    const prs = path.join(d, 'prs.json');
    write(ev, [{ laneId: 'lane-a', kind: 'note', at: T + 10 * MIN }]);
    write(prs, {});
    const now = new Date(T + 3 * 60 * MIN).toISOString();
    const rep = (extra) => run(['--report', '--log', log, '--events-file', ev, '--prs-file', prs, '--now', now, '--root', EMPTY, ...extra]);
    const a = rep(['--days', '1']);
    assert.equal(a.code, 0, a.err);
    const j = JSON.parse(a.out);
    assert.deepEqual(Object.keys(j.totals), ['waits-on-seat']); // the foreign kind is not a key of the report
    assert.equal(j.totals['waits-on-seat'].rows, 1); // old row, foreign kind, foreign subject and the double are out
    assert.equal(j.totals['waits-on-seat'].acted, 1); // the default window of 30 minutes sees the event at +10
    assert.equal(JSON.parse(rep(['--days', '1', '--window', '5']).out).totals['waits-on-seat'].none, 1); // a window of 5 minutes does not
    assert.equal(JSON.parse(rep(['--days', '5']).out).totals['waits-on-seat'].rows, 2); // --days 5 takes the old row too
    for (const bad of [['--days', '0'], ['--days', 'x'], ['--window', '0'], ['--window', 'x'], ['--now', 'not a time'], ['--days']]) assert.equal(rep(bad).code, 1, JSON.stringify(bad));
    // --now is read: a report as of a time before the alarm sees no row.
    assert.equal(run(['--report', '--log', log, '--events-file', ev, '--prs-file', prs, '--now', new Date(T - 60 * MIN).toISOString(), '--days', '1', '--root', EMPTY]).code, 2);
  });

  it('A14: the report needs a readable id list: an unreadable or empty list stops it with exit 3 and no output', () => {
    const d = folder();
    const log = path.join(d, 'alarms.jsonl');
    write(log, JSON.stringify({ kind: 'waits-on-seat', sub: null, subject: '1234567890', head8: null, alarmAt: T }) + '\n');
    const ev = path.join(d, 'events.json');
    const prs = path.join(d, 'prs.json');
    write(ev, []);
    write(prs, {});
    const args = (root) => ['--report', '--log', log, '--events-file', ev, '--prs-file', prs, '--now', new Date(T + 3 * 60 * MIN).toISOString(), '--root', root];
    // The report prints no subject, so a listed id cannot reach it: the pass is a guard for a later change of the output. A good list passes.
    assert.equal(run(args(listRoot())).code, 0);
    // A list that cannot be read stops the run, and so does an empty one.
    const broken = listRoot();
    write(path.join(broken, DATASET_REL), '{ not json 4242');
    const bad = run(args(broken));
    assert.equal(bad.code, 3);
    assert.equal(bad.out, '');
    assert.ok(!bad.err.includes('4242'));
    const empty = listRoot();
    write(path.join(empty, DATASET_REL), { prs: [], findings: [] });
    assert.equal(run(args(empty)).code, 3);
  });
});

describe('part A: gold ids in the id list (card coord-content-scan-followups, item gold ids)', () => {
  it('A15: a made-up gold sha as a lane id stops --append with exit 3 and no file; with no gold folder the same run passes', async () => {
    const { GOLD_DIR_REL } = await import('./board-mask.mjs');
    const GOLD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
    const root = listRoot();
    const d = folder();
    const st = path.join(d, 'state.json');
    const log = path.join(d, 'alarms.jsonl');
    write(st, state({ [`waits ${GOLD_SHA} ${NOTE_AT}`]: T }));
    assert.equal(run(['--append', '--state', st, '--log', log, '--root', root]).code, 0); // control: not listed yet
    fs.rmSync(log, { force: true });
    fs.mkdirSync(path.join(root, GOLD_DIR_REL), { recursive: true });
    write(path.join(root, GOLD_DIR_REL, 'gold-a.json'), [{ target: { sha40: GOLD_SHA, pr: 8888 } }]);
    const bad = run(['--append', '--state', st, '--log', log, '--root', root]);
    assert.equal(bad.code, 3);
    assert.equal(bad.out, '');
    assert.ok(!fs.existsSync(log), 'a file was written after exit 3');
    assert.ok(!bad.err.includes(GOLD_SHA));
    assert.ok(bad.err.includes('a listed id reached the output'), 'exit 3 came from a list-read failure, not the id match');
  });
});
