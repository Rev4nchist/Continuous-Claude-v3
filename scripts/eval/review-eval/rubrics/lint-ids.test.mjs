// Tests for lint-ids.mjs. All ids are made up (9000 and up) and all files are in temp folders.
// No real config, dataset or gold file is read. Every CLI run passes --gold <temp folder> or --no-gold,
// so the default gold folder is never opened. Each test names the change that breaks it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { GOLD_DIR } from '../gold.mjs';
import { forbiddenParts, forbiddenSet, goldChoice, scanRubrics } from './lint-ids.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'lint-ids.mjs');
const BASE = 'a2'.repeat(20);
const HEAD = 'b1'.repeat(20);
const TIP = 'c3'.repeat(20);
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'lint-ids-')); made.push(d); return d; };
const CFG = { holdoutExclude: [], reserve: [] };
const DS = { prs: [{ pr: 9001, real_major: 1 }], findings: [{ pr: 9001, severity: 'major', verdict: 'real' }] };
const goldRow = (over = {}) => ({
  id: 'g-lint-1', source: 'A', suite: 'regression', split: 'dev',
  target: { pr: 9200, round: 1, sha40: TIP }, file: 'src/made-up.mjs', severity: 'major', linkType: 'same-file',
  labels: [{ by: 'agent-claude', verdict: 'real' }], provenance: { note: 'made-up fixture' }, ...over,
});
const goldRows = () => [goldRow(), goldRow({ id: 'g-lint-2', source: 'B', target: { range: `${BASE}..${HEAD}` } })];
// A full-width digit string, built from code points: a typed full-width character can be changed by an editor.
const fullWidth = (digits) => [...digits].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');

/** Writes the files of one CLI run into a temp folder and returns the paths. */
function setup({ cfg = CFG, ds = DS, md = { 'a.md': 'one\ntwo\n' }, gold = null } = {}) {
  const dir = tmp();
  const out = { config: path.join(dir, 'config.json'), dataset: path.join(dir, 'dataset.json'), rubrics: path.join(dir, 'rubrics'), gold: path.join(dir, 'gold') };
  writeFileSync(out.config, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  writeFileSync(out.dataset, typeof ds === 'string' ? ds : JSON.stringify(ds));
  mkdirSync(out.rubrics);
  for (const [n, t] of Object.entries(md)) writeFileSync(path.join(out.rubrics, n), t);
  if (gold) { mkdirSync(out.gold); writeFileSync(path.join(out.gold, 'g.json'), JSON.stringify(gold)); }
  return out;
}
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const baseArgs = (p) => ['--config', p.config, '--dataset', p.dataset, '--rubrics', p.rubrics];
/** mode: 'no-gold' (default), 'gold' (the temp gold folder) or 'none' (no gold flag: only for a run that must stop before gold). */
const argsOf = (p, mode = 'no-gold') => [...baseArgs(p), ...{ 'no-gold': ['--no-gold'], gold: ['--gold', p.gold], none: [] }[mode]];
const noTrace = (r) => assert.ok(!/\n\s+at /.test(`${r.stdout}\n${r.stderr}`), `stack trace in output: ${r.stderr}`);
const scanText = (text, set, file = 'a.md') => {
  const dir = tmp();
  writeFileSync(path.join(dir, file), text);
  return scanRubrics(dir, set);
};

test('forbiddenSet holds holdout and reserve PRs, not dev PRs (breaks if setOf is not used or dev joins the set)', () => {
  const dataset = { prs: [{ pr: 9001 }, { pr: 9002 }, { pr: 9003 }], findings: [{ pr: 9004 }] };
  const cfg = { holdoutExclude: [9002], reserve: [{ pr: 9003 }, { pr: 9010 }] };
  const set = forbiddenSet({ cfg, dataset, goldRows: [] });
  assert.deepEqual([...set].sort(), ['9001', '9003', '9004', '9010']);
});

test('forbiddenSet: a reserve PR that is also in holdoutExclude is still forbidden (breaks if dev wins over reserve)', () => {
  const set = forbiddenSet({ cfg: { holdoutExclude: [9005], reserve: [{ pr: 9005 }] }, dataset: { prs: [{ pr: 9005 }], findings: [] }, goldRows: [] });
  assert.ok(set.has('9005'));
});

test('forbiddenSet: every gold row of every split adds its PR and its sha40, and a range adds both SHAs, all in lower case (breaks if a split is skipped, a side or sha40 is lost, or case is kept)', () => {
  const rows = [
    goldRow({ split: 'dev' }),
    goldRow({ id: 'g-2', split: 'holdout', source: 'C', target: { repo: 'made-up/repo', pr: 9201, round: 1, sha40: TIP.toUpperCase() } }),
    goldRow({ id: 'g-3', source: 'B', target: { range: `${BASE.toUpperCase()}..${HEAD}` } }),
    goldRow({ id: 'g-4', source: 'B', target: { range: `refs/eval/seed/s1..${HEAD}` } }),
  ];
  const args = { cfg: CFG, dataset: { prs: [], findings: [] }, goldRows: rows };
  assert.deepEqual([...forbiddenSet(args)].sort(), ['9200', '9201', BASE, HEAD, TIP].sort());
  const parts = forbiddenParts(args);
  assert.deepEqual([...parts.goldPr].sort(), ['9200', '9201']);
  assert.deepEqual([...parts.goldSha].sort(), [BASE, HEAD, TIP].sort());
});

test('forbiddenParts counts each source apart (breaks if holdout, reserve and gold ids are mixed into one count)', () => {
  const dataset = { prs: [{ pr: 9001 }, { pr: 9003 }], findings: [] };
  const parts = forbiddenParts({ cfg: { holdoutExclude: [], reserve: [{ pr: 9003 }, { pr: 9010 }] }, dataset, goldRows: goldRows() });
  assert.deepEqual([...parts.holdout], ['9001']);
  assert.deepEqual([...parts.reserve].sort(), ['9003', '9010']);
  assert.equal(parts.goldPr.size, 1);
  assert.equal(parts.goldSha.size, 3);
});

test('scanRubrics counts files and tokens and reports hit lines (breaks if the token regex, the count or the line number is wrong)', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.md'), 'plain 12 words\nsee 9001 here\nand 9002\n');
  writeFileSync(path.join(dir, 'b.txt'), '9001\n');
  assert.deepEqual(scanRubrics(dir, new Set(['9001'])), { files: 1, tokens: 3, hits: [{ file: 'a.md', line: 2 }] });
});

