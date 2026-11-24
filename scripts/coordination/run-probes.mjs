/**
 * run-probes.mjs: one command for the six coordination probes of the multi-session system (lane coord-test-suite).
 * No shebang and no top-level argv read, on purpose: scripts/checks/cli-smoke.mjs runs every candidate with no arguments, and a
 * bare run of this program makes scratch databases and runs every probe. Run it with `node`.
 *
 *   node scripts/coordination/run-probes.mjs [--only lease,dm-delivery] [--refusal-only] [--help]
 *
 * The probes: lane-race, lease, claim-sql, degradation, session-lifecycle, dm-delivery. The failure modes they cover are in
 * docs/coordination/test-matrix.md.
 *
 * Steps:
 *   1. Refusal check, no database: each probe runs with a URL that names the live database (continuous_claude) on a dead port,
 *      and with a PATH that holds only the node folder, so docker and psql cannot start. A probe must exit 2 with its refusal
 *      line and print no PASS or FAIL. A probe that does anything else fails the run (rule O3.9).
 *   2. For each probe, one scratch database: scratch-db.mjs create --through 6 makes lanes_pr1_<hex>; the url must pass
 *      assertScratchUrl; the probe runs with that url in CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL and OPC_POSTGRES_URL; the
 *      database is dropped in finally. One database for each probe, so no probe sees the rows of another.
 *   3. Exit 0 only when every refusal check and every probe passed and no probe printed a SKIP line. A skipped check passes in
 *      the probe itself (dm-delivery without migration 0004); here it fails.
 *
 * Exit codes: 0 all passed; 1 a probe, a refusal check or a SKIP failed; 2 no scratch database could be made (the
 * environment, not the change: start Postgres with docker compose up -d in docker/).
 * The server comes from scratch-db's own chain: CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL, OPC_POSTGRES_URL. No url holds a
 * password in anything this program prints. Probes that use `docker exec` need the container continuous-claude-postgres.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScratchUrl, maskUrl } from './scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRATCH_DB = path.join(HERE, 'scratch-db.mjs');
const MIN = 60_000;
export const THROUGH = '6';
/** Names the live database on a port where nothing listens: a probe with no guard fails to connect and writes nothing. */
export const DEAD_LIVE = 'postgresql://x:y@127.0.0.1:1/continuous_claude';
const USAGE = 'usage: node scripts/coordination/run-probes.mjs [--only name,name] [--refusal-only]\n'
  + 'Runs lane-race, lease, claim-sql, degradation, session-lifecycle and dm-delivery, each on its own scratch database.\n'
  + 'Exit 0 only when every probe refuses a live url, passes, and prints no SKIP line. No Postgres: exit 2.\n';

export const PROBES = [
  { name: 'lane-race', file: 'lane-race-probe.mjs' },
  { name: 'lease', file: 'lease-probe.mjs' },
  { name: 'claim-sql', file: 'claim-sql-probe.mjs' },
  { name: 'degradation', file: 'degradation-probe.mjs' },
  { name: 'session-lifecycle', file: 'session-lifecycle-probe.mjs' },
  // The probe reads the hook of ~/.claude by default: it must test the hook of this checkout.
  { name: 'dm-delivery', file: 'dm-delivery-probe.mjs', env: { DM_PROBE_HOOK: path.join(REPO, '.claude', 'hooks', 'dist', 'lane-context.mjs') } },
];

/** Hide each url, its password and any other scheme://user:pass@ in text before it is printed. */
export function redact(text, ...urls) {
  let s = String(text ?? '');
  for (const url of urls.filter(Boolean)) {
    s = s.split(url).join(maskUrl(url));
    let pw = '';
    try { pw = decodeURIComponent(new URL(url).password); } catch { /* not a url: nothing more to hide */ }
    if (pw.length >= 3) s = s.split(pw).join('***');
  }
  return s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, (m) => maskUrl(m));
}

