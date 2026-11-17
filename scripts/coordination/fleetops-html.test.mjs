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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { countListed, DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';
import { buildView } from './fleetops-view.mjs';
import { axisTicks, decodeDisplay, loadFiles, main, pageCore, produce } from './fleetops-html.mjs';

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
    const cases = ['&#35;4242', '&#x23;4242', '&num;4242', '&amp;#35;4242', '\\u00234242', '\\#4242', 'PR `4242`', 'PR&nbsp;4242', 'PR\u200b 4242', 'PR&NewLine;4242'];
    for (const c of cases) assert.ok(countListed(decodeDisplay(c), IDS) > 0, `decoded: ${JSON.stringify(c)}`);
    for (const c of ['&#35;4242', '&#x23;4242', '&num;4242', '&amp;#35;4242', '\\u00234242', 'PR `4242`']) assert.equal(countListed(c, IDS), 0, `the plain count misses ${JSON.stringify(c)}`);
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
    assert.ok(!html.includes('<script>window.pwn'));
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
});
