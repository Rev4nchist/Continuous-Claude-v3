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
 *   - the page width cap is not one shared variable (header and board drift apart), or is not 1840px
 *   - the Priorities grid is not 1 column to 720px, 3 from 721px and 5 from 1360px
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
import { TEMPLATE_FILES, boardStamp, defaultOut, parseBoardStamp, parseRenderArgs, templateHash, writeAtomic } from './render-board-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const RENDER = path.join(HERE, 'render-board.mjs');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
// Size ratchets for the band page (see the ratchet note in the band tests). Measured 2026-11-06: test page 136,616 bytes, widest row 232 bytes of markup.
const ROW_OVERHEAD_MAX = 240;
const PAGE_BYTES_MAX = 140000;
// A title long enough to need more than three lines in a narrow card.
const LONG_TITLE = `long title start ${'word '.repeat(80)}long title END`;

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
        ('zz-rb-p1-due', 'p1 has a due date', 'yy', 'ready', 99, 'P1', '2026-11-20T00:00:00Z', 'continuous-claude'),
        ('zz-rb-p2-plain', 'p2 plain', 'zz', 'backlog', 60, 'P2', NULL, 'continuous-claude'),
        ('zz-rb-p2-xss', '<b>bold</b> "quoted" & done', 'zz', 'backlog', 61, 'P2', NULL, 'continuous-claude'),
        ('zz-rb-done-p0', 'done lane with a band', 'zz', 'done', 5, 'P0', NULL, 'continuous-claude')`);
      await c.query(`INSERT INTO agentic_os.lane_event (session_id, kind, lane_id, body, project_key) VALUES
        ('zz-rb-s-c', 'note', 'zz-rb-ccv3-lane', 'ccv3 event body', 'continuous-claude'),
        ('zz-rb-s-a', 'note', 'zz-rb-a-lane', 'board a event body', 'zz-rb-a')`);
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
    // All five columns exist, in order. Now is empty and says why in words. Waiting on Dave holds the blocked lane (placeLanes, no saved order).
    assert.deepEqual([...section.matchAll(/data-col="(\w+)"/g)].map((m) => m[1]), ['now', 'next', 'later', 'waiting', 'progress']);
    assert.match(section, /data-col="now" data-n="0"/);
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
    assert.deepEqual(ids('now'), []);
    assert.deepEqual(ids('waiting'), ['zz-rb-a-blocked']);
    assert.ok(!section.includes('zz-rb-a-done'), 'a done lane is in no column');
    // Counts agree with the cards.
    assert.match(section, /data-col="next" data-n="3"/);
    assert.match(section, /data-col="later" data-n="3"/);
    assert.match(section, /data-col="waiting" data-n="1"/);
    // An empty column says why in plain words: Now names the missing saved order. Waiting is not empty here, so it shows no empty text.
    const empty = (col) => new RegExp(`id="kb-list-${col}"><li class="kb-empty">([^<]*)</li>`).exec(section)?.[1];
    assert.match(empty('now'), /no saved order/);
    assert.equal(empty('waiting'), undefined);
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
      'id="kb-status"', 'class="kb-to"', 'class="kb-grip"', 'class="kb-btn kb-plain"', 'class="kb-btn kb-save"', 'class="kb-btn kb-up"',
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
      'Drag, or use Do next and Move to, to reorder.', 'class="kb-grip"', 'class="kb-to"', 'class="kb-btn kb-next"', 'class="kb-btn kb-done"', 'id="kb-order"', 'id="kb-data"',
      'function placeLanes', 'claude.use', 'kanban/board', 'class="kb-head"', 'class="kb-more"',
    ]) {
      assert.ok(html.includes(marker), `the CCv3 page lost ${marker}`);
    }
    for (const marker of ['class="kb-ro"', 'kb-ro-detail"', 'class="kb-h kb-ro-h"', 'Read-only snapshot', 'class="kb-empty"']) {
      assert.ok(!html.includes(marker), `the read-only marker ${marker} leaked into the CCv3 page`);
    }
  });

  it('the Columns cards carry Do next, Done and Move to with one placeholder option; By band, In progress and the old Up and Down carry none', () => {
    const out = path.join(E2E.tmp, 'ccv3-buttons.html');
    assert.equal(renderPage(['--project', 'continuous-claude', '--out', out]).code, 0);
    const html = fs.readFileSync(out, 'utf8');
    const columns = /<div class="kb-board" id="kb-board">([\s\S]*?)<script type="application\/json" id="kb-data">/.exec(html)[1];
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

  it('--interactive on a foreign board gives kb-data with only that board\'s lanes, every interactive marker, and keeps the board\'s name in the title and masthead', () => {
    const out = path.join(E2E.tmp, 'a-interactive.html');
    const r = renderPage(['--project', 'zz-rb-a', '--interactive', '--out', out]);
    assert.equal(r.code, 0, r.all);
    const html = fs.readFileSync(out, 'utf8');
    for (const marker of [
      'function placeLanes', 'claude.use', 'kanban/board', 'onSnapshot', 'id="kb-data"', 'id="kb-order"', 'id="kb-live"', 'id="kb-status"',
      'class="kb-to"', 'class="kb-grip"', 'class="kb-btn kb-plain"', 'class="kb-btn kb-save"', 'class="kb-btn kb-next"', 'class="kb-btn kb-done"', 'class="kb-edit"',
      'class="kb-more"', 'class="kb-head"', 'Your order saves to this board',
    ]) {
      assert.ok(html.includes(marker), `an interactive foreign page must carry ${marker}`);
    }
    for (const marker of ['class="kb-ro"', 'kb-ro-detail"', 'class="kb-h kb-ro-h"', 'Read-only snapshot', 'class="kb-empty"']) {
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

    it('one variable sets the width of both .wrap and .top-in, capped at 1840px', () => {
      assert.match(css, /:root \{ --page-w:min\(1840px,100%\); \}/);
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

    it('the board is 3 columns by default, 5 from 1360px and 1 up to 720px; the old 1080px board rule is gone', () => {
      assert.match(css, /\.kb-board \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
      assert.match(css, /@media \(min-width:1360px\) \{ \.kb-board \{ grid-template-columns:repeat\(5,minmax\(0,1fr\)\); \} \}/);
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

    it('an Activity row cannot widen the page: its text column can shrink and breaks long tokens', () => {
      assert.match(css, /\.feed div \{[^}]*grid-template-columns:52px 78px minmax\(0,1fr\);[^}]*overflow-wrap:anywhere/);
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
      assert.deepEqual(rowIds(html, 'none').sort(), ['zz-rb-ccv3-held', 'zz-rb-ccv3-lane', 'zz-rb-ccv3-qend', 'zz-rb-ccv3-qhold']);
      for (const [key, n] of [['P0', 6], ['P1', 3], ['P2', 2], ['none', 4]]) {
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
      assert.deepEqual(chips.filter((c) => c[0] === 'band'), [['band', 'P0', 'P0 6 open'], ['band', 'P1', 'P1 3 open'], ['band', 'P2', 'P2 2 open'], ['band', 'none', 'Unsorted 4 open']]);
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

});
