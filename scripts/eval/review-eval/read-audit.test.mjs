// Failure modes of the answer-key read audit (re-answer-key-audit). Each test names the change that breaks it.
//  V1-V4  primary-checkout read in 4 path forms   -> drop the backslash fold, the drive lower-case, the /c/ map or the \\?\ strip
//  mirror an in-tree read in the same 4 forms      -> the same change makes a fold fail in the other direction (a clean run voids)
//  V5-V9  `..`, grep path, glob dir, grep glob arg, relatedCursorRulePaths -> walk a name list instead of every string
//  V10-V12 unknown kind, no *ToolCall key, hook context -> turn the allow list into a deny list, skip such events, drop the check
//  V13-V15 no init, init cwd of another form, empty or missing stream -> default the tree, test the prefix only, let an empty list pass
//  V16 / N2 symlink to the primary checkout, failed ls-tree -> drop the mode filter, the target check or the failure rule
//  G1-G9  glob `files` exemption (seat answer 3, B and C): `../.\` + a tracked path or one of 5 harness files at tree level, `../` + the folder path + a tracked path for a folder call
//         -> accept another start, drop the head list, drop the answer-key check on the rest, strip two leading .., resolve against targetDirectory
//  D1-D4  brace patterns; T1-T2 event types; F8-F9 stream gaps; E1-E2 a failed state write; A6-A8 symlinkCheck and the head list
//  Prefix rule (~ % $ file:), no-tool-call, content skip, answer-key whole-segment match, pattern echo skip
//  S1-S5 summary, L1 newest line, C1-C3 scan counts only, A1-A4 auditReplay, CLI modes
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { appendLine, AUDIT_VERSION, auditFile, auditReplay, auditStream, checkHeadSymlinks, defaultStatePath, main, newestByRunId, readLines, summarize } from './read-audit.mjs';

// ---- synthetic world: the tmpdir, the tree and the "primary checkout" are injected strings, nothing on this machine ----
const TMP = 'C:\\fake\\tmp';
const TREE = `${TMP}\\cursor-review-abc123\\tree`;
const PRIMARY = 'C:\\work\\primary';
const OPTS = { tmpdir: TMP };
const CLEAN = ['init', 'glob', 'read', 'grep', 'tail'];

const FIX = new URL('./fixtures/read-audit/', import.meta.url);
const template = (name) => readFileSync(new URL(`${name}.jsonl`, FIX), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const swap = (s, vars) => Object.entries(vars).reduce((a, [k, v]) => a.split(`{{${k}}}`).join(v), s);
function fill(v, vars) {
  if (typeof v === 'string') return swap(v, vars);
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [swap(k, vars), fill(x, vars)]));
  return v;
}
const events = (names, vars = {}) => names.flatMap((n) => fill(template(n), { TREE, PRIMARY, ...vars }));
const text = (evs) => `${evs.map((e) => JSON.stringify(e)).join('\n')}\n`;
const audit = (evs, opts = {}) => auditStream(text(evs), { ...OPTS, ...opts });
const calls = (evs, kind) => evs.filter((e) => e.tool_call?.[`${kind}ToolCall`]);
const body = (ev, kind) => ev.tool_call[`${kind}ToolCall`];
const hit = (r, rule, want = {}) => r.rules.some((x) => x.rule === rule && Object.entries(want).every(([k, v]) => x[k] === v));
const names = (r) => [...new Set(r.rules.map((x) => x.rule))].sort();
const adhoc = (kind, args, extra = {}) => ({ type: 'tool_call', subtype: 'started', call_id: 'x1', tool_call: { [`${kind}ToolCall`]: { args }, hookAdditionalContexts: [], toolCallId: 'x1', ...extra } });

function setReadPath(evs, p) {
  for (const e of calls(evs, 'read')) { const b = body(e, 'read'); b.args.path = p; if (b.result) b.result.success.path = p; }
}
function setGrep(evs, fn) { for (const e of calls(evs, 'grep')) fn(body(e, 'grep')); }
/** td: undefined keeps the template, null removes targetDirectory, a string sets it (and the result path). */
function setGlob(evs, { td, files }) {
  for (const e of calls(evs, 'glob')) {
    const b = body(e, 'glob');
    if (td === null) delete b.args.targetDirectory; else if (td !== undefined) b.args.targetDirectory = td;
    if (b.result) { if (td !== undefined) b.result.success.path = td ?? ''; if (files) b.result.success.files = files; }
  }
}

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'read-audit-'));
function put(dir, name, evs) {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  const t = typeof evs === 'string' ? evs : text(evs);
  writeFileSync(file, name.endsWith('.gz') ? gzipSync(t) : t);
  return file;
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function io(extra = {}) {
  const buf = [];
  return { out: (s) => buf.push(String(s)), err: (s) => buf.push(String(s)), text: () => buf.join(''), tmpdir: TMP, env: {}, ...extra };
}

// ---- baseline ----
test('a clean stream with glob, read and grep passes and counts its calls', () => {
  // Breaks when: an in-tree path counts as outside, or the grep / glob shape is not understood.
  const r = audit(events(CLEAN));
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.rules, []);
  assert.equal(r.counts.toolCalls, 3);
  assert.equal(r.counts.read, 1);
  assert.equal(r.counts.grep, 1);
  assert.equal(r.counts.glob, 1);
  assert.equal(r.model, 'Grok 4.7 256K High');
});

// ---- V1-V4: the primary checkout's linktype-labels.json in four forms ----
const FORMS = { 'C:\\': 'C:\\work\\primary', 'c:/': 'c:/work/primary', '/c/': '/c/work/primary', '\\\\?\\C:\\': '\\\\?\\C:\\work\\primary' };
for (const [label, form] of Object.entries(FORMS)) {
  test(`V1-V4 a read of the primary linktype-labels.json as ${label} voids with answer-key`, () => {
    // Breaks when: the backslash fold, the drive lower-case, the /c/ map or the \\?\ strip is removed, for the form named in the title (see the mirror test).
    const r = audit(events(['init', 'read-outside', 'tail'], { PRIMARY: form }));
    assert.equal(r.verdict, 'void');
    assert.ok(hit(r, 'outside-path', { tool: 'read', field: 'args.path', answerKey: true }), JSON.stringify(r.rules));
    assert.ok(hit(r, 'answer-key'));
  });
}
const TREE_FORMS = { 'C:\\': TREE, 'c:/': 'c:/fake/tmp/cursor-review-abc123/tree', '/c/': '/c/fake/tmp/cursor-review-abc123/tree', '\\\\?\\C:\\': `\\\\?\\${TREE}`, 'C:\\ with upper case folder': TREE.toUpperCase().replace('C:', 'c:') };
for (const [label, form] of Object.entries(TREE_FORMS)) {
  test(`mirror: a read of a file inside the tree as ${label} passes`, () => {
    // Breaks when: the fold of that form is removed. The in-tree read then looks outside, so the clean run voids. Without this mirror a fold removal hides, because an outside path voids in every form.
    const evs = events(['init', 'read', 'tail']);
    setReadPath(evs, `${form}/src/a.mjs`);
    const r = audit(evs);
    assert.equal(r.verdict, 'pass', JSON.stringify(r.rules));
  });
}

// ---- V5-V9 ----
test('V5 a read path whose text starts inside the tree but climbs out with .. voids', () => {
  // Breaks when: the text prefix is compared before .. is resolved.
  const evs = events(['init', 'read', 'tail']);
  setReadPath(evs, `${TREE}\\..\\..\\x`);
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'read', field: 'args.path' }));
});

test('V5b a read path of the form ..\\<name> voids (the exemption is for glob files only)', () => {
  // Breaks when: the glob-parent-name exemption is applied to every field.
  const evs = events(['init', 'read', 'tail']);
  setReadPath(evs, '..\\x');
  assert.equal(audit(evs).verdict, 'void');
});

test('V6 a grep path outside the tree voids', () => {
  // Breaks when: the walker skips args.path on grep.
  const evs = events(CLEAN);
  setGrep(evs, (b) => { b.args.path = PRIMARY; });
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'grep', field: 'args.path' }));
});

test('V7 a glob targetDirectory outside the tree voids', () => {
  // Breaks when: the walker uses a name list without targetDirectory.
  const evs = events(CLEAN);
  setGlob(evs, { td: PRIMARY });
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'glob', field: 'args.targetDirectory' }));
});

test('V8 an absolute outside grep glob argument voids', () => {
  // Breaks when: glob is skipped together with pattern on grep.
  const evs = events(CLEAN);
  setGrep(evs, (b) => { b.args.glob = `${PRIMARY}\\**`; });
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'grep', field: 'args.glob' }));
});

test('V9 a relatedCursorRulePaths entry outside the tree voids', () => {
  // Breaks when: the walker does not go into arrays.
  const evs = events(['init', 'read', 'tail']);
  for (const e of calls(evs, 'read')) { const b = body(e, 'read'); if (b.result) b.result.success.relatedCursorRulePaths = [`${PRIMARY}\\.cursor\\rules\\a.mdc`]; }
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'read', field: 'result.success.relatedCursorRulePaths[0]' }));
});

