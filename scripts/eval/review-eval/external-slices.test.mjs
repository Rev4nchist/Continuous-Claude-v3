// Failure modes for external-slices.mjs (two pinned external datasets -> Gold C rows). No network, no model: ghFn, root and clock are injected.
// Every repo, sha, path and text below is made up. SENTINEL_* strings stand for dataset text that must never be copied.
//  S1  usage (no args, --help, unknown command) touches the network or writes a file   -> usage branch moved after the work
//  S2  a file whose bytes differ from manifest.sha256 is read                           -> hash check dropped
//  S3  a manifest for another sha, id or file is read                                   -> manifest not compared with the pin
//  S4  the slice filter is case-sensitive or lets a non-slice extension in              -> extension compare changed
//  S5  an AACR label 0 row becomes a gold row                                           -> label filter dropped
//  S6  a severity map is wrong (Qodo rule flag, an AACR category)                       -> map edited without a version bump
//  S7  a linkType map is wrong (AACR context, Qodo hunk, same-file, cross-file)         -> hunk test or context map changed
//  S8  a bad commit, category, context, repo or file is written                         -> exclusion dropped, or not counted
//  S9  a Qodo PR with no pin is written with a guessed sha                              -> pin lookup dropped
//  S10 dataset text (title, description, note, snippet, rule name, model) is in a row   -> a field copied into provenance or a label
//  S11 ids change between runs, or lose the c-qodo-/c-aacr- prefix, or repeat           -> id input changed; duplicate check dropped
//  S12 the output fails validateRow or loadGold                                         -> row shape drifts from gold.mjs
//  S13 build runs with no pins file, or with a pins file for another Qodo pin           -> pin checks dropped
//  S14 a row that fails validateRow is written, or the file is half written             -> validation skipped or run after the write
//  S15 pin-prs reads hunk ranges wrong (+c,d; d omitted; d = 0; no patch)               -> parseHunks off by one
//  S16 pin-prs passes the 150 call cap, or writes a partial file at the cap             -> cap check dropped or moved after the call
//  S17 pin-prs retries after a rate limit, or writes a partial file                     -> retry loop; write before the end
//  S18 pin-prs accepts a PR head that moved since the recorded pin                      -> head compare dropped
//  S19 a PR with a bad head or base sha is pinned, or a 404 aborts the pass             -> sha check dropped; 404 not mapped to no-head
//  S20 pin-prs calls the API for a PR with no in-slice finding, or records a login      -> slice filter missing; output holds more than the spec
//  S21 stats prints a row, path, url or text                                            -> stats prints a sample
//  S22 stats counts are wrong (slice, rule flag, human or AI, category, context, bad commit)
//  S23 an AACR json that is not an array, or an object with one array, is read as rows -> shape check dropped
//  S1b --help after a subcommand, or --out with no value, runs the command and writes the default gold file -> flag parse lets them through
//  S26 pin-prs accepts a moved head or base when the git-ignored pins file is absent (fresh checkout)   -> committed gold file not compared
//  S27 a Qodo PR whose head commit is after the dataset date, or has no usable date, is pinned           -> headAt check dropped, or the first commit is read, not the last
//  S28 a PR with a recorded pin (pins file or gold) that now answers 404, no-head or head-after-dataset is dropped silently -> refusal dropped
//  S29 a pin-prs rerun changes pinnedAt (so every row's prPinnedAt) for a PR whose head and base did not move -> old pinnedAt not kept
//  S30 a Qodo line at a hunk edge is mapped wrong (9, 10, 20, 21 against [10,20])                        -> hunk compare made strict
//  S31 main runs with no FILE_SHA256 guard when the caller passes no fileSha256                          -> production default changed to null
//  S15b a pure-deletion hunk (+c,0) gives a line range                                                  -> Math.max(len, 1) restored
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { datasetDirName } from './external-pull.mjs';
import { assertUniqueIds, FILE_SHA256, GH_CALL_CAP, main, parseHunks, PINS, PRS_FILE, PRS_VERSION, QODO_DATASET_AT, SEVERITY_MAP_VERSION, SLICE_EXTS } from './external-slices.mjs';
import { loadGold, validateRow } from './gold.mjs';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const HEAD = 'f'.repeat(40);
const BASE = 'e'.repeat(40);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// Every folder this file makes. Only these are removed after the file ends, never a prefix match.
const made = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ext-slices-'));
  made.push(dir);
  return dir;
};
function removeTempDirs() {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A locked folder must not fail a test: a leak is better than a red run.
    }
  }
}
after(removeTempDirs);
const rowsOf = (file) => JSON.parse(readFileSync(file, 'utf8'));

function writeDataset(root, pin, rows, manifestOver = {}) {
  const dir = path.join(root, datasetDirName(pin.id, pin.sha));
  mkdirSync(dir, { recursive: true });
  const text = pin.format === 'jsonl' ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : JSON.stringify(rows);
  const buf = Buffer.from(text);
  writeFileSync(path.join(dir, pin.file), buf);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: pin.id, sha: pin.sha, file: pin.file, bytes: buf.length, sha256: sha256(buf), fetchedAt: '2026-11-13T00:00:00.000Z', ...manifestOver }));
  return sha256(buf);
}
const writePrs = (root, prs, over = {}) => writeFileSync(path.join(root, PRS_FILE), JSON.stringify({ version: 3, qodo: { id: PINS.qodo.id, sha: PINS.qodo.sha }, pinnedAt: '2026-11-12T00:00:00.000Z', prs, excluded: [], ...over }));

