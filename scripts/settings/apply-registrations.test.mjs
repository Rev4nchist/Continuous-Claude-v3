// End-to-end tests for scripts/settings/apply-registrations.mjs. Each test runs the real script as a child process
// against a temp repo (a small settings.json.template) and a temp settings file. No test touches ~/.claude.
//
// How the script can fail, one test each:
//   - the dry run (the default) writes the file, or a backup
//   - --apply with no --only writes (the only guard against a blanket rewrite of the live file)
//   - a matcher change adds a second registration of the same hook instead of updating the first
//   - a hook outside --only changes, or a live-only (machine-local) registration is dropped
//   - the live file is changed without a backup, or the backup is not the original bytes
//   - a second --apply is not a no-op
//   - a live group that shares the hook with a hook outside --only is rewritten (that would move the other hook's matcher)
//   - a hook name that is not in the template is silently accepted
//   - the result still differs from render-settings --check (the parent's release gate)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'apply-registrations.mjs');
const RENDER = join(HERE, 'render-settings.mjs');

const hook = (name, timeout = 5) => ({ type: 'command', command: 'node', timeout, args: [`{{CLAUDE_HOME}}/hooks/dist/${name}.mjs`] });
const TEMPLATE = {
  hooks: {
    SessionStart: [{ hooks: [hook('session-register'), hook('lane-context')] }],
    PostToolUse: [
      { matcher: 'Edit|Write|Bash|PowerShell|Task|Agent', hooks: [hook('lane-context')] },
      { matcher: 'Bash|PowerShell', hooks: [hook('other-hook')] },
    ],
    Stop: [{ hooks: [hook('lane-board-stop-gate')] }],
  },
};

function fixture({ live, template = TEMPLATE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-reg-'));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json.template'), JSON.stringify(template, null, 2));
  const rendered = (name) => JSON.parse(JSON.stringify(hook(name)).replace('{{CLAUDE_HOME}}', `${home.replace(/\\/g, '/')}/.claude`));
  const settings = join(home, '.claude', 'settings.json');
  const liveDoc = live ? live(rendered) : defaultLive(rendered);
  writeFileSync(settings, `${JSON.stringify(liveDoc, null, 2)}\n`);
  return { dir, repo, home, settings, backups: join(dir, 'backup'), rendered };
}

// Live = the template minus the Stop group, lane-context on the OLD matcher, other-hook on a different matcher, one machine-local hook.
function defaultLive(r) {
  return {
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      SessionStart: [{ hooks: [r('session-register'), r('lane-context')] }],
      PostToolUse: [
        { matcher: 'Edit|Write|Bash|PowerShell|Task', hooks: [r('lane-context')] },
        { matcher: 'Bash', hooks: [r('other-hook')] },
      ],
      PermissionRequest: [{ hooks: [r('permission-auto-allow')] }],
    },
  };
}

