/**
 * fleetops-html.test -- tests for the FleetOps HTML renderer, the page.md renderer, the display-text gate and the CLI (card coord-fleetops-notion).
 *
 * Every id, title and number here is MADE UP (fixtures/fleetops-mini). The fake id list is passed in or written into a fake root: a digit id
 * "4242" (a short id counts only after #, PR, pull/), a 10-char hex sha with letters, and a string id "PRRC_kwzzzz". No real id list is read.
 *
 * How it can fail, one test each (the source change that breaks it is in the test name):
 *   1. a listed id reaches the html, page.md or their decoded forms (the mask removed, the cut before the mask, or the gate removed)
 *   2. a string id (not a digit, not a sha) passes: maskListed never masks it, so only the refuse stops it
 *   3. an id written as an entity, a JSON escape, a backslash escape or a code span passes the gate (the decode removed)
 *   4. a lane title breaks out of the data block (the < > & U+2028 escape removed)
 *   5. the clock chip or a lease line shows the wrong state (the 90 min or stale rule, the lease rule)
 *   6. the pile subtitle has a wrong sign, or two axis labels collide
 *   7. the CLI leaves a half write, keeps an old output after a failure, or reads a flag without a value
 *   8. page.md misses a part of the layout the skill needs (placeholder, 2 h2, 4 callouts in columns), or holds lane text
 *   9. --check passes a page with a listed id, a missing stamp or no embed
 *  10. the template holds a colour or number that a short id matches
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { countListed, DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';
import { buildView } from './fleetops-view.mjs';
import { createServer } from 'node:http';
import * as H from './fleetops-html.mjs';
import { FILE_IDS, axisTicks, decodeDisplay, embedView, loadFiles, main, mainAsync, pageCore, produce } from './fleetops-html.mjs';

/** Invisible, bidi and compatibility characters as char codes: a source escape can turn into a raw character in this file. */
const LRM = String.fromCharCode(0x200e);
const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const FW_HASH_4242 = String.fromCharCode(0xff03, 0xff14, 0xff12, 0xff14, 0xff12);

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'fleetops-mini');
const TEMPLATE = join(HERE, 'fleetops', 'page.template.html');
const CLI = join(HERE, 'fleetops-html.mjs');
const IDS = ['4242', 'abc1234def'];
const STAMP = '2026-11-17T17:30:02.680Z';
const OUTS = ['fleetops.html', 'page.md', 'manifest.json'];

