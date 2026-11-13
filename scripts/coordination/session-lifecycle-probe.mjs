#!/usr/bin/env node
/**
 * Session lifecycle probe -- does a session ever actually get marked ENDED, and
 * does a RESUMED session come back?
 *
 * WHY A PROBE AND NOT A UNIT TEST
 * -------------------------------
 * Every load-bearing rule in this change is expressed in SQL, not in TypeScript:
 * the end is recorded by an UPDATE, and "ended" is a RELATIVE predicate evaluated
 * at read time (`ended_at >= GREATEST(last_heartbeat, last_activity_at)`). A
 * mocked test of the surrounding function would assert that a fake client was
 * called with a string, which is a test of the mock. Nothing in the hooks suite
 * touches Postgres today, so there was no pattern to inherit either.
 *
 * This follows the precedent already set by load-probe.mjs in this directory:
 * exercise the REAL hook bundle against the REAL database, and set up and tear
 * down through `docker exec psql` rather than through the transport under test,
 * so the harness stays honest about what it is measuring.
 *
 * WHAT IT PROVES
 * --------------
 *   1. LIVE       a registered session with a fresh heartbeat reads not-ended
 *   2. ENDED      running the real SessionEnd hook records ended_at AND the
 *                 reason string Claude Code supplied
 *   3. RESUMED    a later heartbeat un-ends it, with NO clearing write anywhere
 *                 -- this is the regression that a naive `ended_at IS NOT NULL`
 *                 test would introduce, and it would hide a working session
 *   4. UPDATE-ONLY  ending an id that never registered affects 0 rows and creates
 *                 nothing -- the hook must never invent a session row, because
 *                 that is how a second opinion about project spelling gets in
 *   5. INDEXED    the dashboard's liveness query plans as an Index Scan on
 *                 sessions_last_signal_idx, not a Seq Scan
 *
 * SAFETY
 * ------
 * It writes exactly one synthetic row, id `probe-lifecycle-<pid>-<n>`, and
 * deletes it in a finally block. It also sweeps any `probe-lifecycle-%` rows left
 * behind by a killed earlier run, before and after. It never touches a row it did
 * not create, and its ids cannot collide with Claude Code sessions (UUID) or the
 * legacy coordination rows (`s-`).
 *
 * Usage:
 *   node scripts/coordination/session-lifecycle-probe.mjs
 *     [--hook <path/to/coordination-release.mjs>]   default: .claude/hooks/dist/
 *     [--container <name>]                          default: continuous-claude-postgres
 *     [--db-url <postgres url>]                     run through the pg module against this
 *                                                   database instead of docker exec. The
 *                                                   hook gets the same URL in its env.
 *                                                   Use it with a scratch database
 *                                                   (scratch-db.mjs create). With no flag the
 *                                                   probe uses docker exec on the scratch
 *                                                   database named by the env URL; a URL that
 *                                                   is not a scratch name refuses, exit 2.
 *
 * Exit codes: 0 all checks passed | 1 a check failed | 2 usage/environment error
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, dbNameOf, maskUrl } from './scratch-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CONTAINER = arg('container', 'continuous-claude-postgres');
const DB_URL = arg('db-url', null);
// Rule O3.9: this probe writes, so it runs on a scratch database only. --db-url first, then the env chain; no URL refuses.
// The docker exec path (no --db-url) sends SQL to the scratch name that assertScratchUrl returns, never to continuous_claude.
const TARGET_URL = DB_URL || process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
let DB_NAME;
try { DB_NAME = assertScratchUrl(TARGET_URL); } catch {
  process.stderr.write(`session-lifecycle-probe: refusing to run: database '${dbNameOf(TARGET_URL) || '(no name)'}' is not a scratch database. `
    + "Pass --db-url or set CONTINUOUS_CLAUDE_DB_URL to one made by 'node scripts/coordination/scratch-db.mjs create --through 6' (name starts with lanes_pr1_).\n");
  process.exit(2);
}
const HOOK = resolve(arg('hook', join(REPO, '.claude', 'hooks', 'dist', 'coordination-release.mjs')));
const PROBE_ID = `probe-lifecycle-${process.pid}-1`;
const ABSENT_ID = `probe-lifecycle-${process.pid}-absent`;
const REASON = 'probe_exit_reason';

/** The one connection of a --db-url run. */
let pgClient = null;

