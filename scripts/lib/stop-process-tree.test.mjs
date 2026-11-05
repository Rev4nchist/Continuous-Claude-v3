// Tests for scripts/lib/Stop-ProcessTree.ps1, the one approved way to kill a process tree on Windows,
// and a static guard that no script uses the taskkill tree switch (/T) again.
//
// Why: the taskkill /T walk resolves the tree by parent id at kill time. Process ids are reused on this
// machine, so /T can kill a live peer-session shell that only inherited a recycled parent id.
// See docs/windows/msys-fork-storm-investigation.md.
//
// How it can fail, one test each below:
//   static scan: a new taskkill call with /T or -T in a script, a skill reference or a hint string (any case,
//                same line or the next two lines, argv arrays too); a comment that only warns "never taskkill /T" must pass
//   scanner: the scanner itself must flag the real forms and ignore the safe forms (literal strings)
//   helper file: names taskkill anywhere (the helper must not shell out to it)
//   helper, snapshot seam (no kills happen, rows say WouldKill):
//     the root is the caller or one of its ancestors -> SkippedProtected, nothing else touched
//     the order is leaves first, root last
//     a child older than its parent (a reused id) is SkippedReused and its subtree is not walked
//     a root that is not in the snapshot -> Gone, no throw
//   helper, real processes: a node child with a node grandchild is stopped, both are gone, a sibling outside
//     the tree and the test runner live on
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = join(ROOT, 'scripts', 'lib', 'Stop-ProcessTree.ps1');

// ---- static scan ----
const SCAN_ROOTS = ['scripts', '.claude/scripts', '.claude/skills'];
const SKIP_DIRS = new Set(['node_modules', '.venv', '.git', 'worktrees', 'cache', '_vendor', 'docs', 'thoughts', '.claudedocs']);
const SCAN_EXT = new Set(['.ps1', '.psm1', '.bat', '.cmd', '.mjs', '.js', '.ts', '.py', '.sh', '.md']);
const THIS_FILE = 'scripts/lib/stop-process-tree.test.mjs';

