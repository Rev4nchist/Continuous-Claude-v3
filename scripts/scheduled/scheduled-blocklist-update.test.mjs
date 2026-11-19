// End-to-end tests for .claude/scripts/scheduled/scheduled-blocklist-update.ps1, the push race. Each test runs the real
// script the way Task Scheduler runs a .ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -File) against a temp
// bare remote, a "fork" clone (the primary checkout), a racer clone and a stub updater. The stub updater pushes a
// competing commit through the racer while the job is mid-run, so the job's own push meets a remote that moved.
// No test touches the real ~/.claude, the real fork remote or the primary checkout: every run points -RepoPath at the
// fixture, TMP and TEMP at the fixture, and GIT_CONFIG_GLOBAL, GIT_SAFE_LOG and MSYS_EVENT_LOG at fixture files.
//
// How the job can fail, one test each below:
//   F1  race on another file  the push is rejected non-fast-forward and the job exits 1 (the original bug)
//   F2  race on a build input guard source changed upstream: a rebase would leave a stale dist bundle
//   F3  race on the same JSON a different entry upstream: a rebase conflicts, or the re-run drops the racer's entry
//   F4  race with the same change the identical change upstream: a cherry-pick stops on an empty commit
//   F5  a second race         the job gives up after one retry
//   F6  retry cap             the remote moves on every attempt: the job must stop after 3 attempts and say so
//   F7  push fails, no race   a hook rejects the push but the remote did not move: exit 1 at once, no retry
//   F8  force push            any force would rewrite the remote: every racer commit must stay in its history
//   F9  follow-up and clean   local main is not the remote tip, the temp worktree stays, or the node_modules link is followed
//   F10 no race               a regression in the plain path: exit 0, one updater call, one new commit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = resolve(REPO, '.claude', 'scripts', 'scheduled', 'scheduled-blocklist-update.ps1');
const REAL_GIT_SAFE = resolve(REPO, 'scripts', 'git-safe.ps1');
const onWindows = process.platform === 'win32';
const win = { skip: !onWindows };
const SUBJECT = 'chore(security): daily blocklist update [automated]';
const STUB_ENTRY = 'stub-pkg';

// The stub updater. It does what the production one does to its own checkout (resolve the JSON from its own
// location, add an entry), then plays the racer step for this call number: another process pushes to the remote.
const STUB_UPDATER = `
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsonPath = resolve(here, '../.claude/hooks/src/shared/malicious-packages.json');
const counter = process.env.RACE_COUNTER;
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(n));

const obj = JSON.parse(readFileSync(jsonPath, 'utf8'));
obj.npm[process.env.STUB_ENTRY] = { blocked_all: true };
writeFileSync(jsonPath, JSON.stringify(obj, null, 2) + '\\n');

const step = (process.env.RACE_PLAN || 'none').split(',')[n - 1] || 'none';
const racer = process.env.RACER_DIR;
const git = (...a) => {
  const r = spawnSync('git', ['-C', racer, ...a], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { console.error('racer git ' + a.join(' ') + ': ' + r.stdout + r.stderr); process.exit(9); }
  return r.stdout.trim();
};
const build = () => {
  const r = spawnSync('node', ['build.mjs'], { cwd: join(racer, '.claude', 'hooks'), encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { console.error('racer build: ' + r.stderr); process.exit(9); }
};
const racerJson = join(racer, '.claude', 'hooks', 'src', 'shared', 'malicious-packages.json');
const racerSrc = join(racer, '.claude', 'hooks', 'src', 'package-install-guard.ts');
const addPaths = ['.claude/hooks/src', '.claude/hooks/dist'];
if (step !== 'none') {
  git('pull', '--ff-only', '-q');
  if (step === 'other') writeFileSync(join(racer, 'other-' + n + '.txt'), 'race ' + n + '\\n');
  if (step === 'json' || step === 'same') {
    const o = JSON.parse(readFileSync(racerJson, 'utf8'));
    if (step === 'json') o.npm['RACE_' + n] = { blocked_all: true };
    else o.npm[process.env.STUB_ENTRY] = { blocked_all: true };
    writeFileSync(racerJson, JSON.stringify(o, null, 2) + '\\n');
    build();
  }
  if (step === 'src') {
    const lines = readFileSync(racerSrc, 'utf8').split('\\n');
    lines[0] = '// racer source change ' + n;
    writeFileSync(racerSrc, lines.join('\\n'));
    build();
  }
  git('add', '-A', '.');
  git('commit', '-q', '-m', 'racer ' + n + ' (' + step + ')');
  git('push', '-q', 'origin', 'main');
  appendFileSync(process.env.RACER_LOG, git('rev-parse', 'HEAD') + '\\n');
}
console.log('stub updater call ' + n + ', race step ' + step);
`;