const issue = (over = {}) => ({ title: 'SENTINEL_TITLE', description: 'SENTINEL_DESC', file_path: 'src/a.ts', start_line: 12, end_line: 14, problematic_code_snippet: 'SENTINEL_SNIP', rule_name: 'SENTINEL_RULE', ...over });
const qrow = (url, issues) => ({ repo: 'acme/widget', pr_url_to_review: url, issues, num_of_issues: issues.length });
const PR11 = 'https://github.com/Acme/Widget/pull/11';
const PR22 = 'https://github.com/acme/gadget/pull/22';
const QODO = [
  qrow(PR11, [
    issue(), // in a hunk, rule named
    issue({ file_path: 'src/B.PY', start_line: 3, rule_name: '' }), // upper-case extension, same file
    issue({ file_path: 'docs/readme.md' }), // not in the slice
    issue({ file_path: 'lib/other.js', start_line: 5, rule_name: '  ' }), // file not in the PR, blank rule
    issue({ start_line: null, rule_name: '' }),
    issue({ start_line: 0, rule_name: '' }),
  ]),
  qrow(PR22, [issue()]), // no pin
];
const HEAD_AT = '2026-02-01T00:00:00.000Z';
const PINNED_AT = '2026-11-12T00:00:00.000Z';
const mkPin = (over = {}) => ({ head: HEAD, base: BASE, complete: true, headAt: HEAD_AT, pinnedAt: PINNED_AT, files: {}, ...over });
const PINNED = { 'acme/widget#11': mkPin({ files: { 'src/a.ts': [[10, 20]], 'src/B.PY': [[50, 60]] } }) };

const arow = (over = {}) => ({
  pr_url: 'https://github.com/Acme/Gizmo/pull/5', pr_source_commit: 'D'.repeat(40), pr_target_commit: 'c'.repeat(40), path: 'pkg/mod.PY', from_line: 7, to_line: 9, side: 'right',
  label: 1, category: 'Code Defect', context: 'Diff Level', is_ai_comment: false, source_model: 'SENTINEL_MODEL', note: 'SENTINEL_NOTE',
  project_main_language: 'Python', pr_change_line_count: 10, pr_category: 'x', ...over,
});
const AACR = [
  arow(), // 0 kept, major, within-hunk, human
  arow({ label: 0 }), // 1 dropped
  arow({ category: 'Security Vulnerability', context: 'File Level', is_ai_comment: true }), // 2 major, same-file, AI
  arow({ category: 'Performance', context: 'Repo Level' }), // 3 minor, cross-file-static
  arow({ category: 'Maintainability and Readability', is_ai_comment: true }), // 4 minor, within-hunk
  arow({ pr_source_commit: 'abc123' }), // 5 bad-commit
  arow({ category: 'Style' }), // 6 unknown-category
  arow({ context: 'Weird' }), // 7 unknown-context
  arow({ path: 'README.md' }), // 8 out of slice
  arow({ path: 'pkg/z.mjs', from_line: 0, context: 'File Level' }), // 9 kept, no line
  arow({ pr_url: 'not a url' }), // 10 bad-repo
  arow({ path: '/abs/x.ts' }), // 11 bad-file
];

