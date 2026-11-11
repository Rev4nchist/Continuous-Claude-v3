/**
 * lane-inbox-id.test -- end to end tests for `lane.mjs inbox --id <N>` (contract C11, failure check 14 of
 * coord-banner-page-budget).
 *
 * `inbox --id N` prints one event in full and writes no cursor. It prints only a direct message to the calling
 * session, or a broadcast of the board of the current folder.
 *
 * Output format: line 1 is `event <id> from <label> kind <kind>[ lane <lane-id>]`. The body follows from line 2,
 * byte for byte, with no indent and no trim. Stdout is the body plus the one final newline that every verb adds.
 *
 * Ways the verb can fail (one test each):
 *   1. The body is cut, indented or trimmed (long body, multi-byte text, one line with no space, CRLF, edge spaces).
 *   2. A direct message to another session prints.
 *   3. A broadcast of another board prints.
 *   4. A broadcast of this board does not print.
 *   5. A cursor row changes (with and without --peek).
 *   6. A direct message needs a board, so it fails in an unregistered folder.
 *   7. A broadcast prints in a folder with no board.
 *   8. A missing id or a malformed id gives the wrong exit code.
 *   9. A refusal leaks the sender or the body of the event.
 *  10. A refusal prints more than one line (C11: one refusal line).
 *
 * Every test spawns the real `lane.mjs` against a SCRATCH database that this file creates and drops.
 *
 *   node --test scripts/coordination/lane-inbox-id.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from './scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const fwd = (p) => String(p).replace(/\\/g, '/');
const BOARD = 'ib-a';
const OTHER = 'ib-b';
const ME = randomUUID();
const PEER = randomUUID();
const s = { url: '', db: null, tmp: '', repo: '', bare: '', registry: '', idDir: '', dropped: [] };

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'LANE_PROJECT', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_SKIP_HOOK_PRECHECK']) delete env[k];
  return env;
}
function laneEnv() {
  assertScratchUrl(s.url);
  return Object.assign(cleanEnv(), {
    CONTINUOUS_CLAUDE_DB_URL: s.url, DATABASE_URL: s.url, OPC_POSTGRES_URL: s.url,
    LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: ME,
  });
}
/** Run the worktree lane.mjs against the scratch database. Output is raw bytes. `cwd` defaults to the registered folder. */
function lane(args, { cwd = s.repo } = {}) {
  const r = spawnSync(process.execPath, [LANE, ...args], { cwd, env: laneEnv(), windowsHide: true, maxBuffer: 1 << 24 });
  return { code: r.status, out: r.stdout, err: r.stderr.toString('utf8'), line1: r.stderr.toString('utf8').split('\n')[0] };
}

