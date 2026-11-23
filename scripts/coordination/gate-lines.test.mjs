// Tests for scripts/coordination/gate-lines.mjs (card coord-seat-gate-line).
// The seat writes one GATE line per seat word in the seat log. The script reads the log (never writes it) and counts words and
// the waits the seat caused, from those lines. The form is in the header comment of gate-lines.mjs.
//
// How it can fail, one test each:
//   G1  a valid line is not parsed into its fields (kind, receiver, head, time as an instant, ask)
//   G2  a bad field (unknown kind, time with no offset, ask after time, bad head, extra token, wrong order) is counted as a
//       word, or is dropped with no trace: it must be listed with its line number and counted nowhere
//   G3  a prose line that says GATE in the middle, a bullet "- GATE ...", and a line "GATE prep: ..." count as words
//   G4  the window filter reads a time as an instant (a UTC time and a -06:00 time of one instant are one time)
//   G5  words an hour and the by-kind counts are wrong, with and without NEXT-CARD
//   G6  waits: two overlapping asks count twice in the union; the sum and the union per 112 minutes are wrong; an ask before
//       the window is not cut at the window start
//   G7  a line with ask=- adds a wait
//   G8  zero GATE lines passes as "0 words" (exit 0) instead of exit 3; --allow-empty does not turn that off
//   G9  an exact duplicate line counts twice
//   G10 the line helper prints a line that count does not accept (round trip), or writes a file
//   G11 the count output holds a PR number for a log that has one in prose
//   H1  --ask 18:08 is not read as the latest 18:08 that is not after now
//   H2  the line helper needs --at (the seat typed wrong times): without it the time is the clock
//   H3  an ask after the time is printed instead of refused
//   H4  a clock time after midnight reads the evening before as today
//   H5  the receiver keeps a space (a session name has spaces)
// Pure functions for the rules, the real script for the exit codes. No database, no network. A scratch folder for files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'gate-lines.mjs');
const lib = () => import(pathToFileURL(SCRIPT).href);
const kept = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'gatelines-')); kept.push(d); return d; };
after(() => { for (const d of kept) rmSync(d, { recursive: true, force: true }); });

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000, ...opts });
const D = '2026-11-22';
const at = (hm) => `${D}T${hm}-06:00`;
const gate = (hm, kind, to, head, ask) => `GATE ${at(hm)} kind=${kind} to=${to} head=${head} ask=${ask === '-' ? '-' : at(ask)}`;

// The sample log: 6 words. Waits: L1 17:50-18:00 (10), L2 18:00-18:10 (10), L5 18:25-18:30 (5), L6 18:05-18:35 (30).
// Union of the four = 17:50 to 18:35 = 45 minutes. Sum = 55.
const L1 = gate('18:00', 'GO', 'Coord_hooks', 'aaaaaaa', '17:50');
const L2 = gate('18:10', 'LAND-WORD', 'Coord_standard', 'bbbbbbb', '18:00');
const L3 = gate('18:12', 'LAND-HOLD', 'all', '-', '-');
const L4 = gate('18:20', 'LAND-DONE', 'Coord_standard', 'bbbbbbb', '-');
const L5 = gate('18:30', 'NEXT-CARD', 'Coord_hooks', '-', '18:25');
const L6 = gate('18:35', 'RULING', 'Status_band', '-', '18:05');
const LOG = [L1, L2, L3, L4, L5, L6].join('\n') + '\n';
const FROM = at('17:30');
const TO = at('18:50');

const counted = async (text, opts = {}) => {
  const m = await lib();
  return m.countText(text, { fromMs: Date.parse(FROM), toMs: Date.parse(TO), ...opts });
};

test('G1 a valid line parses into kind, receiver, head, instants and ask', async () => {
  const m = await lib();
  const r = m.parseGateLine(L2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.line.kind, 'LAND-WORD');
  assert.equal(r.line.to, 'Coord_standard');
  assert.equal(r.line.head, 'bbbbbbb');
  assert.equal(r.line.timeMs, Date.parse(at('18:10')));
  assert.equal(r.line.askMs, Date.parse(at('18:00')));
  const upper = m.parseGateLine(`GATE ${at('18:10')} kind=GO to=A head=BBBBBBB ask=-`);
  assert.equal(upper.line.head, 'bbbbbbb', 'a head is compared in lower case');
  const none = m.parseGateLine(L3);
  assert.equal(none.ok, true);
  assert.equal(none.line.head, '-');
  assert.equal(none.line.askMs, null);
});

