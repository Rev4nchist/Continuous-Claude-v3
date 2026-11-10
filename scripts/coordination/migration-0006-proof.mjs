#!/usr/bin/env node
// End-to-end proof of migration 0006 (the dependency gate: new table agentic_os.lane_dep, 3 NOT NULL text columns,
// primary key lane_dep_pkey, CHECK lane_dep_no_self_check, no foreign key, no trigger, no extra index)
// against a SCRATCH database only. Creates its own lanes_pr1_* database, never touches continuous_claude,
// drops it at the end. Every write goes through scratch-db.mjs or a connection to the scratch URL.
//
//   node scripts/coordination/migration-0006-proof.mjs
//
// The transcript goes to stdout (redirect it to keep it). Exit 1 if a check fails.
// The server comes from CONTINUOUS_CLAUDE_DB_URL / DATABASE_URL / OPC_POSTGRES_URL (as scratch-db.mjs reads it);
// only a NEW database named lanes_pr1_* is written.
// Contract: .claudedocs/re-execution/contracts/t2.1-contract.md, "Contract point 1" (1.13 lists the assertions).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  console.log('usage: node scripts/coordination/migration-0006-proof.mjs\n'
    + 'Proves migration 0006 on a throwaway lanes_pr1_* database. Needs a reachable Postgres and the pg package\n'
    + '(set NODE_PATH to a folder that holds pg). Takes no other arguments. Exit 1 if a check fails, 2 if pg is missing.');
  process.exit(0);
}

const WT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/');
const TOOL = `${WT}/scripts/coordination/scratch-db.mjs`;
const DRIZZLE = `${WT}/apps/agentic-os/drizzle`;
const SQL_0006 = `${DRIZZLE}/0006_lane_dep.sql`;
const SQL_0006_DOWN = `${DRIZZLE}/0006_down.sql`;
const JOURNAL = `${DRIZZLE}/meta/_journal.json`;
let pg;
try {
  pg = requireDep('pg', { repoRoot: WT });
} catch (e) {
  console.error(`migration-0006-proof: the pg package is not available (${e.message}). Set NODE_PATH to a folder that holds pg.`);
  process.exit(2);
}

