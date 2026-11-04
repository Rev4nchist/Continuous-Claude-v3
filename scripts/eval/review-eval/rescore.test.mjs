// Tests for `rescore --archive` (rescore.mjs, wired in cli.mjs). Run: node --test scripts/eval/review-eval/rescore.test.mjs
// Each test names the source change that would break it.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from './cli.mjs';

const tmp = () => mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'rescore-'));
const quiet = () => { const out = []; return { out, stdout: (s) => out.push(String(s)), stderr: (s) => out.push(String(s)) }; };
const SHA = 'a'.repeat(40);
const GONE = 'C:\\gone\\worktree\\review-eval';
const answer = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, result: text, session_id: 's', usage: {} });
const BAD = '{"findings":[{"file":"real.ts","line":4,"severity":"major","title":"T","body":"b"},{"file":"ghost.ts","line":9,"severity":"minor","title":"G","body":"b"]}';
const jsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** An archive with three rows. Every findingsPath names a folder that is gone, as in the real archive. */
function makeArchive() {
  const dir = tmp();
  const rows = [];
  const add = (pr, stem, raw, patch) => {
    const folder = path.join(dir, String(pr), SHA.slice(0, 8));
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${stem}.raw.json`), raw);
    writeFileSync(path.join(folder, `${stem}.findings.json`), JSON.stringify({ schema: 1, status: 'failed', error: 'old', findings: [], problems: ['old'] }));
    rows.push({ schema: 1, set: 'holdout', pr, round: 1, sha40: SHA, status: 'failed', reason: 'no findings block and no recognisable headings: the answer is not a pass', findingCount: 0, ts: '2026-11-03T10:00:00.000Z', promptSha256: 'f53fa6b8', findingsPath: `${GONE}\\${pr}\\${SHA.slice(0, 8)}\\${stem}.findings.json`, ...patch });
  };
  add(1, 'bad', answer(`Notes\n\`\`\`json\n${BAD}\n\`\`\``), {});
  add(2, 'empty', answer(''), {});
  add(3, 'timeout', '', { reason: 'TIMED OUT after 1500 s' });
  writeFileSync(path.join(dir, 'runs.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(path.join(dir, 'dataset-resolved.json'), JSON.stringify({ findings: [], zeroMajorPrs: [] }));
  return dir;
}

test('rescore re-parses the archived raw output with the repair and the path filter, and never touches the archive', async () => {
  // Breaks when: rescore is missing, overwrites the archive, skips the path filter, or turns an empty answer or a timeout into a pass.
  const dir = makeArchive();
  const out = path.join(tmp(), 'rescored');
  const before = readFileSync(path.join(dir, 'runs.jsonl'), 'utf8');
  const io = { ...quiet(), exists: (sha, file) => sha === SHA && file === 'real.ts' };
  assert.equal(await main(['rescore', '--archive', dir, '--out', out], io), 0, io.out.join('\n'));
  assert.equal(readFileSync(path.join(dir, 'runs.jsonl'), 'utf8'), before, 'the archive is unchanged');
  const rows = jsonl(path.join(out, 'runs.jsonl'));
  assert.deepEqual(rows.map((r) => r.status), ['ok', 'failed', 'failed']);
  assert.equal(rows[0].findingCount, 1, 'the ghost.ts finding is dropped');
  assert.equal(rows[0].ts, '2026-11-03T10:00:00.000Z', 'ts stays, so the same row wins in score');
  assert.equal(rows[2].reason, 'TIMED OUT after 1500 s', 'a row with no raw output keeps its reason');
  assert.ok(existsSync(rows[0].findingsPath) && rows[0].findingsPath.startsWith(out));
  const rec = JSON.parse(readFileSync(rows[0].findingsPath, 'utf8'));
  assert.deepEqual(rec.findings.map((f) => f.file), ['real.ts']);
  assert.match(rec.problems.join(' '), /repaired malformed findings JSON/);
  assert.equal(await main(['score', '--dir', out], quiet()), 0, 'score runs on the output');
});

test('rescore refuses to write into the archive, and needs --archive', async () => {
  // Breaks when: --out may equal the archive, or the command runs without an archive.
  const dir = makeArchive();
  assert.equal(await main(['rescore', '--archive', dir, '--out', dir], quiet()), 2);
  assert.equal(await main(['rescore'], quiet()), 2);
});

test('score --rebase reads the findings files from the archive folder, not from the stored findingsPath', async () => {
  // Breaks when: scoreCmd trusts the stored findingsPath only.
  const dir = makeArchive();
  writeFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify({ schema: 1, set: 'holdout', pr: 4, round: 1, sha40: SHA, status: 'ok', ts: 't', promptSha256: 'f53fa6b8', findingsPath: `${GONE}\\4\\${SHA.slice(0, 8)}\\x.findings.json` })}\n`);
  mkdirSync(path.join(dir, '4', SHA.slice(0, 8)), { recursive: true });
  writeFileSync(path.join(dir, '4', SHA.slice(0, 8), 'x.findings.json'), JSON.stringify({ findings: [] }));
  const io = quiet();
  assert.equal(await main(['score', '--dir', dir], io), 1, 'without --rebase the gone folder fails');
  assert.equal(await main(['score', '--dir', dir, '--rebase', dir], quiet()), 0);
});

test('rescore refuses an --out junction that points at the archive (CodeRabbit #275)', async () => {
  // Breaks when: the --out check compares path.resolve strings, so a junction or symlink to the archive passes and the archive is overwritten.
  const { symlinkSync } = await import('node:fs');
  const dir = makeArchive();
  const link = path.join(tmp(), 'alias');
  symlinkSync(dir, link, 'junction');
  assert.equal(await main(['rescore', '--archive', dir, '--out', link], quiet()), 2);
  assert.equal(await main(['rescore', '--archive', dir, '--out', path.join(link, 'nested')], quiet()), 0);
});

test('treeCheck accepts a blob and rejects a tree (CodeRabbit #275)', async () => {
  // Breaks when: treeCheck uses cat-file -e, which accepts a directory path.
  const { treeCheck } = await import('./rescore.mjs');
  const git = (args) => {
    if (args[0] === 'cat-file' && args[1] === '-e') return { status: 0, stdout: '' };
    if (args[0] === 'cat-file' && args[1] === '-t') return { status: 0, stdout: args[2].endsWith(':dir') ? 'tree\n' : 'blob\n' };
    return { status: 1, stdout: '' };
  };
  const check = treeCheck(git);
  assert.equal(check(SHA, 'dir/a.ts'), true);
  assert.equal(check(SHA, 'dir'), false);
});

test('CR5: rescore refuses an --out that is an existing file with exit 2 (CodeRabbit #275 round 4)', async () => {
  // Breaks when: the --out check calls readdirSync on a file, which throws ENOTDIR and exits 1.
  const dir = makeArchive();
  const file = path.join(tmp(), 'out.txt');
  writeFileSync(file, 'x');
  assert.equal(await main(['rescore', '--archive', dir, '--out', file], quiet()), 2);
});

test('CR3: rescore refuses an --out folder that exists and is not empty, and writes nothing; a missing or empty folder is fine', async () => {
  // Breaks when: rescore writes into a used folder, so old files mix with the new run.
  const dir = makeArchive();
  const used = tmp();
  writeFileSync(path.join(used, 'old.txt'), 'keep');
  const io = quiet();
  assert.equal(await main(['rescore', '--archive', dir, '--out', used], io), 2);
  assert.match(io.out.join('\n'), /not empty/);
  assert.equal(existsSync(path.join(used, 'runs.jsonl')), false, 'nothing was written');
  assert.equal(await main(['rescore', '--archive', dir, '--out', tmp()], quiet()), 0, 'an empty folder is fine');
  assert.equal(await main(['rescore', '--archive', dir, '--out', path.join(tmp(), 'fresh')], quiet()), 0, 'a missing folder is fine');
});

test('archiveFile refuses a stored path with .. or . segments (CodeRabbit #275 round 4)', async () => {
  // Breaks when: archiveFile joins the last three segments unchecked, so "../.env" resolves outside the archive.
  const { archiveFile } = await import('./rescore.mjs');
  assert.equal(archiveFile('/a', '../.env'), null);
  assert.equal(archiveFile('/a', 'x/../../secret'), null);
  assert.equal(archiveFile('/a', String.raw`C:\gone\211\2aabe283\r.findings.json`), path.join('/a', '211', '2aabe283', 'r.findings.json'));
});
