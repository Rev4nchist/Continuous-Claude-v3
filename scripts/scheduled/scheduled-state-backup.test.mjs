// End-to-end tests for .claude/scripts/scheduled/scheduled-state-backup.ps1 (card ops-state-backup-nightly). Each test runs the real wrapper the way
// Task Scheduler runs a .ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -File) against a fake repo that holds a fake
// scripts/scheduled/backup-state.mjs. It records its argv and environment keys, prints one stdout and one stderr line, then exits with a chosen code or hangs.
// No test touches the real ~/.claude, the primary checkout, Docker or Notion: every run sets CCV3_STATE_BACKUP_REPO_ROOT and CCV3_STATE_BACKUP_LOG to temp paths.
//
// How the wrapper can fail, one test each below:
//   exit code   the code of the command is swallowed or turned into 0
//   args        --repo <root> is missing (the notes are git-excluded: a worktree has none), or the extra args are lost
//   key strip   ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN reaches the command
//   timeout     a hung command is not killed, or the wrapper exits 0 after the kill
//   log         stdout and stderr of the command do not reach the log; the finish line lacks the exit code
//   missing     a missing script gives a silent 0
//   slot        the 07:40 catch-up reruns a finished night, or a failed night is never retried
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(HERE, '..', '..', '.claude', 'scripts', 'scheduled', 'scheduled-state-backup.ps1');
const win = { skip: process.platform !== 'win32' };
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3 }); });

const FAKE = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.FAKE_CALL_DIR, 'call.json'), JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env), tokenOk: process.env.CCV3_BACKUP_NOTION_TOKEN === process.env.EXPECT_TOKEN, tokenSet: Boolean(process.env.CCV3_BACKUP_NOTION_TOKEN), state: process.env.CCV3_BACKUP_CREDENTIAL_STATE ?? null }));
console.log('fake backup stdout line');
console.error('fake backup stderr line');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

function fixture({ script = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-backup-wrapper-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts', 'scheduled'), { recursive: true });
  mkdirSync(join(root, 'calls'), { recursive: true });
  if (script) writeFileSync(join(repo, 'scripts', 'scheduled', 'backup-state.mjs'), FAKE);
  return { root, repo, calls: join(root, 'calls'), log: join(root, 'logs', '2026-11-25.log') };
}

function run(fx, extraEnv = {}) {
  const env = { ...process.env, CCV3_STATE_BACKUP_REPO_ROOT: fx.repo, CCV3_STATE_BACKUP_LOG: fx.log, FAKE_CALL_DIR: fx.calls, ...extraEnv };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  delete env.PSModulePath; // see cleanEnv below
  const started = Date.now();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER], { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { status: r.status, ms: Date.now() - started, log: existsSync(fx.log) ? readFileSync(fx.log, 'utf8') : '', err: r.stderr ?? '' };
}
const called = (fx) => JSON.parse(readFileSync(join(fx.calls, 'call.json'), 'utf8'));

test('exit code: the code of the command is the code of the wrapper, and the finish line names it', win, () => {
  for (const code of [0, 1, 2]) {
    const r = run(fixture(), { FAKE_EXIT: String(code) });
    assert.equal(r.status, code, r.log);
    assert.match(r.log, new RegExp(`backup finished, exit ${code}\\b`));
  }
});

test('args: the command gets --repo <root>, and the extra args follow it', win, () => {
  const fx = fixture();
  const r = run(fx, { CCV3_STATE_BACKUP_EXTRA_ARGS: '--dry-run --out C:\\tmp\\x' });
  assert.equal(r.status, 0, r.log);
  const argv = called(fx).argv;
  assert.equal(argv[argv.indexOf('--repo') + 1], fx.repo);
  assert.deepEqual(argv.slice(argv.indexOf('--repo') + 2), ['--dry-run', '--out', 'C:\\tmp\\x']);
});

test('key strip: no API key reaches the command', win, () => {
  const fx = fixture();
  const r = run(fx, { ANTHROPIC_API_KEY: 'k-not-real', ANTHROPIC_AUTH_TOKEN: 't-not-real' });
  assert.equal(r.status, 0, r.log);
  const keys = called(fx).envKeys;
  assert.ok(!keys.includes('ANTHROPIC_API_KEY') && !keys.includes('ANTHROPIC_AUTH_TOKEN'), keys.join());
});

test('timeout: a hung command is killed, the wrapper exits 124 and does not wait past the limit', win, () => {
  const r = run(fixture(), { FAKE_HANG: '1', CCV3_STATE_BACKUP_TIMEOUT_SEC: '3' });
  assert.equal(r.status, 124, r.log);
  assert.match(r.log, /TIMEOUT: backup killed/);
  assert.ok(r.ms < 60000, `took ${r.ms} ms`);
});

test('launch: a node that cannot start gives a nonzero exit, a LAUNCH FAILED log line, and no slot marker', win, () => {
  // Breaks when Start-Process errors are not fatal: $rc stays unset and the wrapper exits 0 for a night that never ran.
  const fx = fixture();
  const fakeBin = join(fx.root, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, 'node.exe'), 'this is not a program'); // found on PATH first, but Windows cannot start it
  const path = `${fakeBin};${process.env.PATH ?? process.env.Path ?? ''}`;
  const r = run(fx, { PATH: path, Path: undefined });
  assert.notEqual(r.status, 0, r.log);
  assert.match(r.log, /LAUNCH FAILED/);
  assert.equal(existsSync(join(fx.calls, 'call.json')), false, 'the command did not run');
  const again = run(fx, { FAKE_EXIT: '0' });
  assert.equal(again.status, 0, 'a failed launch leaves the slot open, so the next trigger retries');
  assert.equal(existsSync(join(fx.calls, 'call.json')), true);
});

