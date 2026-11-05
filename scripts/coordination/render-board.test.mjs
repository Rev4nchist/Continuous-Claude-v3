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
 *   - the foreign page carries the kanban script (its save drops ids the page does not know)
 *   - the page has no stamp, or the stamp names the wrong board
 *   - an unknown key, or a cwd with no board, writes a page instead of exiting 1
 *   - a half-written page is left at the target (the write must be temp + rename)
 *   - the machine-wide sections do not say so
 *   - the folded-project SQL drifts from lane.mjs (the peer rule must match)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertScratchUrl } from './scratch-db.mjs';
import { boardStamp, defaultOut, parseBoardStamp, parseRenderArgs, writeAtomic } from './render-board-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const RENDER = path.join(HERE, 'render-board.mjs');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');

// ------------------------------------------------------------------ pure parts

describe('parseRenderArgs', () => {
  it('has no project and no output by default', () => {
    assert.deepEqual(parseRenderArgs([]), { project: null, out: null });
  });

  it('reads --project <key> and --project=<key>; the key never becomes the output file', () => {
    assert.deepEqual(parseRenderArgs(['--project', 'zz-a']), { project: 'zz-a', out: null });
    assert.deepEqual(parseRenderArgs(['--project=zz-a']), { project: 'zz-a', out: null });
  });

  it('reads --out <file> and --out=<file>', () => {
    assert.deepEqual(parseRenderArgs(['--out', 'x.html']), { project: null, out: 'x.html' });
    assert.deepEqual(parseRenderArgs(['--out=x.html', '--project', 'k']), { project: 'k', out: 'x.html' });
  });

  it('keeps the positional [out.html] of the old command', () => {
    assert.deepEqual(parseRenderArgs(['board.html']), { project: null, out: 'board.html' });
    assert.deepEqual(parseRenderArgs(['--project', 'k', 'board.html']), { project: 'k', out: 'board.html' });
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
});

// ------------------------------------------------------------------ the page, end to end

function loadPg() {
  for (const anchor of [path.join(REPO, '.claude', 'hooks', 'package.json'), path.join(REPO, 'apps', 'agentic-os', 'package.json')]) {
    try { return createRequire(pathToFileURL(anchor)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve `pg`');
}

const E2E = { url: '', tmp: '', registry: '', rootA: '', rootC: '', noBoard: '' };
const fwd = (p) => p.replace(/\\/g, '/');

function renderPage(args, { cwd = E2E.rootC, env = {} } = {}) {
  assertScratchUrl(E2E.url);
  const r = spawnSync(process.execPath, [RENDER, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CONTINUOUS_CLAUDE_DB_URL: E2E.url,
      DATABASE_URL: E2E.url,
      OPC_POSTGRES_URL: E2E.url,
      LANE_REGISTRY_PATH: E2E.registry,
      LANE_PROJECT: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

describe('render-board.mjs against a scratch database', () => {
  before(async () => {
    const created = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '4'], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    E2E.url = JSON.parse(created.stdout).url;
    assertScratchUrl(E2E.url);
    E2E.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
    for (const n of ['rootA', 'rootC', 'noBoard']) {
      E2E[n] = path.join(E2E.tmp, n);
      fs.mkdirSync(E2E[n]);
    }
    E2E.registry = path.join(E2E.tmp, 'registry.json');
    fs.writeFileSync(E2E.registry, JSON.stringify({
      version: '1.0',
      projects: [
        { name: 'rb-c', key: 'continuous-claude', path: fwd(E2E.rootC), status: 'active' },
        { name: 'rb-a', key: 'zz-rb-a', path: fwd(E2E.rootA), status: 'active' },
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
      await c.query(`INSERT INTO agentic_os.lane (id, title, track, state, project_key, owner_session_id, lease_expires_at) VALUES
        ('zz-rb-ccv3-lane', 'ccv3 lane title', 'zz', 'ready', 'continuous-claude', NULL, NULL),
        ('zz-rb-ccv3-held', 'ccv3 held title', 'zz', 'active', 'continuous-claude', 'zz-rb-s-c', now() + interval '30 minutes'),
        ('zz-rb-a-lane', 'board a lane title', 'zz', 'ready', 'zz-rb-a', NULL, NULL),
        ('zz-rb-a-held', 'board a held title', 'zz', 'active', 'zz-rb-a', 'zz-rb-s-a', now() + interval '30 minutes')`);
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

  it('--project zz-rb-a writes a page with only board a, no kanban script, and the stamp of board a', () => {
    const out = path.join(E2E.tmp, 'a.html');
    const r = renderPage(['--project', 'zz-rb-a', '--out', out]);
    assert.equal(r.code, 0, r.all);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(html.includes('zz-rb-a-lane') && html.includes('zz-rb-a-held'));
    assert.ok(html.includes('board a event body'));
    assert.ok(!html.includes('zz-rb-ccv3') && !html.includes('ccv3 event body') && !html.includes('zz-rb-s-c'), 'CCv3 leaked into board a');
    assert.ok(!html.includes('zz-rb-s-away'), 'a session outside the board roots showed up');
    assert.ok(html.includes('zz-rb-s-a'.slice(0, 8)) || html.includes('zz-rb-s'), 'the live session of board a is listed');
    for (const marker of ['id="kb-data"', 'id="kb-board"', 'id="priorities"', 'function placeLanes']) {
      assert.ok(!html.includes(marker), `a non-CCv3 page must not carry the kanban (${marker})`);
    }
    assert.equal(parseBoardStamp(html).board, 'zz-rb-a');
    assert.match(html, /<title>[^<]*zz-rb-a[^<]*<\/title>/);
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
});