/** The text psql -At -F '|' prints: cells joined by '|', rows by newlines, booleans as t/f, NULL as ''. */
function psqlText(result) {
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 't' : 'f') : String(v));
  return result.rows.map((r) => r.map(cell).join('|')).join('\n');
}

/** Run SQL and return the text psql would print: through the pg module with --db-url, else docker exec psql. */
async function psql(sql) {
  if (DB_URL) {
    const r = await pgClient.query({ text: sql, rowMode: 'array' });
    return psqlText(Array.isArray(r) ? r.at(-1) : r); // several statements: psql prints the last result only
  }
  return dockerPsql(sql);
}

/** Run SQL through docker exec psql, unaligned and tuple-only. Returns stdout. */
function dockerPsql(sql) {
  const res = spawnSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'claude', '-d', DB_NAME, '-At', '-F', '|', '-c', sql],
    { encoding: 'utf-8' },
  );
  if (res.error) throw new Error(`docker exec failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`psql exited ${res.status}: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

/**
 * The app's own definition, copied from
 * apps/agentic-os/src/server/queries/sessions.ts. If these two ever disagree the
 * probe is worthless, so it is quoted here in full rather than approximated.
 */
async function readState(id) {
  const row = await psql(`
    SELECT
      (ended_at IS NOT NULL
        AND ended_at >= GREATEST(last_heartbeat, last_activity_at)) AS is_ended,
      coalesce(end_reason, ''),
      (ended_at IS NOT NULL) AS has_ended_at,
      (GREATEST(last_heartbeat, last_activity_at, ended_at)
        > (now() AT TIME ZONE 'UTC') - make_interval(mins => 15)) AS in_window
    FROM public.sessions WHERE id = '${id}'
  `);
  if (!row) return null;
  const [isEnded, endReason, hasEndedAt, inWindow] = row.split('|');
  return {
    isEnded: isEnded === 't',
    endReason,
    hasEndedAt: hasEndedAt === 't',
    inWindow: inWindow === 't',
  };
}

/** Run the REAL SessionEnd hook bundle with a payload on stdin. */
function runHook(sessionId) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'SessionEnd',
      reason: REASON,
      cwd: REPO,
    }),
    encoding: 'utf-8',
    timeout: 30_000,
    // The hook resolves its own database from env. It must be the same scratch database, on both paths.
    env: { ...process.env, CONTINUOUS_CLAUDE_DB_URL: TARGET_URL, DATABASE_URL: TARGET_URL, OPC_POSTGRES_URL: TARGET_URL },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function sweep() {
  await psql(`DELETE FROM public.sessions WHERE id LIKE 'probe-lifecycle-%'`);
}

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function main() {
  if (!existsSync(HOOK)) {
    console.error(`Hook bundle not found: ${HOOK}\nBuild it first: cd .claude/hooks && npm run build`);
    process.exit(2);
  }

  console.log('session lifecycle probe');
  console.log(`  hook      ${HOOK}`);
  console.log(DB_URL ? `  database  ${maskUrl(DB_URL)} (pg module)` : `  container ${CONTAINER}`);
  console.log(`  probe id  ${PROBE_ID}\n`);

  try {
    if (DB_URL) {
      // `pg` lives in the hooks bundle or apps/agentic-os of this checkout or the primary (scripts/lib/resolve-deps.mjs).
      const { Client } = requireDep('pg', { repoRoot: REPO });
      pgClient = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 5000 });
      await pgClient.connect();
    }
    await psql('SELECT 1');
  } catch (err) {
    console.error(`Cannot reach Postgres: ${err.message}`);
    process.exit(2);
  }

  // Schema gate first. Without it every later check fails for the wrong reason
  // and the operator goes looking at the hook instead of the migration.
  const cols = await psql(`
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sessions'
       AND column_name IN ('ended_at', 'end_reason')
  `);
  if (cols !== '2') {
    console.error(
      `\npublic.sessions is missing ended_at/end_reason (found ${cols} of 2).\n` +
      `Apply scripts/coordination/migrations/003-sessions-lifecycle.sql first.`,
    );
    process.exit(2);
  }

  try {
    await sweep();

    // --- 1. LIVE -----------------------------------------------------------
    await psql(`
      INSERT INTO public.sessions (id, project, working_on, started_at, last_heartbeat)
      VALUES ('${PROBE_ID}', '${REPO.replace(/\\/g, '/')}', 'session lifecycle probe',
              NOW(), NOW())
    `);
    const live = await readState(PROBE_ID);
    check('1 LIVE      registered session reads not-ended',
      live !== null && live.isEnded === false && live.inWindow === true,
      live === null ? 'row missing' : `is_ended=${live.isEnded} in_window=${live.inWindow}`);

    // --- 2. ENDED ----------------------------------------------------------
    const ran = runHook(PROBE_ID);
    const ended = await readState(PROBE_ID);
    check('2 ENDED     real SessionEnd hook records the end',
      ran.status === 0 && ended !== null && ended.isEnded === true,
      `hook exit=${ran.status} is_ended=${ended?.isEnded}`);
    check('2b REASON   Claude Code reason string stored verbatim',
      ended?.endReason === REASON,
      `end_reason=${JSON.stringify(ended?.endReason ?? null)}`);
    check('2c WINDOW   an ended session stays visible in the window',
      ended?.inWindow === true,
      `in_window=${ended?.inWindow}`);

    // --- 3. RESUMED --------------------------------------------------------
    // What heartbeat.ts does on the next UserPromptSubmit after `claude --resume`.
    // Note it does NOT clear ended_at -- that is the whole point of the relative
    // predicate. If this check fails, someone made "ended" absolute.
    await psql(`UPDATE public.sessions SET last_heartbeat = NOW() WHERE id = '${PROBE_ID}'`);
    const resumed = await readState(PROBE_ID);
    check('3 RESUMED   a later heartbeat un-ends it with no clearing write',
      resumed?.isEnded === false && resumed?.hasEndedAt === true,
      `is_ended=${resumed?.isEnded} ended_at still set=${resumed?.hasEndedAt}`);

    // --- 4. UPDATE-ONLY ----------------------------------------------------
    const absentRan = runHook(ABSENT_ID);
    const absent = await psql(`SELECT count(*) FROM public.sessions WHERE id = '${ABSENT_ID}'`);
    check('4 UPDATE    ending an unregistered id creates nothing',
      absentRan.status === 0 && absent === '0',
      `hook exit=${absentRan.status} rows=${absent}`);

    // --- 5. INDEXED --------------------------------------------------------
    // A scratch table has a few rows, so the planner prefers Seq Scan + Sort there. With seq scans off it still picks
    // sessions_last_signal_idx only when the index exists and matches the GREATEST expression: the check proves the
    // index is usable, not that a big table prefers it. One psql call (docker exec runs each call in a new session);
    // on the --db-url path the client is one session, so the setting is reset after.
    const plan = await psql(`
      SET enable_seqscan = off;
      EXPLAIN SELECT s.id FROM public.sessions s
       WHERE s.id NOT LIKE 's-%' AND s.last_heartbeat IS NOT NULL
         AND GREATEST(s.last_heartbeat, s.last_activity_at, s.ended_at)
             > (now() AT TIME ZONE 'UTC') - make_interval(mins => 15)
       ORDER BY GREATEST(s.last_heartbeat, s.last_activity_at, s.ended_at) DESC
       LIMIT 51
    `);
    if (DB_URL) await psql('RESET enable_seqscan');
    check('5 INDEXED   liveness query plans as an Index Scan',
      plan.includes('sessions_last_signal_idx') && !plan.includes('Seq Scan'),
      plan.split('\n')[1]?.trim() ?? plan.split('\n')[0]?.trim());
  } finally {
    // Always, on every path. A probe row left behind would appear on the live
    // dashboard as an unmapped session for fifteen minutes.
    try {
      await sweep();
    } catch (err) {
      console.error(`\nWARNING: cleanup failed, remove by hand: ${err.message}`);
      console.error(`  DELETE FROM public.sessions WHERE id LIKE 'probe-lifecycle-%';`);
    }
    await pgClient?.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nprobe aborted: ${err.stack || err.message}`);
  console.error(`Check for leftovers: SELECT id FROM public.sessions WHERE id LIKE 'probe-lifecycle-%';`);
  process.exit(2);
});
