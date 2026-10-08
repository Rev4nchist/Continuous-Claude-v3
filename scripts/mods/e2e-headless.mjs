#!/usr/bin/env node
/**
 * e2e-headless.mjs - End-to-end check of the ccv3-mods plugin in a real `claude -p` run.
 *
 * Run 1 (mod on): the prompt makes TaskCreate and TaskUpdate calls. The mod must write
 *   ~/.claude/state/agentic-os/<session_id>.json with both tasks and the first one completed.
 * Run 2 (CCV3_MODS_OFF=1): the same prompt. The mod must write no snapshot.
 *
 * Usage: node scripts/mods/e2e-headless.mjs [plugin-dir] [--date YYYY-MM-DD]
 * Saves under .claude/cache/e2e/<date>-mods-headless-*.json (gitignored).
 * Removes the two snapshots it caused, so test sessions stay out of the dashboard's folder.
 * Exit code: 1 when any check fails. ASCII only, node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const dateAt = argv.indexOf('--date');
const date = dateAt >= 0 ? argv[dateAt + 1] : new Date().toISOString().slice(0, 10);
const pluginDir = resolve(argv.find((a, i) => !a.startsWith('--') && i !== dateAt + 1) ?? join(repoRoot, '.claude/plugins/ccv3-mods'));
const outDir = join(repoRoot, '.claude/cache/e2e');
mkdirSync(outDir, { recursive: true });

const PROMPT =
  "Use the TaskCreate tool twice: first with subject 'alpha' and description 'first', then with subject " +
  "'beta' and description 'second'. Then use TaskUpdate to set task 1 to completed. Then reply with the single word done.";

const snapshotPath = id => join(homedir(), '.claude', 'state', 'agentic-os', `${id}.json`);

/** One headless run. The off run sets CCV3_MODS_OFF=1; the on run clears it. */
const run = (label, off) => {
  const env = { ...process.env };
  if (off) env.CCV3_MODS_OFF = '1';
  else delete env.CCV3_MODS_OFF;
  const started = Date.now();
  const ran = spawnSync(
    'claude',
    ['-p', PROMPT, '--plugin-dir', pluginDir, '--allowedTools', 'TaskCreate', 'TaskUpdate', '--output-format', 'json', '--effort', 'high', '--max-budget-usd', '1'],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 300_000 },
  );
  writeFileSync(join(outDir, `${date}-mods-headless-${label}.json`), ran.stdout ?? '');
  let result = null;
  try {
    result = JSON.parse(ran.stdout);
  } catch {
    // reported below as a failed check
  }
  return { label, status: ran.status, seconds: Math.round((Date.now() - started) / 1000), result, stderr: ran.stderr ?? '' };
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};

const on = run('on', false);
const onId = on.result?.session_id;
check('on: claude exited 0 with a JSON result', on.status === 0 && Boolean(onId), `exit ${on.status}, ${on.seconds}s, session ${onId}`);
const onFile = onId ? snapshotPath(onId) : null;
check('on: a snapshot named by session_id exists', Boolean(onFile) && existsSync(onFile), onFile ?? 'no session id');
if (onFile && existsSync(onFile)) {
  copyFileSync(onFile, join(outDir, `${date}-mods-headless-on-snapshot.json`));
  const snap = JSON.parse(readFileSync(onFile, 'utf8'));
  const subjects = (snap.tasks ?? []).map(t => `${t.subject}:${t.status}`);
  check('on: snapshot holds both tasks, alpha completed', subjects.join(',') === 'alpha:completed,beta:pending', subjects.join(','));
  check('on: snapshot sessionId matches the run', snap.sessionId === onId);
  rmSync(onFile);
}

const off = run('off', true);
const offId = off.result?.session_id;
check('off: claude exited 0 with a JSON result', off.status === 0 && Boolean(offId), `exit ${off.status}, ${off.seconds}s, session ${offId}`);
const offFile = offId ? snapshotPath(offId) : null;
check('off: no snapshot is written', Boolean(offFile) && !existsSync(offFile), offFile ?? 'no session id');
if (offFile && existsSync(offFile)) rmSync(offFile);

const failed = checks.filter(c => !c.ok).length;
console.log(`mods e2e-headless: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
