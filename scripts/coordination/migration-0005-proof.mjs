#!/usr/bin/env node
// End-to-end proof of migration 0005 (timed lane reminders: 7 nullable columns, 2 CHECKs, lane_due_idx)
// against a SCRATCH database only. Creates its own lanes_pr1_* database, never touches continuous_claude,
// drops it at the end. Every write goes through scratch-db.mjs or a connection to the scratch URL.
//
//   node scripts/coordination/migration-0005-proof.mjs
//
// The transcript goes to .claude/cache/e2e/2026-11-06-migration-0005-proof.txt (overwritten). Exit 1 if a check fails.
// The server comes from CONTINUOUS_CLAUDE_DB_URL / DATABASE_URL / OPC_POSTGRES_URL (as scratch-db.mjs reads it);
// only a NEW database named lanes_pr1_* is written.
// Design: .claudedocs/2026-11-06-lane-reminders-design.md ("Data model", build phase 1).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/');
const OUT = `${WT}/.claude/cache/e2e/2026-11-06-migration-0005-proof.txt`;
const TOOL = `${WT}/scripts/coordination/scratch-db.mjs`;
const LANE_CLI = `${WT}/scripts/coordination/lane.mjs`;
const SQL_0005 = `${WT}/apps/agentic-os/drizzle/0005_lane_reminders.sql`;
const SQL_0005_DOWN = `${WT}/apps/agentic-os/drizzle/0005_down.sql`;
mkdirSync(`${WT}/.claude/cache/e2e`, { recursive: true });
writeFileSync(OUT, '');
const pg = createRequire(pathToFileURL(`${WT}/.claude/hooks/package.json`))('pg');