test('scanRubrics finds a digit id glued to letters, an underscore or hex letters, and a zero-padded id, but not a longer number (breaks if a word edge is used instead of a digit edge)', () => {
  const lines = ['pr_9123', 'id9123', 'r9123', 'dead9123beef', 'id 009123', 'long 91234', 'short 912', 'x912y'];
  const r = scanText(lines.join('\n'), new Set(['9123']));
  assert.deepEqual(r.hits.map((h) => h.line), [1, 2, 3, 4, 5]);
});

test('scanRubrics matches a hex run in lower case, by a 7+ char prefix of a full SHA, with a -g prefix, and with a glued hex letter (breaks if the match is exact, case-sensitive, edge-bound or limited to 40 chars)', () => {
  const lines = [
    `x ${HEAD.slice(0, 9).toUpperCase()} y`, `full ${BASE}`, `short ${HEAD.slice(0, 6)}`, `other ${'f9'.repeat(8)}`,
    `glued a${HEAD}`, `describe v2-4-g${BASE.slice(0, 9)}`,
  ];
  const r = scanText(lines.join('\n'), new Set([HEAD, BASE]));
  assert.deepEqual(r.hits.map((h) => h.line), [1, 2, 5, 6]);
});

test('scanRubrics reads the text in NFKC form: a full-width id hits (breaks if the scan reads the raw text)', () => {
  assert.equal(scanText(`id ${fullWidth('9123')}\n`, new Set(['9123'])).hits.length, 1);
});

test('scanRubrics splits lines on CR, CRLF and LF (breaks if a line break kind is missed and the line number drifts)', () => {
  const r = scanText('one\rtwo\r\nthree 9123\nfour', new Set(['9123']));
  assert.deepEqual(r.hits, [{ file: 'a.md', line: 3 }]);
});

test('scanRubrics reads .md in any case and refuses a symlink entry (breaks if the extension match is case-sensitive or a link is followed)', (t) => {
  assert.equal(scanText('9123\n', new Set(['9123']), 'A.MD').files, 1);
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.md'), 'one\n');
  try { symlinkSync(path.join(dir, 'a.md'), path.join(dir, 'link.md')); } catch { t.skip('no right to create a symlink here'); return; }
  assert.throws(() => scanRubrics(dir, new Set(['9123'])), /--rubrics/);
});