// Stand-in for the esbuild bundle: the dist file is a pure function of the guard source and the JSON.
const BUILD_MJS = `
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'src', 'package-install-guard.ts'), 'utf8').split('\\n')[0];
const json = JSON.parse(readFileSync(join(here, 'src', 'shared', 'malicious-packages.json'), 'utf8'));
mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist', 'package-install-guard.mjs'), '// ' + src + '\\nexport default ' + JSON.stringify(json) + '\\n');
// Stand-in for write-build-inputs.mjs: the real manifest hashes the json too (PR 656 follow-up), so a blocklist change changes it.
const jsonText = readFileSync(join(here, 'src', 'shared', 'malicious-packages.json'), 'utf8');
writeFileSync(join(here, 'dist', '.build-inputs.json'), JSON.stringify({ json: createHash('sha256').update(jsonText.replace(/\\r/g, '').trimEnd()).digest('hex') }) + '\\n');
`;

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-blocklist-race-'));
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
  const fx = {
    root, gitconfig,
    remote: join(root, 'remote.git'),
    primary: join(root, 'primary'),
    racer: join(root, 'racer'),
    nm: join(root, 'nm'),
    tmp: join(root, 'tmp'),
    counter: join(root, 'counter.txt'),
    racerLog: join(root, 'racers.txt'),
  };
  mkdirSync(fx.tmp, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig };
  fx.git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return r.stdout.trim();
  };
  fx.git(root, ['init', '-q', '--bare', '-b', 'main', fx.remote]);
  fx.git(root, ['-C', fx.remote, 'config', 'receive.denyNonFastForwards', 'true']);
  fx.git(root, ['init', '-q', '-b', 'main', fx.primary]);
  return fx;
}

