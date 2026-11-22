// Card coord-force-high-followups (P1, seat word 2026-11-22): the follow-ups of the PR 673 reviews (aegis F2, F3, the LOW outside the delta, the critic gaps).
// Run: node --test scripts/github/force-high-followups.test.mjs
//
// How the unit can fail, and the test that catches it:
//   a git hook folder of the checkout is not on FORCE_HIGH_FILES, so a PR that edits it keeps a low band                       -> FH1
//   the new core file of the none check is on no list, so an edit of it escapes the base-code check or the forced band        -> FH2
//   the entry file imports band code before baseCodeProblem runs, so a PR's top-level code runs first (aegis F2)              -> FH3, FH4
//   a bare `git` or `gh` name resolves from the current folder on Windows, so a planted exe runs (aegis LOW)                  -> FH5, FH6
//   the backslash replace of the hooks path runs on Linux and changes a legal file name (critic, round 4)                      -> FH7
//   the hash of the check follows the PR's own .gitattributes, or a CRLF copy fails, or a lone CR passes (D3, seat word)       -> FH8, FH9
//   an upper-case path (DRIZZLE/0009_x.SQL) is a lower class or not a migration (aegis F3)                                      -> FH10, FH11
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lnc from './land-none-check.mjs';
import * as router from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const ENTRY = 'scripts/github/land-none-check.mjs';
const CORE = 'scripts/github/land-none-core.mjs';
const HEAD = 'a'.repeat(40);

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };

// ---------- item 1: .githooks and the core file on the lists ----------

test('FH1: a file under .githooks is HIGH at least (forced), in any case, and a near-miss name is not forced', () => {
  assert.ok(router.FORCE_HIGH_FILES.includes('.githooks/**'), '.githooks/** is on FORCE_HIGH_FILES');
  assert.ok(router.TRUST_BOUNDARY.tap.includes('.githooks/**'), 'and on the tap list (FORCE_HIGH_FILES is a subset of it)');
  for (const p of ['.githooks/pre-commit', '.githooks/post-commit', '.githooks/pre-merge-commit', '.githooks/reference-transaction', '.GITHOOKS/Pre-Commit']) {
    const b = router.bandOf([p], LIVE);
    assert.equal(b.band, 'HIGH', p);
    assert.equal(b.forcedHigh, true, p);
    assert.equal(b.L, false, `${p} forces no CRITICAL`);
    assert.deepEqual(b.forceHighFiles, [p], p);
  }
  for (const p of ['docs/.githooks/pre-commit', '.githooks-old/pre-commit', '.githooksx/pre-commit']) {
    assert.equal(router.bandOf([p], LIVE).forcedHigh, false, p);
  }
});

test('FH2: the core file of the none check is on FORCE_HIGH_FILES, on the tap list, and in the file list of the base-code check', () => {
  assert.ok(existsSync(path.join(ROOT, CORE)), `${CORE} exists`);
  assert.ok(router.FORCE_HIGH_FILES.includes(CORE), 'FORCE_HIGH_FILES');
  assert.ok(router.TRUST_BOUNDARY.tap.includes(CORE), 'TRUST_BOUNDARY.tap');
  assert.ok(lnc.BAND_CODE_FILES.includes(CORE), 'BAND_CODE_FILES');
  const b = router.bandOf([CORE], LIVE);
  assert.deepEqual([b.band, b.forcedHigh], ['HIGH', true]);
});

// ---------- item 2: aegis F2, no band code before the base-code check ----------