function setup(over = {}) {
  const root = tmp();
  writeDataset(root, PINS.qodo, over.qodo ?? QODO);
  writeDataset(root, PINS.aacr, over.aacr ?? AACR);
  if (over.prs !== false) writePrs(root, over.prs ?? PINNED);
  return root;
}
async function cli(argv, deps = {}) {
  const out = [];
  const err = [];
  // fileSha256 null: the made-up fixtures are not the pinned files. S2b tests the FILE_SHA256 check.
  // goldFile: a path that does not exist, so a test never reads the real committed gold file.
  const goldFile = path.join(tmp(), 'no-gold-c.json');
  const code = await main(argv, { stdout: (s) => out.push(String(s)), stderr: (s) => err.push(String(s)), now: () => NOW, fileSha256: null, goldFile, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const build = async (root, name = 'gold-c.json') => {
  const file = path.join(tmp(), name);
  const r = await cli(['build', '--out', file], { root });
  return { ...r, file };
};

function fakeGh(map) {
  const calls = [];
  const fn = async (p) => {
    calls.push(p);
    const pr = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(p);
    const cmp = /^repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(p);
    const key = pr ? `${pr[1]}#${pr[2]}` : Object.keys(map).find((k) => k.startsWith(`${cmp?.[1]}#`));
    const e = map[key];
    if (!e) throw Object.assign(new Error('gh api failed: 404'), { status: 404 });
    if (pr) return { head: { sha: e.head }, base: { sha: e.base }, changed_files: e.changed ?? e.files.length, user: { login: 'someone' } };
    return { files: e.files, commits: e.commits ?? [{ commit: { committer: { date: e.headAt ?? HEAD_AT } } }] };
  };
  return { fn, calls };
}
const GH = { 'acme/widget#11': { head: HEAD, base: BASE, files: [{ filename: 'src/a.ts', patch: '@@ -1,3 +10,11 @@ ctx\n x\n@@ -40 +50,0 @@\n' }, { filename: 'README.md' }] } };

test('S1 usage (no args, --help, unknown command) exits 2 with no network and no file write', async () => {
  // Breaks when: the usage branch runs after a pull, a pin or a write.
  for (const argv of [[], ['--help'], ['frobnicate'], ['constructor'], ['build', '--help'], ['stats', '--help'], ['pin-prs', '--help'], ['build', '--out'], ['build', '--out', '--help'], ['stats', '--x'], ['pin-prs', '--out', 'x.json']]) {
    const root = tmp();
    const gh = fakeGh({});
    const r = await cli(argv, { root, ghFn: gh.fn });
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.out + r.err, /Usage/);
    assert.equal(gh.calls.length, 0);
    assert.deepEqual(readdirSync(root), []);
  }
});

test('S2 a file that does not match manifest.sha256 is refused by stats, pin-prs and build', async () => {
  // Breaks when: the hash check is dropped.
  const root = setup();
  writeDataset(root, PINS.qodo, QODO, { sha256: '0'.repeat(64) });
  const gh = fakeGh(GH);
  for (const argv of [['stats'], ['pin-prs'], ['build', '--out', path.join(tmp(), 'o.json')]]) {
    const r = await cli(argv, { root, ghFn: gh.fn });
    assert.equal(r.code, 2, argv[0]);
    assert.match(r.err, /sha256/);
  }
  assert.equal(gh.calls.length, 0);
});

test('S2b a cached file whose sha256 is not the pinned FILE_SHA256 is refused, even with a matching manifest', async () => {
  // Breaks when: build, stats or pin-prs trusts manifest.json alone (a second pull rewrites it) or the byte count alone.
  const root = setup();
  const gh = fakeGh(GH);
  const pinned = { qodo: '1'.repeat(64), aacr: '2'.repeat(64) };
  for (const argv of [['stats'], ['pin-prs'], ['build', '--out', path.join(tmp(), 'o.json')]]) {
    const r = await cli(argv, { root, ghFn: gh.fn, fileSha256: pinned });
    assert.equal(r.code, 2, argv[0]);
    assert.match(r.err, /FILE_SHA256/);
  }
  assert.equal(gh.calls.length, 0);
  assert.equal(FILE_SHA256.qodo.length, 64);
  assert.equal(FILE_SHA256.aacr.length, 64);
});

test('S3 a manifest for another sha, id or file is refused', async () => {
  // Breaks when: the manifest is not compared with the pin.
  for (const over of [{ sha: '9'.repeat(40) }, { id: 'acme/other' }, { file: 'other.jsonl' }]) {
    const root = setup();
    writeDataset(root, PINS.qodo, QODO, over);
    const r = await cli(['stats'], { root });
    assert.equal(r.code, 2, JSON.stringify(over));
    assert.match(r.err, /manifest/);
  }
  const missing = tmp();
  assert.equal((await cli(['stats'], { root: missing })).code, 2);
});

test('S22 stats counts: slice by extension, rule flag, human or AI, category, context, bad commit', async () => {
  // Breaks when: a count rule changes (case-blind extension, label 1 only, blank rule name is empty, other-bucket for odd values).
  const r = await cli(['stats'], { root: setup() });
  assert.equal(r.code, 0);
  const s = JSON.parse(r.out);
  assert.deepEqual(s.qodo, { rows: 2, findings: 7, inSlice: 6, byExt: { '.ts': 4, '.py': 1, '.js': 1 }, ruleNamed: 2, ruleEmpty: 4, distinctPrs: 2 });
  assert.deepEqual(s.aacr, {
    rows: 12, findings: 12, label1Total: 11, inSlice: 10, byExt: { '.py': 8, '.mjs': 1, '.ts': 1 }, human: 8, ai: 2,
    byCategory: { 'Code Defect': 6, 'Security Vulnerability': 1, Performance: 1, 'Maintainability and Readability': 1, other: 1 },
    byContext: { 'Diff Level': 6, 'File Level': 2, 'Repo Level': 1, other: 1 }, badCommit: 1,
  });
});

test('S21 stats prints counts only: no row, path, url or text', async () => {
  // Breaks when: stats prints a sample row, a path or a url.
  const r = await cli(['stats'], { root: setup({ qodo: [qrow(PR11, [issue({ file_path: 'src/SENTINEL_PATH.ts' })])] }) });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out + r.err, /SENTINEL|acme|Acme|widget|github|src\/|pkg\/|Python/i);
  assert.match(r.out, /^\{/);
});

test('S4 the slice filter is case-blind and drops every other extension', async () => {
  // Breaks when: the extension is compared case-sensitively or SLICE_EXTS grows.
  assert.deepEqual([...SLICE_EXTS], ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
  const files = ['a.TS', 'a.Tsx', 'a.JS', 'a.jsx', 'a.MJS', 'a.cjs', 'a.PY', 'a.md', 'a.json', 'a.go', 'a.d.ts.map', 'Makefile', 'a.tsx.bak', 'a.pyc'];
  const root = setup({ qodo: [qrow(PR11, files.map((f) => issue({ file_path: f })))], aacr: [] });
  const s = JSON.parse((await cli(['stats'], { root })).out);
  assert.equal(s.qodo.inSlice, 7);
  assert.deepEqual(s.qodo.byExt, { '.ts': 1, '.tsx': 1, '.js': 1, '.jsx': 1, '.mjs': 1, '.cjs': 1, '.py': 1 });
});

test('S23 the AACR json may be an array or an object holding exactly one array; anything else is refused with exit 2', async () => {
  // Breaks when: the shape check is dropped (a scalar, two arrays, no array, or a non-object row is read as rows).
  const wrap = (body) => {
    const root = setup({ aacr: [] });
    const dir = path.join(root, datasetDirName(PINS.aacr.id, PINS.aacr.sha));
    const buf = Buffer.from(JSON.stringify(body));
    writeFileSync(path.join(dir, PINS.aacr.file), buf);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: PINS.aacr.id, sha: PINS.aacr.sha, file: PINS.aacr.file, sha256: sha256(buf) }));
    return root;
  };
  const ok = await cli(['stats'], { root: wrap({ meta: 'x', rows: [arow(), arow({ label: 0 })] }) });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).aacr.rows, 2);
  for (const body of [5, 'text', null, {}, { a: [], b: [] }, { a: 'x' }, [arow(), 7], [null]]) {
    const r = await cli(['stats'], { root: wrap(body) });
    assert.equal(r.code, 2, JSON.stringify(body));
  }
});

