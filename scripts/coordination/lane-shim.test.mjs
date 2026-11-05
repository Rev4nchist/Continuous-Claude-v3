// Tests for the lane CLI shim (.claude/scripts/lane.mjs).
//
// The shim is what model-run text names (`node <home>/.claude/scripts/lane.mjs ...`). It runs the primary checkout's
// scripts/coordination/lane.mjs in this process. Tests live here, not in .claude/scripts, so they do not sync to ~/.claude.
//
// How the shim can fail, one test each:
//   - the primary's lane.mjs is missing: exit 1, and the message names the path it looked for
//   - the primary is off main: ONE stderr WARNING line naming the branch, and the command still runs
//   - the primary is on main, or its .git is not a plain checkout: no warning, no crash
//   - a soft deny (exit 3), a hard failure (exit 1) and a usage error (exit 2) must reach the caller unchanged
//   - arguments reach lane.mjs (it reads process.argv.slice(2))
//   - a printed path with a backslash or a literal `~`
//   - lane.mjs gains an `argv[1]` main check: the in-process import would then run nothing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, '..', '..', '.claude', 'scripts', 'lane.mjs');
const REAL_LANE = join(HERE, 'lane.mjs');

// A stand-in home. Its continuous-claude/scripts/coordination/lane.mjs echoes argv and exits with FAKE_EXIT.
function standIn({ head, lane = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'lane-shim-'));
  const primary = join(home, 'continuous-claude');
  if (lane) {
    mkdirSync(join(primary, 'scripts', 'coordination'), { recursive: true });
    writeFileSync(join(primary, 'scripts', 'coordination', 'lane.mjs'),
      `process.stdout.write('FAKE-LANE ' + JSON.stringify(process.argv.slice(2)) + '\\n');\n`
      + `if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));\n`);
  }
  if (head !== undefined) {
    mkdirSync(join(primary, '.git'), { recursive: true });
    writeFileSync(join(primary, '.git', 'HEAD'), head);
  }
  return home;
}

function run(home, args = [], env = {}) {
  const r = spawnSync(process.execPath, [SHIM, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_USER_HOME: home, FAKE_EXIT: '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const fwd = (p) => p.replace(/\\/g, '/');

test('a missing primary lane.mjs exits 1 and names the path it looked for', () => {
  const home = standIn({ lane: false });
  const r = run(home, ['board']);
  assert.equal(r.code, 1, r.err);
  const want = `${fwd(home)}/continuous-claude/scripts/coordination/lane.mjs`;
  assert.ok(r.err.includes(want), r.err);
  assert.equal(r.out, '');
});

test('off main: exactly one WARNING line names the branch, then the command still runs', () => {
  const home = standIn({ head: 'ref: refs/heads/feat/per-project-lanes-pr2\n' });
  const r = run(home, ['board', '--json']);
  assert.equal(r.code, 0, r.err);
  const warn = r.err.split(/\r?\n/).filter((l) => l.trim());
  assert.equal(warn.length, 1, r.err);
  assert.match(warn[0], /^WARNING: /);
  assert.ok(warn[0].includes('feat/per-project-lanes-pr2'), warn[0]);
  assert.match(warn[0], /not main/);
  assert.match(r.out, /FAKE-LANE \["board","--json"\]/);
});

test('a detached HEAD is off main too: one WARNING, the command runs', () => {
  const home = standIn({ head: '0123456789abcdef0123456789abcdef01234567\n' });
  const r = run(home, ['whoami']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err.split(/\r?\n/).filter((l) => l.trim()).length, 1, r.err);
  assert.match(r.err, /^WARNING: .*detached/);
  assert.match(r.out, /FAKE-LANE/);
});

test('on main there is no warning', () => {
  const home = standIn({ head: 'ref: refs/heads/main\n' });
  const r = run(home, ['next']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.match(r.out, /FAKE-LANE \["next"\]/);
});

test('a primary whose .git is missing (or a file) gives no warning and no crash', () => {
  const none = run(standIn(), ['next']);
  assert.equal(none.code, 0, none.err);
  assert.equal(none.err, '');
  const home = standIn();
  writeFileSync(join(home, 'continuous-claude', '.git'), 'gitdir: /elsewhere\n');
  const file = run(home, ['next']);
  assert.equal(file.code, 0, file.err);
  assert.equal(file.err, '');
});

test('exit codes 1, 2 and 3 from lane.mjs reach the caller (a soft deny is 3)', () => {
  const home = standIn({ head: 'ref: refs/heads/main\n' });
  for (const code of [1, 2, 3]) {
    const r = run(home, ['claim', 'x'], { FAKE_EXIT: String(code) });
    assert.equal(r.code, code, `exit ${code}: ${r.err}`);
    assert.match(r.out, /FAKE-LANE/);
  }
});

test('no printed path has a literal ~ or a backslash', () => {
  const missing = run(standIn({ lane: false }), ['board']);
  const off = run(standIn({ head: 'ref: refs/heads/other\n' }), ['board']);
  for (const text of [missing.err, off.err, off.out]) {
    assert.ok(!text.includes('~'), text);
    assert.ok(!text.includes('\\'), text);
  }
});

test('without CCV3_USER_HOME the shim looks under the real home dir (forward slashes, no ~)', () => {
  const r = spawnSync(process.execPath, [SHIM, 'board'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_USER_HOME: '', USERPROFILE: tmpdir(), HOME: tmpdir() },
  });
  // The temp dir holds no continuous-claude/, so the shim exits 1 and names where it looked.
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`${fwd(tmpdir())}/continuous-claude/scripts/coordination/lane.mjs`), r.stderr);
});

test('pin: the real lane.mjs has no argv[1] main check, so the shim import runs it', () => {
  const src = readFileSync(REAL_LANE, 'utf8');
  assert.doesNotMatch(src, /process\.argv\[1\]/, 'lane.mjs gained an argv[1] check: the in-process import in .claude/scripts/lane.mjs would run nothing');
  assert.doesNotMatch(src, /import\.meta\.url\s*===|isMain/);
});