test('G2 every bad field is listed with its line number and counted nowhere', async () => {
  const bad = [
    ['unknown kind', `GATE ${at('18:00')} kind=PING to=A head=aaaaaaa ask=-`, /kind/],
    ['time with no offset', `GATE ${D}T18:00 kind=GO to=A head=aaaaaaa ask=-`, /time/],
    ['ask after time', `GATE ${at('18:00')} kind=GO to=A head=aaaaaaa ask=${at('18:30')}`, /ask is after/],
    ['head too short', `GATE ${at('18:00')} kind=GO to=A head=abc ask=-`, /head/],
    ['head not hex', `GATE ${at('18:00')} kind=GO to=A head=zzzzzzz ask=-`, /head/],
    ['extra token', `GATE ${at('18:00')} kind=GO to=A head=aaaaaaa ask=- why=x`, /fields/],
    ['fields in another order', `GATE ${at('18:00')} to=A kind=GO head=aaaaaaa ask=-`, /field 2/],
    ['missing ask', `GATE ${at('18:00')} kind=GO to=A head=aaaaaaa`, /fields/],
    ['empty receiver', `GATE ${at('18:00')} kind=GO to= head=aaaaaaa ask=-`, /receiver/],
    ['an all-digit receiver (a PR number)', `GATE ${at('18:00')} kind=GO to=684 head=aaaaaaa ask=-`, /receiver/],
  ];
  const text = [L1, ...bad.map((b) => b[1]), L2].join('\n') + '\n';
  const c = await counted(text);
  assert.equal(c.inWindow, 2, 'only the two good lines count');
  assert.equal(c.bad.length, bad.length);
  bad.forEach((b, i) => {
    assert.equal(c.bad[i].n, i + 2, `${b[0]}: line number`);
    assert.match(c.bad[i].reason, b[2], `${b[0]}: the reason names the field`);
  });
});

test('G12 a double space, a tab, a no-break space or a BOM is a bad line, never a silent drop', async () => {
  const text = [
    '﻿' + L1, // a BOM before line 1: the line still counts
    L2.replace('GATE ', 'GATE  '),
    L3.replace('GATE ', 'GATE\t'),
    L4.replace('GATE ', 'GATE '),
    L5.replace(' kind=', '  kind='),
  ].join('\n') + '\n';
  const c = await counted(text);
  assert.equal(c.inWindow, 1, 'the BOM line counts, the four others do not');
  assert.equal(c.bad.length, 4, 'each of the four is listed');
  assert.deepEqual(c.bad.map((b) => b.n), [2, 3, 4, 5]);
});

test('G13 a GATE line inside a code fence is an example, not a word', async () => {
  const text = ['The form:', '```', L1, L2, '```', L3, '~~~', L4, '~~~', L5].join('\n') + '\n';
  const c = await counted(text);
  assert.equal(c.inWindow, 2, 'L3 and L5 only');
  assert.equal(c.read, 2);
});

test('G14 a bad-line reason never echoes the log text (a PR number in a field)', async () => {
  const c = await counted(`GATE ${at('18:00')} kind=PR-684 to=A head=aaaaaaa ask=-\nGATE ${at('18:00')} kind=GO to=PR4242x head=zz684zz ask=-\n`);
  assert.equal(c.bad.length, 2);
  assert.doesNotMatch(JSON.stringify(c.bad), /684|4242/);
  const dir = scratch();
  const file = join(dir, 'log.md');
  writeFileSync(file, `GATE ${at('18:00')} kind=PR-684 to=A head=aaaaaaa ask=-\n${L1}\n`);
  const r = run(['count', '--file', file, '--from', FROM, '--to', TO]);
  assert.doesNotMatch(r.stdout + r.stderr, /684/);
});