test('S5 an AACR label 0 row never becomes a gold row', async () => {
  // Breaks when: the label === 1 filter is dropped.
  const root = setup({ qodo: [], aacr: [arow({ label: 0 }), arow({ label: 1 }), arow({ label: '1' }), arow({ label: undefined })] });
  const r = await build(root);
  assert.equal(r.code, 0);
  assert.equal(rowsOf(r.file).length, 1);
});

test('S6 S7 S9 Qodo rows: severity from the rule flag, linkType from the hunks, unpinned PR excluded', async () => {
  // Breaks when: the rule flag map flips, the hunk test or same-file test changes, or a PR with no pin is written.
  const r = await build(setup({ aacr: [] }));
  assert.equal(r.code, 0);
  const rows = rowsOf(r.file);
  assert.equal(rows.length, 5);
  const got = rows.map((x) => [x.provenance.issue, x.file, x.line ?? null, x.severity, x.linkType, x.provenance.ruleFlag]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(got, [
    [0, 'src/a.ts', 12, 'minor', 'within-hunk', true],
    [1, 'src/B.PY', 3, 'major', 'same-file', false],
    [3, 'lib/other.js', 5, 'major', 'cross-file-static', false],
    [4, 'src/a.ts', null, 'major', 'same-file', false],
    [5, 'src/a.ts', null, 'major', 'same-file', false],
  ]);
  const c = JSON.parse(r.out);
  assert.equal(c.excluded['pr-not-pinned'], 1);
  for (const x of rows) {
    assert.deepEqual(x.target, { repo: 'acme/widget', pr: 11, round: 1, sha40: HEAD });
    assert.deepEqual([x.source, x.suite, x.split], ['C', 'capability', 'holdout']);
    assert.deepEqual(x.labels, [{ by: 'qodo', verdict: 'real' }]);
    assert.deepEqual([x.provenance.severityMapVersion, x.provenance.prHead, x.provenance.prBase, x.provenance.prPinnedAt], [SEVERITY_MAP_VERSION, HEAD, BASE, PINNED_AT]);
  }
});

test('S6 S7 AACR rows: severity per category, linkType per context, line only when positive, sha lower-cased', async () => {
  // Breaks when: a category or context map entry changes, or an unknown value maps to a default.
  const r = await build(setup({ qodo: [] }));
  assert.equal(r.code, 0);
  const rows = rowsOf(r.file).sort((a, b) => a.provenance.row - b.provenance.row);
  assert.deepEqual(rows.map((x) => [x.provenance.row, x.severity, x.linkType, x.line ?? null, x.provenance.isAi]), [
    [0, 'major', 'within-hunk', 7, false],
    [2, 'major', 'same-file', 7, true],
    [3, 'minor', 'cross-file-static', 7, false],
    [4, 'minor', 'within-hunk', 7, true],
    [9, 'major', 'same-file', null, false],
  ]);
  assert.deepEqual(rows[0].target, { repo: 'acme/gizmo', pr: 5, round: 1, sha40: 'd'.repeat(40) });
  assert.deepEqual(rows[0].labels, [{ by: 'aacr', verdict: 'real' }]);
  assert.deepEqual([rows[0].provenance.srcCategory, rows[0].provenance.srcContext, rows[0].provenance.side, rows[0].provenance.dataset], ['Code Defect', 'Diff Level', 'right', PINS.aacr.id]);
});

test('S8 bad commit, category, context, repo and file are excluded and counted, not written', async () => {
  // Breaks when: an exclusion is dropped, miscounted, or turned into a default value.
  const r = await build(setup({ qodo: [] }));
  const c = JSON.parse(r.out);
  assert.deepEqual(c.excluded, { 'bad-commit': 1, 'unknown-category': 1, 'unknown-context': 1, 'bad-repo': 1, 'bad-file': 1 });
  assert.equal(c.rows.aacr, 5);
  assert.deepEqual(c.humanAi, { human: 3, ai: 2 });
});

test('S8 a Qodo repo or file that gold.mjs refuses is excluded', async () => {
  // Breaks when: the repo or file rule is not applied before the row is built.
  const rows = [qrow('https://github.com/acme/.hidden/pull/11', [issue()]), qrow(PR11, [issue({ file_path: 'a\\b.ts' }), issue({ file_path: './a.ts' })])];
  const root = setup({ qodo: rows, aacr: [], prs: { ...PINNED, 'acme/.hidden#11': mkPin() } });
  const c = JSON.parse((await build(root)).out);
  assert.deepEqual(c.excluded, { 'bad-repo': 1, 'bad-file': 2 });
  assert.equal(c.rows.qodo, 0);
});

test('S10 no dataset text is copied into the written file', async () => {
  // Breaks when: a title, description, note, snippet, rule name or model name reaches a row.
  const r = await build(setup());
  assert.equal(r.code, 0);
  const text = readFileSync(r.file, 'utf8');
  assert.ok(text.length > 100);
  assert.doesNotMatch(text, /SENTINEL/);
  assert.doesNotMatch(r.out + r.err, /SENTINEL/);
});

test('S11 ids are stable across runs, prefixed, 16 hex, and the file is sorted with a trailing newline', async () => {
  // Breaks when: the id input changes, a prefix is lost, or rows are not sorted.
  const root = setup();
  const a = await build(root, 'a.json');
  const b = await build(root, 'b.json');
  assert.equal(readFileSync(a.file, 'utf8'), readFileSync(b.file, 'utf8'));
  const text = readFileSync(a.file, 'utf8');
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.equal(text, `${JSON.stringify(rowsOf(a.file), null, 2)}\n`);
  const rows = rowsOf(a.file);
  const ids = rows.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const x of rows) assert.match(x.id, x.source === 'C' && x.labels[0].by === 'qodo' ? /^c-qodo-[0-9a-f]{16}$/ : /^c-aacr-[0-9a-f]{16}$/);
  const first = rows.find((x) => x.provenance.dataset === PINS.qodo.id && x.provenance.row === 0 && x.provenance.issue === 0);
  assert.equal(first.id, `c-qodo-${sha256(`${PINS.qodo.sha}:0:0`).slice(0, 16)}`);
});

