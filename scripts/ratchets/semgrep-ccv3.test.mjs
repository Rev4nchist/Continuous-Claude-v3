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
//   SG6   the per-file limit                            -> one engine keeps 30 s, the override is not read, a bad override is not refused, the limit in force is not printed
//   SG7   a Timeout error in the report                 -> the TIMEOUT line (file, rule, limit) is gone, or a timeout stops failing the ratchet (a skipped file passes)
//   SG8   a parse error in the report                   -> a parse error is called a TIMEOUT, or stops counting as a scan-error
//   SG9   the --time data                               -> the slowest-file line or the NOTE over half the limit is gone, or a report with no time data throws
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IMAGE as PROVE_IMAGE } from '../checks/prove-check.mjs';
import { DEFAULT_IMAGE, DOCKER_DOWN_MESSAGE, EXCLUDES, dockerArgs, main } from './semgrep-ccv3.mjs';
import * as sg from './semgrep-ccv3.mjs'; // PER_FILE_TIMEOUT_S, opengrepArgs, normaliseOpengrepReport: read as sg.X so a missing export fails one row, not the whole file

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
    findOpengrep: () => null, // these tests cover the Docker path; semgrep-ccv3-opengrep.test.mjs covers opengrep
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

// ---------- card semgrep-timeout-large-files: the per-file limit, and a timeout that says so ----------

const pair = (args, flag) => args[args.indexOf(flag) + 1];
const timeoutError = (file, rule = 'scripts.ratchets.semgrep-ccv3.ccv3-argv-index-as-path') => ({ code: 3, level: 'warn', type: 'Timeout', rule_id: rule, message: `Timeout when running ${rule} on ${file}`, path: file });

test('SG6: both engines run with the per-file limit of 90 s and --time; the env override takes a whole number from 1 to 300; the limit in force is printed', () => {
  assert.equal(sg.PER_FILE_TIMEOUT_S, 90);
  // Docker engine
  const d = harness({ spawn: ok(report()) });
  assert.equal(main([], d.deps), 0);
  assert.equal(pair(d.calls[0].args, '--timeout'), '90', 'docker: the default limit');
  assert.ok(d.calls[0].args.includes('--time'), 'docker: --time is on');
  assert.ok(d.lines.some((l) => l.includes('per-file limit 90 s')), d.lines.join('\n'));
  // opengrep engine
  const o = harness({ spawn: ok(report()) });
  assert.equal(main([], { ...o.deps, findOpengrep: () => 'og-test' }), 0);
  assert.equal(pair(o.calls[0].args, '--timeout'), '90', 'opengrep: the default limit');
  assert.ok(o.calls[0].args.includes('--time'), 'opengrep: --time is on');
  // a valid override reaches both engines and is printed
  for (const value of ['5', '1', '300']) {
    const dv = harness({ spawn: ok(report()) });
    assert.equal(main([], { ...dv.deps, env: { DOCKER_BIN: 'docker-test', CCV3_SEMGREP_TIMEOUT_S: value } }), 0, value);
    assert.equal(pair(dv.calls[0].args, '--timeout'), value, `docker override ${value}`);
    assert.ok(dv.lines.some((l) => l.includes(`per-file limit ${value} s`)), dv.lines.join('\n'));
    const ov = harness({ spawn: ok(report()) });
    assert.equal(main([], { ...ov.deps, env: { CCV3_SEMGREP_TIMEOUT_S: value }, findOpengrep: () => 'og-test' }), 0, value);
    assert.equal(pair(ov.calls[0].args, '--timeout'), value, `opengrep override ${value}`);
  }
  // anything else is refused before any scan: a limit that was silently ignored would hide a typo
  for (const bad of ['0', '301', '5.5', 'abc', '-3', ' 7', '1e2', '90s']) {
    const b = harness({ spawn: ok(report()) });
    assert.equal(main([], { ...b.deps, env: { DOCKER_BIN: 'docker-test', CCV3_SEMGREP_TIMEOUT_S: bad } }), 2, JSON.stringify(bad));
    assert.equal(b.calls.length, 0, `no scan runs with the override ${JSON.stringify(bad)}`);
    assert.ok(b.lines.some((l) => /whole number from 1 to 300/.test(l)), b.lines.join('\n'));
  }
  // an empty override is no override
  const e = harness({ spawn: ok(report()) });
  assert.equal(main([], { ...e.deps, env: { DOCKER_BIN: 'docker-test', CCV3_SEMGREP_TIMEOUT_S: '' } }), 0);
  assert.equal(pair(e.calls[0].args, '--timeout'), '90');
});

