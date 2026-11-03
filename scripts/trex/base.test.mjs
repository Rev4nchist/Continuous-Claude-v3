import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveArgs, archiveInto, extractGrading, listGrading, resolveBase, tarBin } from './base.mjs';

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const FULL = 'a'.repeat(40);

/** A fake git. `tree` is the list of every file at the SHA; ls-tree filters it by path prefix like the real one. */
function fakeGit(tree, calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return ok(`${FULL}\n`);
    if (args[0] !== 'ls-tree') return { status: 1, stdout: '', stderr: 'unexpected' };
    const specs = args.slice(args.indexOf('--') + 1);
    const hit = tree.filter((f) => specs.some((s) => f === s || f.startsWith(`${s}/`)));
    return ok(hit.map((f) => `${f}\0`).join(''));
  };
}

// ---------- listGrading ----------

test('listGrading: keeps trex-*.spec.ts directly under e2e and drops other specs', () => {
  const tree = [
    'apps/agentic-os/e2e/trex-login.spec.ts',
    'apps/agentic-os/e2e/other.spec.ts',
    'apps/agentic-os/e2e/trex-sub/deep.spec.ts',
    'apps/agentic-os/e2e/trex-notes.txt',
  ];
  assert.deepEqual(listGrading(fakeGit(tree), FULL, '.trex/flows'), ['apps/agentic-os/e2e/trex-login.spec.ts']);
});

test('listGrading: collects every grading root and sorts the paths', () => {
  const tree = [
    'docker/trex/Dockerfile', '.trex/flows/b.yaml', '.trex/flows/a.yaml', '.trex/config.json',
    'apps/agentic-os/.trex/x.json', 'apps/agentic-os/playwright.trex.config.ts', 'src/app.ts',
  ];
  assert.deepEqual(listGrading(fakeGit(tree), FULL, '.trex/flows'), [
    '.trex/config.json', '.trex/flows/a.yaml', '.trex/flows/b.yaml',
    'apps/agentic-os/.trex/x.json', 'apps/agentic-os/playwright.trex.config.ts', 'docker/trex/Dockerfile',
  ]);
});

test('listGrading: reads the tree with ls-tree -r -z at the given sha', () => {
  const calls = [];
  listGrading(fakeGit([], calls), FULL, '.trex/flows');
  assert.ok(calls.length > 0);
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 3), ['ls-tree', '-r', '-z']);
    assert.ok(args.includes(FULL));
  }
});

test('listGrading: an ls-tree failure throws', () => {
  const git = () => ({ status: 128, stdout: '', stderr: 'bad object' });
  assert.throws(() => listGrading(git, FULL, '.trex/flows'), /bad object/);
});

// ---------- extractGrading ----------

test('extractGrading: an empty grading set is skipped no_config and runs no archive', async () => {
  let piped = 0;
  const pipe = async () => { piped += 1; return { codeA: 0, codeB: 0 }; };
  const r = await extractGrading(fakeGit(['src/app.ts']), FULL, 'dest', '.trex/flows', { pipe });
  assert.deepEqual(r.skipped, { reason: 'no_config' });
  assert.deepEqual(r.files, []);
  assert.equal(piped, 0);
});

test('extractGrading: archives the listed files from the given sha with autocrlf off, then untars', async () => {
  const seen = [];
  const pipe = async (a, b) => { seen.push({ a, b }); return { codeA: 0, codeB: 0 }; };
  const dest = mkdtempSync(path.join(tmpdir(), 'trex-base-'));
  const r = await extractGrading(fakeGit(['.trex/flows/a.yaml']), 'abc123', dest, '.trex/flows', { pipe, exists: () => true });
  assert.deepEqual(r.files, ['.trex/flows/a.yaml']);
  assert.equal(r.configSha, FULL);
  assert.equal(r.skipped, undefined);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].a.args, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', 'abc123', '--', '.trex/flows/a.yaml']);
  assert.deepEqual(seen[0].b.args, ['-xf', '-', '-C', dest]);
});

test('extractGrading: a failed archive throws', async () => {
  const pipe = async () => ({ codeA: 128, codeB: 0 });
  await assert.rejects(extractGrading(fakeGit(['.trex/a.yaml']), FULL, 'dest', '.trex/flows', { pipe }), /archive/);
});

