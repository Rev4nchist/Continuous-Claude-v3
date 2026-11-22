// land-none-check.mjs, base-code check (card force-high-land-path, Part B; aegis M on PR 669). The check computes the review band with bandOf, and bandOf is
// code of the checkout that runs the land script. A PR that lowers its own bandOf must not decide its own band. baseCodeProblem() compares the files the
// check runs with the same files on the base branch tip, after a fresh fetch, and refuses on any difference.
// Run: node --test scripts/github/land-none-base-code.test.mjs
//
// How the unit can fail, and the test that catches it:
//   the checkout holds band code that the base branch does not (a PR worktree, a branch checkout) and the check goes on -> BC2, BC9
//   the base is a stale local ref or the PR's base.sha, so a base that moved is not seen                                -> BC3
//   a CRLF working copy of a file that equals the base blob is refused (a raw hash fails on CRLF)                       -> BC4
//   a listed file that the base tip lacks is not named                                                                  -> BC5
//   a failed fetch lets the check go on (it must refuse)                                                                -> BC6
//   the list of files is a hand list that misses an import of land-none-check.mjs, or names a file that is gone         -> BC7
//   --warn blocks, or the refusal prints no reason                                                                      -> BC9
//   a fixture run with no --remote touches the network, or a live run skips the check                                  -> BC10, BC11
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lnc from './land-none-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const HEAD = 'a'.repeat(40);

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };

/** A bare remote named `fork` and a checkout of it on main, with the files in `files` committed and pushed. Returns { tmp, remote, checkout, other() }. */
function setup(files) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'land-base-code-'));
  const remote = path.join(tmp, 'remote.git');
  const checkout = path.join(tmp, 'checkout');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) write(checkout, rel, text);
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'remote', 'add', 'fork', remote);
  git(checkout, 'push', '-q', 'fork', 'main');
  // a second clone moves the base branch
  const other = () => {
    const clone = path.join(tmp, 'other');
    if (!existsSync(clone)) git(tmp, 'clone', '-q', remote, clone);
    return clone;
  };
  return { tmp, remote, checkout, other };
}
const FILES = { 'scripts/a.mjs': 'export const a = 1;\n', 'scripts/b.mjs': 'export const b = 2;\n', 'scripts/c.mjs': 'export const c = 3;\n' };
const LIST = ['scripts/a.mjs', 'scripts/b.mjs'];
const check = (env, over = {}) => lnc.baseCodeProblem({ root: env.checkout, baseRef: 'main', remote: 'fork', files: LIST, ...over });

