// End-to-end tests for scripts/settings/remove-registrations.mjs. Each test runs the real script as a child process
// against a temp settings file and a temp backup folder. No test touches ~/.claude.
//
// How the script can fail, one test each:
//   - the dry run (the default) writes the file or a backup
//   - --apply writes no backup, or the backup is not the original bytes
//   - the hook match is a substring: "git-auto-commit" also removes "git-auto-commit-extra", or a path that only contains the name
//   - a hook that shares a group with other hooks takes the other hooks with it
//   - a group left empty, or an event left empty, stays in the file
//   - other hooks, other keys, or key order change
//   - 0 matches writes a backup or rewrites the file, or exits non-zero
//   - malformed JSON is accepted, or the file is changed
//   - the write is not temp + rename (a temp file is left behind)
//   - --apply twice is not a no-op
//   - a missing --hook is accepted
//   - the command form ("node <path>.mjs") is not matched
// One repo test: the committed template must not register git-auto-commit while its dist file stays (M2 decision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SCRIPT = join(HERE, 'remove-registrations.mjs');

const hook = (name, timeout = 5) => ({ type: 'command', command: 'node', timeout, args: [`/home/.claude/hooks/dist/${name}.mjs`] });
const LIVE = () => ({
  model: 'x',
  permissions: { allow: ['Bash(ls)'] },
  hooks: {
    SessionStart: [{ hooks: [hook('session-register')] }],
    PostToolUse: [
      { matcher: 'Write|Edit', hooks: [hook('prd-roadmap-sync'), hook('git-auto-commit', 10), hook('tree-invalidate')] },
      { matcher: 'Bash', hooks: [hook('git-auto-commit-extra')] },
    ],
    Stop: [{ hooks: [hook('git-auto-commit')] }],
  },
});

function fixture(doc = LIVE(), raw) {
  const dir = mkdtempSync(join(tmpdir(), 'remove-reg-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, raw ?? `${JSON.stringify(doc, null, 2)}\n`);
  return { dir, file, backups: join(dir, 'backup') };
}
function run(fx, args = [], file = fx.file) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--backup-dir', fx.backups, file], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const names = (g) => g.hooks.map((h) => h.args[0].replace(/^.*\//, '').replace('.mjs', ''));
const read = (fx) => JSON.parse(readFileSync(fx.file, 'utf8'));
const backups = (fx) => (existsSync(fx.backups) ? readdirSync(fx.backups) : []);
const HOOK = ['--hook', 'git-auto-commit'];

test('the default run is a dry run: it names each entry and writes nothing', () => {
  const fx = fixture();
  const before = sha(fx.file);
  const r = run(fx, HOOK);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /would remove 2/i);
  assert.match(r.out, /PostToolUse/);
  assert.match(r.out, /Write\|Edit/);
  assert.match(r.out, /Stop/);
  assert.equal(sha(fx.file), before);
  assert.deepEqual(backups(fx), []);
});

test('--apply removes only the exact hook file and keeps the other hooks in a shared group', () => {
  const fx = fixture();
  const r = run(fx, [...HOOK, '--apply']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /removed 2/i);
  const live = read(fx);
  const group = live.hooks.PostToolUse.find((g) => g.matcher === 'Write|Edit');
  assert.deepEqual(names(group), ['prd-roadmap-sync', 'tree-invalidate']);
  // a longer name that contains the target as a prefix is not a match
  assert.deepEqual(names(live.hooks.PostToolUse.find((g) => g.matcher === 'Bash')), ['git-auto-commit-extra']);
});

test('--apply drops a group left empty and an event left empty', () => {
  const fx = fixture();
  run(fx, [...HOOK, '--apply']);
  const live = read(fx);
  assert.equal(live.hooks.Stop, undefined, 'the emptied Stop event must be gone');
  assert.equal(live.hooks.PostToolUse.length, 2, 'the shared group stays, the Bash group stays');
  const only = fixture({ hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [hook('git-auto-commit')] }, { matcher: 'Bash', hooks: [hook('keep')] }] } });
  run(only, [...HOOK, '--apply']);
  assert.deepEqual(read(only).hooks.PostToolUse.map((g) => g.matcher), ['Bash']);
});

test('--apply leaves other keys, other hooks and key order untouched', () => {
  const fx = fixture();
  const before = JSON.parse(readFileSync(fx.file, 'utf8'));
  run(fx, [...HOOK, '--apply']);
  const live = read(fx);
  assert.deepEqual(Object.keys(live), Object.keys(before));
  assert.deepEqual(Object.keys(live.hooks), ['SessionStart', 'PostToolUse']);
  assert.deepEqual(live.permissions, before.permissions);
  assert.deepEqual(live.hooks.SessionStart, before.hooks.SessionStart);
  assert.deepEqual(names(live.hooks.PostToolUse[0]), ['prd-roadmap-sync', 'tree-invalidate']);
  assert.equal(live.hooks.PostToolUse[0].hooks[0].timeout, 5);
});