test('V17 a workspaceResults key outside the tree voids and the field name holds no key text', () => {
  // Breaks when: the walker reads values only, or writes the key into the field name.
  const evs = events(CLEAN);
  setGrep(evs, (b) => { if (b.result) b.result.success.workspaceResults = { [`${PRIMARY}\\x`]: { content: {} } }; });
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(r.rules.some((x) => x.rule === 'outside-path' && /workspaceResults\.\{key\}$/.test(x.field)), JSON.stringify(r.rules));
  assert.equal(JSON.stringify(r.rules).includes('primary'), false);
});

// ---- V10-V12 ----
test('V10 a shellToolCall voids with unknown-kind', () => {
  // Breaks when: the allow list (read, grep, glob) becomes a deny list.
  const r = audit([...events(CLEAN), adhoc('shell', { command: 'dir' })]);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'unknown-kind', { tool: 'shell' }));
});

test('V10b a kind that is new to the agent (mcp, readLints) voids with unknown-kind', () => {
  // Breaks when: only a fixed list of bad kinds (shell) is refused.
  for (const kind of ['mcp', 'readLints', 'subagent']) {
    const r = audit([...events(CLEAN), adhoc(kind, {})]);
    assert.equal(r.verdict, 'void', kind);
    assert.ok(hit(r, 'unknown-kind'), kind);
  }
});

test('V11 a tool_call with no *ToolCall key voids', () => {
  // Breaks when: such events are skipped.
  const r = audit([...events(CLEAN), { type: 'tool_call', subtype: 'started', call_id: 'x2', tool_call: { hookAdditionalContexts: [] } }]);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'unknown-kind'));
});

test('V12 a non-empty hookAdditionalContexts voids', () => {
  // Breaks when: the hook-context check is removed.
  const evs = events(CLEAN);
  calls(evs, 'read')[0].tool_call.hookAdditionalContexts = ['extra context'];
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'hook-context', { tool: 'read' }));
});

// ---- V13-V15 ----
test('V13 a stream with no init event voids', () => {
  // Breaks when: the tree defaults to the stream folder or the process cwd.
  const r = audit(events(['read', 'tail']));
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'no-init'));
});

test('V14 an init cwd that is not <tmpdir>\\cursor-review-<id>\\tree voids, near misses included', () => {
  // Breaks when: the tree-form test becomes a prefix test, loses its segment boundary, or the id may be empty.
  const bad = [
    'C:\\Users\\x\\scratch\\stream-precheck',
    `${TMP}\\cursor-review-abc123`,
    `${TREE}\\sub`,
    `${TMP}\\extra\\cursor-review-abc123\\tree`,
    `${TMP}\\other-abc123\\tree`,
    `${TMP}\\cursor-review-\\tree`,
    `${TMP}2\\cursor-review-abc123\\tree`,
  ];
  for (const cwd of bad) {
    const r = audit(events(['init', 'read', 'tail'], { TREE: cwd }));
    assert.ok(hit(r, 'tree-form'), cwd);
    assert.equal(r.verdict, 'void', cwd);
  }
});

test('V14b the tree-form test is case-blind and takes both slash forms', () => {
  // Breaks when: the tree-form regex is case-sensitive or accepts one slash form.
  const r = audit(events(CLEAN, { TREE: 'c:/FAKE/tmp/cursor-review-ABC123/Tree' }));
  assert.equal(r.verdict, 'pass', JSON.stringify(r.rules));
});

test('V14c the default tmpdir is os.tmpdir()', () => {
  // Breaks when: the default tmpdir is a fixed string.
  const tree = path.join(os.tmpdir(), 'cursor-review-abc123', 'tree');
  const r = auditStream(text(events(CLEAN, { TREE: tree })), {});
  assert.equal(r.verdict, 'pass', JSON.stringify(r.rules));
});

test('V15 an empty stream and a missing file void with no-stream', () => {
  // Breaks when: an empty event list passes.
  const dir = tmpDir();
  const empty = put(dir, 'empty.raw.json', '');
  assert.ok(hit(auditFile(empty, OPTS), 'no-stream'));
  assert.equal(auditFile(empty, OPTS).verdict, 'void');
  const missing = auditFile(path.join(dir, 'nope.raw.json'), OPTS);
  assert.equal(missing.verdict, 'void');
  assert.ok(hit(missing, 'no-stream'));
  assert.equal(auditStream('', OPTS).verdict, 'void');
});

test('V15b a gz file that holds nothing, and a corrupt gz file, void', () => {
  // Breaks when: a failed gunzip throws out of the audit or is read as a clean empty list.
  const dir = tmpDir();
  assert.equal(auditFile(put(dir, 'a.stream.jsonl.gz', ''), OPTS).verdict, 'void');
  const bad = path.join(dir, 'b.stream.jsonl.gz');
  writeFileSync(bad, 'this is not gzip');
  const r = auditFile(bad, OPTS);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'unparsable') || hit(r, 'no-stream'));
});

// ---- V16 / N2 symlinks ----
const OID = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const lsLine = (mode, name) => `${mode} blob ${OID}\t${name}\0`;
function scriptedLs({ ls = '', target = '', lsStatus = 0, catStatus = 0 } = {}) {
  const seen = [];
  const git = (args) => {
    seen.push(args);
    if (args[0] === 'ls-tree') return { status: lsStatus, stdout: ls, stderr: '' };
    if (args[0] === 'cat-file') return { status: catStatus, stdout: target, stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  return { git, seen };
}

test('V16a a head with a mode 120000 entry that points at the primary checkout voids', () => {
  // Breaks when: the mode filter or the absolute-target check is removed.
  const { git } = scriptedLs({ ls: lsLine('120000', 'link'), target: PRIMARY });
  const rules = checkHeadSymlinks({ git, head: HEAD });
  assert.ok(rules.some((x) => x.rule === 'symlink'), JSON.stringify(rules));
  const r = auditStream(text(events(CLEAN)), { ...OPTS, symlinks: rules });
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'symlink'));
});

test('V16a2 ls-tree is run recursively with -z on the head', () => {
  // Breaks when: the call drops -r (a nested link is missed) or -z (a name with a newline splits).
  const { git, seen } = scriptedLs();
  checkHeadSymlinks({ git, head: HEAD });
  const ls = seen.find((a) => a[0] === 'ls-tree');
  assert.ok(ls.includes('-r') && ls.includes('-z') && ls.includes(HEAD), JSON.stringify(ls));
});

test('P4 a regular file (mode 100644) whose text is the primary path is not a symlink', () => {
  // Breaks when: the mode filter is removed and every blob is read as a link target.
  const { git, seen } = scriptedLs({ ls: lsLine('100644', 'notes.txt'), target: PRIMARY });
  assert.deepEqual(checkHeadSymlinks({ git, head: HEAD }), []);
  assert.equal(seen.some((a) => a[0] === 'cat-file'), false);
});

test('P4b a symlink target is judged from the folder of the link', () => {
  // Breaks when: the target is resolved from the repo root instead of dirname(name).
  const inside = scriptedLs({ ls: lsLine('120000', 'a/b/link'), target: '../../x' });
  assert.deepEqual(checkHeadSymlinks({ git: inside.git, head: HEAD }), []);
  const outside = scriptedLs({ ls: lsLine('120000', 'a/b/link'), target: '../../../x' });
  assert.ok(checkHeadSymlinks({ git: outside.git, head: HEAD }).some((x) => x.rule === 'symlink'));
});

test('P4c absolute targets in every form void, a relative inside target passes', () => {
  // Breaks when: the absolute test knows one form only.
  for (const target of ['C:\\x', 'c:/x', '/c/x', '/etc/x', '\\\\server\\share\\x', '~/x']) {
    const { git } = scriptedLs({ ls: lsLine('120000', 'link'), target });
    assert.ok(checkHeadSymlinks({ git, head: HEAD }).some((x) => x.rule === 'symlink'), target);
  }
  const ok = scriptedLs({ ls: lsLine('120000', 'link'), target: 'src/a.mjs' });
  assert.deepEqual(checkHeadSymlinks({ git: ok.git, head: HEAD }), []);
});

const gitIn = (dir) => (args) => {
  try { return { status: 0, stdout: execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }), stderr: '' }; } catch (e) { return { status: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? '') }; }
};
function repoWithLink(target) {
  const dir = tmpDir();
  const run = (input, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, ...(input === null ? {} : { input }) }).trim();
  run(null, 'init', '-q', '-b', 'main');
  run(null, 'config', 'user.email', 't@t'); run(null, 'config', 'user.name', 't'); run(null, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'f.txt'), '1');
  run(null, 'add', 'f.txt');
  const oid = run(target, 'hash-object', '-w', '--stdin');
  run(null, 'update-index', '--add', '--cacheinfo', `120000,${oid},link`);
  run(null, 'commit', '-qm', 'c1');
  return { dir, head: run(null, 'rev-parse', 'HEAD') };
}

test('V16b a real repo with a mode 120000 entry whose target is ../../.. voids', () => {
  // Breaks when: a relative escape is not resolved. No symlink right is needed: the entry is made with update-index.
  const { dir, head } = repoWithLink('../../..');
  const rules = checkHeadSymlinks({ git: gitIn(dir), head });
  assert.ok(rules.some((x) => x.rule === 'symlink'), JSON.stringify(rules));
});

test('V16c a real repo with a link to a file inside the tree passes', () => {
  // Breaks when: every mode 120000 entry voids.
  const { dir, head } = repoWithLink('f.txt');
  assert.deepEqual(checkHeadSymlinks({ git: gitIn(dir), head }), []);
});