const mask = (s) => String(s).replace(/(postgresql:\/\/[^:]+:)[^@]+@/g, '$1***@');
const log = (s = '') => { const t = mask(s); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const tool = (...args) => execFileSync('node', [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
/** Run scratch-db.mjs and keep the failure instead of throwing. */
const toolTry = (...args) => {
  const t0 = Date.now();
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - t0 };
};

// The seven columns, in design order, with the type and CHECK each one must have.
const NEW_COLS = [
  ['due_at', 'timestamp with time zone'], ['band', 'text'], ['remind_state', 'text'], ['fired_at', 'timestamp with time zone'],
  ['action_id', 'text'], ['notion_page_id', 'text'], ['notion_synced_at', 'timestamp with time zone'],
];
const NEW_COL_NAMES = NEW_COLS.map((c) => c[0]);
const TICK_SQL = `SELECT id, project_key, band, due_at FROM agentic_os.lane
  WHERE project_key = 'continuous-claude' AND remind_state = 'scheduled' AND due_at <= now() AND state <> 'done'`;
const SESSION_SQL = `SELECT id, title, band, remind_state, due_at, priority FROM agentic_os.lane
  WHERE project_key = 'continuous-claude' AND remind_state IN ('due','needs_dave','failed') AND due_at IS NOT NULL AND state <> 'done'
  ORDER BY band, due_at, priority, id LIMIT 5`;

const live = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
let url, name, c, c2;
try {
  log('# Migration 0005 scratch-database proof, 2026-11-06');
  log('# Live database: NOT touched. Only the scratch database below receives writes.');
  log('\n## Step 1: create scratch DB through migration 0004');
  const created = JSON.parse(tool('create', '--through', '4'));
  url = created.url; name = created.name;
  log(`scratch database: ${name}`);
  log(`scratch url: ${url}`);
  if (!name.startsWith('lanes_pr1_') || new URL(url).pathname.slice(1) === 'continuous_claude') throw new Error('guard: not a scratch db');
  if (live && new URL(live).pathname === new URL(url).pathname) throw new Error('scratch url equals live url');

  c = new pg.Client({ connectionString: url });
  await c.connect();
  const q = (sql, p) => c.query(sql, p);
  const tryq = async (sql, p) => { try { const r = await c.query(sql, p); return { r }; } catch (e) { return { e }; } };

  log(`\nSELECT version(): ${(await q('SELECT version() AS v')).rows[0].v}`);

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
  // Every lane row as JSON, minus the seven new keys, so the same query works before and after 0005.
  const snap = async () => JSON.stringify((await q(
    `SELECT to_jsonb(l) - $1::text[] AS j FROM agentic_os.lane l WHERE l.id NOT LIKE 'zz-%' ORDER BY l.id`, [NEW_COL_NAMES])).rows.map((r) => r.j));
  const eventCount = async () => Number((await q('SELECT count(*) AS n FROM agentic_os.lane_event')).rows[0].n);
  // The exact query from scripts/coordination/lane.mjs assertMigrated (lines 1218-1224). lane.mjs runs main() on import, so it cannot be imported.
  const assertMigratedN = async () => (await q(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='agentic_os' AND table_name IN ('lane','lane_event') AND column_name='project_key'`)).rows[0].n;
  const hasNewCols = async () => Number((await q(
    `SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name='lane' AND column_name = ANY($1::text[])`, [NEW_COL_NAMES])).rows[0].n);
  const laneCli = () => {
    const r = spawnSync('node', [LANE_CLI, 'board', '--project', 'continuous-claude'], { encoding: 'utf8', env: { ...process.env, CONTINUOUS_CLAUDE_DB_URL: url } });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  const schema4 = await describe();
  log('\n## 0004-shape schema description (lane, lane_event)');
  schema4.forEach((s) => log('  ' + s));

  log('\n## Step 2: seed');
  log(tool('seed', url).trim());
  const seedCount = Number((await q('SELECT count(*) AS n FROM agentic_os.lane')).rows[0].n);
  const rows0 = await snap();
  const ev0 = await eventCount();
  log(`lanes: ${seedCount}, events: ${ev0}; snapshot of all lane rows taken (${rows0.length} chars)`);

  log('\n## RED: the new columns do not exist before 0005');
  {
    const r = await tryq('SELECT due_at FROM agentic_os.lane LIMIT 1');
    log(`RED  ${r.e ? r.e.code + ': ' + r.e.message : 'unexpectedly succeeded'}`);
    check('(red) due_at query fails before 0005 with 42703', r.e?.code === '42703');
    check('(red2) assertMigrated count is 2 on the 0004 schema', (await assertMigratedN()) === 2);
  }
  const cli0 = laneCli();
  check('(red3) real lane.mjs board runs against the 0004 scratch DB', cli0.status === 0, `exit ${cli0.status}`);

  log('\n## Check (lock): 0005 fails fast, and leaves no trace, behind a long reader');
  {
    const sqlText = readFileSync(SQL_0005, 'utf8');
    check('(lock0) 0005 starts with SET LOCAL lock_timeout = \'3s\'', /^SET LOCAL lock_timeout = '3s';--> statement-breakpoint/.test(sqlText));
    const sqlCode = sqlText.replace(/--(?!>)[^\n]*/g, ''); // drop comments, keep the statement-breakpoint markers
    const addCols = sqlCode.split('--> statement-breakpoint').filter((st) => /ADD COLUMN/i.test(st));
    check('(lock0b) 7 ADD COLUMN statements, none with DEFAULT or NOT NULL', addCols.length === 7 && !addCols.some((st) => /\b(DEFAULT|NOT NULL)\b/i.test(st)), `${addCols.length} statements`);
    check('(lock0c) 0005 index build is not CONCURRENTLY (the migrator runs one transaction)', !/CONCURRENTLY/i.test(sqlCode));
    c2 = new pg.Client({ connectionString: url });
    await c2.connect();
    await c2.query('BEGIN');
    await c2.query('SELECT count(*) FROM agentic_os.lane'); // holds ACCESS SHARE until ROLLBACK
    const r = toolTry('migrate', url, '5');
    log(`migrate while a reader holds the table: exit ${r.status} after ${r.ms} ms`);
    log(r.out.trim().split('\n').slice(-2).join('\n'));
    check('(lock1) migrate fails with a lock timeout while a reader holds the table', r.status !== 0 && /lock timeout/i.test(r.out), `exit ${r.status}`);
    check('(lock2) it gives up after about 3 s, not never', r.ms >= 2500 && r.ms < 20000, `${r.ms} ms incl. node start`);
    await c2.query('ROLLBACK');
    await c2.end(); c2 = null;
    check('(lock3) the failed migration rolled back: no new column exists', (await hasNewCols()) === 0);
  }

  log('\n## Step 3: apply 0005');
  log(tool('migrate', url, '5').trim() || '(done, see stderr line above)');
  const schema5 = await describe();
  log('\n## 0005-shape schema description');
  schema5.filter((s, i) => !schema4.includes(s)).forEach((s) => log('  + ' + s));
  schema4.filter((s) => !schema5.includes(s)).forEach((s) => log('  - ' + s));

  log('\n## Check (a): the 7 columns');
  const colRows = (await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema='agentic_os' AND table_name='lane' AND column_name = ANY($1::text[]) ORDER BY ordinal_position`, [NEW_COL_NAMES])).rows;
  colRows.forEach((r) => log(`  ${r.column_name} ${r.data_type} nullable=${r.is_nullable} default=${r.column_default}`));
  check('(a1) exactly 7 new columns exist on agentic_os.lane', colRows.length === 7);
  check('(a2) names and types match the design',
    NEW_COLS.every(([n, t]) => colRows.find((r) => r.column_name === n)?.data_type === t));
  check('(a3) every new column is nullable with no default (metadata-only add)', colRows.every((r) => r.is_nullable === 'YES' && r.column_default === null));
  check('(a4) new columns are on lane only, not lane_event',
    Number((await q(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name='lane_event' AND column_name = ANY($1::text[])`, [NEW_COL_NAMES])).rows[0].n) === 0);

  log('\n## Check (b): the two CHECK constraints');
  const cons = (await q(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid='agentic_os.lane'::regclass AND contype='c' ORDER BY conname`)).rows;
  cons.forEach((r) => log(`  ${r.conname}: ${r.def}`));
  check('(b1) lane_band_check allows exactly P0, P1, P2', /band/.test(cons.find((r) => r.conname === 'lane_band_check')?.def || '')
    && ['P0', 'P1', 'P2'].every((v) => cons.find((r) => r.conname === 'lane_band_check').def.includes(`'${v}'`)));
  check('(b2) lane_remind_state_check allows exactly the five states',
    ['scheduled', 'due', 'needs_dave', 'failed', 'acked'].every((v) => (cons.find((r) => r.conname === 'lane_remind_state_check')?.def || '').includes(`'${v}'`))
    && !(cons.find((r) => r.conname === 'lane_remind_state_check')?.def || '').includes("'missed'"));
  const ins = (extra, vals) => tryq(`INSERT INTO agentic_os.lane (id, title, ${extra}) VALUES ('zz-chk-' || md5(random()::text), 'chk', ${vals})`);
  for (const v of ['P3', 'p0', '']) {
    const t = await ins('band', `'${v}'`);
    log(`INSERT band='${v}' -> ${t.e ? `${t.e.code} constraint=${t.e.constraint}` : 'no error'}`);
    check(`(b3) bad band '${v}' is rejected by lane_band_check (23514)`, t.e?.code === '23514' && t.e.constraint === 'lane_band_check');
  }
  for (const v of ['missed', 'DUE', 'done']) {
    const t = await ins('remind_state', `'${v}'`);
    log(`INSERT remind_state='${v}' -> ${t.e ? `${t.e.code} constraint=${t.e.constraint}` : 'no error'}`);
    check(`(b4) bad remind_state '${v}' is rejected by lane_remind_state_check (23514)`, t.e?.code === '23514' && t.e.constraint === 'lane_remind_state_check');
  }
  {
    let ok = true; let last = '';
    for (const p of ['P0', 'P1', 'P2']) for (const s of ['scheduled', 'due', 'needs_dave', 'failed', 'acked']) {
      const t = await ins('band, remind_state', `'${p}', '${s}'`);
      if (t.e) { ok = false; last = `${p}/${s}: ${t.e.message}`; }
    }
    check('(b5) all 3 priorities x 5 states are accepted', ok, last);
    const t = await ins('band, remind_state, due_at', 'NULL, NULL, NULL');
    check('(b6) NULL band and remind_state are accepted (Unsorted, and a lane that is not a reminder)', !t.e, t.e?.message);
    await q(`DELETE FROM agentic_os.lane WHERE id LIKE 'zz-chk-%'`);
  }

  log('\n## Check (c): existing rows and old writers are unaffected');
  check('(c1) all seeded lane rows are unchanged by 0005', (await snap()) === rows0);
  check('(c2) lane_event is untouched', (await eventCount()) === ev0);
  check('(c3) seeded lanes have NULL in all 7 new columns',
    Number((await q(`SELECT count(*) AS n FROM agentic_os.lane WHERE id LIKE 'seed-%' AND (${NEW_COL_NAMES.map((n) => n + ' IS NOT NULL').join(' OR ')})`)).rows[0].n) === 0);
  {
    // An old lane.mjs `add` names none of the new columns.
    const t = await tryq(`INSERT INTO agentic_os.lane (id,title,track,scope,branch,state,priority,note) VALUES ('zz-old-add','old add','harness',NULL,NULL,'backlog',50,NULL)
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, updated_at=now() RETURNING id, due_at, remind_state`);
    check('(c4) an old-shape lane insert (no new columns) still works and leaves them NULL', !t.e && t.r.rows[0].due_at === null && t.r.rows[0].remind_state === null, t.e?.message);
    await q(`DELETE FROM agentic_os.lane WHERE id='zz-old-add'`);
    await q(`INSERT INTO agentic_os.lane (id, title, project_key) VALUES ('zz-fence','foreign','zz-b')`);
    const f = await tryq(`UPDATE agentic_os.lane SET note='x' WHERE id='zz-fence'`);
    check('(c5) the 0004 foreign-board fence still refuses an unversioned UPDATE (42501)', f.e?.code === '42501');
    await q(`SET lane.client_version = '2'`);
    const f2 = await tryq(`UPDATE agentic_os.lane SET due_at = now(), band='P1', remind_state='scheduled' WHERE id='zz-fence'`);
    check('(c6) with client_version set, a foreign-board lane takes the new columns', !f2.e && f2.r.rowCount === 1, f2.e?.message);
    await q(`DELETE FROM agentic_os.lane WHERE id='zz-fence'`);
    await q('RESET lane.client_version');
  }

  log('\n## Check (d): assertMigrated (lane.mjs:1218) and the real lane CLI');
  const n5 = await assertMigratedN();
  log(`project_key column count over lane + lane_event = ${n5} (lane.mjs requires exactly 2)`);
  check('(d1) assertMigrated query still returns 2 after 0005', n5 === 2);
  const cli5 = laneCli();
  log(cli5.out.trim().split('\n').slice(0, 6).join('\n'));
  check('(d2) real lane.mjs board (runs assertMigrated) exits 0 against the 0005 scratch DB', cli5.status === 0 && /seed-/.test(cli5.out), `exit ${cli5.status}`);

  log('\n## Step 4: seed reminders, then EXPLAIN the tick and SessionStart queries');
  const explain = async (label, sql, opts = {}) => {
    log(`\n=== ${label}${opts.noseq ? '  [enable_seqscan=off, to show index shape]' : '  [planner default]'}\n${sql}`);
    await q('BEGIN');
    if (opts.noseq) await q('SET LOCAL enable_seqscan = off');
    const r = await q(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    await q('ROLLBACK');
    const plan = r.rows.map((x) => x['QUERY PLAN']).join('\n');
    log(plan);
    const used = /lane_due_idx/.test(plan);
    log(`>>> lane_due_idx used: ${used ? 'YES' : 'NO'}`);
    return used;
  };
  // 12 reminders on existing and new lanes: mixed past and future due times, states and priorities.
  await q(`UPDATE agentic_os.lane SET due_at = now() - interval '2 hours', band = 'P0', remind_state = 'scheduled' WHERE id = 'seed-harness-1'`);
  await q(`UPDATE agentic_os.lane SET due_at = now() - interval '30 minutes', band = 'P1', remind_state = 'due', fired_at = now() WHERE id = 'seed-harness-2'`);
  await q(`UPDATE agentic_os.lane SET due_at = now() + interval '1 day', band = 'P2', remind_state = 'scheduled' WHERE id = 'seed-agentic-1'`);
  await q(`UPDATE agentic_os.lane SET due_at = now() - interval '1 day', band = 'P1', remind_state = 'scheduled' WHERE id = 'seed-harness-4'`); // state done: must be excluded
  log('seeded 8 lanes: 4 carry a reminder (one is a done lane and must never match)');
  const small = [['tick (8 lanes)', TICK_SQL], ['SessionStart (8 lanes)', SESSION_SQL]];
  for (const [l, s] of small) await explain(l, s);
  const smallNoSeq = [];
  for (const [l, s] of small) smallNoSeq.push(await explain(l, s, { noseq: true }));
  log(`INFO  8-lane table, seqscan off: tick uses lane_due_idx = ${smallNoSeq[0]}, SessionStart uses lane_due_idx = ${smallNoSeq[1]}. On 8 rows the planner costs several indexes the same and may pick another; the 3000-row table below is the real test.`);
  const tickRows = (await q(TICK_SQL)).rows.map((r) => r.id).sort();
  check('(e3) tick query returns only the overdue scheduled lane, not the future, due, or done ones', JSON.stringify(tickRows) === JSON.stringify(['seed-harness-1']), JSON.stringify(tickRows));
  const sessRows = (await q(SESSION_SQL)).rows.map((r) => r.id);
  check('(e4) SessionStart query returns the due lane only', JSON.stringify(sessRows) === JSON.stringify(['seed-harness-2']), JSON.stringify(sessRows));

  log('\n--- Table with 3000 filler lanes and 12 reminders, ANALYZEd (the planner now has a reason to use the partial index)');
  await q(`INSERT INTO agentic_os.lane (id, title, track, state, priority) SELECT 'zz-fill-' || g, 'filler', 'harness', 'ready', g % 100 FROM generate_series(1, 3000) g`);
  await q(`INSERT INTO agentic_os.lane (id, title, state, due_at, band, remind_state)
    SELECT 'zz-rem-' || g, 'reminder ' || g, 'backlog', now() + (g - 6) * interval '1 hour', (ARRAY['P0','P1','P2'])[1 + g % 3],
           (ARRAY['scheduled','due','needs_dave','failed'])[1 + g % 4] FROM generate_series(1, 8) g`);
  await q('ANALYZE agentic_os.lane');
  const bulkTick = await explain('tick (3000+ lanes)', TICK_SQL);
  const bulkSess = await explain('SessionStart (3000+ lanes)', SESSION_SQL);
  await explain('tick (3000+ lanes)', TICK_SQL, { noseq: true });
  await explain('SessionStart (3000+ lanes)', SESSION_SQL, { noseq: true });
  check('(e5) tick query uses lane_due_idx on its own with 3000+ lanes', bulkTick);
  check('(e6) SessionStart query uses lane_due_idx on its own with 3000+ lanes', bulkSess);
  log('NOTE: the SessionStart ORDER BY starts with band, which is not in the index, so the index filters rows but a small Sort stays on top. That is fine: the partial index holds only open reminders.');
  await q(`DELETE FROM agentic_os.lane WHERE id LIKE 'zz-fill-%' OR id LIKE 'zz-rem-%'`);

  log('\n## Check (f): 0005_down.sql removes exactly what 0005 added');
  const rowsWithRem = await snap();
  check('(f0) seeded rows differ from the original snapshot only in the new columns (old columns unchanged)', rowsWithRem === rows0);
  log(tool('down', url, '5').trim() || '(down applied)');
  const schemaDown = await describe();
  const same = JSON.stringify(schemaDown) === JSON.stringify(schema4);
  if (!same) {
    log('  expected (0004):'); schema4.forEach((s) => log('    ' + s));
    log('  got (after down):'); schemaDown.forEach((s) => log('    ' + s));
  }
  check('(f1) schema after 0005_down equals the 0004 shape (columns, indexes, constraints, triggers, functions)', same);
  check('(f2) none of the 7 columns remain', (await hasNewCols()) === 0);
  check('(f3) lane_due_idx and both CHECK constraints are gone',
    (await q(`SELECT 1 FROM pg_indexes WHERE schemaname='agentic_os' AND indexname='lane_due_idx'`)).rowCount === 0
    && (await q(`SELECT 1 FROM pg_constraint WHERE conname IN ('lane_band_check','lane_remind_state_check')`)).rowCount === 0);
  check('(f4) old data intact after down', (await snap()) === rows0 && (await eventCount()) === ev0);
  check('(f5) assertMigrated query still returns 2 after down', (await assertMigratedN()) === 2);
  const cliDown = laneCli();
  check('(f6) real lane.mjs board still runs after down', cliDown.status === 0, `exit ${cliDown.status}`);

  log('\n## Step 5: migrate again');
  log(tool('migrate', url, '5').trim() || '(0005 re-applied)');
  const schemaAgain = await describe();
  check('(g1) 0005 re-applies after down and gives the same 0005 shape', JSON.stringify(schemaAgain) === JSON.stringify(schema5));
  check('(g2) old data intact after the round trip', (await snap()) === rows0);
  check('(g3) assertMigrated query returns 2 after the round trip', (await assertMigratedN()) === 2);
  check('(g4) the CHECK still rejects a bad value after the round trip', (await ins('band', "'P9'")).e?.code === '23514');
  await c.end(); c = null;

  log('\n## Check (h): create --through 5 builds the post-0005 schema in one step');
  const c5 = JSON.parse(tool('create', '--through', '5'));
  try {
    const x = new pg.Client({ connectionString: c5.url }); await x.connect();
    const col = await x.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name='lane' AND column_name = ANY($1::text[])`, [NEW_COL_NAMES]);
    const idx = await x.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='agentic_os' AND indexname='lane_due_idx'`);
    const trg = await x.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='lane_guard_foreign_board' AND NOT tgisinternal`);
    check('(h1) create --through 5 has 7 columns, lane_due_idx and the 0004 trigger', col.rows[0].n === 7 && idx.rows[0].n === 1 && trg.rows[0].n === 1, `columns=${col.rows[0].n} index=${idx.rows[0].n} trigger=${trg.rows[0].n}`);
    await x.end();
  } finally { log(tool('drop', c5.url).trim()); }

  log(`\nSQL files proven: ${SQL_0005.replace(WT + '/', '')}, ${SQL_0005_DOWN.replace(WT + '/', '')}`);
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  results.push(['driver error', false]);
} finally {
  if (c2) { await c2.query('ROLLBACK').catch(() => {}); await c2.end().catch(() => {}); }
  if (c) await c.end().catch(() => {}); // the failure path must not leave the client open: it can hang the script and block the drop
  if (url) {
    log('\n## Final step: drop scratch database');
    try { log(tool('drop', url).trim()); } catch (e) { log('drop failed: ' + e.message); results.push(['drop', false]); }
  }
  const failed = results.filter((r) => !r[1]).length;
  log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed (of ${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}