const files = () => loadFiles(FIXTURE);
const withTitle = (title, i = 1) => { const f = files(); f.lanes.rows[i].title = title; return f; };
const tmp = () => mkdtempSync(join(tmpdir(), 'fleetops-html-test-'));
const withTmp = (fn) => { const d = tmp(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const quiet = (extra = {}) => { const log = { out: [], err: [] }; return { log, deps: { out: (s) => log.out.push(s), err: (s) => log.err.push(s), ...extra } }; };
const read = (d, n) => readFileSync(join(d, n), 'utf8');

function fakeRoot(dir, commentId) {
  mkdirSync(join(dir, dirname(DATASET_REL)), { recursive: true });
  mkdirSync(join(dir, dirname(EVAL_CONFIG_REL)), { recursive: true });
  const finding = { pr: 4242, round: 'abc1234def', ...(commentId ? { comment_id: commentId } : {}) };
  writeFileSync(join(dir, DATASET_REL), JSON.stringify({ prs: [{ pr: 4242 }], findings: [finding] }));
  writeFileSync(join(dir, EVAL_CONFIG_REL), JSON.stringify({}));
  return dir;
}

/** The view JSON of a rendered page: the text of the data block. */
function dataBlock(html) {
  const open = '<script type="application/json" id="fleetops-data">';
  const from = html.indexOf(open) + open.length;
  return html.slice(from, html.indexOf('</script>', from));
}

describe('listed ids', () => {
  it('1a. KEY: no listed id in the html, page.md or their decoded forms, title cut at 60 included (break: mask removed, cut before mask, gate removed)', () => withTmp((d) => {
    const r = cli([FIXTURE, '--out', join(d, 'out'), '--ids-root', fakeRoot(join(d, 'root'))]);
    assert.equal(r.status, 0, r.stderr);
    const html = read(join(d, 'out'), 'fleetops.html');
    const page = read(join(d, 'out'), 'page.md');
    for (const text of [html, page, decodeDisplay(html), decodeDisplay(page), dataBlock(html)]) assert.equal(countListed(text, IDS), 0);
    const view = JSON.parse(dataBlock(html));
    const held = view.wip.rows.find((x) => x.id.startsWith('key-'));
    for (const field of [held.title, held.id, held.goal, held.holder]) assert.ok(field.includes('masked-id'), 'each of title, id, goal, holder is masked');
    assert.ok(JSON.parse(read(join(d, 'out'), 'manifest.json')).masked > 0);
  }));

  it('1b. an unmasked view (buildView with ids=[]) makes the CLI exit 1 and write nothing, an old output is gone (break: the gate removed)', () => withTmp((d) => {
    const out = join(d, 'out');
    mkdirSync(out);
    for (const n of OUTS) writeFileSync(join(out, n), 'old');
    const { log, deps } = quiet({ build: (f) => buildView(f, []) });
    assert.equal(main([FIXTURE, '--out', out, '--ids-root', fakeRoot(join(d, 'root'))], deps), 1);
    assert.deepEqual(readdirSync(out), []);
    assert.match(log.err.join('\n'), /listed id/);
    assert.ok(!log.err.join('\n').includes('4242'));
  }));

  it('2a. a string id (underscore) in a title makes the render refuse; maskListed cannot mask it (break: the count of non-digit ids removed)', () => {
    const f = withTitle('see PRRC_kwzzzz here');
    assert.throws(() => produce(f, ['PRRC_kwzzzz']), /listed id/);
    assert.doesNotThrow(() => produce(withTitle('see PRRC here'), ['PRRC_kwzzzz']));
  });

  it('2b. the CLI refuses the same way, exits 1, writes nothing and prints no id (break: refuse removed)', () => withTmp((d) => {
    cpSync(FIXTURE, join(d, 'in'), { recursive: true });
    const lanes = JSON.parse(readFileSync(join(d, 'in', 'lanes.json'), 'utf8'));
    lanes.rows[1].title = 'see PRRC_kwzzzz here';
    writeFileSync(join(d, 'in', 'lanes.json'), JSON.stringify(lanes));
    const r = cli([join(d, 'in'), '--out', join(d, 'out'), '--ids-root', fakeRoot(join(d, 'root'), 'PRRC_kwzzzz')]);
    assert.equal(r.status, 1);
    assert.ok(!existsSync(join(d, 'out')));
    assert.ok(!r.stderr.includes('PRRC_kwzzzz') && /listed id/.test(r.stderr));
  }));

  it('3a. an id written as an entity, a JSON escape, a backslash escape or a code span is caught (break: a decode step removed)', () => {
    const cases = ['&#35;4242', '&#x23;4242', '&num;4242', '&amp;#35;4242', '\\u00234242', '\\#4242', 'PR `4242`', 'PR&nbsp;4242', 'PR\u200b 4242', 'PR&NewLine;4242', FW_HASH_4242, `PR 42${LRM}42`];
    for (const c of cases) assert.ok(countListed(decodeDisplay(c), IDS) > 0, `decoded: ${JSON.stringify(c)}`);
    for (const c of ['&#35;4242', '&#x23;4242', '&num;4242', '&amp;#35;4242', '\\u00234242', 'PR `4242`', FW_HASH_4242, `PR 42${LRM}42`]) assert.equal(countListed(c, IDS), 0, `the plain count misses ${JSON.stringify(c)}`);
    for (const c of ['see 4242 alone', STAMP, 'a &amp; b']) assert.equal(countListed(decodeDisplay(c), IDS), 0, `no false hit: ${c}`);
  });

  it('3b. an entity-split id in a title reaches the data as text and the render refuses (break: the gate reads only the raw JSON)', () => {
    for (const t of ['ask &#35;4242 now', 'ask &num;4242 now', 'ask &#x23;4242 now']) assert.throws(() => produce(withTitle(t), IDS), /listed id/, t);
    const ok = produce(withTitle(`ask PR${' '.repeat(7)}4242.md now`), IDS);
    assert.ok(!ok.html.includes('4242') && dataBlock(ok.html).includes('PR masked-id.md'), 'a whitespace-split id is masked after the clean');
  });

  it('3c. a retired string in a title stops the render (break: the forbidden guard removed)', () => {
    for (const t of ['x board_url x', 'x {h} x', 'x claude.ai/artifact/abc x']) assert.throws(() => produce(withTitle(t), IDS), /forbidden/, t);
  });

  /** The message of a refusal, or '' when the render goes through. */
  const refusal = (f, ids = IDS, opts) => { try { produce(f, ids, opts); return ''; } catch (e) { return e.message; } };

  it('3d. a refusal names the field path and never the value (break: the path or the value in the message)', () => {
    const msg = refusal(withTitle('ask &#35;4242 now'));
    assert.match(msg, /listed id/);
    assert.match(msg, /asks\.main\[\d+\]\.title/);
    assert.ok(!msg.includes('4242') && !msg.includes('&#35;'));
    assert.match(refusal(withTitle('x board_url x')), /forbidden string at asks\.main\[\d+\]\.title/);
  });

  it('3e. a project that ends in PR next to an id that starts with a listed number is refused: the page shows them side by side (break: the leaf and pair scan removed)', () => {
    const f = files();
    f.lanes.rows[1].project = 'Review PR';
    f.lanes.rows[1].id = '4242-retry';
    const msg = refusal(f);
    assert.match(msg, /listed id/);
    assert.match(msg, /asks\.main\[\d+\]\.(id|project\+id)/);
    assert.ok(!msg.includes('4242'));
    const leafOnly = files();
    leafOnly.lanes.rows[1].project = 'Review';
    leafOnly.lanes.rows[1].id = '4242-retry-x';
    assert.match(refusal(leafOnly), /asks\.main\[\d+\]\.id/, 'a leaf that starts with a listed number is refused on its own, as #leaf');
    const plain = files();
    plain.lanes.rows[1].project = 'Review';
    plain.lanes.rows[1].id = 'retry-4242';
    assert.equal(refusal(plain), '', 'a number that no context word reaches is not an id');
  });

  it('3f. a bidi control in any field is refused, because the displayed order can differ from the code-point order (break: the bidi refuse removed)', () => {
    const inject = (title) => (f) => { const v = buildView(f, IDS); v.asks.main[0].title = title; return v; };
    const msg = refusal(files(), IDS, { build: inject(`PR ${RLO}2424${PDF}`) });
    assert.match(msg, /bidi control at asks\.main\[0\]\.title/);
    assert.equal(refusal(files(), IDS, { build: inject(`PR 24${LRM}24`) }), '', 'an LRM is only invisible: the decoded text decides');
    assert.match(refusal(files(), IDS, { build: inject('PR &#x202e;2424') }), /bidi control at asks\.main\[0\]\.title/);
  });

  it('3g. an id split by an LRM or written fullwidth is caught by the gate too, in an injected view (break: normalize or the ignorable strip removed from decodeDisplay)', () => {
    const inject = (title) => (f) => { const v = buildView(f, IDS); v.asks.main[0].title = title; return v; };
    assert.match(refusal(files(), IDS, { build: inject(`see PR 42${LRM}42`) }), /listed id/);
    assert.match(refusal(files(), IDS, { build: inject(`see ${FW_HASH_4242}`) }), /listed id/);
    assert.match(refusal(files(), IDS, { build: inject('see &#xFF03;&#xFF14;&#xFF12;&#xFF14;&#xFF12;') }), /listed id/);
  });

  it('3h. an html over 150 KB is refused (break: the size guard removed)', () => {
    const big = (f) => { const v = buildView(f, IDS); v.wip.rows[0].goal = 'word '.repeat(40000); return v; };
    assert.match(refusal(files(), IDS, { build: big }), /over 150000 bytes/);
  });
});

describe('embed view', () => {
  it('12a. the embed holds only what the page renders: no daily rows, spark, bar width, ask dates or unheld titles (break: the pick removed)', () => {
    const ev = embedView(buildView(files(), IDS));
    assert.deepEqual(Object.keys(ev).sort(), ['asks', 'dataFrom', 'exportedAt', 'masked', 'never', 'openCount', 'p0', 'pile', 'projects', 'staleAt', 'staleAtMs', 'wip']);
    assert.deepEqual(Object.keys(ev.p0).sort(), ['cap', 'open', 'unheldCount']);
    assert.equal(ev.p0.unheldCount, 1);
    const text = JSON.stringify(ev);
    for (const gone of ['"daily"', '"spark"', '"width"', '"askedAt"', '"unheld"', '"asked"', '"count":8']) assert.ok(!text.includes(gone), gone);
  });

  it('12b. every key the template reads from D exists in the embed view (break: a pick that drops a rendered field)', () => {
    const tpl = readFileSync(TEMPLATE, 'utf8');
    const ev = embedView(buildView(files(), IDS));
    const reads = new Set([...tpl.matchAll(/\bD\.(\w+)/g)].map((m) => m[1]));
    assert.ok(reads.size >= 10);
    for (const k of reads) assert.ok(k in ev, `D.${k}`);
    for (const [obj, keys] of [['asks', ['total', 'over', 'main', 'folds', 'other', 'blockedNoAsk']], ['never', ['total', 'open', 'old', 'buckets', 'top']], ['wip', ['rows', 'live', 'lapsed']]]) {
      for (const k of keys) assert.ok(k in ev[obj], `${obj}.${k}`);
    }
    const row = ev.wip.rows[0];
    for (const k of ['title', 'id', 'project', 'goal', 'holder', 'state', 'lapsed', 'leaseAt', 'lapsedOn', 'lapsedDays']) assert.ok(k in row, `wip row ${k}`);
    const ask = ev.asks.main[0];
    for (const k of ['title', 'id', 'project', 'band', 'state', 'p0', 'age']) assert.ok(k in ask, `ask row ${k}`);
  });
});

describe('loadFiles', () => {
  it('7d. exportedAt must be a non-empty string in every file: all missing, or all empty, is refused (break: the type check removed)', () => withTmp((d) => {
    cpSync(FIXTURE, join(d, 'in'), { recursive: true });
    const setAll = (value) => {
      for (const k of FILE_IDS) {
        const f = JSON.parse(readFileSync(join(d, 'in', `${k}.json`), 'utf8'));
        if (value === undefined) delete f.exportedAt; else f.exportedAt = value;
        writeFileSync(join(d, 'in', `${k}.json`), JSON.stringify(f));
      }
    };
    setAll(undefined);
    assert.throws(() => loadFiles(join(d, 'in')), /exportedAt/);
    setAll('');
    assert.throws(() => loadFiles(join(d, 'in')), /exportedAt/);
    setAll(20261117);
    assert.throws(() => loadFiles(join(d, 'in')), /exportedAt/);
    setAll(STAMP);
    assert.equal(loadFiles(join(d, 'in')).meta.exportedAt, STAMP);
  }));
});

describe('--verify-upload', () => {
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const html = Buffer.from('<!doctype html><title>x</title>');

  function serve(body, status = 200) {
    const server = createServer((req, res) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(body); });
    return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({
      url: `http://127.0.0.1:${server.address().port}/signed`, close: () => new Promise((done) => { server.close(done); server.closeAllConnections?.(); }),
    })));
  }
  const manifestFile = (d) => { const p = join(d, 'manifest.json'); writeFileSync(p, JSON.stringify({ sha256Html: sha(html) })); return p; };
  const verify = async (url, extra = []) => {
    const d = tmp();
    try {
      const { log, deps } = quiet();
      const code = await mainAsync(['--verify-upload', url, '--manifest', manifestFile(d), ...extra], deps);
      return { code, out: log.out.join('').trim(), err: log.err.join('\n') };
    } finally { rmSync(d, { recursive: true, force: true }); }
  };

  it('11a. the bytes of the url match the manifest: exit 0 and the byte count (break: the compare or the exit code)', async () => {
    const srv = await serve(html);
    try {
      const r = await verify(srv.url);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, `verify-upload: sha ok, bytes ${html.length}`);
    } finally { await srv.close(); }
  });

  it('11a2. @file: the url is read from the file, the file is deleted, and the match holds (break: @ not read, or the file kept)', async () => {
    const srv = await serve(html);
    const d = mkdtempSync(join(tmpdir(), 'fleetops-url-'));
    try {
      const urlFile = join(d, 'url.txt');
      writeFileSync(urlFile, `${srv.url}\n`);
      const r = await verify(`@${urlFile}`);
      assert.equal(r.code, 0);
      assert.equal(r.out, `verify-upload: sha ok, bytes ${html.length}`);
      assert.equal(existsSync(urlFile), false);
    } finally { rmSync(d, { recursive: true, force: true }); await srv.close(); }
  });

  it('11a3. @file that is missing or holds no http url: exit 1, no sha line (break: a bad url file passes)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'fleetops-url-'));
    try {
      const bad = join(d, 'bad.txt');
      writeFileSync(bad, 'not a url');
      for (const arg of [`@${join(d, 'missing.txt')}`, `@${bad}`]) {
        const r = await verify(arg);
        assert.equal(r.code, 1, arg);
        assert.ok(!r.out.includes('sha ok'), arg);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('11b. other bytes are a MISMATCH, exit 1 (break: a mismatch passes)', async () => {
    const other = Buffer.from('<!doctype html><title>y</title>!');
    const srv = await serve(other);
    try {
      const r = await verify(srv.url);
      assert.equal(r.code, 1);
      assert.equal(r.out, `verify-upload: MISMATCH, bytes ${other.length}`);
    } finally { await srv.close(); }
  });

  it('11c. a non-200 answer, an unreachable url and a bad argument are exit 1 with no sha ok line (break: a status or usage check removed)', async () => {
    const srv = await serve('gone', 404);
    try {
      const r = await verify(srv.url);
      assert.equal(r.code, 1);
      assert.match(r.err, /http 404/);
      assert.ok(!r.out.includes('sha ok'));
    } finally { await srv.close(); }
    const dead = await verify('http://127.0.0.1:1/none');
    assert.equal(dead.code, 1);
    assert.ok(!dead.out.includes('sha ok'));
    const { log, deps } = quiet();
    for (const argv of [['--verify-upload', 'ftp://x/y', '--manifest', 'm.json'], ['--verify-upload', 'http://127.0.0.1:1/x'], ['--manifest', 'm.json'], ['--verify-upload', 'http://127.0.0.1:1/x', '--manifest', 'm.json', '--out', 'o']]) {
      assert.equal(await mainAsync(argv, deps), 1, JSON.stringify(argv));
    }
    assert.ok(log.err.every((l) => /usage/.test(l)));
    assert.equal(log.out.length, 0);
  });

  it('11d. a manifest with no sha is refused, not matched against undefined (break: the manifest shape check)', async () => {
    const srv = await serve(html);
    const d = tmp();
    try {
      writeFileSync(join(d, 'm.json'), JSON.stringify({ htmlBytes: 5 }));
      const { log, deps } = quiet();
      assert.equal(await mainAsync(['--verify-upload', srv.url, '--manifest', join(d, 'm.json')], deps), 1);
      assert.ok(!log.out.join('').includes('sha ok'));
    } finally { rmSync(d, { recursive: true, force: true }); await srv.close(); }
  });
});

describe('data block', () => {
  it('4. a title cannot break out of the data block, and U+2028 stays escaped (break: the < > & U+2028 escape removed)', () => {
    const title = 'a </script><script>x=1</script> &amp; <i> c\u2028d\u2029e';
    const { html } = produce(withTitle(title), IDS);
    const tpl = readFileSync(TEMPLATE, 'utf8');
    assert.equal(html.split('</script').length, tpl.split('</script').length, 'no new script close');
    const block = dataBlock(html);
    assert.ok(!/[<>&\u2028\u2029]/.test(block), 'no raw < > & U+2028 U+2029 in the block');
    const view = JSON.parse(block);
    assert.equal(view.asks.main.find((r) => r.id === 'timed-reminders').title, title.replace(/\s+/g, ' '));
  });

  it('4b. the html is one file under 150 KB with the data in it and no network url (break: a link or an asset added)', () => {
    const { html } = produce(files(), IDS);
    assert.ok(Buffer.byteLength(html) < 150000);
    assert.equal(html.split('id="fleetops-data"').length, 2);
    assert.ok(!/\b(src|href)\s*=\s*["']?https?:/i.test(html) && !/@import|url\(\s*["']?https?:/i.test(html));
  });
});

describe('page clock and lease rows (the real page code, loaded from the template)', () => {
  const core = pageCore();
  const exp = Date.parse(STAMP);
  const staleAt = exp + 36 * 3600000;
  const state = (now) => { const s = core.clockState(now, exp, staleAt); return `${s.kind}|${core.clockText(s, 'Wed 18 Nov, 23:30 CST')}`; };

  it('5a. snapshot under 90 min, behind from 90 min, stale after the stale time (break: a threshold or the comparison)', () => {
    assert.equal(state(exp + 30 * 60000), 'snapshot|Snapshot, 30 min old');
    assert.equal(state(exp + 90 * 60000 - 1), 'snapshot|Snapshot, 90 min old');
    assert.equal(state(exp + 90 * 60000), 'behind|Behind, 2 h old');
    assert.equal(state(exp + 10 * 3600000), 'behind|Behind, 10 h old');
    assert.equal(state(staleAt), 'behind|Behind, 36 h old');
    assert.equal(state(staleAt + 1), 'stale|Stale since Wed 18 Nov, 23:30 CST');
    assert.equal(state(exp - 5000), 'snapshot|Snapshot, 0 min old', 'a clock before the export is age 0');
    assert.equal(String(core.clockState(exp + 9e9, exp, null).kind), 'behind', 'no stale time: never stale');
  });

  it('5b. a lease is held, ended since export, or lapsed (break: the lease rule)', () => {
    const row = { lapsed: false, leaseAt: '2026-11-18T01:00:00.000Z', lapsedOn: '' };
    const at = (now, r = row) => `${core.leaseState(now, r).kind}|${core.leaseState(now, r).text}`;
    assert.equal(at(exp + 30 * 60000), 'held|held to 19:00 at export');
    assert.equal(at(Date.parse(row.leaseAt) + 60000), 'ended|ended since export');
    assert.equal(at(exp, { lapsed: true, lapsedOn: '12 Nov', leaseAt: '2026-11-12T20:00:00.000Z' }), 'lapsed|Lapsed 12 Nov');
    assert.equal(at(exp, { lapsed: false, leaseAt: '' }), 'none|No lease time');
  });

  it('6a. the pile subtitle: sign, days and the peak (break: sign or text)', () => {
    assert.equal(core.pileSubtitle({ change: 45, span: 7, sincePeak: -5 }), '+45 in 7 d, -5 since the peak');
    assert.equal(core.pileSubtitle({ change: 26, span: 7, sincePeak: 0 }), '+26 in 7 d, at the peak');
    assert.equal(core.pileSubtitle({ change: -3, span: 6, sincePeak: -9 }), '-3 in 6 d, -9 since the peak');
  });

  it('6b. x-axis labels keep a gap, include the first and the last day, at every width (break: label spacing)', () => {
    for (let count = 2; count <= 14; count += 1) {
      for (let width = 100; width <= 900; width += 20) {
        const t = axisTicks(count, width, 56);
        assert.equal(t[0], 0);
        assert.equal(t[t.length - 1], count - 1);
        const px = width / (count - 1);
        for (let i = 1; i < t.length; i += 1) assert.ok((t[i] - t[i - 1]) * px >= 56 - 1e-9, `count ${count} width ${width}: ${t}`);
      }
    }
    assert.deepEqual(axisTicks(8, 226, 56).length, 4);
  });
});

describe('CLI', () => {
  it('7a. a good run writes 3 files and no temp file; the manifest is true (break: a write before the check, or a wrong hash or size)', () => withTmp((d) => {
    const r = cli([FIXTURE, '--out', join(d, 'out'), '--ids-root', fakeRoot(join(d, 'root'))]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(d, 'out')).sort(), [...OUTS].sort());
    const html = read(join(d, 'out'), 'fleetops.html');
    const page = read(join(d, 'out'), 'page.md');
    const m = JSON.parse(read(join(d, 'out'), 'manifest.json'));
    assert.deepEqual(Object.keys(m).sort(), ['exportedAt', 'htmlBytes', 'masked', 'pageBytes', 'sha256Html', 'sha256Page']);
    assert.deepEqual([m.exportedAt, m.htmlBytes, m.pageBytes], [STAMP, Buffer.byteLength(html), Buffer.byteLength(page)]);
    assert.equal(m.sha256Html, createHash('sha256').update(html).digest('hex'));
    assert.equal(m.sha256Page, createHash('sha256').update(page).digest('hex'));
    assert.ok(m.masked > 0 && /masked \d+ listed id\(s\)/.test(r.stderr) && r.stderr.includes('listed ids left 0'));
  }));

  it('7b. any failure leaves none of the 3 outputs, also an old set; a missing id list, a mixed export (break: delete-first removed, write order)', () => withTmp((d) => {
    const out = join(d, 'out');
    const seed = () => { mkdirSync(out, { recursive: true }); for (const n of OUTS) writeFileSync(join(out, n), 'old'); };
    seed();
    const noList = cli([FIXTURE, '--out', out, '--ids-root', join(d, 'no-root')]);
    assert.equal(noList.status, 1);
    assert.deepEqual(readdirSync(out), []);
    cpSync(FIXTURE, join(d, 'in'), { recursive: true });
    const tiles = JSON.parse(readFileSync(join(d, 'in', 'tiles.json'), 'utf8'));
    tiles.exportedAt = '2026-11-16T00:00:00.000Z';
    writeFileSync(join(d, 'in', 'tiles.json'), JSON.stringify(tiles));
    seed();
    const mixed = cli([join(d, 'in'), '--out', out, '--ids-root', fakeRoot(join(d, 'root'))]);
    assert.equal(mixed.status, 1);
    assert.match(mixed.stderr, /another export/);
    assert.deepEqual(readdirSync(out), []);
  }));

  it('7c. a flag with no value is a usage error, exit 1, and nothing is created (break: the value check)', () => withTmp((d) => {
    const root = fakeRoot(join(d, 'root'));
    for (const args of [[FIXTURE, '--out'], [FIXTURE, '--out', '--ids-root', root], [FIXTURE, '--out', join(d, 'o'), '--ids-root'], [FIXTURE], ['--out', join(d, 'o')], [FIXTURE, '--bogus', 'x', '--out', join(d, 'o')]]) {
      const r = cli(args);
      assert.equal(r.status, 1, JSON.stringify(args));
      assert.match(r.stderr, /usage/);
    }
    assert.deepEqual(readdirSync(d).sort(), ['root']);
  }));
});

describe('page.md', () => {
  const { page } = produce(files(), IDS);
  const lines = page.split('\n');

  it('8a. one gray callout, one headline, 4 small callouts in columns, the embed placeholder after the board heading, 2 h2 (break: a section removed)', () => {
    assert.ok(page.startsWith('<callout icon="🕒" color="gray_bg">'));
    assert.ok(page.includes('Tue 17 Nov, 11:30 CST') && page.includes('Wed 18 Nov, 23:30 CST') && page.includes(STAMP));
    const cols = page.slice(page.indexOf('<columns>'), page.indexOf('</columns>'));
    assert.equal((cols.match(/<callout /g) ?? []).length, 4);
    assert.equal(lines.filter((l) => /^## /.test(l)).length, 2);
    const heading = lines.indexOf('## 📊 FleetOps live board');
    assert.ok(heading > 0);
    assert.deepEqual(lines.filter((l) => l === '{{FLEETOPS_EMBED}}').length, 1);
    assert.equal(lines.indexOf('{{FLEETOPS_EMBED}}'), heading + 2);
    assert.ok(lines.indexOf('## 📘 How to use and update') > heading);
    assert.equal(page.split('{{').length, 2, 'only one placeholder');
    assert.ok(page.includes('7 lanes wait on you') && page.includes('grew by 26'));
  });

  it('8b. the how-to names the phone tap, the frame drag, the refresh phrase and the mask (break: the text removed)', () => {
    const how = page.slice(page.indexOf('## 📘'));
    for (const must of ['file card', 'Drag', 'refresh FleetOps', 'either account', 'by hand', 'masked']) assert.ok(how.includes(must), must);
  });

  it('8c. page.md holds no lane title, id, goal or holder (break: lane text added to the summary)', () => {
    const f = files();
    for (const row of f.lanes.rows) for (const t of [row.title, row.goal, row.holder]) if (t) assert.ok(!page.includes(t), t);
    for (const row of f.lanes.rows) assert.ok(!page.includes(row.id), row.id);
  });
});

describe('--check', () => {
  const { page } = produce(files(), IDS);
  const embed = '<embed source="file-upload://fake-upload" />';
  const good = page.replace('{{FLEETOPS_EMBED}}', embed);
  const run = (text, stamp = STAMP) => withTmp((d) => {
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'page.txt'), text);
    const { log, deps } = quiet();
    const code = main(['--check', join(d, 'page.txt'), '--stamp', stamp, '--ids-root', fakeRoot(join(d, 'root'))], deps);
    return { code, out: log.out.join(''), err: log.err.join('') };
  });

  it('9a. a good page: listed 0, stamp yes, 1 embed, 2 h2, exit 0 (break: a count wrong)', () => {
    const r = run(good);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'check: listed 0, stamp yes, embeds 1, h2 2');
  });

  it('9b. each failure cause exits 1 with its own count (break: a condition dropped from the exit rule)', () => {
    const listed = run(`${good}\nsee PR 4242\n`);
    assert.equal(listed.code, 1);
    assert.equal(listed.out.trim(), 'check: listed 1, stamp yes, embeds 1, h2 2');
    const noStamp = run(good, '2026-01-01T00:00:00.000Z');
    assert.equal(noStamp.code, 1);
    assert.equal(noStamp.out.trim(), 'check: listed 0, stamp no, embeds 1, h2 2');
    const noEmbed = run(page);
    assert.equal(noEmbed.code, 1);
    assert.equal(noEmbed.out.trim(), 'check: listed 0, stamp yes, embeds 0, h2 2');
    const extraH2 = run(`${good}\n## a third heading\n`);
    assert.equal(extraH2.code, 1);
    assert.equal(extraH2.out.trim(), 'check: listed 0, stamp yes, embeds 1, h2 3');
    const oneH2 = run(good.replace('## 📘 How to use and update', 'How to use and update'));
    assert.equal(oneH2.code, 1);
    assert.equal(oneH2.out.trim(), 'check: listed 0, stamp yes, embeds 1, h2 1');
  });

  it('9e. --stamp must be an ISO time: anything else is a usage error and prints no check line (break: the stamp pattern removed)', () => {
    for (const bad of ['yesterday', '2026-11-17', '2026-11-17 17:30:02', '`2026-11-17T17:30:02.680Z`']) {
      const r = run(good, bad);
      assert.equal(r.code, 1, bad);
      assert.match(r.err, /usage/);
      assert.equal(r.out, '');
    }
  });

  it('9c. a Notion read-back is decoded: an entity-split id is counted, a code-span stamp is found, only a line that starts with the tag is an embed (break: the decode or the line rule)', () => {
    assert.equal(run(`${good}\nsee &#35;4242\n`).out.trim(), 'check: listed 1, stamp yes, embeds 1, h2 2');
    assert.equal(run(good.replace(STAMP, `\`${STAMP}\``)).out.trim(), 'check: listed 0, stamp yes, embeds 1, h2 2');
    assert.equal(run(page.replace('{{FLEETOPS_EMBED}}', `see ${embed}`)).out.trim(), 'check: listed 0, stamp yes, embeds 0, h2 2');
    assert.equal(run(page.replace('{{FLEETOPS_EMBED}}', `  ${embed}`)).out.trim(), 'check: listed 0, stamp yes, embeds 0, h2 2', 'the rule is literal: a line that starts with the embed tag');
  });

  it('9d. on the real CLI: the exit code and the one stdout line; a missing file or id list is exit 1 (break: the exit code)', () => withTmp((d) => {
    writeFileSync(join(d, 'p.txt'), good);
    const ok = cli(['--check', join(d, 'p.txt'), '--stamp', STAMP, '--ids-root', fakeRoot(join(d, 'root'))]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'check: listed 0, stamp yes, embeds 1, h2 2');
    assert.equal(cli(['--check', join(d, 'none.txt'), '--stamp', STAMP, '--ids-root', join(d, 'root')]).status, 1);
    assert.equal(cli(['--check', join(d, 'p.txt'), '--stamp', STAMP, '--ids-root', join(d, 'no-root')]).status, 1);
    assert.equal(cli(['--check', join(d, 'p.txt'), '--ids-root', join(d, 'root')]).status, 1, 'no --stamp is a usage error');
  }));
});

describe('template', () => {
  it('10. no short id (0 to 9999) is found in the template: no colour or number that the matcher reads as an id (break: a hex colour with #)', () => {
    const tpl = readFileSync(TEMPLATE, 'utf8');
    const ids = Array.from({ length: 10000 }, (_, i) => String(i));
    assert.equal(countListed(tpl, ids), 0);
    assert.equal(countListed(decodeDisplay(tpl), ids), 0);
    assert.equal(tpl.split('__FLEETOPS_DATA__').length, 2, 'one data slot');
  });

  it('10b. the zone name comes from Intl (CST or CDT), never a fixed CST; the clock chip is not a live region (break: a fixed CST or role=status back)', () => {
    const tpl = readFileSync(TEMPLATE, 'utf8');
    assert.ok(!/\bCST\b/.test(tpl), 'no fixed CST in the template');
    assert.ok(!tpl.includes('role="status"'));
    const core = pageCore();
    assert.equal(core.cstZone(Date.parse('2026-07-01T12:00:00Z')), 'CDT');
    assert.equal(core.cstZone(Date.parse('2026-11-17T12:00:00Z')), 'CST');
  });

  it('10c. the page reads no object key from a name in the data: a project or never-started name like __proto__ is a plain key (break: {} back in the template)', () => {
    const tpl = readFileSync(TEMPLATE, 'utf8');
    assert.ok(!/\b(names|neverTop)\s*=\s*\{\}/.test(tpl));
    assert.ok(/neverTop\s*=\s*Object\.create\(null\)/.test(tpl) && /names\s*=\s*Object\.create\(null\)/.test(tpl));
  });
});

/* ---------- live refresh (card coord-fleetops-live-refresh): LF render, publication lock, badge ---------- */

const CR = 13;
const countCr = (buf) => buf.reduce((n, b) => n + (b === CR ? 1 : 0), 0);
const SENTINEL = '<!-- crlf-sentinel-7c1f -->';

/** A CRLF copy of the real template with a sentinel line, so the test does not depend on the checkout line endings. */
function crlfTemplate(dir) {
  const lf = readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  const p = join(dir, 'crlf.template.html');
  writeFileSync(p, `${SENTINEL}\n${lf}`.replace(/\n/g, '\r\n'));
  return p;
}

describe('R5: the render writes LF only', () => {
  it('R5a. a CRLF template renders with 0 CR bytes and the manifest equals the written file (break: no CRLF normalisation, or a template path that is ignored)', () => withTmp((d) => {
    const tpl = crlfTemplate(d);
    assert.ok(countCr(readFileSync(tpl)) > 600, 'the test template really has CRLF');
    const q = quiet({ template: tpl });
    const code = main([FIXTURE, '--out', join(d, 'out'), '--ids-root', fakeRoot(join(d, 'root'))], q.deps);
    assert.equal(code, 0, q.log.err.join('\n'));
    const html = readFileSync(join(d, 'out', 'fleetops.html'));
    assert.ok(html.includes(SENTINEL), 'the injected template was used');
    assert.equal(countCr(html), 0);
    const m = JSON.parse(read(join(d, 'out'), 'manifest.json'));
    assert.equal(m.htmlBytes, html.length);
    assert.equal(m.sha256Html, createHash('sha256').update(html).digest('hex'));
  }));

  it('R5b. renderHtml with a CRLF template has no CR, and the real template on disk renders with no CR whatever its line endings (break: normalisation only in one of the two reads)', () => withTmp((d) => {
    const view = embedView(buildView(files(), IDS));
    const html = H.renderHtml(view, JSON.stringify(view), crlfTemplate(d));
    assert.ok(html.includes(SENTINEL));
    assert.equal(html.includes('\r'), false);
    assert.equal(H.renderHtml(view).includes('\r'), false);
  }));
});

describe('D4: the badge is readable', () => {
  it('D4a. .badge uses the act wash with the act ink and an act border, not white on act (break: the old white-on-orange rule)', () => {
    const tpl = readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
    const rule = /\.badge\{([^}]*)\}/.exec(tpl);
    assert.ok(rule, 'a .badge rule exists');
    const decl = rule[1];
    assert.match(decl, /background:var\(--act-wash\)/);
    assert.match(decl, /color:var\(--act-ink\)/);
    assert.match(decl, /border:1px solid var\(--act\)/);
    assert.ok(!/color:white/.test(decl));
  });
});