test('--apply saves a timestamped backup holding the original bytes, and leaves no temp file', () => {
  const fx = fixture();
  const before = sha(fx.file);
  run(fx, [...HOOK, '--apply']);
  const saved = backups(fx);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^\d{4}-\d{2}-\d{2}-\d{6}.*settings\.json$/);
  assert.equal(sha(join(fx.backups, saved[0])), before);
  assert.notEqual(sha(fx.file), before);
  assert.deepEqual(readdirSync(fx.dir).filter((f) => /tmp/i.test(f)), []);
});

test('the command form "node <path>.mjs" is matched by file name too', () => {
  const doc = { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [
    { type: 'command', command: 'node C:/Users/x/.claude/hooks/dist/git-auto-commit.mjs', timeout: 10 },
    { type: 'command', command: 'node C:/Users/x/.claude/hooks/dist/other.mjs' },
  ] }] } };
  const fx = fixture(doc);
  const r = run(fx, [...HOOK, '--apply']);
  assert.equal(r.code, 0, r.all);
  assert.equal(read(fx).hooks.PostToolUse[0].hooks.length, 1);
});

test('0 matches is a no-op: exit 0, no backup, file bytes unchanged', () => {
  const fx = fixture();
  const before = sha(fx.file);
  const r = run(fx, ['--hook', 'not-registered', '--apply']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /0 entries/i);
  assert.equal(sha(fx.file), before);
  assert.deepEqual(backups(fx), []);
});

test('a second --apply is a no-op', () => {
  const fx = fixture();
  run(fx, [...HOOK, '--apply']);
  const after = sha(fx.file);
  const n = backups(fx).length;
  const r = run(fx, [...HOOK, '--apply']);
  assert.equal(r.code, 0, r.all);
  assert.equal(sha(fx.file), after);
  assert.equal(backups(fx).length, n);
});

test('malformed JSON exits non-zero and writes nothing', () => {
  const fx = fixture(null, '{ "hooks": { oops');
  const before = sha(fx.file);
  const r = run(fx, [...HOOK, '--apply']);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /cannot read/);
  assert.equal(sha(fx.file), before);
  assert.deepEqual(backups(fx), []);
});

test('a missing file exits 1 with a "cannot read" message', () => {
  const fx = fixture();
  const r = run(fx, HOOK, join(fx.dir, 'nope.json'));
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /cannot read/);
});

test('a path that only contains the hook name is not a match', () => {
  const doc = { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [
    { type: 'command', command: 'node', args: ['/x/git-auto-commit/other.mjs'] },
    hook('git-auto-commit'),
  ] }] } };
  const fx = fixture(doc);
  run(fx, [...HOOK, '--apply']);
  const left = read(fx).hooks.PostToolUse[0].hooks;
  assert.equal(left.length, 1);
  assert.equal(left[0].args[0], '/x/git-auto-commit/other.mjs');
});

test('an event that was already empty is kept', () => {
  const doc = { hooks: { Notification: [], Stop: [{ hooks: [hook('git-auto-commit')] }, { hooks: [hook('keep')] }] } };
  const fx = fixture(doc);
  run(fx, [...HOOK, '--apply']);
  const live = read(fx);
  assert.deepEqual(live.hooks.Notification, []);
  assert.equal(live.hooks.Stop.length, 1);
});

test('a failed write exits 1, leaves the settings file unchanged and no temp file', () => {
  const fx = fixture();
  const before = sha(fx.file);
  mkdirSync(join(fx.dir, '.settings.json.remove-tmp')); // a directory in the temp name makes the write fail
  const r = run(fx, [...HOOK, '--apply']);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /cannot write/);
  assert.equal(sha(fx.file), before);
});

test('no --hook is refused: exit 2, nothing written', () => {
  const fx = fixture();
  const before = sha(fx.file);
  const r = run(fx, ['--apply']);
  assert.equal(r.code, 2);
  assert.equal(sha(fx.file), before);
});

test('a hook name with a path or extension is refused', () => {
  const fx = fixture();
  const r = run(fx, ['--hook', 'dist/git-auto-commit.mjs', '--apply']);
  assert.equal(r.code, 2);
  assert.deepEqual(backups(fx), []);
});

// M2 decision (Dave, 2026-11-09): git-auto-commit is unregistered on purpose, its source and dist stay.
test('the committed template does not register git-auto-commit while its dist file still exists', () => {
  assert.ok(existsSync(join(REPO, '.claude', 'hooks', 'dist', 'git-auto-commit.mjs')), 'dist must stay (M2 keeps the code)');
  assert.ok(existsSync(join(REPO, '.claude', 'hooks', 'src', 'git-auto-commit.ts')), 'src must stay (M2 keeps the code)');
  const tpl = readFileSync(join(REPO, '.claude', 'settings.json.template'), 'utf8');
  assert.equal(/git-auto-commit\.mjs/.test(tpl), false, 'settings.json.template still registers git-auto-commit.mjs');
});