test('CLI: a hit exits 1 and prints counts and file:line only, never the id (breaks if the token or exit code leaks)', () => {
  const r = run(argsOf(setup({ md: { 'a.md': 'one\nsee 9001 here\n' } })));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /files 1, tokens 1, forbidden-set size 1, hits 1/);
  assert.match(r.stdout, /holdout 1, reserve 0, gold-pr 0, gold-sha 0/);
  assert.match(r.stdout, /small-ids 0/);
  assert.match(r.stdout, /HIT a\.md:2/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('9001'));
  noTrace(r);
});

test('CLI: no hit exits 0 (breaks if a clean folder fails)', () => {
  const r = run(argsOf(setup({ md: { 'a.md': 'one 12 two\n' } })));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /files 1, tokens 1, forbidden-set size 1, hits 0/);
  assert.ok(!r.stdout.includes('HIT'));
});

test('CLI: a .MD file is scanned (breaks if the extension match is case-sensitive and the guard passes on a skipped file)', () => {
  const r = run(argsOf(setup({ md: { 'A.MD': '9001\n' } })));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /files 1/);
});

test('CLI: small-ids counts the forbidden ids under the digit floor and never prints them (breaks if the count is missing or wrong)', () => {
  const r = run(argsOf(setup({ cfg: { holdoutExclude: [], reserve: [{ pr: 12 }] } })));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /small-ids 1/);
  assert.ok(!/(^|\D)12(\D|$)/.test(r.stdout), 'the forbidden id is printed');
});

test('CLI: gold SHAs, sha40 and gold PRs are forbidden and counted per source, never printed (breaks if --gold is ignored, sha40 is lost or a SHA is echoed)', () => {
  const p = setup({ md: { 'a.md': `9200\nsha ${HEAD.slice(0, 10)}\nclean 7\n` }, gold: goldRows() });
  const r = run(argsOf(p, 'gold'));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /forbidden-set size 5, hits 2/);
  assert.match(r.stdout, /holdout 1, reserve 0, gold-pr 1, gold-sha 3/);
  assert.match(r.stdout, /HIT a\.md:1/);
  assert.match(r.stdout, /HIT a\.md:2/);
  const all = `${r.stdout}${r.stderr}`;
  for (const bad of ['9200', HEAD.slice(0, 8), BASE.slice(0, 8), TIP.slice(0, 8)]) assert.ok(!all.includes(bad));
});

test('CLI: reserve beats dev in the CLI too (breaks if the CLI reads holdoutExclude without cfg.reserve)', () => {
  const p = setup({ cfg: { holdoutExclude: [9001], reserve: [{ pr: 9001 }] }, md: { 'a.md': '9001\n' } });
  assert.equal(run(argsOf(p)).status, 1);
});

test('CLI: --help, no args, a missing flag, an unknown flag and --gold with --no-gold print usage and exit 2 (breaks if the main guard fails open or a flag is optional)', () => {
  const p = setup({ gold: goldRows() });
  const cases = [['--help'], [], ['--dataset', p.dataset], ['--config', p.config], ['--config', p.config, '--dataset'], [...argsOf(p), '--bogus', 'x'], [...argsOf(p, 'gold'), '--no-gold']];
  for (const args of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /usage/i);
    noTrace(r);
  }
});

test('goldChoice: no flag means the default gold folder, --gold means that folder, --no-gold means skip (breaks if the gold check stops being the default)', () => {
  assert.deepEqual(goldChoice({}), { skip: false, dir: GOLD_DIR });
  assert.deepEqual(goldChoice({ '--gold': 'x' }), { skip: false, dir: 'x' });
  assert.deepEqual(goldChoice({ '--no-gold': true }), { skip: true });
});