test('extractGrading: real git repo keeps LF when core.autocrlf=true is set', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'trex-repo-'));
  const run = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  run('init', '-q', '.');
  run('config', 'core.autocrlf', 'false');
  mkdirSync(path.join(repo, '.trex', 'flows'), { recursive: true });
  writeFileSync(path.join(repo, '.trex', 'flows', 'a.yaml'), 'id: one\nid2: two\n');
  run('add', '.');
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  run('config', 'core.autocrlf', 'true');
  const sha = run('rev-parse', 'HEAD').stdout.trim();
  const git = (args) => { const r = run(...args); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
  const dest = path.join(repo, '..', `out-${path.basename(repo)}`);
  const r = await extractGrading(git, sha, dest, '.trex/flows', { cwd: repo });
  assert.equal(r.configSha, sha);
  const text = readFileSync(path.join(dest, '.trex', 'flows', 'a.yaml'), 'utf8');
  assert.equal(text, 'id: one\nid2: two\n');
  assert.ok(existsSync(path.join(dest, '.trex', 'flows')));
});

// ---------- resolveBase and archiveArgs ----------

test('resolveBase: returns the merge-base of head and fork/main by default', () => {
  const calls = [];
  const git = (args) => { calls.push(args); return ok(`${'b'.repeat(40)}\n`); };
  assert.equal(resolveBase(git, 'headsha'), 'b'.repeat(40));
  assert.deepEqual(calls[0], ['merge-base', 'headsha', 'fork/main']);
});

test('resolveBase: a missing merge-base throws', () => {
  const git = () => ({ status: 1, stdout: '', stderr: '' });
  assert.throws(() => resolveBase(git, 'headsha', 'fork/main'), /merge-base/);
});

test('archiveArgs: sets autocrlf=false and eol=lf before archive', () => {
  assert.deepEqual(archiveArgs('abc', ['x', 'y']), ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', 'abc', '--', 'x', 'y']);
});

// ---------- tarBin and extraction checks (H1) ----------

const SYS_TAR = 'C:\\Windows\\System32\\tar.exe';
const noMkdir = () => {};
const okPipe = async () => ({ codeA: 0, codeB: 0 });

test('tarBin: TAR_BIN wins, then System32 tar on win32, then bare tar', () => {
  // Breaks when tarBin is removed or the order changes: Git MSYS tar then comes first on PATH.
  assert.equal(tarBin({ TAR_BIN: 'X:\\my\\tar.exe' }, { platform: 'win32', exists: () => true }), 'X:\\my\\tar.exe');
  assert.equal(tarBin({ SystemRoot: 'C:\\Windows' }, { platform: 'win32', exists: (p) => p === SYS_TAR }), SYS_TAR);
  assert.equal(tarBin({}, { platform: 'win32', exists: () => false }), 'tar');
  assert.equal(tarBin({}, { platform: 'linux', exists: () => true }), 'tar');
});

test('archiveInto: runs the resolved tar, not a bare tar', async () => {
  // Breaks when archiveInto spawns the literal "tar" again.
  let seen;
  const pipe = async (a, b) => { seen = b; return { codeA: 0, codeB: 0 }; };
  await archiveInto('abc', ['a'], 'dest', { pipe, mkdir: noMkdir, exists: () => true, env: { TAR_BIN: 'Z:\\tar.exe' } });
  assert.equal(seen.cmd, 'Z:\\tar.exe');
});

test('archiveInto: both exit 0 but a listed file is missing throws and names the file', async () => {
  // Breaks when the post-extraction check is removed (MSYS tar prints names, exits 0, extracts nothing).
  await assert.rejects(
    archiveInto('abc', ['a.txt', 'b.txt'], 'dest', { pipe: okPipe, mkdir: noMkdir, exists: (p) => p.endsWith('a.txt') }),
    /b\.txt/,
  );
});

test('archiveInto: an empty file list still throws when nothing was extracted', async () => {
  // Breaks when the whole-tree case skips the check (the host tree comes through this path).
  await assert.rejects(archiveInto('abc', [], 'dest', { pipe: okPipe, mkdir: noMkdir, readdir: () => [] }), /nothing/);
  await archiveInto('abc', [], 'dest', { pipe: okPipe, mkdir: noMkdir, readdir: () => ['package.json'] });
});

test('archiveInto: real git archive and real tar extract two files into a backslash temp path', async () => {
  // Breaks when the tar binary cannot read the destination path or extracts nothing. No Docker.
  const root = path.resolve(import.meta.dirname, '..', '..');
  const dest = mkdtempSync(path.join(tmpdir(), 'trex-tar-'));
  await archiveInto('HEAD', ['package.json', 'scripts/trex/base.mjs'], dest, { cwd: root });
  assert.ok(existsSync(path.join(dest, 'package.json')));
  const text = readFileSync(path.join(dest, 'scripts', 'trex', 'base.mjs'), 'utf8');
  assert.ok(text.includes('archiveInto') && !text.includes('\r'));
});