/* ---- the publication lock ---- */

const MIN = 60_000;
const T0 = Date.parse('2026-11-17T20:00:00.000Z');
const SID_A = 'aaaaaaaa';
const SID_B = 'bbbbbbbb';
const SID_C = 'cccccccc';
const KEY = '2026-11-17T17:30:02.680Z';
const lockPath = (d) => join(d, 'publish.lock');
const pubPath = (d) => join(d, 'publish.json');
const json = (d, n) => JSON.parse(readFileSync(join(d, n), 'utf8'));
const lockCli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, LANE_DASH_STATE_DIR: '', ...env } });
const acquireArgs = (d, sid, key = KEY) => ['--lock-acquire', key, '--session', sid, '--dir', d];
const releaseArgs = (d, sid, outcome, extra = []) => ['--lock-release', outcome, '--session', sid, '--dir', d, ...extra];
const staleLockText = (session, ageMs, now = T0) => JSON.stringify({ session, key: KEY, at: new Date(now - ageMs).toISOString() });

describe('lock: acquire and release through the CLI', () => {
  it('L1. acquire writes publish.lock and publish.json state writing with no pid (break: the file names, the fields, a pid back)', () => withTmp((d) => {
    const r = lockCli(acquireArgs(d, SID_A));
    assert.equal(r.status, 0, r.stderr);
    const lock = json(d, 'publish.lock');
    assert.deepEqual([lock.session, lock.key], [SID_A, KEY]);
    assert.ok(!Number.isNaN(Date.parse(lock.at)));
    const pub = json(d, 'publish.json');
    assert.deepEqual(Object.keys(pub).sort(), ['at', 'key', 'session', 'state']);
    assert.deepEqual([pub.state, pub.session, pub.key], ['writing', SID_A, KEY]);
  }));

  it('L2. a second acquire exits 3 with one line that names the holder, and changes nothing (break: no wx create)', () => withTmp((d) => {
    assert.equal(lockCli(acquireArgs(d, SID_A)).status, 0);
    const before = readFileSync(lockPath(d), 'utf8');
    const r = lockCli(acquireArgs(d, SID_B));
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.stderr.trim().split('\n').length, 1);
    assert.ok(r.stderr.includes(SID_A));
    assert.ok(!/nothing written/.test(r.stderr));
    assert.equal(readFileSync(lockPath(d), 'utf8'), before);
    assert.equal(json(d, 'publish.json').session, SID_A);
  }));

  it('L3. a release by a session that does not hold the lock exits 3 and changes nothing (break: holder check)', () => withTmp((d) => {
    assert.equal(lockCli(acquireArgs(d, SID_A)).status, 0);
    const snap = [readFileSync(lockPath(d), 'utf8'), readFileSync(pubPath(d), 'utf8')];
    for (const outcome of ['ok', 'failed']) {
      const r = lockCli(releaseArgs(d, SID_B, outcome));
      assert.equal(r.status, 3, r.stderr);
      assert.deepEqual([readFileSync(lockPath(d), 'utf8'), readFileSync(pubPath(d), 'utf8')], snap);
    }
  }));

  it('L3b. a release with no lock at all exits 3 (break: a missing lock counted as held)', () => withTmp((d) => {
    assert.equal(lockCli(releaseArgs(d, SID_A, 'ok')).status, 3);
    assert.equal(existsSync(pubPath(d)), false);
  }));

  it('L4. release ok by the holder removes both files, and the lock can be taken again (break: a file left)', () => withTmp((d) => {
    assert.equal(lockCli(acquireArgs(d, SID_A)).status, 0);
    assert.equal(lockCli(releaseArgs(d, SID_A, 'ok')).status, 0);
    assert.deepEqual(readdirSync(d), []);
    assert.equal(lockCli(acquireArgs(d, SID_B)).status, 0);
  }));

  it('L5. release failed keeps publish.json with state failed, the key and the step, and removes the lock (break: failed state lost)', () => withTmp((d) => {
    assert.equal(lockCli(acquireArgs(d, SID_A)).status, 0);
    const r = lockCli(releaseArgs(d, SID_A, 'failed', ['--step', '7.3']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(lockPath(d)), false);
    const pub = json(d, 'publish.json');
    assert.deepEqual([pub.state, pub.session, pub.key, String(pub.step)], ['failed', SID_A, KEY, '7.3']);
    assert.ok(!Number.isNaN(Date.parse(pub.at)));
    assert.equal(Object.hasOwn(pub, 'pid'), false);
    assert.equal(lockCli(acquireArgs(d, SID_B)).status, 0, 'a failed state does not block a new writer');
  }));

  it('L5b. release failed with no step writes no step field', () => withTmp((d) => {
    assert.equal(lockCli(acquireArgs(d, SID_A)).status, 0);
    assert.equal(lockCli(releaseArgs(d, SID_A, 'failed')).status, 0);
    assert.equal(Object.hasOwn(json(d, 'publish.json'), 'step'), false);
  }));

  it('L6. a bad session, key, outcome or step is a usage error (exit 1) and writes nothing (break: a session that becomes a path)', () => withTmp((d) => {
    for (const args of [
      acquireArgs(d, '../evil'), acquireArgs(d, 'abc'), acquireArgs(d, 'AAAAAAAA'), acquireArgs(d, SID_A, ''), acquireArgs(d, SID_A, 'a b'),
      ['--lock-acquire', KEY, '--dir', d], ['--lock-acquire', '--session', SID_A, '--dir', d],
      releaseArgs(d, SID_A, 'maybe'), releaseArgs(d, SID_A, 'failed', ['--step', '../x']), ['--lock-release', 'ok', '--dir', d],
      [...acquireArgs(d, SID_A), '--bogus'], ['--lock-acquire', KEY, '--lock-release', 'ok', '--session', SID_A, '--dir', d],
    ]) {
      const r = lockCli(args);
      assert.equal(r.status, 1, JSON.stringify(args));
      assert.match(r.stderr, /usage/);
    }
    assert.deepEqual(readdirSync(d), []);
  }));

  it('L7. the default dir is LANE_DASH_STATE_DIR (break: a test that writes the real state dir)', () => withTmp((d) => {
    const r = lockCli(['--lock-acquire', KEY, '--session', SID_A], { LANE_DASH_STATE_DIR: d });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(lockPath(d)));
  }));
});