function createScratch(through) {
  const r = spawnSync(process.execPath, [SCRATCH, 'create', '--through', String(through)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `scratch create failed: ${r.stderr}`);
  const { url } = JSON.parse(r.stdout);
  assertScratchUrl(url);
  return url;
}

/** An event row. `to` null makes a broadcast of `board`. Returns the new id as a string. */
async function ev({ from = PEER, to = null, board = BOARD, kind = 'note', lane: laneId = null, body }) {
  const r = await s.db.query(
    `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6) RETURNING id::text AS id`,
    [laneId, kind, from, to, body, board],
  );
  return r.rows[0].id;
}
const watermarks = async () => (await s.db.query(`SELECT session_id, last_event_id::text AS last_event_id, updated_at::text AS updated_at FROM agentic_os.lane_watermark ORDER BY session_id`)).rows;

/** stdout minus the first line and the one final newline = the stored body. */
function bodyOf(out) {
  const nl = out.indexOf(0x0a);
  assert.ok(nl >= 0, 'stdout has a header line');
  assert.equal(out[out.length - 1], 0x0a, 'stdout ends with the newline that main adds');
  return out.subarray(nl + 1, out.length - 1);
}
const headerOf = (out) => out.subarray(0, out.indexOf(0x0a)).toString('utf8');

/** A refusal: exit 4, line 1 `REFUSED inbox <id> [<token>] -- ...`, nothing on stdout, and no secret from the event in the text. */
function assertRefused(r, id, token, ...secrets) {
  assert.equal(r.code, 4, `exit code: ${r.err}`);
  assert.match(r.line1, new RegExp(`^REFUSED inbox ${id} \\[${token}\\] -- `), r.err);
  // C11: one refusal line, and nothing after it.
  assert.equal(r.err.trimEnd().split('\n').length, 1, `one refusal line, got: ${r.err}`);
  assert.equal(r.out.length, 0, 'a refusal prints nothing on stdout');
  for (const x of secrets) assert.ok(!r.err.includes(x), `the refusal does not contain ${x}`);
}

before(async () => {
  s.url = createScratch(6);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-inbox-id-')));
  s.repo = path.join(s.tmp, 'repo');
  s.bare = path.join(s.tmp, 'unregistered');
  s.idDir = path.join(s.tmp, 'ids');
  for (const d of [s.repo, s.bare, s.idDir]) fs.mkdirSync(d);
  s.registry = path.join(s.tmp, 'registry.json');
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: [{ name: 'ib', key: BOARD, path: fwd(s.repo), status: 'active' }] }));
  s.db = new Client({ connectionString: s.url });
  await s.db.connect();
  await s.db.query(`SELECT set_config('lane.client_version','test',false)`);
});

after(async () => {
  await s.db?.end().catch(() => {});
  if (s.url) {
    const r = spawnSync(process.execPath, [SCRATCH, 'drop', s.url], { encoding: 'utf8' });
    s.dropped.push(`${new URL(s.url).pathname.slice(1)} status ${r.status}`);
  }
  if (s.tmp) fs.rmSync(s.tmp, { recursive: true, force: true });
  console.log(`scratch database dropped: ${s.dropped.join('; ')}`);
});

describe('inbox --id: the body', () => {
  it('prints a long direct message byte for byte (multi-byte text, a line with no space, CRLF, edge spaces)', async () => {
    const body = [
      '  leading spaces stay', 'tail spaces stay   ', `${'é漢字😀'.repeat(900)}`, 'x'.repeat(1500), 'crlf line\r', '', 'last line  ',
    ].join('\n');
    assert.ok(Buffer.byteLength(body, 'utf8') >= 9000, 'the body is at least 9,000 bytes');
    const id = await ev({ to: ME, body });
    const r = lane(['inbox', '--id', id]);
    assert.equal(r.code, 0, r.err);
    assert.equal(Buffer.compare(bodyOf(r.out), Buffer.from(body, 'utf8')), 0, 'the body equals the stored body');
  });

  it('prints one header line: id, sender label, kind and lane id', async () => {
    const id = await ev({ to: ME, kind: 'handoff', lane: 'some-lane', body: 'hello' });
    const r = lane(['inbox', '--id', id]);
    assert.equal(r.code, 0, r.err);
    const h = headerOf(r.out);
    assert.match(h, new RegExp(`^event ${id} from .*${PEER.slice(0, 8)}.* kind handoff lane some-lane$`));
    assert.equal(bodyOf(r.out).toString('utf8'), 'hello');
  });

  it('an event with no lane and no body prints a header with no lane and an empty body', async () => {
    const id = await ev({ to: ME, body: null });
    const r = lane(['inbox', '--id', id]);
    assert.equal(r.code, 0, r.err);
    assert.ok(!/ lane /.test(headerOf(r.out)));
    assert.equal(bodyOf(r.out).length, 0);
  });
});