function run(fx, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', fx.repo, '--home', fx.home, '--settings', fx.settings, '--backup-dir', fx.backups, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_MACHINE_PROFILE: '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const live = (fx) => JSON.parse(readFileSync(fx.settings, 'utf8'));
const scripts = (group) => group.hooks.map((h) => h.args[0].replace(/^.*\//, '').replace('.mjs', ''));
const ONLY = ['--only', 'lane-board-stop-gate,lane-context'];

test('the default run is a dry run: it prints every difference and writes nothing', () => {
  const fx = fixture();
  const before = sha(fx.settings);
  const r = run(fx);
  assert.equal(r.code, 0, r.all);
  assert.equal(sha(fx.settings), before, 'the dry run changed the settings file');
  assert.equal(existsSync(fx.backups), false, 'the dry run wrote a backup');
  assert.match(r.out, /dry run/i);
  assert.match(r.out, /lane-board-stop-gate/);
  assert.match(r.out, /Stop/);
  assert.match(r.out, /lane-context/);
  assert.match(r.out, /matcher/);
  assert.match(r.out, /wrote nothing/i);
});

test('a dry run with --only shows the planned actions and still writes nothing', () => {
  const fx = fixture();
  const before = sha(fx.settings);
  const r = run(fx, ONLY);
  assert.equal(r.code, 0, r.all);
  assert.equal(sha(fx.settings), before);
  assert.match(r.out, /add\s+Stop .*lane-board-stop-gate/);
  assert.match(r.out, /update\s+PostToolUse lane-context/);
});

test('--apply without --only refuses and writes nothing', () => {
  const fx = fixture();
  const before = sha(fx.settings);
  const r = run(fx, ['--apply']);
  assert.equal(r.code, 2, r.all);
  assert.match(r.all, /--only/);
  assert.equal(sha(fx.settings), before);
  assert.equal(existsSync(fx.backups), false);
});

test('--apply --only adds the missing Stop group and updates the old matcher in place (one lane-context, not two)', () => {
  const fx = fixture();
  const r = run(fx, ['--apply', ...ONLY]);
  assert.equal(r.code, 0, r.all);
  const doc = live(fx);
  assert.deepEqual(doc.hooks.Stop.map(scripts), [['lane-board-stop-gate']]);
  const post = doc.hooks.PostToolUse;
  const laneGroups = post.filter((g) => scripts(g).includes('lane-context'));
  assert.equal(laneGroups.length, 1, 'lane-context is registered twice on PostToolUse');
  assert.equal(laneGroups[0].matcher, 'Edit|Write|Bash|PowerShell|Task|Agent');
  assert.equal(doc.hooks.SessionStart[0].hooks.length, 2, 'SessionStart group changed');
});

test('a hook outside --only is not touched, a live-only hook is kept and listed as kept, other keys survive', () => {
  const fx = fixture();
  const r = run(fx, ['--apply', ...ONLY]);
  const doc = live(fx);
  const other = doc.hooks.PostToolUse.find((g) => scripts(g).includes('other-hook'));
  assert.equal(other.matcher, 'Bash', 'other-hook is outside --only: its matcher must not change');
  assert.deepEqual(doc.hooks.PermissionRequest.map(scripts), [['permission-auto-allow']]);
  assert.deepEqual(doc.permissions, { allow: ['Bash(ls)'] });
  assert.match(r.out, /kept/i);
  assert.match(r.out, /permission-auto-allow/);
});

test('before writing it copies the original bytes to <backup-dir>/<YYYY-MM-DD-HHMMSS>-settings.json', () => {
  const fx = fixture();
  const original = readFileSync(fx.settings);
  run(fx, ['--apply', ...ONLY]);
  const files = readdirSync(fx.backups);
  assert.equal(files.length, 1, files.join());
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}-\d{6}-settings\.json$/);
  assert.deepEqual(readFileSync(join(fx.backups, files[0])), original);
});

test('a second --apply prints 0 changes, writes no new backup and leaves the file as it is', () => {
  const fx = fixture();
  run(fx, ['--apply', ...ONLY]);
  const once = sha(fx.settings);
  const backups = readdirSync(fx.backups).length;
  const r = run(fx, ['--apply', ...ONLY]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /\b0 changes\b/);
  assert.equal(sha(fx.settings), once);
  assert.equal(readdirSync(fx.backups).length, backups);
});

test('a live group that shares the hook with a hook outside --only is not rewritten: exit 1, nothing written', () => {
  const fx = fixture({
    live: (r) => ({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|Bash|PowerShell|Task', hooks: [r('lane-context'), r('other-hook')] }] } }),
  });
  const before = sha(fx.settings);
  const r = run(fx, ['--apply', '--only', 'lane-context']);
  assert.equal(r.code, 1, r.all);
  assert.match(r.all, /shares a group with other-hook/);
  assert.equal(sha(fx.settings), before);
  assert.equal(existsSync(fx.backups), false);
});

test('a group shared only with hooks that are also in --only, all wanting the same matcher, is updated once in place', () => {
  const shared = { hooks: { PostToolUse: [{ matcher: 'Edit|Task|Agent', hooks: [hook('lane-context'), hook('other-hook')] }] } };
  const fx = fixture({
    template: shared,
    live: (r) => ({ hooks: { PostToolUse: [{ matcher: 'Edit|Task', hooks: [r('lane-context'), r('other-hook')] }] } }),
  });
  const r = run(fx, ['--apply', '--only', 'lane-context,other-hook']);
  assert.equal(r.code, 0, r.all);
  const post = live(fx).hooks.PostToolUse;
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, 'Edit|Task|Agent');
  assert.deepEqual(scripts(post[0]), ['lane-context', 'other-hook']);
});

test('a name that is not a hook in the template is refused (exit 2), so a typo cannot pass as 0 changes', () => {
  const fx = fixture();
  const r = run(fx, ['--apply', '--only', 'lane-contxt']);
  assert.equal(r.code, 2, r.all);
  assert.match(r.all, /lane-contxt/);
});

test('--apply on a missing settings file refuses instead of creating one', () => {
  const fx = fixture();
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', fx.repo, '--home', fx.home, '--settings', join(fx.dir, 'nope.json'), '--apply', ...ONLY], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_MACHINE_PROFILE: '' },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(existsSync(join(fx.dir, 'nope.json')), false);
});

test('after --apply --only, render-settings --check --settings reports no drift for those hooks', () => {
  const fx = fixture({
    // live-only machine-local hook would be drift for --check; give the fixture none so the whole file can reach OK
    live: (r) => ({ hooks: {
      SessionStart: [{ hooks: [r('session-register'), r('lane-context')] }],
      PostToolUse: [{ matcher: 'Edit|Write|Bash|PowerShell|Task', hooks: [r('lane-context')] }, { matcher: 'Bash|PowerShell', hooks: [r('other-hook')] }],
    } }),
  });
  const check = () => spawnSync(process.execPath, [RENDER, '--check', '--repo', fx.repo, '--settings', fx.settings, '--var', `CLAUDE_HOME=${fx.home.replace(/\\/g, '/')}/.claude`], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_MACHINE_PROFILE: '', USERPROFILE: fx.home, HOME: fx.home },
  });
  const before = check();
  assert.equal(before.status, 1, before.stdout);
  assert.match(before.stdout, /render-only .*lane-board-stop-gate/);
  assert.equal(run(fx, ['--apply', ...ONLY]).code, 0);
  const after = check();
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /RESULT: OK/);
});