test('N2 a failed git ls-tree voids with symlink-check-failed', () => {
  // Breaks when: a non-zero ls-tree status is read as "no symlinks".
  const { git } = scriptedLs({ lsStatus: 128 });
  const rules = checkHeadSymlinks({ git, head: HEAD });
  assert.ok(rules.some((x) => x.rule === 'symlink-check-failed'), JSON.stringify(rules));
  assert.equal(auditStream(text(events(CLEAN)), { ...OPTS, symlinks: rules }).verdict, 'void');
});

test('N2b a failed cat-file on a link voids with symlink-check-failed', () => {
  // Breaks when: a link whose target cannot be read passes.
  const { git } = scriptedLs({ ls: lsLine('120000', 'link'), catStatus: 128 });
  assert.ok(checkHeadSymlinks({ git, head: HEAD }).some((x) => x.rule === 'symlink-check-failed'));
});

test('a missing head or git gives no rules (the check did not run)', () => {
  // Breaks when: a missing head is read as a failure that voids every stream with no repo.
  assert.deepEqual(checkHeadSymlinks({ git: null, head: HEAD }), []);
  assert.deepEqual(checkHeadSymlinks({ git: scriptedLs().git, head: null }), []);
});

// ---- N1 ----
test('N1 a stream with an init and a result but no tool call voids with no-tool-call only', () => {
  // Breaks when: an empty call list passes.
  const r = audit(events(['init', 'tail']));
  assert.equal(r.verdict, 'void');
  assert.deepEqual(names(r), ['no-tool-call']);
});

// ---- pass cases ----
test('P1 an empty path passes', () => {
  // Breaks when: an empty string counts as a path.
  const evs = events(['init', 'read', 'tail']);
  setReadPath(evs, '');
  assert.equal(audit(evs).verdict, 'pass');
});

test('P2 a path relative to the tree passes', () => {
  // Breaks when: a relative path counts as outside.
  const evs = events(['init', 'read', 'tail']);
  setReadPath(evs, 'src\\a.mjs');
  assert.equal(audit(evs).verdict, 'pass');
});

test('P3 a read of holdout.json inside the tree passes with no answer-key rule', () => {
  // Breaks when: answer-key segments are matched inside the tree.
  for (const rel of ['holdout.json', '.git\\config', '.claudedocs\\x.md', 'scripts\\eval\\review-eval\\gold\\a.json']) {
    const evs = events(['init', 'read', 'tail']);
    setReadPath(evs, `${TREE}\\${rel}`);
    const r = audit(evs);
    assert.equal(r.verdict, 'pass', rel);
    assert.equal(hit(r, 'answer-key'), false, rel);
  }
});

test('P5 file content and contentBlobId are not read as paths', () => {
  // Breaks when: the walker enters content or contentBlobId.
  const evs = events(['init', 'read', 'tail']);
  for (const e of calls(evs, 'read')) {
    const b = body(e, 'read');
    if (b.result) { b.result.success.content = `${PRIMARY}\\linktype-labels.json`; b.result.success.contentBlobId = `${PRIMARY}\\blob`; }
  }
  assert.equal(audit(evs).verdict, 'pass');
});

test('P6 a $ or % or ~ inside a path, not at its start, passes', () => {
  // Breaks when: the prefix rule tests for the character anywhere in the string.
  const evs = events(['init', 'read', 'tail']);
  setReadPath(evs, 'src\\$lib\\100%~a.mjs');
  assert.equal(audit(evs).verdict, 'pass');
});

// ---- X ----
test('X1 an outside .github is not tagged answer-key, an outside .git is, and review-eval/gold is a whole-segment match', () => {
  // Breaks when: the answer-key match is a substring match.
  const one = (rel) => { const evs = events(['init', 'read', 'tail']); setReadPath(evs, `${PRIMARY}\\${rel}`); return audit(evs); };
  const gh = one('.github\\workflows\\x.yml');
  assert.equal(gh.verdict, 'void');
  assert.equal(hit(gh, 'outside-path', { answerKey: true }), false);
  assert.ok(hit(one('.git\\config'), 'outside-path', { answerKey: true }));
  assert.ok(hit(one('scripts\\eval\\review-eval\\gold\\a.json'), 'outside-path', { answerKey: true }));
  assert.equal(hit(one('scripts\\eval\\review-eval\\goldfish\\a.json'), 'outside-path', { answerKey: true }), false);
  assert.ok(hit(one('.claudedocs\\e2e\\x.txt'), 'outside-path', { answerKey: true }));
});

test('X2 the grep pattern and its result echo may look like an absolute path', () => {
  // Breaks when: the pattern echo (result.success.pattern) is walked.
  const evs = events(CLEAN);
  setGrep(evs, (b) => { b.args.pattern = '/abs/outside/x'; if (b.result) b.result.success.pattern = '/abs/outside/x'; });
  assert.equal(audit(evs).verdict, 'pass');
});

test('X2b a glob pattern that is an absolute outside path voids (only the grep pattern is exempt)', () => {
  // Breaks when: pattern is skipped on every kind.
  const evs = events(CLEAN);
  for (const e of calls(evs, 'glob')) { const b = body(e, 'glob'); b.args.globPattern = `${PRIMARY}\\**`; }
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'glob', field: 'args.globPattern' }));
});

test('X3 a path in a sibling folder <tree>2 voids', () => {
  // Breaks when: the inside test has no segment boundary.
  const evs = events(['init', 'read', 'tail']);
  setReadPath(evs, `${TREE}2\\a`);
  assert.equal(audit(evs).verdict, 'void');
});

test('X4 a line that is not JSON voids with unparsable', () => {
  // Breaks when: parse errors are skipped.
  const lines = text(events(CLEAN)).split('\n');
  lines.splice(3, 0, '{"type":"tool_call","tool_call":{"readTool');
  const r = auditStream(lines.join('\n'), OPTS);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'unparsable'));
});

// ---- prefix rule: one test per form ----
const PREFIX = { tilde: '~\\continuous-claude\\scripts\\eval\\review-eval\\linktype-labels.json', percent: '%USERPROFILE%\\x', dollar: '$HOME/x', 'file:': 'file:///c:/work/primary/x' };
for (const [label, p] of Object.entries(PREFIX)) {
  test(`prefix rule: a read path that starts with ${label} voids as outside`, () => {
    // Breaks when: the prefix rule drops this form. The string is neither absolute nor a .. path, so it would pass as tree-relative.
    const evs = events(['init', 'read', 'tail']);
    setReadPath(evs, p);
    const r = audit(evs);
    assert.equal(r.verdict, 'void');
    assert.ok(hit(r, 'prefix-path', { tool: 'read', field: 'args.path' }), JSON.stringify(r.rules));
  });
}

// ---- G: glob files exemption (glob-parent-name). Seat answer 3, points B and C. ----
// A `files` entry with a leading .. segment is exempt or it voids. It never resolves against targetDirectory.
const TRACKED = ['main.mjs', 'math.mjs', 'src/a.mjs', 'src/deep/b.mjs', 'sub/x.mjs', 'sub/dir/x.mjs', 'sub/dir/deep/y.mjs', 'sub/holdout.json', 'sub2/x.mjs', 'other/x.mjs', 'scripts/eval/review-eval/gold/a.json', 'holdout.json', '.git/config'];
const TL = '../.\\'; // the exact start bytes of a tree-level entry: two dots, FORWARD slash, one dot, BACK slash
const SUB = `${TREE}\\sub`;
const SUB2 = `${TREE}\\sub\\dir`;
const globFiles = (files, td, tracked = TRACKED) => { const evs = events(CLEAN); setGlob(evs, { td, files }); return audit(evs, { tracked }); };
const exemptCounts = (r) => [r.exempt.tree.tracked, r.exempt.tree.harness, r.exempt.folder.tracked, r.exempt.folder.harness];
const voidsAll = (files, td, tracked, label = '') => files.forEach((f) => {
  const r = globFiles([f], td, tracked);
  assert.equal(r.verdict, 'void', `${label}${f}`);
  assert.ok(hit(r, 'outside-path', { tool: 'glob', field: 'result.success.files[0]' }), `${label}${f}`);
  assert.deepEqual(exemptCounts(r), [0, 0, 0, 0], `${label}${f}`);
});

test('G1 a tree-level entry ../.\\<tracked path> passes, whatever the case and the separators of the rest, and counts as tracked', () => {
  // Breaks when: the exemption is removed, the rest is compared case-sensitively, or the rest may hold only one separator form.
  const r = globFiles([`${TL}main.mjs`, `${TL}src\\a.mjs`, `${TL}src/deep/b.mjs`, `${TL}SRC\\A.MJS`, '.\\main.mjs'], TREE);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.rules));
  assert.deepEqual(exemptCounts(r), [4, 0, 0, 0]);
});

test('G1b each of the five harness files passes at tree level with no tracked match, and counts as harness', () => {
  // Breaks when: one of the five names is missing from the list, or the harness list needs the tracked list to hold the name.
  for (const f of ['PR.diff', 'DELTA.diff', '.review/PROMPT.md', '.review/CONTEXT.md', '.review/PRIOR.json', '.review\\prompt.md', 'pr.DIFF']) {
    const r = globFiles([`${TL}${f}`], TREE, []);
    assert.equal(r.verdict, 'pass', `${f} ${JSON.stringify(r.rules)}`);
    assert.deepEqual(exemptCounts(r), [0, 1, 0, 0], f);
  }
});