test('S11 a duplicate id throws', () => {
  // Breaks when: the duplicate check is dropped.
  assert.doesNotThrow(() => assertUniqueIds([{ id: 'a' }, { id: 'b' }]));
  assert.throws(() => assertUniqueIds([{ id: 'a' }, { id: 'a' }]), /duplicate/);
});

test('S12 every written row passes validateRow, and loadGold accepts a gold folder holding the file', async () => {
  // Breaks when: a row key or value drifts from the gold.mjs contract.
  const r = await build(setup());
  const rows = rowsOf(r.file);
  assert.ok(rows.length >= 10);
  for (const x of rows) assert.deepEqual(validateRow(x), []);
  const dir = tmp();
  writeFileSync(path.join(dir, 'gold-c.json'), readFileSync(r.file));
  assert.equal(loadGold(dir).rows.length, rows.length);
});

test('S13 build refuses a missing pins file and a pins file for another Qodo pin', async () => {
  // Breaks when: the pins file is optional, or its qodo pin is not compared with PINS.qodo.
  const out = path.join(tmp(), 'o.json');
  const none = await cli(['build', '--out', out], { root: setup({ prs: false }) });
  assert.equal(none.code, 2);
  const root = setup({ prs: false });
  writePrs(root, PINNED, { qodo: { id: PINS.qodo.id, sha: '9'.repeat(40) } });
  const other = await cli(['build', '--out', out], { root });
  assert.equal(other.code, 2);
  assert.equal(existsSync(out), false);
});

test('S14 a row that fails validateRow exits 1 and writes nothing', async () => {
  // Breaks when: validation is skipped, or the file is written before the check.
  const root = setup({ qodo: [qrow('https://github.com/acme/widget/pull/0', [issue()])], aacr: [], prs: { 'acme/widget#0': mkPin() } });
  const r = await build(root);
  assert.equal(r.code, 1);
  assert.equal(existsSync(r.file), false);
});

test('S15 parseHunks reads the new-side range of each hunk', () => {
  // Breaks when: +c,d is read as the old side, d is not defaulted to 1, a pure deletion (+c,0) gives a range, or no patch throws.
  assert.deepEqual(parseHunks('@@ -1,3 +10,11 @@ fn\n x\n@@ -40 +50,0 @@\n@@ -5,2 +70 @@ y\n'), [[10, 20], [70, 70]]);
  assert.deepEqual(parseHunks('@@ -40 +50,0 @@\n'), []);
  assert.deepEqual(parseHunks(undefined), []);
  assert.deepEqual(parseHunks(''), []);
  assert.deepEqual(parseHunks('no hunk header here'), []);
});