test('BC1: a checkout that holds the base branch code has no problem', () => {
  const env = setup(FILES);
  try { assert.equal(check(env), null); } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC2: a changed band-code file in the checkout is named, and an unlisted changed file is not', () => {
  const env = setup(FILES);
  try {
    write(env.checkout, 'scripts/a.mjs', 'export const a = 99; // the PR head lowers its own band\n');
    write(env.checkout, 'scripts/c.mjs', 'export const c = 4;\n');
    const p = check(env);
    assert.equal(typeof p, 'string');
    assert.ok(p.includes('scripts/a.mjs'), p);
    assert.ok(!p.includes('scripts/b.mjs'), 'an unchanged listed file is not named');
    assert.ok(!p.includes('scripts/c.mjs'), 'an unlisted file is not checked');
    assert.match(p, /fork\/main/);
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC3: the base is the branch tip after a fresh fetch: a base that moved after the checkout was made is seen', () => {
  const env = setup(FILES);
  try {
    const other = env.other();
    write(other, 'scripts/b.mjs', 'export const b = 22; // main moved\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'main moves');
    git(other, 'push', '-q', 'origin', 'main');
    // the checkout still holds the old file; its own fork/main ref is stale until the check fetches
    const p = check(env);
    assert.equal(typeof p, 'string', 'a stale checkout is refused');
    assert.ok(p.includes('scripts/b.mjs'), p);
    // after the checkout takes the new base, the check passes
    git(env.checkout, 'pull', '-q', '--ff-only', 'fork', 'main');
    assert.equal(check(env), null);
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC4: a CRLF working copy that equals the base blob is not a difference (git hash-object --path)', () => {
  const env = setup(FILES);
  try {
    git(env.checkout, 'config', 'core.autocrlf', 'true');
    write(env.checkout, 'scripts/a.mjs', 'export const a = 1;\r\n');
    assert.equal(check(env), null);
    // a real change in a CRLF file is still a difference
    write(env.checkout, 'scripts/a.mjs', 'export const a = 2;\r\n');
    assert.ok(String(check(env)).includes('scripts/a.mjs'));
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC5: a listed file that the base tip lacks, or that the checkout lacks, is named', () => {
  const env = setup(FILES);
  try {
    const p = check(env, { files: [...LIST, 'scripts/new-import.mjs'] });
    assert.ok(String(p).includes('scripts/new-import.mjs'), p);
    rmSync(path.join(env.checkout, 'scripts/b.mjs'));
    assert.ok(String(check(env)).includes('scripts/b.mjs'), 'a file deleted in the checkout');
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC6: a failed fetch is a refusal that says so (never a pass)', () => {
  const env = setup(FILES);
  try {
    const p = check(env, { remote: 'nowhere' });
    assert.equal(typeof p, 'string');
    assert.match(p, /could not fetch/);
    const q = check(env, { baseRef: 'no-such-branch' });
    assert.match(String(q), /could not fetch/);
    // the remote exists as a tracking ref but cannot be reached now: the stale tip must not be used
    git(env.checkout, 'remote', 'set-url', 'fork', path.join(env.tmp, 'gone.git'));
    assert.match(String(check(env)), /could not fetch/, 'an unreachable remote with a stale tracking ref refuses');
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC12: the fetch of the check runs no git hook of the checkout (aegis F1: a PR hook must not run inside the none-pick check)', () => {
  const env = setup(FILES);
  try {
    const hooks = path.join(env.tmp, 'hooks');
    const marker = path.join(env.tmp, 'hook-ran.txt');
    const script = path.join(hooks, 'reference-transaction');
    mkdirSync(hooks);
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 });
    git(env.checkout, 'config', 'core.hooksPath', hooks);
    const moveBase = (text) => {
      const other = env.other();
      write(other, 'scripts/b.mjs', text);
      git(other, 'add', '-A');
      git(other, 'commit', '-q', '-m', 'main moves');
      git(other, 'push', '-q', 'origin', 'main');
    };
    // control: a plain fetch of a moved base runs the hook, so the test can see it
    moveBase('export const b = 21;\n');
    git(env.checkout, 'fetch', '-q', 'fork');
    assert.ok(existsSync(marker), 'control: the reference-transaction hook runs on a plain fetch');
    rmSync(marker);
    // the check fetches a base that moved again: the hook must not run
    moveBase('export const b = 22;\n');
    const p = check(env);
    assert.equal(typeof p, 'string', 'the moved base is still seen');
    assert.ok(!existsSync(marker), 'no hook of the checkout ran during baseCodeProblem');
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC13: the hooks-off setting of the check points at no folder: not at a temp folder that another account can write (aegis, round 2 of PR 673)', () => {
  assert.deepEqual(lnc.HOOKS_OFF_ARGS, ['-c', 'core.hooksPath=/dev/null']);
  const value = lnc.HOOKS_OFF_ARGS[1].slice('core.hooksPath='.length);
  const rel = path.relative(os.tmpdir(), path.resolve(value));
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `the hooks path ${value} is under ${os.tmpdir()}`);
});

test('BC14: a reference-transaction hook in the temp folder does not run during baseCodeProblem (the temp folder is no hooks folder)', () => {
  const env = setup(FILES);
  try {
    const tmpHooks = path.join(env.tmp, 'fake-temp');
    const marker = path.join(env.tmp, 'tmp-hook-ran.txt');
    mkdirSync(tmpHooks);
    writeFileSync(path.join(tmpHooks, 'reference-transaction'), `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 });
    const other = env.other();
    write(other, 'scripts/b.mjs', 'export const b = 31;\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'main moves');
    git(other, 'push', '-q', 'origin', 'main');
    const runner = path.join(env.tmp, 'run-check.mjs');
    const checkUrl = new URL('./land-none-check.mjs', import.meta.url).href;
    writeFileSync(runner, [
      `import { baseCodeProblem } from ${JSON.stringify(checkUrl)};`,
      "const p = baseCodeProblem({ root: process.env.CHECK_ROOT, baseRef: 'main', remote: 'fork', files: ['scripts/a.mjs', 'scripts/b.mjs'] });",
      'console.log(typeof p);', '',
    ].join('\n'));
    // the child sees the folder with the hook as its temp folder (os.tmpdir() reads TEMP, TMP and TMPDIR)
    const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: { ...process.env, TEMP: tmpHooks, TMP: tmpHooks, TMPDIR: tmpHooks, CHECK_ROOT: env.checkout } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'string', 'the moved base is seen (the fetch ran)');
    assert.ok(!existsSync(marker), 'a hook in the temp folder ran during baseCodeProblem');
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

/** Repo paths of the static relative imports of a module, transitively (the entry first). */
function importClosure(entry) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.')) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  };
  walk(entry);
  return [...seen].sort();
}

test('BC7: BAND_CODE_FILES is exactly the static import closure of land-none-check.mjs, and each file exists', () => {
  assert.ok(Array.isArray(lnc.BAND_CODE_FILES) && Object.isFrozen(lnc.BAND_CODE_FILES), 'exported and frozen');
  const closure = importClosure('scripts/github/land-none-check.mjs');
  assert.deepEqual([...lnc.BAND_CODE_FILES].sort(), closure, 'a missing import is a hole in the check; a stale entry makes every land refuse');
  for (const rel of lnc.BAND_CODE_FILES) assert.ok(existsSync(path.join(ROOT, rel)), `${rel} exists`);
  // review-status.mjs loads review-router.mjs again by a dynamic import: the same file, so no new entry
  const dynamic = [...readFileSync(path.join(ROOT, 'scripts/github/review-status.mjs'), 'utf8').matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const spec of dynamic.filter((s) => s.startsWith('.'))) {
    const rel = path.posix.normalize(path.posix.join('scripts/github', spec));
    assert.ok(lnc.BAND_CODE_FILES.includes(rel), `the dynamic import ${spec} of review-status.mjs is in the list`);
  }
});

/** A temp checkout that holds a copy of the band-code files, on main, with a bare remote named fork. */
function copyOfCheck() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'land-base-int-'));
  const remote = path.join(tmp, 'remote.git');
  const checkout = path.join(tmp, 'checkout');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  for (const rel of lnc.BAND_CODE_FILES) { mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true }); copyFileSync(path.join(ROOT, rel), path.join(checkout, rel)); }
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'remote', 'add', 'fork', remote);
  git(checkout, 'push', '-q', 'fork', 'main');
  const fixtureFile = path.join(tmp, 'land.json');
  writeFileSync(fixtureFile, JSON.stringify({
    pull: { number: 900, state: 'open', head: { sha: HEAD }, base: { ref: 'main', sha: 'c'.repeat(40) }, labels: [{ name: 'review:none' }], changed_files: 1 },
    files: [{ filename: 'docs/guide.md', additions: 1, deletions: 0 }],
    config: JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8')),
  }));
  const run = (args) => {
    const r = spawnSync(process.execPath, [path.join(checkout, 'scripts/github/land-none-check.mjs'), '900', '--repo', 'o/r', '--head', HEAD, '--fixture', fixtureFile, '--store', path.join(tmp, 'none.json'), ...args], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: tmp } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { tmp, checkout, run };
}

test('BC9: the check run from a checkout whose band code differs from the base refuses (exit 1), names the file, and --warn only warns', () => {
  const env = copyOfCheck();
  try {
    const clean = env.run(['--remote', 'fork']);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /needs no record/);
    appendTo(env.checkout, 'scripts/github/review-router.mjs', '\n// head code that lowers its own band\n');
    const refused = env.run(['--remote', 'fork']);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /^REFUSED/m);
    assert.ok(refused.out.includes('scripts/github/review-router.mjs'), refused.out);
    assert.match(refused.out, /fork\/main/);
    const warned = env.run(['--remote', 'fork', '--warn']);
    assert.equal(warned.code, 0, warned.out);
    assert.match(warned.out, /^WARNING/m);
    assert.ok(warned.out.includes('scripts/github/review-router.mjs'), warned.out);
    // a failed fetch refuses with exit 2 (could not determine), also never a pass
    const broken = env.run(['--remote', 'nowhere']);
    assert.equal(broken.code, 2, broken.out);
    assert.match(broken.out, /could not fetch/);
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});
function appendTo(dir, rel, text) { writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), 'utf8') + text); }

test('BC10: a fixture run with no --remote does not run the base-code check (the other tests of land-none-check.mjs have no remote)', () => {
  const env = copyOfCheck();
  try {
    appendTo(env.checkout, 'scripts/github/review-router.mjs', '\n// differs from the base\n');
    const r = env.run([]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /needs no record/);
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

test('BC11: a live run always checks the base code; a fixture run checks only with --remote', () => {
  assert.equal(lnc.baseCheckWanted(['900', '--repo', 'o/r']), true);
  assert.equal(lnc.baseCheckWanted(['900', '--remote', 'fork']), true);
  assert.equal(lnc.baseCheckWanted(['900', '--fixture', 'f.json']), false);
  assert.equal(lnc.baseCheckWanted(['900', '--fixture', 'f.json', '--remote', 'fork']), true);
});