const mask = (s) => String(s).replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g, '$1***@');
const log = (s = '') => console.log(mask(s));
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const tool = (...args) => execFileSync('node', [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
/**
 * Run scratch-db.mjs and keep the failure instead of throwing. The timeout bounds a migrate that waits on a lock
 * (lock1 holds ACCESS EXCLUSIVE): a killed run has status null, which every caller treats as a failure, so the
 * finally block still rolls back and drops the scratch database.
 */
const toolTry = (...args) => {
  const t0 = Date.now();
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') + (r.status === null ? '\n(killed after 30s)' : ''), ms: Date.now() - t0 };
};
const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
/** SQL without line comments; the statement-breakpoint markers stay. */
const stripComments = (t) => t.replace(/--(?!>)[^\n]*/g, '');

const COLS = ['lane_id', 'depends_on', 'project_key'];
const LANE_SQL = `SELECT 1 FROM agentic_os.lane_dep WHERE lane_id = $1`;

const live = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
let url, name, c, c2;
try {
  log('# Migration 0006 scratch-database proof');
  log('# Live database: NOT touched. Only the scratch database below receives writes.');
  log('\n## Step 1: create scratch DB through migration 0005');
  const created = JSON.parse(tool('create', '--through', '5'));
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

  /** Columns, indexes, constraints and triggers of the named tables, as sorted text lines. */
  const describe = async (tables) => {
    const out = [];
    const cols = await q(`SELECT table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' default='||coalesce(column_default,'') AS d
      FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name = ANY($1::text[]) ORDER BY 1`, [tables]);
    out.push(...cols.rows.map((r) => 'col ' + r.d));
    const idx = await q(`SELECT indexdef AS d FROM pg_indexes WHERE schemaname='agentic_os' AND tablename = ANY($1::text[]) ORDER BY 1`, [tables]);
    out.push(...idx.rows.map((r) => 'idx ' + r.d));
    const con = await q(`SELECT conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE connamespace='agentic_os'::regnamespace AND conrelid::regclass::text = ANY($1::text[]) ORDER BY 1`, [tables.map((t) => `agentic_os.${t}`)]);
    out.push(...con.rows.map((r) => 'con ' + r.d));
    const trg = await q(`SELECT tgname||' on '||tgrelid::regclass AS d FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($1::text[]) ORDER BY 1`, [tables.map((t) => `agentic_os.${t}`)]);
    out.push(...trg.rows.map((r) => 'trg ' + r.d));
    return out;
  };
  const allTables = async () => (await q(`SELECT tablename FROM pg_tables WHERE schemaname='agentic_os' ORDER BY 1`)).rows.map((r) => r.tablename);
  const describeAll = async () => [...(await describe(await allTables())),
    ...(await q(`SELECT 'fn '||proname AS d FROM pg_proc WHERE pronamespace='agentic_os'::regnamespace ORDER BY 1`)).rows.map((r) => r.d)];
  const count = async (t) => Number((await q(`SELECT count(*) AS n FROM agentic_os.${t}`)).rows[0].n);
  const snap = async () => JSON.stringify((await q(`SELECT to_jsonb(l) AS j FROM agentic_os.lane l ORDER BY l.id`)).rows.map((r) => r.j));
  const laneDepExists = async () => (await q(`SELECT to_regclass('agentic_os.lane_dep') AS r`)).rows[0].r !== null;

  log('\n## Step 2: seed lanes (so "lane is unchanged" compares real rows)');
  log(tool('seed', url).trim());
  const lane0 = await describe(['lane']);
  const all0 = await describeAll();
  const laneRows0 = await count('lane');
  const laneSnap0 = await snap();
  const evRows0 = await count('lane_event');
  log(`lane rows: ${laneRows0}, lane_event rows: ${evRows0}; lane schema lines: ${lane0.length}`);
  check('(pre) the seed made lane rows to compare', laneRows0 > 0, `${laneRows0} rows`);

  log('\n## Check (files): the migration files and the journal');
  const upText = readText(SQL_0006);
  const downText = readText(SQL_0006_DOWN);
  const journal = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  const entry6 = journal.entries.find((e) => e.idx === 6);
  const entry5 = journal.entries.find((e) => e.idx === 5);
  check('(files1) 0006_lane_dep.sql exists', upText !== null);
  check('(files2) 0006_down.sql exists', downText !== null);
  check('(files3) journal entry idx 6 is version "7", tag 0006_lane_dep, breakpoints true, and newer than idx 5',
    !!entry6 && entry6.version === '7' && entry6.tag === '0006_lane_dep' && entry6.breakpoints === true && entry6.when > entry5.when,
    entry6 ? JSON.stringify(entry6) : 'no entry idx 6');
  check('(files4) the down file is not in the journal', !journal.entries.some((e) => /down/i.test(e.tag)));
  check('(files5) every journal entry has idx equal to its position, and entry 6 exists', journal.entries.every((e, i) => e.idx === i) && journal.entries.length >= 7, `${journal.entries.length} entries`);
  if (upText !== null) {
    const code = stripComments(upText);
    const stmts = code.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    check("(lock0) 0006 starts with SET LOCAL lock_timeout = '3s'", /^SET LOCAL lock_timeout = '3s';--> statement-breakpoint/.test(upText));
    check('(lock0b) 0006 holds one CREATE TABLE for lane_dep and nothing else besides the SET LOCAL',
      stmts.length === 2 && /^SET LOCAL lock_timeout/.test(stmts[0]) && /^CREATE TABLE "agentic_os"\."lane_dep"/.test(stmts[1]), `${stmts.length} statements`);
    check('(lock0c) 0006 has no IF NOT EXISTS, no REFERENCES, no ALTER, no CREATE INDEX, no CONCURRENTLY, no DEFAULT',
      !/IF NOT EXISTS|REFERENCES|ALTER\s|CREATE\s+(UNIQUE\s+)?INDEX|CONCURRENTLY|\bDEFAULT\b/i.test(code));
  } else {
    check('(lock0) 0006 starts with SET LOCAL lock_timeout', false, 'file missing');
  }
  if (downText !== null) {
    const code = stripComments(downText);
    check("(lock0d) 0006_down.sql sets lock_timeout = '3s' and drops lane_dep",
      /SET LOCAL lock_timeout = '3s';/.test(code) && /DROP TABLE IF EXISTS agentic_os\.lane_dep;/.test(code));
  } else {
    check("(lock0d) 0006_down.sql sets lock_timeout = '3s' and drops lane_dep", false, 'file missing');
  }

  log('\n## RED: lane_dep does not exist before 0006');
  {
    const r = await tryq(LANE_SQL, ['x']);
    log(`RED  ${r.e ? r.e.code + ': ' + r.e.message : 'unexpectedly succeeded'}`);
    check('(red) a lane_dep query fails before 0006 with 42P01', r.e?.code === '42P01');
  }

  log('\n## Step 3: apply 0006');
  const mig = toolTry('migrate', url, '6');
  log(mig.out.trim());
  check('(mig) migrate 6 exits 0', mig.status === 0, `exit ${mig.status}`);
  if (mig.status !== 0) throw new Error('migrate 6 failed: the checks below need the table');
  const all1 = await describeAll();
  log('\n## Schema delta of 0006 (whole agentic_os schema)');
  all1.filter((s) => !all0.includes(s)).forEach((s) => log('  + ' + s));
  all0.filter((s) => !all1.includes(s)).forEach((s) => log('  - ' + s));

  log('\n## Check 1: the table and its columns');
  const colRows = (await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema='agentic_os' AND table_name='lane_dep' ORDER BY ordinal_position`)).rows;
  colRows.forEach((r) => log(`  ${r.column_name} ${r.data_type} nullable=${r.is_nullable} default=${r.column_default}`));
  check('(1a) lane_dep has exactly the 3 columns lane_id, depends_on, project_key', JSON.stringify(colRows.map((r) => r.column_name)) === JSON.stringify(COLS));
  check('(1b) all 3 are text, NOT NULL, with no default', colRows.length === 3 && colRows.every((r) => r.data_type === 'text' && r.is_nullable === 'NO' && r.column_default === null));

  log('\n## Check 2: constraints by name');
  const cons = (await q(`SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid='agentic_os.lane_dep'::regclass ORDER BY conname`)).rows;
  cons.forEach((r) => log(`  ${r.conname} (${r.contype}): ${r.def}`));
  const pkey = cons.find((r) => r.conname === 'lane_dep_pkey');
  const chk = cons.find((r) => r.conname === 'lane_dep_no_self_check');
  check('(2a) pg_constraint holds lane_dep_pkey, a primary key on (lane_id, depends_on)', pkey?.contype === 'p' && /PRIMARY KEY \(lane_id, depends_on\)/.test(pkey.def), pkey?.def);
  check('(2b) pg_constraint holds lane_dep_no_self_check, a CHECK of lane_id <> depends_on', chk?.contype === 'c' && /lane_id <> depends_on/.test(chk.def), chk?.def);
  check('(2c) these are the only 2 constraints on lane_dep', cons.length === 2, `${cons.length} constraints`);

  log('\n## Check 3: no trigger, no foreign key, no other index');
  const trg = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid='agentic_os.lane_dep'::regclass AND NOT tgisinternal`)).rows;
  check('(3a) no user trigger on lane_dep', trg.length === 0, `${trg.length} triggers`);
  const itrg = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid='agentic_os.lane_dep'::regclass`)).rows;
  check('(3b) no internal (foreign key) trigger on lane_dep either', itrg.length === 0, `${itrg.length} triggers`);
  const fks = (await q(`SELECT conname FROM pg_constraint WHERE contype='f' AND (conrelid='agentic_os.lane_dep'::regclass OR confrelid='agentic_os.lane_dep'::regclass)`)).rows;
  check('(3c) no foreign key on lane_dep, from or to it', fks.length === 0, `${fks.length} foreign keys`);
  const idx = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname='agentic_os' AND tablename='lane_dep' ORDER BY 1`)).rows.map((r) => r.indexname);
  check('(3d) the only index is lane_dep_pkey (no depends_on or project_key index)', JSON.stringify(idx) === JSON.stringify(['lane_dep_pkey']), idx.join(','));

  log('\n## Check 4 and 5: the constraints reject, and an orphan edge inserts');
  const ins = (cols, vals) => tryq(`INSERT INTO agentic_os.lane_dep (${cols}) VALUES (${vals})`);
  {
    const r = await ins('lane_id, depends_on, project_key', `'zz-a', 'zz-a', 'continuous-claude'`);
    log(`INSERT self-edge -> ${r.e ? `${r.e.code} constraint=${r.e.constraint}` : 'no error'}`);
    check('(4a) a self-edge fails with 23514 on lane_dep_no_self_check', r.e?.code === '23514' && r.e.constraint === 'lane_dep_no_self_check');
  }
  {
    const first = await ins('lane_id, depends_on, project_key', `'zz-a', 'zz-b', 'continuous-claude'`);
    check('(4b0) a first edge inserts', !first.e, first.e?.message);
    const r = await ins('lane_id, depends_on, project_key', `'zz-a', 'zz-b', 'continuous-claude'`);
    log(`INSERT duplicate edge -> ${r.e ? `${r.e.code} constraint=${r.e.constraint}` : 'no error'}`);
    check('(4b) a duplicate edge fails with 23505 on lane_dep_pkey', r.e?.code === '23505' && r.e.constraint === 'lane_dep_pkey');
    const other = await ins('lane_id, depends_on, project_key', `'zz-a', 'zz-b', 'other-board'`);
    check('(4b2) the same edge with another project_key also fails with 23505 (project_key is not in the key)', other.e?.code === '23505');
  }
  {
    const r = await ins('lane_id, depends_on', `'zz-c', 'zz-d'`);
    log(`INSERT without project_key -> ${r.e ? `${r.e.code} column=${r.e.column}` : 'no error'}`);
    check('(4c) an insert without project_key fails with 23502', r.e?.code === '23502' && r.e.column === 'project_key');
  }
  {
    const have = (await q(`SELECT count(*)::int AS n FROM agentic_os.lane WHERE id IN ('zz-e', 'zz-f')`)).rows[0].n;
    const r = await ins('lane_id, depends_on, project_key', `'zz-e', 'zz-f', 'continuous-claude'`);
    check('(5) an edge between ids that have no lane row inserts (no foreign key)', have === 0 && !r.e, r.e?.message || `lane rows with those ids: ${have}`);
    const real = await ins('lane_id, depends_on, project_key', `'seed-harness-1', 'zz-f', 'continuous-claude'`);
    check('(5b) an edge from a real lane to an id with no lane row inserts', !real.e, real.e?.message);
  }
  await q(`DELETE FROM agentic_os.lane_dep WHERE lane_id LIKE 'zz-%' OR depends_on LIKE 'zz-%'`);
  check('(5c) cleanup by prefix on both columns leaves lane_dep empty', (await count('lane_dep')) === 0);

  log('\n## Check 6: the planner uses lane_dep_pkey for the stand-in query, with no planner setting changed');
  {
    // 12000 filler rows, 4 edges per lane, many distinct lane_id values, then ANALYZE, so the planner picks by cost.
    await q(`INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key)
      SELECT 'zz-fill-' || (g / 4), 'zz-dep-' || g, 'continuous-claude' FROM generate_series(0, 11999) g`);
    await q('ANALYZE agentic_os.lane_dep');
    const rows = await count('lane_dep');
    const seq = (await q('SHOW enable_seqscan')).rows[0].enable_seqscan;
    log(`filler rows: ${rows}; enable_seqscan = ${seq} (session default, not changed)`);
    check('(6a) at least 10000 filler rows are in place', rows >= 10000, `${rows} rows`);
    check('(6b) enable_seqscan is on: the planner chooses by cost', seq === 'on');
    log(`query: ${LANE_SQL}   with $1 = 'zz-fill-1500'`);
    // Bound value first. EXPLAIN takes no parameter in the simple protocol, so use PREPARE, then EXPLAIN EXECUTE.
    await q(`PREPARE lane_dep_edges(text) AS ${LANE_SQL}`);
    const plan = (await q(`EXPLAIN (ANALYZE, BUFFERS) EXECUTE lane_dep_edges('zz-fill-1500')`)).rows.map((x) => x['QUERY PLAN']).join('\n');
    log(plan);
    await q('DEALLOCATE lane_dep_edges');
    check('(6c) the plan names lane_dep_pkey', /lane_dep_pkey/.test(plan));
    check('(6d) the plan has no Seq Scan on lane_dep', !/Seq Scan on lane_dep/.test(plan));
    await q(`DELETE FROM agentic_os.lane_dep WHERE lane_id LIKE 'zz-%' OR depends_on LIKE 'zz-%'`);
    await q(`DELETE FROM agentic_os.lane_dep WHERE lane_id = 'seed-harness-1'`);
    check('(6e) filler removed: lane_dep is empty again', (await count('lane_dep')) === 0);
  }

  log('\n## Check 8: the drizzle journal table on the scratch database');
  {
    const reg = (await q(`SELECT to_regclass('agentic_os.__migrations') AS r`)).rows[0].r;
    if (reg === null) {
      log('NOTE  agentic_os.__migrations does not exist on the scratch database: scratch-db.mjs runs each drizzle file itself and never writes the drizzle journal table. The 0006 row check is NOT proven here. The pre-land migration check reads that table on the live database.');
    } else {
      const rows = (await q('SELECT * FROM agentic_os.__migrations ORDER BY id')).rows;
      if (!rows.length) {
        log('NOTE  agentic_os.__migrations exists but is empty: scratch-db.mjs does not write it. The 0006 row check is NOT proven here.');
      } else {
        check('(8) agentic_os.__migrations holds the 0006 row (created_at = the journal "when")',
          rows.some((r) => Number(r.created_at) === entry6?.when), `${rows.length} rows`);
      }
    }
  }

  log('\n## Check 7a: table lane is unchanged by 0006');
  check('(7a1) lane columns, indexes, constraints and triggers are identical before and after migrate 6', JSON.stringify(await describe(['lane'])) === JSON.stringify(lane0));
  check('(7a2) lane rows and lane_event rows are unchanged', (await snap()) === laneSnap0 && (await count('lane_event')) === evRows0);
  check('(7a3) the only schema difference is the new lane_dep table and its key and check',
    all1.filter((s) => !all0.includes(s)).every((s) => /lane_dep/.test(s)) && all0.every((s) => all1.includes(s)));

  log('\n## Check 7b: 0006_down.sql removes exactly what 0006 added');
  const down = toolTry('down', url, '6');
  log(down.out.trim());
  check('(7b0) down 6 exits 0', down.status === 0, `exit ${down.status}`);
  check('(7b1) lane_dep is gone', !(await laneDepExists()));
  check('(7b2) lane_dep_pkey and lane_dep_no_self_check are gone',
    (await q(`SELECT 1 FROM pg_constraint WHERE conname IN ('lane_dep_pkey','lane_dep_no_self_check')`)).rowCount === 0);
  check('(7b3) table lane is unchanged after down: same schema lines, same row count, same rows', JSON.stringify(await describe(['lane'])) === JSON.stringify(lane0)
    && (await count('lane')) === laneRows0 && (await snap()) === laneSnap0, `${await count('lane')} rows`);
  check('(7b4) the whole agentic_os schema equals the 0005 shape after down', JSON.stringify(await describeAll()) === JSON.stringify(all0));

  log('\n## Check (lock): migrate 6 needs no lock on lane or lane_event');
  {
    c2 = new pg.Client({ connectionString: url });
    await c2.connect();
    await c2.query('BEGIN');
    await c2.query('LOCK TABLE agentic_os.lane, agentic_os.lane_event IN ACCESS EXCLUSIVE MODE');
    const r = toolTry('migrate', url, '6');
    log(`migrate while another session holds ACCESS EXCLUSIVE on lane and lane_event: exit ${r.status} after ${r.ms} ms`);
    log(r.out.trim().split('\n').slice(-2).join('\n'));
    await c2.query('ROLLBACK');
    await c2.end(); c2 = null;
    check('(lock1) migrate 6 succeeds at once while lane and lane_event are locked (no foreign key, no lock on them)',
      r.status === 0 && !/lock timeout/i.test(r.out), `exit ${r.status}, ${r.ms} ms incl. node start (time is printed, not a pass condition)`);
    check('(lock2) 0006 re-applies after down and gives the same schema as the first apply', JSON.stringify(await describeAll()) === JSON.stringify(all1));
    check('(lock3) lane rows are unchanged after the round trip', (await snap()) === laneSnap0);
  }
  await c.end(); c = null;

  log('\n## Check (h): create --through 6 builds the post-0006 schema in one step');
  const c6 = JSON.parse(tool('create', '--through', '6'));
  try {
    const x = new pg.Client({ connectionString: c6.url }); await x.connect();
    const t = await x.query(`SELECT (SELECT count(*)::int FROM pg_constraint WHERE conrelid = to_regclass('agentic_os.lane_dep') AND conname IN ('lane_dep_pkey','lane_dep_no_self_check')) AS k,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name='lane_dep') AS cols`);
    check('(h1) create --through 6 has lane_dep with 3 columns and both named constraints', t.rows[0].k === 2 && t.rows[0].cols === 3, `constraints=${t.rows[0].k} columns=${t.rows[0].cols}`);
    await x.end();
  } finally { log(tool('drop', c6.url).trim()); }

  log(`\nSQL files proven: ${SQL_0006.replace(WT + '/', '')}, ${SQL_0006_DOWN.replace(WT + '/', '')}`);
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