test('S15 pin-prs writes the pins file: hunks, null for a file with no patch, complete when every changed file came back, the pin, the injected time, nothing else', async () => {
  // Breaks when: the output shape changes, a login or header is kept, or the time is not injected.
  const root = setup({ qodo: [QODO[0]], prs: false });
  const gh = fakeGh(GH);
  const r = await cli(['pin-prs'], { root, ghFn: gh.fn });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(gh.calls, ['repos/acme/widget/pulls/11', `repos/acme/widget/compare/${BASE}...${HEAD}`]);
  const file = readFileSync(path.join(root, PRS_FILE), 'utf8');
  assert.deepEqual(JSON.parse(file), {
    version: 3, qodo: { id: PINS.qodo.id, sha: PINS.qodo.sha }, pinnedAt: '2026-11-13T12:00:00.000Z', excluded: [],
    prs: { 'acme/widget#11': mkPin({ pinnedAt: '2026-11-13T12:00:00.000Z', files: { 'src/a.ts': [[10, 20]], 'README.md': null } }) },
  });
  assert.doesNotMatch(file + r.out + r.err, /someone|login|token|authorization/i);
  assert.doesNotMatch(r.out + r.err, /acme|widget|src\//);
});

test('S20 pin-prs skips a PR with no in-slice finding and a PR URL that does not parse', async () => {
  // Breaks when: the slice filter is missing, or a bad url reaches the API.
  const rows = [qrow(PR11, [issue()]), qrow('https://github.com/acme/docs/pull/33', [issue({ file_path: 'a.md' })]), qrow('nonsense', [issue()])];
  const gh = fakeGh(GH);
  const r = await cli(['pin-prs'], { root: setup({ qodo: rows, prs: false }), ghFn: gh.fn });
  assert.equal(r.code, 0);
  assert.equal(gh.calls.length, 2);
});

test('S16 pin-prs stops before the 150th-plus-one call and writes nothing', async () => {
  // Breaks when: the cap is dropped, checked after the call, or a partial file is written.
  assert.equal(GH_CALL_CAP, 150);
  const rows = Array.from({ length: 80 }, (_, i) => qrow(`https://github.com/acme/widget/pull/${100 + i}`, [issue()]));
  const calls = [];
  const ghFn = async (p) => {
    calls.push(p);
    return /\/pulls\//.test(p) ? { head: { sha: HEAD }, base: { sha: BASE } } : { files: [] };
  };
  const root = setup({ qodo: rows, prs: false });
  const r = await cli(['pin-prs'], { root, ghFn });
  assert.equal(r.code, 1);
  assert.equal(calls.length, GH_CALL_CAP);
  assert.equal(existsSync(path.join(root, PRS_FILE)), false);
  assert.doesNotMatch(r.out + r.err, /acme|widget/);
});

test('S17 pin-prs stops at once on a rate limit (error, HTTP 403 or 429, or a message body), with no retry and no file', async () => {
  // Breaks when: a retry is added, the status check is dropped, the rate-limit detection (rateErr, rateBody) is removed, or a partial file is written.
  const limits = [
    () => { throw new Error('API rate limit exceeded'); },
    () => { throw Object.assign(new Error('gh api failed: 403'), { status: 403 }); },
    () => { throw Object.assign(new Error('gh api failed: 429'), { status: 429 }); },
    () => ({ message: 'API Rate Limit exceeded for user' }),
  ];
  const rows = [qrow(PR11, [issue()]), qrow('https://github.com/acme/widget/pull/12', [issue()])];
  for (const limit of limits) {
    const calls = [];
    const ghFn = async (p) => {
      calls.push(p);
      if (calls.length === 2) return limit();
      return /\/pulls\//.test(p) ? { head: { sha: HEAD }, base: { sha: BASE } } : { files: [] };
    };
    const root = setup({ qodo: rows, prs: false });
    const r = await cli(['pin-prs'], { root, ghFn });
    assert.equal(r.code, 1);
    assert.match(r.err, /stopped: rate limit/, 'detected as a rate limit, not as a plain failure');
    assert.equal(calls.length, 2, 'no retry, no later call');
    assert.equal(existsSync(path.join(root, PRS_FILE)), false);
  }
});

test('S18 pin-prs refuses a PR head that moved since the recorded pin, exit 2, file unchanged', async () => {
  // Breaks when: the head compare is dropped.
  const root = setup({ prs: { 'acme/widget#11': mkPin({ head: '1'.repeat(40) }) } });
  const before = readFileSync(path.join(root, PRS_FILE), 'utf8');
  const r = await cli(['pin-prs'], { root, ghFn: fakeGh(GH).fn });
  assert.equal(r.code, 2);
  assert.equal(readFileSync(path.join(root, PRS_FILE), 'utf8'), before);
  const same = setup({ prs: { 'acme/widget#11': mkPin() } });
  assert.equal((await cli(['pin-prs'], { root: same, ghFn: fakeGh(GH).fn })).code, 0);
});

test('S19 a PR whose head or base is not 40-hex, or that answers 404, is excluded as no-head; another error aborts', async () => {
  // Breaks when: the sha check is dropped, a 404 aborts the pass, or any error is swallowed.
  const rows = [qrow(PR11, [issue()]), qrow('https://github.com/acme/widget/pull/12', [issue()]), qrow('https://github.com/acme/widget/pull/13', [issue()])];
  const ghFn = async (p) => {
    if (p.endsWith('/pulls/12')) return { head: { sha: 'xyz' }, base: { sha: BASE } };
    if (p.endsWith('/pulls/13')) throw Object.assign(new Error('gh api failed: 404'), { status: 404 });
    return /\/pulls\//.test(p) ? { head: { sha: HEAD }, base: { sha: BASE } } : { files: [], commits: [{ commit: { committer: { date: HEAD_AT } } }] };
  };
  const root = setup({ qodo: rows, prs: false });
  const r = await cli(['pin-prs'], { root, ghFn });
  assert.equal(r.code, 0, r.err);
  const pins = JSON.parse(readFileSync(path.join(root, PRS_FILE), 'utf8'));
  assert.deepEqual(Object.keys(pins.prs), ['acme/widget#11']);
  assert.deepEqual(pins.excluded, [{ key: 'acme/widget#12', reason: 'no-head' }, { key: 'acme/widget#13', reason: 'no-head' }]);
  const boom = await cli(['pin-prs'], { root: setup({ prs: false }), ghFn: async () => { throw Object.assign(new Error('gh api failed: 500'), { status: 500 }); } });
  assert.equal(boom.code, 1);
});

test('S18b pin-prs refuses a PR whose base moved while the head stayed, exit 2, file unchanged', async () => {
  // Breaks when: only the head is compared, so a base-only change replaces the recorded hunks.
  const root = setup({ prs: { 'acme/widget#11': mkPin({ base: '1'.repeat(40) }) } });
  const before = readFileSync(path.join(root, PRS_FILE), 'utf8');
  const r = await cli(['pin-prs'], { root, ghFn: fakeGh(GH).fn });
  assert.equal(r.code, 2);
  assert.equal(readFileSync(path.join(root, PRS_FILE), 'utf8'), before);
});

test('S24 an AACR row that is not on the head (right) side is excluded as not-head-side, never paired with the head sha', async () => {
  // Breaks when: a left-side line (an old-file line) or a row with no side is written against the head commit.
  const root = setup({ qodo: [], aacr: [arow(), arow({ side: 'left' }), arow({ side: undefined }), arow({ side: 'LEFT' })] });
  const r = await build(root);
  assert.equal(r.code, 0, r.err);
  const c = JSON.parse(r.out);
  assert.equal(c.rows.aacr, 1);
  assert.equal(c.excluded['not-head-side'], 3);
});

test('S25 pin-prs marks a compare that lost files as incomplete', async () => {
  // Breaks when: a cut-off compare (fewer files than changed_files) is recorded as complete.
  const gh = fakeGh({ 'acme/widget#11': { ...GH['acme/widget#11'], changed: 3 } });
  const root = setup({ qodo: [QODO[0]], prs: false });
  const r = await cli(['pin-prs'], { root, ghFn: gh.fn });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(readFileSync(path.join(root, PRS_FILE), 'utf8')).prs['acme/widget#11'].complete, false);
});