test('G1c a name that only looks like a harness file voids', () => {
  // Breaks when: the harness list matches a prefix, a suffix or a folder, or the five files may sit in a subfolder.
  voidsAll(['PR.diff.bak', 'xPR.diff', '.review/OTHER.md', 'review/PROMPT.md', 'sub/PR.diff', '.review', '.review/PROMPT.md/x'].map((f) => `${TL}${f}`), TREE, []);
});

test('G2 with no head list every entry voids, also a tracked name and a harness file', () => {
  // Breaks when: a missing head list is read as "everything is tracked", or the harness files skip the head-list rule.
  voidsAll([`${TL}main.mjs`, `${TL}PR.diff`, `${TL}.review/PROMPT.md`], TREE, null);
  const evs = events(CLEAN);
  setGlob(evs, { td: TREE, files: [`${TL}main.mjs`] });
  assert.equal(audit(evs).verdict, 'void', 'no tracked option at all');
});

test('G3 a tree-level entry whose rest is not a tracked path voids', () => {
  // Breaks when: any rest is accepted, a tracked folder counts as a tracked file, or a prefix of a tracked path counts.
  voidsAll(['zzz', 'src', 'src\\missing.mjs', 'main.mj', 'main.mjs.bak', 'sr'].map((f) => `${TL}${f}`), TREE);
});

test('G3b the withdrawn one-segment form and every other ..<sep> form void, also with a tracked name', () => {
  // Breaks when: the one-segment exemption ..<sep><name> comes back, or an entry that starts with .. resolves against the tree.
  voidsAll(['..\\main.mjs', '../main.mjs', '..\\x', '..\\..\\x', '..\\a\\b', '..\\..', '..\\.', '..\\', '..', '..\\a\\', '../..\\x'], TREE);
});

test('G3c near misses of the start bytes and of the rest void', () => {
  // Breaks when: the start is a regex with a free separator, or the rest may hold an empty, dot or two-dot segment, a root, a drive, a prefix form or a trailing separator.
  voidsAll([
    '..\\.\\main.mjs', '.././main.mjs', '../.\\', '../.\\.\\main.mjs', '../.\\..\\main.mjs', '../.\\src\\..\\main.mjs', '../.\\\\main.mjs', '../.\\/main.mjs',
    '../.\\main.mjs\\', '../.\\main.mjs/', '../.\\C:\\x', '../.\\c:x', '../.\\~main.mjs', '../.\\$x', '../.\\%x', '../.\\file:x', '../.\\src\\\\a.mjs', '../.\\src\\.\\a.mjs',
    '../.\\\\\\?\\C:\\x', '../.\\/c/x', '../.\\\\\\server\\share',
  ], TREE);
});

test('G3d a rest with an answer-key segment voids with the answer-key tag, also when the head tracks that path', () => {
  // Breaks when: the rest is checked with classify alone (it returns null for a relative path), or hasAnswerKey is not called on the rest.
  for (const f of ['scripts\\eval\\review-eval\\gold\\a.json', 'holdout.json', '.git\\config', 'SCRIPTS/EVAL/REVIEW-EVAL/GOLD/A.JSON']) {
    const r = globFiles([`${TL}${f}`], TREE);
    assert.equal(r.verdict, 'void', f);
    assert.ok(hit(r, 'outside-path', { tool: 'glob', field: 'result.success.files[0]', answerKey: true }), f);
    assert.ok(hit(r, 'answer-key'), f);
    assert.deepEqual(exemptCounts(r), [0, 0, 0, 0], f);
  }
});

test('G4 an absolute outside path in glob files voids', () => {
  // Breaks when: the exemption covers absolute paths.
  const r = globFiles([`${PRIMARY}\\x`], TREE);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'glob', field: 'result.success.files[0]' }));
});

test('G5 a folder targetDirectory: ../<path relative to the tree> passes when the remainder starts with the folder path and is tracked, and counts apart', () => {
  // Breaks when: the entry is resolved against targetDirectory (the old G5), the folder prefix is not compared, or folder entries land in the tree-level count.
  const one = globFiles(['../sub\\x.mjs', '../SUB/X.MJS'], SUB);
  assert.equal(one.verdict, 'pass', JSON.stringify(one.rules));
  assert.deepEqual(exemptCounts(one), [0, 0, 2, 0]);
  const two = globFiles(['../sub\\dir\\x.mjs', '../SUB/Dir/deep/y.mjs'], SUB2);
  assert.equal(two.verdict, 'pass', JSON.stringify(two.rules));
  assert.deepEqual(exemptCounts(two), [0, 0, 2, 0]);
  for (const td of [`${SUB2}\\`, 'c:/fake/tmp/cursor-review-abc123/tree/sub/dir', `${SUB2}\\.`]) {
    assert.equal(globFiles(['../sub/dir\\x.mjs'], td).verdict, 'pass', td);
  }
});

test('G5b a folder entry with two leading .. segments voids, at depth 1, 2 and 3', () => {
  // Breaks when: more than one leading .. is stripped, or the entry is resolved as a normal path (../../sub/dir/x resolves inside the tree from a folder two deep).
  voidsAll(['../../sub/x.mjs', '..\\..\\sub\\x.mjs'], SUB);
  voidsAll(['../../sub/dir/x.mjs', '../..\\sub\\dir\\x.mjs', '../../../sub/dir/x.mjs', '..\\..\\..\\sub\\dir\\x.mjs'], SUB2);
  voidsAll(['../../sub/dir/deep/y.mjs', '../../../sub/dir/deep/y.mjs'], `${SUB2}\\deep`);
});

test('G5c a folder entry whose first separator is not a forward slash, or that starts with ../.\\, voids', () => {
  // Breaks when: the first separator may be a back slash, or the tree-level start is accepted for a folder call.
  voidsAll(['..\\x.mjs', '..\\sub\\x.mjs', '../.\\sub\\x.mjs', '../.\\x.mjs'], SUB);
});

test('G5d a folder entry whose remainder does not start with the folder path voids', () => {
  // Breaks when: the remainder is not compared with the folder path, the compare has no segment boundary (sub2), or an outer folder path is enough.
  voidsAll(['../other/x.mjs', '../sub2/x.mjs', '../x.mjs', '../main.mjs'], SUB);
  voidsAll(['../sub/x.mjs', '../sub/dir2/x.mjs'], SUB2);
});

test('G5e a folder entry whose remainder is not tracked, names the folder only, or holds an answer-key segment voids', () => {
  // Breaks when: the checks of the tree-level rest are not applied to the folder remainder.
  voidsAll(['../sub/missing.mjs', '../sub', '../sub/', '../sub/x.mjs/'], SUB);
  voidsAll(['../sub/holdout.json'], SUB);
  voidsAll(['../sub/x.mjs'], SUB, null);
});

test('G5f a harness file passes under a folder call when the folder is its own folder, and counts as harness', () => {
  // Breaks when: the harness list is not applied to the folder remainder.
  const r = globFiles(['../.review/PROMPT.md'], `${TREE}\\.review`, []);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.rules));
  assert.deepEqual(exemptCounts(r), [0, 0, 0, 1]);
});

test('G6 the tree-level form with no targetDirectory voids, and so does one with a targetDirectory outside the tree', () => {
  // Breaks when: a missing targetDirectory is read as "the tree", or an outside folder is read as a folder of the tree.
  voidsAll([`${TL}main.mjs`, '../x.mjs'], null);
  const r = globFiles([`${TL}main.mjs`, '../x.mjs'], PRIMARY);
  assert.equal(r.verdict, 'void');
  assert.deepEqual(exemptCounts(r), [0, 0, 0, 0]);
  assert.equal(globFiles([`${TL}main.mjs`], `${TREE}2`).verdict, 'void');
});

test('G7 the exemption is for glob result files only', () => {
  // Breaks when: the exemption leaks to a grep result path, a grep match file, a read path, a glob targetDirectory or a related rule path.
  const form = `${TL}main.mjs`;
  const g = events(CLEAN);
  setGrep(g, (b) => { if (b.result) b.result.success.path = form; });
  assert.equal(audit(g, { tracked: TRACKED }).verdict, 'void');
  const t = events(CLEAN);
  setGlob(t, { td: form });
  assert.equal(audit(t, { tracked: TRACKED }).verdict, 'void');
  const m = events(CLEAN);
  setGrep(m, (b) => { if (b.result) b.result.success.workspaceResults = { [TREE]: { content: { matches: [{ file: form, content: [] }], totalLines: 1 } } }; });
  assert.equal(audit(m, { tracked: TRACKED }).verdict, 'void');
  const rd = events(['init', 'read', 'tail']);
  setReadPath(rd, form);
  assert.equal(audit(rd, { tracked: TRACKED }).verdict, 'void');
  const rr = events(['init', 'read', 'tail']);
  for (const e of calls(rr, 'read')) { const b = body(e, 'read'); if (b.result) b.result.success.relatedCursorRulePaths = [form]; }
  assert.equal(audit(rr, { tracked: TRACKED }).verdict, 'void');
});

test('G8 the tree-level counts split into tracked and harness, and tree-level and folder-level entries are counted apart', () => {
  // Breaks when: the split is dropped, or the folder entries share a counter with the tree-level entries.
  const r = globFiles([`${TL}main.mjs`, `${TL}PR.diff`, `${TL}DELTA.diff`, `${TL}src\\a.mjs`], TREE);
  assert.deepEqual(exemptCounts(r), [2, 2, 0, 0]);
  const f = globFiles(['../sub/x.mjs'], SUB);
  assert.deepEqual(exemptCounts(f), [0, 0, 1, 0]);
});

