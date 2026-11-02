// Tests for semgrep-ccv3.mjs. Run: node --test scripts/ratchets/semgrep-ccv3.test.mjs
// Docker is never started: the spawn call is injected. The ratchet itself is the real scan-ratchet.mjs run().
//
// Failure modes, and the source change that makes each test fail:
//   SG1a  Docker is not installed (spawn error)        -> the wrapper returns 0 or stays silent on a spawn error
//   SG1b  Docker is installed, the daemon is down      -> the wrapper treats a non-zero exit with a daemon message as a scan failure (exit 2)
//   SG1c  another Docker failure (bad image)            -> every non-zero exit is reported as "start Docker Desktop"
//   SG2   the default image differs from CI             -> edit the digest in the wrapper or in .github/workflows/ccv3-checks.yml
//   SG3   the scan prints something that is not JSON    -> a JSON parse error is treated as zero results
//   SG4   a new finding / a clean scan / drift          -> the ratchet call is dropped, or --changed is not passed on
//   SG5   the scan command                              -> the /rules mount, an exclude or the SEMGREP_IMAGE override is removed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IMAGE as PROVE_IMAGE } from '../checks/prove-check.mjs';
import { DEFAULT_IMAGE, DOCKER_DOWN_MESSAGE, EXCLUDES, dockerArgs, main } from './semgrep-ccv3.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const temp = () => mkdtempSync(path.join(tmpdir(), 'sg-test-'));

function harness({ spawn, baselineCounts = {} }) {
  const dir = temp();
  const baseline = path.join(dir, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ tool: 'semgrep', reason: 'test', total: 0, counts: baselineCounts }));
  const lines = [];
  const calls = [];
  const deps = {
    spawn: (cmd, args) => { calls.push({ cmd, args }); return spawn(cmd, args); },
    log: (s) => lines.push(String(s)),
    env: { DOCKER_BIN: 'docker-test' },
    baseline,
    tmp: () => dir,
  };
  return { deps, lines, calls, dir };
}

const report = (results = [], errors = []) => JSON.stringify({ results, errors });
const finding = (file) => ({ check_id: 'rules.ccv3-graphql-connection-no-pageinfo', path: file, extra: { severity: 'ERROR' } });
const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });

test('SG1a: no Docker binary exits 1 and says to start Docker Desktop', () => {
  const h = harness({ spawn: () => ({ error: Object.assign(new Error('spawn docker-test ENOENT'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' }) });
  assert.equal(main([], h.deps), 1);
  assert.ok(h.lines.some((l) => l.includes('start Docker Desktop') || l.includes('Start Docker Desktop')), h.lines.join('\n'));
  assert.equal(DOCKER_DOWN_MESSAGE.includes('Start Docker Desktop'), true);
});

test('SG1b: Docker installed but the daemon is down exits 1 with the same message', () => {
  const stderr = 'error during connect: Head "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/_ping": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.';
  const h = harness({ spawn: () => ({ status: 1, stdout: '', stderr }) });
  assert.equal(main([], h.deps), 1);
  assert.ok(h.lines.some((l) => l.includes('Start Docker Desktop')), h.lines.join('\n'));
});

test('SG1c: another Docker failure exits 2 and does not blame Docker Desktop', () => {
  const h = harness({ spawn: () => ({ status: 125, stdout: '', stderr: 'Unable to find image locally\nmanifest unknown' }) });
  assert.equal(main([], h.deps), 2);
  assert.ok(!h.lines.some((l) => l.includes('Docker Desktop')), h.lines.join('\n'));
});

test('SG2: the wrapper default image is the digest the CI semgrep job pins, and the proof harness uses it too', () => {
  const yml = readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'ccv3-checks.yml'), 'utf8');
  const m = /SEMGREP_IMAGE:\s*"([^"]+)"/.exec(yml);
  assert.ok(m, 'ccv3-checks.yml has a SEMGREP_IMAGE line');
  assert.equal(DEFAULT_IMAGE, m[1]);
  assert.equal(PROVE_IMAGE, m[1]);
});

test('SG3: scan output that is not JSON exits 2 and never reaches the ratchet', () => {
  const h = harness({ spawn: ok('Scanning 12 files...\nnot json') });
  let ratcheted = false;
  assert.equal(main([], { ...h.deps, ratchet: () => { ratcheted = true; return 0; } }), 2);
  assert.equal(ratcheted, false);
  assert.ok(h.lines.some((l) => /not JSON/.test(l)));
});

test('SG3b: JSON that is not a Semgrep report exits 2 (not a clean pass)', () => {
  const h = harness({ spawn: ok('{"hello":1}') });
  assert.equal(main([], h.deps), 2);
});

test('SG4: a new finding exits 1, a clean scan exits 0, drift in an untouched file exits 0', () => {
  const dirty = harness({ spawn: ok(report([finding('scripts/a.mjs')])) });
  assert.equal(main([], dirty.deps), 1);
  assert.ok(dirty.lines.some((l) => l.startsWith('NEW ')), dirty.lines.join('\n'));

  const clean = harness({ spawn: ok(report()) });
  assert.equal(main([], clean.deps), 0);

  const drift = harness({ spawn: ok(report([finding('scripts/a.mjs')])) });
  const changed = path.join(drift.dir, 'changed.txt');
  writeFileSync(changed, 'scripts/other.mjs\n');
  assert.equal(main(['--changed', changed], drift.deps), 0);
  assert.ok(drift.lines.some((l) => l.startsWith('DRIFT ')), drift.lines.join('\n'));

  const touched = harness({ spawn: ok(report([finding('scripts/a.mjs')])) });
  writeFileSync(path.join(touched.dir, 'changed.txt'), 'scripts/a.mjs\n');
  assert.equal(main(['--changed', path.join(touched.dir, 'changed.txt')], touched.deps), 1);
});

test('SG5: the scan mounts the rules at /rules, excludes the fixtures and the proof cache, and honours SEMGREP_IMAGE', () => {
  const h = harness({ spawn: ok(report()) });
  main([], { ...h.deps, env: { DOCKER_BIN: 'docker-test', SEMGREP_IMAGE: 'img@sha256:test' } });
  const args = h.calls[0].args;
  assert.ok(args.some((a) => a.endsWith(':/rules:ro')), 'rules mount at /rules');
  assert.ok(args.includes('img@sha256:test'), 'image override');
  for (const e of ['scripts/ratchets/semgrep-ccv3', '.claude/cache']) {
    const i = args.indexOf(e);
    assert.ok(i > 0 && args[i - 1] === '--exclude', `--exclude ${e}`);
  }
  assert.deepEqual(dockerArgs({ root: 'R', rulesDir: 'D', image: 'I' }).filter((a, i, all) => all[i - 1] === '--exclude'), EXCLUDES);
});