test('G15 exit codes: 1 for --strict with a bad line, 2 for usage errors, 3 lists why when the lines are bad', () => {
  const dir = scratch();
  const file = join(dir, 'log.md');
  writeFileSync(file, `${L1}\nGATE ${at('18:01')} kind=PING to=A head=- ask=-\n`);
  const base = ['count', '--file', file, '--from', FROM, '--to', TO];
  assert.equal(run(base).status, 0, 'a bad line alone does not fail without --strict');
  const strict = run([...base, '--strict']);
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout, /bad line 2/);
  for (const [name, args] of [
    ['an unknown flag with a value', [...base, '--frm', '18:00']],
    ['an unknown switch', [...base, '--verbose']],
    ['a flag with no value', ['count', '--file']],
    ['--since with --from', ['count', '--file', file, '--since', '3h', '--from', FROM, '--to', TO]],
    ['a missing log', ['count', '--file', join(dir, 'none.md'), '--from', FROM, '--to', TO]],
    ['an extra word', [...base, 'now']],
    ['no command', []],
    ['an empty window', ['count', '--file', file, '--from', TO, '--to', FROM]],
    ['an unknown flag for line', ['line', '--kind', 'GO', '--to', 'x', '--why', 'y']],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
  }
  // Every line in the window is bad: exit 3, and it says how many are bad and why.
  writeFileSync(file, `GATE ${at('18:01')} kind=PING to=A head=- ask=-\n`);
  const none = run(base);
  assert.equal(none.status, 3);
  assert.match(none.stderr, /1 read, 1 bad/);
  assert.match(none.stderr, /bad line 1: unknown kind/);
});

test('G16 one instant written with Z and with an offset is one word', async () => {
  const z = 'GATE 2026-11-23T00:00Z kind=GO to=A head=aaaaaaa ask=-';
  const off = `GATE ${at('18:00')} kind=GO to=A head=aaaaaaa ask=-`;
  const c = await counted([z, off].join('\n') + '\n');
  assert.equal(c.inWindow, 1);
  assert.equal(c.duplicates, 1);
});

test('G3 prose that says GATE, a bullet, and a "GATE prep:" line are no words and no bad lines', async () => {
  const text = [
    `- ${L1}`,
    `The GATE line ${L2} sits in a sentence.`,
    '   ' + L3,
    'GATE prep: pre-pr bug bundle, rebased',
    'GATEKEEPER kind=GO',
    L4,
  ].join('\n') + '\n';
  const c = await counted(text);
  assert.equal(c.inWindow, 1, 'only the column-0 line counts');
  assert.equal(c.bad.length, 0);
});

test('G4 the window reads times as instants, across offsets and across the day change', async () => {
  const m = await lib();
  const utc = 'GATE 2026-11-23T00:15Z kind=GO to=A head=aaaaaaa ask=-'; // 18:15 at -06:00
  const text = [L1, L2, L3, utc, L4, L6].join('\n') + '\n';
  const c = m.countText(text, { fromMs: Date.parse(at('18:05')), toMs: Date.parse(at('18:25')) });
  assert.equal(c.inWindow, 4, 'L2 18:10, L3 18:12, the UTC 18:15 line and L4 18:20');
  const midnight = 'GATE 2026-11-23T00:05-06:00 kind=GO to=A head=aaaaaaa ask=2026-11-22T23:55-06:00';
  const c2 = m.countText(midnight + '\n', { fromMs: Date.parse('2026-11-22T23:00-06:00'), toMs: Date.parse('2026-11-23T01:00-06:00') });
  assert.equal(c2.inWindow, 1);
  assert.equal(c2.waits.sumMin, 10);
});

test('G5 words an hour and by kind, with and without NEXT-CARD', async () => {
  const c = await counted(LOG);
  assert.equal(c.inWindow, 6);
  assert.equal(c.withoutNextCard, 5);
  assert.equal(c.windowMin, 80);
  assert.equal(c.perHour, 4.5);
  assert.equal(c.perHourWithoutNextCard, 3.8);
  assert.deepEqual(c.byKind, { GO: 1, 'LAND-WORD': 1, 'LAND-HOLD': 1, 'LAND-DONE': 1, 'NEXT-CARD': 1, RULING: 1 });
});

