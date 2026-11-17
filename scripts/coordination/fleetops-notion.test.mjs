/**
 * fleetops-notion.test -- tests for the FleetOps Notion page renderer (card coord-fleetops-notion).
 *
 * Every id, title and number here is MADE UP (fixtures/fleetops-mini). The fake id list is passed straight in: a digit id written "#4242" or
 * "PR 4242" in context, and a 10-char hex sha with letters. No real id list is read, except by the CLI tests, which build a fake root.
 *
 * How the page can fail, one test each (the change that breaks it is in the test name):
 *   1. a listed id survives in a title, id, goal or holder, most of all in a title that is cut at 60 (mask removed, or cut before the mask)
 *   2. the whole-page check passes a page that still holds a listed id (count check removed)
 *   3. one ask date shows two ages (UTC date instead of the CST calendar day), or the age depends on the TZ of the machine
 *   4. the pile shows a second figure (a tile text or all snapshots are read), or its window is 7 snapshots (6 days), not 7 calendar days
 *   5. a retired string reaches the page ({h}, no_end, board_url, a claude.ai artifact url, a raw div), or the guard stops guarding
 *   6. P0 rows are not first, or a project with 3 or more asks does not fold
 *   7. a title cut breaks a word
 *   8. a mixed export is rendered, or the CLI writes a file on any error
 *   9. a lapsed lease is not red or has no word, a live one is red
 *  10. project states (Ongoing, Done N open, empty Unassigned) are wrong
 *  11. a stale page is not red at render time
 *  12. a phone table has more than 3 columns outside a toggle, a bar is wider than 20, or never started is counted by claim, not by work
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { countListed } from './board-mask.mjs';
import { DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';
import { buildView, cstDayDiff, cutWords } from './fleetops-view.mjs';
import { loadFiles, maskPage, renderPage } from './fleetops-notion.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'fleetops-mini');
const CLI = join(HERE, 'fleetops-notion.mjs');
const IDS = ['4242', 'abc1234def'];
const NOW = new Date('2026-11-17T18:00:00.000Z');

const files = () => loadFiles(FIXTURE);
const pageOf = (f = files(), ids = IDS, now = NOW) => renderPage(buildView(f, ids), now);
const rowsOf = (page) => page.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*<\/tr>/g) ?? [];
const rowWith = (page, needle) => rowsOf(page).find((r) => r.includes(needle));
const tmp = () => mkdtempSync(join(tmpdir(), 'fleetops-test-'));
const withTmp = (fn) => { const d = tmp(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

function fakeRoot(dir) {
  mkdirSync(join(dir, dirname(DATASET_REL)), { recursive: true });
  mkdirSync(join(dir, dirname(EVAL_CONFIG_REL)), { recursive: true });
  writeFileSync(join(dir, DATASET_REL), JSON.stringify({ prs: [{ pr: 4242 }], findings: [{ pr: 4242, round: 'abc1234def' }] }));
  writeFileSync(join(dir, EVAL_CONFIG_REL), JSON.stringify({}));
  return dir;
}

describe('listed ids', () => {
  it('1. none is left in the page, also in a title cut at 60 (break: maskListed removed, or the cut runs before it)', () => {
    const f = files();
    const title = f.lanes.rows[0].title;
    const at = title.indexOf('abc1234def');
    assert.ok(at + 7 <= 60 && at + 10 > 60, 'the fixture id must straddle character 60');
    assert.ok(countListed(title.slice(0, 60), IDS) > 0, 'a cut before the mask would leak a partial sha');
    const view = buildView(f, IDS);
    const page = renderPage(view, NOW);
    assert.equal(countListed(page, IDS), 0);
    assert.ok(view.masked > 0);
    assert.ok(page.includes('masked-id'));
    for (const kept of ['key-masked-id', 'PR masked-id']) assert.ok(page.includes(kept), `the page keeps ${kept}`);
  });

  it('2. an unmasked view leaks, and maskPage refuses a page the mask did not clean (break: the count check removed)', () => {
    const raw = renderPage(buildView(files(), []), NOW);
    assert.ok(countListed(raw, IDS) > 0, 'with ids=[] the view cannot mask');
    const noMask = (text) => ({ text, masked: 0 });
    assert.throws(() => maskPage(raw, IDS, { mask: noMask }), /still in the page/);
    assert.equal(countListed(maskPage(raw, IDS).page, IDS), 0);
  });
});

describe('ages', () => {
  it('3. one ask date shows one age: the 23:30 CST ask is 11 d everywhere (break: UTC date diff)', () => {
    const ask = '2026-11-07T05:30:00.000Z';
    assert.equal(cstDayDiff(ask, '2026-11-17T17:30:02.680Z'), 11);
    assert.equal(cstDayDiff('2026-10-31T12:00:00.000Z', '2026-11-02T12:00:00.000Z'), 2, 'a DST change does not move a day');
    const page = pageOf();
    assert.ok(rowWith(page, 'timed-reminders').includes('6 Nov · 11 d'));
    assert.ok(page.includes('asked 11 d ago'));
    assert.ok(!page.includes('10 d'));
  });
});

describe('pile', () => {
  it('4. one figure only: open now minus open 7 calendar days before (break: a tile text, all 9 snapshots, or the last 7 snapshots = 6 days)', () => {
    const page = pageOf();
    assert.ok(page.includes('<b>+26</b> open, 7 days'));
    assert.ok(page.includes('The pile grew by 26 in 7 days.'));
    assert.ok(!page.includes('7777') && !page.includes('+30') && !page.includes('+27'));
    assert.match(page, /[▁-█]{8} {2}min 103, max 130/);
  });
});

describe('forbidden text', () => {
  it('5a. no retired string reaches the page (break: the renderer reads tile text, no_end or board_url)', () => {
    const page = pageOf();
    for (const bad of ['{h}', 'no_end', 'board_url', '<div', '<details', 'claude.ai/artifact/', 'FAKE-ARTIFACT']) assert.ok(!page.includes(bad), bad);
    assert.ok(page.includes('Ongoing'));
  });

  it('5b. a forbidden string made by a lane title stops the render (break: the guard removed)', () => {
    const f = files();
    f.lanes.rows[1].title = 'see {h} here';
    assert.throws(() => pageOf(f), /forbidden/);
    f.lanes.rows[1].title = 'a <div> tag';
    assert.ok(pageOf(f).includes('a &lt;div&gt; tag'));
  });

  it('5c. a dotted file name goes in a code span, so Notion does not make it a web link (break: esc without the code-span split)', () => {
    const f = files();
    f.lanes.rows[1].title = 'fix refs.mjs and IMPACT.md for P5.1';
    const page = pageOf(f);
    assert.ok(page.includes('fix `refs.mjs` and `IMPACT.md` for P5.1'));
  });
});

describe('waiting on Dave', () => {
  it('6. P0 first, then the older asks; a project with 3 asks folds into one h3 toggle (break: sort or fold rule)', () => {
    const page = pageOf();
    const waiting = page.slice(page.indexOf('## 🙋'), page.indexOf('## 📈'));
    assert.ok(waiting.indexOf('timed-reminders') < waiting.indexOf('old-ask-lane'), 'P0 (11 d) before the older P1 ask (15 d)');
    assert.ok(rowWith(page, 'old-ask-lane').startsWith('<tr color="orange_bg">'));
    assert.equal(waiting.match(/<toggle heading="h3">Gamma work: 3 asks, oldest 5 d/g)?.length, 1);
    const fold = waiting.slice(waiting.indexOf('<toggle heading="h3">Gamma'));
    for (const id of ['gamma-one', 'gamma-two', 'gamma-three']) assert.ok(fold.includes(id) && waiting.indexOf(id) > waiting.indexOf('<toggle heading="h3">Gamma'));
    assert.ok(waiting.includes('Other projects: 2 asks'));
    assert.ok(page.includes('<b>7</b> wait on Dave<br />2 over 7 d'));
  });
});

describe('cut', () => {
  it('7. a title cut never breaks a word (break: a hard slice)', () => {
    const view = buildView(files(), IDS);
    const full = files().lanes.rows[0].title.replace(/abc1234def/, 'masked-id').split(' ');
    const cut = view.wip.rows.find((r) => r.id.startsWith('key-')).title;
    assert.ok(cut.endsWith('…') && cut.length <= 61);
    const words = cut.slice(0, -1).split(' ');
    assert.deepEqual(words, full.slice(0, words.length));
    assert.equal(cutWords('alpha beta gamma', 8), 'alpha…');
    assert.equal(cutWords('averyveryverylongword tail', 5), 'averyveryverylongword…');
  });
});

describe('export and CLI', () => {
  it('8a. a mixed export throws, the CLI exits 1 and writes nothing (break: the stamp check removed)', () => withTmp((d) => {
    cpSync(FIXTURE, join(d, 'in'), { recursive: true });
    const tiles = JSON.parse(readFileSync(join(d, 'in', 'tiles.json'), 'utf8'));
    tiles.exportedAt = '2026-11-16T00:00:00.000Z';
    writeFileSync(join(d, 'in', 'tiles.json'), JSON.stringify(tiles));
    assert.throws(() => loadFiles(join(d, 'in')), /another export/);
    const r = cli([join(d, 'in'), '--out', join(d, 'out'), '--ids-root', fakeRoot(join(d, 'root'))]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /another export/);
    assert.ok(!existsSync(join(d, 'out')));
  }));

  it('8b. a missing id list exits 1 with no file; a good run writes page.md and a true manifest (break: write before check)', () => withTmp((d) => {
    const bad = cli([FIXTURE, '--out', join(d, 'bad'), '--ids-root', join(d, 'no-root')]);
    assert.equal(bad.status, 1);
    assert.ok(!existsSync(join(d, 'bad')));
    const ok = cli([FIXTURE, '--out', join(d, 'out'), '--ids-root', fakeRoot(join(d, 'root'))]);
    assert.equal(ok.status, 0, ok.stderr);
    const page = readFileSync(join(d, 'out', 'page.md'), 'utf8');
    const m = JSON.parse(readFileSync(join(d, 'out', 'manifest.json'), 'utf8'));
    assert.equal(countListed(page, IDS), 0);
    assert.equal(m.sha256, createHash('sha256').update(page).digest('hex'));
    assert.deepEqual([m.exportedAt, m.bytes, m.h2Count], ['2026-11-17T17:30:02.680Z', Buffer.byteLength(page), 7]);
    assert.ok(m.masked > 0 && ok.stderr.includes('listed ids left 0'));
  }));
});

describe('colour and shape', () => {
  it('9. a lapsed lease is a red row with the word Lapsed; a live lease is not (break: the lease test or colour)', () => {
    const page = pageOf();
    const lapsed = rowWith(page, 'lapsed-guard');
    assert.ok(lapsed.startsWith('<tr color="red_bg">') && lapsed.includes('Lapsed 12 Nov · 5 d') && lapsed.includes('peer-one'));
    const live = rowWith(page, 'phone-page');
    assert.ok(live.startsWith('<tr>') && live.includes('Live') && live.includes('trex #0d40499c'));
    assert.ok(page.includes('<callout icon="⚙️" color="red_bg">\n<b>2</b> live<br />1 lapsed'));
  });

  it('10. projects: no_end is Ongoing, a done project with open lanes is Done and yellow, an empty Unassigned is dropped (break: the state map)', () => {
    const page = pageOf();
    assert.ok(rowWith(page, 'Gamma work').includes('Ongoing'));
    assert.ok(rowWith(page, 'Beta flow').startsWith('<tr color="yellow_bg">') && rowWith(page, 'Beta flow').includes('Done · 2 open'));
    assert.ok(!page.includes('Unassigned'));
  });

  it('11. the data callout is red once the stale time is past, gray before (break: the stale colour)', () => {
    const view = buildView(files(), IDS);
    assert.ok(view.staleAt.startsWith('Wed 18 Nov, 23:30 CST'));
    assert.ok(renderPage(view, NOW).includes('<callout icon="🕒" color="gray_bg">'));
    const late = renderPage(view, new Date('2026-11-19T12:00:00.000Z'));
    assert.ok(late.includes('<callout icon="🕒" color="red_bg">') && late.includes('Stale since Wed 18 Nov, 23:30 CST'));
  });

  it('12. open tables have 3 columns at most and bars are 20 wide at most (break: a wider open table or bar scale)', () => {
    const page = pageOf();
    const open = page.replace(/<toggle heading="h2">[\s\S]*$/, '').replace(/<toggle[^>]*>[\s\S]*?<\/toggle>/g, '');
    for (const r of rowsOf(open)) assert.ok((r.match(/<td>/g) ?? []).length <= 3);
    assert.ok(Math.max(...(page.match(/▇+/g) ?? []).map((b) => b.length)) <= 20);
    assert.ok(page.includes('<b>7</b>/10 never started<br />3 at 7 d or more'), 'never started = no last_work_at, a claimed lane with no work counts');
    assert.ok(rowWith(page, '7 d or more').startsWith('<tr color="orange_bg">'));
  });
});