test('FH3: the entry file imports only node: built-ins (statically); the band code comes by import() after the check', () => {
  const text = readFileSync(path.join(ROOT, ENTRY), 'utf8');
  const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  assert.ok(specs.length >= 3, `the entry has static imports (${specs.join(', ')})`);
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), [], 'a static import of band code runs its top-level code before baseCodeProblem');
  assert.match(text, /import\(\s*['"]\.\/land-none-core\.mjs['"]\s*\)/, 'the core is loaded by a literal import() (BC7 follows it)');
});

/** A temp checkout with a copy of the band-code files on main, a bare remote named fork, and a fixture for the entry. */
function copyOfCheck() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fh-copy-'));
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
    config: LIVE,
  }));
  const run = (args = ['--remote', 'fork']) => {
    const r = spawnSync(process.execPath, [path.join(checkout, ENTRY), '900', '--repo', 'o/r', '--head', HEAD, '--fixture', fixtureFile, '--store', path.join(tmp, 'none.json'), ...args], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: tmp } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { tmp, checkout, run };
}

test('FH4: top-level code that a PR adds to any file of the check does not run when the base-code check refuses (aegis F2)', () => {
  const env = copyOfCheck();
  try {
    const clean = env.run();
    assert.equal(clean.code, 0, clean.out);
    for (const rel of lnc.BAND_CODE_FILES.filter((f) => f !== ENTRY)) {
      const abs = path.join(env.checkout, rel);
      writeFileSync(abs, `${readFileSync(abs, 'utf8')}\nconsole.log('PLANTED-RAN ${rel}');\n`);
      const r = env.run();
      assert.equal(r.code, 1, `${rel}: ${r.out}`);
      assert.match(r.out, /^REFUSED/m, rel);
      assert.ok(r.out.includes(rel), `${rel} is named in the refusal`);
      assert.ok(!r.out.includes('PLANTED-RAN'), `${rel}: the planted top-level code ran before the base-code check`);
      copyFileSync(path.join(ROOT, rel), abs);
    }
    // a plain, clean run still works after the restores
    assert.equal(env.run().code, 0);
  } finally { rmSync(env.tmp, { recursive: true, force: true }); }
});

// ---------- item 4: bare-name git and gh spawns ----------

const EXE = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