test('G6 waits: sum, union and union per 112 minutes; an ask before the window is cut at the window start', async () => {
  const c = await counted(LOG);
  assert.equal(c.waits.count, 4);
  assert.equal(c.waits.sumMin, 55);
  assert.equal(c.waits.unionMin, 45);
  assert.equal(c.waits.per112, 63);
  const cut = (await lib()).countText(LOG, { fromMs: Date.parse(at('18:00')), toMs: Date.parse(TO) });
  // The window starts at 18:00: L1 [17:50,18:00] shrinks to 0 minutes, the others keep their length.
  assert.equal(cut.waits.sumMin, 45);
  assert.equal(cut.waits.unionMin, 35, 'union 18:00 to 18:35');
  // The window starts at 18:05 inside L2's wait (18:00 to 18:10): only 18:05 to 18:10 counts. L1 ends before the window: no wait.
  const midCut = (await lib()).countText(LOG, { fromMs: Date.parse(at('18:05')), toMs: Date.parse(TO) });
  assert.equal(midCut.inWindow, 5, 'L2 to L6');
  assert.equal(midCut.waits.count, 3, 'L2, L5, L6');
  assert.equal(midCut.waits.sumMin, 40, 'L2 5 + L5 5 + L6 30');
  assert.equal(midCut.waits.unionMin, 30, 'union 18:05 to 18:35');
  // The window ends at 18:20: a word after it still counts the minutes of its wait inside the window (L6 18:05 to 18:20),
  // and a wait that starts at or after the end (L5, ask 18:25) counts none.
  const endCut = (await lib()).countText(LOG, { fromMs: Date.parse(FROM), toMs: Date.parse(at('18:20')) });
  assert.equal(endCut.inWindow, 4, 'L1 to L4 are the words of the window');
  assert.equal(endCut.waits.count, 3);
  assert.equal(endCut.waits.sumMin, 35);
  assert.equal(endCut.waits.unionMin, 30, 'union 17:50 to 18:20');
});

test('G7 a line with ask=- adds no wait', async () => {
  const c = await counted([L3, L4].join('\n') + '\n');
  assert.equal(c.inWindow, 2);
  assert.equal(c.waits.count, 0);
  assert.equal(c.waits.sumMin, 0);
  assert.equal(c.waits.unionMin, 0);
});

test('G8 zero GATE lines is exit 3, never "0 words"; --allow-empty turns it off', () => {
  const dir = scratch();
  const file = join(dir, 'log.md');
  writeFileSync(file, '- LAND HOLD 684 (18:22 CST): no pre-pr starts.\nGATE prep: a lane title\n');
  const args = ['count', '--file', file, '--from', FROM, '--to', TO];
  const r = run(args);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /0 GATE lines/);
  assert.equal(r.stdout.trim(), '', 'a zero prints no counts on stdout: "0 words" is no result');
  const ok = run([...args, '--allow-empty']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // Lines in the file but none in the window: also exit 3, with the number read.
  writeFileSync(file, L1 + '\n');
  const out = run(['count', '--file', file, '--from', at('19:00'), '--to', at('20:00')]);
  assert.equal(out.status, 3);
  assert.match(out.stdout + out.stderr, /0 GATE lines in the window \(1 read, 0 bad\)/);
});

test('G9 an exact duplicate line counts once', async () => {
  const c = await counted([L1, L1, L2, L2, L2].join('\n') + '\n');
  assert.equal(c.inWindow, 2);
  assert.equal(c.duplicates, 3);
});

