#!/usr/bin/env node
/**
 * e2e-headless.mjs - End-to-end check of the ccv3-mods plugin in a real `claude -p` run.
 *
 * Run 1 (mod on): the prompt makes TaskCreate and TaskUpdate calls. The mod must write
 *   ~/.claude/state/agentic-os/<session_id>.json with both tasks and the first one completed,
 *   and `lanes: null` (a headless run never reads the lane board). The debug log must show
 *   exactly one ccv3-mods plugin loaded, the one under test: a second copy (say the active
 *   copy from CLAUDE_CODE_PLUGIN_DIRS) would drop one of the two by name and could hide a regression.
 * Run 2 (CCV3_MODS_OFF=1): the same prompt. The mod must write no snapshot.
 * Run 3 (ledger): a TaskCreate, then one Agent call to the repo's `scout` agent. The snapshot must carry
 *   that run in `agentRuns` (Agent Ledger): type scout, a Sonnet model, tokens counted from its turn.step
 *   requests, settled done, the spec read from .claude/agents/scout.md, and no drift.
 *
 * Usage: node scripts/mods/e2e-headless.mjs [plugin-dir] [--date YYYY-MM-DD]
 * Saves under .claude/cache/e2e/<date>-mods-headless-*.json (gitignored).
 * Removes the two snapshots it caused, so test sessions stay out of the dashboard's folder.
 * Exit code: 1 when any check fails. ASCII only, node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

const debugPath = label => join(outDir, `${date}-mods-headless-${label}-debug.log`);
const snapshotPath = id => join(homedir(), '.claude', 'state', 'agentic-os', `${id}.json`);

const LEDGER_PROMPT =
  "First use the TaskCreate tool with subject 'gamma' and description 'ledger'. Then use the Agent tool once with " +
  "subagent_type 'scout', description 'say ok', and prompt 'Reply with the single word ok. Use no tools.' " +
  'Then reply with the single word done.';

/** One headless run. The off run sets CCV3_MODS_OFF=1; the on run clears it. */
const run = (label, off, prompt = PROMPT, tools = ['TaskCreate', 'TaskUpdate']) => {
  const env = { ...process.env };
  // The run tests the copy named by --plugin-dir. The user's env must not add a second ccv3-mods.
  delete env.CLAUDE_CODE_PLUGIN_DIRS;
  // Run from inside a session, the child inherits its id and every run reports (and snapshots under) the
  // parent's session. Each run gets its own.
  const parentId = env.CLAUDE_CODE_SESSION_ID ?? null;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  const sessionId = randomUUID();
  if (off) env.CCV3_MODS_OFF = '1';
  else delete env.CCV3_MODS_OFF;
  writeFileSync(debugPath(label), ''); // --debug-file appends; a stale log would add load lines
  const started = Date.now();
  const ran = spawnSync(
    'claude',
    ['-p', prompt, '--session-id', sessionId, '--plugin-dir', pluginDir, '--allowedTools', ...tools, '--output-format', 'json', '--effort', 'high', '--max-budget-usd', '1', '--debug-file', debugPath(label)],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 300_000 },
  );
  writeFileSync(join(outDir, `${date}-mods-headless-${label}.json`), ran.stdout ?? '');
  let result = null;
  try {
    result = JSON.parse(ran.stdout);
  } catch {
    // reported below as a failed check
  }
  return { label, sessionId, parentId, status: ran.status, seconds: Math.round((Date.now() - started) / 1000), result, stderr: ran.stderr ?? '' };
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
  check('on: headless read no lane board', snap.lanes === null, `lanes ${JSON.stringify(snap.lanes)}`);
  rmSync(onFile);
}

const norm = text => text.replace(/\\/g, '/').toLowerCase();
const loads = existsSync(debugPath('on'))
  ? readFileSync(debugPath('on'), 'utf8')
      .split(/\r?\n/)
      .filter(line => /Read hooks\.json for plugin ccv3-mods/.test(line))
  : [];
// The engine may read the same hooks.json more than once per run; two different folders is the clash.
const folders = [...new Set(loads.map(line => norm(line.slice(line.lastIndexOf('): ') + 3))))];
check(
  'on: only the plugin under test loaded as ccv3-mods',
  folders.length === 1 && folders[0].startsWith(norm(pluginDir)),
  `${folders.length} folder(s) from ${loads.length} read(s)`,
);

const off = run('off', true);
const offId = off.result?.session_id;
check('off: claude exited 0 with a JSON result', off.status === 0 && Boolean(offId), `exit ${off.status}, ${off.seconds}s, session ${offId}`);
const offFile = offId ? snapshotPath(offId) : null;
check('off: no snapshot is written', Boolean(offFile) && !existsSync(offFile), offFile ?? 'no session id');
if (offFile && existsSync(offFile)) rmSync(offFile);

const ledger = run('ledger', false, LEDGER_PROMPT, ['TaskCreate', 'Agent']);
const ledgerId = ledger.result?.session_id;
check('ledger: claude exited 0 with a JSON result', ledger.status === 0 && Boolean(ledgerId), `exit ${ledger.status}, ${ledger.seconds}s, session ${ledgerId}`);
const ledgerFile = ledgerId ? snapshotPath(ledgerId) : null;
if (ledgerFile && existsSync(ledgerFile)) {
  copyFileSync(ledgerFile, join(outDir, `${date}-mods-headless-ledger-snapshot.json`));
  const runs = JSON.parse(readFileSync(ledgerFile, 'utf8')).agentRuns ?? [];
  const scout = runs.find(r => r.type === 'scout');
  check('ledger: the scout run is in agentRuns', Boolean(scout), `${runs.length} run(s)`);
  if (scout) {
    check('ledger: run model is Sonnet', /sonnet/i.test(scout.model ?? ''), String(scout.model));
    check('ledger: tokens counted from its requests', scout.tokens > 0, `${scout.tokens} tokens, ~$${(scout.costUsd ?? 0).toFixed(4)}`);
    check('ledger: run settled done', scout.status === 'done', String(scout.status));
    check('ledger: spec read from scout.md', scout.spec?.model === 'sonnet' && scout.spec?.effort === 'high', JSON.stringify(scout.spec));
    check('ledger: no drift on a scout run', scout.drift === null, String(scout.drift));
  }
  rmSync(ledgerFile);
} else check('ledger: a snapshot named by session_id exists', false, ledgerFile ?? 'no session id');

const ids = [on, off, ledger].map(r => r.result?.session_id);
check(
  'each run had its own session (not the parent, not shared)',
  ids.every((id, i) => id === [on, off, ledger][i].sessionId && id !== on.parentId) && new Set(ids).size === 3,
  ids.join(', '),
);

const failed = checks.filter(c => !c.ok).length;
console.log(`mods e2e-headless: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