test('CLI: a missing path names its flag and exits 2 with no output on stdout (breaks if a read error becomes a pass or a stack trace)', () => {
  const p = setup();
  const nope = (n) => path.join(os.tmpdir(), `no-such-${n}`);
  const cases = [
    ['--config', ['--config', nope(9001), '--dataset', p.dataset, '--rubrics', p.rubrics, '--no-gold']],
    ['--dataset', ['--config', p.config, '--dataset', nope(9002), '--rubrics', p.rubrics, '--no-gold']],
    ['--rubrics', ['--config', p.config, '--dataset', p.dataset, '--rubrics', nope(9003), '--no-gold']],
    ['--gold', [...baseArgs(p), '--gold', nope(9004)]],
  ];
  for (const [flag, args] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `${flag}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes(flag), `${flag} not named: ${r.stderr}`);
    assert.equal(r.stdout, '');
    noTrace(r);
  }
});

test('CLI: invalid JSON exits 2, names the flag and never echoes the file text (breaks if a parse message is printed)', () => {
  for (const [flag, bad] of [['--config', { cfg: '{ "marker-9007": oops' }], ['--dataset', { ds: '{ "marker-9007": oops' }]]) {
    const r = run(argsOf(setup(bad)));
    assert.equal(r.status, 2, r.stdout);
    assert.ok(r.stderr.includes(flag));
    assert.ok(!`${r.stdout}${r.stderr}`.includes('marker-9007'));
    noTrace(r);
  }
});

test('CLI: a dataset of the wrong shape, a bad reserve list and a string holdoutExclude exit 2 (breaks if a shape error escapes as a crash or a pass)', () => {
  const r1 = run(argsOf(setup({ ds: { prs: 'x' } })));
  assert.equal(r1.status, 2);
  assert.ok(r1.stderr.includes('--dataset'));
  const r2 = run(argsOf(setup({ cfg: { holdoutExclude: [], reserve: 'x' } })));
  assert.equal(r2.status, 2);
  assert.ok(r2.stderr.includes('--config'));
  const r3 = run(argsOf(setup({ cfg: { holdoutExclude: 'x', reserve: [] } })));
  assert.equal(r3.status, 2);
  assert.ok(r3.stderr.includes('--config'));
  for (const r of [r1, r2, r3]) { assert.equal(r.stdout, ''); noTrace(r); }
});

test('CLI: a dataset that gives zero PRs exits 2, never a pass (breaks if an empty dataset is accepted)', () => {
  const r = run(argsOf(setup({ ds: { prs: [], findings: [] } })));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('--dataset'));
  assert.equal(r.stdout, '');
});

test('CLI: an empty forbidden set exits 2, never a pass (breaks if an empty set is accepted)', () => {
  const r = run(argsOf(setup({ cfg: { holdoutExclude: [9001], reserve: [] } })));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty/);
  assert.match(r.stderr, /--config/);
  assert.equal(r.stdout, '');
});

test('CLI: a rubrics folder with no .md file exits 2, never a pass (breaks if zero files count as a pass)', () => {
  const r = run(argsOf(setup({ md: { 'a.txt': '9001' } })));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('--rubrics'));
});

test('CLI: a symlink in the rubrics folder exits 2 (breaks if a link is followed)', (t) => {
  const p = setup({ md: { 'a.md': 'one\n' } });
  try { symlinkSync(path.join(p.rubrics, 'a.md'), path.join(p.rubrics, 'link.md')); } catch { t.skip('no right to create a symlink here'); return; }
  const r = run(argsOf(p));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('--rubrics'));
});

test('CLI: a bad gold file exits 2, names --gold and never echoes its text (breaks if a GoldError message is printed)', () => {
  const r = run(argsOf(setup({ gold: [{ id: 'marker-9008' }] }), 'gold'));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('--gold'));
  assert.ok(!`${r.stdout}${r.stderr}`.includes('marker-9008'));
  noTrace(r);
});

test('CLI: a gold folder with zero rows exits 2 unless --no-gold is given (breaks if an empty gold folder passes)', () => {
  const p = setup({ gold: [] });
  const r = run(argsOf(p, 'gold'));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('--gold'));
  assert.equal(r.stdout, '');
  assert.equal(run(argsOf(p)).status, 0);
});

test('CLI: --no-gold runs and says on stderr that gold was skipped (breaks if the skip is silent)', () => {
  const r = run(argsOf(setup()));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /--no-gold/);
  assert.match(r.stdout, /gold-pr 0, gold-sha 0/);
});

test('importing the module runs nothing (breaks if the main guard is removed)', () => {
  const code = `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('scanRubrics skips a 1 or 2 digit integer and scans one of 3 or more digits (breaks if the MIN_INT_DIGITS floor is dropped or set wrong)', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.md'), '"version": 1, "score": 0.5\n4 rows, 3 opened, 75 percent\nsee 042 and 9420\n');
  const r = scanRubrics(dir, new Set(['1', '0', '5', '4', '3', '75', '42', '9420']));
  assert.deepEqual(r.hits, [{ file: 'a.md', line: 3 }]);
});
