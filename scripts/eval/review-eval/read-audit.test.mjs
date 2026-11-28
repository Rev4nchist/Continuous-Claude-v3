// Failure modes of the answer-key read audit (re-answer-key-audit). Each test names the change that breaks it.
//  V1-V4  primary-checkout read in 4 path forms   -> drop the backslash fold, the drive lower-case, the /c/ map or the \\?\ strip
//  mirror an in-tree read in the same 4 forms      -> the same change makes a fold fail in the other direction (a clean run voids)
//  V5-V9  `..`, grep path, glob dir, grep glob arg, relatedCursorRulePaths -> walk a name list instead of every string
//  V10-V12 unknown kind, no *ToolCall key, hook context -> turn the allow list into a deny list, skip such events, drop the check
//  V13-V15 no init, init cwd of another form, empty or missing stream -> default the tree, test the prefix only, let an empty list pass
//  V16 / N2 symlink to the primary checkout, failed ls-tree -> drop the mode filter, the target check or the failure rule
//  SL-a..f a link target walked through the other links of the head -> go back to a text-only normalize, drop the step cap, resolve a substituted link from the root
//  F7b-F7c --summary --runs with a missing or unreadable runs file -> read it with readLines
//  G1-G9  glob `files` exemption (seat answer 3, B and C): `../.\` + a tracked path or one of 5 harness files at tree level, `../` + the folder path + a tracked path for a folder call
//         -> accept another start, drop the head list, drop the answer-key check on the rest, strip two leading .., resolve against targetDirectory
//  D1-D4  brace patterns; T1-T2 event types; F8-F9 stream gaps; E1-E2 a failed state write; A6-A8 symlinkCheck and the head list
//  Prefix rule (~ % $ file:), no-tool-call, content skip, answer-key whole-segment match, pattern echo skip
//  S1-S5 summary, L1 newest line, C1-C3 scan counts only, A1-A4 auditReplay, CLI modes
//  B1 device paths (GLOBALROOT, Volume{GUID}) in 9 fields and a symlink target -> parseRoot returns null for a `\\?\` path with no drive or UNC share
//  N1 auditReplay throws -> no try; N2a the root compare in isInside; N2b the same-tree check of a second init; N3 no result event
//  M1 `.. ` `.. .` `...` segments -> compare a segment to the two dots only (DOT_DOT, fold, exemptEntry, escapesTree); M2 an unreadable state file in --summary
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

function repoWithLinks(links) {
  const dir = tmpDir();
  const run = (input, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, ...(input === null ? {} : { input }) }).trim();
  run(null, 'init', '-q', '-b', 'main');
  run(null, 'config', 'user.email', 't@t'); run(null, 'config', 'user.name', 't'); run(null, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'f.txt'), '1');
  run(null, 'add', 'f.txt');
  for (const [name, target] of Object.entries(links)) run(null, 'update-index', '--add', '--cacheinfo', `120000,${run(target, 'hash-object', '-w', '--stdin')},${name}`);
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