describe('inbox --id: who may read', () => {
  it('refuses a direct message to another session (exit 4) and does not leak it', async () => {
    const id = await ev({ to: randomUUID(), body: 'SECRET-DM-BODY' });
    assertRefused(lane(['inbox', '--id', id]), id, 'not-yours', 'SECRET-DM-BODY', PEER);
  });

  it('refuses a broadcast of another board (exit 4)', async () => {
    const id = await ev({ board: OTHER, body: 'SECRET-OTHER-BOARD' });
    assertRefused(lane(['inbox', '--id', id]), id, 'not-yours', 'SECRET-OTHER-BOARD');
  });

  it('prints a broadcast of this board', async () => {
    const id = await ev({ body: 'board news' });
    const r = lane(['inbox', '--id', id]);
    assert.equal(r.code, 0, r.err);
    assert.equal(bodyOf(r.out).toString('utf8'), 'board news');
  });

  it('prints a direct message that came from another board', async () => {
    const id = await ev({ to: ME, board: OTHER, body: 'crossed boards' });
    const r = lane(['inbox', '--id', id]);
    assert.equal(r.code, 0, r.err);
    assert.equal(bodyOf(r.out).toString('utf8'), 'crossed boards');
  });
});

describe('inbox --id: no cursor moves', () => {
  it('leaves every lane_watermark row as it was, with and without --peek, while plain inbox does write', async () => {
    await s.db.query(`DELETE FROM agentic_os.lane_watermark`);
    await s.db.query(`INSERT INTO agentic_os.lane_watermark (session_id, last_event_id) VALUES ($1, 1), ($2, 1)`, [`${ME}@${BOARD}`, `${PEER}@${BOARD}`]);
    const dm = await ev({ to: ME, body: 'unread dm' });
    const bc = await ev({ body: 'unread broadcast' });
    const before = await watermarks();

    for (const extra of [[], ['--peek']]) {
      for (const id of [dm, bc]) {
        const r = lane(['inbox', '--id', id, ...extra]);
        assert.equal(r.code, 0, r.err);
        assert.deepEqual(await watermarks(), before, `no watermark change for --id ${id} ${extra.join(' ')}`);
      }
    }
    // Control: without --id the same events move the cursor, so the check above can fail.
    const plain = lane(['inbox']);
    assert.equal(plain.code, 0, plain.err);
    assert.notDeepEqual(await watermarks(), before, 'plain inbox writes a cursor');
  });
});

describe('inbox --id: a folder with no board', () => {
  it('control: plain inbox fails there with "no lane board for"', () => {
    const r = lane(['inbox', '--peek'], { cwd: s.bare });
    assert.equal(r.code, 1);
    assert.match(r.err, /no lane board for/);
  });

  it('prints a direct message to this session', async () => {
    const id = await ev({ to: ME, body: 'dm in a bare folder' });
    const r = lane(['inbox', '--id', id], { cwd: s.bare });
    assert.equal(r.code, 0, r.err);
    assert.equal(bodyOf(r.out).toString('utf8'), 'dm in a bare folder');
  });

  it('refuses a broadcast (exit 4): it needs the board of the folder', async () => {
    const id = await ev({ body: 'SECRET-BROADCAST' });
    assertRefused(lane(['inbox', '--id', id], { cwd: s.bare }), id, 'not-yours', 'SECRET-BROADCAST');
  });

  it('refuses a direct message of another session there too', async () => {
    const id = await ev({ to: randomUUID(), body: 'SECRET-DM-2' });
    assertRefused(lane(['inbox', '--id', id], { cwd: s.bare }), id, 'not-yours', 'SECRET-DM-2');
  });
});

describe('inbox --id: bad ids', () => {
  it('an id that does not exist is refused with exit 4', async () => {
    const top = (await s.db.query(`SELECT COALESCE(max(id),0)::bigint + 1000 AS n FROM agentic_os.lane_event`)).rows[0].n;
    assertRefused(lane(['inbox', '--id', String(top)]), top, 'no-such-event');
  });

  for (const bad of ['abc', '0', '-5', '1.5', '12x', '007', '99999999999999999999']) {
    it(`a malformed id "${bad}" is a usage error (exit 1)`, () => {
      const r = lane(['inbox', '--id', bad]);
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, /usage/);
      assert.equal(r.out.length, 0);
    });
  }

  it('a bare --id is a usage error (exit 1)', () => {
    const r = lane(['inbox', '--id']);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /usage/);
  });
});
