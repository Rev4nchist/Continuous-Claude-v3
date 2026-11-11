// Tests for lib/db.mjs and lib/board.mjs with a fake client. No Postgres runs here: the SQL text is checked, never executed.
// The scratch-database probe covers the SQL itself (design section C.4).
// Failure modes:
//   D1 a database URL with a password reaches output (A2)
//   D2 the read-only client loses its read-only setting
//   D3 hasLaneDep reads a row wrongly (NULL regclass must be false)
//   D4 an opener skips SET SESSION ... READ ONLY (a URL options parameter could then turn read-only off), or loses READ ONLY in the BEGIN
//   B7 an event reader judges events of a same-id lane on another board (no project_key filter)
//   B1 board key or ids are put into the SQL text instead of bound (injection)
//   B2 a bigserial id stays a string (a string compare of event ids breaks the claim replay)
//   B3 the program seed mark is the newest or any 'seeded' event, or counts an array-form seed (A1)
//   B4 a reader uses its own copy of the lifecycle filter instead of sql.lifecycleWhere (A9)
//   B5 the pg client is loaded when a pure test imports the module
// Run: node --test scripts/review-engine/db-board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientOptions, hasLaneDep, maskDbUrl, openAutocommitRO, openReadOnly, READ_ONLY_SESSION, scrubUrls, SNAPSHOT_BEGIN } from './lib/db.mjs';
import { readBoard, readEdges, readForeign, readLaneEvents, readLaneStates, readProgramSeed, toBoardRow, toEdgeRow, toEventRow } from './lib/board.mjs';
import * as realDep from '../coordination/lane-dep.mjs';

// A client that records every query and answers from a queue.
function fake(...answers) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows: answers.length ? answers.shift() : [] };
    },
  };
}

const EVIL = "x'); DROP TABLE agentic_os.lane; --";
const BOARD = "continuous-claude'; --";

// ---- D: db.mjs

test('D1 maskDbUrl hides the user and the password; the form is postgresql://***@host/db', () => {
  assert.equal(maskDbUrl('postgresql://claude:s3cret@localhost:5432/lanes_pr1_ab12cd34'), 'postgresql://***@localhost:5432/lanes_pr1_ab12cd34');
  assert.equal(maskDbUrl('postgres://u:p%40ss@db.example.com/x?sslmode=require&password=zzz'), 'postgresql://***@db.example.com/x');
  assert.equal(maskDbUrl('postgresql://localhost/lanes_pr1_aa'), 'postgresql://***@localhost/lanes_pr1_aa');
  assert.equal(maskDbUrl('not a url with s3cret'), 'postgresql://***@<unreadable>');
  for (const u of ['postgresql://claude:s3cret@localhost:5432/d', 'postgres://u:pw@h/d?password=pw']) assert.equal(maskDbUrl(u).includes('pw'), false);
});

test('D1b scrubUrls masks every database URL inside a text', () => {
  const text = 'connect failed for postgresql://claude:s3cret@localhost:5432/db: ECONNREFUSED; also postgres://a:b@h2/d2';
  const out = scrubUrls(text);
  assert.equal(out.includes('s3cret'), false);
  assert.equal(out.includes('a:b'), false);
  assert.match(out, /postgresql:\/\/\*\*\*@localhost:5432\/db: ECONNREFUSED/);
  assert.equal(scrubUrls('no url here'), 'no url here');
});

test('D2 clientOptions: read-only session, bounded timeouts, the url as connectionString', () => {
  const o = clientOptions('postgresql://u:p@h/db');
  assert.equal(o.connectionString, 'postgresql://u:p@h/db');
  assert.match(o.options, /default_transaction_read_only=on/);
  assert.ok(o.connectionTimeoutMillis > 0 && o.connectionTimeoutMillis <= 10000);
  assert.ok(o.query_timeout > 0 && o.query_timeout <= 60000);
});

test('D3 hasLaneDep: true only when to_regclass finds the table', async () => {
  assert.equal(await hasLaneDep(fake([{ ok: true }])), true);
  assert.equal(await hasLaneDep(fake([{ ok: false }])), false);
  assert.equal(await hasLaneDep(fake([])), false);
  const c = fake([{ ok: true }]);
  await hasLaneDep(c);
  assert.match(c.calls[0].text, /to_regclass\('agentic_os\.lane_dep'\)/);
});

// A fake pg client and factory for the openers: every statement is recorded in order. failOn: a statement that throws.
function fakePg(failOn = null) {
  const calls = [];
  const client = {
    async connect() { calls.push('connect'); },
    async query(text) {
      calls.push(text);
      if (text === failOn) throw new Error('boom');
      return { rows: [] };
    },
    async end() { calls.push('end'); },
  };
  return { calls, make: async (url) => { calls.push(`new ${url}`); return client; } };
}

const SET_RO = 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY';
const BEGIN_RO = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const OPTIONS_URL = 'postgresql://u:p@h/lanes_pr1_aa?options=-c%20default_transaction_read_only%3Doff';