test('SG7: a Timeout in the report prints a TIMEOUT line (file, rule, limit) and STILL fails the ratchet; a skipped file never passes', () => {
  const file = 'scripts/github/pre-pr.cases.mjs';
  const h = harness({ spawn: ok(JSON.stringify({ results: [], errors: [timeoutError(file)] })) });
  assert.equal(main([], h.deps), 1, 'a new scan-error fails, as before');
  assert.ok(h.lines.some((l) => l.startsWith('NEW ') && l.includes(`scan-error|${file}`)), h.lines.join('\n'));
  const line = h.lines.find((l) => l.includes('TIMEOUT'));
  assert.ok(line, `a TIMEOUT line: ${h.lines.join('\n')}`);
  assert.ok(line.includes(file) && line.includes('ccv3-argv-index-as-path') && line.includes('90 s'), line);
  assert.match(line, /not a finding of a rule/);
  // the engine may type the error as an array (opengrep): the same line
  const arr = harness({ spawn: ok(JSON.stringify({ results: [], errors: [{ ...timeoutError(file), type: ['Timeout', { x: 1 }] }] })) });
  assert.equal(main([], arr.deps), 1);
  assert.ok(arr.lines.some((l) => l.includes('TIMEOUT') && l.includes(file)), arr.lines.join('\n'));
  // a timeout the baseline already holds exits 0 as before and is still said out loud
  const known = harness({ spawn: ok(JSON.stringify({ results: [], errors: [timeoutError(file)] })), baselineCounts: { [`scan-error|${file}`]: 1 } });
  assert.equal(main([], known.deps), 0);
  assert.ok(known.lines.some((l) => l.includes('TIMEOUT') && l.includes(file)), known.lines.join('\n'));
  // the limit in force is the one printed (an override of 7 shows 7)
  const seven = harness({ spawn: ok(JSON.stringify({ results: [], errors: [timeoutError(file)] })) });
  main([], { ...seven.deps, env: { DOCKER_BIN: 'docker-test', CCV3_SEMGREP_TIMEOUT_S: '7' } });
  assert.ok(seven.lines.some((l) => l.includes('TIMEOUT') && l.includes('7 s')), seven.lines.join('\n'));
});

test('SG8: a parse error is not called a TIMEOUT, and still counts as a scan-error', () => {
  const file = 'scripts/x.mjs';
  const parse = { code: 3, level: 'warn', type: 'PartialParsing', message: 'Syntax error at line 3', path: file };
  const h = harness({ spawn: ok(JSON.stringify({ results: [], errors: [parse] })) });
  assert.equal(main([], h.deps), 1);
  assert.ok(h.lines.some((l) => l.startsWith('NEW ') && l.includes(`scan-error|${file}`)), h.lines.join('\n'));
  assert.ok(!h.lines.some((l) => l.includes('TIMEOUT')), h.lines.join('\n'));
});

test('SG9: the --time data gives one slowest-file line, a NOTE over half the limit, and a report with no time data is fine', () => {
  const targets = (rows) => rows.map(([p, t]) => ({ path: p, num_bytes: 1, run_time: t }));
  // one file listed twice (parse then match): the times add up, and the line names the slowest file
  const slow = harness({ spawn: ok(JSON.stringify({ results: [], errors: [], time: { targets: targets([['scripts/github/pre-pr.cases.mjs', 11.1], ['scripts/github/pre-pr.cases.mjs', 0.01], ['scripts/a.mjs', 2]]) } })) });
  assert.equal(main([], slow.deps), 0);
  const line = slow.lines.find((l) => l.includes('slowest file'));
  assert.ok(line, slow.lines.join('\n'));
  assert.ok(line.includes('scripts/github/pre-pr.cases.mjs') && line.includes('11.1 s') && line.includes('of 90 s'), line);
  assert.ok(!slow.lines.some((l) => l.startsWith('NOTE') && l.includes('half')), 'no NOTE under half the limit');
  // over half the limit: a NOTE that names the file
  const near = harness({ spawn: ok(JSON.stringify({ results: [], errors: [], time: { targets: targets([['scripts/big.mjs', 50]]) } })) });
  assert.equal(main([], near.deps), 0, 'a NOTE never fails the run');
  assert.ok(near.lines.some((l) => l.startsWith('NOTE') && l.includes('scripts/big.mjs') && l.includes('half')), near.lines.join('\n'));
  // no time data at all: no slowest line, no throw
  const none = harness({ spawn: ok(report()) });
  assert.equal(main([], none.deps), 0);
  assert.ok(!none.lines.some((l) => l.includes('slowest file')), none.lines.join('\n'));
  // opengrep prints Windows paths: the time targets are rewritten to forward slashes like the results and the errors
  const norm = sg.normaliseOpengrepReport({ results: [], errors: [], time: { targets: [{ path: 'scripts\\github\\pre-pr.cases.mjs', run_time: 1 }] } });
  assert.equal(norm.time.targets[0].path, 'scripts/github/pre-pr.cases.mjs');
});