const COMMENT_START = /^(#|\/\/|\/\*|\*|REM\b|::|<!--)/i;
const TASKKILL_WORD = /\btaskkill\b/i;
const TREE_FLAG = /(^|[\s'",[(])[/-]t(?=[\s'",\])`]|$)/i;
const NEGATED_PROSE = /\b(never|do not|don't|not)\b.{0,30}\btaskkill\b/i;

/** Lines of `text` that run taskkill with a tree flag (1-based numbers). Comment lines are skipped; .md prose that forbids it is skipped. */
function treeKillLines(text, file = 'x.ps1') {
  const lines = text.split(/\r?\n/);
  const isCode = (l) => !COMMENT_START.test(l.trim());
  const hits = [];
  lines.forEach((line, i) => {
    if (!isCode(line) || !TASKKILL_WORD.test(line)) return;
    if (file.endsWith('.md') && NEGATED_PROSE.test(line)) return;
    const window = lines.slice(i, i + 3).filter(isCode);
    if (window.some((l) => TREE_FLAG.test(l))) hits.push(i + 1);
  });
  return hits;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile()) yield full;
  }
}

const isScanned = (rel) => {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (rel === THIS_FILE || /\.test\.[a-z0-9]+$/i.test(base)) return false;
  return SCAN_EXT.has(base.slice(base.lastIndexOf('.')).toLowerCase());
};

test('scanner flags the tree-kill forms and ignores the safe ones', () => {
  assert.deepEqual(treeKillLines('taskkill /PID 1 /T /F'), [1]);
  assert.deepEqual(treeKillLines('& taskkill.exe /t /f /pid $x'), [1]);
  assert.deepEqual(treeKillLines("spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)])"), [1]);
  assert.deepEqual(treeKillLines("spawnSync('taskkill', [\n  '/F',\n  '-T',\n  '/PID', '1'])"), [1]);
  assert.deepEqual(treeKillLines("'run: (taskkill /PID <n> /T /F).'"), [1]);
  assert.deepEqual(treeKillLines('# Never taskkill /T\n// taskkill /T is banned\nREM taskkill /T /F'), []);
  assert.deepEqual(treeKillLines('taskkill /F /PID 1'), []);
  assert.deepEqual(treeKillLines('taskkill /F /IM chrome.exe'), []);
  assert.deepEqual(treeKillLines('TaskKilled (another attempt succeeded) /T'), []);
  assert.deepEqual(treeKillLines('Never taskkill /T on this box.', 'a.ps1'), [1]); // only .md prose may forbid it
  assert.deepEqual(treeKillLines('- Never taskkill /T on this box.', 'a.md'), []);
});

test('no script, skill reference or hint string runs taskkill with /T', () => {
  const found = [];
  for (const base of SCAN_ROOTS) {
    const dir = join(ROOT, base);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (!isScanned(rel)) continue;
      for (const n of treeKillLines(readFileSync(file, 'utf8'), rel)) found.push(`${rel}:${n}`);
    }
  }
  assert.deepEqual(found, [], `taskkill with /T is banned (pid reuse kills live shells). Use scripts/lib/Stop-ProcessTree.ps1:\n  ${found.join('\n  ')}`);
});

test('the helper exists, is ASCII and never calls taskkill', () => {
  assert.ok(existsSync(HELPER), `missing ${HELPER}`);
  const text = readFileSync(HELPER, 'utf8');
  assert.doesNotMatch(text, /taskkill/i);
  assert.doesNotMatch(text, /[^\x00-\x7f]/, 'powershell.exe 5.1 reads a file with no BOM as CP1252: keep it ASCII');
});

// ---- helper behaviour ----
const PS = 'powershell.exe';
const work = mkdtempSync(join(tmpdir(), 'spt-'));

/** Runs the helper in a fresh powershell.exe 5.1. `spec.rows` ProcessId/ParentProcessId may be the string SELF (that shell's own pid). */
function runSnapshot(spec) {
  const specFile = join(work, `spec-${Math.random().toString(16).slice(2)}.json`);
  const driver = join(work, 'driver.ps1');
  writeFileSync(specFile, JSON.stringify(spec));
  writeFileSync(driver, [
    'param([string]$Helper, [string]$Spec)',
    '$ErrorActionPreference = "Stop"',
    '. $Helper',
    '$s = Get-Content -Raw -LiteralPath $Spec | ConvertFrom-Json',
    'function Id($v) { if ("$v" -eq "SELF") { return $PID } return [int]$v }',
    '$rows = @(foreach ($r in $s.rows) { [pscustomobject]@{ ProcessId = (Id $r.ProcessId); ParentProcessId = (Id $r.ParentProcessId); CreationDate = [datetime]$r.CreationDate; Name = [string]$r.Name } })',
    '$p = @{ RootId = (Id $s.root); Snapshot = $rows }',
    'if ($s.excludeRoot) { $p.ExcludeRoot = $true }',
    '$out = @(Stop-ProcessTree @p)',
    'ConvertTo-Json -InputObject @($out | Select-Object ProcessId, Status, Name, Detail) -Compress',
  ].join('\r\n'));
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver, '-Helper', HELPER, '-Spec', specFile], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, `powershell failed: ${r.stdout}\n${r.stderr}`);
  const rows = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
  return rows.map((x) => ({ ...x, ProcessId: Number(x.ProcessId) }));
}

const T0 = '2026-01-01T12:00:00Z';
const at = (min) => `2026-01-01T12:${String(min).padStart(2, '0')}:00Z`;
const row = (ProcessId, ParentProcessId, CreationDate, Name = 'fake.exe') => ({ ProcessId, ParentProcessId, CreationDate, Name });
const byPid = (rows, pid) => rows.find((r) => r.ProcessId === pid);

test('a root that is the caller or one of its ancestors is SkippedProtected and nothing is killed', { skip: process.platform !== 'win32' }, () => {
  const rows = [row(70001, 0, T0), row('SELF', 70001, at(1)), row(70003, 'SELF', at(2))];
  const ancestor = runSnapshot({ root: 70001, rows });
  assert.deepEqual(ancestor.map((r) => [r.ProcessId, r.Status]), [[70001, 'SkippedProtected']]);
  const self = runSnapshot({ root: 'SELF', rows });
  assert.ok(self.every((r) => r.Status === 'SkippedProtected'), JSON.stringify(self));
  assert.ok(!self.some((r) => r.Status === 'WouldKill'));
});