test('D4 openReadOnly runs SET SESSION ... READ ONLY after connect, then the pinned BEGIN (F2)', async () => {
  const pg = fakePg();
  await openReadOnly(OPTIONS_URL, pg.make);
  assert.deepEqual(pg.calls, [`new ${OPTIONS_URL}`, 'connect', SET_RO, BEGIN_RO]);
  assert.equal(SET_RO, READ_ONLY_SESSION);
  assert.equal(BEGIN_RO, SNAPSHOT_BEGIN);
});

test('D4b openAutocommitRO runs SET SESSION ... READ ONLY after connect and opens no transaction (F2)', async () => {
  const pg = fakePg();
  await openAutocommitRO(OPTIONS_URL, pg.make);
  assert.deepEqual(pg.calls, [`new ${OPTIONS_URL}`, 'connect', SET_RO]);
});

test('D4c a failed SET ends the client and throws: no reader is returned, no BEGIN runs', async () => {
  for (const open of [openReadOnly, openAutocommitRO]) {
    const pg = fakePg(SET_RO);
    await assert.rejects(open(OPTIONS_URL, pg.make), /boom/);
    assert.deepEqual(pg.calls.slice(-2), [SET_RO, 'end']);
    assert.equal(pg.calls.includes(BEGIN_RO), false);
  }
});

test('D4d a failed BEGIN ends the client; a failed connect names the masked URL only', async () => {
  const pg = fakePg(BEGIN_RO);
  await assert.rejects(openReadOnly(OPTIONS_URL, pg.make), /boom/);
  assert.equal(pg.calls.at(-1), 'end');
  const bad = { make: async () => ({ connect: async () => { throw new Error('refused postgresql://u:s3cret@h/db'); } }) };
  await assert.rejects(openReadOnly('postgresql://u:s3cret@h/db', bad.make), (e) => /cannot connect to postgresql:\/\/\*\*\*@h\/db/.test(e.message) && !e.message.includes('s3cret'));
});

// ---- B: board.mjs

const BOARD_ROW = {
  id: 're-a', project_key: 'continuous-claude', state: 'backlog', owner_session_id: null, lease_expires_at: null,
  updated_at: new Date('2026-11-10T00:00:00Z'), branch: 're/re-a', track: 'review-engine', note: null, priority: 12, band: null,
  owner_alive_at: null, reclaimable: true, open_dep: true, waits_on: ['re-b'], met: false, landed_sha: null, last_life: null,
};

test('B1 readBoard binds the board key and the ids; neither is in the SQL text', async () => {
  const c = fake([]);
  await readBoard(c, { board: BOARD, ids: [EVIL, 're-a'], sql: realDep });
  const { text, params } = c.calls[0];
  assert.equal(text.includes(EVIL), false);
  assert.equal(text.includes(BOARD), false);
  assert.deepEqual(params, [BOARD, [EVIL, 're-a']]);
  for (const n of [1, 2]) assert.ok(text.includes(`$${n}`), `$${n}`);
  assert.equal(/\$3/.test(text), false);
});

test('B1b readForeign, readEdges and readLaneEvents bind too, and numbers placeholders per query', async () => {
  const c = fake([], [], []);
  await readForeign(c, { board: BOARD, ids: [EVIL] });
  await readEdges(c, { board: BOARD, ids: [EVIL] });
  await readLaneEvents(c, { board: BOARD, ids: [EVIL], sql: realDep });
  for (const { text } of c.calls) {
    assert.equal(text.includes(EVIL), false);
    assert.equal(text.includes(BOARD), false);
  }
  assert.deepEqual(c.calls[0].params, [BOARD, [EVIL]]);
  assert.deepEqual(c.calls[1].params, [BOARD, [EVIL]]);
  assert.deepEqual(c.calls[2].params, [BOARD, [EVIL]]);
  assert.match(c.calls[2].text, /ANY\(\$2::text\[\]\)/);
  assert.equal(/\$3/.test(c.calls[2].text), false);
});

test('B4 readBoard and readLaneEvents take the lifecycle filter from sql.lifecycleWhere and the dep builders from sql', async () => {
  const marker = {
    lifecycleWhere: (a) => `LIFE_MARK(${a})`, landedShaSql: (a) => `LANDED_MARK(${a})`, laneMetSql: (a) => `MET_MARK(${a})`,
    openDepSql: (a) => `OPEN_MARK(${a})`, waitsOnSql: (a) => `WAITS_MARK(${a})`,
  };
  const c = fake([], []);
  await readBoard(c, { board: 'b', ids: [], sql: marker });
  await readLaneEvents(c, { board: 'b', ids: [], sql: marker });
  const board = c.calls[0].text;
  for (const m of ['LIFE_MARK(e)', 'LANDED_MARK(l)', 'MET_MARK(l)', 'OPEN_MARK(l)', 'WAITS_MARK(l)']) assert.ok(board.includes(m), m);
  assert.ok(c.calls[1].text.includes('LIFE_MARK(e)'));
  assert.equal(/kind = 'kanban'/.test(board + c.calls[1].text), false, 'no hand copy of the lifecycle filter');
});

