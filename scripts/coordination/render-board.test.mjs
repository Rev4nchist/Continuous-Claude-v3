/**
 * render-board.test -- tests for the board-aware page generator.
 *
 * Pure parts (flag parsing, output names, the meta stamp) are unit tests. The page itself is an end to end test: it
 * runs the real render-board.mjs as a child process against a SCRATCH database (lanes_pr1_*) that this file creates and
 * drops. The default output path is never used by a test: it would write into the working tree.
 *
 * How the generator can fail, one test each:
 *   - `--project x` becomes the output FILE NAME (the old script took argv[2] whole)
 *   - the positional [out.html] of the old command stops working
 *   - a flag with no value, an unknown flag, or a second file name is taken as something else
 *   - a board key with a path character picks a file outside the repo root
 *   - the foreign board's page lists continuous-claude lanes, events or sessions (or the reverse)
 *   - the foreign page carries the kanban script or an artifact db reference (its save drops ids the page does not know)
 *   - the foreign page has no read-only Priorities section, or shows a CCv3 lane in a column, or a lane in the wrong column
 *   - a read-only flag leaks into the continuous-claude page, or that page loses its interactive kanban
 *   - `--interactive` is not a flag, takes a value, or changes the continuous-claude page
 *   - `--interactive` on a foreign board leaks CCv3 lanes into kb-data, drops a kanban marker, or hides the board name
 *   - a page cannot tell which board owns it (the board guard has nothing to compare), or a helper the page calls is not inlined
 *   - the default page changes in any byte outside the kanban script (golden, opt-in against a git ref)
 *   - a board whose registry entry has a valid laneArtifact renders read-only without the flag, or one with no or a bad laneArtifact renders interactive
 *   - the page has no stamp, or the stamp names the wrong board
 *   - an unknown key, or a cwd with no board, writes a page instead of exiting 1
 *   - a half-written page is left at the target (the write must be temp + rename)
 *   - the page width cap is not one shared variable (header and board drift apart), or is not 2200px
 *   - the Priorities grid is not 1 column to 720px, 3 from 721px and 6 from 1360px
 *   - a Priorities list does not scroll inside itself from 721px, or the phone loses normal page scrolling
 *   - the phone header pins the counters again (the counters sit inside the pinned row), or the Activity feed pushes the page sideways
 *   - the machine-wide sections do not say so
 *   - the folded-project SQL drifts from lane.mjs (the peer rule must match)
 *   - By band shows a done lane, lists another board's lane, mis-orders the groups or a group, or shows P0 6/5 without the cap warning
 *   - a NULL band is not Unsorted, or a title or band chip is not HTML-escaped
 *   - the editable and read-only cards differ (band chip, "rank N"), or still print "prio N"
 *   - a lane row lacks data-band, data-ord or data-seq; kb-data lacks band
 *   - a By band row borrows kb-card, lane, detail or chip (breaks paintEdit, the filter, the details toggle)
 *   - the read-only page loses the By band view, or gains a kanban marker
 *   - the filter chips are not two groups (state, band), or the view and group buttons use the chip class
 *   - the inline script is not ES5, or localStorage is read outside try/catch
 *   - the template hash does not change when a generator file (board-band-view.mjs included) changes, or the page stamp is not that hash
 *   - the By band intro does not say a drag shows only after the next sync, or the status line and order chip leave the page in one view
 *   - a band chip count counts open lanes under a label that does not say "open"
 *   - a By band row grows (bytes beyond id and title), or the page outgrows its size ratchet (the artifact limit is 16 MB)
 *
 * How the desktop board (PR-K1) can fail, one test each (the layout itself is the Edge run in .claude/cache/e2e/2026-11-07-desktop-board.*):
 *   - the fine-pointer block is missing, twice, out of order, names #kb-board (it would beat the By band hide rule) or snaps (it undoes the edge scroll)
 *   - the board is not a flex row that scrolls sideways, a list does not scroll by itself, or the base rule stops being a grid (touch screens lose the 3x2 grid)
 *   - the intro hides outside the desktop Columns view, the board has no region name, or the polish rules (13px ink title, amber Waiting pill, one control row,
 *     narrow empty Scheduled, muted small text) are missing or leak into the phone
 *   - the page script fits the board without the fine-pointer query, or leaves its two properties set after a resize to a phone
 *
 * How the Scheduled and reminders column (PR-F) can fail, one test each (the split and the chip are in board-scheduled-view.test.mjs):
 *   - a scheduled lane is also in Next, Later or Waiting, or in kb-data (the browser would place it twice)
 *   - a scheduled card takes kb-card (paintEdit in the client does part(id,'.kb-note').disabled with no null check) or any class the client handles
 *   - the Scheduled head has no .kb-head on the editable page (syncHeads kills the client), or an empty column says nothing
 *   - an acked reminder, a held lane or a past-due normal lane shows in Scheduled; a due reminder or a future lane is missing
 *   - the column order is not Scheduled, Next, Later, Waiting on Dave, In progress, Done; the Now column is back
 *   - a lane title is not escaped; the chip says the wrong time; the template hash ignores board-scheduled-view.mjs
 *
 * How the Done column (PR-D) can fail, one test each (the pure window, cap and order rules are in board-done-view.test.mjs):
 *   - the six columns are not Scheduled, Next, Later, Waiting on Dave, In progress, Done (Done first, or missing on the read-only page)
 *   - the Done head has no .kb-head: syncHeads of the client throws and the whole client dies
 *   - a Done card takes a class the client handles (kb-card, kb-ctl, kb-st, kb-bd, kb-save, kb-grip, kb-more, kb-next, kb-done, kb-undo, kb-plain)
 *   - a done title, scope or note is not escaped, or a long note is not cut
 *   - a lane shows in Done under the wrong day, in the wrong order, or when its only done event is the kanban sync's
 *   - a done lane appears in By band, or an open lane in Done
 *   - the Done footer or Show all is missing, sits inside the scroll area, or its handler is in the client (the read-only page has none)
 *   - a collapsed Done column on the phone still shows its footer
 *   - a done card grows beyond its ratchet, or the template hash ignores board-done-view.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from './scratch-db.mjs';
import { stripClientComments } from './kanban-strip.mjs';
import { DONE_NOTE_MAX } from './board-done-view.mjs';
import { TEMPLATE_FILES, boardStamp, defaultOut, parseBoardStamp, parseRenderArgs, templateHash, writeAtomic } from './render-board-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const RENDER = path.join(HERE, 'render-board.mjs');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
// Size ratchets for the band page (see the ratchet note in the band tests). Measured 2026-11-06: test page 136,616 bytes, widest row 232 bytes of markup.
// Measured 2026-11-07 (PR-D, after the critic fixes): test page 149,826 bytes. PAGE_BYTES_MAX is that plus about 1 KB. It rose from 140,000
// because the Done column (Dave chose option B: native <details> with scope and last note on every Done card) adds about 32 KB to the live page,
// and the test fixture gained five done lanes (their Done cards, Lanes rows and the new CSS), the fifth for the max-not-min check.
// A done card measures 395 bytes beyond its text.
// Measured 2026-11-07 (PR-F): test page 162,174 bytes, so PAGE_BYTES_MAX is that plus about 1 KB. It rose from 150,800 (+12,348 over the 149,826 above) ONLY because
// the fixture gained five open lanes with a due time (sch-future, sch-rem, sch-acked, sch-past, sch-held), and p1-due now has a relative due time.
// The same fixtures on the code before PR-F measure 167,973 bytes (about 3.6 KB per new lane: kb-card, Lanes row, By band row, kb-data row), so the column
// itself makes this page 5,799 bytes smaller: three lanes become a Scheduled card instead of a kb-card, and the Now column and its client code go.
// A scheduled card measures 422 bytes beyond its text (a done card: 395).
// Measured 2026-11-07 (PR-M1): test page about 164,700 bytes (164,626 before the By band type sizes moved below the By band rules), so PAGE_BYTES_MAX is that plus about 1 KB. It rose from 163,200 (about +2,500 over the 162,174 above) ONLY because
// the phone fixes add about a dozen CSS rules (16px fields, type sizes, hidden chrome, sticky status bar, 44px theme button, --top-h) and
// a touch guard in the client (focus, column open, scroll back). No markup was added to a card, a row or a Done card.
// Measured 2026-11-07 (PR-M2): test page 166,868 bytes (about +2,100 over the PR-M1 page above; the PR-M1 figure of about 164,761 comes from the PR-M2 task, not from a re-measure of the base), so PAGE_BYTES_MAX is that plus about 1 KB. It rose from 165,700 ONLY because
// of phone CSS (row cursor, state word, Waiting above Later, the Later cap), one Show more button in the Later footer (85 bytes), and client logic (row tap,
// cap, neighbour skip; the client comments are stripped from the page). No card, row, Done or Scheduled markup grew: ROW, DONE and SCHED overheads are unchanged.
// Measured 2026-11-07 (PR-M2 critic fixes): test page 168,457 bytes (+1,589 over the 166,868 above), so PAGE_BYTES_MAX is that plus about 1 KB (167,900 to 169,500). It rose ONLY because
// of client logic (a Scheduled row tap, the pinned-bar height, the drag cap lift, two live-region lines, focus on a fine pointer) and one CSS term (--bar-h). No markup grew.
// Measured 2026-11-07 (PR-K1, the desktop board): test page 171,469 bytes (+3,012 over the 168,457 above), so PAGE_BYTES_MAX is that plus about 1 KB (172,469 to 172,500). It rose from 169,500 ONLY because
// of the desktop CSS block (one wide board, 13px titles, amber Waiting pill, one control row, narrow empty Scheduled; about 1.5 KB with its comment), the fit script beside setView (height and scroll padding, gated by the
// fine-pointer query, about 1.0 KB), the edge scroll in the client (about 0.5 KB) and a region label on the board (41 bytes). Dave's estimate was 171,500, from the 1.9 KB of the Design A prototype. No card, row, Done or Scheduled markup grew.
// Measured 2026-11-07 PR-G (the Band select on the card form): test page 174,538 bytes after the critic fixes (+3,062 over 171,476, the main page re-measured today; the PR-K1 note above says 171,469), so PAGE_BYTES_MAX is 175,000, the hard limit Dave approved, and headroom is 462 bytes. The critic fixes added 245 bytes: bandAt with every band write and in the band base, and the line on an active card. It rose from 172,500 ONLY because
// of the Band select markup (one label and an EMPTY select per editable card, about 100 bytes x 17 cards; the client fills the 4 options once, as it does for Move to: a full inline select would cost about 3.9 KB and break the limit), the client option fill and band base (about 0.7 KB, comments stripped), and .kb-bd added to four CSS rules.
const ROW_OVERHEAD_MAX = 240;
const PAGE_BYTES_MAX = 175000;
const DONE_OVERHEAD_MAX = 420;
// A title long enough to need more than three lines in a narrow card.
const LONG_TITLE = `long title start ${'word '.repeat(80)}long title END`;
// Done fixtures. A note longer than DONE_NOTE_MAX, and a title that needs escaping.
const DN_TITLE = '<b>done</b> "quoted" & today';
const DN_NOTE = `${'N'.repeat(300)}TAILMARK`;
// A scheduled title that needs escaping, and the markup limit of a scheduled card.
const SCH_TITLE = '<b>sched</b> "quoted" & later';
const SCHED_OVERHEAD_MAX = 440;
/** Local noon, `back` days ago. Built with local constructors so "Yesterday" is right in any timezone. */
const noon = (back) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() - back, 12, 0, 0); };

// ------------------------------------------------------------------ pure parts

const ARGS = (o = {}) => ({ project: null, out: null, interactive: false, ...o });

describe('parseRenderArgs', () => {
  it('has no project, no output and no interactive flag by default', () => {
    assert.deepEqual(parseRenderArgs([]), ARGS());
  });

  it('reads --interactive as a boolean flag in any position, with no value', () => {
    assert.deepEqual(parseRenderArgs(['--interactive']), ARGS({ interactive: true }));
    assert.deepEqual(parseRenderArgs(['--project', 'zz-a', '--interactive', '--out', 'x.html']), ARGS({ project: 'zz-a', out: 'x.html', interactive: true }));
    assert.deepEqual(parseRenderArgs(['--interactive', 'board.html']), ARGS({ out: 'board.html', interactive: true }));
    // It never swallows the next word, and it takes no value of its own.
    assert.deepEqual(parseRenderArgs(['--interactive', '--project', 'k']), ARGS({ project: 'k', interactive: true }));
    assert.throws(() => parseRenderArgs(['--interactive=false']), /--interactive takes no value/);
    assert.throws(() => parseRenderArgs(['--interactive=']), /--interactive takes no value/);
  });

  it('still refuses a misspelt flag next to --interactive', () => {
    assert.throws(() => parseRenderArgs(['--interactive', '--interactve']), /unknown argument: --interactve/);
    assert.throws(() => parseRenderArgs(['--interact']), /unknown argument: --interact/);
  });

  it('reads --project <key> and --project=<key>; the key never becomes the output file', () => {
    assert.deepEqual(parseRenderArgs(['--project', 'zz-a']), ARGS({ project: 'zz-a' }));
    assert.deepEqual(parseRenderArgs(['--project=zz-a']), ARGS({ project: 'zz-a' }));
  });

  it('reads --out <file> and --out=<file>', () => {
    assert.deepEqual(parseRenderArgs(['--out', 'x.html']), ARGS({ out: 'x.html' }));
    assert.deepEqual(parseRenderArgs(['--out=x.html', '--project', 'k']), ARGS({ project: 'k', out: 'x.html' }));
  });

  it('keeps the positional [out.html] of the old command', () => {
    assert.deepEqual(parseRenderArgs(['board.html']), ARGS({ out: 'board.html' }));
    assert.deepEqual(parseRenderArgs(['--project', 'k', 'board.html']), ARGS({ project: 'k', out: 'board.html' }));
  });

  it('refuses an unknown flag, a flag with no value, and an output named twice', () => {
    assert.throws(() => parseRenderArgs(['--projcet', 'k']), /unknown argument: --projcet/);
    assert.throws(() => parseRenderArgs(['--project']), /--project needs a value/);
    assert.throws(() => parseRenderArgs(['--project', '--out', 'x.html']), /--project needs a value/);
    assert.throws(() => parseRenderArgs(['--out']), /--out needs a value/);
    assert.throws(() => parseRenderArgs(['a.html', 'b.html']), /one output file/);
    assert.throws(() => parseRenderArgs(['--out', 'a.html', 'b.html']), /one output file/);
  });
});

describe('defaultOut', () => {
  it('is lane-board.html for continuous-claude and lane-board-<key>.html for every other board', () => {
    assert.equal(defaultOut('/repo', 'continuous-claude'), path.join('/repo', 'lane-board.html'));
    assert.equal(defaultOut('/repo', 'zz-a'), path.join('/repo', 'lane-board-zz-a.html'));
  });

  it('refuses a key that is not a plain board key, so a key cannot choose a path', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', 'A', '', '-a', 'a b']) {
      assert.throws(() => defaultOut('/repo', bad), /not a board key/, bad);
    }
  });
});

describe('the meta stamp', () => {
  it('round trips board, template hash and generated time', () => {
    const tag = boardStamp({ board: 'zz-a', template: 'deadbeef', generated: '2026-11-04T12:00:00.000Z' });
    assert.match(tag, /^<meta name="lane-board" content="board=zz-a;template=deadbeef;generated=2026-11-04T12:00:00\.000Z">$/);
    assert.deepEqual(parseBoardStamp(`<head>${tag}</head>`), { board: 'zz-a', template: 'deadbeef', generated: '2026-11-04T12:00:00.000Z' });
  });

  it('reads a single-quoted tag too, and gives null when there is none', () => {
    assert.deepEqual(parseBoardStamp("<meta name=lane-board content='board=k;template=ab;generated=t'>"), { board: 'k', template: 'ab', generated: 't' });
    assert.equal(parseBoardStamp('<html></html>'), null);
  });
});