const lastLine = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
const spawnOpts = (cwd, env, timeout) => ({ cwd, env, encoding: 'utf8', shell: false, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
const baseUrls = (env) => [env.CONTINUOUS_CLAUDE_DB_URL, env.DATABASE_URL, env.OPC_POSTGRES_URL];

/** The number of lines of probe output that start with SKIP. A probe prints one for a check it could not run. Pure. */
export function countSkips(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => /^\s*SKIP\b/.test(l)).length;
}

/** The environment of the refusal check: the live name on a dead port, no docker, no psql (their folders are not on PATH). Pure. */
export function refusalEnv(base, nodePath = process.execPath) {
  const e = { ...base, CONTINUOUS_CLAUDE_DB_URL: DEAD_LIVE };
  for (const k of ['DATABASE_URL', 'OPC_POSTGRES_URL', 'DOCKER_HOST', 'DOCKER_CONTEXT']) delete e[k];
  // Windows keeps the key as Path: drop every spelling, then give only the node folder.
  for (const k of Object.keys(e)) if (/^path$/i.test(k)) delete e[k];
  e.PATH = path.dirname(nodePath);
  return e;
}

/** Refusal check of one probe. Returns { ok, line }. A probe that does not exit 2 with its refusal line, or prints PASS or FAIL, fails. */
export function checkRefusal(probe, { spawn, env, dir }) {
  const r = spawn(process.execPath, [path.join(dir, probe.file)], spawnOpts(REPO, refusalEnv(env), MIN));
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const refused = r.status === 2 && /refusing to run/.test(r.stderr ?? '') && !/PASS|FAIL/.test(r.stdout ?? '');
  const why = refused ? '' : ` (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${redact(lastLine(text) || 'no output')}`;
  return { ok: refused, line: `${refused ? 'PASS' : 'FAIL'} refusal ${probe.name}${refused ? ': exit 2 on a live url' : `: did not refuse a live url${why}`}` };
}

/** Make a scratch database. Returns { url } or { env: true, line } (no server) or { line }. */
function createScratch({ spawn, env }) {
  const r = spawn(process.execPath, [SCRATCH_DB, 'create', '--through', THROUGH], spawnOpts(REPO, env, 2 * MIN));
  let url = '';
  try { url = String(JSON.parse(lastLine(r.stdout)).url ?? ''); } catch { /* no JSON: create failed */ }
  if (r.status !== 0 || !url) {
    const cause = lastLine(r.stderr) || (r.error ? String(r.error.message) : '') || `create exited ${r.status} with no url`;
    return { env: true, line: `ENV: run-probes needs local Postgres for a scratch database: ${redact(cause, url, ...baseUrls(env)).replace(/\s+/g, ' ')}. Fix: docker compose up -d in docker/.` };
  }
  try { assertScratchUrl(url); } catch (e) { return { line: `FAIL: ${redact(e.message, url, ...baseUrls(env))}; probe not run` }; }
  return { url };
}

/** Drop half. Returns the lines to add (empty when the drop worked). */
function dropScratch({ spawn, env, url }) {
  try {
    const r = spawn(process.execPath, [SCRATCH_DB, 'drop', url], spawnOpts(REPO, env, MIN));
    return r.status === 0 ? [] : [`FAIL: could not drop the scratch database: ${redact(lastLine(r.stderr) || `exit ${r.status}`, url)}`];
  } catch (e) {
    return [`FAIL: could not drop the scratch database: ${redact(e.message, url)}`];
  }
}

/** Run one probe on one scratch database. Returns { ok, lines, env }. env is true when no scratch database could be made. */
export function runProbe(probe, { spawn, env, dir, now = Date.now }) {
  const made = createScratch({ spawn, env });
  if (!made.url) return { ok: false, env: Boolean(made.env), lines: [made.line] };
  const { url } = made;
  const dbName = assertScratchUrl(url); // the name only: it holds no secret, and it lets a log show which database was dropped
  const penv = { ...env, CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url, ...(probe.env ?? {}) };
  const started = now();
  let lines = [];
  let ok = false;
  try {
    const r = spawn(process.execPath, [path.join(dir, probe.file)], spawnOpts(REPO, penv, 5 * MIN));
    const text = `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`;
    const skips = countSkips(text);
    ok = r.status === 0 && skips === 0;
    const secs = ((now() - started) / 1000).toFixed(1);
    const head = `${ok ? 'PASS' : 'FAIL'} ${probe.name} on ${dbName}: exit ${r.status}${r.error ? ` (${r.error.message})` : ''}, ${skips} skip, ${secs} s`;
    const shown = redact(text, url, ...baseUrls(env)).split(/\r?\n/).filter((l) => l.trim());
    lines = ok ? [head, `  ${shown.at(-1) ?? ''}`] : [head, ...shown.slice(-25).map((l) => `  ${l}`)];
  } catch (e) {
    lines = [`FAIL ${probe.name}: ${redact(e.message, url)}`];
  } finally {
    const dropped = dropScratch({ spawn, env, url });
    if (dropped.length) { ok = false; lines = [...lines, ...dropped]; } else lines = [...lines, `  dropped ${dbName}`];
  }
  return { ok, lines, env: false };
}

/**
 * The whole run. Never throws. Returns { code, lines }. `spawn` (spawnSync shape), `env`, `probes` and `dir` are injected so a
 * test needs no database. `only` is a list of probe names, `refusalOnly` stops after step 1.
 */
export function run({ spawn = spawnSync, env = process.env, probes = PROBES, dir = HERE, only = null, refusalOnly = false } = {}) {
  const list = only ? probes.filter((p) => only.includes(p.name)) : probes;
  if (!list.length) return { code: 1, lines: [`FAIL: no probe matches ${only ? only.join(',') : '(none)'}; known: ${probes.map((p) => p.name).join(', ')}`] };
  const lines = [];
  let failed = 0;
  for (const p of list) {
    const r = checkRefusal(p, { spawn, env, dir });
    lines.push(r.line);
    if (!r.ok) failed += 1;
  }
  if (refusalOnly) return { code: failed ? 1 : 0, lines: [...lines, `run-probes: ${list.length - failed} of ${list.length} refusal checks passed`] };
  let envFail = false;
  for (const p of list) {
    const r = runProbe(p, { spawn, env, dir });
    lines.push(...r.lines);
    if (!r.ok) failed += 1;
    if (r.env) { envFail = true; break; }
  }
  lines.push(`run-probes: ${failed} failure(s) in ${list.length} probe(s) (refusal check and run)`);
  return { code: envFail ? 2 : (failed ? 1 : 0), lines };
}

// main reads argv itself, inside the function (see the header: cli-smoke).
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const i = argv.indexOf('--only');
  const only = i !== -1 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
  const r = run({ only, refusalOnly: argv.includes('--refusal-only') });
  for (const line of r.lines) process.stdout.write(`${line}\n`);
  return r.code;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) process.exitCode = main();