test('S25 build excludes a Qodo linkType it cannot prove: a file missing from an incomplete compare, a line in a file with no patch', async () => {
  // Breaks when: a missing file is called cross-file-static on a cut-off compare, or a no-patch file is called same-file.
  const prs = { 'acme/widget#11': mkPin({ complete: false, files: { 'src/a.ts': [[10, 20]], 'src/B.PY': null } }) };
  const r = await build(setup({ qodo: [QODO[0]], aacr: [], prs }));
  assert.equal(r.code, 0, r.err);
  const c = JSON.parse(r.out);
  assert.equal(c.excluded['link-unproven'], 2);
  assert.equal(c.rows.qodo, 3);
  assert.deepEqual(c.linkType, { 'within-hunk': 1, 'same-file': 2 });
});

test('S13b build refuses a version 1 or 2 pins file (no complete flag, no headAt or per-PR pinnedAt), so old pins are pinned again', async () => {
  // Breaks when: build reads a pins file that cannot say whether a compare was cut off or when the head was made.
  assert.equal(PRS_VERSION, 3);
  for (const version of [1, 2]) {
    const root = setup({ prs: false });
    writePrs(root, PINNED, { version });
    const r = await build(root);
    assert.equal(r.code, 2, `version ${version}`);
    assert.match(r.err, /Run pin-prs again/);
  }
});

test('S19 build counts a Qodo PR that pin-prs excluded as pr-not-pinned', async () => {
  // Breaks when: an excluded PR is looked up with a guessed head.
  const root = setup({ aacr: [], prs: {} });
  const c = JSON.parse((await build(root)).out);
  assert.equal(c.excluded['pr-not-pinned'], 6);
});

const goldRow = (prov = {}, over = {}) => ({ labels: [{ by: 'qodo', verdict: 'real' }], target: { repo: 'acme/widget', pr: 11 }, provenance: { prHead: HEAD, prBase: BASE, prPinnedAt: '2026-11-01T00:00:00.000Z', ...prov }, ...over });
const writeGold = (rows) => {
  const file = path.join(tmp(), 'gold-c.json');
  writeFileSync(file, JSON.stringify(rows));
  return file;
};
const pinsOf = (root) => JSON.parse(readFileSync(path.join(root, PRS_FILE), 'utf8'));

test('S26 pin-prs with no pins file compares a new head or base with the committed gold file, and refuses a move with nothing written', async () => {
  // Breaks when: cmdPinPrs reads only the git-ignored pins file, or the gold compare skips head or base, or counts a non-Qodo row.
  for (const moved of [{ prHead: '1'.repeat(40) }, { prBase: '1'.repeat(40) }]) {
    const root = setup({ qodo: [QODO[0]], prs: false });
    const r = await cli(['pin-prs'], { root, ghFn: fakeGh(GH).fn, goldFile: writeGold([goldRow(moved)]) });
    assert.equal(r.code, 2, JSON.stringify(moved));
    assert.equal(existsSync(path.join(root, PRS_FILE)), false);
  }
  const same = setup({ qodo: [QODO[0]], prs: false });
  const ok = await cli(['pin-prs'], { root: same, ghFn: fakeGh(GH).fn, goldFile: writeGold([goldRow()]) });
  assert.equal(ok.code, 0, ok.err);
  const aacr = goldRow({ prHead: undefined }, { labels: [{ by: 'aacr', verdict: 'real' }] });
  const skip = setup({ qodo: [QODO[0]], prs: false });
  assert.equal((await cli(['pin-prs'], { root: skip, ghFn: fakeGh(GH).fn, goldFile: writeGold([aacr]) })).code, 0);
});

test('S26 a PR in the gold file keeps its prPinnedAt when its head and base did not move', async () => {
  // Breaks when: the pin takes the run time instead of the recorded gold prPinnedAt.
  const root = setup({ qodo: [QODO[0]], prs: false });
  const r = await cli(['pin-prs'], { root, ghFn: fakeGh(GH).fn, goldFile: writeGold([goldRow()]) });
  assert.equal(r.code, 0, r.err);
  assert.equal(pinsOf(root).prs['acme/widget#11'].pinnedAt, '2026-11-01T00:00:00.000Z');
});

test('S27 a PR whose head commit is after the dataset date, or has no usable date, is excluded as head-after-dataset; the last commit decides', async () => {
  // Breaks when: the headAt check is dropped, the first commit is read instead of the last, or a missing or bad date passes.
  assert.equal(QODO_DATASET_AT, '2026-02-03T19:01:08Z');
  const late = { commit: { committer: { date: '2026-03-01T00:00:00Z' } } };
  const early = { commit: { committer: { date: '2026-01-01T00:00:00Z' } } };
  const edge = { commit: { committer: { date: QODO_DATASET_AT } } };
  const cases = [
    [{ headAt: '2026-03-01T00:00:00Z' }, 'head-after-dataset'], [{ commits: [] }, 'head-after-dataset'],
    [{ headAt: 'not a date' }, 'head-after-dataset'], [{ commits: [{ commit: {} }] }, 'head-after-dataset'],
    [{ commits: [early, late] }, 'head-after-dataset'], [{ commits: [late, early] }, 'pinned'], [{ commits: [edge] }, 'pinned'],
  ];
  for (const [over, want] of cases) {
    const root = setup({ qodo: [QODO[0]], prs: false });
    const r = await cli(['pin-prs'], { root, ghFn: fakeGh({ 'acme/widget#11': { ...GH['acme/widget#11'], ...over } }).fn });
    assert.equal(r.code, 0, r.err);
    const pins = pinsOf(root);
    assert.deepEqual(want === 'pinned' ? Object.keys(pins.prs) : pins.excluded, want === 'pinned' ? ['acme/widget#11'] : [{ key: 'acme/widget#11', reason: want }], JSON.stringify(over));
    if (want !== 'pinned') assert.equal(JSON.parse(r.out).excluded['head-after-dataset'], 1);
  }
});