test('G9 the tree-level start is accepted for every spelling of the tree as targetDirectory', () => {
  // Breaks when: the tree compare is case-sensitive or takes one slash form or no trailing separator.
  for (const td of [TREE, `${TREE}\\`, `${TREE}\\.`, 'c:/fake/tmp/cursor-review-abc123/tree', 'C:/FAKE/TMP/CURSOR-REVIEW-ABC123/TREE/', `\\\\?\\${TREE}`]) {
    const r = globFiles([`${TL}main.mjs`], td);
    assert.equal(r.verdict, 'pass', `${td} ${JSON.stringify(r.rules)}`);
    assert.deepEqual(exemptCounts(r), [1, 0, 0, 0], td);
  }
});

// ---- the verdict line ----
test('A1 auditReplay: a void stream gives a void patch, a state line with no path text, and no change to anything else', () => {
  // Breaks when: the patch loses status failed, void true or the read-audit: reason, or the line carries tool-call strings.
  const dir = tmpDir();
  const statePath = path.join(dir, 'state', 'read-audit.jsonl');
  const stream = put(dir, 'run1.raw.json', events(['init', 'read-outside', 'tail'], {}));
  const { patch, line } = auditReplay({ kind: 'cursor-review', streamPath: stream, runId: 'run1', head: HEAD, pr: 7, round: 2, statePath, tmpdir: TMP });
  assert.equal(patch.status, 'failed');
  assert.equal(patch.void, true);
  assert.match(patch.reason, /^read-audit: /);
  assert.equal(/timed out/i.test(patch.reason), false);
  assert.equal(line.verdict, 'void');
  assert.equal(line.schema, 1);
  assert.equal(line.auditVersion, AUDIT_VERSION);
  assert.equal(line.streamSha256, sha256(stream));
  assert.deepEqual({ runId: line.runId, kind: line.kind, head: line.head, pr: line.pr, round: line.round }, { runId: 'run1', kind: 'cursor-review', head: HEAD, pr: 7, round: 2 });
  const lines = readLines(statePath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].verdict, 'void');
  const raw = readFileSync(statePath, 'utf8');
  for (const bad of ['linktype-labels', 'primary', 'cursor-review-abc123', 'fake']) assert.equal(raw.includes(bad), false, bad);
});

test('A2 auditReplay: a clean gz stream gives an empty patch, a pass line, and the agent version of the record beside it', () => {
  // Breaks when: a pass adds a patch, the gz is not read, or the agent version is not taken from the record.
  const dir = tmpDir();
  const statePath = path.join(dir, 'state.jsonl');
  const stream = put(dir, 'r1.stream.jsonl.gz', events(CLEAN));
  writeFileSync(path.join(dir, 'r1.json'), JSON.stringify({ runId: 'r1', cursorAgentVersion: '2026.11.1-abc' }));
  const { patch, line } = auditReplay({ kind: 'engine', streamPath: stream, runId: 'r1', head: HEAD, pr: 1, round: 1, statePath, tmpdir: TMP });
  assert.deepEqual(patch, {});
  assert.equal(line.verdict, 'pass');
  assert.equal(line.agentVersion, '2026.11.1-abc');
  assert.equal(line.model, 'Grok 4.7 256K High');
  assert.deepEqual(readLines(statePath).map((l) => l.verdict), ['pass']);
});

test('A3 auditReplay: a null stream path is a void no-stream, never a throw', () => {
  // Breaks when: a missing path reaches readFileSync.
  const dir = tmpDir();
  const { patch, line } = auditReplay({ kind: 'engine', streamPath: null, runId: 'r9', head: HEAD, pr: 1, round: 1, statePath: path.join(dir, 's.jsonl'), tmpdir: TMP });
  assert.equal(patch.void, true);
  assert.match(patch.reason, /no-stream/);
  assert.equal(line.verdict, 'void');
});

test('A4 auditReplay: git and head give the symlink check, and a link voids the run', () => {
  // Breaks when: auditReplay does not pass git and head to checkHeadSymlinks.
  const dir = tmpDir();
  const stream = put(dir, 'r2.stream.jsonl.gz', events(CLEAN));
  const { git } = scriptedLs({ ls: lsLine('120000', 'link'), target: PRIMARY });
  const { patch } = auditReplay({ kind: 'engine', streamPath: stream, runId: 'r2', head: HEAD, git, pr: 1, round: 1, statePath: path.join(dir, 's.jsonl'), tmpdir: TMP });
  assert.equal(patch.void, true);
  assert.match(patch.reason, /symlink/);
});



// ---- state file and newest line ----
test('state path: an override, then READ_AUDIT_LEDGER, then the home folder', () => {
  // Breaks when: the env override is ignored (a test would write the real file).
  assert.equal(defaultStatePath({ READ_AUDIT_LEDGER: 'x.jsonl' }), 'x.jsonl');
  assert.ok(defaultStatePath({}).endsWith(path.join('.claude', 'state', 'review-engine', 'read-audit.jsonl')));
});

test('L1 the newest line of a run id wins: pass then void is void, void then pass is pass', () => {
  // Breaks when: the first line wins.
  const a = { runId: 'r', verdict: 'pass', ts: '2026-11-11T10:00:00Z' };
  const b = { runId: 'r', verdict: 'void', ts: '2026-11-11T11:00:00Z' };
  assert.equal(newestByRunId([a, b]).get('r').verdict, 'void');
  assert.equal(newestByRunId([b, a]).get('r').verdict, 'void');
  assert.equal(newestByRunId([{ ...b, ts: a.ts }, { ...a }]).get('r').verdict, 'pass');
});