test('G10 the line helper prints a line that count accepts, and writes no file', () => {
  const dir = scratch();
  const before = readdirSync(dir).length;
  const r = run(['line', '--kind', 'LAND-WORD', '--to', 'Coord hooks', '--head', 'C40558C4', '--at', at('18:22'), '--ask', at('18:08')], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const printed = r.stdout.trim();
  assert.equal(printed, `GATE ${at('18:22')} kind=LAND-WORD to=Coord_hooks head=c40558c4 ask=${at('18:08')}`);
  assert.equal(readdirSync(dir).length, before, 'no file written');
  const file = join(dir, 'log.md');
  writeFileSync(file, printed + '\n');
  const c = run(['count', '--file', file, '--from', FROM, '--to', TO, '--json']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(JSON.parse(c.stdout).inWindow, 1);
});

test('G11 the count output holds no PR number that the log names in prose', () => {
  const dir = scratch();
  const file = join(dir, 'log.md');
  writeFileSync(file, `- LAND WORD 684 (18:22 CST) PR 4242 is open\n${L1}\n${L2}\n`);
  const r = run(['count', '--file', file, '--from', FROM, '--to', TO]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /4242|684/);
});

test('H1 --ask HH:mm is the latest such clock time that is not after now', async () => {
  const m = await lib();
  const now = Date.parse(at('18:22'));
  const offsetMin = -360;
  assert.equal(m.resolveClock('18:08', now, offsetMin), Date.parse(at('18:08')));
  assert.equal(m.resolveClock('18:22', now, offsetMin), now, 'the same minute is now');
  assert.equal(m.resolveClock(at('17:00'), now, offsetMin), Date.parse(at('17:00')), 'a full time passes through');
});

test('H4 a clock time later than now reads the day before (after midnight, 23:50 is yesterday)', async () => {
  const m = await lib();
  const now = Date.parse('2026-11-23T00:10-06:00');
  assert.equal(m.resolveClock('23:50', now, -360), Date.parse('2026-11-22T23:50-06:00'));
});

test('H2 without --at the time is the clock, with the local offset', async () => {
  const m = await lib();
  const now = Date.parse(at('18:22'));
  const text = m.formatLine({ kind: 'GO', to: 'Coord hooks', head: undefined, ask: '18:08' }, { nowMs: now, offsetMin: -360 });
  assert.equal(text, `GATE ${at('18:22')} kind=GO to=Coord_hooks head=- ask=${at('18:08')}`);
  const cli = run(['line', '--kind', 'GO', '--to', 'x']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout.trim(), /^GATE \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2} kind=GO to=x head=- ask=-$/);
});

test('H3 an ask later than the time is refused, nothing is printed', () => {
  const r = run(['line', '--kind', 'GO', '--to', 'x', '--at', at('18:00'), '--ask', at('18:30')]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /ask/i);
  const bad = run(['line', '--kind', 'PING', '--to', 'x']);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout.trim(), '');
  const pr = run(['line', '--kind', 'GO', '--to', '684']);
  assert.equal(pr.status, 2, 'an all-digit receiver (a PR number) is refused');
  assert.equal(pr.stdout.trim(), '');
});

test('H6 a clock time on a DST day takes the offset of its own instant', async () => {
  const m = await lib();
  const change = Date.parse('2026-11-01T07:00Z'); // US fall back: 02:00 CDT is 07:00Z
  const offsetAt = (ms) => (ms < change ? -300 : -360);
  const now = Date.parse('2026-11-01T14:00Z'); // 08:00 CST
  const r = m.resolveTime('00:30', now, -360, offsetAt);
  assert.equal(r.ms, Date.parse('2026-11-01T05:30Z'), '00:30 that day was CDT');
  assert.equal(r.text, '2026-11-01T00:30-05:00');
  assert.equal(m.resolveClock('07:30', now, -360, offsetAt), Date.parse('2026-11-01T13:30Z'), 'after the change: the offset of now');
  const spring = Date.parse('2026-03-08T08:00Z'); // US spring forward: 02:00 CST is 08:00Z
  const offSpring = (ms) => (ms < spring ? -360 : -300);
  const s = m.resolveTime('01:30', Date.parse('2026-03-08T20:00Z'), -300, offSpring);
  assert.equal(s.ms, Date.parse('2026-03-08T07:30Z'), '01:30 that day was CST');
  assert.equal(s.text, '2026-03-08T01:30-06:00');
});

test('H7 an offset with minutes (+05:30, -03:30) is written and read right', async () => {
  const m = await lib();
  const noon = Date.parse('2026-11-22T12:00Z');
  assert.equal(m.formatTime(noon, 330), '2026-11-22T17:30+05:30');
  assert.equal(m.formatTime(noon, -210), '2026-11-22T08:30-03:30');
  assert.equal(m.resolveClock('17:00', noon, 330), Date.parse('2026-11-22T11:30Z'));
  assert.equal(m.resolveClock('08:00', noon, -210), Date.parse('2026-11-22T11:30Z'));
  assert.equal(m.parseGateLine('GATE 2026-11-22T17:30+05:30 kind=GO to=A head=- ask=-').line.timeMs, noon);
});

test('H5 a receiver with spaces prints with underscores', async () => {
  const m = await lib();
  const text = m.formatLine({ kind: 'GO', to: 'RE program seat', head: 'abcdef1' }, { nowMs: Date.parse(at('18:00')), offsetMin: -360 });
  assert.match(text, / to=RE_program_seat /);
});