// The repo that holds the running script can be a linked worktree that land-pr later removes. Without --repo the script must use
// the PRIMARY checkout (<home>/continuous-claude, the path lane.mjs repoPath() gives) for the template and the backup folder.
function withPrimary(fx) {
  const primary = join(fx.home, 'continuous-claude');
  mkdirSync(join(primary, '.claude'), { recursive: true });
  writeFileSync(join(primary, '.claude', 'settings.json.template'), JSON.stringify(TEMPLATE, null, 2));
  return primary;
}
const runNoRepo = (fx, args = []) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--home', fx.home, '--settings', fx.settings, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_MACHINE_PROFILE: '' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
};
const fwd = (p) => p.replace(/\\/g, '/');

test('without --repo it reads the template from the primary checkout and says so, never from the repo that holds the script', () => {
  const fx = fixture();
  const primary = withPrimary(fx);
  const r = runNoRepo(fx, ONLY);
  assert.equal(r.code, 0, r.all);
  assert.ok(r.out.includes(`repo ${fwd(primary)} (primary checkout)`), r.out);
  assert.ok(r.out.includes(`template ${fwd(join(primary, '.claude', 'settings.json.template'))}`), r.out);
  assert.match(r.out, /add\s+Stop .*lane-board-stop-gate/, 'the primary template was not the one read');
});

test('without --repo, --apply writes the backup under the primary checkout, not under the repo that holds the script', () => {
  const fx = fixture();
  const primary = withPrimary(fx);
  const r = runNoRepo(fx, ['--apply', ...ONLY]);
  assert.equal(r.code, 0, r.all);
  const dir = join(primary, '.claude', 'cache', 'backup');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  assert.equal(files.length, 1, `no backup in ${dir}\n${r.all}`);
  assert.ok(r.out.includes(`backup ${fwd(join(dir, files[0]))}`), r.out);
  assert.equal(readFileSync(join(dir, files[0]), 'utf8').includes('lane-board-stop-gate'), false, 'the backup is not the original bytes');
});

test('without --repo and with no primary checkout it refuses (exit 2) and writes nothing, instead of falling back to the script repo', () => {
  const fx = fixture();
  const before = sha(fx.settings);
  const r = runNoRepo(fx, ['--apply', ...ONLY]);
  assert.equal(r.code, 2, r.all);
  assert.match(r.all, /primary checkout/i);
  assert.match(r.all, /--repo/);
  assert.equal(sha(fx.settings), before);
});

test('an explicit --repo still wins over the primary checkout and is named as such', () => {
  const fx = fixture();
  withPrimary(fx);
  const r = run(fx, ONLY);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /\(--repo\)/);
  assert.ok(r.out.includes(`template ${fwd(join(fx.repo, '.claude', 'settings.json.template'))}`), r.out);
});