// The entry (git) and the router (makeGh) each hold their own copy of resolveExe: the entry cannot import band code before the base-code check. Each copy is tested.
for (const [owner, mod] of [['land-none-check.mjs', lnc], ['review-router.mjs', router]]) {
  test(`FH5: ${owner} resolveExe finds an executable on an absolute PATH entry only: never the current folder, a relative entry or an empty entry`, () => {
    assert.equal(typeof mod.resolveExe, 'function');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'fh-exe-'));
    try {
      const good = path.join(tmp, 'good');
      const planted = path.join(tmp, 'planted');
      write(good, EXE('git'), 'x');
      write(planted, EXE('git'), 'x');
      const env = (...dirs) => ({ PATH: dirs.join(path.delimiter), Path: dirs.join(path.delimiter) });
      assert.equal(mod.resolveExe('git', { env: env('.', '', 'planted-relative', good) }), path.join(good, EXE('git')));
      assert.equal(mod.resolveExe('git', { env: env('.', '', path.relative(process.cwd(), planted)) }), null, 'only relative entries: no match');
      assert.equal(mod.resolveExe('git', { env: env(path.join(tmp, 'none')) }), null, 'no match');
      for (const bad of ['', '../git', 'a/b', 'git;calc', 'git ']) assert.equal(mod.resolveExe(bad, { env: env(good) }), null, `${JSON.stringify(bad)} is not a plain name`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('FH12: the entry has its own default repo (it cannot import the router), and it equals the router constant', () => {
  const text = readFileSync(path.join(ROOT, ENTRY), 'utf8');
  assert.ok(text.includes(`const DEFAULT_REPO = '${router.DEFAULT_REPO}';`), 'the entry names the same default repo as review-router.mjs');
});

/** A folder with a copy of node.exe named `<name>.exe` and a preload that writes a marker when it runs under that name. */
function plantedExe(name) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fh-plant-'));
  const marker = path.join(tmp, 'planted-ran.txt');
  const preload = path.join(tmp, 'preload.cjs');
  copyFileSync(process.execPath, path.join(tmp, `${name}.exe`));
  writeFileSync(preload, `if (/^${name}\\.exe$/i.test(require('node:path').basename(process.execPath))) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  // NoDefaultCurrentDirectoryInExePath=1 (set on Dave's machine) already keeps the current folder out of the search; the default Windows environment does not.
  const { NoDefaultCurrentDirectoryInExePath: _protected, ...plain } = process.env;
  const env = { ...plain, NODE_OPTIONS: `--require=${preload.replaceAll('\\', '/')}` };
  return { tmp, marker, env };
}

test('FH6a: on Windows a git.exe in the current folder does not run in the base-code check', { skip: process.platform !== 'win32' }, () => {
  const plant = plantedExe('git');
  try {
    const runner = path.join(plant.tmp, 'runner.mjs');
    writeFileSync(runner, `import { baseCodeProblem } from ${JSON.stringify(new URL('./land-none-check.mjs', import.meta.url).href)};\nconsole.log(String(baseCodeProblem({ root: ${JSON.stringify(plant.tmp)}, baseRef: 'main', remote: 'fork', files: [] })));\n`);
    const r = spawnSync(process.execPath, [runner], { cwd: plant.tmp, encoding: 'utf8', env: plant.env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(plant.marker), 'the git.exe planted in the current folder ran');
  } finally { rmSync(plant.tmp, { recursive: true, force: true }); }
});

test('FH6b: on Windows a gh.exe in the current folder does not run in makeGh', { skip: process.platform !== 'win32' }, () => {
  const plant = plantedExe('gh');
  try {
    const runner = path.join(plant.tmp, 'runner.mjs');
    writeFileSync(runner, `import { makeGh } from ${JSON.stringify(new URL('./review-router.mjs', import.meta.url).href)};\ntry { makeGh()(['help']); } catch { /* gh prints no JSON, or is absent */ }\n`);
    const r = spawnSync(process.execPath, [runner], { cwd: plant.tmp, encoding: 'utf8', env: plant.env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(plant.marker), 'the gh.exe planted in the current folder ran');
  } finally { rmSync(plant.tmp, { recursive: true, force: true }); }
});

// ---------- item 5: the backslash replace of the hooks path ----------

test('FH7: toGitPath changes backslashes only where the path separator is a backslash', () => {
  assert.equal(typeof lnc.toGitPath, 'function');
  assert.equal(lnc.toGitPath('C:\\a\\b\\c.mjs', '\\'), 'C:/a/b/c.mjs');
  assert.equal(lnc.toGitPath('/home/x/a\\b/c.mjs', '/'), '/home/x/a\\b/c.mjs', 'a backslash is a legal file name character on Linux');
});

// ---------- item 6: the hash in Node ----------

/** A bare remote and a checkout with the files committed and pushed. */
function setup(files) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fh-hash-'));
  const remote = path.join(tmp, 'remote.git');
  const checkout = path.join(tmp, 'checkout');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'config', 'core.autocrlf', 'false');
  for (const [rel, text] of Object.entries(files)) write(checkout, rel, text);
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'remote', 'add', 'fork', remote);
  git(checkout, 'push', '-q', 'fork', 'main');
  return { tmp, checkout };
}
const check = (env, files = ['scripts/a.mjs']) => lnc.baseCodeProblem({ root: env.checkout, baseRef: 'main', remote: 'fork', files });

test('FH8: the blob hash is computed in Node: a git blob id, CRLF pairs equal LF, a lone CR does not (seat word D3)', () => {
  assert.equal(typeof lnc.blobHash, 'function');
  assert.equal(typeof lnc.matchesBase, 'function');
  assert.equal(lnc.blobHash(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', 'the same id as git hash-object');
  const base = lnc.blobHash(Buffer.from('a\nb\n'));
  const same = (text, against = base) => lnc.matchesBase(Buffer.from(text), against);
  assert.equal(same('a\nb\n'), true, 'raw LF');
  assert.equal(same('a\r\nb\r\n'), true, 'CRLF pairs convert to LF, as autocrlf does');
  assert.equal(same('a\rb\n'), false, 'a lone CR stays and fails');
  assert.equal(same('a\r\nb\r'), false, 'a trailing lone CR fails');
  assert.equal(same('a\r\r\nb\n'), false, 'CR CR LF: only the last pair converts, the lone CR stays');
  assert.equal(same('a\n\r\nb\n'), false, 'a different line count fails');
  assert.equal(same('a\r\nb\r\n', lnc.blobHash(Buffer.from('a\r\nb\r\n'))), true, 'a base that is CRLF itself matches its raw bytes');
  assert.equal(same('a\nc\n'), false, 'a real change fails');
});

test('FH9: baseCodeProblem hashes raw bytes: a CRLF copy passes with no autocrlf, a lone CR fails, and the PR\'s .gitattributes cannot hide a change', () => {
  const crlf = setup({ 'scripts/a.mjs': 'export const a = 1;\nexport const b = 2;\n' });
  try {
    write(crlf.checkout, 'scripts/a.mjs', 'export const a = 1;\r\nexport const b = 2;\r\n');
    assert.equal(check(crlf), null, 'CRLF pairs, no core.autocrlf (git hash-object --path would refuse this)');
    write(crlf.checkout, 'scripts/a.mjs', 'export const a = 1;\rexport const b = 2;\n');
    assert.ok(String(check(crlf)).includes('scripts/a.mjs'), 'a lone CR is a difference');
  } finally { rmSync(crlf.tmp, { recursive: true, force: true }); }
  // `ident` in the checkout's .gitattributes collapses $Id: ...$ in git hash-object --path, so a changed file looks equal
  const ident = setup({ '.gitattributes': 'scripts/a.mjs ident\n', 'scripts/a.mjs': 'export const a = "$Id$";\n' });
  try {
    assert.equal(check(ident), null, 'control: the file equals the base');
    write(ident.checkout, 'scripts/a.mjs', 'export const a = "$Id: the PR changed this line$";\n');
    assert.ok(String(check(ident)).includes('scripts/a.mjs'), 'an ident attribute of the PR does not hide a change');
  } finally { rmSync(ident.tmp, { recursive: true, force: true }); }
});

// ---------- CodeRabbit CLI finding 1 of pre-pr 1 (seat ruling 11-22): a link must not stand in for a listed file ----------

test('FH13: a listed file that is a link, or sits in a linked folder, is refused even when its bytes equal the base (Node loads the real path)', (t) => {
  const env = setup({ 'lib/a.mjs': 'export const a = 1;\n', 'b.mjs': 'export const b = 2;\n' });
  const links = [];
  try {
    const elsewhere = path.join(env.tmp, 'elsewhere');
    mkdirSync(elsewhere);
    copyFileSync(path.join(env.checkout, 'lib/a.mjs'), path.join(elsewhere, 'a.mjs'));
    copyFileSync(path.join(env.checkout, 'b.mjs'), path.join(elsewhere, 'b.mjs'));
    assert.equal(check(env, ['lib/a.mjs', 'b.mjs']), null, 'control: the real files equal the base');
    // a linked parent folder (a junction needs no privilege on Windows)
    rmSync(path.join(env.checkout, 'lib'), { recursive: true });
    symlinkSync(elsewhere, path.join(env.checkout, 'lib'), 'junction');
    links.push(path.join(env.checkout, 'lib'));
    assert.ok(String(check(env, ['lib/a.mjs'])).includes('lib/a.mjs'), 'a file in a linked folder is named');
    // a linked file (needs the symlink privilege on Windows: skipped there without it)
    try {
      rmSync(path.join(env.checkout, 'b.mjs'));
      symlinkSync(path.join(elsewhere, 'b.mjs'), path.join(env.checkout, 'b.mjs'), 'file');
      links.push(path.join(env.checkout, 'b.mjs'));
      assert.ok(String(check(env, ['b.mjs'])).includes('b.mjs'), 'a linked file is named');
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) throw err;
      t.diagnostic(`the file-link half is skipped: ${err.code}`);
    }
  } finally {
    for (const link of links) { try { unlinkSync(link); } catch { /* removed with the folder below */ } }
    rmSync(env.tmp, { recursive: true, force: true });
  }
});

// ---------- item 3: aegis F3, case ----------

test('FH10: classify gives an upper-case path the class of its lower-case form', () => {
  const lower = router.classify(['apps/agentic-os/drizzle/0009_x.sql'], LIVE).class;
  assert.notEqual(lower, 'normal', 'control: the lower-case path is in a class');
  assert.equal(router.classify(['apps/agentic-os/DRIZZLE/0009_x.SQL'], LIVE).class, lower);
  assert.equal(router.classify(['APPS/AGENTIC-OS/Drizzle/0009_X.sql'], LIVE).class, lower);
  assert.equal(router.classify(['docs/guide.md'], LIVE).class, router.classify(['DOCS/Guide.MD'], LIVE).class);
});

test('FH11: the migration gate sees an upper-case .SQL in an upper-case folder as an added migration', async () => {
  const gate = await import('./migration-gate.mjs');
  assert.equal(typeof gate.addedMigrationFiles, 'function');
  const names = [
    'apps/agentic-os/drizzle/0009_a.sql', 'apps/agentic-os/DRIZZLE/0010_B.SQL', 'Apps/Agentic-OS/drizzle/0011_c.Sql',
    'apps/agentic-os/drizzle/0004_down.txt', 'apps/agentic-os/drizzle/meta/0001_snapshot.json', 'apps/agentic-os/drizzle/sub/0012_d.sql', 'docs/0013_e.sql',
  ];
  assert.deepEqual(gate.addedMigrationFiles(names), ['apps/agentic-os/drizzle/0009_a.sql', 'apps/agentic-os/DRIZZLE/0010_B.SQL', 'Apps/Agentic-OS/drizzle/0011_c.Sql']);
  // end to end through git plumbing (no working tree, so the file system case does not matter): the head adds DRIZZLE/0001_B.SQL and lists 0001_b in the journal
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fh-mig-'));
  try {
    git(tmp, 'init', '-q', '-b', 'main');
    git(tmp, 'config', 'core.ignorecase', 'false');
    const blob = (text) => spawnSync('git', ['-C', tmp, 'hash-object', '-w', '--stdin'], { input: text, encoding: 'utf8' }).stdout.trim();
    const commit = (entries, parent) => {
      const index = path.join(tmp, `index-${parent ? 'head' : 'main'}`);
      const env = { ...process.env, GIT_INDEX_FILE: index };
      for (const [file, text] of entries) {
        const r = spawnSync('git', ['-C', tmp, 'update-index', '--add', '--cacheinfo', `100644,${blob(text)},${file}`], { env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
      }
      const tree = spawnSync('git', ['-C', tmp, 'write-tree'], { env, encoding: 'utf8' }).stdout.trim();
      return git(tmp, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'c');
    };
    const journal = (tags) => JSON.stringify({ entries: tags.map((tag) => ({ tag })) });
    const base = commit([['apps/agentic-os/drizzle/meta/_journal.json', journal(['0000_init'])], ['apps/agentic-os/drizzle/0000_init.sql', 'select 1;\n']]);
    git(tmp, 'update-ref', 'refs/heads/main', base);
    const head = commit([['apps/agentic-os/drizzle/meta/_journal.json', journal(['0000_init', '0001_b'])], ['apps/agentic-os/drizzle/0000_init.sql', 'select 1;\n'], ['apps/agentic-os/DRIZZLE/0001_B.SQL', 'select 2;\n']], base);
    const facts = gate.readPrFacts({ head, repoPath: tmp, base: 'main' });
    assert.deepEqual(facts.newMigrations, ['0001_b'], 'the upper-case folder and file name are a migration of the journal tag 0001_b');
    assert.equal(facts.journalCount, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