test('the kill order is leaves first and the root last', { skip: process.platform !== 'win32' }, () => {
  const rows = [row(70100, 1, T0), row(70101, 70100, at(1)), row(70102, 70100, at(1)), row(70103, 70101, at(2)), row(70104, 70103, at(3)), row(70999, 1, at(1))];
  const out = runSnapshot({ root: 70100, rows });
  assert.deepEqual(out.map((r) => r.ProcessId).sort(), [70100, 70101, 70102, 70103, 70104]);
  assert.ok(out.every((r) => r.Status === 'WouldKill'), JSON.stringify(out));
  const index = (pid) => out.findIndex((r) => r.ProcessId === pid);
  for (const [child, parent] of [[70101, 70100], [70102, 70100], [70103, 70101], [70104, 70103]]) assert.ok(index(child) < index(parent), `${child} must come before ${parent}`);
  assert.equal(out.at(-1).ProcessId, 70100);
  assert.ok(!out.some((r) => r.ProcessId === 70999), 'a process outside the tree is never listed');
});

test('a child older than its parent (a reused id) is SkippedReused and its subtree is left alone', { skip: process.platform !== 'win32' }, () => {
  const rows = [row(70200, 1, at(10)), row(70201, 70200, at(5)), row(70202, 70201, at(11)), row(70203, 70200, at(11))];
  const out = runSnapshot({ root: 70200, rows });
  assert.equal(byPid(out, 70201).Status, 'SkippedReused');
  assert.equal(byPid(out, 70202), undefined, 'the subtree of a reused id is not walked');
  assert.equal(byPid(out, 70203).Status, 'WouldKill');
  assert.equal(byPid(out, 70200).Status, 'WouldKill');
});

test('a root that is not in the snapshot is Gone, not an error', { skip: process.platform !== 'win32' }, () => {
  const out = runSnapshot({ root: 79999, rows: [row(70300, 1, T0)] });
  assert.deepEqual(out.map((r) => [r.ProcessId, r.Status]), [[79999, 'Gone']]);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return fn(); };

test('real processes: the child and its grandchild die, a sibling and the test runner live', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const sleeper = 'setTimeout(() => {}, 60000)'; // bounded: a failed run leaves no permanent orphan
  const childCode = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore' }); console.log(g.pid); setTimeout(() => {}, 60000);`;
  const child = spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const sibling = spawn(process.execPath, ['-e', sleeper], { stdio: 'ignore', windowsHide: true });
  let grandchild = 0;
  try {
    grandchild = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no grandchild pid')), 15000);
      child.stdout.once('data', (d) => { clearTimeout(timer); resolve(Number(String(d).trim())); });
    });
    assert.ok(alive(child.pid) && alive(grandchild) && alive(sibling.pid), 'the tree must be alive before the kill');
    const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `. '${HELPER}'; ConvertTo-Json -InputObject @(Stop-ProcessTree -RootId ${child.pid} | Select-Object ProcessId, Status) -Compress`],
    { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const rows = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)).map((x) => ({ pid: Number(x.ProcessId), status: x.Status }));
    // Windows can add a console host (conhost.exe) child under a node process, so the tree may hold more than two ids.
    // A console host that exits by itself between the snapshot and its kill is Gone, which is fine. The two node processes must be Killed.
    assert.ok(rows.every((x) => x.status === 'Killed' || x.status === 'Gone'), JSON.stringify(rows));
    assert.equal(rows.find((x) => x.pid === grandchild)?.status, 'Killed', JSON.stringify(rows));
    assert.equal(rows.find((x) => x.pid === child.pid)?.status, 'Killed', JSON.stringify(rows));
    assert.equal(rows.at(-1).pid, child.pid, 'the root is last');
    assert.ok(await waitFor(() => !alive(child.pid) && !alive(grandchild)), 'the child and the grandchild must be gone');
    assert.ok(alive(sibling.pid), 'a process outside the tree must live');
    assert.ok(alive(process.pid), 'the test runner must live');
  } finally {
    for (const pid of [child.pid, grandchild, sibling.pid]) { if (pid && alive(pid)) { try { process.kill(pid); } catch { /* already gone */ } } }
  }
});