function seed(fx) {
  const p = fx.primary;
  mkdirSync(join(p, 'scripts'), { recursive: true });
  copyFileSync(REAL_GIT_SAFE, join(p, 'scripts', 'git-safe.ps1'));
  put(join(p, '.gitignore'), 'node_modules/\n');
  put(join(p, '.claude', 'hooks', 'package.json'), JSON.stringify({ scripts: { build: 'node build.mjs' } }) + '\n');
  put(join(p, '.claude', 'hooks', 'build.mjs'), BUILD_MJS);
  put(join(p, '.claude', 'hooks', 'src', 'package-install-guard.ts'), '// seed source\nexport {};\n');
  put(join(p, '.claude', 'hooks', 'src', 'shared', 'malicious-packages.json'), JSON.stringify({ npm: {}, pypi: {} }, null, 2) + '\n');
  put(join(p, 'scripts', 'update-blocklist.mjs'), STUB_UPDATER);
  const r = spawnSync('node', ['build.mjs'], { cwd: join(p, '.claude', 'hooks'), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  fx.git(p, ['add', '-A']);
  fx.git(p, ['commit', '-q', '-m', 'seed']);
  fx.git(p, ['remote', 'add', 'fork', fx.remote]);
  fx.git(p, ['push', '-q', 'fork', 'main']);
  fx.git(p, ['fetch', '-q', 'fork', 'main']);
  fx.git(fx.root, ['clone', '-q', fx.remote, fx.racer]);
  mkdirSync(join(fx.nm, 'esbuild'), { recursive: true });
  writeFileSync(join(fx.nm, 'esbuild', 'keep.txt'), 'keep\n');
}

function build(plan, { rejectHook = false } = {}) {
  const fx = fixture();
  seed(fx);
  if (rejectHook) {
    put(join(fx.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "pre-receive: rejected on purpose" >&2\nexit 1\n');
  }
  fx.seedSha = fx.git(fx.primary, ['rev-parse', 'HEAD']);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: fx.gitconfig,
    TMP: fx.tmp, TEMP: fx.tmp,
    GIT_SAFE_LOG: join(fx.root, 'msys-crash.jsonl'),
    MSYS_EVENT_LOG: join(fx.root, 'msys-events.jsonl'),
    RACE_PLAN: plan, RACE_COUNTER: fx.counter, RACER_DIR: fx.racer, RACER_LOG: fx.racerLog, STUB_ENTRY,
  };
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-RepoPath', fx.primary, '-Remote', 'fork', '-Branch', 'main', '-NodeModules', fx.nm, '-NoSync'];
  const r = spawnSync('powershell.exe', args, { env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  fx.status = r.status;
  fx.log = (r.stdout ?? '') + (r.stderr ?? '');
  fx.calls = existsSync(fx.counter) ? Number(readFileSync(fx.counter, 'utf8')) : 0;
  fx.racers = existsSync(fx.racerLog) ? readFileSync(fx.racerLog, 'utf8').split('\n').filter(Boolean) : [];
  fx.tip = fx.git(fx.root, ['-C', fx.remote, 'rev-parse', 'main']);
  return fx;
}

const msg = (fx) => `exit ${fx.status}; calls ${fx.calls}; racers ${fx.racers.length}; log:\n${fx.log}`;
const tipFile = (fx, path) => fx.git(fx.root, ['-C', fx.remote, 'show', `main:${path}`]);
const tipJson = (fx) => JSON.parse(tipFile(fx, '.claude/hooks/src/shared/malicious-packages.json'));

function assertRaced(fx, count) {
  assert.equal(fx.racers.length, count, `the stub must play ${count} race(s); ${msg(fx)}`);
}

function assertNoForce(fx) {
  for (const sha of fx.racers) {
    const r = spawnSync('git', ['-C', fx.remote, 'merge-base', '--is-ancestor', sha, fx.tip], { env: { ...process.env, GIT_CONFIG_GLOBAL: fx.gitconfig }, windowsHide: true });
    assert.equal(r.status, 0, `racer commit ${sha} must stay in the remote history (no force push); ${msg(fx)}`);
  }
}

// F9: breaks when local main stays behind (the later sync would skip and exit 2), when the temp worktree stays,
// or when the cleanup follows the node_modules junction and empties the real folder.
function assertFollowedAndClean(fx) {
  assert.equal(fx.git(fx.primary, ['rev-parse', 'refs/heads/main']), fx.tip, `local main must equal the remote tip; ${msg(fx)}`);
  const left = readdirSync(fx.tmp).filter((n) => n.startsWith('blocklist-update-'));
  assert.deepEqual(left, [], `temp worktree and message file must be gone; ${msg(fx)}`);
  assert.ok(existsSync(join(fx.nm, 'esbuild', 'keep.txt')), 'the real node_modules must survive the cleanup');
  assert.equal(fx.git(fx.primary, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'no worktree may stay registered');
}

test('F1 a race on another file: the job rebuilds on the new tip, pushes, and exits 0', win, () => {
  const fx = build('other');
  assert.equal(fx.status, 0, msg(fx));
  assertRaced(fx, 1);
  assertNoForce(fx);
  assert.equal(fx.calls, 2, 'the updater runs again on the new tip');
  assert.ok(tipJson(fx).npm[STUB_ENTRY], 'the job entry must be on the remote');
  assert.equal(fx.git(fx.root, ['-C', fx.remote, 'log', '-1', '--format=%s', 'main']), SUBJECT);
  assertFollowedAndClean(fx);
});

test('F2 a race on guard source: the pushed dist is built from the tip source, not merged text', win, () => {
  const fx = build('src');
  assert.equal(fx.status, 0, msg(fx));
  assertRaced(fx, 1);
  assertNoForce(fx);
  const dist = tipFile(fx, '.claude/hooks/dist/package-install-guard.mjs');
  assert.match(dist, /racer source change 1/, 'the dist must carry the racer source line');
  assert.ok(dist.includes(STUB_ENTRY), 'the dist must carry the job entry');
  const check = join(fx.root, 'tipcheck');
  fx.git(fx.root, ['clone', '-q', fx.remote, check]);
  const r = spawnSync('node', ['build.mjs'], { cwd: join(check, '.claude', 'hooks'), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(check, '.claude', 'hooks', 'dist', 'package-install-guard.mjs'), 'utf8').replace(/\r\n/g, '\n').trim(), dist.replace(/\r\n/g, '\n').trim(), 'the tip dist must equal a fresh build of the tip tree');
  assertFollowedAndClean(fx);
});

test('F3 a race on the same JSON with another entry: both entries reach the remote', win, () => {
  const fx = build('json');
  assert.equal(fx.status, 0, msg(fx));
  assertRaced(fx, 1);
  assertNoForce(fx);
  const npm = tipJson(fx).npm;
  assert.ok(npm.RACE_1, 'the racer entry must stay');
  assert.ok(npm[STUB_ENTRY], 'the job entry must be added');
  assertFollowedAndClean(fx);
});

test('F4 a race with the identical change: no empty commit, exit 0, remote tip is the racer commit', win, () => {
  const fx = build('same');
  assert.equal(fx.status, 0, msg(fx));
  assertRaced(fx, 1);
  assert.equal(fx.tip, fx.racers[0], 'the job adds no commit of its own');
  assert.match(fx.log, /No blocklist changes detected/);
  assert.equal(fx.calls, 2);
  assertFollowedAndClean(fx);
});

test('F5 a second race during the retry: the third attempt pushes', win, () => {
  const fx = build('other,other');
  assert.equal(fx.status, 0, msg(fx));
  assertRaced(fx, 2);
  assertNoForce(fx);
  assert.equal(fx.calls, 3);
  assert.ok(tipJson(fx).npm[STUB_ENTRY]);
  assertFollowedAndClean(fx);
});

test('F6 the remote moves on every attempt: stop after 3 attempts, exit 1, name the cap, no push of ours', win, () => {
  const fx = build('other,other,other');
  assert.equal(fx.status, 1, msg(fx));
  assertRaced(fx, 3);
  assert.equal(fx.calls, 3, 'exactly 3 attempts');
  assert.match(fx.log, /moved on each of 3 attempts/);
  assert.equal(fx.tip, fx.racers[2], 'the remote tip is the last racer commit');
  assertNoForce(fx);
  assert.deepEqual(readdirSync(fx.tmp).filter((n) => n.startsWith('blocklist-update-')), [], 'cleanup runs after a failure');
});

test('F7 a push rejected while the remote did not move: exit 1 at once, one attempt, no retry', win, () => {
  const fx = build('none', { rejectHook: true });
  assert.equal(fx.status, 1, msg(fx));
  assert.equal(fx.calls, 1, 'no retry');
  assert.match(fx.log, /did not move/);
  assert.equal(fx.tip, fx.seedSha, 'the remote is unchanged');
  assert.deepEqual(readdirSync(fx.tmp).filter((n) => n.startsWith('blocklist-update-')), [], 'cleanup runs after a failure');
});

test('F11 the job commit carries the build manifest, which hashes the changed json (else the next session-start check and the CI dist diff go stale)', win, () => {
  const fx = build('none');
  assert.equal(fx.status, 0, msg(fx));
  const manifest = JSON.parse(tipFile(fx, '.claude/hooks/dist/.build-inputs.json'));
  const jsonText = tipFile(fx, '.claude/hooks/src/shared/malicious-packages.json');
  assert.equal(manifest.json, createHash('sha256').update(jsonText.replace(/\r/g, '').trimEnd()).digest('hex'), 'the pushed manifest must hash the pushed json');
});

test('F10 no race: exit 0, one updater call, exactly one new commit', win, () => {
  const fx = build('none');
  assert.equal(fx.status, 0, msg(fx));
  assertRaced(fx, 0);
  assert.equal(fx.calls, 1);
  assert.equal(fx.git(fx.root, ['-C', fx.remote, 'rev-list', '--count', 'main']), '2', 'seed plus one job commit');
  assert.equal(fx.git(fx.root, ['-C', fx.remote, 'log', '-1', '--format=%s', 'main']), SUBJECT);
  assert.ok(tipJson(fx).npm[STUB_ENTRY]);
  assertFollowedAndClean(fx);
});