test('log: stdout and stderr of the command reach the log', win, () => {
  const r = run(fixture());
  assert.match(r.log, /fake backup stdout line/);
  assert.match(r.log, /fake backup stderr line/);
  assert.match(r.log, /backup starting, repo /);
});

test('missing: no backup-state.mjs gives exit 3 and a log line, not a silent 0', win, () => {
  const r = run(fixture({ script: false }));
  assert.equal(r.status, 3, r.log);
  assert.match(r.log, /ERROR: backup-state\.mjs not found/);
});

test('slot: a finished night skips the catch-up run; a failed night is retried', win, () => {
  const ok = fixture();
  assert.equal(run(ok).status, 0);
  unlinkSync(join(ok.calls, 'call.json'));
  const again = run(ok);
  assert.equal(again.status, 0, again.log);
  assert.match(again.log, /skip: slot 03:10/);
  assert.equal(existsSync(join(ok.calls, 'call.json')), false, 'the command must not run twice for one slot');
  const bad = fixture();
  assert.equal(run(bad, { FAKE_EXIT: '1' }).status, 1);
  unlinkSync(join(bad.calls, 'call.json'));
  const retry = run(bad, { FAKE_EXIT: '0' });
  assert.equal(retry.status, 0, retry.log);
  assert.equal(existsSync(join(bad.calls, 'call.json')), true, 'a failed night leaves the slot open');
});

test('row: the real tasks.json row is daily 03:10 with a 07:40 catch-up, no model, hidden, and its script exists', () => {
  const tasks = JSON.parse(readFileSync(resolve(HERE, 'tasks.json'), 'utf8')).tasks;
  const row = tasks.find((t) => t.name === 'CCv3-State-Backup');
  assert.ok(row, 'CCv3-State-Backup is in tasks.json');
  assert.equal(row.trigger, 'daily 03:10');
  assert.equal(row.catchUp, 'daily 07:40');
  assert.equal(row.llm, false, 'no model reads the dump');
  assert.equal(row.battery, true);
  assert.equal(row.hidden, true);
  assert.equal(row.execLimitMin, 15);
  assert.deepEqual(row.allowedExit, [0]);
  assert.equal(row.maxAgeHours, 30);
  assert.ok(existsSync(resolve(HERE, '..', '..', row.script)), row.script);
});

// ---- credential at rest (seat ruling 19:17): the wrapper decrypts a DPAPI file and gives the token to the one child through one env variable ----
const FRESH = 'secret_' + 'y'.repeat(20); // fake, low entropy on purpose (gitleaks)
// Windows PowerShell 5.1 cannot load its Security module when it inherits the PSModulePath of a PowerShell 7 parent: drop it, as Task Scheduler's clean env does.
const cleanEnv = (extra) => { const e = { ...process.env, ...extra }; delete e.PSModulePath; return e; };
const dpapi = (text) => spawnSync('powershell.exe', ['-NoProfile', '-Command', 'ConvertTo-SecureString $env:CCV3_T -AsPlainText -Force | ConvertFrom-SecureString'], { env: cleanEnv({ CCV3_T: text }), encoding: 'utf8', windowsHide: true }).stdout.trim();

function withCred(fx, content, extra = {}) {
  const file = join(fx.root, 'token.txt');
  if (content !== null) writeFileSync(file, content);
  return run(fx, { CCV3_BACKUP_TOKEN_FILE: file, EXPECT_TOKEN: FRESH, ...extra });
}

test('cred: a DPAPI file is decrypted for the child only; the token is not on argv and not in the log', win, () => {
  const fx = fixture();
  const r = withCred(fx, dpapi(FRESH));
  assert.equal(r.status, 0, r.log);
  const call = called(fx);
  assert.equal(call.tokenOk, true, 'the child must get the decrypted token');
  assert.equal(call.state, null);
  assert.ok(!JSON.stringify(call.argv).includes(FRESH));
  assert.ok(!r.log.includes(FRESH) && !r.err.includes(FRESH), 'no token in the log or stderr');
  assert.ok(!r.log.includes(dpapi(FRESH).slice(0, 40)), 'no blob text in the log');
});

test('cred: a plain-text file fails closed: no token for the child, the state not-protected', win, () => {
  const fx = fixture();
  const r = withCred(fx, FRESH);
  assert.equal(r.status, 0, 'the wrapper passes the child exit code through');
  const call = called(fx);
  assert.equal(call.tokenOk, false);
  assert.equal(call.tokenSet, false);
  assert.equal(call.state, 'not-protected');
  assert.ok(!r.log.includes(FRESH) && !r.err.includes(FRESH));
});

test('cred: a DPAPI-shaped file that cannot be decrypted gives the state unreadable and no token', win, () => {
  const fx = fixture();
  const r = withCred(fx, '01000000d08c9ddf0115d1118c7a00c04fc297eb01000000deadbeef');
  const call = called(fx);
  assert.equal(call.state, 'unreadable');
  assert.equal(call.tokenSet, false);
  assert.ok(!r.log.includes(FRESH));
});

test('cred: no credential file means no token, and a token inherited from the environment is dropped', win, () => {
  const fx = fixture();
  withCred(fx, null, { CCV3_BACKUP_NOTION_TOKEN: FRESH });
  const call = called(fx);
  assert.equal(call.tokenSet, false, 'the wrapper owns the credential: an inherited token must not reach the child');
  assert.equal(call.state, null);
});

test('trash: the wrapper never passes --allow-trash on its own', win, () => {
  const fx = fixture();
  run(fx);
  assert.ok(!called(fx).argv.includes('--allow-trash'));
});