describe('lock: the 20 minute rule and the takeover (injected clock)', () => {
  const take = (d, sid, now) => H.lockAcquire({ dir: d, key: KEY, session: sid, now });
  const seed = (d, session, ageMs) => writeFileSync(lockPath(d), staleLockText(session, ageMs));

  it('L8. a lock 19 minutes old is live (exit 3); one 21 minutes old is taken over (break: the age limit or its direction)', () => withTmp((d) => {
    seed(d, SID_A, 19 * MIN);
    const live = take(d, SID_B, T0);
    assert.equal(live.code, 3);
    assert.ok(live.msg.includes(SID_A));
    assert.equal(json(d, 'publish.lock').session, SID_A);
    seed(d, SID_A, 21 * MIN);
    const got = take(d, SID_B, T0);
    assert.equal(got.code, 0, got.msg);
    assert.equal(json(d, 'publish.lock').session, SID_B);
    assert.deepEqual([json(d, 'publish.json').state, json(d, 'publish.json').session], ['writing', SID_B]);
    assert.deepEqual(readdirSync(d).sort(), ['publish.json', 'publish.lock'], 'no taken copy is left');
  }));

  it('L8b. exactly 20 minutes old is still live; a lock dated in the future is live', () => withTmp((d) => {
    seed(d, SID_A, 20 * MIN);
    assert.equal(take(d, SID_B, T0).code, 3);
    seed(d, SID_A, -5 * MIN);
    assert.equal(take(d, SID_B, T0).code, 3);
  }));

  it('L9. two takers that BOTH passed the stale read: A renames first, B gets ENOENT, exactly one holder (break: a plain overwrite of the lock)', () => withTmp((d) => {
    seed(d, SID_C, 30 * MIN);
    const snapA = H.lockSnapshot(d, T0);
    const snapB = H.lockSnapshot(d, T0);
    assert.equal(snapA.state, 'stale');
    assert.equal(snapB.state, 'stale');
    let b;
    const a = H.lockTake(d, snapA, { key: KEY, session: SID_A, now: T0 }, { afterRename: () => { b = H.lockTake(d, snapB, { key: KEY, session: SID_B, now: T0 }); } });
    assert.equal(b.code, 3, 'B lost the rename');
    assert.equal(a.code, 0, a.msg);
    assert.equal(json(d, 'publish.lock').session, SID_A);
    assert.equal(json(d, 'publish.json').session, SID_A);
    assert.deepEqual(readdirSync(d).sort(), ['publish.json', 'publish.lock']);
  }));

  it('L10. B passed both stale reads, A finishes its takeover, then B renames: B finds a fresh lock, puts it back and exits 3 (break: no content compare after the rename)', () => withTmp((d) => {
    seed(d, SID_C, 30 * MIN);
    const snapA = H.lockSnapshot(d, T0);
    const snapB = H.lockSnapshot(d, T0);
    const a = H.lockTake(d, snapA, { key: KEY, session: SID_A, now: T0 });
    assert.equal(a.code, 0, a.msg);
    const lockBefore = readFileSync(lockPath(d), 'utf8');
    const b = H.lockTake(d, snapB, { key: KEY, session: SID_B, now: T0 });
    assert.equal(b.code, 3, b.msg);
    assert.equal(readFileSync(lockPath(d), 'utf8'), lockBefore, 'A still holds the same lock');
    assert.equal(json(d, 'publish.json').session, SID_A);
    assert.deepEqual(readdirSync(d).sort(), ['publish.json', 'publish.lock'], 'B left no taken copy');
    assert.equal(H.lockRelease({ dir: d, session: SID_A, outcome: 'ok' }).code, 0, 'A can still release');
  }));

  it('L11. the lock changes between the two reads: not stale, not taken (break: one read only)', () => withTmp((d) => {
    seed(d, SID_C, 30 * MIN);
    const snap = H.lockSnapshot(d, T0, { betweenReads: () => seed(d, SID_A, 1 * MIN) });
    assert.notEqual(snap.state, 'stale');
    assert.equal(json(d, 'publish.lock').session, SID_A);
  }));

  it('L12. an empty lock file is live when new and stale when its mtime is over 20 minutes old (break: a crash between create and write blocks for ever, or a half-written lock is taken)', () => withTmp((d) => {
    writeFileSync(lockPath(d), '');
    assert.equal(take(d, SID_B, Date.now()).code, 3);
    const old = new Date(Date.now() - 25 * MIN);
    utimesSync(lockPath(d), old, old);
    assert.equal(take(d, SID_B, Date.now()).code, 0);
    writeFileSync(lockPath(d), 'not json');
    utimesSync(lockPath(d), old, old);
    assert.equal(take(d, SID_C, Date.now()).code, 0);
    assert.equal(json(d, 'publish.lock').session, SID_C);
  }));
});