test('B2 readBoard converts last_life.id and keeps the shape of BoardRow', async () => {
  const c = fake([{ ...BOARD_ROW, last_life: { id: '3001', kind: 'done', session_id: 's', detail: { merged: 'a'.repeat(40) } } }]);
  const [row] = await readBoard(c, { board: 'continuous-claude', ids: ['re-a'], sql: realDep });
  assert.equal(row.last_life.id, 3001);
  assert.equal(typeof row.last_life.id, 'number');
  assert.deepEqual(Object.keys(row).sort(), Object.keys(BOARD_ROW).sort());
  assert.deepEqual(row.waits_on, ['re-b']);
  assert.equal(toBoardRow({ ...BOARD_ROW, last_life: null }).last_life, null);
  assert.deepEqual(toBoardRow({ ...BOARD_ROW, waits_on: null }).waits_on, []);
});

test('B2b EventRow ids are numbers; EdgeRow keeps its four keys', async () => {
  const ev = toEventRow({ id: '3002', lane_id: 're-a', kind: 'claimed', session_id: 's', detail: { state: 'active' }, occurred_at: new Date(0) });
  assert.equal(ev.id, 3002);
  assert.equal(ev.detail.state, 'active');
  assert.deepEqual(Object.keys(ev).sort(), ['detail', 'id', 'kind', 'lane_id', 'occurred_at', 'session_id']);
  const edge = toEdgeRow({ lane_id: 'a', depends_on: 'b', project_key: 'p', dep_board: null });
  assert.deepEqual(edge, { lane_id: 'a', depends_on: 'b', project_key: 'p', dep_board: null });
  const c = fake([{ id: '10', lane_id: 'a', kind: 'done', session_id: null, detail: {}, occurred_at: new Date(0) }]);
  const [one] = await readLaneEvents(c, { board: 'p', ids: ['a'], sql: realDep });
  assert.equal(one.id, 10);
});

test('B3 readProgramSeed: the earliest seeded event with an edges key; a plain number or null', async () => {
  const c = fake([{ id: '3100' }]);
  assert.equal(await readProgramSeed(c, 'continuous-claude'), 3100);
  const { text, params } = c.calls[0];
  assert.deepEqual(params, ['continuous-claude']);
  assert.match(text, /kind = 'seeded'/);
  assert.match(text, /detail->'edges'\) IS NOT NULL/);
  assert.match(text, /ORDER BY id ASC\s+LIMIT 1/);
  assert.equal(/max\(/i.test(text), false, 'not the newest');
  assert.equal(await readProgramSeed(fake([]), 'p'), null);
  assert.equal(await readProgramSeed(fake([{ id: null }]), 'p'), null);
});

test('B7 readLaneEvents and the last_life subquery filter events by the board key, not by lane id alone (F4)', async () => {
  const c = fake([], []);
  await readLaneEvents(c, { board: 'b', ids: ['a'], sql: realDep });
  await readBoard(c, { board: 'b', ids: ['a'], sql: realDep });
  const [events, boardText] = c.calls.map((x) => x.text);
  assert.match(events, /WHERE e\.project_key = \$1 AND e\.lane_id = ANY\(\$2::text\[\]\)/);
  const lastLife = /SELECT row_to_json\(x\) FROM \(SELECT[\s\S]*?\) x\) AS last_life/.exec(boardText)?.[0] ?? '';
  assert.ok(lastLife.length > 0, 'last_life subquery found');
  assert.match(lastLife, /WHERE e\.project_key = \$1 AND e\.lane_id = l\.id/);
});

test('B5 importing db.mjs and board.mjs loads neither pg nor lane-sort', () => {
  for (const file of ['db.mjs', 'board.mjs', 'lane-cli.mjs', 'contract.mjs', 'liveness.mjs']) {
    const src = readFileSync(new URL(`./lib/${file}`, import.meta.url), 'utf8');
    const statics = src.split(/\r?\n/).filter((l) => /^import\b/.test(l));
    for (const l of statics) assert.equal(/coordination|resolve-deps|from 'pg'/.test(l), false, `${file}: ${l}`);
  }
});

test('B6 readLaneStates binds the board and the ids and returns a Map of state and owner (a NULL owner stays null)', async () => {
  const client = fake([{ id: 'a', state: 'blocked', owner_session_id: null }, { id: 'b', state: 'active', owner_session_id: 's1' }]);
  const states = await readLaneStates(client, { board: BOARD, ids: [EVIL, 'b'] });
  assert.deepEqual([...states], [['a', { state: 'blocked', owner: null }], ['b', { state: 'active', owner: 's1' }]]);
  assert.deepEqual(client.calls[0].params, [BOARD, [EVIL, 'b']]);
  assert.ok(!client.calls[0].text.includes(EVIL) && !client.calls[0].text.includes('continuous-claude'));
});
