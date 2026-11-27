/**
 * send-word.test.mjs -- card coord-clock-send.
 *
 * `node scripts/coordination/send-word.mjs --file <text> --to <name> [--to <name2> ...] --lane <lane> [--log <file>] [--no-time] [--allow-typed]`
 * reads the clock ONCE, fills the tokens TIME ("HH:MM CST") and TIME_S ("HH:MM:SS CST"), scans the filled text with scan-listed.mjs on stdin,
 * sends one lane DM per receiver, appends one log line after the sends, and prints the marker line and the filled text whole as the last output.
 * Exit 0 sent. Exit 1 the scan stopped the send or a say failed. Exit 2 a refusal (usage, no TIME token, a typed clock time).
 *
 * Rows run the real send-word.mjs as a child process. Two fake scripts stand in for lane.mjs and scan-listed.mjs, so no test sends a real DM
 * and no test writes a listed id anywhere. The seams are read only when SEND_WORD_ALLOW_ENV is exactly "1":
 * SEND_WORD_NOW_SEQ (a file with one ISO instant per line, one line is consumed per clock read), SEND_WORD_LANE_CLI, SEND_WORD_SCAN_CLI.
 *
 *   W1  a scan hit stops the send                 -> exit 1, no say call, no log line, no text on stdout
 *   W2  the scan sees the filled text             -> the stdin of the scan holds the clock time and no token
 *   W3  an unusable scan stops the send           -> scan exit 2 and a scan that cannot start: exit 1, nothing sent, no log
 *   W4  a time comes from the clock               -> TIME and TIME_S are the injected instant in Chicago time (CST and CDT); a typed time is refused
 *   W5  no TIME token is refused                  -> exit 2; --no-time passes
 *   W6  a text cut before the end                -> the block after the marker equals the filled text byte for byte (20 KB), and it is last
 *   W7  two receivers get the same text           -> two say calls, equal text, one per --to, same --lane
 *   W8  the log                                   -> no line on any stop; one line after a clean send, appended
 *   W9  a failed say                              -> exit 1, the failed receiver named on stderr and in the log line, the text still printed
 *   W10 one clock read                            -> TIME and TIME_S agree when the clock crosses a minute; one line of the sequence is consumed
 *   W11 the seams are ignored without the ALLOW variable
 *   W12 the real scan-listed passes a clean text (exit 0)
 *   W13 bad flags                                 -> exit 2 before any say call
 *   W14 a text that starts with two hyphens       -> exit 2, nothing sent
 *   W15 a log write that fails after the sends    -> exit 1, the error and the send result named, the text still printed
 * W12 skips with 'listed-id dataset absent' where the git-ignored dataset is missing (CI); it runs in a checkout that has it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEND = path.join(HERE, 'send-word.mjs');
const MARKER = '=== SEND-WORD TEXT (copy this into SendMessage, nothing else) ===';
// 2026-11-27 14:06:08 in Chicago (CST, UTC-6) and 2026-07-01 13:30:00 (CDT, UTC-5).
const T_CST = '2026-11-27T20:06:08Z';
const T_CST_LATE = '2026-11-27T20:07:02Z';
const T_CDT = '2026-07-01T18:30:00Z';
let tmp;
let fakeLane;
let fakeScan;

const FAKE_LANE = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(argv) + '\\n');
const to = argv[argv.indexOf('--to') + 1];
const fail = (process.env.FAKE_SAY_FAIL || '').split(',').filter(Boolean);
if (process.env.FAKE_SAY_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SAY_SLEEP)));
if (fail.includes(to)) {
  const code = Number(process.env.FAKE_SAY_EXIT || 1);
  console.error(code === 1 ? 'not confirmed: fake failure' : 'fake hard failure');
  process.exit(code);
}
console.log('sent to ' + to);
`;
const FAKE_SCAN = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_DIR;
fs.writeFileSync(path.join(dir, 'scan-in.txt'), fs.readFileSync(0));
fs.appendFileSync(path.join(dir, 'scan-args.txt'), process.argv.slice(2).join(' ') + '\\n');
process.exit(Number(process.env.FAKE_SCAN_EXIT || 0));
`;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'send-word-test-'));
  fakeLane = path.join(tmp, 'fake-lane.mjs');
  fakeScan = path.join(tmp, 'fake-scan.mjs');
  fs.writeFileSync(fakeLane, FAKE_LANE);
  fs.writeFileSync(fakeScan, FAKE_SCAN);
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function newCase(text, { clock = [T_CST], log = null } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  const file = path.join(dir, 'word.txt');
  fs.writeFileSync(file, text);
  const seq = path.join(dir, 'clock-seq.txt');
  fs.writeFileSync(seq, `${clock.join('\n')}\n`);
  const logFile = log === null ? path.join(dir, 'milestone.md') : log;
  return { dir, file, seq, logFile };
}
const callsOf = (c) => {
  const f = path.join(c.dir, 'calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

function run(c, argv, env = {}) {
  const r = spawnSync(process.execPath, [SEND, ...argv], {
    env: { ...process.env, SEND_WORD_ALLOW_ENV: '1', SEND_WORD_NOW_SEQ: c.seq, SEND_WORD_LANE_CLI: fakeLane, SEND_WORD_SCAN_CLI: fakeScan, FAKE_DIR: c.dir, ...env },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const baseArgs = (c, extra = []) => ['--file', c.file, '--to', 'alpha', '--lane', 'coord-clock-send', '--log', c.logFile, ...extra];
const printedText = (out) => out.slice(out.indexOf(`${MARKER}\n`) + MARKER.length + 1);

describe('W1 a scan hit stops the send', () => {
  it('exits 1 with no say call, no log line and no text on stdout', () => {
    const c = newCase('Seat word at TIME: one line.\n');
    const r = run(c, baseArgs(c), { FAKE_SCAN_EXIT: '1' });
    assert.equal(r.code, 1);
    assert.equal(callsOf(c).length, 0);
    assert.equal(fs.existsSync(c.logFile), false);
    assert.equal(r.out, '');
    assert.match(r.err, /scan/i);
  });
});

describe('W2 the scan sees the filled text', () => {
  it('feeds the scan the text with the clock time and no token, on stdin', () => {
    const c = newCase('Word at TIME and TIME_S now.\n');
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 0, r.err);
    const seen = fs.readFileSync(path.join(c.dir, 'scan-in.txt'), 'utf8');
    assert.match(seen, /14:06 CST/);
    assert.match(seen, /14:06:08 CST/);
    assert.doesNotMatch(seen, /\bTIME(_S)?\b/);
    assert.match(fs.readFileSync(path.join(c.dir, 'scan-args.txt'), 'utf8'), /^-$/m);
  });
});

describe('W3 an unusable scan stops the send', () => {
  it('scan exit 2 sends nothing and writes no log', () => {
    const c = newCase('Word at TIME.\n');
    const r = run(c, baseArgs(c), { FAKE_SCAN_EXIT: '2' });
    assert.equal(r.code, 1);
    assert.equal(callsOf(c).length, 0);
    assert.equal(fs.existsSync(c.logFile), false);
    assert.equal(r.out, '');
  });
  it('a scan that cannot start sends nothing and writes no log', () => {
    const c = newCase('Word at TIME.\n');
    const r = run(c, baseArgs(c), { SEND_WORD_SCAN_CLI: path.join(c.dir, 'no-such-scan.mjs') });
    assert.equal(r.code, 1);
    assert.equal(callsOf(c).length, 0);
    assert.equal(fs.existsSync(c.logFile), false);
    assert.equal(r.out, '');
  });
});

describe('W4 a time comes from the clock', () => {
  it('fills TIME and TIME_S from the injected instant in Chicago time (CST)', () => {
    const c = newCase('Clock read TIME; with seconds TIME_S.\n');
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 0, r.err);
    assert.equal(printedText(r.out), 'Clock read 14:06 CST; with seconds 14:06:08 CST.\n');
    assert.equal(callsOf(c)[0][1], 'Clock read 14:06 CST; with seconds 14:06:08 CST.');
  });
  it('uses the CDT label in summer', () => {
    const c = newCase('At TIME_S.\n', { clock: [T_CDT] });
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 0, r.err);
    assert.equal(printedText(r.out), 'At 13:30:00 CDT.\n');
  });
  it('refuses a typed clock time by default: exit 2, nothing sent, no log', () => {
    const c = newCase('Merged at 13:59 and noted at TIME.\n');
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 2);
    assert.equal(callsOf(c).length, 0);
    assert.equal(fs.existsSync(c.logFile), false);
    assert.equal(r.out, '');
    assert.match(r.err, /typed/i);
  });
  it('--allow-typed passes the typed time and the log line records the flag', () => {
    const c = newCase('GitHub merged at 13:59; noted at TIME.\n');
    const r = run(c, baseArgs(c, ['--allow-typed']));
    assert.equal(r.code, 0, r.err);
    assert.equal(printedText(r.out), 'GitHub merged at 13:59; noted at 14:06 CST.\n');
    assert.match(fs.readFileSync(c.logFile, 'utf8'), /typed-time allowed/);
  });
  it('the filled time is never a time typed in the file: a file with no typed time and a different clock gives the clock', () => {
    const c = newCase('Now TIME.\n', { clock: ['2026-11-27T15:00:00Z'] });
    const r = run(c, baseArgs(c));
    assert.equal(printedText(r.out), 'Now 09:00 CST.\n');
  });
});

describe('W5 no TIME token', () => {
  it('is refused: exit 2, nothing sent, no log', () => {
    const c = newCase('A word with no time token.\n');
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 2);
    assert.equal(callsOf(c).length, 0);
    assert.equal(fs.existsSync(c.logFile), false);
  });
  it('passes with --no-time', () => {
    const c = newCase('A word with no time token.\n');
    const r = run(c, baseArgs(c, ['--no-time']));
    assert.equal(r.code, 0, r.err);
    assert.equal(callsOf(c).length, 1);
    assert.equal(printedText(r.out), 'A word with no time token.\n');
  });
});

describe('W6 a text cut before the end', () => {
  it('prints the filled text whole after the marker, byte for byte, as the last output (20 KB)', () => {
    const lines = ['Head at TIME_S.'];
    for (let i = 0; i < 320; i++) lines.push(`Row ${i} of the long word, padded with some plain words to make it long.`);
    lines.push('Last line ends here.');
    const text = `${lines.join('\n')}\n`;
    assert.ok(text.length > 20000);
    const c = newCase(text);
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 0, r.err);
    const expected = text.replace('TIME_S', '14:06:08 CST');
    assert.equal(printedText(r.out), expected);
    assert.ok(r.out.endsWith(expected), 'the text is the last output');
    assert.equal(r.out.split(MARKER).length, 2, 'one marker line');
    assert.equal(callsOf(c)[0][1], expected.replace(/\n+$/, ''));
  });
});

describe('W6b a text too long for one command line', () => {
  it('is refused: exit 2, nothing sent, no log', () => {
    const c = newCase(`Word at TIME.\n${'a long plain line of words\n'.repeat(1200)}`);
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 2);
    assert.equal(callsOf(c).length, 0);
    assert.equal(fs.existsSync(c.logFile), false);
  });
});

describe('W7 two receivers get the same text', () => {
  it('makes one say call per --to with equal text and the same lane', () => {
    const c = newCase('Shared word at TIME.\n');
    const r = run(c, ['--file', c.file, '--to', 'alpha', '--to', 'beta', '--lane', 'coord-clock-send', '--log', c.logFile]);
    assert.equal(r.code, 0, r.err);
    const calls = callsOf(c);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'say');
    assert.equal(calls[0][1], calls[1][1]);
    assert.deepEqual(calls.map((x) => x[x.indexOf('--to') + 1]), ['alpha', 'beta']);
    assert.deepEqual(calls.map((x) => x[x.indexOf('--lane') + 1]), ['coord-clock-send', 'coord-clock-send']);
  });
});

describe('W8 the log', () => {
  it('writes one line after a clean send, appended to what is there', () => {
    const c = newCase('Logged word at TIME.\n');
    fs.writeFileSync(c.logFile, '- earlier entry\n');
    const r = run(c, ['--file', c.file, '--to', 'alpha', '--to', 'beta', '--lane', 'coord-clock-send', '--log', c.logFile]);
    assert.equal(r.code, 0, r.err);
    const log = fs.readFileSync(c.logFile, 'utf8');
    assert.ok(log.startsWith('- earlier entry\n'));
    const added = log.slice('- earlier entry\n'.length).split('\n').filter(Boolean);
    assert.equal(added.length, 1);
    assert.match(added[0], /14:06 CST/);
    assert.match(added[0], /alpha/);
    assert.match(added[0], /beta/);
    assert.match(added[0], /Logged word/);
  });
  it('writes no line on any stop: scan hit, scan error, no token, typed time', () => {
    const cases = [
      [newCase('Word TIME.\n'), { FAKE_SCAN_EXIT: '1' }],
      [newCase('Word TIME.\n'), { FAKE_SCAN_EXIT: '2' }],
      [newCase('Word.\n'), {}],
      [newCase('Word 12:00 TIME.\n'), {}],
    ];
    for (const [c, env] of cases) {
      const r = run(c, baseArgs(c), env);
      assert.notEqual(r.code, 0);
      assert.equal(fs.existsSync(c.logFile), false);
    }
  });
});

describe('W9 a failed say', () => {
  it('exits 1, names the failed receiver, marks it in the log, and still prints the scanned text', () => {
    const c = newCase('Two receivers at TIME.\n');
    const r = run(c, ['--file', c.file, '--to', 'alpha', '--to', 'beta', '--lane', 'coord-clock-send', '--log', c.logFile], { FAKE_SAY_FAIL: 'beta', FAKE_SAY_EXIT: '3' });
    assert.equal(r.code, 1);
    assert.match(r.err, /beta/);
    assert.match(r.err, /alpha/);
    assert.equal(callsOf(c).length, 2);
    assert.match(fs.readFileSync(c.logFile, 'utf8'), /FAILED: beta/);
    assert.equal(printedText(r.out), 'Two receivers at 14:06 CST.\n');
  });
});

describe('W10 one clock read', () => {
  it('shows the same minute for TIME and TIME_S when the clock crosses a minute, and consumes one line', () => {
    const c = newCase('Pair TIME and TIME_S.\n', { clock: [T_CST, T_CST_LATE] });
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 0, r.err);
    assert.equal(printedText(r.out), 'Pair 14:06 CST and 14:06:08 CST.\n');
    assert.deepEqual(fs.readFileSync(c.seq, 'utf8').split('\n').filter(Boolean), [T_CST_LATE]);
  });
});

describe('W11 the seams are ignored without SEND_WORD_ALLOW_ENV', () => {
  it('readClock, laneCliPath and scanCliPath give the real values', async () => {
    const m = await import(pathToFileURL(SEND).href);
    const c = newCase('x\n');
    const env = { SEND_WORD_NOW_SEQ: c.seq, SEND_WORD_LANE_CLI: fakeLane, SEND_WORD_SCAN_CLI: fakeScan };
    const real = m.readClock(env);
    assert.ok(Math.abs(real.getTime() - Date.now()) < 60000, 'the real clock, not the sequence file');
    assert.match(m.laneCliPath(env).replace(/\\/g, '/'), /\.claude\/scripts\/lane\.mjs$/);
    assert.match(m.scanCliPath(env).replace(/\\/g, '/'), /scripts\/coordination\/scan-listed\.mjs$/);
    const withAllow = m.readClock({ ...env, SEND_WORD_ALLOW_ENV: '1' });
    assert.equal(withAllow.toISOString(), '2026-11-27T20:06:08.000Z');
    assert.equal(m.laneCliPath({ ...env, SEND_WORD_ALLOW_ENV: '1' }), fakeLane);
  });
  it('ALLOW must be exactly 1', async () => {
    const m = await import(pathToFileURL(SEND).href);
    assert.match(m.scanCliPath({ SEND_WORD_ALLOW_ENV: 'true', SEND_WORD_SCAN_CLI: fakeScan }).replace(/\\/g, '/'), /scan-listed\.mjs$/);
  });
});

describe('W12 the real scan-listed passes a clean text', () => {
  it('exit 0 with the real scan and a fake lane CLI', (t) => {
    // The listed-id dataset is git-ignored: a checkout without it (CI) makes scan-listed exit 2 for every text. That row only runs where the dataset is.
    const probe = spawnSync(process.execPath, [path.join(HERE, 'scan-listed.mjs'), '-'], { input: 'plain\n', encoding: 'utf8' });
    if (probe.status === 2) { t.skip('listed-id dataset absent'); return; }
    const c = newCase('A plain clean word at TIME.\n');
    const r = run(c, baseArgs(c), { SEND_WORD_SCAN_CLI: '' });
    assert.equal(r.code, 0, r.err);
    assert.equal(callsOf(c).length, 1);
  });
});

describe('W14 a text that starts with two hyphens', () => {
  it('is refused: exit 2, nothing sent, no log', () => {
    const c = newCase('--force is a flag word at TIME.\n');
    const r = run(c, baseArgs(c));
    assert.equal(r.code, 2);
    assert.equal(callsOf(c).length, 0);
    assert.equal(fs.existsSync(c.logFile), false);
    assert.equal(r.out, '');
  });
});

describe('W15 a log write that fails after the sends', () => {
  it('names the error, keeps the send result, still prints the text, exits 1', () => {
    const c = newCase('Logged word at TIME.\n');
    const blocker = path.join(c.dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const r = run(c, ['--file', c.file, '--to', 'alpha', '--lane', 'coord-clock-send', '--log', path.join(blocker, 'sub', 'milestone.md')]);
    assert.equal(r.code, 1);
    assert.equal(callsOf(c).length, 1, 'the say call was made');
    assert.match(r.err, /sent to alpha/);
    assert.match(r.err, /log line was NOT written/);
    assert.equal(printedText(r.out), 'Logged word at 14:06 CST.\n');
  });
});

describe('W13 bad flags', () => {
  const cases = [
    ['no --to', (c) => ['--file', c.file, '--lane', 'coord-clock-send']],
    ['no --lane', (c) => ['--file', c.file, '--to', 'alpha']],
    ['no --file', () => ['--to', 'alpha', '--lane', 'coord-clock-send']],
    ['an unknown flag', (c) => [...baseArgs(c), '--frobnicate']],
    ['a missing file', (c) => ['--file', path.join(c.dir, 'nope.txt'), '--to', 'alpha', '--lane', 'coord-clock-send']],
  ];
  for (const [name, args] of cases) {
    it(`${name}: exit 2 and no say call`, () => {
      const c = newCase('Word TIME.\n');
      const r = run(c, args(c));
      assert.equal(r.code, 2);
      assert.equal(callsOf(c).length, 0);
    });
  }
});

// Card coord-followups-1127. W16 to W19 and W21 fail on main 5e496be1.
//   W16  a say that exits 1 ("not confirmed", lane.mjs M4.1) -> stderr and log say UNCONFIRMED and that the DM may already be on the board, not FAILED
//   W17  a say that exits with another code                   -> stays FAILED (guards the split)
//   W18  17000 double quotes (17 KB raw, over 32000 units once Windows escapes each quote) -> exit 2, "command line", nothing sent
//   W19  20000 backslashes then a quote (the backslashes double before the quote)           -> exit 2, nothing sent
//   W21  a say that outlives the say timeout                  -> UNCONFIRMED (the insert may have run), not FAILED
describe('W16 a say that exits 1 is unconfirmed, not failed', () => {
  it('names the receiver as unconfirmed on stderr and in the log, and says it may already be on the board', () => {
    const c = newCase('Two receivers at TIME.\n');
    const r = run(c, ['--file', c.file, '--to', 'alpha', '--to', 'beta', '--lane', 'coord-clock-send', '--log', c.logFile], { FAKE_SAY_FAIL: 'beta' });
    assert.equal(r.code, 1);
    assert.match(r.err, /unconfirmed/i);
    assert.match(r.err, /already be on the board/i);
    const log = fs.readFileSync(c.logFile, 'utf8');
    assert.match(log, /UNCONFIRMED: beta/);
    assert.doesNotMatch(log, /FAILED: beta/);
    assert.equal(printedText(r.out), 'Two receivers at 14:06 CST.\n');
  });
});

describe('W17 a say that exits with another code stays failed', () => {
  it('says failed on stderr and FAILED in the log, not unconfirmed', () => {
    const c = newCase('One receiver at TIME.\n');
    const r = run(c, ['--file', c.file, '--to', 'beta', '--lane', 'coord-clock-send', '--log', c.logFile], { FAKE_SAY_FAIL: 'beta', FAKE_SAY_EXIT: '3' });
    assert.equal(r.code, 1);
    assert.match(r.err, /say failed for beta/);
    const log = fs.readFileSync(c.logFile, 'utf8');
    assert.match(log, /FAILED: beta/);
    assert.doesNotMatch(log, /UNCONFIRMED/);
  });
});

describe('W18 and W19 the length limit counts the command line as Windows escapes it', () => {
  for (const [name, body] of [['17000 double quotes', '"'.repeat(17000)], ['20000 backslashes then a quote', `${'\\'.repeat(20000)}"`]]) {
    it(`refuses ${name} with exit 2 and sends nothing`, () => {
      const c = newCase(`${body} at TIME.\n`);
      const r = run(c, baseArgs(c));
      assert.equal(r.code, 2, r.err.slice(0, 300));
      assert.match(r.err, /command line/i);
      assert.equal(callsOf(c).length, 0);
      assert.equal(fs.existsSync(c.logFile), false);
    });
  }
});

describe('W21 a say that outlives the say timeout is unconfirmed', () => {
  it('reports UNCONFIRMED, since the insert may have run', () => {
    const c = newCase('Slow say at TIME.\n');
    const r = run(c, baseArgs(c), { FAKE_SAY_SLEEP: '3000', SEND_WORD_SAY_TIMEOUT_MS: '500' });
    assert.equal(r.code, 1, r.err.slice(0, 300));
    assert.match(r.err, /unconfirmed/i);
    assert.match(fs.readFileSync(c.logFile, 'utf8'), /UNCONFIRMED: alpha/);
  });
});
