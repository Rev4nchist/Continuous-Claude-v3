#!/usr/bin/env node
// End-to-end proof of migration 0004 against a SCRATCH database only.
// Creates its own lanes_pr1_* database, never touches continuous_claude, drops it at the end.
//
//   node scripts/coordination/migration-0004-proof.mjs
//
// The transcript goes to .claude/cache/e2e/2026-11-04-migration-0004-scratch.txt (overwritten). Exit 1 if a check fails.
// The server comes from CONTINUOUS_CLAUDE_DB_URL / DATABASE_URL / OPC_POSTGRES_URL (as scratch-db.mjs reads it);
// only a NEW database named lanes_pr1_* is written.
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';

const WT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/');
const OUT = `${WT}/.claude/cache/e2e/2026-11-04-migration-0004-scratch.txt`;
const TOOL = `${WT}/scripts/coordination/scratch-db.mjs`;
mkdirSync(`${WT}/.claude/cache/e2e`, { recursive: true });
writeFileSync(OUT, '');
let pg;
try { pg = requireDep('pg', { repoRoot: WT }); } catch (e) { console.error(`migration-0004-proof: ${e.message}`); process.exit(2); }

const mask = (s) => String(s).replace(/(postgresql:\/\/[^:]+:)[^@]+@/g, '$1***@');
const log = (s = '') => { const t = mask(s); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const tool = (...args) => execFileSync('node', [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const live = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
let url, name, c;
try {
  log('# Migration 0004 scratch-database proof, 2026-11-04');
  log('# Live database: NOT touched. Only the scratch database below receives writes.');
  log('\n## Step 1: create scratch DB through migration 0003');
  const created = JSON.parse(tool('create', '--through', '3'));
  url = created.url; name = created.name;
  log(`scratch database: ${name}`);
  log(`scratch url: ${url}`);
  if (!name.startsWith('lanes_pr1_') || new URL(url).pathname.slice(1) === 'continuous_claude') throw new Error('guard: not a scratch db');
  if (live && new URL(live).pathname === new URL(url).pathname) throw new Error('scratch url equals live url');

  c = new pg.Client({ connectionString: url });
  await c.connect();
  const q = (sql, p) => c.query(sql, p);
  const tryq = async (sql, p) => { try { const r = await c.query(sql, p); return { r }; } catch (e) { return { e }; } };
  const rollbackIfAborted = async () => { await c.query('ROLLBACK').catch(() => {}); };

  const describe = async () => {
    const out = [];
    const cols = await q(`SELECT table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' default='||coalesce(column_default,'') AS d
      FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name IN ('lane','lane_event') ORDER BY 1`);
    out.push(...cols.rows.map((r) => 'col ' + r.d));
    const idx = await q(`SELECT indexdef AS d FROM pg_indexes WHERE schemaname='agentic_os' AND tablename IN ('lane','lane_event') ORDER BY 1`);
    out.push(...idx.rows.map((r) => 'idx ' + r.d));
    const con = await q(`SELECT conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE connamespace='agentic_os'::regnamespace AND conrelid::regclass::text IN ('agentic_os.lane','agentic_os.lane_event') ORDER BY 1`);
    out.push(...con.rows.map((r) => 'con ' + r.d));
    const trg = await q(`SELECT tgname||' on '||tgrelid::regclass AS d FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'agentic_os.%' ORDER BY 1`);
    out.push(...trg.rows.map((r) => 'trg ' + r.d));
    const fn = await q(`SELECT proname AS d FROM pg_proc WHERE pronamespace='agentic_os'::regnamespace ORDER BY 1`);
    out.push(...fn.rows.map((r) => 'fn ' + r.d));
    return out;
  };
  const schema3 = await describe();
  log('\n## 0003-shape schema description (lane, lane_event)');
  schema3.forEach((s) => log('  ' + s));

  log('\n## Step 2: seed');
  log(tool('seed', url).trim());
  const seedCount = Number((await q('SELECT count(*) AS n FROM agentic_os.lane')).rows[0].n);
  log(`lanes: ${seedCount}, events: ${(await q('SELECT count(*) AS n FROM agentic_os.lane_event')).rows[0].n}, watermarks: ${(await q('SELECT count(*) AS n FROM agentic_os.lane_watermark')).rows[0].n}, sessions: ${(await q('SELECT count(*) AS n FROM public.sessions')).rows[0].n}`);

  const explain = async (label, sql, opts = {}) => {
    log(`\n=== ${label}${opts.noseq ? '  [enable_seqscan=off, to show index shape]' : ''}\n${sql}`);
    await q('BEGIN');
    if (opts.noseq) await q('SET LOCAL enable_seqscan = off');
    const r = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    await q('ROLLBACK');
    log(r.rows.map((x) => x['QUERY PLAN']).join('\n'));
  };
  const before = [
    ['board: open lanes', `SELECT l.* FROM agentic_os.lane l WHERE (false OR l.state <> 'done') ORDER BY l.track, l.priority, l.id`],
    ['next: claimable by priority', `SELECT l.* FROM agentic_os.lane l WHERE l.state IN ('ready','backlog') ORDER BY l.priority, l.id LIMIT 5`],
    ['claim: lookup by id', `SELECT l.* FROM agentic_os.lane l WHERE l.id = 'seed-harness-1'`],
    ['unread: events past watermark', `SELECT e.* FROM agentic_os.lane_event e WHERE e.id > COALESCE((SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id='x'),0) AND e.session_id <> 'x' AND (e.to_session_id IS NULL OR e.to_session_id = 'x') ORDER BY e.id`],
    ['lanes by owner (renew/mine)', `SELECT l.* FROM agentic_os.lane l WHERE l.owner_session_id='zz-seed-sa' ORDER BY l.priority, l.id`],
  ];
  log('\n## Step 3: EXPLAIN baseline on the 0003 schema (same five shapes as preflight.mjs)');
  for (const [l, s] of before) await explain(l, s);

  log('\n## RED: check (a) query on the 0003 schema, before 0004');
  {
    const r = await tryq('SELECT project_key, count(*) FROM agentic_os.lane GROUP BY 1');
    log(`RED  ${r.e ? r.e.code + ': ' + r.e.message : 'unexpectedly succeeded'}`);
    check('(red) project_key query fails before 0004 with 42703', r.e?.code === '42703');
  }

  log('\n## Step 4: apply 0004');
  log(tool('migrate', url, '4').trim() || '(done, see stderr line above)');
  const schema4 = await describe();
  log('\n## 0004-shape schema description');
  schema4.forEach((s) => log('  ' + s));

  log('\n## Check (a): project_key backfill');
  const a = (await q('SELECT project_key, count(*)::int AS n FROM agentic_os.lane GROUP BY 1')).rows;
  log(JSON.stringify(a));
  check('(a) one row continuous-claude with the seeded lane count', a.length === 1 && a[0].project_key === 'continuous-claude' && a[0].n === seedCount, `${a[0]?.n} of ${seedCount}`);
  const ae = (await q('SELECT project_key, count(*)::int AS n FROM agentic_os.lane_event GROUP BY 1')).rows;
  check('(a2) lane_event rows all continuous-claude', ae.length === 1 && ae[0].project_key === 'continuous-claude', JSON.stringify(ae));

  log('\n## Check (b): foreign board fence');
  await q(`INSERT INTO agentic_os.lane (id, title, project_key) VALUES ('zz-b-1','foreign one','zz-b'), ('zz-b-2','foreign two','zz-b'), ('zz-b-3','foreign three','zz-b')`);
  let t = await tryq(`UPDATE agentic_os.lane SET note='x' WHERE id='zz-b-1'`);
  log(`UPDATE without setting -> ${t.e ? `${t.e.code}: ${t.e.message}` : 'no error'}`);
  check('(b1) UPDATE of foreign lane without setting fails 42501 with message', t.e?.code === '42501' && /^lane zz-b-1 belongs to board zz-b: this lane\.mjs predates per-project boards; rebase the worktree onto main$/.test(t.e.message));
  t = await tryq(`DELETE FROM agentic_os.lane WHERE id='zz-b-1'`);
  log(`DELETE without setting -> ${t.e ? `${t.e.code}: ${t.e.message}` : 'no error'}`);
  check('(b2) DELETE of foreign lane without setting fails 42501', t.e?.code === '42501');
  check('(b2b) foreign lane still present after refused DELETE', (await q(`SELECT 1 FROM agentic_os.lane WHERE id='zz-b-1'`)).rowCount === 1);
  await q(`SET lane.client_version = '2'`);
  t = await tryq(`UPDATE agentic_os.lane SET note='x' WHERE id='zz-b-1'`);
  check('(b3) UPDATE with session setting client_version=2 succeeds', !t.e && t.r.rowCount === 1, t.e?.message);
  t = await tryq(`DELETE FROM agentic_os.lane WHERE id='zz-b-3'`);
  check('(b4) DELETE with session setting succeeds and removes the row', !t.e && t.r.rowCount === 1 && (await q(`SELECT 1 FROM agentic_os.lane WHERE id='zz-b-3'`)).rowCount === 0, t.e?.message);
  await q('RESET lane.client_version');
  log(`after RESET, current_setting = ${JSON.stringify((await q(`SELECT current_setting('lane.client_version', true) AS v`)).rows[0].v)}`);
  t = await tryq(`UPDATE agentic_os.lane SET note='y' WHERE id='zz-b-1'`);
  check('(b5) after RESET the fence is back (42501)', t.e?.code === '42501');
  await q(`SET lane.client_version = ''`);
  t = await tryq(`UPDATE agentic_os.lane SET note='y' WHERE id='zz-b-1'`);
  check("(b6) empty-string setting does not open the fence", t.e?.code === '42501');
  await q('RESET lane.client_version');
  await q('BEGIN'); await q(`SET LOCAL lane.client_version = '2'`);
  t = await tryq(`UPDATE agentic_os.lane SET note='z' WHERE id='zz-b-2'`);
  await q('COMMIT');
  check('(b7) SET LOCAL inside a transaction opens the fence for that transaction', !t.e && t.r.rowCount === 1, t.e?.message);
  t = await tryq(`UPDATE agentic_os.lane SET note='y' WHERE id='zz-b-2'`);
  check('(b8) SET LOCAL does not leak past COMMIT', t.e?.code === '42501');
  t = await tryq(`UPDATE agentic_os.lane SET note='y' WHERE id='nonexistent-lane'`);
  check('(b9) UPDATE that matches no row never fires the fence', !t.e && t.r.rowCount === 0);

  log('\n## Check (c): CCv3 lanes work with no setting (old-copy behaviour)');
  t = await tryq(`UPDATE agentic_os.lane SET note='old copy', updated_at=now() WHERE id='seed-harness-1'`);
  check('(c1) UPDATE of CCv3 lane with no setting succeeds', !t.e && t.r.rowCount === 1, t.e?.message);
  await q(`INSERT INTO agentic_os.lane (id, title) VALUES ('zz-c-del','delete me')`);
  t = await tryq(`DELETE FROM agentic_os.lane WHERE id='zz-c-del'`);
  check('(c2) DELETE of CCv3 lane with no setting really deletes (trigger returns OLD)', !t.e && t.r.rowCount === 1 && (await q(`SELECT 1 FROM agentic_os.lane WHERE id='zz-c-del'`)).rowCount === 0, t.e?.message);
  // Old lane.mjs claim shape: conditional UPDATE by id.
  t = await tryq(`UPDATE agentic_os.lane SET owner_session_id='zz-seed-sb', state='active', fence=fence+1, claimed_at=now(), lease_expires_at=now()+interval '90 minutes', updated_at=now()
                  WHERE id='seed-harness-2' AND (owner_session_id IS NULL) RETURNING id, project_key, fence`);
  check('(c3) old-style claim UPDATE on CCv3 lane succeeds', !t.e && t.r.rowCount === 1, t.e?.message);
  t = await tryq(`UPDATE agentic_os.lane SET owner_session_id='zz-seed-sb', state='active' WHERE id='zz-b-1' AND owner_session_id IS NULL`);
  check('(c4) old-style claim UPDATE on a foreign-board lane is refused (42501)', t.e?.code === '42501');

  log('\n## ON CONFLICT DO UPDATE from an old lane.mjs `add` (no setting)');
  const oldAdd = `INSERT INTO agentic_os.lane (id,title,track,scope,branch,state,priority,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, track=EXCLUDED.track, scope=COALESCE(EXCLUDED.scope, agentic_os.lane.scope), priority=EXCLUDED.priority, updated_at=now()
       RETURNING id, project_key`;
  const args = (id) => [id, 'old add', 'harness', null, null, 'backlog', 50, null];
  t = await tryq(oldAdd, args('seed-harness-3'));
  check('(oc1) ON CONFLICT DO UPDATE on an existing CCv3 lane succeeds', !t.e && t.r.rows[0]?.project_key === 'continuous-claude', t.e?.message);
  t = await tryq(oldAdd, args('zz-b-1'));
  log(`   existing foreign lane -> ${t.e ? `${t.e.code}: ${t.e.message}` : 'no error'}`);
  check('(oc2) ON CONFLICT DO UPDATE onto a foreign-board id is refused by the fence (42501)', t.e?.code === '42501');
  t = await tryq(oldAdd, args('zz-oc-new'));
  check('(oc3) new id inserts with default key continuous-claude', !t.e && t.r.rows[0]?.project_key === 'continuous-claude', t.e?.message);
  const newAdd = `INSERT INTO agentic_os.lane (id,title,project_key) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, updated_at=now() WHERE agentic_os.lane.project_key = EXCLUDED.project_key`;
  await q(`SET lane.client_version = '2'`);
  t = await tryq(newAdd, ['zz-b-1', 'new add', 'continuous-claude']);
  check('(oc4) planned new-client add with a mismatched board: WHERE false -> 0 rows, no trigger error', !t.e && t.r.rowCount === 0, t.e?.message);
  t = await tryq(newAdd, ['zz-b-1', 'new add', 'zz-b']);
  check('(oc5) planned new-client add with the matching board updates 1 row', !t.e && t.r.rowCount === 1, t.e?.message);
  await q('RESET lane.client_version');
  // Old lane.mjs seed shape touches the same path; also watermark upsert has no project_key and is unaffected.
  t = await tryq(`INSERT INTO agentic_os.lane_watermark (session_id, last_event_id, updated_at) VALUES ('zz-seed-sa',3,now()) ON CONFLICT (session_id) DO UPDATE SET last_event_id=EXCLUDED.last_event_id, updated_at=now()`);
  check('(oc6) watermark upsert (old shape) still works', !t.e, t.e?.message);
  t = await tryq(`INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail) VALUES ('seed-harness-1','note','zz-seed-sa',NULL,'old insert','{}') RETURNING project_key`);
  check('(oc7) old lane_event insert (no project_key) defaults to continuous-claude', !t.e && t.r.rows[0].project_key === 'continuous-claude', t.e?.message);

  log('\n## Check (d): ids stay globally unique through the primary key on id (no unique index on (project_key, id))');
  t = await tryq(`INSERT INTO agentic_os.lane (id, title, project_key) VALUES ('zz-b-1','dup pair','zz-b')`);
  log(`duplicate (zz-b, zz-b-1) -> ${t.e ? `${t.e.code} constraint=${t.e.constraint}` : 'no error'}`);
  const dupPair = t.e;
  t = await tryq(`INSERT INTO agentic_os.lane (id, title, project_key) VALUES ('zz-b-1','same id other board','zz-other')`);
  log(`same id 'zz-b-1' under board zz-other -> ${t.e ? `${t.e.code} constraint=${t.e.constraint}` : 'no error'}`);
  const sameId = t.e;
  check('(d1) duplicate (project_key,id) pair is rejected', dupPair?.code === '23505');
  check('(d2) same id under another board is still rejected (by the primary key)', sameId?.code === '23505' && sameId.constraint === 'lane_pkey', `constraint=${sameId?.constraint}`);
  log(`   NOTE: the duplicate pair is rejected by constraint '${dupPair?.constraint}': the primary key. Lane ids stay globally unique.`);
  check('(d3) the redundant unique index lane_project_id_uniq is absent; lane_project_track_priority_idx (project_key, track, priority) is present',
    (await q(`SELECT 1 FROM pg_indexes WHERE schemaname='agentic_os' AND indexname='lane_project_id_uniq'`)).rowCount === 0
    && (await q(`SELECT 1 FROM pg_indexes WHERE schemaname='agentic_os' AND indexname='lane_project_track_priority_idx' AND indexdef LIKE '%(project_key, track, priority)'`)).rowCount === 1);

  log('\n## Step 5: EXPLAIN on the post-0004 queries (project_key filter added)');
  const after = [
    ['board: open lanes', `SELECT l.* FROM agentic_os.lane l WHERE (false OR l.state <> 'done') AND l.project_key = 'continuous-claude' ORDER BY l.track, l.priority, l.id`],
    ['next: claimable by priority', `SELECT l.* FROM agentic_os.lane l WHERE l.state IN ('ready','backlog') AND l.project_key = 'continuous-claude' ORDER BY l.priority, l.id LIMIT 5`],
    ['claim: lookup by id', `SELECT l.* FROM agentic_os.lane l WHERE l.id = 'seed-harness-1' AND l.project_key = 'continuous-claude'`],
    ['unread: events past watermark', `SELECT e.* FROM agentic_os.lane_event e WHERE e.project_key = 'continuous-claude' AND e.id > COALESCE((SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id='x'),0) AND e.session_id <> 'x' AND (e.to_session_id IS NULL OR e.to_session_id = 'x') ORDER BY e.id`],
    ['lanes by owner (renew/mine)', `SELECT l.* FROM agentic_os.lane l WHERE l.owner_session_id='zz-seed-sa' ORDER BY l.priority, l.id`],
  ];
  for (const [l, s] of after) await explain(l, s);
  for (const i of [0, 1, 3]) await explain(after[i][0], after[i][1], { noseq: true });

  log('\n## Check (e): down migration restores the 0003 shape, then 0004 re-applies');
  // Remove the foreign rows first: dropping project_key would otherwise turn them into CCv3 lanes (documented data loss).
  await q(`SET lane.client_version = '2'`);
  await q(`DELETE FROM agentic_os.lane WHERE project_key <> 'continuous-claude'`);
  await q('RESET lane.client_version');
  log(tool('down', url, '4').trim() || '(down applied)');
  const schemaDown = await describe();
  const same = JSON.stringify(schemaDown) === JSON.stringify(schema3);
  if (!same) {
    log('  expected (0003):'); schema3.forEach((s) => log('    ' + s));
    log('  got (after down):'); schemaDown.forEach((s) => log('    ' + s));
  }
  check('(e1) schema after 0004_down equals the 0003 shape (columns, indexes, constraints, triggers, functions)', same);
  check('(e2) seeded lanes survive the round trip', Number((await q('SELECT count(*) AS n FROM agentic_os.lane')).rows[0].n) >= seedCount);
  log(tool('migrate', url, '4').trim() || '(0004 re-applied)');
  const schemaAgain = await describe();
  check('(e3) 0004 re-applies after down and gives the same 0004 shape', JSON.stringify(schemaAgain) === JSON.stringify(schema4));
  const a2 = (await q('SELECT project_key, count(*)::int AS n FROM agentic_os.lane GROUP BY 1')).rows;
  check('(e4) after re-apply every lane is continuous-claude', a2.length === 1 && a2[0].project_key === 'continuous-claude', JSON.stringify(a2));
  // Idempotence of the hand-written part: the trigger block alone can run twice.
  const trgChunks = (await import('node:fs')).readFileSync(`${WT}/apps/agentic-os/drizzle/0004_per_project_lanes.sql`, 'utf8').split('--> statement-breakpoint').slice(-3);
  await q('BEGIN'); let ok = true; try { for (const ch of trgChunks) await q(ch); await q('COMMIT'); } catch (e) { ok = false; log(e.message); await rollbackIfAborted(); }
  check('(e5) trigger block (CREATE OR REPLACE function, DROP TRIGGER IF EXISTS, CREATE TRIGGER) is re-runnable', ok);
  await c.end();

  log('\n## Check (f): create --through 4 builds the post-0004 schema in one step');
  const c4 = JSON.parse(tool('create', '--through', '4'));
  try {
    const x = new pg.Client({ connectionString: c4.url }); await x.connect();
    const trg = await x.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='lane_guard_foreign_board' AND NOT tgisinternal`);
    const col = await x.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='agentic_os' AND column_name='project_key' AND table_name IN ('lane','lane_event')`);
    check('(f1) create --through 4 has the trigger and both project_key columns', trg.rows[0].n === 1 && col.rows[0].n === 2, `trigger=${trg.rows[0].n} columns=${col.rows[0].n}`);
    await x.end();
  } finally { log(tool('drop', c4.url).trim()); }

  log('\n## Check (g): fallback DDL (sessions, file_claims, sequence) is valid on an empty database');
  const gdb = JSON.parse(tool('create', '--through', '0'));
  try {
    const mod = await import(pathToFileURL(TOOL).href);
    const x = new pg.Client({ connectionString: gdb.url }); await x.connect();
    await x.query('DROP TABLE file_claims, sessions CASCADE; DROP SEQUENCE coordination_fence_seq CASCADE');
    await x.query(mod.MINIMAL_INIT);
    const n = await x.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('sessions','file_claims') AND table_schema='public'`);
    check('(g1) MINIMAL_INIT recreates sessions and file_claims', n.rows[0].n === 2);
    await x.end();
  } finally { log(tool('drop', gdb.url).trim()); }
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  results.push(['driver error', false]);
} finally {
  if (c) await c.end().catch(() => {}); // the failure path must not leave the client open: it can hang the script and block the drop
  if (url) {
    log('\n## Final step: drop scratch database');
    try { log(tool('drop', url).trim()); } catch (e) { log('drop failed: ' + e.message); results.push(['drop', false]); }
  }
  const failed = results.filter((r) => !r[1]).length;
  log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed (of ${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}