// ---- SL a link target is walked through the other links of the head ----
/** A scripted git for a head with several links. links: { name: target }. Each name gets its own blob id, so cat-file answers per link. */
function scriptedLinks(links) {
  const entries = Object.entries(links);
  const oid = (i) => String(i + 1).padStart(40, '0');
  const ls = entries.map(([name], i) => `120000 blob ${oid(i)}\t${name}\0`).join('');
  const git = (args) => {
    if (args[0] === 'ls-tree') return { status: 0, stdout: ls, stderr: '' };
    if (args[0] === 'cat-file') return { status: 0, stdout: entries[Number(args[2]) - 1][1], stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  return git;
}
const symlinkRules = (links) => checkHeadSymlinks({ git: scriptedLinks(links), head: HEAD }).filter((x) => x.rule === 'symlink');

test('SL-a a link through another link to a path above the root voids', () => {
  // Breaks when: the target is normalized as text only: alias/../outside reads as "outside" and passes, but a real lookup follows alias (to .) and then leaves the tree.
  assert.equal(symlinkRules({ alias: '.', leak: 'alias/../outside' }).length, 1);
});

test('SL-a2 a link through a link in a folder, then up past the root, voids', () => {
  // Breaks when: the substituted target is resolved from the repo root instead of the folder of the link it replaces.
  assert.equal(symlinkRules({ 'd/up': '..', 'e/leak': '../d/up/../x' }).length, 1, 'd/up is the root, so d/up/.. leaves the tree');
  assert.equal(symlinkRules({ 'a/b/up': '..', 'c/leak': '../a/b/up/../../y' }).length, 1, 'a/b/up is a, so a/b/up/../.. leaves the tree');
});

test('SL-b a link through another link that stays inside the tree passes', () => {
  // Breaks when: every link that names another link voids, or a substituted target is read from the wrong folder.
  assert.deepEqual(symlinkRules({ alias: 'sub', 'sub2/l': '../alias/x' }), []);
});

test('SL-b2 a link through a link that goes up one folder and stays inside passes', () => {
  // Breaks when: a .. that follows a substituted link folder is counted against the wrong depth.
  assert.deepEqual(symlinkRules({ 'a/b/up': '..', 'c/l': '../a/b/up/../y' }), []);
});

test('SL-c a link loop voids at the step cap and does not hang', () => {
  // Breaks when: the walk has no cap (it never returns) or a capped walk passes.
  assert.equal(symlinkRules({ a: 'b', b: 'a' }).length, 2);
  assert.equal(symlinkRules({ self: 'self/x' }).length, 1);
});

test('SL-d an absolute target reached through a link still voids', () => {
  // Breaks when: the absolute check is applied to the first target only.
  assert.equal(symlinkRules({ hop: 'next', next: PRIMARY }).length, 2);
});

test('SL-e a .. above the root at any step voids, a .. inside the tree passes', () => {
  // Breaks when: pop on an empty path is ignored (the .. is dropped) instead of voiding.
  assert.equal(symlinkRules({ l: 'x/../../y' }).length, 1);
  assert.deepEqual(symlinkRules({ l: 'x/../y' }), []);
});

test('SL-g a link whose target text climbs above the root voids, also when a link walk stays inside', () => {
  // Breaks when: only the link walk decides. Windows applies a two-dot step to the path text: l/../.. from the root is above the tree, though the walk (l is a/b/c) ends inside.
  assert.equal(symlinkRules({ l: 'a/b/c', x: 'l/../..' }).length, 1);
  assert.equal(symlinkRules({ 'd/l': 'a/b/c', 'd/x': 'l/../../..' }).length, 1);
  // Both checks agree on a plain inside link.
  assert.deepEqual(symlinkRules({ l: 'a/b/c', 'd/y': '../l/q' }), []);
});

test('SL-f a real repo: alias -> . and leak -> alias/../outside voids, alias -> sub with a link through it passes', () => {
  // Breaks when: the walk uses the scripted map but not the ls-tree and cat-file of a real head.
  const bad = repoWithLinks({ alias: '.', leak: 'alias/../outside' });
  assert.equal(checkHeadSymlinks({ git: gitIn(bad.dir), head: bad.head }).filter((x) => x.rule === 'symlink').length, 1);
  const ok = repoWithLinks({ alias: 'sub', 'sub2/l': '../alias/x' });
  assert.deepEqual(checkHeadSymlinks({ git: gitIn(ok.dir), head: ok.head }), []);
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

test('F7b --summary --runs with a missing or unreadable runs file is an error (exit 2), not "void runs: 0"', () => {
  // Breaks when: readLines is used for the runs file, so a missing file reads as no runs and the summary exits 0.
  const dir = tmpDir();
  for (const bad of [path.join(dir, 'no-such-runs-file.jsonl'), dir]) {
    const c = io();
    let code;
    assert.doesNotThrow(() => { code = main(['--summary', '--runs', bad, '--state', path.join(dir, 'state.jsonl')], c); });
    assert.equal(code, 2);
    assert.equal(/void runs: 0/.test(c.text()), false);
    assert.equal(c.text().includes('no-such-runs-file'), false);
    assert.equal(/\n\s+at /.test(c.text()), false);
  }
});

test('F7c a missing state file is still allowed: the runs are unaudited (exit 1), not an error', () => {
  // Breaks when: the runs-file check is also applied to the state file.
  const dir = tmpDir();
  const runs = path.join(dir, 'runs.jsonl');
  writeFileSync(runs, `${JSON.stringify(row())}\n`);
  const c = io();
  assert.equal(main(['--summary', '--runs', runs, '--state', path.join(dir, 'no-state.jsonl')], c), 1);
  assert.match(c.text(), /unaudited: 1/);
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

// ---- B1: a Windows device path that names no drive and no UNC share is a root (outside, absolute) ----
// The `?` prefix is stripped by parseRoot; with no drive or UNC after it the string used to read as tree-relative. Breaks when: parseRoot returns null for such a string.
const GUID = '{12345678-1234-1234-1234-123456789abc}';
const DEVICE_PREFIXES = [['\\\\?\\', '\\'], ['\\\\.\\', '\\'], ['//?/', '/'], ['//./', '/'], ['\\/?\\', '\\'], ['/\\.\\', '\\']];
const DEVICE_TAILS = ['GLOBALROOT\\??\\C:\\work\\primary\\x', 'GLOBALROOT\\Device\\HarddiskVolume3\\work\\primary\\x', `Volume${GUID}\\work\\primary\\x`];
const DEVICE_FORMS = DEVICE_PREFIXES.flatMap(([p, sep]) => DEVICE_TAILS.map((t) => `${p}${sep === '/' ? t.replace(/\\/g, '/') : t}`));
const B1_FIELDS = {
  'read args.path': (f) => { const evs = events(CLEAN); setReadPath(evs, f); return [evs, { tool: 'read', field: 'args.path' }]; },
  'grep args.path': (f) => { const evs = events(CLEAN); setGrep(evs, (b) => { b.args.path = f; }); return [evs, { tool: 'grep', field: 'args.path' }]; },
  'glob targetDirectory': (f) => { const evs = events(CLEAN); setGlob(evs, { td: f }); return [evs, { tool: 'glob', field: 'args.targetDirectory' }]; },
  'glob files entry': (f) => { const evs = events(CLEAN); setGlob(evs, { files: [f] }); return [evs, { tool: 'glob', field: 'result.success.files[0]' }]; },
  'grep workspaceResults key': (f) => { const evs = events(CLEAN); setGrep(evs, (b) => { if (b.result) b.result.success.workspaceResults = { [f]: { content: {} } }; }); return [evs, { tool: 'grep' }]; },
  'glob pattern': (f) => [withGlobPattern(f), { tool: 'glob', field: 'args.globPattern' }],
  'grep glob argument': (f) => [withGrepGlob(f), { tool: 'grep', field: 'args.glob' }],
  'glob pattern, inside a brace alternative': (f) => [withGlobPattern(`{a,${f}}`), { tool: 'glob', field: 'args.globPattern' }],
  'grep glob argument, inside a brace alternative': (f) => [withGrepGlob(`{${f},a}`), { tool: 'grep', field: 'args.glob' }],
};
for (const [label, make] of Object.entries(B1_FIELDS)) {
  for (const form of DEVICE_FORMS) {
    test(`B1 ${label}: the device path ${form} voids`, () => {
      const [evs, want] = make(form);
      const r = audit(evs);
      assert.equal(r.verdict, 'void');
      assert.ok(hit(r, 'outside-path', want), JSON.stringify(r.rules));
    });
  }
}
for (const form of DEVICE_FORMS) {
  test(`B1 a symlink target ${form} voids`, () => {
    const { git } = scriptedLs({ ls: lsLine('120000', 'link'), target: form });
    assert.ok(checkHeadSymlinks({ git, head: HEAD }).some((x) => x.rule === 'symlink'), form);
  });
}

test('B1 a read of an answer file through a device path carries the answer-key tag', () => {
  // Breaks when: the device path is read as tree-relative, so the read passes and no tag is set.
  const evs = events(CLEAN);
  setReadPath(evs, '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\work\\primary\\review-eval\\gold\\x.json');
  const r = audit(evs);
  assert.ok(hit(r, 'outside-path', { tool: 'read', field: 'args.path', answerKey: true }), JSON.stringify(r.rules));
  assert.ok(hit(r, 'answer-key'));
});

test('B1 the long-path drive form inside the tree and the existing UNC prefix keep their old verdict', () => {
  // Breaks when: the new device-root rule swallows the drive and UNC forms that parseRoot already unwraps.
  const inside = events(CLEAN);
  setReadPath(inside, `\\\\?\\${TREE}\\src\\a.mjs`);
  assert.equal(audit(inside).verdict, 'pass');
  const slashed = events(CLEAN);
  setReadPath(slashed, `//?/${TREE.replace(/\\/g, '/')}/src/a.mjs`);
  assert.equal(audit(slashed).verdict, 'pass');
  for (const form of ['\\\\?\\UNC\\server\\share\\x', '\\\\?\\D:\\fake\\tmp\\cursor-review-abc123\\tree\\x']) {
    const evs = events(CLEAN);
    setReadPath(evs, form);
    assert.equal(audit(evs).verdict, 'void', form);
  }
});

// ---- N2: the two rules the mutants left green ----
test('N2a the root of a path is compared, not only its segments: the same segments on another drive, a UNC root or a / root are outside', () => {
  // Breaks when: `n.root === tree.root` is dropped from isInside (read-audit.mjs, the return line of isInside).
  const same = 'fake\\tmp\\cursor-review-abc123\\tree\\src\\a.mjs';
  for (const form of [`D:\\${same}`, `d:/${same.replace(/\\/g, '/')}`, `\\\\${same}`, `\\${same}`, `/${same.replace(/\\/g, '/')}`, `\\\\?\\D:\\${same}`]) {
    const evs = events(CLEAN);
    setReadPath(evs, form);
    const r = audit(evs);
    assert.equal(r.verdict, 'void', form);
    assert.ok(hit(r, 'outside-path', { tool: 'read', field: 'args.path' }), form);
  }
  const ok = events(CLEAN);
  setReadPath(ok, `C:\\${same}`);
  assert.equal(audit(ok).verdict, 'pass');
});

test('N2b a second init event with another cwd voids, one with the same cwd passes', () => {
  // Breaks when: the `sameDir` compare is dropped from auditInits (read-audit.mjs, the `bad` line): the second cwd is itself a valid tree form.
  const other = `${TMP}\\cursor-review-def456\\tree`;
  const withSecond = (cwd) => { const evs = events(CLEAN); evs.splice(1, 0, { ...evs[0], cwd }); return evs; };
  const r = audit(withSecond(other));
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'tree-form', { field: 'cwd' }), JSON.stringify(r.rules));
  assert.equal(audit(withSecond(TREE)).verdict, 'pass');
  assert.equal(audit(withSecond(TREE.toUpperCase().replace('C:', 'c:'))).verdict, 'pass');
});

// ---- M1: Windows drops trailing spaces and dots of a segment, so `.. ` acts as `..` ----
// Breaks when: DOT_DOT, fold, exemptEntry or escapesTree compares a segment to the two dots only.
const SPACED_PARENTS = ['.. ', '..  ', '.. .'];
test('M1 a path whose parent segment carries trailing spaces or dots climbs out of the tree and voids', () => {
  for (const seg of SPACED_PARENTS) {
    const read = events(CLEAN);
    setReadPath(read, `${TREE}\\${seg}\\..\\x`);
    assert.equal(audit(read).verdict, 'void', `read ${JSON.stringify(seg)}`);
    const rel = events(CLEAN);
    setReadPath(rel, `${seg}\\${seg}\\x`);
    assert.equal(audit(rel).verdict, 'void', `relative read ${JSON.stringify(seg)}`);
    const grep = events(CLEAN);
    setGrep(grep, (b) => { b.args.path = `${TREE}\\${seg}\\..\\x`; });
    assert.ok(hit(audit(grep), 'outside-path', { tool: 'grep', field: 'args.path' }), `grep ${JSON.stringify(seg)}`);
    const td = events(CLEAN);
    setGlob(td, { td: `${TREE}\\${seg}\\..\\x` });
    assert.ok(hit(audit(td), 'outside-path', { tool: 'glob', field: 'args.targetDirectory' }), `glob dir ${JSON.stringify(seg)}`);
    const files = events(CLEAN);
    setGlob(files, { files: [`${seg}\\x`] });
    assert.ok(hit(audit(files), 'outside-path', { tool: 'glob', field: 'result.success.files[0]' }), `glob files ${JSON.stringify(seg)}`);
    assert.equal(audit(withGlobPattern(`{a,b}/${seg}/x`)).verdict, 'void', `brace ${JSON.stringify(seg)}`);
    assert.equal(audit(withGrepGlob(`{a,b}/${seg}/x`)).verdict, 'void', `brace grep ${JSON.stringify(seg)}`);
    const { git } = scriptedLs({ ls: lsLine('120000', 'link'), target: `${seg}/x` });
    assert.ok(checkHeadSymlinks({ git, head: HEAD }).some((x) => x.rule === 'symlink'), `symlink ${JSON.stringify(seg)}`);
  }
});

test('M1b a spaced parent segment that stays inside the tree resolves as a parent and passes', () => {
  // Breaks when: the spaced segment is kept as a folder name (fold) or every spaced segment voids.
  const evs = events(CLEAN);
  setReadPath(evs, `${TREE}\\src\\.. \\src\\a.mjs`);
  assert.equal(audit(evs).verdict, 'pass');
  const { git } = scriptedLs({ ls: lsLine('120000', 'a/b/link'), target: '.. /x' });
  assert.deepEqual(checkHeadSymlinks({ git, head: HEAD }), []);
});

test('M1c a segment of only dots and spaces that is not one or two dots cannot be resolved: it voids as outside', () => {
  // Breaks when: `...` is kept as a folder name. Windows treats a run of three dots as a name or trims it away: the audit cannot tell, so it fails closed.
  for (const seg of ['...', '. ', ' .', '....']) {
    const evs = events(CLEAN);
    setReadPath(evs, `${TREE}\\${seg}\\a.mjs`);
    assert.equal(audit(evs).verdict, 'void', JSON.stringify(seg));
    const rel = events(CLEAN);
    setReadPath(rel, `x\\${seg}\\a.mjs`);
    assert.equal(audit(rel).verdict, 'void', `relative ${JSON.stringify(seg)}`);
    const { git } = scriptedLs({ ls: lsLine('120000', 'link'), target: `${seg}/x` });
    assert.ok(checkHeadSymlinks({ git, head: HEAD }).some((x) => x.rule === 'symlink'), `symlink ${JSON.stringify(seg)}`);
  }
});

test('M1d ordinary names with dots, a single dot segment and a number range keep their verdict', () => {
  // Breaks when: the dots-and-spaces test matches a name that holds letters, one dot, or a brace range.
  for (const p of [`${TREE}\\src\\a.b.mjs`, `${TREE}\\.\\src\\a.mjs`, `${TREE}\\.hidden\\a.mjs`, `${TREE}\\src\\a..b.mjs`, `${TREE}\\src\\..a\\x`]) {
    const evs = events(CLEAN);
    setReadPath(evs, p);
    assert.equal(audit(evs).verdict, 'pass', p);
  }
  assert.equal(audit(withGlobPattern('{1..3}.mjs')).verdict, 'pass');
});

test('M1e the glob-parent-name exemption refuses a spaced parent segment in the rest, even when the head lists that name', () => {
  // Breaks when: exemptEntry tests the rest for the two dots only.
  const evs = events(CLEAN);
  setGlob(evs, { td: TREE, files: [`${TL}.. \\main.mjs`] });
  const r = audit(evs, { tracked: ['.. /main.mjs'] });
  assert.equal(r.verdict, 'void');
  assert.deepEqual(r.exempt.tree, { tracked: 0, harness: 0 });
});

// ---- M2: a state file that exists but cannot be read ----
test('M2 --summary with a state file that is a folder exits 2 with a fixed message, no path and no stack; a missing state file still gives exit 1', () => {
  // Breaks when: the readLines call in summaryMode has no guard (a throw with a stack), or the guard also catches a missing file.
  const dir = tmpDir();
  const runs = path.join(dir, 'runs.jsonl');
  writeFileSync(runs, `${JSON.stringify({ pr: 1, round: 1, sha40: HEAD, status: 'ok', cursorRunId: 'r1' })}\n`);
  const folder = path.join(dir, 'state-is-a-folder');
  mkdirSync(folder);
  const c = io();
  let code;
  assert.doesNotThrow(() => { code = main(['--summary', '--runs', runs, '--state', folder], c); });
  assert.equal(code, 2);
  assert.match(c.text(), /state file/);
  for (const bad of [dir, 'state-is-a-folder', 'EISDIR', 'unaudited']) assert.equal(c.text().includes(bad), false, bad);
  assert.equal(/\n\s+at /.test(c.text()), false);
  const m = io();
  assert.equal(main(['--summary', '--runs', runs, '--state', path.join(dir, 'missing.jsonl')], m), 1);
  assert.match(m.text(), /unaudited: 1\b/);
});

// ---- N1: auditReplay never throws ----
test('N1 auditReplay catches its own throw: a git handle that throws, or a bad clock, gives a void patch with read-audit: audit-error, never a throw', () => {
  // Breaks when: auditReplay has no try. The caller then writes no row at all.
  const dir = tmpDir();
  const stream = put(dir, 'n1.raw.json', events(CLEAN));
  const o = { kind: 'cursor-review', streamPath: stream, runId: 'n1', head: HEAD, pr: 1, round: 1, tmpdir: TMP };
  const SECRET = 'secret-path-text';
  const throwing = { git: () => { throw new Error(SECRET); } };
  const clock = { now: () => { throw new Error(SECRET); } };
  for (const [name, extra] of [['git', throwing], ['clock', clock]]) {
    const statePath = path.join(dir, `${name}.jsonl`);
    let r;
    assert.doesNotThrow(() => { r = auditReplay({ ...o, statePath, ...extra }); }, name);
    assert.deepEqual(r.patch, { status: 'failed', void: true, reason: 'read-audit: audit-error' }, name);
    const [line, ...more] = readLines(statePath);
    assert.equal(more.length, 0);
    assert.deepEqual([line.verdict, line.runId, line.rules.map((x) => x.rule)], ['void', 'n1', ['audit-error']], name);
    assert.equal(JSON.stringify([r, line]).includes(SECRET), false, 'the error text never reaches the patch or the line');
  }
});

// ---- no-result: a stream cut at a line end holds no result event ----
test('N3 a stream with no result event voids with no-result; one with a result event passes', () => {
  // Breaks when: the no-result rule is dropped: a stream cut exactly at a line end passes.
  const cut = events(CLEAN).filter((e) => e.type !== 'result');
  const r = audit(cut);
  assert.equal(r.verdict, 'void');
  assert.ok(hit(r, 'no-result', { field: 'stream' }), JSON.stringify(r.rules));
  assert.equal(audit(events(CLEAN)).verdict, 'pass');
});

test('N3b no-result applies only to a run that reports success: runOk false gives no void for it, and every other rule still applies', () => {
  // Breaks when: the runOk option is ignored (a timed-out run is voided for good), or runOk false switches off another rule.
  const cut = events(CLEAN).filter((e) => e.type !== 'result');
  assert.equal(audit(cut, { runOk: false }).verdict, 'pass');
  assert.equal(audit(cut, { runOk: true }).verdict, 'void');
  assert.equal(audit(cut).verdict, 'void', 'the default is strict');
  const noCalls = cut.filter((e) => e.type !== 'tool_call');
  assert.deepEqual(audit(noCalls, { runOk: false }).rules.map((x) => x.rule), ['no-tool-call']);
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

// ---- read-audit-followups: letter case, climb names, backslash names, runOk and result count on the line ----
/** A scripted git whose head holds plain files (mode 100644) with these names. */
function scriptedNames(namesList) {
  const ls = namesList.map((name, i) => `100644 blob ${String(i + 1).padStart(40, '0')}\t${name}\0`).join('');
  return (args) => (args[0] === 'ls-tree' ? { status: 0, stdout: ls, stderr: '' } : { status: 1, stdout: '', stderr: '' });
}
const rulesOfNames = (list, rule) => checkHeadSymlinks({ git: scriptedNames(list), head: HEAD }).filter((x) => x.rule === rule);

test('FU1 link names are looked up without letter case: Alias -> . and leak -> alias/../outside voids', () => {
  // Breaks when: the links map or its lookup keeps letter case. A case-blind file system (WSL on NTFS, macOS) follows alias to Alias, then leaves the tree.
  assert.equal(symlinkRules({ Alias: '.', leak: 'alias/../outside' }).length, 1);
  assert.equal(symlinkRules({ 'A/b/Up': '..', 'c/leak': '../a/B/UP/../../y' }).length, 1, 'a chain with mixed case at two links');
  assert.deepEqual(symlinkRules({ Alias: 'sub', 'sub2/l': '../ALIAS/x' }), [], 'a mixed-case link that stays inside passes');
});

test('FU2 a tracked name with a segment of dots and spaces voids with climb-name; a normal dot name passes', () => {
  // Breaks when: the head check reads link targets only, or the segment test is not the climb test (a name such as ..foo or .hidden must pass).
  for (const bad of ['a/.. /x', 'a/.../x', 'a/. /x', '.. ']) assert.equal(rulesOfNames(['f.txt', bad], 'climb-name').length, 1, bad);
  assert.deepEqual(checkHeadSymlinks({ git: scriptedNames(['.gitignore', '..foo', 'a.b', 'x/.hidden/y', 'a/. b/c', 'f.txt']), head: HEAD }), []);
});

test('FU3 a link name with a backslash voids; a target walked on slash only is checked too', () => {
  // Breaks when: a link named a\b is looked up as a/b, or the walk reads only the Windows form of a target.
  assert.equal(symlinkRules({ 'a\\b': 'f.txt' }).length, 1);
  // Windows reads a\b as two segments (stays inside), a slash-only lookup reads one name (three parent steps leave the tree).
  assert.equal(symlinkRules({ 'd/l': 'a\\b/../../..' }).length, 1);
  assert.deepEqual(symlinkRules({ 'd/l': 'a\\b' }), [], 'a backslash target alone is not void');
});

/** A real repo whose head holds links with names that git refuses in the index on Windows (a backslash). A flat tree from git mktree and commit-tree: no index, no checkout. */
function repoWithRawLinks(links) {
  const dir = tmpDir();
  const run = (input, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, ...(input === null ? {} : { input }) }).trim();
  run(null, 'init', '-q', '-b', 'main');
  const rows = Object.entries(links).map(([name, target]) => `120000 blob ${run(target, 'hash-object', '-w', '--stdin')}\t${name}\n`).join('');
  const tree = run(rows, 'mktree');
  const head = run(null, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', tree, '-m', 'c1');
  return { dir, head };
}

test('FU3b a real repo: a mixed-case link chain (update-index) and a backslash link name (mktree), no checkout', () => {
  // Breaks when: the real ls-tree and cat-file path differs from the scripted one.
  const bad = repoWithLinks({ Alias: '.', leak: 'alias/../outside' });
  assert.equal(checkHeadSymlinks({ git: gitIn(bad.dir), head: bad.head }).filter((x) => x.rule === 'symlink').length, 1);
  const back = repoWithRawLinks({ 'a\\b': 'f.txt' });
  assert.equal(checkHeadSymlinks({ git: gitIn(back.dir), head: back.head }).filter((x) => x.rule === 'symlink').length, 1);
});

test('FU4 AUDIT_VERSION is 2: items 1 to 3 add rules and item 5 adds fields', () => {
  // Breaks when: a rule or line-format change lands with the version at 1.
  assert.equal(AUDIT_VERSION, 2);
});

test('FU5 the state line holds runOk and the result event count, so a cut stream of an incomplete run is told from a full one', () => {
  // Breaks when: buildLine drops either field, or takes runOk from the wrong place.
  const dir = tmpDir();
  const statePath = path.join(dir, 'state.jsonl');
  const cut = put(dir, 'cut.stream.jsonl.gz', events(['init', 'glob', 'read', 'grep']));
  const full = put(dir, 'full.stream.jsonl.gz', events(CLEAN));
  const a = auditReplay({ kind: 'engine', streamPath: cut, runId: 'cut', runOk: false, head: HEAD, pr: 1, round: 1, statePath, tmpdir: TMP }).line;
  assert.deepEqual([a.verdict, a.runOk, a.resultEvents], ['pass', false, 0]);
  const b = auditReplay({ kind: 'engine', streamPath: full, runId: 'full', runOk: true, head: HEAD, pr: 1, round: 1, statePath, tmpdir: TMP }).line;
  assert.deepEqual([b.verdict, b.runOk, b.resultEvents], ['pass', true, 1]);
  const c = auditReplay({ kind: 'cursor-review', streamPath: full, runId: 'dflt', head: HEAD, pr: 1, round: 1, statePath, tmpdir: TMP }).line;
  assert.equal(c.runOk, true, 'runOk defaults to true');
  const d = auditReplay({ kind: 'engine', streamPath: null, runId: 'none', head: HEAD, pr: 1, round: 1, statePath, tmpdir: TMP }).line;
  assert.deepEqual([d.verdict, d.runOk, d.resultEvents], ['void', true, 0], 'a void with no stream still carries both fields');
  assert.deepEqual(readLines(statePath).map((l) => [l.runId, l.runOk, l.resultEvents]), [['cut', false, 0], ['full', true, 1], ['dflt', true, 1], ['none', true, 0]]);
  const single = io();
  assert.equal(main([full, '--no-record', '--run-id', 'one'], { ...single, tmpdir: TMP }), 0);
  const printed = JSON.parse(single.text().trim().split('\n').pop());
  assert.deepEqual([printed.runOk, printed.resultEvents], [true, 1]);
});