test('appendLine writes one JSON line per call and readLines skips a damaged line', () => {
  // Breaks when: a damaged line throws, or the folder is not made.
  const dir = tmpDir();
  const file = path.join(dir, 'deep', 'l.jsonl');
  appendLine(file, { runId: 'a', verdict: 'pass' });
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n`);
  appendLine(file, { runId: 'b', verdict: 'void' });
  assert.deepEqual(readLines(file).map((l) => l.runId), ['a', 'b']);
  assert.deepEqual(readLines(path.join(dir, 'none.jsonl')), []);
});

// ---- summary ----
const row = (over = {}) => ({ schema: 1, pr: 7, round: 1, sha40: 'c'.repeat(40), status: 'ok', cursorRunId: 'r-ok', ts: '2026-11-11T10:00:00.000Z', ...over });
const voidRow = (over = {}) => row({ status: 'failed', void: true, reason: 'read-audit: outside-path', cursorRunId: 'r-void', ...over });
const KEY = `7|1|${'c'.repeat(40)}`;

function runSummary(rows, extra = [], state = []) {
  const dir = tmpDir();
  const runs = path.join(dir, 'runs.jsonl');
  writeFileSync(runs, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const statePath = path.join(dir, 'state.jsonl');
  state.forEach((l) => appendLine(statePath, l));
  const c = io();
  const code = main(['--summary', '--runs', runs, '--state', statePath, ...extra], c);
  return { code, out: c.text() };
}

test('S1 a runs file with one void row prints 1 void run, its round, a NOTE, and exits 1', () => {
  // Breaks when: a void is found by status alone, the round is not printed, or the exit is 0.
  const { code, out } = runSummary([voidRow()]);
  assert.equal(code, 1);
  assert.match(out, /void runs: 1/);
  assert.ok(out.includes(`VOID ${KEY}`), out);
  assert.match(out, /NOTE/);
  assert.equal(out.includes('REPLACED'), false);
});

test('S2 a later ok row for the same round makes the round REPLACED and the exit stays 1', () => {
  // Breaks when: the key lacks sha40, the tie rule is flipped, or only the newest row is looked at.
  const { code, out } = runSummary([voidRow(), row({ ts: '2026-11-11T11:00:00.000Z' })]);
  assert.equal(code, 1);
  assert.match(out, /void runs: 1/);
  assert.ok(out.includes(`REPLACED ${KEY}`), out);
});

test('S2b the score.mjs tie rule: same ts, the later line wins; an older ts on a later line loses', () => {
  // Breaks when: the newest row is chosen by line order alone.
  const same = runSummary([voidRow(), row()]);
  assert.ok(same.out.includes(`REPLACED ${KEY}`), same.out);
  const voidNewest = runSummary([row(), voidRow()]);
  assert.equal(voidNewest.out.includes('REPLACED'), false, voidNewest.out);
  const olderLater = runSummary([row({ ts: '2026-11-11T12:00:00.000Z' }), voidRow({ ts: '2026-11-11T09:00:00.000Z' })]);
  assert.ok(olderLater.out.includes(`REPLACED ${KEY}`), olderLater.out);
});

test('S2c a void of another round is not replaced by an ok row of a different sha', () => {
  // Breaks when: the round key is (pr, round) only.
  const { out } = runSummary([voidRow(), row({ sha40: 'd'.repeat(40), ts: '2026-11-11T11:00:00.000Z' })]);
  assert.equal(out.includes('REPLACED'), false, out);
});

test('S4 a clean runs file exits 0 with no NOTE', () => {
  // Breaks when: exit 1 or NOTE is printed with 0 voids.
  const { code, out } = runSummary([row()], [], [{ runId: 'r-ok', verdict: 'pass', ts: '2026-11-11T10:00:01.000Z' }]);
  assert.equal(code, 0);
  assert.match(out, /void runs: 0/);
  assert.equal(out.includes('NOTE'), false);
  assert.match(out, /unaudited: 0/);
});

test('S4b an ok row with no state line is unaudited and the summary exits 1', () => {
  // Breaks when: a missing line counts as a pass, or the exit ignores the unaudited count.
  const { code, out } = runSummary([row()]);
  assert.match(out, /unaudited: 1/);
  assert.equal(code, 1);
});

function headsFixture(state) {
  const dir = tmpDir();
  const head = path.join(dir, 'engine-state', 'branch', HEAD);
  mkdirSync(head, { recursive: true });
  for (const id of ['r1', 'r2']) writeFileSync(path.join(head, `${id}.json`), JSON.stringify({ runId: id }));
  writeFileSync(path.join(head, 'r1.trace.json'), JSON.stringify({ runId: 'ignored-trace' }));
  const statePath = path.join(dir, 'state.jsonl');
  state.forEach((l) => appendLine(statePath, l));
  const c = io();
  const code = main(['--summary', '--heads', head, '--state', statePath], c);
  return { code, out: c.text() };
}

test('S3 --heads counts a run with no state line as unaudited, skips trace files, and exits 1', () => {
  // Breaks when: a missing line counts as a pass, a trace.json file counts as a record, or an unaudited run exits 0 (fail closed: a failed state write leaves no line).
  const { code, out } = headsFixture([{ runId: 'r1', verdict: 'pass', ts: '2026-11-11T10:00:00Z' }]);
  assert.match(out, /unaudited: 1/);
  assert.match(out, /void runs: 0/);
  assert.equal(code, 1);
});

test('S5 --heads counts a run whose newest line is void', () => {
  // Breaks when: the oldest line is read, or heads mode ignores the state file.
  const { code, out } = headsFixture([
    { runId: 'r1', verdict: 'pass', ts: '2026-11-11T10:00:00Z' },
    { runId: 'r1', verdict: 'void', ts: '2026-11-11T11:00:00Z' },
    { runId: 'r2', verdict: 'pass', ts: '2026-11-11T10:00:00Z' },
  ]);
  assert.equal(code, 1);
  assert.match(out, /void runs: 1/);
  assert.match(out, /unaudited: 0/);
});

test('summarize returns the numbers the CLI prints', () => {
  // Breaks when: the object and the printed text disagree.
  const s = summarize({ runs: [voidRow(), row({ ts: '2026-11-11T11:00:00.000Z' })], lines: [] });
  assert.equal(s.voids.length, 1);
  assert.equal(s.replaced.length, 1);
});

// ---- scan ----
/** A real repo with one commit that tracks `names`. Returns { dir, head }. */
function repoWithFiles(names) {
  const dir = tmpDir();
  const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@t'); run('config', 'user.name', 't'); run('config', 'commit.gpgsign', 'false');
  for (const n of names) { mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); writeFileSync(path.join(dir, n), '1'); }
  run('add', ...names);
  run('commit', '-qm', 'c1');
  return { dir, head: run('rev-parse', 'HEAD') };
}
/** A glob call (started and completed) with its own call id, from the glob template. */
const extraGlob = (id, td, files) => events(['glob']).map((e) => {
  e.call_id = id; e.tool_call.toolCallId = id;
  const b = body(e, 'glob');
  b.args.targetDirectory = td;
  if (b.result) { b.result.success.path = td; b.result.success.files = files; }
  return e;
});

function plantRoot(head) {
  const root = tmpDir();
  const clean = events(CLEAN);
  setGlob(clean, { td: TREE, files: [`${TL}main.mjs`, `${TL}PR.diff`, `${TL}src\\a.mjs`, '.\\math.mjs'] });
  put(root, `2026-11-04-p1-holdout-run-1/engine-state/some-branch/${head}/r1.stream.jsonl.gz`, [...clean, ...extraGlob('call-glob-2', SUB, ['../sub/x.mjs']), ...gapEvents()]);
  put(root, `2026-11-04-p1-holdout-nobody-run-1/engine-state/some-branch/${head}/r2.stream.jsonl.gz`, events(['init', 'read-outside', 'grep', 'tail']));
  put(root, `2026-11-04-p1-other/engine-state/x/${head}/r3.stream.jsonl.gz`, events(['read']));
  return root;
}

test('C1 --scan over 2 planted gz streams with a real repo prints counts only, writes no line, and exits 1 on a void', () => {
  // Breaks when: scan prints a path, a stream name, a sha or an exception, writes a state line, scans a folder the prefix does not name,
  // does not take the head from the 40-hex folder name, or drops one of the counts the Done-when names.
  const { dir: repo, head } = repoWithFiles(['main.mjs', 'src/a.mjs', 'sub/x.mjs', 'math.mjs']);
  const root = plantRoot(head);
  const statePath = path.join(tmpDir(), 'scan-state.jsonl');
  const c = io({ env: { READ_AUDIT_LEDGER: statePath } });
  const code = main(['--scan', '--root', root, '--repo', repo], c);
  const out = c.text();
  assert.equal(code, 1, out);
  assert.match(out, /streams: 2\b/);
  assert.match(out, /pass: 1\b/);
  assert.match(out, /void: 1\b/);
  assert.match(out, /outside-path: 1\b/);
  assert.match(out, /read: 2\b/);
  assert.match(out, /grep: 2\b/);
  assert.match(out, /glob: 2\b/);
  assert.match(out, /glob-parent-name tree-level exempt: 3 \(tracked 2, harness 1\)/);
  assert.match(out, /glob-parent-name subfolder entries checked: 1 \(tracked 1, harness 0\)/);
  assert.match(out, /event types seen: 7\b/);
  assert.match(out, /event types outside the list: 0\b/);
  assert.match(out, /streams with a gap: 1, gap events: 2/);
  assert.match(out, /brace-checked arguments: glob 2, grep glob 2/);
  assert.match(out, /head lists: read 2, not read 0/);
  assert.match(out, /symlink check: not run/);
  for (const bad of [root, repo, 'some-branch', 'r1.stream', 'r2.stream', head, 'primary', 'linktype', 'cursor-review-abc123', 'zzz', 'main.mjs', 'holdout-run']) assert.equal(out.includes(bad), false, bad);
  assert.equal(existsSync(statePath), false);
});

test('C3 --scan voids an exempt-form entry when its head folder is not a 40-hex name or its commit is not in the repo, and prints counts only', () => {
  // Breaks when: a missing head list lets an entry pass, or the scan prints the sha or the git error.
  const { dir: repo } = repoWithFiles(['main.mjs']);
  const root = tmpDir();
  const evs = events(CLEAN);
  setGlob(evs, { td: TREE, files: [`${TL}main.mjs`] });
  put(root, '2026-11-04-p1-holdout-a/engine-state/b/not-a-head/r1.stream.jsonl.gz', evs);
  put(root, `2026-11-04-p1-holdout-a/engine-state/b/${'e'.repeat(40)}/r2.stream.jsonl.gz`, evs);
  const c = io();
  assert.equal(main(['--scan', '--root', root, '--repo', repo], c), 1);
  assert.match(c.text(), /void: 2\b/);
  assert.match(c.text(), /head lists: read 0, not read 2/);
  assert.match(c.text(), /glob-parent-name tree-level exempt: 0/);
  for (const bad of ['e'.repeat(40), 'fatal', 'not-a-head', repo]) assert.equal(c.text().includes(bad), false, bad);
});

test('C2 --scan exits 0 when every stream passes, and counts a damaged gz as a void without printing the error', () => {
  // Breaks when: one bad file throws out of the scan, or its message (which holds the folder path) is printed.
  const root = tmpDir();
  put(root, '2026-11-04-p1-holdout-a/engine-state/b/h/r1.stream.jsonl.gz', events(CLEAN));
  const clean = io();
  assert.equal(main(['--scan', '--root', root], clean), 0);
  assert.match(clean.text(), /streams: 1\b/);
  writeFileSync(path.join(root, '2026-11-04-p1-holdout-a/engine-state/b/h/r2.stream.jsonl.gz'), 'not gzip');
  const c = io();
  assert.equal(main(['--scan', '--root', root], c), 1);
  assert.match(c.text(), /streams: 2\b/);
  assert.match(c.text(), /void: 1\b/);
  assert.equal(c.text().includes(root), false);
  assert.equal(/Error|ZlibError|incorrect header/i.test(c.text()), false);
});

// ---- single-stream CLI ----
test('CLI: one stream prints the verdict line, records it, and exits 1 on a void and 0 on a pass', () => {
  // Breaks when: the exit code ignores the verdict, the line is not recorded, or --no-record still records.
  const dir = tmpDir();
  const bad = put(dir, 'b.raw.json', events(['init', 'read-outside', 'tail']));
  const good = put(dir, 'g.raw.json', events(CLEAN));
  const statePath = path.join(dir, 'st', 'state.jsonl');
  const c1 = io();
  assert.equal(main([bad, '--state', statePath, '--run-id', 'rb', '--kind', 'canary'], c1), 1);
  const printed = JSON.parse(c1.text().trim().split('\n').pop());
  assert.equal(printed.verdict, 'void');
  assert.equal(printed.kind, 'canary');
  assert.equal(printed.runId, 'rb');
  assert.equal(readLines(statePath).length, 1);
  const c2 = io();
  assert.equal(main([good, '--state', statePath, '--run-id', 'rg', '--no-record'], c2), 0);
  assert.equal(readLines(statePath).length, 1);
});

test('CLI: no arguments is a usage error (exit 2) and writes nothing', () => {
  // Breaks when: a missing stream argument audits an empty path or throws.
  const c = io({ env: { READ_AUDIT_LEDGER: path.join(tmpDir(), 'never.jsonl') } });
  assert.equal(main([], c), 2);
  assert.equal(existsSync(c.env.READ_AUDIT_LEDGER), false);
});

// ---- fix pass: findings of the test report and the two reviews ----
// grep result match files sit under workspaceResults.{tree}.content.matches[].file. Only a STRING `content` is file text.
const grepMatches = (matches) => {
  const evs = events(CLEAN);
  setGrep(evs, (b) => { if (b.result) b.result.success.workspaceResults = { [TREE]: { content: { matches, totalLines: matches.length } } }; });
  return audit(evs);
};

test('F1a a grep match file that is an absolute outside path voids with answer-key, though it sits under a content key', () => {
  // Breaks when: every key named content is skipped, including an object that holds the match list.
  const r = grepMatches([{ file: `${PRIMARY}\\linktype-labels.json`, content: [{ lineNumber: 1, content: 'x', isContextLine: false }] }]);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'outside-path', { tool: 'grep', answerKey: true }), JSON.stringify(r.rules));
  assert.ok(r.rules.some((x) => /content\.matches\[0\]\.file$/.test(x.field)), JSON.stringify(r.rules));
});

test('F1b a grep match file with a .. that leaves the tree voids, and a match file relative to the tree passes', () => {
  // Breaks when: match files are not resolved, or a relative match file counts as outside.
  assert.equal(grepMatches([{ file: '..\\..\\x', content: [] }]).verdict, 'void');
  assert.equal(grepMatches([{ file: '.\\main.mjs', content: [] }, { file: 'src/a.mjs', content: [] }]).verdict, 'pass');
});

test('F1c matched line text that looks like an outside path is not read', () => {
  // Breaks when: the walker enters the string `content` of a matched line.
  const r = grepMatches([{ file: '.\\main.mjs', content: [{ lineNumber: 1, content: `${PRIMARY}\\linktype-labels.json`, isContextLine: false }] }]);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.rules));
});

test('F3 a drive-relative path (a drive letter and a colon, no separator) voids, as does one that climbs with ..', () => {
  // Breaks when: parseRoot and the .. test need a separator after the colon. Windows resolves such a path against the drive's own cwd.
  for (const p of ['C:..\\..\\work\\primary\\linktype-labels.json', 'D:x', 'c:secret.txt', 'C:..\\x']) {
    const evs = events(['init', 'read', 'tail']);
    setReadPath(evs, p);
    const r = audit(evs);
    assert.equal(r.verdict, 'void', p);
    assert.ok(hit(r, 'outside-path', { tool: 'read', field: 'args.path' }), p);
  }
  const named = events(['init', 'read', 'tail']);
  setReadPath(named, 'C:..\\..\\work\\primary\\linktype-labels.json');
  assert.ok(hit(audit(named), 'answer-key'));
});

test('F3b a drive-relative symlink target escapes the tree', () => {
  // Breaks when: escapesTree does not test for a drive letter without a separator.
  for (const target of ['C:..\\..\\x', 'D:secret']) {
    const { git } = scriptedLs({ ls: lsLine('120000', 'link'), target });
    assert.ok(checkHeadSymlinks({ git, head: HEAD }).some((x) => x.rule === 'symlink'), target);
  }
});

test('F6a a *ToolCall key that is not an object voids, and it cannot hide beside a read', () => {
  // Breaks when: the key filter drops a non-object *ToolCall value.
  const evs = events(CLEAN);
  calls(evs, 'read')[0].tool_call.shellToolCall = 'x';
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'unknown-kind', { tool: 'shell' }), JSON.stringify(r.rules));
});

test('F6b a tool_call key that is neither *ToolCall nor known metadata voids', () => {
  // Breaks when: unknown keys of a tool_call are skipped, so an mcpCall beside a read passes.
  const evs = events(CLEAN);
  calls(evs, 'read')[0].tool_call.mcpCall = { args: { path: `${PRIMARY}\\x` } };
  const r = audit(evs);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'unknown-kind', { field: 'tool_call' }), JSON.stringify(r.rules));
});

test('F6c two *ToolCall keys in one call are each counted, and a started and a completed line count once', () => {
  // Breaks when: the seen map keeps only the last kind of a call id.
  const evs = events(CLEAN);
  calls(evs, 'grep').forEach((e) => { e.tool_call.readToolCall = { args: { path: 'a.mjs' } }; });
  const r = audit(evs);
  assert.equal(r.counts.grep, 1);
  assert.equal(r.counts.read, 2);
  assert.equal(r.counts.toolCalls, 4);
});

test('F5 --summary --runs reports an ok row whose newest state line is void', () => {
  // Breaks when: --runs mode reads the row status and void flag only, never the newest state line of the run.
  const { code, out } = runSummary([row()], [], [
    { runId: 'r-ok', verdict: 'pass', ts: '2026-11-11T10:00:01.000Z' },
    { runId: 'r-ok', verdict: 'void', ts: '2026-11-11T12:00:00.000Z' },
  ]);
  assert.equal(code, 1);
  assert.match(out, /void runs: 1/);
  assert.match(out, /unaudited: 0/);
});

test('F7 --heads with a missing folder is a usage error (exit 2) that prints no path and no stack', () => {
  // Breaks when: readdirSync throws out of main.
  const missing = path.join(tmpDir(), 'no-such-head-folder');
  const c = io();
  let code;
  assert.doesNotThrow(() => { code = main(['--summary', '--heads', missing], c); });
  assert.equal(code, 2);
  assert.match(c.text(), /usage/);
  assert.equal(c.text().includes('no-such-head-folder'), false);
});

// ---- seat answer 3: D brace patterns, event types, F stream gaps, E a failed state write, symlinkCheck ----
const BRACE_VOID = ['{..,x}/*', '{C:/x,y}/**', '{x,../y}/*', '{x,..\\y}', '{a/..,b}', '{a,{..,b}}', '{/c/x,y}', '{\\\\?\\C:\\x,y}', '*.{js,/etc}', '{c:/x,y}', '{x,..}', '{x,C:\\y}'];
const BRACE_OK = ['**/{main,math}.mjs', '{src,lib}/**/*.mjs', '*.{js,mjs}', '{1..3}.mjs', 'src/**/{a,b}/*.mjs', '*.mjs', '**/*.{c,h}'];
const withGlobPattern = (p) => { const evs = events(CLEAN); for (const e of calls(evs, 'glob')) { const b = body(e, 'glob'); b.args.globPattern = p; if (b.result) b.result.success.pattern = p; } return evs; };
const withGrepGlob = (p) => { const evs = events(CLEAN); setGrep(evs, (b) => { b.args.glob = p; }); return evs; };

test('D1 a glob pattern with a .. segment or a root inside a brace voids', () => {
  // Breaks when: DOT_DOT needs a separator before the dots and parseRoot needs the root at the start, as before: both let {..,x} and {C:/x,y} pass.
  for (const p of BRACE_VOID) {
    const r = audit(withGlobPattern(p));
    assert.equal(r.verdict, 'void', p);
    assert.ok(hit(r, 'outside-path', { tool: 'glob', field: 'args.globPattern' }), p);
  }
});

test('D2 a grep glob argument with a .. segment or a root inside a brace voids', () => {
  // Breaks when: the brace check is applied to glob patterns only.
  for (const p of BRACE_VOID) {
    const r = audit(withGrepGlob(p));
    assert.equal(r.verdict, 'void', p);
    assert.ok(hit(r, 'outside-path', { tool: 'grep', field: 'args.glob' }), p);
  }
});

test('D3 ordinary brace patterns pass in a glob pattern and in a grep glob argument', () => {
  // Breaks when: any brace voids, or the number range {1..3} reads as a .. segment.
  for (const p of BRACE_OK) {
    assert.equal(audit(withGlobPattern(p)).verdict, 'pass', p);
    assert.equal(audit(withGrepGlob(p)).verdict, 'pass', p);
  }
});

// A `..` segment outside a brace, beside a brace whose alternative holds a separator: the text folds inside the tree, the expansion does not (`{a,b/c}/../../x` expands to `a/../../x`).
const BRACE_HIDES_DOTDOT = ['{a,b/c}/../../x', '{a,b/c/d}/../../../x', '{a,{b/c,d}}/../../x', 'x/{a,b\\c}/..\\..\\y', '{a,b/c}/..'];

test('D5 a .. segment beside a brace in a glob pattern or a grep glob argument voids, because the brace can hold a separator that hides the climb', () => {
  // Breaks when: the string is folded as text, so `{a,b/c}` counts as two segments and `{a,b/c}/../../x` stays inside the tree.
  for (const p of BRACE_HIDES_DOTDOT) {
    const g = audit(withGlobPattern(p));
    assert.equal(g.verdict, 'void', p);
    assert.ok(hit(g, 'outside-path', { tool: 'glob', field: 'args.globPattern' }), p);
    const r = audit(withGrepGlob(p));
    assert.equal(r.verdict, 'void', p);
    assert.ok(hit(r, 'outside-path', { tool: 'grep', field: 'args.glob' }), p);
  }
});

test('D5b a .. segment with no brace, and a brace with no .. segment, keep their old verdict', () => {
  // Breaks when: the rule voids every .. segment or every brace (the map voids a .. only when it points outside the tree).
  for (const p of ['src/../lib/*.mjs', 'a/b/../*.mjs', '{1..3}/*.mjs']) assert.equal(audit(withGlobPattern(p)).verdict, 'pass', p);
  assert.equal(audit(withGlobPattern('../../x/*.mjs')).verdict, 'void');
});

test('D4 the result counts the glob patterns and grep glob arguments it checked, once per call', () => {
  // Breaks when: the count is left off (a wrong field name then passes with nothing checked), or a started and a completed line count twice.
  assert.deepEqual(audit(events(CLEAN)).braceChecked, { glob: 1, grep: 1 });
});

const typed = (type, extra = {}) => ({ type, session_id: 's', ...extra });

test('T1 each event type of the allow list passes and is counted', () => {
  // Breaks when: one of the eight types is missing from the list.
  const evs = [...events(CLEAN), typed('connection', { subtype: 'reconnected' }), typed('retry', { subtype: 'x' }), typed('thinking', { subtype: 'delta', text: 'x' })];
  const r = audit(evs);
  assert.equal(r.verdict, 'pass', JSON.stringify(r.rules));
  assert.deepEqual(r.eventTypes, { system: 1, user: 1, thinking: 1, assistant: 1, tool_call: 6, result: 1, connection: 1, retry: 1, other: 0 });
});

test('T2 an event of another type voids with unknown-kind, and the type text is in no rule', () => {
  // Breaks when: the allow list is dropped, an event with no type passes, or the type text goes into the verdict line.
  for (const t of ['mcp_event', 'shell', 'Assistant', undefined, null, 7]) {
    const ev = { type: t, session_id: 's' };
    const r = audit([...events(CLEAN), ev]);
    assert.equal(r.verdict, 'void', String(t));
    assert.ok(hit(r, 'unknown-kind', { field: 'type' }), String(t));
    assert.equal(r.eventTypes.other, 1, String(t));
    if (typeof t === 'string') assert.equal(JSON.stringify(r.rules).includes(t), false, t);
  }
});

const gapEvents = () => [typed('connection', { subtype: 'reconnecting', attempt: 1 }), typed('retry', { subtype: 'starting', attempt: 1, is_resume: true }), typed('retry', { subtype: 'resuming', attempt: 1 }), typed('connection', { subtype: 'reconnected' })];

test('F8 a reconnect and a resume are counted as gaps and do not void', () => {
  // Breaks when: gaps are not counted, a gap voids, or a plain retry or a reconnected event counts as a gap.
  const gap = audit([...events(CLEAN), ...gapEvents()]);
  assert.equal(gap.verdict, 'pass', JSON.stringify(gap.rules));
  assert.equal(gap.gaps, 2);
  assert.equal(audit(events(CLEAN)).gaps, 0);
  assert.equal(audit([...events(CLEAN), typed('retry', { subtype: 'starting', is_resume: false }), typed('connection', { subtype: 'reconnected' })]).gaps, 0);
});

test('E1 auditReplay: a failed state write voids the patch with read-audit: record-failed and sets recordError', () => {
  // Breaks when: the catch around appendLine leaves the patch empty (the old rule): the row then counts although its line is missing.
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  const o = { kind: 'engine', streamPath: put(dir, 'e1.stream.jsonl.gz', events(CLEAN)), runId: 'e1', head: HEAD, pr: 1, round: 1, statePath: path.join(blocker, 'sub', 's.jsonl'), tmpdir: TMP };
  const r = auditReplay(o);
  assert.deepEqual(r.patch, { status: 'failed', void: true, reason: 'read-audit: record-failed' });
  assert.equal(r.recordError, true);
  assert.equal(r.line.verdict, 'pass');
  const bad = auditReplay({ ...o, streamPath: put(dir, 'e2.raw.json', events(['init', 'read-outside', 'tail'])), runId: 'e2' });
  assert.match(bad.patch.reason, /^read-audit: .*outside-path/);
  assert.match(bad.patch.reason, /record-failed/);
  assert.equal(auditReplay({ ...o, statePath: path.join(dir, 'ok', 's.jsonl') }).recordError, undefined);
});

test('E2 CLI single mode: a failed state write exits 1 with no stack and no path', () => {
  // Breaks when: appendLine throws out of main, or the exit stays 0.
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocker-folder-name');
  writeFileSync(blocker, 'x');
  const good = put(dir, 'g.raw.json', events(CLEAN));
  const c = io();
  let code;
  assert.doesNotThrow(() => { code = main([good, '--state', path.join(blocker, 'sub', 's.jsonl')], c); });
  assert.equal(code, 1);
  assert.match(c.text(), /record-failed/);
  assert.equal(c.text().includes('blocker-folder-name'), false);
});

const noLinks = (...names) => scriptedLs({ ls: names.map((n) => lsLine('100644', n)).join('') });

test('A6 the verdict line carries symlinkCheck: pass with a clean head, void with a link, not-run with no git or no head', () => {
  // Breaks when: symlinkCheck is left off the line, or a run with no git reads as pass.
  const dir = tmpDir();
  const stream = put(dir, 'a6.stream.jsonl.gz', events(CLEAN));
  const run = (extra) => auditReplay({ kind: 'engine', streamPath: stream, runId: 'a6', head: HEAD, pr: 1, round: 1, statePath: path.join(dir, 's.jsonl'), tmpdir: TMP, ...extra }).line.symlinkCheck;
  assert.equal(run({ git: noLinks('main.mjs').git }), 'pass');
  assert.equal(run({ git: scriptedLs({ ls: lsLine('120000', 'link'), target: PRIMARY }).git }), 'void');
  assert.equal(run({}), 'not-run');
  assert.equal(run({ git: noLinks('main.mjs').git, head: null }), 'not-run');
});

test('A7 the head list from git reaches the audit: a tracked tree-level entry passes and is counted on the line, an untracked one voids', () => {
  // Breaks when: auditReplay does not pass the ls-tree list to the audit, so every exempt-form entry voids; or a not-tracked entry passes.
  const dir = tmpDir();
  const mk = (files) => { const evs = events(CLEAN); setGlob(evs, { td: TREE, files }); return put(dir, `a7-${files.length}-${files[0].length}.raw.json`, evs); };
  const o = { kind: 'cursor-review', runId: 'a7', head: HEAD, pr: 1, round: 1, statePath: path.join(dir, 's.jsonl'), tmpdir: TMP, git: noLinks('main.mjs', 'src/a.mjs').git };
  const ok = auditReplay({ ...o, streamPath: mk([`${TL}main.mjs`, `${TL}src\\a.mjs`, `${TL}PR.diff`]) });
  assert.deepEqual(ok.patch, {}, JSON.stringify(ok.line.rules));
  assert.deepEqual(ok.line.exempt['glob-parent-name'], { tree: { tracked: 2, harness: 1 }, folder: { tracked: 0, harness: 0 } });
  assert.equal(JSON.stringify(ok.line).includes('main.mjs'), false);
  const bad = auditReplay({ ...o, streamPath: mk([`${TL}zzz`]) });
  assert.equal(bad.patch.void, true);
  assert.match(bad.patch.reason, /outside-path/);
});

test('A8 a failed ls-tree leaves no head list: an exempt-form entry voids beside symlink-check-failed; with no git at all it voids too', () => {
  // Breaks when: a failed or missing head list is read as "everything tracked".
  const dir = tmpDir();
  const evs = events(CLEAN);
  setGlob(evs, { td: TREE, files: [`${TL}main.mjs`] });
  const stream = put(dir, 'a8.raw.json', evs);
  const base = { kind: 'cursor-review', streamPath: stream, runId: 'a8', head: HEAD, pr: 1, round: 1, statePath: path.join(dir, 's.jsonl'), tmpdir: TMP };
  const failed = auditReplay({ ...base, git: scriptedLs({ lsStatus: 128 }).git });
  assert.match(failed.patch.reason, /outside-path/);
  assert.match(failed.patch.reason, /symlink-check-failed/);
  assert.match(auditReplay(base).patch.reason, /outside-path/);
});

test('F9 the verdict line carries the gap count, and the scan counts streams with a gap and gap events', () => {
  // Breaks when: the gap count is left off the line or the scan.
  const dir = tmpDir();
  const stream = put(dir, 'f9.stream.jsonl.gz', [...events(CLEAN), ...gapEvents()]);
  assert.equal(auditReplay({ kind: 'engine', streamPath: stream, runId: 'f9', head: HEAD, pr: 1, round: 1, statePath: path.join(dir, 's.jsonl'), tmpdir: TMP }).line.gaps, 2);
  const root = tmpDir();
  put(root, `2026-11-04-p1-holdout-a/engine-state/b/h/r1.stream.jsonl.gz`, [...events(CLEAN), ...gapEvents()]);
  put(root, `2026-11-04-p1-holdout-a/engine-state/b/h/r2.stream.jsonl.gz`, events(CLEAN));
  const c = io();
  assert.equal(main(['--scan', '--root', root], c), 0);
  assert.match(c.text(), /streams with a gap: 1, gap events: 2/);
});