test('S27 a PR with a head before the dataset date is pinned with headAt (ISO, committer date, else author date)', async () => {
  // Breaks when: headAt is not recorded, is not normalised to ISO, or the author-date fallback is dropped.
  const root = setup({ qodo: [QODO[0]], prs: false });
  const r = await cli(['pin-prs'], { root, ghFn: fakeGh(GH).fn });
  assert.equal(r.code, 0, r.err);
  assert.equal(pinsOf(root).prs['acme/widget#11'].headAt, HEAD_AT);
  const author = setup({ qodo: [QODO[0]], prs: false });
  const commits = [{ commit: { author: { date: '2026-01-05T10:00:00Z' } } }];
  await cli(['pin-prs'], { root: author, ghFn: fakeGh({ 'acme/widget#11': { ...GH['acme/widget#11'], commits } }).fn });
  assert.equal(pinsOf(author).prs['acme/widget#11'].headAt, '2026-01-05T10:00:00.000Z');
});

test('S28 a PR with a recorded pin that is now gone, has no usable sha or a head after the dataset is a refusal, exit 2, nothing written', async () => {
  // Breaks when: pinAll drops a previously pinned PR into excluded instead of refusing (pins file or gold file).
  const late = fakeGh({ 'acme/widget#11': { ...GH['acme/widget#11'], headAt: '2026-03-01T00:00:00Z' } }).fn;
  const badSha = async () => ({ head: { sha: 'xyz' }, base: { sha: BASE } });
  for (const ghFn of [fakeGh({}).fn, badSha, late]) {
    const root = setup({ qodo: [QODO[0]], prs: { 'acme/widget#11': mkPin() } });
    const before = readFileSync(path.join(root, PRS_FILE), 'utf8');
    const r = await cli(['pin-prs'], { root, ghFn });
    assert.equal(r.code, 2);
    assert.equal(readFileSync(path.join(root, PRS_FILE), 'utf8'), before);
    const fresh = setup({ qodo: [QODO[0]], prs: false });
    assert.equal((await cli(['pin-prs'], { root: fresh, ghFn, goldFile: writeGold([goldRow()]) })).code, 2);
    assert.equal(existsSync(path.join(fresh, PRS_FILE)), false);
  }
});

test('S29 a second pin-prs run at a later time keeps the first pinnedAt of an unchanged PR, and two builds are byte-identical', async () => {
  // Breaks when: pinnedAt is rewritten on every run (prPinnedAt of every Qodo row changes without a moved pin).
  const root = setup({ prs: false });
  assert.equal((await cli(['pin-prs'], { root, ghFn: fakeGh(GH).fn })).code, 0);
  const first = await build(root, 'a.json');
  const later = await cli(['pin-prs'], { root, ghFn: fakeGh(GH).fn, now: () => NOW + 3600 * 1000 });
  assert.equal(later.code, 0, later.err);
  const pins = pinsOf(root);
  assert.equal(pins.pinnedAt, '2026-11-13T13:00:00.000Z');
  assert.equal(pins.prs['acme/widget#11'].pinnedAt, '2026-11-13T12:00:00.000Z');
  const second = await build(root, 'b.json');
  assert.equal(readFileSync(second.file, 'utf8'), readFileSync(first.file, 'utf8'));
  assert.ok(rowsOf(first.file).every((x) => x.labels[0].by !== 'qodo' || x.provenance.prPinnedAt === '2026-11-13T12:00:00.000Z'));
});

test('S30 a Qodo line at a hunk edge: 9 and 21 are same-file, 10 and 20 are within-hunk', async () => {
  // Breaks when: the hunk compare is made strict (> or <), or the end is read as exclusive.
  const issues = [9, 10, 20, 21].map((n) => issue({ start_line: n }));
  const prs = { 'acme/widget#11': mkPin({ files: { 'src/a.ts': [[10, 20]] } }) };
  const r = await build(setup({ qodo: [qrow(PR11, issues)], aacr: [], prs }));
  assert.equal(r.code, 0, r.err);
  const got = rowsOf(r.file).sort((a, b) => a.provenance.issue - b.provenance.issue).map((x) => [x.line, x.linkType]);
  assert.deepEqual(got, [[9, 'same-file'], [10, 'within-hunk'], [20, 'within-hunk'], [21, 'same-file']]);
});

test('S31 main with no fileSha256 key uses the production FILE_SHA256 and refuses made-up files', async () => {
  // Breaks when: the default of deps.fileSha256 becomes null, so the production run reads any file that matches its manifest.
  const err = [];
  const code = await main(['stats'], { root: setup(), stdout: () => {}, stderr: (s) => err.push(String(s)), now: () => NOW });
  assert.equal(code, 2);
  assert.match(err.join('\n'), /FILE_SHA256/);
});