describe('writeAtomic', () => {
  it('replaces the target in one rename and leaves no temp file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-atomic-'));
    const file = path.join(dir, 'p.html');
    fs.writeFileSync(file, 'old');
    writeAtomic(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(dir), ['p.html']);
  });

  it('keeps the old page and removes the temp file when the write cannot finish', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-atomic-'));
    const file = path.join(dir, 'p.html');
    fs.writeFileSync(file, 'old');
    assert.throws(() => writeAtomic(file, { not: 'a string' }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['p.html']);
  });
});

describe('source twins', () => {
  it('render-board.mjs folds sessions.project exactly the way lane.mjs does (the peer rule)', () => {
    const pick = (file) => /const FOLDED_PROJECT = [\s\S]*?\n\s+`'\^\/\(\[a-z\]\)[^\n]*\n/.exec(fs.readFileSync(file, 'utf8'))?.[0];
    const a = pick(RENDER);
    const b = pick(LANE);
    assert.ok(a && b, 'FOLDED_PROJECT not found in both files');
    assert.equal(a, b);
  });

  it('the "open, quiet" window is the same in lane.mjs and render-board.mjs (the header and the page must print one number)', () => {
    const hours = (file) => /const QUIET_HOURS = (\d+);/.exec(fs.readFileSync(file, 'utf8'))?.[1];
    assert.ok(hours(RENDER) && hours(LANE), 'QUIET_HOURS not found in both files');
    assert.equal(hours(RENDER), hours(LANE));
  });
});

// ------------------------------------------------------------------ the page, end to end

const loadPg = () => requireDep('pg', { repoRoot: REPO });

const E2E = { url: '', tmp: '', registry: '', home: '', rootA: '', rootC: '', rootArt: '', rootBad: '', noBoard: '' };
const fwd = (p) => p.replace(/\\/g, '/');

function renderPage(args, { cwd = E2E.rootC, env = {}, script = RENDER, nodeArgs = [] } = {}) {
  assertScratchUrl(E2E.url);
  const r = spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CONTINUOUS_CLAUDE_DB_URL: E2E.url,
      DATABASE_URL: E2E.url,
      OPC_POSTGRES_URL: E2E.url,
      LANE_REGISTRY_PATH: E2E.registry,
      CCV3_USER_HOME: E2E.home,
      LANE_PROJECT: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

/** A preload that freezes the clock, so two renders of the same data differ only in what the generator itself writes. */
function freezeClock() {
  const file = path.join(E2E.tmp, 'freeze-clock.mjs');
  fs.writeFileSync(file, [
    "const Real = Date; const FIXED = Real.parse('2026-11-05T12:00:00Z');",
    'class Frozen extends Real { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }',
    'globalThis.Date = Frozen;',
  ].join('\n'));
  return pathToFileURL(file).href;
}

/** The kanban client script: the one <script> block that starts with the inlined placeLanes source. */
const KB_SCRIPT_RE = /<script>\nfunction placeLanes[\s\S]*?<\/script>/;

/** A page with what a render writes about itself masked: the stamp (template hash, generated time), the clock text and the age badge. */
function maskPage(html) {
  return html
    .replace(/template=[0-9a-f]+;generated=[^"]+/g, 'template=T;generated=G')
    .replace(/data-ts="[^"]+"/g, 'data-ts="TS"')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} local/g, 'CLOCK local');
}

describe('render-board.mjs against a scratch database', () => {
  before(async () => {
    const created = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '5'], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    E2E.url = JSON.parse(created.stdout).url;
    assertScratchUrl(E2E.url);
    E2E.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
    for (const n of ['rootA', 'rootC', 'rootArt', 'rootBad', 'noBoard']) {
      E2E[n] = path.join(E2E.tmp, n);
      fs.mkdirSync(E2E[n]);
    }
    E2E.registry = path.join(E2E.tmp, 'registry.json');
    E2E.home = path.join(E2E.tmp, 'home'); // the resolver reads <home>/continuous-claude/.claude/artifacts.json; never the live one
    fs.mkdirSync(E2E.home);
    fs.writeFileSync(E2E.registry, JSON.stringify({
      version: '1.0',
      projects: [
        { name: 'rb-c', key: 'continuous-claude', path: fwd(E2E.rootC), status: 'active' },
        { name: 'rb-a', key: 'zz-rb-a', path: fwd(E2E.rootA), status: 'active' },
        { name: 'rb-art', key: 'zz-rb-art', path: fwd(E2E.rootArt), status: 'active', laneArtifact: 'https://claude.ai/artifact/ZzRbArtifact0001' },
        { name: 'rb-bad', key: 'zz-rb-bad', path: fwd(E2E.rootBad), status: 'active', laneArtifact: 'http://claude.ai/artifact/ZzRbArtifact0002' },
        { name: 'rb-gone', key: 'zz-rb-gone', path: fwd(path.join(E2E.tmp, 'gone')), status: 'inactive' },
      ],
    }));
    const { Client } = loadPg();
    const c = new Client({ connectionString: E2E.url });
    await c.connect();
    try {
      await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES
        ('zz-rb-s-c', $1, 'work on c', now()), ('zz-rb-s-a', $2, 'work on a', now()), ('zz-rb-s-away', 'c:/somewhere/else', 'away', now())`,
      [fwd(E2E.rootC).toLowerCase(), fwd(E2E.rootA).toLowerCase()]);
      // Quiet sessions of board c: 30 min and 3 h since the last beat, and 5 h with an open lane. Only the first and the lane holder are "open, quiet".
      await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at) VALUES
        ('zz-rb-s-q30', $1, 'zzsleep-30m', now() - interval '30 minutes', now() - interval '30 minutes'),
        ('zz-rb-s-q3h', $1, 'zzsleep-3h', now() - interval '3 hours', now() - interval '3 hours'),
        ('zz-rb-s-qhold', $1, 'zzsleep-holder', now() - interval '5 hours', now() - interval '5 hours')`, [fwd(E2E.rootC).toLowerCase()]);
      // An ended session that still holds an open lane is not open: ended_at is its latest signal.
      await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at, ended_at) VALUES
        ('zz-rb-s-qend', $1, 'zzsleep-ended', now() - interval '20 minutes', now() - interval '20 minutes', now() - interval '10 minutes')`, [fwd(E2E.rootC).toLowerCase()]);
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, project_key, owner_session_id, lease_expires_at) VALUES
        ('zz-rb-ccv3-qend', 'ccv3 lane held by an ended session', 'zz', 'backlog', 'continuous-claude', 'zz-rb-s-qend', now() - interval '5 minutes')`);
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, project_key, owner_session_id, lease_expires_at) VALUES
        ('zz-rb-ccv3-qhold', 'ccv3 lane held by a sleeper', 'zz', 'backlog', 'continuous-claude', 'zz-rb-s-qhold', now() + interval '30 minutes')`);
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, project_key, owner_session_id, lease_expires_at) VALUES
        ('zz-rb-ccv3-lane', 'ccv3 lane title', 'zz', 'ready', 'continuous-claude', NULL, NULL),
        ('zz-rb-ccv3-held', 'ccv3 held title', 'zz', 'active', 'continuous-claude', 'zz-rb-s-c', now() + interval '30 minutes'),
        ('zz-rb-art-lane', 'board art lane title', 'zz', 'ready', 'zz-rb-art', NULL, NULL),
        ('zz-rb-bad-lane', 'board bad lane title', 'zz', 'ready', 'zz-rb-bad', NULL, NULL),
        ('zz-rb-a-lane', 'board a lane title', 'zz', 'ready', 'zz-rb-a', NULL, NULL),
        ('zz-rb-a-held', 'board a held title', 'zz', 'active', 'zz-rb-a', 'zz-rb-s-a', now() + interval '30 minutes')`);
      // Priority 1 and 2 ready lanes, and one lane in each other state, to pin column placement and order on the read-only page.
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, priority, project_key, band) VALUES
        ('zz-rb-a-p2', 'board a ready priority two', 'zz', 'ready', 2, 'zz-rb-a', NULL),
        ('zz-rb-a-p1', 'board a ready priority one', 'zz', 'ready', 1, 'zz-rb-a', 'P0'),
        ('zz-rb-a-blocked', 'board a blocked title', 'zz', 'blocked', 50, 'zz-rb-a', NULL),
        ('zz-rb-a-backlog', 'board a backlog title', 'zz', 'backlog', 50, 'zz-rb-a', NULL),
        ('zz-rb-a-review', 'board a review title', 'zz', 'review', 50, 'zz-rb-a', NULL),
        ('zz-rb-a-done', 'board a done title', 'zz', 'done', 50, 'zz-rb-a', 'P0'),
        ('zz-rb-a-long', $1, 'zz', 'backlog', 50, 'zz-rb-a', NULL)`, [LONG_TITLE]);
      // Bands. continuous-claude: six P0 (one over the cap of 5), three P1 (a due date, two ranks), two P2 (one title needs escaping),
      // a done lane that still carries P0. The four older open lanes have no band: they are Unsorted. board a: one P0, plus a done P0.
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, priority, band, due_at, project_key) VALUES
        ('zz-rb-p0-1', 'p0 one', 'zz', 'ready', 11, 'P0', NULL, 'continuous-claude'),
        ('zz-rb-p0-2', 'p0 two', 'zz', 'ready', 12, 'P0', NULL, 'continuous-claude'),
        ('zz-rb-p0-3', 'p0 three', 'zz', 'ready', 13, 'P0', NULL, 'continuous-claude'),
        ('zz-rb-p0-4', 'p0 four', 'zz', 'backlog', 14, 'P0', NULL, 'continuous-claude'),
        ('zz-rb-p0-5', 'p0 five', 'zz', 'blocked', 15, 'P0', NULL, 'continuous-claude'),
        ('zz-rb-p0-6', 'p0 six', 'yy', 'ready', 16, 'P0', NULL, 'continuous-claude'),
        ('zz-rb-p1-rank20', 'p1 rank twenty', 'zz', 'ready', 20, 'P1', NULL, 'continuous-claude'),
        ('zz-rb-p1-rank5', 'p1 rank five', 'zz', 'ready', 5, 'P1', NULL, 'continuous-claude'),
        ('zz-rb-p1-due', 'p1 has a due date', 'yy', 'ready', 99, 'P1', now() + interval '20 days', 'continuous-claude'),
        ('zz-rb-p2-plain', 'p2 plain', 'zz', 'backlog', 60, 'P2', NULL, 'continuous-claude'),
        ('zz-rb-p2-xss', '<b>bold</b> "quoted" & done', 'zz', 'backlog', 61, 'P2', NULL, 'continuous-claude'),
        ('zz-rb-done-p0', 'done lane with a band', 'zz', 'done', 5, 'P0', NULL, 'continuous-claude')`);
      // Scheduled and reminders (PR-F). The times are relative to the insert, so a slow run still reads "in 3h" (3 h 30 min ahead).
      //   sch-future  ready, due in 3 h 30 min                        -> Scheduled, chip "in 3h"
      //   sch-rem     reminders track, due 10 min ago, needs_dave     -> Scheduled, chip DUE, above sch-future
      //   sch-acked   reminders track, due an hour ago, acked         -> not Scheduled; Next (ready lane)
      //   sch-past    ready, due 2 h ago, not a reminder              -> not Scheduled; Next
      //   sch-held    active (held), due in 2 h                       -> In progress, not Scheduled
      //   zz-rb-a-sched  board a, ready, due in 5 h 30 min            -> Scheduled on the read-only page
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, priority, scope, note, due_at, remind_state, project_key) VALUES
        ('zz-rb-sch-future', $1, 'zz', 'ready', 50, $2, 'sch last note', now() + interval '3 hours 30 minutes', NULL, 'continuous-claude'),
        ('zz-rb-sch-rem', 'reminder that needs Dave', 'reminders', 'ready', 50, NULL, NULL, now() - interval '10 minutes', 'needs_dave', 'continuous-claude'),
        ('zz-rb-sch-acked', 'acked reminder', 'reminders', 'ready', 50, NULL, NULL, now() - interval '1 hour', 'acked', 'continuous-claude'),
        ('zz-rb-sch-past', 'past due normal lane', 'zz', 'ready', 50, NULL, NULL, now() - interval '2 hours', NULL, 'continuous-claude'),
        ('zz-rb-a-sched', 'board a lane due later', 'zz', 'ready', 50, NULL, NULL, now() + interval '5 hours 30 minutes', NULL, 'zz-rb-a')`, [SCH_TITLE, 'sch <i>scope</i>']);
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, owner_session_id, lease_expires_at, due_at, project_key) VALUES
        ('zz-rb-sch-held', 'held with a due time', 'zz', 'active', 'zz-rb-s-c', now() + interval '30 minutes', now() + interval '2 hours', 'continuous-claude')`);
      await c.query(`INSERT INTO agentic_os.lane_event (session_id, kind, lane_id, body, project_key) VALUES
        ('zz-rb-s-c', 'note', 'zz-rb-ccv3-lane', 'ccv3 event body', 'continuous-claude'),
        ('zz-rb-s-a', 'note', 'zz-rb-a-lane', 'board a event body', 'zz-rb-a')`);
      // Done lanes of continuous-claude (zz-rb-done-p0 above has no event: its time is updated_at, which is now).
      //   dn-today   a 'done' event just now           -> Today
      //   dn-yday    a 'done' event yesterday 12:00    -> Yesterday
      //   dn-kanban  ONLY a kanban sync event, to done, yesterday 15:00 -> Yesterday, above dn-yday
      //   dn-old     a 'done' event 9 days ago, plus a kanban note event to 'done' and a kanban state event to 'ready' just now (neither counts)
      //   dn-twice   a 'done' event 9 days ago AND a kanban state event to done a second ahead of now: the NEWEST counts (max, not min), so it is the first card under Today
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, priority, scope, note, project_key) VALUES
        ('zz-rb-dn-today', $1, 'zz', 'done', 50, $2, $3, 'continuous-claude'),
        ('zz-rb-dn-yday', 'done yesterday', 'zz', 'done', 50, NULL, NULL, 'continuous-claude'),
        ('zz-rb-dn-kanban', 'done by the sync only', 'yy', 'done', 50, NULL, NULL, 'continuous-claude'),
        ('zz-rb-dn-old', 'done nine days ago', 'zz', 'done', 50, NULL, NULL, 'continuous-claude'),
        ('zz-rb-dn-twice', 'done, reopened and done again', 'zz', 'done', 50, NULL, NULL, 'continuous-claude')`, [DN_TITLE, 'dn <i>scope</i>', DN_NOTE]);
      await c.query(`INSERT INTO agentic_os.lane_event (session_id, kind, lane_id, project_key, occurred_at, detail) VALUES
        ('zz-rb-s-c', 'done', 'zz-rb-dn-today', 'continuous-claude', $1, '{}'),
        ('zz-rb-s-c', 'done', 'zz-rb-dn-yday', 'continuous-claude', $2, '{}'),
        ('zz-rb-s-c', 'kanban', 'zz-rb-dn-kanban', 'continuous-claude', $3, '{"kind":"state","from":"review","to":"done"}'),
        ('zz-rb-s-c', 'done', 'zz-rb-dn-old', 'continuous-claude', $4, '{}'),
        ('zz-rb-s-c', 'kanban', 'zz-rb-dn-old', 'continuous-claude', $5, '{"kind":"note","to":"done"}'),
        ('zz-rb-s-c', 'kanban', 'zz-rb-dn-old', 'continuous-claude', $5, '{"kind":"state","from":"done","to":"ready"}'),
        ('zz-rb-s-c', 'done', 'zz-rb-dn-twice', 'continuous-claude', $4, '{}'),
        ('zz-rb-s-c', 'kanban', 'zz-rb-dn-twice', 'continuous-claude', $6, '{"kind":"state","from":"review","to":"done"}')`,
      [new Date(), noon(1), new Date(noon(1).getTime() + 3 * 3600 * 1000), noon(9), new Date(), new Date(Date.now() + 1000)]);
    } finally { await c.end(); }
  });

  after(() => {
    if (E2E.url) { assertScratchUrl(E2E.url); spawnSync(process.execPath, [SCRATCH, 'drop', E2E.url], { encoding: 'utf8' }); }
    if (E2E.tmp) fs.rmSync(E2E.tmp, { recursive: true, force: true });
  });

  it('--project continuous-claude --out writes the CCv3 page: its lanes, the kanban script, a stamp, and nothing of board a', () => {
    const out = path.join(E2E.tmp, 'ccv3.html');
    const r = renderPage(['--project', 'continuous-claude', '--out', out]);
    assert.equal(r.code, 0, r.all);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('zz-rb-ccv3-lane') && html.includes('zz-rb-ccv3-held'));
    assert.ok(html.includes('ccv3 event body'));
    assert.ok(!html.includes('zz-rb-a-lane') && !html.includes('board a event body') && !html.includes('zz-rb-s-a'), 'board a leaked into the CCv3 page');
    assert.ok(html.includes('id="kb-data"'), 'the CCv3 page keeps the kanban');
    assert.deepEqual(parseBoardStamp(html) && Object.keys(parseBoardStamp(html)), ['board', 'template', 'generated']);
    assert.equal(parseBoardStamp(html).board, 'continuous-claude');
    assert.match(parseBoardStamp(html).template, /^[0-9a-f]{8}$/);
    assert.ok(!Number.isNaN(Date.parse(parseBoardStamp(html).generated)));
    assert.match(html, /id="gen-ago" data-ts="[^"]+"/, 'the page needs the embedded time for the generated N min ago badge');
    assert.match(r.out, new RegExp(`wrote .*ccv3\\.html.*board continuous-claude`));
  });

  it('the header counts active (5 min) and open, quiet sessions apart: a quiet lane holder counts, a session seen 3 h ago does not', () => {
    const out = path.join(E2E.tmp, 'ccv3-counters.html');
    assert.equal(renderPage(['--project', 'continuous-claude', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    const ctr = (label) => new RegExp(String.raw`<b>(\d+)</b><span>${label}</span>`).exec(html)?.[1];
    assert.equal(ctr(String.raw`active \(5 min\)`), '1', 'zz-rb-s-c beat just now; the quiet ones are not active');
    assert.equal(ctr('open, quiet'), '2', 'zz-rb-s-q30 (30 min) and zz-rb-s-qhold (holds an open lane); zz-rb-s-q3h is out, zz-rb-s-qend ended');
    assert.ok(!html.includes('<span>live sessions</span>'), 'the old "live sessions" label is gone');
    // The NOW cards stay on active sessions only.
    assert.ok(!html.includes('zzsleep-30m') && !html.includes('zzsleep-holder'), 'a quiet session showed in the Right now cards');
  });

  it('the header shows claude.exe matched by start time, in red with the pid when one has no session; nothing when the list is unknown', () => {
    const out = path.join(E2E.tmp, 'ccv3-procs.html');
    // Year 2001: no fixture session started within 10 s of it, so the one process stays unmatched.
    const procs = JSON.stringify([{ pid: 4242, startMs: Date.UTC(2001, 0, 1) }]);
    const r = renderPage(['--project', 'continuous-claude', '--out', out], { env: { LANE_CLAUDE_PROCESSES: procs } });
    assert.equal(r.code, 0, r.all);
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, /<span class="ctr is-crit" title="[^"]*no session for pid 4242"><b>0\/1<\/b><span>claude\.exe matched<\/span>/);
    assert.match(r.out, /0\/1 claude\.exe matched/);
    const none = path.join(E2E.tmp, 'ccv3-noprocs.html');
    assert.equal(renderPage(['--project', 'continuous-claude', '--out', none], { env: { LANE_CLAUDE_PROCESSES: 'not json' } }).code, 0);
    assert.ok(!fs.readFileSync(none, 'utf8').includes('claude.exe matched'));
  });

  it('--project zz-rb-a writes a page with only board a, a read-only Priorities section with board a lanes, and the stamp of board a', () => {
    const out = path.join(E2E.tmp, 'a.html');
    const r = renderPage(['--project', 'zz-rb-a', '--out', out]);
    assert.equal(r.code, 0, r.all);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('zz-rb-a-lane') && html.includes('zz-rb-a-held'));
    assert.ok(html.includes('board a event body'));
    assert.ok(!html.includes('zz-rb-ccv3') && !html.includes('ccv3 event body') && !html.includes('zz-rb-s-c'), 'CCv3 leaked into board a');
    assert.ok(!html.includes('zz-rb-s-away'), 'a session outside the board roots showed up');
    assert.ok(html.includes('zz-rb-s-a'.slice(0, 8)) || html.includes('zz-rb-s'), 'the live session of board a is listed');
    assert.equal(parseBoardStamp(html).board, 'zz-rb-a');
    assert.match(html, /<title>[^<]*zz-rb-a[^<]*<\/title>/);

    // The Priorities section: board a's lanes in the right columns, nothing of CCv3 in any column.
    const section = /<section id="priorities"[\s\S]*?<\/section>/.exec(html)?.[0];
    assert.ok(section, 'a board other than continuous-claude shows a Priorities section');
    assert.ok(html.indexOf('<section id="priorities"') < html.indexOf('<h2>Right now</h2>'), 'Priorities comes before Right now');
    assert.match(section, /<h2 id="kb-title">Priorities<\/h2>/);
    // All six columns exist, in order, Done last. Scheduled holds the one board a lane with a future due time. Waiting on Dave holds the blocked lane (placeLanes, no saved order).
    assert.deepEqual([...section.matchAll(/data-col="(\w+)"/g)].map((m) => m[1]), ['scheduled', 'next', 'later', 'waiting', 'progress', 'done']);
    assert.match(section, /data-col="scheduled" data-fixed="1" data-n="1"/);
    assert.match(section, /data-col="waiting" data-n="1"/);
    // LEAK GATE: no CCv3 lane in any column.
    assert.ok(!section.includes('zz-rb-ccv3') && !section.includes('ccv3 lane title') && !section.includes('ccv3 held title'), 'a CCv3 lane showed in a column of board a');
  });

  it('the read-only page puts each state in its column, orders by priority, and drops done lanes', () => {
    const out = path.join(E2E.tmp, 'a-cols.html');
    assert.equal(renderPage(['--project', 'zz-rb-a', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    const section = /<section id="priorities"[\s\S]*?<\/section>/.exec(html)[0];
    const ids = (col) => {
      const body = new RegExp(`<ul class="kb-list" id="kb-list-${col}">([\\s\\S]*?)<\\/ul>`).exec(section)?.[1] ?? '';
      return [...body.matchAll(/<li class="card kb-card[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]);
    };
    // Next: ready lanes by priority (1, 2, then the default 50).
    assert.deepEqual(ids('next'), ['zz-rb-a-p1', 'zz-rb-a-p2', 'zz-rb-a-lane']);
    // Later: every other open state, in DB order at equal priority. Blocked is not here: with no saved order it goes to Waiting on Dave.
    assert.deepEqual(ids('later').sort(), ['zz-rb-a-backlog', 'zz-rb-a-long', 'zz-rb-a-review']);
    assert.deepEqual(ids('progress'), ['zz-rb-a-held']);
    assert.deepEqual(ids('waiting'), ['zz-rb-a-blocked']);
    // The scheduled lane is in no movable column, and is not a kb-card at all.
    assert.deepEqual(ids('scheduled'), []);
    for (const col of ['next', 'later', 'waiting', 'progress']) assert.ok(!ids(col).includes('zz-rb-a-sched'), `a scheduled lane is in the ${col} column`);
    // A done lane is in no OPEN column. It is in Done (read-only, tested in the Done column block), which this helper does not read.
    for (const col of ['next', 'later', 'waiting', 'progress']) assert.ok(!ids(col).includes('zz-rb-a-done'), `a done lane is in the ${col} column`);
    // Counts agree with the cards.
    assert.match(section, /data-col="next" data-n="3"/);
    assert.match(section, /data-col="later" data-n="3"/);
    assert.match(section, /data-col="waiting" data-n="1"/);
    // Waiting and Scheduled are not empty here, so they show no empty text.
    const empty = (col) => new RegExp(`id="kb-list-${col}"><li class="kb-empty">([^<]*)</li>`).exec(section)?.[1];
    assert.equal(empty('waiting'), undefined);
    assert.equal(empty('scheduled'), undefined);
  });

  it('read-only cards show the whole title, name each Details by lane, keep no countdown and call the rank an unsaved order', () => {
    const out = path.join(E2E.tmp, 'a-card.html');
    assert.equal(renderPage(['--project', 'zz-rb-a', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    const section = /<section id="priorities"[\s\S]*?<\/section>/.exec(html)[0];
    // The full long title is in the markup, and the read-only section lifts the 3-line clamp.
    assert.ok(section.includes('long title start') && section.includes('long title END'));
    assert.match(html, /\.kb-ro \.kb-title \{[^}]*overflow:visible/);
    assert.match(html, /\.kb-ro \.kb-lease[^{]*\{[^}]*var\(--muted\)/);
    // Each Details has a name that carries the lane id.
    for (const id of ['zz-rb-a-lane', 'zz-rb-a-held', 'zz-rb-a-blocked']) {
      assert.ok(section.includes(`<summary>Details<span class="sr"> for ${id}</span></summary>`), `Details for ${id} has no accessible name`);
    }
    assert.ok(section.includes('title="Priority order (not a saved order)"'));
    assert.ok(!section.includes('Rank in this column'));
    // In progress: no "Not reorderable" line, a lease end time and no "Nm left" countdown.
    assert.ok(!section.includes('Not reorderable') && !section.includes('Held by a session'));
    assert.match(section, /lease ends [A-Z][a-z]{2} \d+, \d+:\d{2}/);
    assert.doesNotMatch(section, /\d+m left/);
  });

  it('the read-only page carries no kanban script, no save and no artifact db reference', () => {
    const out = path.join(E2E.tmp, 'a-ro.html');
    assert.equal(renderPage(['--project', 'zz-rb-a', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    // Markup and script strings. The kb-* CSS is on every page, so only markup attributes are matched here.
    for (const marker of [
      'function placeLanes', 'claude.use', 'kanban/board', 'onSnapshot', 'id="kb-data"', 'id="kb-order"', 'id="kb-live"',
      'id="kb-status"', 'class="kb-to"', 'class="kb-bd"', 'class="kb-grip"', 'class="kb-btn kb-plain"', 'class="kb-btn kb-save"', 'class="kb-btn kb-up"',
      'class="kb-btn kb-next"', 'class="kb-btn kb-done"', "'kb-btn kb-undo'", 'class="kb-ctl"', 'class="kb-flag"',
      'class="kb-edit"', 'class="kb-more"', 'class="kb-head"',
    ]) {
      assert.ok(!html.includes(marker), `a read-only page must not carry ${marker}`);
    }
  });

  it('the continuous-claude page keeps the interactive kanban and none of the read-only markup', () => {
    const out = path.join(E2E.tmp, 'ccv3-interactive.html');
    assert.equal(renderPage(['--project', 'continuous-claude', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    for (const marker of [
      'Drag, or use Do next and Move to, to reorder.', 'class="kb-grip"', 'class="kb-to"', 'class="kb-bd"', 'class="kb-btn kb-next"', 'class="kb-btn kb-done"', 'id="kb-order"', 'id="kb-data"',
      'function placeLanes', 'claude.use', 'kanban/board', 'class="kb-head"', 'class="kb-more"',
    ]) {
      assert.ok(html.includes(marker), `the CCv3 page lost ${marker}`);
    }
    // kb-ro-detail is not a read-only marker any more: the Done cards of every page use that native <details> (PR-D).
    for (const marker of ['class="kb-ro"', 'class="kb-h kb-ro-h"', 'Read-only snapshot', 'class="kb-empty"']) {
      assert.ok(!html.includes(marker), `the read-only marker ${marker} leaked into the CCv3 page`);
    }
  });

  it('the Columns cards carry Do next, Done and Move to with one placeholder option; By band, In progress and the old Up and Down carry none', () => {
    const out = path.join(E2E.tmp, 'ccv3-buttons.html');
    assert.equal(renderPage(['--project', 'continuous-claude', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    const columns = /<div class="kb-board" id="kb-board"[^>]*>([\s\S]*?)<script type="application\/json" id="kb-data">/.exec(html)[1];
    const cut = columns.indexOf('data-col="progress"');
    const cardsIn = (part) => part.split('<li class="card kb-card"').slice(1);
    const movable = cardsIn(columns.slice(0, cut));
    assert.ok(movable.length >= 4, 'the test page has movable cards');
    for (const c of movable) {
      const id = /data-id="([^"]+)"/.exec(c)[1];
      assert.ok(c.includes('<button class="kb-btn kb-next" type="button" aria-label="Do next: ' + id + '" disabled>Do next</button>'), id + ': Do next');
      assert.ok(c.includes('<button class="kb-btn kb-done" type="button" aria-label="Mark ' + id + ' done" disabled>Done</button>'), id + ': Done');
      const select = /<select class="kb-to"[^>]*>([\s\S]*?)<\/select>/.exec(c)[1];
      assert.equal(select, '<option value="" selected>Move to\u2026</option>', id + ': the select holds more than its placeholder');
      assert.ok(!c.includes('kb-up') && !c.includes('kb-dn'), id + ': Up or Down is back');
    }
    const progress = columns.slice(cut);
    assert.ok(progress.includes('kb-card') && !progress.includes('kb-ctl'), 'a card that a session holds has controls');
    const bb = /<div class="bb" id="bb">[\s\S]*?<!-- \/bb -->/.exec(html)[0];
    assert.ok(!/kb-next|kb-done|kb-to|kb-undo|<button/.test(bb), 'By band has a control');
    assert.ok(!html.includes('class="kb-flag"') && !html.includes('class="kb-btn kb-undo"'), 'the flag and Undo are made by the page script, not drawn by the server');
  });

  it('PR-G: every editable card (Columns and In progress) has exactly one empty Band select; By band and the read-only page have none', () => {
    const out = path.join(E2E.tmp, 'ccv3-band-select.html');
    assert.equal(renderPage(['--project', 'continuous-claude', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    const columns = /<div class="kb-board" id="kb-board"[^>]*>([\s\S]*?)<script type="application\/json" id="kb-data">/.exec(html)[1];
    const cards = columns.split('<li class="card kb-card"').slice(1);
    assert.ok(cards.length >= 4, 'the test page has cards');
    for (const c of cards) {
      const id = /data-id="([^"]+)"/.exec(c)[1];
      const sels = [...c.matchAll(/<select class="kb-bd"[^>]*>([\s\S]*?)<\/select>/g)];
      assert.equal(sels.length, 1, `${id}: ${sels.length} Band selects`);
      assert.equal(sels[0][1], '', `${id}: the server drew the options (the client fills them, to keep the page small)`);
      assert.match(sels[0][0], /disabled/, `${id}: the Band select is on before the cards load`);
      assert.match(c, /<span>Band<\/span><select class="kb-bd"/, `${id}: the label`);
    }
    const bb = /<div class="bb" id="bb">[\s\S]*?<!-- \/bb -->/.exec(html)[0];
    assert.ok(!bb.includes('kb-bd'), 'By band has a Band select');
    const ro = path.join(E2E.tmp, 'ccv3-band-select-ro.html');
    assert.equal(renderPage(['--project', 'zz-rb-a', '--out', ro]).code, 0);
    assert.ok(!fs.readFileSync(ro, 'utf8').includes('<select class="kb-bd"'), 'the read-only page carries a Band select');
  });

  it('--interactive on a foreign board gives kb-data with only that board\'s lanes, every interactive marker, and keeps the board\'s name in the title and masthead', () => {
    const out = path.join(E2E.tmp, 'a-interactive.html');
    const r = renderPage(['--project', 'zz-rb-a', '--interactive', '--out', out]);
    assert.equal(r.code, 0, r.all);
    const html = fs.readFileSync(out, 'utf8');
    for (const marker of [
      'function placeLanes', 'claude.use', 'kanban/board', 'onSnapshot', 'id="kb-data"', 'id="kb-order"', 'id="kb-live"', 'id="kb-status"',
      'class="kb-to"', 'class="kb-bd"', 'class="kb-grip"', 'class="kb-btn kb-plain"', 'class="kb-btn kb-save"', 'class="kb-btn kb-next"', 'class="kb-btn kb-done"', 'class="kb-edit"',
      'class="kb-more"', 'class="kb-head"', 'Your order saves to this board',
    ]) {
      assert.ok(html.includes(marker), `an interactive foreign page must carry ${marker}`);
    }
    // kb-ro-detail is shared with the Done cards of every page (PR-D), so it is not a read-only marker.
    for (const marker of ['class="kb-ro"', 'class="kb-h kb-ro-h"', 'Read-only snapshot', 'class="kb-empty"']) {
      assert.ok(!html.includes(marker), `the read-only marker ${marker} is on an interactive page`);
    }
    // The page's own lanes, and none of CCv3's.
    const data = JSON.parse(/<script type="application\/json" id="kb-data">([\s\S]*?)<\/script>/.exec(html)[1].replace(/\\u003c/g, '<'));
    assert.ok(data.length >= 9, 'board a has nine lanes');
    assert.ok(data.every((l) => l.id.startsWith('zz-rb-a-')), `a lane of another board is in kb-data: ${data.map((l) => l.id)}`);
    assert.ok(!html.includes('zz-rb-ccv3') && !html.includes('ccv3 lane title'), 'CCv3 leaked into the interactive page of board a');
    // Identity stays the board's: interactivity does not make this the default page.
    assert.match(html, /<title>[^<]*zz-rb-a[^<]*<\/title>/);
    assert.match(html, /<b>Lane Board &middot; zz-rb-a<\/b>/);
    assert.equal(parseBoardStamp(html).board, 'zz-rb-a');
  });

  it('a board whose registry entry has a laneArtifact renders the interactive kanban with no --interactive flag, and keeps its own identity', () => {
    const out = path.join(E2E.tmp, 'art-noflag.html');
    const r = renderPage(['--project', 'zz-rb-art', '--out', out]);
    assert.equal(r.code, 0, r.all);
    const html = fs.readFileSync(out, 'utf8');
    for (const marker of ['id="kb-data"', 'id="kb-order"', 'function placeLanes', 'claude.use', 'kanban/board', 'class="kb-to"', 'class="kb-btn kb-save"']) {
      assert.ok(html.includes(marker), `a board with a laneArtifact must render ${marker} without the flag`);
    }
    for (const marker of ['class="kb-ro"', 'Read-only snapshot', 'class="kb-empty"']) {
      assert.ok(!html.includes(marker), `the read-only marker ${marker} is on a page whose board has a laneArtifact`);
    }
    const data = JSON.parse(/<script type="application\/json" id="kb-data">([\s\S]*?)<\/script>/.exec(html)[1].replace(/\\u003c/g, '<'));
    assert.deepEqual(data.map((l) => l.id), ['zz-rb-art-lane']);
    assert.ok(!html.includes('zz-rb-ccv3') && !html.includes('zz-rb-a-lane'), 'another board leaked into the page');
    assert.match(html, /<title>[^<]*zz-rb-art[^<]*<\/title>/);
    assert.ok(KB_SCRIPT_RE.exec(html)?.[0].includes('var KB_BOARD = "zz-rb-art";'));
    assert.equal(parseBoardStamp(html).board, 'zz-rb-art');
  });

  it('a board with no laneArtifact, or a malformed one, stays read-only without the flag', () => {
    for (const board of ['zz-rb-a', 'zz-rb-bad']) {
      const out = path.join(E2E.tmp, `ro-${board}.html`);
      assert.equal(renderPage(['--project', board, '--out', out]).code, 0);
      const html = fs.readFileSync(out, 'utf8');
      assert.ok(!html.includes('id="kb-data"') && !html.includes('function placeLanes'), `${board}: the interactive kanban leaked into a board with no valid laneArtifact`);
      assert.ok(html.includes('<section id="priorities"'), `${board}: the read-only Priorities section is missing`);
    }
  });

  it('the page knows its own board, so the client can refuse another board\'s saved order, and every helper it calls is inlined', () => {
    for (const [board, flags] of [['continuous-claude', []], ['zz-rb-a', ['--interactive']]]) {
      const out = path.join(E2E.tmp, `guard-${board}.html`);
      assert.equal(renderPage(['--project', board, ...flags, '--out', out]).code, 0);
      const html = fs.readFileSync(out, 'utf8');
      const script = KB_SCRIPT_RE.exec(html)?.[0];
      assert.ok(script, `${board}: the kanban script block is missing`);
      assert.ok(script.includes(`var KB_BOARD = "${board}";`), `${board}: the page does not name its board`);
      for (const helper of ['boardMismatch', 'boardWriteKind', 'mergeUnknownColumns', 'bandAhead', 'doneChip']) {
        assert.ok(script.includes(`function ${helper}(`), `${board}: the page calls ${helper} but does not inline it`);
      }
      assert.ok(script.indexOf('var KB_BOARD') < script.indexOf('(function () {'), 'KB_BOARD must come before the client');
    }
  });

  it('--interactive changes nothing on the continuous-claude page (same bytes once the stamp and clock are masked)', () => {
    const base = path.join(E2E.tmp, 'ccv3-noflag.html');
    const flagged = path.join(E2E.tmp, 'ccv3-flag.html');
    const nodeArgs = ['--import', freezeClock()];
    assert.equal(renderPage(['--project', 'continuous-claude', '--out', base], { nodeArgs, env: { TZ: 'UTC' } }).code, 0);
    assert.equal(renderPage(['--project', 'continuous-claude', '--interactive', '--out', flagged], { nodeArgs, env: { TZ: 'UTC' } }).code, 0);
    assert.equal(maskPage(fs.readFileSync(flagged, 'utf8')), maskPage(fs.readFileSync(base, 'utf8')));
  });

  // Opt-in golden. The default page must not change outside the kanban script. The "before" is the generator of a git ref
  // (RENDER_BOARD_BASELINE_REF, e.g. fork/main before this change). It cannot be pinned in the repo: the next intended
  // template edit would fail it for ever. Run it once per template change that must not touch the default page.
  const BASELINE_REF = process.env.RENDER_BOARD_BASELINE_REF || '';
  it('golden: the continuous-claude page matches the generator at RENDER_BOARD_BASELINE_REF in every byte outside the kanban script', { skip: BASELINE_REF ? false : 'set RENDER_BOARD_BASELINE_REF=<git ref> to compare with that generator' }, () => {
    const shown = spawnSync('git', ['show', `${BASELINE_REF}:scripts/coordination/render-board.mjs`], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(shown.status, 0, shown.stderr);
    // Next to the real one, so its relative imports resolve. It is removed in the finally block.
    const beforeFile = path.join(HERE, `render-board.baseline-${process.pid}.mjs`);
    fs.writeFileSync(beforeFile, shown.stdout);
    try {
      const nodeArgs = ['--import', freezeClock()];
      const a = path.join(E2E.tmp, 'golden-before.html');
      const b = path.join(E2E.tmp, 'golden-after.html');
      const before = renderPage(['--project', 'continuous-claude', '--out', a], { nodeArgs, script: beforeFile, env: { TZ: 'UTC' } });
      assert.equal(before.code, 0, before.all);
      assert.equal(renderPage(['--project', 'continuous-claude', '--out', b], { nodeArgs, env: { TZ: 'UTC' } }).code, 0);
      const strip = (f) => maskPage(fs.readFileSync(f, 'utf8')).replace(KB_SCRIPT_RE, 'KANBAN-SCRIPT');
      const [x, y] = [strip(a), strip(b)];
      assert.ok(x.includes('KANBAN-SCRIPT') && x.includes('id="kb-data"'), 'the golden lost its anchors');
      assert.equal(y.length, x.length, 'the default page changed size outside the kanban script');
      assert.equal(y, x);
    } finally {
      fs.rmSync(beforeFile, { force: true });
    }
  });

  it('the old positional [out.html] still writes the page (board from the cwd), and no half-written temp file stays', () => {
    const out = path.join(E2E.tmp, 'positional.html');
    const r = renderPage([out], { cwd: E2E.rootA });
    assert.equal(r.code, 0, r.all);
    assert.equal(parseBoardStamp(fs.readFileSync(out, 'utf8')).board, 'zz-rb-a');
    assert.deepEqual(fs.readdirSync(E2E.tmp).filter((n) => n.includes('.tmp')), []);
  });

  it('LANE_PROJECT picks the board when no flag is given', () => {
    const out = path.join(E2E.tmp, 'env.html');
    const r = renderPage(['--out', out], { cwd: E2E.noBoard, env: { LANE_PROJECT: 'zz-rb-a' } });
    assert.equal(r.code, 0, r.all);
    assert.equal(parseBoardStamp(fs.readFileSync(out, 'utf8')).board, 'zz-rb-a');
  });

  it('an unknown key exits 1 and writes nothing; so does a cwd with no board, and it prints the register hint', () => {
    const none = path.join(E2E.tmp, 'none.html');
    const bad = renderPage(['--project', 'zz-nope', '--out', none]);
    assert.equal(bad.code, 1, bad.all);
    assert.match(bad.err, /unknown board 'zz-nope'/);
    const inactive = renderPage(['--project', 'zz-rb-gone', '--out', none]);
    assert.equal(inactive.code, 1, inactive.all);
    const lost = renderPage(['--out', none], { cwd: E2E.noBoard });
    assert.equal(lost.code, 1, lost.all);
    assert.match(lost.err, /no lane board for /);
    assert.match(lost.err, /register it: node \S*\/\.claude\/scripts\/lane\.mjs project register /);
    assert.equal(fs.existsSync(none), false);
  });

  it('a bad flag exits 2, writes nothing, and a flag-looking word is never a file name', () => {
    const r = renderPage(['--projct', 'zz-rb-a']);
    assert.equal(r.code, 2, r.all);
    assert.match(r.err, /unknown argument: --projct/);
    assert.equal(fs.existsSync(path.join(E2E.rootC, '--projct')), false);
  });

  // Layout rules. The measured behaviour (widths, column counts, scroll, pinned header) is the Edge run in
  // .claude/cache/e2e/2026-11-06-board-wide.json; these pin the CSS and markup that produce it. Each fails if its rule is reverted.
  describe('page layout (emitted CSS and markup)', () => {
    let html = '';
    let css = '';
    before(() => {
      const out = path.join(E2E.tmp, 'layout.html');
      assert.equal(renderPage(['--project', 'continuous-claude', '--out', out]).code, 0);
      html = fs.readFileSync(out, 'utf8');
      css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
    });

    it('one variable sets the width of both .wrap and .top-in, capped at 2200px', () => {
      assert.match(css, /:root \{ --page-w:min\(2200px,100%\); \}/);
      assert.ok(!css.includes('min(1840px'), 'the old 1840px cap is still in the CSS');
      assert.match(css, /\.wrap \{ width:var\(--page-w\);/);
      assert.match(css, /\.top-in \{ width:var\(--page-w\);/);
      assert.ok(!css.includes('min(1240px'), 'the old 1240px cap is still in the CSS');
    });

    it('the Lanes and Activity sections keep a 1240px cap while the board is wide; the board and Right now stay uncapped', () => {
      assert.match(css, /\.sec-cap \{ max-width:1240px; \}/);
      assert.match(html, /<section class="sec-cap">\s*<div class="sec-head">\s*<h2>Lanes<\/h2>/);
      assert.match(html, /<section class="sec-cap">\s*<div class="sec-head"><h2>Activity<\/h2>/);
      assert.equal((html.match(/<section class="sec-cap">/g) || []).length, 2, 'only Lanes and Activity are capped');
    });

    it('the board is 3 columns by default, 6 from 1360px and 1 up to 720px; the old 1080px board rule is gone', () => {
      assert.match(css, /\.kb-board \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
      assert.match(css, /@media \(min-width:1360px\) \{ \.kb-board \{ grid-template-columns:repeat\(6,minmax\(0,1fr\)\); \} \}/);
      assert.match(css, /@media \(max-width:720px\) \{\s*\.kb-board \{ grid-template-columns:minmax\(0,1fr\); \}/);
      assert.doesNotMatch(css, /max-width:1080px\) \{ \.kb-board/);
    });

    it('each list scrolls inside itself from 721px up, and only there (the phone scrolls the page)', () => {
      assert.match(css, /@media \(min-width:721px\) \{ \.kb-list \{ max-height:calc\(100vh - 190px\); overflow-y:auto; \} \}/);
      assert.doesNotMatch(/\.kb-list \{[^}]*\}/.exec(css)[0], /max-height|overflow/, 'the base .kb-list rule must not scroll on the phone');
    });

    it('on the phone only .top-row is sticky and header.top gives up its box; on a wide screen the header stays sticky', () => {
      assert.match(css, /header\.top \{ position:sticky; top:0;/);
      const phone = /@media \(max-width:720px\) \{\s*header\.top, \.top-in \{ display:contents; \}\s*\.top-row \{ position:sticky; top:0;[^}]*\}/.exec(css)?.[0];
      assert.ok(phone, 'the phone header block is missing');
      assert.match(css, /\.top-row \{ display:contents; \}/, 'on a wide screen .top-row must add no box');
    });

    it('the counters sit outside .top-row, so they can scroll away on the phone', () => {
      const row = /<div class="top-row">([\s\S]*?)<\/div>\s*<div class="counters">/.exec(html)?.[1];
      assert.ok(row, 'the .top-row block is missing');
      assert.ok(row.includes('class="brand"') && row.includes('id="tt"'), 'the brand and the theme button belong in .top-row');
      assert.ok(!row.includes('class="ctr'), 'a counter is inside the pinned row');
      assert.ok(html.indexOf('class="counters"') > html.indexOf('class="top-row"'));
    });

    // PR-M1: phone fixes. The measured behaviour is the Edge run saved in .claude/cache/e2e/2026-11-07-pr-m1.{mjs,log,json} (360/390/430 px, overflow-anchor:none, 65px row); these pin the CSS that produces it.
    // block(query) is the text of the media block that opens with query, up to its closing brace at two-space indent.
    const block = (query) => {
      const i = css.indexOf(query);
      assert.ok(i >= 0, `the ${query} block is missing`);
      return css.slice(i, css.indexOf('\n  }', i));
    };
    const COARSE = '@media (pointer:coarse), (max-width:720px) {';
    const PHONE = '@media (max-width:720px) {\n    header.top';
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /** The bodies, joined, of every rule in text whose selector list contains sel. */
    const rule = (text, sel) => {
      const all = [...text.matchAll(new RegExp(`(?:^|[\\n}{;])\\s*([^{};]*${esc(sel)}[^{};]*)\\{([^}]*)\\}`, 'g'))];
      assert.ok(all.length, `no rule for ${sel}`);
      return all.map((m) => m[2]).join(' ');
    };
    const luminance = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    /** The colour tokens of one of the four sets, by the text that opens it. */
    const tokens = (open) => {
      const i = css.search(open);
      assert.ok(i >= 0, `token set ${open} is missing`);
      const body = css.slice(i, css.indexOf('}', i));
      return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]));
    };

    // PR-K1: the desktop board. The measured behaviour is the Edge run saved in .claude/cache/e2e/2026-11-07-desktop-board.{mjs,log,json}.
    // How it can fail, one test each:
    //   - the block is missing, or is not a fine-pointer block (a touch laptop or an iPad would lose the 3x2 grid)
    //   - the block targets #kb-board (0,1,0 + id beats the By band rule [data-view="band"] .kb-board and shows the board in By band)
    //   - the block is not between the 721px list rule and the phone block (it loses to nothing, but the order is the contract)
    //   - the board does not scroll sideways, a list does not scroll by itself, or scroll-snap undoes the edge scroll
    //   - the intro is hidden outside the Columns view, or the board loses its region name
    //   - the page script sets --kbh or the header padding without the same query, or leaves them set after a resize to a phone
    const DESK = '@media (min-width:721px) and (pointer:fine) {';
    describe('desktop board (PR-K1)', () => {
      const desk = () => block(DESK);

      it('the block is a fine-pointer block between the 721px list rule and the phone block, and never names the id', () => {
        const at = css.indexOf(DESK);
        assert.ok(at > css.indexOf('@media (min-width:721px) { .kb-list {'), 'the block comes before the 721px list rule');
        assert.ok(at < css.indexOf('@media (max-width:720px) {\n    .kb-board'), 'the block comes after the phone block');
        assert.doesNotMatch(desk(), /#kb-board/, 'an id selector would beat the By band hide rule');
        assert.equal(css.split(DESK).length, 2, 'there must be exactly one desktop block');
      });

      it('the board is one flex row that scrolls sideways; each list scrolls inside its column; nothing snaps', () => {
        const b = desk();
        assert.match(rule(b, '.kb-board'), /display:flex/);
        assert.match(rule(b, '.kb-board'), /overflow-x:auto/);
        assert.match(rule(b, '.kb-board'), /height:var\(--kbh,/);
        assert.match(rule(b, '.kcol'), /flex:0 0 300px/);
        assert.match(rule(b, '.kb-list'), /min-height:0/);
        assert.match(rule(b, '.kb-list'), /max-height:none/);
        assert.doesNotMatch(b, /scroll-snap/, 'scroll-snap undoes the edge scroll');
        assert.doesNotMatch(css.slice(0, css.indexOf(DESK)), /\.kb-board \{[^}]*display:flex/, 'the base rule must stay a grid');
      });

      it('the intro is hidden in the Columns view only, and the board has a region name', () => {
        assert.match(rule(desk(), '[data-view="columns"] .sec-head p'), /display:none/);
        assert.doesNotMatch(css.slice(0, css.indexOf(DESK)) + css.slice(css.indexOf(DESK) + desk().length), /sec-head p \{[^}]*display:none/, 'the intro is hidden outside the desktop block');
        assert.match(html, /<div class="kb-board" id="kb-board" role="region" aria-label="[^"]+">/);
      });

      it('the polish: 13px ink titles, an amber Waiting count, one control row, a narrow empty Scheduled, muted small text', () => {
        const b = desk();
        assert.match(rule(b, '.kb-title'), /font-size:13px/);
        assert.match(rule(b, '.kb-title'), /color:var\(--ink\)/);
        assert.match(rule(b, '[data-col="waiting"]'), /var\(--warn\)/);
        assert.ok(b.includes('.kcol[data-col="waiting"]:not([data-n="0"]) .kb-count'), 'the pill is amber on an empty Waiting column too');
        assert.match(rule(b, '.kb-mv'), /font-size:0/);
        assert.match(rule(b, '.kb-ctl'), /flex-wrap:nowrap/);
        assert.match(rule(b, '[data-col="scheduled"][data-n="0"]'), /flex-basis:\d+px/);
        assert.match(rule(b, '.kb-sub'), /color:var\(--muted\)/);
        assert.match(rule(b, 'data-n="0"] .kb-list::after'), /color:var\(--muted\)/);
        // The phone and By band keep their ink: the change is scoped to this block.
        assert.match(rule(css.slice(0, css.indexOf(DESK)), '.kb-sub'), /color:var\(--faint\)/);
      });

      it('the page script fits the board only on a fine pointer wider than 720px, and gives the properties back otherwise', () => {
        const fit = html.slice(html.indexOf('function fitBoard'), html.indexOf('window.lbSetView = setView'));
        assert.ok(fit.length > 60, 'the main page script has no fitBoard function beside setView');
        assert.ok(fit.includes("(min-width:721px) and (pointer:fine)"), 'the fit is not gated by the desktop query');
        assert.ok(fit.includes("'--kbh'"), 'the fit does not set --kbh');
        assert.ok(fit.includes('removeProperty'), 'the fit leaves its properties set after a resize to a phone');
        assert.ok(fit.includes('matchMedia'), 'the fit has no matchMedia guard');
        assert.match(desk(), /html\s*\{\s*scroll-padding-top:var\(--sp,\d+px\)/, 'no desktop scroll-padding-top');
      });
    });

    it('a field and the Move to select are 16px on a touch screen or a phone, so iOS does not zoom on focus', () => {
      const b = block(COARSE);
      for (const sel of ['.kb-st', '.kb-bd', '.kb-note', '.kb-q', '.kb-to']) assert.match(rule(b, sel), /font-size:16px/, `${sel} is not 16px in the touch block`);
      assert.doesNotMatch(css, /maximum-scale|user-scalable/, 'zoom must stay possible');
    });

    it('on the phone the Priorities intro, the By band note and three of the counters are hidden', () => {
      const b = block(PHONE);
      assert.match(rule(b, '.bb-note'), /display:none/);
      assert.match(rule(b, '#priorities .sec-head p'), /display:none/);
      // The counters are hidden by position. Read the order from the markup and the hidden positions from the CSS together.
      const labels = [...html.matchAll(/<span class="ctr[^"]*"[^>]*><b>[^<]*<\/b><span>([^<]*)<\/span>/g)].map((m) => m[1]);
      const sel = /(\.counters \.ctr:nth-child\([^{]*)\{\s*display:none/.exec(b)?.[1];
      assert.ok(sel, 'the counter rule is missing');
      const hidden = (n) => sel.split(',').some((part) => {
        const arg = /nth-child\(([^)]*)\)/.exec(part)[1].trim();
        const plus = /^n\+(\d+)$/.exec(arg);
        return plus ? n >= Number(plus[1]) : n === Number(arg);
      });
      const shown = labels.filter((_, i) => !hidden(i + 1));
      assert.deepEqual(shown, ['open lanes', 'held now', 'blocked'], `the phone shows ${JSON.stringify(shown)} of ${JSON.stringify(labels)}`);
    });

    it('in By band the idle and ok status line is hidden on the phone; a warning or a failure still shows', () => {
      const b = block(PHONE);
      const r = /(\[data-view="band"\] \.kb-status[^{]*)\{\s*display:none/.exec(b)?.[1];
      assert.ok(r, 'the status rule is missing');
      assert.match(r, /data-k="idle"/);
      assert.match(r, /data-k="ok"/);
      assert.doesNotMatch(r, /data-k="(warn|crit)"/, 'a warning or a failure would be hidden');
    });

    it('the touch block sets phone type sizes: titles 14px, meta 12px, buttons 13px', () => {
      const b = block(COARSE);
      assert.match(rule(b, '.kb-title'), /font-size:14px/);
      for (const sel of ['.kb-track', '.kb-prio', '.kb-lease', '.kb-dl dd']) assert.match(rule(b, sel), /font-size:12px/, sel);
      // The By band rules come later in the file than the touch block, so their sizes sit in the phone block after them.
      const ph = block(PHONE);
      assert.ok(css.indexOf(ph) > css.indexOf('.bb-t { flex:1 1 100%'), 'the By band type sizes must come after the By band rules');
      assert.match(rule(ph, '.bb-t'), /font-size:14px/);
      for (const sel of ['.bb-track', '.bb-rank']) assert.match(rule(ph, sel), /font-size:12px/, sel);
      assert.match(rule(b, '.kb-btn'), /font-size:13px/);
    });

    it('the colours that carry text pass 4.5:1 in every token set (light --faint stays below 4.5:1, so card text must not use it: next test)', () => {
      const sets = {
        light: [/:root \{\s*\/\*/, true], dark: [/@media \(prefers-color-scheme: dark\) \{\s*:root \{/, false],
        'data-theme=dark': [/:root\[data-theme="dark"\] \{/, false], 'data-theme=light': [/:root\[data-theme="light"\] \{/, true],
      };
      for (const [name, [open, isLight]] of Object.entries(sets)) {
        const t = tokens(open);
        assert.ok(t['--ok-bg'] && t['--warn-bg'] && t['--panel-2'], `${name}: tokens not read`);
        assert.ok(contrast(t['--ok'], t['--ok-bg']) >= 4.5, `${name}: --ok on --ok-bg is ${contrast(t['--ok'], t['--ok-bg']).toFixed(2)}`);
        assert.ok(contrast(t['--warn'], t['--warn-bg']) >= 4.5, `${name}: --warn on --warn-bg is ${contrast(t['--warn'], t['--warn-bg']).toFixed(2)}`);
        if (!isLight) assert.ok(contrast(t['--faint'], t['--panel-2']) >= 4.5, `${name}: --faint on --panel-2 is ${contrast(t['--faint'], t['--panel-2']).toFixed(2)}`);
      }
    });

    it('the card meta and the field labels use --muted, not --faint, and --muted passes 4.5:1 on the card and column backgrounds in every token set', () => {
      // Light --faint is 3.09:1 on --panel and 2.73:1 on --panel-2. Option 1 of the critic: the editable page uses --muted, as KB_RO_CSS does.
      // The rule whose selector list holds exactly sel, outside any @media block (a rule with `color:` in it).
      const colourOf = (sel) => {
        const m = [...css.matchAll(/(?:^|\n)  ([^{}\n@][^{}]*)\{([^}]*)\}/g)].filter((x) => x[1].split(',').map((p) => p.trim()).includes(sel) && /(?:^|[;\s])color:/.test(x[2]));
        assert.ok(m.length, `no colour rule for ${sel}`);
        return /(?:^|[;\s])color:([^;]*)/.exec(m.at(-1)[2])[1].trim();
      };
      for (const sel of ['.kb-track', '.kb-prio', '.kb-lease', '.kb-fl', '.kb-dl dt', '.kb-why']) assert.equal(colourOf(sel), 'var(--muted)', `${sel} uses ${colourOf(sel)}`);
      const sets = [/:root \{\s*\/\*/, /@media \(prefers-color-scheme: dark\) \{\s*:root \{/, /:root\[data-theme="dark"\] \{/, /:root\[data-theme="light"\] \{/];
      for (const open of sets) {
        const t = tokens(open);
        for (const bg of ['--panel', '--panel-2']) assert.ok(contrast(t['--muted'], t[bg]) >= 4.5, `${open}: --muted on ${bg} is ${contrast(t['--muted'], t[bg]).toFixed(2)}`);
      }
    });

    it('the Move to word is hidden in the touch block but the select keeps its aria-label; the Done Details summary has no top padding', () => {
      const b = block(COARSE);
      assert.match(rule(b, '.kb-mv'), /font-size:0/);
      assert.match(rule(b, '.kb-ro-detail > summary'), /padding:4px 0[;\s}]/);
      assert.match(html, /<select class="kb-to" aria-label="[^"]+"/);
    });

    it('one --top-h sets the pinned row height and the scroll padding, so a focused field is not hidden under the header', () => {
      assert.match(css, /:root \{ --top-h:\d+px; \}/);
      const b = block(PHONE);
      assert.match(rule(b, '.top-row'), /min-height:var\(--top-h\)/);
      // --bar-h is the pinned crit status bar; the client sets it when a row tap scrolls (0px when the bar is not pinned).
      assert.match(b, /html \{[^}]*scroll-padding-top:calc\(var\(--top-h\) \+ var\(--bar-h,0px\) \+ \d+px\)/);
    });

    it('a failed save pins the status bar under the header on the phone, for failures only (a save in progress is a warning too)', () => {
      const b = block(PHONE);
      const m = /(\.kb-bar:has\([^{]*)\{([^}]*)\}/.exec(b);
      assert.ok(m, 'the sticky status rule is missing');
      assert.match(m[1], /data-k="crit"/);
      assert.doesNotMatch(m[1], /data-k="warn"/, 'Saving... is a warning: the bar would flash on every save');
      assert.match(m[2], /position:sticky/);
      assert.match(m[2], /top:var\(--top-h\)/);
    });

    it('every touch target is 44px, the theme button too, and taps do not wait for a double-tap zoom; the grip keeps touch-action:none', () => {
      const b = block(COARSE);
      assert.match(rule(b, '.themebtn'), /min-height:44px/);
      assert.match(rule(b, '.vt'), /min-height:44px/);
      assert.match(b, /button, select, \.vt, \.chip \{ touch-action:manipulation; \}/);
      assert.match(css, /\.kb-grip \{[^}]*touch-action:none/);
    });

    it('the drag grip is hidden on a touch screen but stays in the markup', () => {
      assert.match(css, /@media \(pointer:coarse\) \{\s*\.kb-grip \{ display:none; \}/);
      assert.match(html, /class="kb-grip"/);
    });

    it('an Activity row cannot widen the page: its text column can shrink and breaks long tokens', () => {
      assert.match(css, /\.feed div \{[^}]*grid-template-columns:52px 78px minmax\(0,1fr\);[^}]*overflow-wrap:anywhere/);
    });

    // PR-M2: a row tap in By band, a state word in Lanes, a capped Later column, Waiting above Later. The measured behaviour is the Edge run
    // saved in .claude/cache/e2e/2026-11-07-pr-m2.{mjs,log,json}; these pin the markup and CSS that produce it.
    const laterCap = () => Number(/var LATER_CAP = (\d+);/.exec(html)?.[1]);
    const colMarkup = (page, name) => new RegExp(`<div class="kcol" data-col="${name}"[\\s\\S]*?\\n  </div>`).exec(page)?.[0] ?? '';
    const pageBody = (page) => page.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script[\s\S]*?<\/script>/g, '');

    it('the editable page has one Show more button, in the Later column only; the read-only page has none', () => {
      const body = pageBody(html);
      assert.equal((body.match(/class="lt-more"/g) || []).length, 1, 'the Later footer button is missing or repeated');
      assert.ok(colMarkup(body, 'later').includes('<p class="dn-foot lt-foot"><button class="lt-more" type="button"></button></p>'), 'the button is not in the Later column');
      for (const other of ['next', 'waiting', 'scheduled']) assert.ok(!colMarkup(body, other).includes('lt-more'), `${other} has a Show more button`);
      const roOut = path.join(E2E.tmp, 'layout-ro.html');
      assert.equal(renderPage(['--project', 'zz-rb-a', '--out', roOut]).code, 0);
      assert.ok(!pageBody(fs.readFileSync(roOut, 'utf8')).includes('lt-more'), 'the read-only page has a Show more button');
    });

    it('Later shows LATER_CAP cards on the phone: the hide rule counts from cap+1, the footer shows only while the column is open and capped', () => {
      const cap = laterCap();
      assert.ok(cap >= 5, 'the page script has no LATER_CAP');
      const b = block(PHONE);
      assert.match(rule(b, '.kb-capped .kb-list'), /display:none/);
      assert.ok(b.includes(`.kcol.kb-capped .kb-list > :nth-child(n+${cap + 1})`), `the hide rule does not start at card ${cap + 1}`);
      const foot = /(\.kcol\.kb-capped[^{]*\.lt-foot)\s*\{([^}]*)\}/.exec(b);
      assert.ok(foot, 'the footer rule is missing');
      assert.match(foot[1], /:not\(\.kb-collapsed\)/, 'a collapsed column would show the footer');
      assert.match(foot[2], /display:block/);
      // The footer is hidden in the base CSS, so a wide screen never shows it.
      const base = css.slice(0, css.indexOf('@media (max-width:720px) {\n    header.top'));
      assert.match(rule(base, '.lt-foot'), /display:none/);
      assert.ok(!css.slice(css.indexOf(PHONE) + PHONE.length).includes('.lt-foot { display:none'), 'the cap must not be undone later in the file');
    });

    it('the Show more button is styled and sized like Show all', () => {
      assert.match(css, /\.dn-all, \.lt-more \{ padding:4px 0;/);
      assert.match(rule(block(COARSE), '.lt-more'), /min-height:44px/);
    });

    it('on the phone the visual order is Scheduled, Next, Waiting, Later, In progress, Done; the markup order does not change', () => {
      const b = block(PHONE).replace(/\/\*[\s\S]*?\*\//g, '');
      const order = {};
      for (const m of b.matchAll(/([^{}]*)\{\s*order:(-?\d+)\s*;?\s*\}/g)) {
        for (const sel of m[1].split(',')) {
          const name = /^\s*\.kcol\[data-col="([a-z]+)"\]\s*$/.exec(sel)?.[1];
          assert.ok(name, `an order rule has a selector that is not .kcol[data-col]: ${sel.trim()}`);
          order[name] = Number(m[2]);
        }
      }
      const markup = [...html.matchAll(/<div class="kcol"(?: data-col="([a-z]+)")/g)].map((m) => m[1]);
      assert.deepEqual(markup, ['scheduled', 'next', 'later', 'waiting', 'progress', 'done'], 'the markup order changed');
      const visual = markup.map((n, i) => ({ n, i, o: order[n] ?? 0 })).sort((x, y) => x.o - y.o || x.i - y.i).map((x) => x.n);
      assert.deepEqual(visual, ['scheduled', 'next', 'waiting', 'later', 'progress', 'done']);
    });

    it('a By band row looks tappable on the phone, in the phone block, after the By band rules', () => {
      const b = block(PHONE);
      assert.match(rule(b, '.bb-row'), /cursor:pointer/);
      assert.match(rule(b, '.bb-row'), /touch-action:manipulation/);
      assert.ok(css.indexOf(b) > css.indexOf('.bb-row { display:flex'), 'the phone rule comes before the base row rule and loses');
    });

    it('the Lanes list shows the state word on the phone and still hides the owner; the word goes under the title', () => {
      const line = css.split('\n').find((l) => l.includes('@media (max-width:720px) { .lane {'));
      assert.ok(line, 'the phone Lanes rule is missing');
      const hidden = /([^{}]*)\{\s*display:none;\s*\}/.exec(line.slice(line.indexOf('}') + 1))?.[1] ?? '';
      assert.match(hidden, /\.lane \.own/, 'the owner is no longer hidden');
      assert.doesNotMatch(hidden, /state-c/, 'the state word is still hidden');
      const b = block(PHONE);
      assert.match(rule(b, '.lane .state-c'), /grid-area:2\/2/);
      assert.match(rule(b, '.stripe'), /grid-row:1\/3/);
    });

    it('the main script exposes the view switch to the client, and the client calls it', () => {
      assert.match(html, /window\.lbSetView = setView;/);
      const client = fs.readFileSync(path.join(HERE, 'kanban-client.js'), 'utf8');
      assert.match(client, /window\.lbSetView\('columns', false\)/);
      assert.match(client, /setProperty\('--bar-h'/, 'the client never sets the bar height the scroll padding reads');
    });
  });

  it('the machine-wide sections say so on every page', () => {
    for (const board of ['continuous-claude', 'zz-rb-a']) {
      const out = path.join(E2E.tmp, `wide-${board}.html`);
      assert.equal(renderPage(['--project', board, '--out', out]).code, 0);
      const html = fs.readFileSync(out, 'utf8');
      assert.match(html, /machine-wide/i);
      assert.match(html, /coordination_event/);
    }
  });

  it('a second render over an existing page replaces it whole', () => {
    const out = path.join(E2E.tmp, 'again.html');
    fs.writeFileSync(out, 'STALE PAGE');
    assert.equal(renderPage(['--project', 'zz-rb-a', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(!html.includes('STALE PAGE') && html.includes('zz-rb-a-lane'));
  });

  // ---------------------------------------------------------------- band view (priority phase 5)
  describe('band on the page', () => {
    let html = '';
    let ro = '';
    before(() => {
      const out = path.join(E2E.tmp, 'band.html');
      assert.equal(renderPage(['--project', 'continuous-claude', '--out', out]).code, 0);
      html = fs.readFileSync(out, 'utf8');
      const roOut = path.join(E2E.tmp, 'band-ro.html');
      assert.equal(renderPage(['--project', 'zz-rb-a', '--out', roOut]).code, 0);
      ro = fs.readFileSync(roOut, 'utf8');
    });

    /** The By band block of a page: from its opening tag to the end marker. */
    const bb = (page) => /<div class="bb" id="bb">[\s\S]*?<!-- \/bb -->/.exec(page)?.[0] ?? '';
    const group = (page, key) => new RegExp(`<div class="bb-grp[^"]*" data-band="${key}">[\\s\\S]*?(?=<div class="bb-grp|<!-- /bb -->)`).exec(bb(page))?.[0] ?? '';
    const rowIds = (page, key) => [...group(page, key).matchAll(/<li class="bb-row"[^>]*><span class="bb-id mono">([^<]+)</g)].map((m) => m[1]);
    const rowOf = (page, id) => bb(page).split('<li class="bb-row"').find((r) => r.includes(`<span class="bb-id mono">${id}<`)) ?? '';

    it('By band is the default view, with four groups in the order P0, P1, P2, Unsorted', () => {
      assert.match(html, /<section id="priorities"[^>]*data-view="band"/);
      assert.deepEqual([...bb(html).matchAll(/<div class="bb-grp[^"]*" data-band="(\w+)">/g)].map((m) => m[1]), ['P0', 'P1', 'P2', 'none']);
      assert.match(html, /<button class="vt" type="button" data-g="view" data-v="band" aria-pressed="true">By band<\/button>/);
      assert.match(html, /<button class="vt" type="button" data-g="view" data-v="columns" aria-pressed="false">Columns<\/button>/);
    });

    it('a group lists its open lanes in the shared order: due date first, then rank, then id', () => {
      assert.deepEqual(rowIds(html, 'P0'), ['zz-rb-p0-1', 'zz-rb-p0-2', 'zz-rb-p0-3', 'zz-rb-p0-4', 'zz-rb-p0-5', 'zz-rb-p0-6']);
      assert.deepEqual(rowIds(html, 'P1'), ['zz-rb-p1-due', 'zz-rb-p1-rank5', 'zz-rb-p1-rank20']);
      assert.deepEqual(rowIds(html, 'P2'), ['zz-rb-p2-plain', 'zz-rb-p2-xss']);
    });

    it('a NULL band is Unsorted, and the group counts match the rows', () => {
      // The five zz-rb-sch-* lanes (PR-F) have no band either. A scheduled lane stays in By band: only the kanban columns split it out.
      assert.deepEqual(rowIds(html, 'none').sort(), ['zz-rb-ccv3-held', 'zz-rb-ccv3-lane', 'zz-rb-ccv3-qend', 'zz-rb-ccv3-qhold',
        'zz-rb-sch-acked', 'zz-rb-sch-future', 'zz-rb-sch-held', 'zz-rb-sch-past', 'zz-rb-sch-rem']);
      for (const [key, n] of [['P0', 6], ['P1', 3], ['P2', 2], ['none', 9]]) {
        assert.equal((group(html, key).match(/<li class="bb-row"/g) || []).length, n, key);
      }
    });

    it('P0 shows 6/5 with the over class and the words "over the cap of 5"; a group under the cap shows neither', () => {
      const p0 = group(html, 'P0');
      assert.match(p0, /<div class="bb-grp bb-over" data-band="P0">/);
      assert.ok(p0.includes('6/5') && p0.includes('over the cap of 5'));
      assert.ok(!group(html, 'P1').includes('bb-over') && !group(html, 'P1').includes('over the cap'));
      assert.ok(!group(html, 'P1').includes('/5'), 'only P0 has a cap');
      assert.ok(group(ro, 'P0').includes('1/5') && !group(ro, 'P0').includes('bb-over'));
    });

    it('a done lane is in no By band row, even with band P0', () => {
      assert.ok(bb(html).includes('zz-rb-p0-1'), 'By band has rows to test against');
      assert.ok(!bb(html).includes('zz-rb-done-p0'));
      assert.ok(html.includes('zz-rb-done-p0'), 'the done lane stays in the Lanes list');
      assert.ok(!bb(ro).includes('zz-rb-a-done'));
    });

    it('an empty group says so in words', () => {
      assert.match(group(ro, 'P2'), /Nothing in P2\./);
      assert.match(group(ro, 'P1'), /Nothing in P1\./);
    });

    it('By band lists the lanes of its own board only', () => {
      assert.ok(!bb(ro).includes('zz-rb-ccv3') && !bb(ro).includes('zz-rb-p0-1'), 'CCv3 leaked into board a By band');
      assert.deepEqual(rowIds(ro, 'P0'), ['zz-rb-a-p1']);
      assert.ok(!bb(html).includes('zz-rb-a-'), 'board a leaked into the CCv3 By band');
    });

    it('titles are escaped in every By band row, card and lane row', () => {
      assert.ok(!html.includes('<b>bold</b>'), 'a raw <b> from a title reached the page');
      assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot; &amp; done'));
      assert.ok(bb(html).includes('&lt;b&gt;bold&lt;/b&gt;'));
    });

    it('a By band row never takes a class the lane list, the filter or the card editor looks up', () => {
      const rows = bb(html);
      assert.ok(rows.includes('class="bb-row"'));
      for (const cls of ['kb-card', 'class="lane', 'class="detail', 'class="chip', 'kb-head', 'kb-more', 'data-col=']) {
        assert.ok(!rows.includes(cls), `By band uses ${cls}`);
      }
    });

    it('a By band row shows the state, the track and "rank N", and no chip: its group heading names the band', () => {
      const row = rowOf(html, 'zz-rb-p1-rank5');
      assert.ok(row, 'row not found');
      assert.match(row, /data-state="ready"/);
      assert.match(row, /rank 5</);
      assert.match(row, />zz</);
      assert.ok(!row.includes('bchip'), 'a chip repeats the group heading in every row');
      assert.ok(!row.includes('title='), 'a title attribute repeats text the row already shows');
    });

    it('both card branches carry the band chip and "rank N", and none says "prio N"', () => {
      const card = (page, id) => new RegExp(`<li class="card kb-card[^"]*" data-id="${id}"[\\s\\S]*?</li>`).exec(page)?.[0] ?? '';
      const edit = card(html, 'zz-rb-p0-1');
      const read = card(ro, 'zz-rb-a-p1');
      for (const [name, c] of [['editable', edit], ['read-only', read]]) {
        assert.ok(c, `${name} card not found`);
        assert.match(c, /<span class="kb-band" data-band="P0"/, name);
        assert.match(c, /<span class="kb-prio mono" title="Rank inside the band \(lane\.priority\)">rank \d+<\/span>/, name);
      }
      assert.ok(!/>prio \d/.test(html) && !/>prio \d/.test(ro), 'prio N is still on the page');
      assert.match(edit, /title="Rank in this column"/, 'the position circle keeps its own title');
    });

    it('every lane row has data-band, data-ord and data-seq; the order index counts done lanes', () => {
      const rows = [...html.matchAll(/<button class="lane[^"]*"[^>]*>/g)].map((m) => m[0]);
      assert.ok(rows.length > 12);
      for (const r of rows) assert.match(r, /data-band="(P0|P1|P2|none)" data-ord="\d+" data-seq="\d+"/);
      const ordOf = (id) => {
        const body = new RegExp(`<button class="lane[^"]*"[^>]*>\\s*<span class="stripe[^"]*"></span>\\s*<span class="nm"><span class="bchip"[^>]*>[^<]*</span>${id}<`).exec(html);
        assert.ok(body, `lane row of ${id} not found`);
        return Number(/data-ord="(\d+)"/.exec(body[0])[1]);
      };
      const seqs = rows.map((r) => Number(/data-seq="(\d+)"/.exec(r)[1]));
      assert.deepEqual(seqs, seqs.map((_, i) => i), 'data-seq is the DOM order 0..n-1');
      assert.ok(ordOf('zz-rb-p0-1') < ordOf('zz-rb-p1-due'), 'a P0 lane sorts before a P1 lane');
      assert.ok(ordOf('zz-rb-done-p0') < ordOf('zz-rb-p1-due'), 'a done lane keeps its band slot in the order index');
    });

    it('kb-data carries the band of each lane (null for none), and the placeLanes input keys stay', () => {
      const data = JSON.parse(/<script type="application\/json" id="kb-data">([\s\S]*?)<\/script>/.exec(html)[1].replace(/\\u003c/g, '<'));
      const by = Object.fromEntries(data.map((l) => [l.id, l.band]));
      assert.equal(by['zz-rb-p0-1'], 'P0');
      assert.equal(by['zz-rb-p2-plain'], 'P2');
      assert.equal(by['zz-rb-ccv3-lane'], null);
      for (const l of data) for (const k of ['id', 'state', 'priority']) assert.ok(k in l);
    });

    it('the filter has two chip groups: state chips and band chips with open counts; the view buttons are not chips', () => {
      const chips = [...html.matchAll(/<button class="chip" data-g="(\w+)" data-f="(\w+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2], m[3]]);
      assert.deepEqual(chips.filter((c) => c[0] === 'state').map((c) => c[1]), ['open', 'ready', 'held', 'blocked', 'all']);
      assert.deepEqual(chips.filter((c) => c[0] === 'band'), [['band', 'P0', 'P0 6 open'], ['band', 'P1', 'P1 3 open'], ['band', 'P2', 'P2 2 open'], ['band', 'none', 'Unsorted 9 open']]);
      assert.ok(!/class="chip"[^>]*data-g="(view|group)"/.test(html) && !/class="vt"[^>]*data-g="(state|band)"/.test(html));
      assert.match(html, /data-g="group" data-v="track" aria-pressed="true">Track</);
      assert.match(html, /data-g="group" data-v="band" aria-pressed="false">Band</);
    });

    it('the read-only page has the By band view and the view toggle, and still no kanban script or marker', () => {
      assert.match(ro, /<section id="priorities" class="kb-ro"[^>]*data-view="band"/);
      assert.ok(bb(ro).includes('class="bb-row"'));
      assert.ok(ro.includes('data-g="view" data-v="columns"'));
      for (const marker of ['function placeLanes', 'id="kb-data"', 'class="kb-grip"', 'class="kb-head"', 'class="kb-btn kb-save"', 'claude.use']) {
        assert.ok(!ro.includes(marker), `the read-only page gained ${marker}`);
      }
    });

    it('the page prints the queries behind By band and the P0 count', () => {
      assert.match(bb(html), /FROM agentic_os\.lane/);
      assert.match(bb(html), /state &lt;&gt; 'done'/);
      assert.match(bb(html), /CASE l\.band WHEN 'P0' THEN 0/);
      assert.match(bb(html), /SELECT count\(\*\) FROM agentic_os\.lane WHERE project_key = 'continuous-claude' AND state &lt;&gt; 'done' AND band = 'P0'/);
    });

    it('the page script is ES5 and guards localStorage', () => {
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      const inline = blocks.find((b) => b.includes("'lb-view'"));
      assert.ok(inline, 'the inline script with the view code is missing');
      for (const b of blocks) {
        const code = b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may name `db` in backticks
        assert.doesNotMatch(code, /=>|\bconst\s|\blet\s|`|\.\.\.[\w(\[]/, 'ES6 syntax in a page script');
      }
      const kbCode = KB_SCRIPT_RE.exec(html)[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!kbCode.includes('localStorage'), 'localStorage in the kanban script');
      // Every read and write sits inside try { }.
      for (const m of inline.matchAll(/localStorage/g)) {
        const before = inline.slice(0, m.index);
        assert.ok(before.lastIndexOf('try {') > before.lastIndexOf('} catch'), 'localStorage used outside try/catch');
      }
      assert.ok(inline.includes("'lb-group'"));
    });

    it('the page script ships without the comments of kanban-client.js, and what is left still compiles', () => {
      const script = KB_SCRIPT_RE.exec(html)[0].replace(/^<script>\n|<\/script>$/g, '');
      assert.doesNotMatch(script, /^[ \t]*\/\//m, 'a whole-line comment is on the page');
      assert.ok(!script.includes('/*'), 'a block comment is on the page');
      assert.doesNotThrow(() => new vm.Script(script), 'the stripped script does not compile');
    });

    it('the page ships exactly the client that kanban-strip.mjs returns, and the stripper is one of the generator files', () => {
      assert.ok(TEMPLATE_FILES.includes('kanban-strip.mjs'), 'a change to the stripper would not change the page stamp');
      const raw = fs.readFileSync(path.join(HERE, 'kanban-client.js'), 'utf8');
      assert.ok(KB_SCRIPT_RE.exec(html)[0].includes(stripClientComments(raw)), 'the page script is not the stripped client');
    });

    it('the Move to caption uses the muted ink, not the faint one (faint is below 4.5:1 on the card)', () => {
      assert.match(html, /\.kb-mv \{[^}]*color:var\(--muted\)/);
    });

    it('the template hash changes when a generator file changes, board-band-view.mjs included, and the page stamp is that hash', () => {
      assert.ok(TEMPLATE_FILES.includes('board-band-view.mjs'));
      assert.ok(TEMPLATE_FILES.includes('board-done-view.mjs'), 'an edit to the Done rules would not change the page stamp');
      assert.ok(TEMPLATE_FILES.includes('board-scheduled-view.mjs'), 'an edit to the Scheduled rules would not change the page stamp');
      assert.equal(parseBoardStamp(html).template, templateHash(HERE), 'the stamp is not the hash of the generator files');
      const copyOf = () => {
        const dir = fs.mkdtempSync(path.join(E2E.tmp, 'tpl-'));
        for (const f of TEMPLATE_FILES) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
        return dir;
      };
      assert.equal(templateHash(copyOf()), templateHash(HERE), 'a plain copy hashes the same');
      for (const f of TEMPLATE_FILES) {
        const edited = copyOf();
        fs.appendFileSync(path.join(edited, f), '\n// changed\n');
        assert.notEqual(templateHash(edited), templateHash(HERE), `editing ${f} does not change the hash`);
      }
    });

    it('the By band intro says a drag shows only after the next sync; the status line and order chip sit outside both views', () => {
      assert.match(html, /<section id="priorities"[^>]*>[\s\S]*?From the last render; a drag shows here after the next sync\.[\s\S]*?<div class="bb" id="bb">/);
      const at = (needle) => html.indexOf(needle);
      assert.ok(at('id="kb-status"') > 0 && at('id="kb-order"') > 0);
      assert.ok(at('id="kb-status"') < at('<div class="bb" id="bb">') && at('id="kb-order"') < at('<div class="bb" id="bb">'), 'the status line sits above both views');
      assert.ok(at('id="kb-status"') < at('id="kb-board"') && at('id="kb-order"') < at('id="kb-board"'));
    });

    // Size ratchet. The artifact limit is 16 MB. The live page was 997,523 bytes on 2026-11-06 (217 lanes) before the row shrink and 983,024 after it
    // against about 895,500 for main without the band view. The limits below sit just above the size after the band work,
    // so growth is a decision, not an accident. Raise one only with a reason in the commit. They are not the artifact limit.
    it('a By band row carries no bytes beyond its id, its title and a few short fields', () => {
      const rows = bb(html).split('<li class="bb-row"').slice(1).map((r) => r.slice(0, r.indexOf('</li>') + 5));
      assert.ok(rows.length >= 15);
      for (const r of rows) {
        const id = /class="bb-id mono">([^<]*)</.exec(r)[1];
        const title = /class="bb-t">([^<]*)</.exec(r)[1];
        const overhead = r.length + '<li class="bb-row"'.length - id.length - title.length;
        assert.ok(overhead <= ROW_OVERHEAD_MAX, `row of ${id} has ${overhead} bytes of markup (limit ${ROW_OVERHEAD_MAX}): ${r}`);
      }
    });

    it('the continuous-claude test page stays under its size ratchet', () => {
      const bytes = Buffer.byteLength(html);
      assert.ok(bytes <= PAGE_BYTES_MAX, `page is ${bytes} bytes, ratchet ${PAGE_BYTES_MAX}`);
    });
  });

  // ---------------------------------------------------------------- Done column (PR-D)
  describe('Done column', () => {
    let html = '';   // continuous-claude, editable
    let ro = '';     // zz-rb-a, read-only, one done lane with no event
    let roEmpty = ''; // zz-rb-bad, read-only, no done lane
    before(() => {
      for (const [name, board] of [['dn-edit', 'continuous-claude'], ['dn-ro', 'zz-rb-a'], ['dn-empty', 'zz-rb-bad']]) {
        const out = path.join(E2E.tmp, `${name}.html`);
        assert.equal(renderPage(['--project', board, '--out', out]).code, 0);
        if (board === 'continuous-claude') html = fs.readFileSync(out, 'utf8');
        else if (board === 'zz-rb-a') ro = fs.readFileSync(out, 'utf8');
        else roEmpty = fs.readFileSync(out, 'utf8');
      }
    });

    const section = (page) => /<section id="priorities"[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';
    /** The Done column: from its opening tag to the script block (editable page) or the end of the section (read-only page). */
    const doneCol = (page) => {
      const at = page.indexOf('<div class="kcol" data-col="done"');
      if (at < 0) return '';
      const rest = page.slice(at);
      return rest.slice(0, Math.min(...['<script type="application/json"', '</section>'].map((m) => (rest.indexOf(m) < 0 ? Infinity : rest.indexOf(m)))));
    };
    const doneList = (page) => /<ul class="kb-list" id="kb-list-done">([\s\S]*?)<\/ul>/.exec(page)?.[1] ?? '';
    /** The Done list as a sequence: { day } for a day header, { id, card } for a card. */
    const doneSeq = (page) => [...doneList(page).matchAll(/<li class="kb-day">([^<]*)<\/li>|<li class="card kb-done-card"[\s\S]*?<\/li>/g)]
      .map((m) => (m[1] !== undefined ? { day: m[1] } : { card: m[0], id: /class="kb-id mono">([^<]*)</.exec(m[0])[1] }));
    const doneCards = (page) => doneSeq(page).filter((e) => e.card);
    const tokens = (markup) => new Set([...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));

    it('there are six columns, left to right Scheduled and reminders, Next, Later, Waiting on Dave, In progress, Done, on the editable and the read-only page', () => {
      for (const page of [html, ro]) {
        assert.deepEqual([...section(page).matchAll(/data-col="(\w+)"/g)].map((m) => m[1]), ['scheduled', 'next', 'later', 'waiting', 'progress', 'done']);
        assert.deepEqual([...section(page).matchAll(/<span class="kb-name">([^<]*)</g)].map((m) => m[1]), ['Scheduled and reminders', 'Next', 'Later', 'Waiting on Dave', 'In progress', 'Done']);
      }
      assert.match(section(html), /<div class="kcol" data-col="done" data-fixed="1" data-n="\d+">/);
    });

    it('the Done head keeps the .kb-head button, a count of shown/total, and no "Held by a session" line (syncHeads calls querySelector(".kb-head") on every column)', () => {
      const col = doneCol(html);
      assert.match(col, /<h3 class="kb-h"><button class="kb-head" type="button" aria-expanded="true" aria-controls="kb-list-done"><span class="kb-name">Done<\/span><span class="kb-count mono">\d+\/\d+<\/span><\/button><\/h3>/);
      assert.ok(!col.includes('kb-sub'), 'Done has no sub line');
      // The read-only page has no script and no button: a plain heading.
      assert.match(doneCol(ro), /<h3 class="kb-h kb-ro-h"><span class="kb-name">Done<\/span><span class="kb-count mono">\d+\/\d+<\/span><\/h3>/);
      assert.ok(!doneCol(ro).includes('kb-head'));
    });

    it('the Done count reads shown/total, data-n is the shown count, and the footer says the same in words with a Show all button outside the list', () => {
      // continuous-claude: done-p0 (no event, updated_at), dn-today, dn-twice, dn-yday, dn-kanban are in the 7 days; dn-old is not. Six done lanes in all.
      assert.match(section(html), /data-col="done" data-fixed="1" data-n="5"/);
      assert.match(doneCol(html), /<span class="kb-count mono">5\/6<\/span>/);
      assert.match(doneCol(html), /<\/ul>\s*<p class="dn-foot">Showing 5 of 5 from the last 7 days\. 6 done in total\. <button class="dn-all" type="button">Show all<\/button><\/p>/);
      assert.ok(!doneList(html).includes('dn-foot'), 'the footer is inside the scroll area');
      // The read-only page has the same footer: one done lane (zz-rb-a-done) and it is in the 7 days.
      assert.match(doneCol(ro), /<span class="kb-count mono">1\/1<\/span>/);
      assert.match(doneCol(ro), /<p class="dn-foot">Showing 1 of 1 from the last 7 days\. 1 done in total\. <button class="dn-all" type="button">Show all<\/button><\/p>/);
    });

    it('an empty Done column says "Nothing done in the last 7 days." on the read-only page, and has no footer when no lane is done', () => {
      assert.match(section(roEmpty), /id="kb-list-done"><li class="kb-empty">Nothing done in the last 7 days\.<\/li>/);
      assert.match(section(roEmpty), /data-col="done" data-fixed="1" data-n="0"/);
      assert.ok(!roEmpty.includes('class="dn-foot"'), 'a footer with nothing to show');
      assert.ok(!html.includes('class="kb-empty"'), 'the editable page draws its empty text in CSS');
    });

    it('a done card carries none of the class tokens the client handles; kb-done-card is not the token kb-done', () => {
      const FORBIDDEN = ['kb-card', 'kb-ctl', 'kb-st', 'kb-bd', 'kb-save', 'kb-grip', 'kb-more', 'kb-next', 'kb-done', 'kb-undo', 'kb-plain'];
      for (const page of [html, ro]) {
        const cards = doneCards(page);
        assert.ok(cards.length >= 1, 'the test page has done cards');
        for (const { id, card } of cards) {
          const t = tokens(card);
          for (const f of FORBIDDEN) assert.ok(!t.has(f), `${id}: the done card has the class token ${f}`);
          assert.ok(t.has('kb-done-card'));
          for (const attr of ['data-id=', 'data-hash=']) assert.ok(!card.includes(attr), `${id}: a done card must not carry ${attr}`);
          assert.ok(!card.includes('<button') && !card.includes('<select') && !card.includes('<textarea'), `${id}: a done card has a control`);
        }
      }
      // The client's own selector for Done is `.kb-done`. A class selector matches a token, never a prefix.
      assert.ok(/t\.closest\('\.kb-done'\)/.test(fs.readFileSync(path.join(HERE, 'kanban-client.js'), 'utf8')), 'the client no longer uses .kb-done (update this pin)');
    });

    it('a done card shows the id, the title, the track, a clock chip, and a native <details> with scope and last note', () => {
      const card = doneCards(html).find((c) => c.id === 'zz-rb-dn-yday').card;
      assert.match(card, /<span class="kb-id mono">zz-rb-dn-yday<\/span>/);
      assert.match(card, /<p class="kb-title">done yesterday<\/p>/);
      assert.match(card, /<span class="kb-track mono">zz<\/span>/);
      assert.match(card, /<span class="dn-time mono">12:00 PM<\/span>/);
      assert.match(card, /<details class="kb-ro-detail"><summary>Details<span class="sr"> for zz-rb-dn-yday<\/span><\/summary>/);
      assert.match(card, /<dt>scope<\/dt><dd>none set<\/dd>/);
      assert.match(card, /<dt>last note<\/dt><dd>none<\/dd>/);
    });

    it('a done title, scope and note are escaped, and a note is cut at DONE_NOTE_MAX characters', () => {
      const card = doneCards(html).find((c) => c.id === 'zz-rb-dn-today').card;
      assert.ok(!card.includes('<b>done</b>') && !card.includes('<i>scope</i>'), 'raw markup from a lane reached the page');
      assert.ok(card.includes('&lt;b&gt;done&lt;/b&gt; &quot;quoted&quot; &amp; today'));
      assert.ok(card.includes('dn &lt;i&gt;scope&lt;/i&gt;'));
      const note = /<dt>last note<\/dt><dd>([^<]*)<\/dd>/.exec(card)[1];
      assert.ok(!note.includes('TAILMARK'), 'the end of a long note is on the page');
      assert.equal(note, `${'N'.repeat(DONE_NOTE_MAX - 1)}…`);
    });

    it('lanes stand under the day they were done, newest first: the kanban-only lane counts, an old lane and the sync\'s other events do not', () => {
      assert.deepEqual(doneSeq(html).map((e) => e.day ?? e.id), [
        'Today', 'zz-rb-dn-twice', 'zz-rb-dn-today', 'zz-rb-done-p0', 'Yesterday', 'zz-rb-dn-kanban', 'zz-rb-dn-yday',
      ]);
      // A lane with two events that count is placed by the newest (max): its 9 day old 'done' event does not hide it or pull it down.
      assert.ok(!doneList(html).includes('zz-rb-dn-old'), 'a lane done 9 days ago is in the list (or a kanban note/ready event counted as done)');
      // The old lane still counts in the total and stays in the Lanes list.
      assert.ok(html.includes('zz-rb-dn-old'));
      // The kanban-only lane shows its sync time (15:00), not updated_at.
      assert.match(doneCards(html).find((c) => c.id === 'zz-rb-dn-kanban').card, /<span class="dn-time mono">3:00 PM<\/span>/);
    });

    it('an open lane is never in Done, and a done lane is never in By band', () => {
      const ids = doneCards(html).map((c) => c.id);
      for (const open of ['zz-rb-ccv3-lane', 'zz-rb-ccv3-held', 'zz-rb-p0-1']) assert.ok(!ids.includes(open), `${open} is in Done`);
      const bb = /<div class="bb" id="bb">[\s\S]*?<!-- \/bb -->/.exec(html)[0];
      for (const id of ids) assert.ok(!bb.includes(id), `${id} is in By band`);
      // Board a: only its own done lane, none of CCv3.
      assert.deepEqual(doneCards(ro).map((c) => c.id), ['zz-rb-a-done']);
    });

    it('Show all is handled by the main page script (the read-only page has no kanban client), and the client has no part in it', () => {
      for (const page of [html, ro]) {
        const main = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((b) => b.includes("'lb-view'"));
        assert.ok(main, 'the main script is missing');
        assert.ok(main.includes("'.dn-all'"), 'the main script has no Show all handler');
        assert.ok(main.includes(`.chip[data-g="state"][data-f="all"]`) && main.includes("getElementById('lane-groups')") && main.includes('scrollIntoView'));
      }
      assert.ok(!fs.readFileSync(path.join(HERE, 'kanban-client.js'), 'utf8').includes('dn-all'), 'the Show all handler is in the client');
    });

    it('Show all first clears a pressed band chip, then presses the state "all" chip (a band filter would hide done lanes of other bands)', () => {
      for (const page of [html, ro]) {
        const main = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((b) => b.includes("'lb-view'"));
        const body = /var dnAll = [\s\S]*?\n    }\n/.exec(main)?.[0] ?? '';
        const band = body.indexOf('.chip[data-g="band"][aria-pressed="true"]');
        const state = body.indexOf('.chip[data-g="state"][data-f="all"]');
        assert.ok(band >= 0, 'Show all does not look for a pressed band chip');
        assert.ok(state > band, 'Show all presses the state chip before it clears the band chip');
        assert.match(body.slice(band, state), /\.click\(\)/, 'the pressed band chip is found but not clicked');
      }
    });

    it('only the Done and Scheduled cards use <details>: the open cards, By band and the rest of the page have none', () => {
      const rest = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(doneList(html), '')
        .replace(/<ul class="kb-list" id="kb-list-scheduled">[\s\S]*?<\/ul>/, ''); // the Scheduled cards use <details> too (PR-F)
      assert.ok(doneList(html).includes('<details class="kb-ro-detail">'), 'the Done list lost its <details>');
      assert.ok(!rest.includes('<details') && !rest.includes('kb-ro-detail'), 'a card outside Done uses <details>: the editor panel is the .kb-detail button pair');
    });

    it('the Done CSS: shared card rule, day headers, footer, a collapsed phone column hides the footer, and the Details rules are in the base CSS once', () => {
      const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
      assert.match(css, /\.kb-card, \.kb-done-card \{ min-width:0; padding:10px 11px; border-left:3px solid var\(--line\); \}/);
      for (const sel of ['.kb-day', '.dn-foot', '.dn-all', '.dn-time']) assert.ok(css.includes(`${sel} {`) || css.includes(`${sel},`), `${sel} has no rule`);
      assert.match(css, /\.kcol\.kb-collapsed \.dn-foot[^{]*\{ display:none; \}/);
      assert.match(css, /\.kb-ro-detail > summary \{/);
      const roCss = /<style>([\s\S]*?)<\/style>/.exec(ro)[1];
      // Two summary rules in the base CSS: the plain one and the 44px touch one. The read-only extra CSS must not add a third.
      assert.equal(css.split('.kb-ro-detail > summary {').length - 1, 2);
      assert.equal(roCss.split('.kb-ro-detail > summary {').length - 1, 2, 'the Details rules are defined again for the read-only page');
    });

    it('the header comment says six columns, and both intros mention Done', () => {
      const src = fs.readFileSync(RENDER, 'utf8');
      const header = /\/\*\*[\s\S]*?\*\//.exec(src)[0].replace(/\n\s*\*\s?/g, ' '); // a phrase may wrap over two comment lines
      assert.match(header, /six\s+columns/);
      assert.doesNotMatch(header, /five\s+columns/);
      const intro = (page) => /<div class="sec-head">\s*<h2 id="kb-title">Priorities<\/h2>\s*<p>([^<]*)<\/p>/.exec(page)[1];
      assert.match(intro(html), /Done/);
      assert.match(intro(ro), /Done/);
      assert.ok(intro(html).includes('Drag, or use Do next and Move to, to reorder.') && intro(html).includes('Your order saves to this board'));
    });

    // Size ratchet for one Done card: bytes beyond its id, title, track, clock, scope and note text. The summary repeats the id (its accessible name).
    it('a done card carries no bytes beyond its text and a fixed frame', () => {
      const cards = doneCards(html);
      assert.ok(cards.length >= 5);
      for (const { id, card } of cards) {
        const text = [/class="kb-id mono">([^<]*)</, /class="kb-title">([^<]*)</, /class="kb-track mono">([^<]*)</, /class="dn-time mono">([^<]*)</,
          /<dt>scope<\/dt><dd>([^<]*)</, /<dt>last note<\/dt><dd>([^<]*)</].map((re) => re.exec(card)[1]);
        const overhead = card.length - text.reduce((n, t) => n + t.length, 0);
        assert.ok(overhead <= DONE_OVERHEAD_MAX, `done card of ${id} has ${overhead} bytes of markup (limit ${DONE_OVERHEAD_MAX}): ${card}`);
      }
    });
  });


  // ---------------------------------------------------------------- Scheduled and reminders column (PR-F)
  describe('Scheduled and reminders column', () => {
    let html = '';   // continuous-claude, editable
    let ro = '';     // zz-rb-a, read-only, one lane due in 5 h 30 min
    let roEmpty = ''; // zz-rb-bad, read-only, no due time anywhere
    before(() => {
      for (const [name, board] of [['sc-edit', 'continuous-claude'], ['sc-ro', 'zz-rb-a'], ['sc-empty', 'zz-rb-bad']]) {
        const out = path.join(E2E.tmp, `${name}.html`);
        assert.equal(renderPage(['--project', board, '--out', out]).code, 0);
        const page = fs.readFileSync(out, 'utf8');
        if (board === 'continuous-claude') html = page; else if (board === 'zz-rb-a') ro = page; else roEmpty = page;
      }
    });

    const section = (page) => /<section id="priorities"[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';
    /** One column: from its opening tag to the next column or the end of the page. */
    const col = (page, key) => {
      const at = page.indexOf(`<div class="kcol" data-col="${key}"`);
      if (at < 0) return '';
      const rest = page.slice(at);
      const next = rest.indexOf('<div class="kcol"', 10);
      return next < 0 ? rest : rest.slice(0, next);
    };
    const list = (page, key) => new RegExp(`<ul class="kb-list" id="kb-list-${key}">([\\s\\S]*?)</ul>`).exec(page)?.[1] ?? '';
    const cardsOf = (page) => [...list(page, 'scheduled').matchAll(/<li class="card kb-done-card"[\s\S]*?<\/li>/g)].map((m) => m[0]);
    const idOf = (card) => /class="kb-id mono">([^<]*)</.exec(card)[1];
    const cardIds = (markup) => [...markup.matchAll(/class="kb-id mono">([^<]*)</g)].map((m) => m[1]);
    const count = (page, id) => cardIds(section(page)).filter((x) => x === id).length;
    const kbData = (page) => JSON.parse(/<script type="application\/json" id="kb-data">([\s\S]*?)<\/script>/.exec(page)[1]);

    it('holds the future lanes and the due reminder, the reminder first, and no past-due lane, acked reminder or held lane', () => {
      assert.deepEqual(cardsOf(html).map(idOf), ['zz-rb-sch-rem', 'zz-rb-sch-future', 'zz-rb-p1-due']);
      assert.match(col(html, 'scheduled'), /data-fixed="1" data-n="3"/);
      assert.match(col(html, 'scheduled'), /<span class="kb-count mono">3<\/span>/);
    });

    it('a scheduled lane is on the page once: not in Next, Later, Waiting or In progress, and not in kb-data', () => {
      const dataIds = kbData(html).map((l) => l.id);
      for (const id of ['zz-rb-sch-rem', 'zz-rb-sch-future', 'zz-rb-p1-due']) {
        assert.equal(count(html, id), 1, `${id} is on the board ${count(html, id)} times`);
        assert.ok(!dataIds.includes(id), `${id} is in kb-data`);
        for (const key of ['next', 'later', 'waiting', 'progress']) assert.ok(!cardIds(list(html, key)).includes(id), `${id} is in ${key}`);
      }
      // The lanes that stay out of the column are placed once, and are in kb-data.
      assert.ok(cardIds(list(html, 'next')).includes('zz-rb-sch-past'), 'a past-due normal lane is a normal lane');
      assert.ok(cardIds(list(html, 'next')).includes('zz-rb-sch-acked'), 'an acked reminder is a normal lane');
      assert.deepEqual(cardIds(list(html, 'progress')).filter((id) => id.startsWith('zz-rb-sch')), ['zz-rb-sch-held']);
      for (const id of ['zz-rb-sch-past', 'zz-rb-sch-acked', 'zz-rb-sch-held']) {
        assert.equal(count(html, id), 1, `${id} is on the board ${count(html, id)} times`);
        assert.ok(dataIds.includes(id), `${id} is missing from kb-data`);
      }
      assert.equal(new Set(dataIds).size, dataIds.length, 'kb-data lists a lane twice');
    });

    it('every open lane of kb-data is placed exactly once, and each kb-data row keeps the facts of its own lane (no index shift)', () => {
      const rows = new Map(kbData(html).map((l) => [l.id, l]));
      for (const l of rows.values()) if (l.state !== 'done') assert.equal(count(html, l.id), 1, `${l.id} is on the board ${count(html, l.id)} times`);
      assert.equal(rows.get('zz-rb-ccv3-lane').title, 'ccv3 lane title');
      assert.equal(rows.get('zz-rb-sch-past').title, 'past due normal lane');
      assert.equal(rows.get('zz-rb-sch-acked').title, 'acked reminder');
      assert.equal(rows.get('zz-rb-sch-acked').track, 'reminders');
      assert.equal(rows.get('zz-rb-sch-held').state, 'active');
    });

    it('the editable page lists the scheduled lanes (id, state, band only) in kb-sched, so "lanes ahead" counts them; the read-only page has no such block', () => {
      const m = /<script type="application\/json" id="kb-sched">([\s\S]*?)<\/script>/.exec(html);
      assert.ok(m, 'kb-sched is missing');
      const rows = JSON.parse(m[1].replace(/\\u003c/g, '<'));
      assert.deepEqual(rows.map((r) => r.id), ['zz-rb-sch-rem', 'zz-rb-sch-future', 'zz-rb-p1-due']);
      assert.deepEqual(Object.keys(rows[0]).sort(), ['band', 'id', 'state']);
      assert.equal(rows.find((r) => r.id === 'zz-rb-p1-due').band, 'P1');
      assert.ok(!kbData(html).some((l) => rows.some((r) => r.id === l.id)), 'a scheduled lane is also in kb-data');
      assert.ok(!ro.includes('id="kb-sched"'), 'the read-only page has a kb-sched block');
    });

    it('a scheduled card is a kb-done-card with id, title, track, a time chip and Details, and takes no class the client handles', () => {
      const cards = cardsOf(html);
      assert.equal(cards.length, 3);
      const handled = ['kb-card', 'kb-ctl', 'kb-st', 'kb-save', 'kb-grip', 'kb-more', 'kb-next', 'kb-done', 'kb-undo', 'kb-plain', 'kb-note', 'kb-to', 'kb-bd'];
      for (const c of cards) {
        const tokens = new Set([...c.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
        for (const h of handled) assert.ok(!tokens.has(h), `a scheduled card takes the class ${h}: ${c}`);
        assert.ok(!c.includes('data-id='), 'a scheduled card has a data-id the client could pick up');
        assert.match(c, /<details class="kb-ro-detail"><summary>Details<span class="sr"> for zz-rb-[^<]*<\/span><\/summary>/);
      }
      assert.ok(!list(html, 'scheduled').includes('class="card kb-card'), 'a kb-card is in the Scheduled list');
    });

    it('the chip says DUE for the due reminder, "in 3h" for the lane 3 h 30 min ahead and "in 20d" for the one 20 days ahead', () => {
      const chips = Object.fromEntries(cardsOf(html).map((c) => [idOf(c), /class="sc-chip mono[^"]*">([^<]*)</.exec(c)[1]]));
      assert.deepEqual(chips, { 'zz-rb-sch-rem': 'DUE', 'zz-rb-sch-future': 'in 3h', 'zz-rb-p1-due': 'in 20d' });
      assert.match(list(html, 'scheduled'), /class="sc-chip mono sc-due">DUE</, 'DUE has its own class so it can stand out');
    });

    it('escapes the title, scope and note of a scheduled lane', () => {
      const card = cardsOf(html).find((c) => idOf(c) === 'zz-rb-sch-future');
      assert.ok(card.includes('&lt;b&gt;sched&lt;/b&gt; &quot;quoted&quot; &amp; later'), card);
      assert.ok(card.includes('sch &lt;i&gt;scope&lt;/i&gt;') && card.includes('sch last note'));
      assert.ok(!card.includes('<b>sched') && !card.includes('<i>scope'));
    });

    it('the editable head keeps the .kb-head button; the read-only head is a plain heading', () => {
      assert.match(col(html, 'scheduled'), /<h3 class="kb-h"><button class="kb-head" type="button" aria-expanded="true" aria-controls="kb-list-scheduled"><span class="kb-name">Scheduled and reminders<\/span>/);
      assert.match(col(ro, 'scheduled'), /<h3 class="kb-h kb-ro-h"><span class="kb-name">Scheduled and reminders<\/span><span class="kb-count mono">1<\/span><\/h3>/);
      assert.ok(!col(ro, 'scheduled').includes('kb-head'));
    });

    it('the read-only page puts its due lane in Scheduled and nowhere else', () => {
      assert.deepEqual(cardsOf(ro).map(idOf), ['zz-rb-a-sched']);
      assert.equal(count(ro, 'zz-rb-a-sched'), 1);
      assert.match(list(ro, 'scheduled'), /class="sc-chip mono">in 5h</);
    });

    it('an empty column says "Nothing scheduled": a line on the read-only page, a CSS line on the editable page', () => {
      assert.match(col(roEmpty, 'scheduled'), /id="kb-list-scheduled"><li class="kb-empty">Nothing scheduled<\/li><\/ul>/);
      assert.match(col(roEmpty, 'scheduled'), /data-n="0"/);
      const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
      assert.ok(css.includes(`.kcol[data-col="scheduled"][data-n="0"] .kb-list::after { content:'Nothing scheduled'; }`), 'the editable page has no empty text for Scheduled');
    });

    it('the Now column is gone from both pages and from the client', () => {
      for (const page of [html, ro]) {
        assert.ok(!/data-col="now"/.test(page) && !/kb-list-now/.test(page), 'a Now column is on the page');
        assert.ok(!/<span class="kb-name">Now</.test(page));
      }
      const script = KB_SCRIPT_RE.exec(html)[0];
      assert.ok(!/\bnow:/.test(script), 'the client or placeLanes still names a now column');
      assert.ok(!script.includes("'now'"), "the client names 'now'");
    });

    it('both intros mention Scheduled', () => {
      const intro = (page) => /<div class="sec-head">\s*<h2 id="kb-title">Priorities<\/h2>\s*<p>([^<]*)<\/p>/.exec(page)[1];
      assert.match(intro(html), /Scheduled/);
      assert.match(intro(ro), /Scheduled/);
    });

    it('a scheduled card carries no bytes beyond its text and a fixed frame', () => {
      for (const card of cardsOf(html)) {
        const text = [/class="kb-id mono">([^<]*)</, /class="kb-title">([^<]*)</, /class="kb-track mono">([^<]*)</, /class="sc-chip mono[^"]*">([^<]*)</,
          /<dt>scope<\/dt><dd>([^<]*)</, /<dt>last note<\/dt><dd>([^<]*)</, /<dt>due<\/dt><dd>([^<]*)</].map((re) => re.exec(card)[1]);
        const overhead = card.length - text.reduce((n, t) => n + t.length, 0);
        assert.ok(overhead <= SCHED_OVERHEAD_MAX, `scheduled card has ${overhead} bytes of markup (limit ${SCHED_OVERHEAD_MAX}): ${card}`);
      }
    });
  });

});
