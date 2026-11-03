// Tests for author.mjs. Every test imports the real function. Git, the agent and the file system are injected or temporary.
// None of them starts cursor-agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCH_CAP, BENCH_TIMEOUT_SEC, GROUP_CAP, GROUPS, P0_CHECKS, P0_DRIVERS, analyzeStream, authorGroup, benchGit, benchRuns, blobAt, freeze, hostFlowDigest, leakScan,
  lintFlow, main, mapNegatives, parseArgs, parseAuthorOutput, renderPrompt,
} from './author.mjs';
import { makeTrexGit } from '../lib/git.mjs';
import { runAgent } from '../../github/cursor-review.mjs';

const FIX = 'f0b67364aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHANGED = ['scripts/github/pre-pr.mjs', '.claude/hooks/src/pre-pr-gate.ts'];

const tmp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trex-author-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const put = (dir, rel, text) => {
  const p = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};

const flowYaml = (extra = '') => `id: gate-blocks-inline-body
title: gate blocks an inline body
description: a PR create call whose body the gate cannot match
goal: the hook blocks the call
paths: [scripts/github/pre-pr.mjs]
driver: hook
${extra}steps:
  - action: {hook: .claude/hooks/dist/pre-pr-gate.mjs, payload: fixtures/payload.json}
    checks:
      - {text: gate blocks the call, stdout: "BLOCKED"}
`;
const hostYaml = (driver, action, extra = '') => `id: host-flow-one
title: host flow
description: d
goal: g
paths: [scripts/github/pre-pr.mjs]
driver: ${driver}
profile: host
${extra}steps:
  - action: ${action}
    checks:
      - {text: passes, exit: 0}
`;

// ---------- leakScan ----------

const ROWS = [{ id: 'S1', pre: '23b62e5daaaaaaaa', fix: FIX, subject: 'fix: stop the space-path leak in safe-message' }];

test('leakScan flags a file that names the fix sha (8 chars or the full sha)', (t) => {
  const dir = tmp(t);
  put(dir, 'docs/a.md', 'see commit f0b67364 for the change');
  put(dir, 'docs/b.md', `full ${FIX}`);
  put(dir, 'docs/ok.md', 'commit f0b67365 is another one');
  const hits = leakScan(dir, ROWS);
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.includes('docs/a.md')) && hits.some((h) => h.includes('docs/b.md')));
});

test('leakScan flags the pre sha and the fix commit subject, and skips binary files', (t) => {
  const dir = tmp(t);
  put(dir, 'notes.txt', 'base was 23b62e5d');
  put(dir, 'log.txt', 'Fix: Stop the space-path leak in safe-message');
  writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0x66, 0x30, 0x62, 0x36, 0x37, 0x33, 0x36, 0x34]));
  const hits = leakScan(dir, ROWS);
  assert.equal(hits.length, 2);
  assert.ok(!hits.some((h) => h.includes('blob.bin')));
});

test('leakScan flags a file that names a fix file next to its row id, but not a plain mention', (t) => {
  const dir = tmp(t);
  const rows = [{ id: 'S12', pre: '707612bd', fix: 'a4952ff5', fixFiles: ['scripts/github/land-pr.ps1'] }];
  put(dir, 'docs/answers.md', 'S12 is the land-pr bug in scripts/github/land-pr.ps1');
  put(dir, 'docs/plain.md', 'run scripts/github/land-pr.ps1 to land a PR');
  put(dir, 'src/code.test.mjs', '// S12 checks scripts/github/land-pr.ps1');
  put(dir, 'PR.diff', '+ S12 scripts/github/land-pr.ps1');
  const hits = leakScan(dir, rows);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /docs\/answers\.md/);
});

test('leakScan returns nothing for a clean tree', (t) => {
  const dir = tmp(t);
  put(dir, 'src/a.ts', 'export const a = 1; // deadbeef is not a bench sha');
  assert.deepEqual(leakScan(dir, ROWS), []);
});

// ---------- parseAuthorOutput ----------

const answer = (files, manifest, tail = '') => `${files.map(([p, body]) => `\`\`\`file path=${p}\n${body}\n\`\`\``).join('\n')}\nNotes for scripts/github/pre-pr.mjs.\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\`${tail}`;
const MANIFEST = { flows: [{ id: 'gate-blocks-inline-body', file: 'gate.yaml', risk: 'inline body' }], cannotVerify: [{ risk: 'scale', why: 'no 10k repo' }] };

test('parseAuthorOutput reads file blocks and the manifest', () => {
  const r = parseAuthorOutput(answer([['gate.yaml', flowYaml()], ['fixtures/payload.json', '{}']], MANIFEST), CHANGED);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.files.map((f) => f.path), ['gate.yaml', 'fixtures/payload.json']);
  assert.equal(r.files[1].text, '{}');
  assert.equal(r.manifest.flows[0].id, 'gate-blocks-inline-body');
});

test('parseAuthorOutput rejects a path outside the group folder', () => {
  for (const bad of ['../x.yaml', '/etc/x.yaml', 'a\\b.yaml', 'C:/x.yaml', 'a/../../x.yaml', './x.yaml']) {
    const r = parseAuthorOutput(answer([[bad, flowYaml()]], { flows: [{ id: 'gate-blocks-inline-body', file: bad, risk: 'r' }], cannotVerify: [] }), CHANGED);
    assert.ok(r.problems.some((p) => /path/i.test(p)), `no path problem for ${bad}`);
  }
});

test('parseAuthorOutput reports an answer that cites no changed file', () => {
  const text = answer([['gate.yaml', flowYaml().replace('scripts/github/pre-pr.mjs', 'other/file.mjs')]], MANIFEST).replace('scripts/github/pre-pr.mjs', 'x');
  assert.ok(parseAuthorOutput(text, CHANGED).problems.some((p) => /changed file/i.test(p)));
});

test('parseAuthorOutput reports a missing manifest, a missing file and an unlisted flow file', () => {
  assert.ok(parseAuthorOutput(`\`\`\`file path=gate.yaml\n${flowYaml()}\n\`\`\`\nscripts/github/pre-pr.mjs`, CHANGED).problems.some((p) => /manifest/i.test(p)));
  const missing = parseAuthorOutput(answer([['fixtures/payload.json', '{}']], MANIFEST), CHANGED);
  assert.ok(missing.problems.some((p) => /gate\.yaml/.test(p)));
  const unlisted = parseAuthorOutput(answer([['gate.yaml', flowYaml()], ['extra.yaml', flowYaml()]], MANIFEST), CHANGED);
  assert.ok(unlisted.problems.some((p) => /extra\.yaml/.test(p)));
});

test('parseAuthorOutput reports text after the manifest and a duplicate path', () => {
  assert.ok(parseAuthorOutput(answer([['gate.yaml', flowYaml()]], MANIFEST, '\nthanks'), CHANGED).problems.some((p) => /manifest/i.test(p)));
  const dup = parseAuthorOutput(answer([['gate.yaml', flowYaml()], ['gate.yaml', flowYaml()]], MANIFEST), CHANGED);
  assert.ok(dup.problems.some((p) => /twice|duplicate/i.test(p)));
});

// A short cut of the real S17 answer (2026-11-03): the first file fence starts mid-line, right after prose.
const S17_PROSE = 'I\'ll read the diff and the changed files first.The diff is mostly a Windows daemon-pipe fix. I\'ll read those files to see which defect a user would actually hit.';
const S17_YAML = 'id: daemon-spawn-pipe-contract\ntitle: Daemon spawn clears inheritable pipes\ndescription: d\ngoal: g\npaths:\n  - scripts/start-embedding-daemon.ps1';
const S17_MANIFEST = { flows: [{ id: 'daemon-spawn-pipe-contract', file: 'daemon-spawn-pipe-contract.yaml', risk: 'pipe' }], cannotVerify: [{ risk: 'r', why: 'w' }] };
const s17Answer = (opener) => `${S17_PROSE}${opener}\n${S17_YAML}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(S17_MANIFEST)}\n\`\`\``;

test('parseAuthorOutput accepts an opening file fence that follows prose on the same line (real S17 shape)', () => {
  // Breaks when fileBlocks goes back to matching the opener only at line start: the S17 run failed with "no file block wrote it".
  const r = parseAuthorOutput(s17Answer('```file path=daemon-spawn-pipe-contract.yaml'), ['scripts/start-embedding-daemon.ps1']);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.files.map((f) => f.path), ['daemon-spawn-pipe-contract.yaml']);
  assert.equal(r.files[0].text, S17_YAML, 'the prose before the fence is not part of the file');
  assert.equal(r.manifest.flows[0].id, 'daemon-spawn-pipe-contract');
});

test('parseAuthorOutput keeps the closing-fence rule for a mid-line opener', () => {
  // A closing fence that follows text on its line is not a closer: the block stays open to the end and is reported.
  const text = `${S17_PROSE}\`\`\`file path=a.yaml\n${S17_YAML}\nend\`\`\`\n\`\`\`json\n${JSON.stringify(S17_MANIFEST)}\n\`\`\``;
  const r = parseAuthorOutput(text, ['scripts/start-embedding-daemon.ps1']);
  assert.ok(r.problems.some((p) => /a\.yaml/.test(p)), r.problems.join('; '));
});

test('parseAuthorOutput does not treat a ``` in prose that is not "```file path=" as a fence', () => {
  // Breaks when the mid-line rule matches any ``` instead of only the file-path opener.
  for (const prose of ['Use ```bash to run it.', 'A ```json example follows', 'text ```file without a path', 'text ```files path=x.yaml']) {
    const r = parseAuthorOutput(`${prose}\n${S17_YAML}\n\`\`\`\n\`\`\`json\n${JSON.stringify(S17_MANIFEST)}\n\`\`\``, ['scripts/start-embedding-daemon.ps1']);
    assert.equal(r.files.length, 0, prose);
    assert.ok(r.problems.some((p) => /no file block/.test(p)), prose);
  }
  // Prose with a stray fence, then a real line-start block: only the real block is a file.
  const both = parseAuthorOutput(`Use \`\`\`bash to run it.\n\`\`\`file path=a.yaml\n${S17_YAML}\n\`\`\`\n\`\`\`json\n${JSON.stringify({ flows: [{ id: 'daemon-spawn-pipe-contract', file: 'a.yaml', risk: 'r' }], cannotVerify: [] })}\n\`\`\``, ['scripts/start-embedding-daemon.ps1']);
  assert.deepEqual(both.problems, []);
  assert.deepEqual(both.files.map((f) => f.path), ['a.yaml']);
});

// ---------- lintFlow ----------

test('lintFlow accepts a valid scripted flow', () => {
  assert.deepEqual(lintFlow(flowYaml(), CHANGED), []);
});

test('lintFlow rejects a judge check, start.note and an agent flow', () => {
  const judge = flowYaml().replace('stdout: "BLOCKED"}', 'judge: {artifact: out.txt}}');
  assert.ok(lintFlow(judge, CHANGED).some((p) => /judge/.test(p)));
  assert.ok(lintFlow(flowYaml('start:\n  note: look at it\n'), CHANGED).some((p) => /note/.test(p)));
  assert.ok(lintFlow(flowYaml('mode: agent\n'), CHANGED).some((p) => /scripted/.test(p)));
});

test('lintFlow rejects bad YAML and a schema error', () => {
  assert.ok(lintFlow('id: [unclosed', CHANGED).some((p) => /YAML/i.test(p)));
  assert.ok(lintFlow(flowYaml().replace('driver: hook', 'driver: ftp'), CHANGED).length > 0);
});

test('lintFlow rejects paths that hit no changed file', () => {
  const p = lintFlow(flowYaml().replace('[scripts/github/pre-pr.mjs]', '[docs/**]'), CHANGED);
  assert.ok(p.some((m) => /changed file/i.test(m)));
  assert.deepEqual(lintFlow(flowYaml().replace('[scripts/github/pre-pr.mjs]', '[scripts/github/*.mjs]'), CHANGED), []);
});

test('lintFlow rejects a fixture the group folder does not hold', () => {
  const p = lintFlow(flowYaml(), CHANGED, { files: ['gate.yaml'] });
  assert.ok(p.some((m) => /fixtures\/payload\.json/.test(m)));
  assert.deepEqual(lintFlow(flowYaml(), CHANGED, { files: ['gate.yaml', 'fixtures/payload.json'] }), []);
});

const treeHas = { treeHas: (p) => p === 'scripts/land-pr.ps1' || p === 'scripts/x.ps1' };

test('lintFlow allows the two host shapes only', () => {
  assert.deepEqual(lintFlow(hostYaml('mod-event', '{test: brief-hook}'), CHANGED), []);
  assert.deepEqual(lintFlow(hostYaml('cli', '{cmd: [pwsh, -NoProfile, -File, scripts/land-pr.ps1]}'), CHANGED, treeHas), []);
});

test('lintFlow refuses a host .ps1 that is not in the tree at the group head, or lives under the flows dir', () => {
  const yaml = hostYaml('cli', '{cmd: [pwsh, -NoProfile, -File, scripts/land-pr.ps1]}');
  assert.ok(lintFlow(yaml, CHANGED).some((m) => /host/i.test(m) && /does not exist/.test(m)), 'no treeHas given');
  assert.ok(lintFlow(yaml, CHANGED, { treeHas: () => false }).some((m) => /does not exist/.test(m)));
  const own = hostYaml('cli', '{cmd: [pwsh, -NoProfile, -File, scripts/trex/bench/flows/S15/run.ps1]}');
  assert.ok(lintFlow(own, CHANGED, { treeHas: () => true }).some((m) => /host/i.test(m) && /flows/.test(m)));
});

test('lintFlow rejects every other host argv', () => {
  const bad = [
    '{cmd: [node, scripts/x.mjs]}',
    '{cmd: [pwsh, -File, scripts/x.ps1]}',
    '{cmd: [pwsh, -NoProfile, -Command, "rm -rf ."]}',
    '{cmd: [pwsh, -NoProfile, -File, scripts/x.ps1, extra]}',
    '{cmd: [pwsh, -NoProfile, -File, scripts/x.sh]}',
    '{cmd: [pwsh, -NoProfile, -File, C:/x.ps1]}',
    '{cmd: [pwsh, -NoProfile, -File, scripts/x.ps1], env: {A: b}}',
    '{cmd: [pwsh, -NoProfile, -File, scripts/x.ps1], stdin: hi}',
  ];
  for (const action of bad) assert.ok(lintFlow(hostYaml('cli', action), CHANGED, treeHas).some((m) => /host/i.test(m)), `host argv passed: ${action}`);
  assert.ok(lintFlow(hostYaml('mod-event', '{test: -rf}'), CHANGED).some((m) => /host/i.test(m)));
});

test('lintFlow rejects a host flow with a hook, api or browser driver, or a setup command', () => {
  assert.ok(lintFlow(hostYaml('hook', '{hook: .claude/hooks/dist/a.mjs, payload: p.json}'), CHANGED).some((m) => /host/i.test(m)));
  assert.ok(lintFlow(hostYaml('api', '{method: GET, path: /x}'), CHANGED).some((m) => /host/i.test(m)));
  assert.ok(lintFlow(hostYaml('mod-event', '{test: t}', 'start:\n  run: [node, x.mjs]\n'), CHANGED).some((m) => /host/i.test(m)));
});

// ---------- mapNegatives ----------

const gitFrom = (handlers) => (args) => {
  const key = args.join(' ');
  for (const [re, fn] of handlers) {
    const m = re.exec(key);
    if (m) return { stderr: '', ...fn(m, args) };
  }
  return { status: 1, stdout: '', stderr: `unhandled git ${key}` };
};
const GROUP_FLOWS = { S1: [{ id: 'one', paths: ['apps/agentic-os/src/**'] }], S8: [{ id: 'two', paths: ['scripts/settings/*.mjs'] }] };
const mapGit = ({ changed = {}, ancestor = () => true } = {}) => gitFrom([
  [/^diff --name-only --no-renames (\S+)\^1 \1$/, (m) => ({ status: 0, stdout: `${(changed[m[1]] ?? []).join('\n')}\n` })],
  [/^merge-base --is-ancestor (\S+) (\S+)$/, (m) => ({ status: ancestor(m[1], m[2]) ? 0 : 1, stdout: '' })],
]);

test('mapNegatives drops N1, N4 and N5', () => {
  const git = mapGit({ changed: { aaa: ['apps/agentic-os/src/x.ts'] } });
  const negs = ['N1', 'N2', 'N4', 'N5'].map((id) => ({ id, head: 'aaa' }));
  const r = mapNegatives(negs, { groups: GROUP_FLOWS, fixes: { S1: 'f1', S8: 'f8' } }, git);
  assert.deepEqual(Object.keys(r.negatives), ['N2']);
  assert.deepEqual(r.dropped, ['N1', 'N4', 'N5']);
});

test('mapNegatives grades a pair only when the group fix is an ancestor of the negative', () => {
  const git = mapGit({ changed: { aaa: ['apps/agentic-os/src/x.ts', 'scripts/settings/a.mjs'] }, ancestor: (fix) => fix === 'f1' });
  const r = mapNegatives([{ id: 'N2', head: 'aaa' }], { groups: GROUP_FLOWS, fixes: { S1: 'f1', S8: 'f8' } }, git);
  assert.deepEqual(r.negatives.N2, ['S1']);
  assert.deepEqual(r.ungraded.N2, ['S8']);
});

test('mapNegatives skips a negative with no path match, and K1 and K2 reach that line', () => {
  const git = mapGit({ changed: { aaa: ['apps/agentic-os/src/x.ts'], kkk: ['README.md'], kk2: [] } });
  const negs = [{ id: 'N2', head: 'aaa' }, { id: 'K1', head: 'kkk', kind: 'skip' }, { id: 'K2', head: 'kk2', kind: 'skip' }];
  const r = mapNegatives(negs, { groups: GROUP_FLOWS, fixes: { S1: 'f1', S8: 'f8' } }, git);
  assert.deepEqual(r.negatives.K1, []);
  assert.equal(r.skipped.K1, 'no_match');
  assert.equal(r.skipped.K2, 'no_match');
  assert.equal(r.skipped.N2, undefined);
  assert.deepEqual(r.problems, []);
});

test('mapNegatives reports a skip-class negative that has a match', () => {
  const git = mapGit({ changed: { kkk: ['apps/agentic-os/src/x.ts'] } });
  const r = mapNegatives([{ id: 'K1', head: 'kkk', kind: 'skip' }], { groups: GROUP_FLOWS, fixes: { S1: 'f1', S8: 'f8' } }, git);
  assert.ok(r.problems.some((p) => /K1/.test(p)));
});

test('mapNegatives throws when git cannot diff the negative', () => {
  const git = gitFrom([[/^diff/, () => ({ status: 128, stdout: '', stderr: 'bad revision' })]]);
  assert.throws(() => mapNegatives([{ id: 'N2', head: 'zzz' }], { groups: GROUP_FLOWS, fixes: { S1: 'f1' } }, git), /N2/);
});

// ---------- freeze ----------

const TREE = 'treehash1111';
// git ls-tree -z <head> -- <path>: a blob line when blobs holds "<head>:<path>", else nothing.
const lsBlob = (args, blobs) => {
  const blob = blobs[`${args[2]}:${args[4]}`];
  return { status: 0, stdout: blob ? `100644 blob ${blob}\t${args[4]}\0` : '', stderr: '' };
};
const FLOWS_DIR = 'scripts/trex/bench/flows';
function freezeSetup(t, over = {}) {
  const root = tmp(t);
  const FD = over.flowsDir ?? FLOWS_DIR;
  const stem = over.stem ?? 'trex-author';
  const files = { [`${FD}/S1/a.yaml`]: over.s1Flow ?? hostYaml('mod-event', '{test: brief-hook}'), [`${FD}/S8/b.yaml`]: flowYaml().replace('gate-blocks-inline-body', 'second-flow-here') };
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    const k = args.join(' ');
    if (k.startsWith('status --porcelain')) return { status: 0, stdout: over.dirty ?? '', stderr: '' };
    if (k.startsWith('rev-parse --verify')) return { status: 0, stdout: 'abc123\n', stderr: '' };
    if (k === `rev-parse abc123:${FD}`) return { status: 0, stdout: `${TREE}\n`, stderr: '' };
    if (k === `rev-parse HEAD:${FD}`) return { status: 0, stdout: `${over.headTree ?? TREE}\n`, stderr: '' };
    if (args[0] === 'ls-tree' && !args.includes('-r')) return lsBlob(args, over.blobs ?? {});
    if (args[0] === 'ls-tree') return { status: 0, stdout: Object.keys(files).filter((f) => f.startsWith(`${args.at(-1)}/`)).join('\0'), stderr: '' };
    if (args[0] === 'show') return { status: 0, stdout: files[args[1].split(':')[1]] ?? '', stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: over.diff ?? 'x.md\n', stderr: '' };
    if (k.startsWith('merge-base --is-ancestor')) return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'hash-object') return over.noHash ? { status: 1, stdout: '', stderr: 'no such file' } : { status: 0, stdout: `blob:${path.basename(args.at(-1))}\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: `unhandled ${k}` };
  };
  const cacheDir = path.join(root, '.claude/cache/e2e');
  for (const g of ['S1', 'S8']) put(cacheDir, `2026-11-02-${stem}-${g}.manifest.json`, JSON.stringify({ group: g, runId: `run-${g}`, model: 'grok-4.7-high', usage: { in: 1 }, retries: 0 }));
  const digest = over.digest ?? hostFlowDigest(git, 'abc123', { flowsDir: FD, groups: ['S1', 'S8'], negativeHeads: over.negativeHeads });
  if (!over.noMarker) put(root, 'scripts/trex/bench/host-review.json', JSON.stringify({ sha256: digest }));
  const opts = { root, flowsDir: FD, groups: ['S1', 'S8'], fixes: { S1: 'f1', S8: 'f8' }, cacheDir, negatives: [{ id: 'N2', head: 'nnn' }], ...over.opts };
  return { root, git, calls, opts, digest };
}

test('hostFlowDigest changes when a host flow changes and ignores container flows', (t) => {
  const s = freezeSetup(t);
  const o = { flowsDir: FLOWS_DIR, groups: ['S1', 'S8'] };
  assert.equal(hostFlowDigest(s.git, 'abc123', o), s.digest);
  assert.match(s.digest, /^[0-9a-f]{64}$/);
  const edit = (re, from, to) => (args) => { const r = s.git(args); return args[0] === 'show' && re.test(args[1]) ? { ...r, stdout: r.stdout.replace(from, to) } : r; };
  assert.notEqual(hostFlowDigest(edit(/a\.yaml/, 'brief-hook', 'other-hook'), 'abc123', o), s.digest);
  assert.equal(hostFlowDigest(edit(/b\.yaml/, 'gate blocks the call', 'renamed check'), 'abc123', o), s.digest);
});

const PS1_FLOW = hostYaml('cli', '{cmd: [pwsh, -NoProfile, -File, scripts/land.ps1]}');
const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);

const PS1 = 'scripts/land.ps1';
const O2 = { flowsDir: FLOWS_DIR, groups: ['S1', 'S8'] };
const NOSET = 'f'.repeat(64); // skips the digest freezeSetup would compute from incomplete blobs
// S1 runs at pre 23b62e5d and fix f0b67364 (spec section 7).
const at = (pre, fix, extra = {}) => ({ [`23b62e5d:${PS1}`]: pre, [`f0b67364:${PS1}`]: fix, ...extra });

test('hostFlowDigest covers the blob id of a host .ps1 at the group pre', (t) => {
  // Breaks when the digest drops the blob at pre.
  const a = freezeSetup(t, { s1Flow: PS1_FLOW, blobs: at(BLOB_A, BLOB_A) });
  const b = freezeSetup(t, { s1Flow: PS1_FLOW, blobs: at(BLOB_B, BLOB_A) });
  assert.notEqual(hostFlowDigest(a.git, 'abc123', O2), hostFlowDigest(b.git, 'abc123', O2));
  assert.equal(hostFlowDigest(a.git, 'abc123', O2), hostFlowDigest(a.git, 'abc123', O2));
});

test('hostFlowDigest covers the blob id of a host .ps1 at the group fix, not only at one sha', (t) => {
  // Breaks when the .ps1 is pinned at one sha: a script that differs between pre and fix then escapes the human review.
  const a = freezeSetup(t, { s1Flow: PS1_FLOW, blobs: at(BLOB_A, BLOB_A) });
  const b = freezeSetup(t, { s1Flow: PS1_FLOW, blobs: at(BLOB_A, BLOB_B) });
  assert.notEqual(hostFlowDigest(a.git, 'abc123', O2), hostFlowDigest(b.git, 'abc123', O2));
});

test('hostFlowDigest throws, naming the sha, when a referenced .ps1 is missing at the pre or at the fix', (t) => {
  // Breaks when a missing script at one run sha is tolerated.
  const onlyPre = freezeSetup(t, { s1Flow: PS1_FLOW, digest: NOSET, blobs: { [`23b62e5d:${PS1}`]: BLOB_A } });
  assert.throws(() => hostFlowDigest(onlyPre.git, 'abc123', O2), /scripts\/land\.ps1.*f0b67364/);
  const onlyFix = freezeSetup(t, { s1Flow: PS1_FLOW, digest: NOSET, blobs: { [`f0b67364:${PS1}`]: BLOB_A } });
  assert.throws(() => hostFlowDigest(onlyFix.git, 'abc123', O2), /scripts\/land\.ps1.*23b62e5d/);
});

test('hostFlowDigest covers a negative head mapped to the group, and throws when the .ps1 is missing there', (t) => {
  // Breaks when negative heads are left out: the runner runs the .ps1 at every graded negative head.
  const negativeHeads = { S1: ['nnn'] };
  const without = freezeSetup(t, { s1Flow: PS1_FLOW, blobs: at(BLOB_A, BLOB_A) });
  assert.throws(() => hostFlowDigest(without.git, 'abc123', { ...O2, negativeHeads }), /nnn/);
  const a = freezeSetup(t, { s1Flow: PS1_FLOW, blobs: at(BLOB_A, BLOB_A, { [`nnn:${PS1}`]: BLOB_A }) });
  const b = freezeSetup(t, { s1Flow: PS1_FLOW, blobs: at(BLOB_A, BLOB_A, { [`nnn:${PS1}`]: BLOB_B }) });
  assert.notEqual(hostFlowDigest(a.git, 'abc123', { ...O2, negativeHeads }), hostFlowDigest(b.git, 'abc123', { ...O2, negativeHeads }));
});

test('hostFlowDigest pins an honest-skip group (S17, no fix) at its pre and skipAt shas', () => {
  // Breaks when a group without a fix is pinned at a null fix sha or at no sha.
  const asked = [];
  const git = (args) => {
    if (args[0] === 'ls-tree' && args.includes('-r')) return { status: 0, stdout: `${FLOWS_DIR}/S17/a.yaml\0`, stderr: '' };
    if (args[0] === 'show') return { status: 0, stdout: PS1_FLOW, stderr: '' };
    asked.push(args[2]);
    return { status: 0, stdout: `100644 blob ${BLOB_A}\t${args[4]}\0`, stderr: '' };
  };
  hostFlowDigest(git, 'abc123', { flowsDir: FLOWS_DIR, groups: ['S17'] });
  assert.deepEqual(asked.sort(), ['6f36d24f', '73040918']);
});

test('freeze covers the graded negative heads: a head without the .ps1 refuses the freeze', (t) => {
  // Breaks when freeze computes the digest before the negatives are mapped.
  const diff = 'scripts/github/pre-pr.mjs\n';
  const opts = { negatives: [{ id: 'N2', head: 'nnn' }] };
  const bad = freezeSetup(t, { s1Flow: PS1_FLOW, diff, digest: NOSET, blobs: at(BLOB_A, BLOB_A), opts });
  assert.throws(() => freeze('abc123', bad.opts, { git: bad.git }), /nnn/);
  const blobs = at(BLOB_A, BLOB_A, { [`nnn:${PS1}`]: BLOB_B });
  const good = freezeSetup(t, { s1Flow: PS1_FLOW, diff, blobs, opts, negativeHeads: { S1: ['nnn'] } });
  assert.ok(freeze('abc123', good.opts, { git: good.git }).negatives.N2.includes('S1'));
});

const MARKER_ERR = 'host-flow review marker missing or stale; ask Dave to review with --host-digest';

test('freeze names neither the digest nor the marker JSON when the marker is missing or stale', (t) => {
  for (const over of [{ noMarker: true }, { digest: 'f'.repeat(64) }]) {
    const s = freezeSetup(t, over);
    assert.throws(() => freeze('abc123', s.opts, { git: s.git }), (e) => e.message === MARKER_ERR, JSON.stringify(Object.keys(over)));
  }
});

test('freeze refuses a dirty flows dir', (t) => {
  const s = freezeSetup(t, { dirty: '?? scripts/trex/bench/flows/S1/x.yaml\n' });
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /dirty/i);
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/frozen.json')));
});

test('freeze refuses without a host review marker', (t) => {
  const s = freezeSetup(t, { noMarker: true });
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /review/i);
});

test('freeze refuses a marker for a different host-flow diff', (t) => {
  const s = freezeSetup(t, { digest: 'f'.repeat(64) });
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /review/i);
});

test('freeze refuses a sha whose flows tree differs from HEAD', (t) => {
  const s = freezeSetup(t, { headTree: 'othertree' });
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /HEAD/);
});

test('freeze refuses when a group has no author manifest', (t) => {
  const s = freezeSetup(t, { opts: { groups: ['S1', 'S8', 'S9'], fixes: { S1: 'f1', S8: 'f8', S9: 'f9' } } });
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /S9/);
});

test('freeze labels the bench audited only when every group manifest is audited', (t) => {
  const s = freezeSetup(t);
  const manifest = (g, blind) => put(s.opts.cacheDir, `2026-11-02-trex-author-${g}.manifest.json`, JSON.stringify({ group: g, runId: `run-${g}`, model: 'grok-4.7-high', retries: 0, blind }));
  manifest('S1', 'audited (stream-json reads in tree)');
  assert.match(freeze('abc123', s.opts, { git: s.git }).blind, /best-effort/, 'S8 is not audited');
  manifest('S8', 'audited (stream-json reads in tree)');
  const r = freeze('abc123', s.opts, { git: s.git });
  assert.equal(r.blind, 'audited (stream-json reads in tree)');
  assert.equal(r.groups.S1.blind, 'audited (stream-json reads in tree)');
});

test('freeze writes frozen.json and never commits', (t) => {
  const s = freezeSetup(t);
  const r = freeze('abc123', s.opts, { git: s.git });
  const file = JSON.parse(readFileSync(path.join(s.root, 'scripts/trex/bench/frozen.json'), 'utf8'));
  assert.equal(file.sha, 'abc123');
  assert.equal(file.flowsTree, TREE);
  assert.deepEqual(Object.keys(file.groups), ['S1', 'S8']);
  assert.equal(file.groups.S1.runId, 'run-S1');
  assert.equal(file.groups.S1.model, 'grok-4.7-high');
  assert.ok('N2' in file.negatives);
  assert.match(file.blind, /best-effort \(no read audit\)/);
  assert.equal(r.flowsTree, TREE);
  assert.ok(!s.calls.some((c) => /^(commit|add|push|stash|reset|checkout)\b/.test(c)), s.calls.join('\n'));
});

// ---------- authorGroup ----------

const NOW = Date.parse('2026-11-02T18:00:00Z');
const resultLine = (text, extra = {}) => `${JSON.stringify({ type: 'init' })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { inputTokens: 10, outputTokens: 5 }, session_id: 'sess-1', ...extra })}\n`;
const GOOD = answer([['gate.yaml', flowYaml()], ['fixtures/payload.json', '{}']], MANIFEST);
// A real cut of the raw probe stream (the first 10 tool call starts). {TREE} stands for the review tree path.
const FIXTURE = readFileSync(new URL('./fixtures/probe-stream.jsonl', import.meta.url), 'utf8');
const treeIn = (dir) => FIXTURE.split('{TREE}').join(JSON.stringify(dir).slice(1, -1));
const asLine = (o) => `${JSON.stringify(o)}\n`;
/** The fixture with the tree path set to dir, then a synthetic final assistant event and a synthetic result event. */
const streamFor = (dir, { answer: text = GOOD, extra = [] } = {}) => treeIn(dir) + extra.map(asLine).join('')
  + asLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  + asLine({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { inputTokens: 10, outputTokens: 5 }, session_id: 'sess-1' });
const streamRun = (o = {}) => (spec) => ({ status: 0, stdout: streamFor(spec.cwd, o), stderr: '', timedOut: false, durationMs: 5 });

function authorSetup(t, over = {}) {
  const root = tmp(t);
  const ledger = path.join(root, 'ledger.jsonl');
  if (over.ledger) writeFileSync(ledger, over.ledger);
  const state = { prepared: 0, cleaned: 0, runs: [], atRun: null };
  const treeFiles = over.treeFiles ?? { 'scripts/checks/proofs.json': '{"rows":[]}', 'scripts/github/pre-pr.mjs': 'export {};' };
  const prepare = async ({ input }) => {
    state.prepared += 1;
    const dir = mkdtempSync(path.join(root, 'tree-'));
    for (const [rel, text] of Object.entries(treeFiles)) put(dir, rel, text);
    return { ref: `range-${input.range}`, base: 'b', head: 'h', dir, files: over.files ?? CHANGED, cleanup: () => { state.cleaned += 1; } };
  };
  const runner = async (spec) => {
    state.runs.push(spec);
    state.atRun = existsSync(path.join(spec.cwd, 'scripts/checks/proofs.json'));
    return over.run ? over.run(spec) : { status: 0, stdout: resultLine(GOOD), stderr: '', timedOut: false, durationMs: 5 };
  };
  const git = gitFrom([[/^log -1 --format=%s/, () => ({ status: 0, stdout: 'fix: something unrelated to any file\n' })]]);
  const deps = { prepare, runner, agent: { cmd: 'cursor-agent', prefixArgs: [] }, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CODE_SESSION_ID: 's1' }, now: () => NOW, git, platform: 'linux', ...over.deps };
  const opts = { root, ledgerPath: ledger, ...over.opts };
  return { root, ledger, state, deps, opts };
}
const ledgerLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const startLines = (n, ref = 'trex-S1') => Array.from({ length: n }, (_, i) => JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', phase: 'start', id: `id-${ref}-${i}`, ref, model: 'grok-4.7-high' })).join('\n');
const cacheFiles = (root) => readdirSync(path.join(root, '.claude/cache/e2e'));

test('authorGroup deletes scripts/checks/proofs.json before the agent starts', async (t) => {
  const s = authorSetup(t);
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.equal(s.state.runs.length, 1);
  assert.equal(s.state.atRun, false);
});

test('authorGroup removes the proofs.json section from PR.diff', async (t) => {
  const diff = 'diff --git a/scripts/checks/proofs.json b/scripts/checks/proofs.json\n+answers\ndiff --git a/scripts/github/pre-pr.mjs b/scripts/github/pre-pr.mjs\n+code\n';
  const s = authorSetup(t, { treeFiles: { 'PR.diff': diff } });
  const seen = { diff: null };
  s.deps.runner = async (spec) => { seen.diff = readFileSync(path.join(spec.cwd, 'PR.diff'), 'utf8'); return { status: 0, stdout: resultLine(GOOD), stderr: '', timedOut: false }; };
  await authorGroup('S18', s.opts, s.deps);
  assert.ok(!seen.diff.includes('answers'));
  assert.ok(seen.diff.includes('+code'));
});

test('authorGroup passes --mode ask, the model, the stripped env, and writes the flows and the cache files', async (t) => {
  const s = authorSetup(t, { run: streamRun() });
  const r = await authorGroup('S18', s.opts, s.deps);
  const spec = s.state.runs[0];
  const args = spec.args;
  assert.equal(args[args.indexOf('--mode') + 1], 'ask');
  assert.equal(args[args.indexOf('--model') + 1], 'grok-4.7-high');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spec.env.CLAUDE_CODE_SESSION_ID, undefined);
  const folder = path.join(s.root, 'scripts/trex/bench/flows/S18');
  assert.ok(existsSync(path.join(folder, 'gate.yaml')) && existsSync(path.join(folder, 'fixtures/payload.json')));
  const cache = cacheFiles(s.root);
  assert.ok(cache.some((f) => /-trex-author-S18\.raw\.json$/.test(f)));
  const mf = cache.find((f) => /-trex-author-S18\.manifest\.json$/.test(f));
  const manifest = JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', mf), 'utf8'));
  assert.equal(manifest.runId, r.runId);
  assert.equal(manifest.model, 'grok-4.7-high');
  assert.equal(manifest.blind, 'audited (stream-json reads in tree)');
  assert.equal(manifest.outputFormat, 'stream-json');
  assert.equal(manifest.toolCalls, 10);
  assert.deepEqual(manifest.outsideTree, []);
  assert.ok(manifest.reads.length > 0);
  assert.equal(manifest.retries, 0);
  assert.deepEqual(ledgerLines(s.ledger).map((l) => [l.phase, l.ref]), [['start', 'trex-S18'], ['end', 'trex-S18']]);
  assert.equal(s.state.cleaned, 1);
});

test('authorGroup refuses at BENCH_CAP bench runs, counted by ref prefix and run id, before it prepares a tree', async (t) => {
  const end = JSON.stringify({ ts: '2026-11-01T00:00:01.000Z', phase: 'end', id: 'id-trex-S1-0', ref: 'trex-S1' });
  const s = authorSetup(t, { ledger: `${startLines(BENCH_CAP - 1, 'trex-S1')}\n${startLines(1, 'trex-probe')}\n${end}\n` });
  assert.equal(benchRuns(s.ledger).used, BENCH_CAP);
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 3);
  assert.equal(s.state.prepared, 0);
  assert.equal(s.state.runs.length, 0);
});

test('authorGroup does not count non-bench runs toward the 18', async (t) => {
  const s = authorSetup(t, { ledger: startLines(20, 'pr-12') });
  assert.equal(benchRuns(s.ledger).used, 0);
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
});

test('authorGroup respects the weekly cap of 300', async (t) => {
  const s = authorSetup(t, { ledger: startLines(300, 'pr-1') });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 3);
  assert.equal(s.state.runs.length, 0);
});

test('authorGroup refuses a prompt over 24000 chars and writes no ledger line', async (t) => {
  const s = authorSetup(t, { deps: { template: `${'x'.repeat(24_100)} {ref} {group} {files} {schema}` } });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join(' '), /24000/);
  assert.deepEqual(ledgerLines(s.ledger), []);
  assert.equal(s.state.runs.length, 0);
  assert.equal(s.state.cleaned, 1);
});

test('authorGroup stops before the agent when the tree leaks a fix sha', async (t) => {
  const s = authorSetup(t, { treeFiles: { 'docs/x.md': `fixed in ${GROUPS.S18.fix.slice(0, 8)}` } });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join(' '), /docs\/x\.md/);
  assert.equal(s.state.runs.length, 0);
  assert.deepEqual(ledgerLines(s.ledger), []);
});

test('authorGroup blocks only on the own group shas and records other-group hits', async (t) => {
  const s = authorSetup(t, { treeFiles: { 'docs/x.md': `an older fix was ${GROUPS.S8.fix}`, 'scripts/github/pre-pr.mjs': 'export {};' } });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  const mf = cacheFiles(s.root).find((f) => f.endsWith('S18.manifest.json'));
  const rec = JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', mf), 'utf8'));
  assert.equal(rec.crossGroupHits.length, 1);
  assert.match(rec.crossGroupHits[0], /docs\/x\.md/);
});

test('authorGroup refuses an unknown group and a model outside the allow list', async (t) => {
  const s = authorSetup(t);
  assert.equal((await authorGroup('S99', s.opts, s.deps)).exit, 2);
  assert.equal((await authorGroup('S18', { ...s.opts, model: 'auto' }, s.deps)).exit, 2);
  assert.equal(s.state.runs.length, 0);
});

test('authorGroup returns exit 1 and writes no flows after a timeout', async (t) => {
  const s = authorSetup(t, { run: () => ({ status: null, stdout: '', stderr: '', timedOut: true, durationMs: 9 }) });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 1);
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18')));
  const end = ledgerLines(s.ledger).find((l) => l.phase === 'end');
  assert.equal(end.exit, 1);
  assert.equal(end.timedOut, true);
});

test('authorGroup returns exit 1 and writes no flows when lint fails', async (t) => {
  const bad = answer([['gate.yaml', flowYaml().replace('[scripts/github/pre-pr.mjs]', '[docs/**]')], ['fixtures/payload.json', '{}']], MANIFEST);
  const s = authorSetup(t, { run: () => ({ status: 0, stdout: resultLine(bad), stderr: '', timedOut: false }) });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 1);
  assert.ok(r.problems.some((p) => /gate\.yaml/.test(p) && /changed file/.test(p)));
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18')));
  assert.ok(cacheFiles(s.root).some((f) => /S18\.raw\.json$/.test(f)));
});

test('authorGroup voids an answer that says the agent could not read the change', async (t) => {
  const text = ['I could not read the files.', '```json', '{"flows":[],"cannotVerify":[]}', '```'].join('\n');
  const s = authorSetup(t, { run: () => ({ status: 0, stdout: resultLine(text), stderr: '', timedOut: false }), deps: { notRun: (x) => /could not read/.test(x) } });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 1);
  assert.ok(r.problems.some((p) => /void/.test(p)));
});

test('authorGroup returns exit 1 for an agent error result', async (t) => {
  const s = authorSetup(t, { run: () => ({ status: 0, stdout: resultLine('boom', { is_error: true, subtype: 'error' }), stderr: '', timedOut: false }) });
  assert.equal((await authorGroup('S18', s.opts, s.deps)).exit, 1);
});

test('authorGroup allows GROUP_CAP - 1 retries per group, and only after a failed run', async (t) => {
  const s = authorSetup(t, { run: () => ({ status: null, stdout: '', stderr: '', timedOut: true }) });
  assert.equal((await authorGroup('S18', s.opts, s.deps)).exit, 1);
  assert.equal((await authorGroup('S18', s.opts, s.deps)).exit, 2, 'a second run without a retry flag');
  assert.equal((await authorGroup('S18', { ...s.opts, retry: true }, s.deps)).exit, 1);
  for (let i = 2; i < GROUP_CAP; i++) assert.equal((await authorGroup('S18', { ...s.opts, retry: true }, s.deps)).exit, 1);
  assert.equal((await authorGroup('S18', { ...s.opts, retry: true }, s.deps)).exit, 3, 'a run past GROUP_CAP is over the retry limit');
  assert.equal(s.state.runs.length, GROUP_CAP);
});

test('authorGroup refuses a retry of a run that succeeded, unless the harness failed', async (t) => {
  const s = authorSetup(t);
  assert.equal((await authorGroup('S18', s.opts, s.deps)).exit, 0);
  assert.equal((await authorGroup('S18', { ...s.opts, retry: true }, s.deps)).exit, 2);
  assert.equal((await authorGroup('S18', { ...s.opts, retry: 'harness' }, s.deps)).exit, 0);
  const mf = cacheFiles(s.root).find((f) => f.endsWith('S18-r1.manifest.json'));
  assert.equal(JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', mf), 'utf8')).retries, 1);
  assert.ok(cacheFiles(s.root).some((f) => f.endsWith('S18.manifest.json')), 'the first manifest is kept');
});

test('authorGroup probe uses stream-json, counts against the cap, records tool calls and writes no flows', async (t) => {
  const read = (p) => ({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: p } } } });
  const stream = [
    { type: 'system', subtype: 'init' },
    read('scripts/github/pre-pr.mjs'),
    read('C:/Users/dkhay/continuous-claude/.claudedocs/x.md'),
    { type: 'result', subtype: 'success', is_error: false, result: GOOD, usage: { inputTokens: 1 } },
  ].map((o) => JSON.stringify(o)).join('\n');
  const s = authorSetup(t, { run: () => ({ status: 0, stdout: stream, stderr: '', timedOut: false }) });
  const r = await authorGroup('S18', { ...s.opts, probe: true }, s.deps);
  const args = s.state.runs[0].args;
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--mode') + 1], 'ask');
  assert.equal(r.exit, 1, 'a read outside the tree fails the probe too');
  assert.equal(ledgerLines(s.ledger)[0].ref, 'trex-probe');
  assert.equal(benchRuns(s.ledger).used, 1);
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18')));
  const f = cacheFiles(s.root).find((n) => /trex-author-probe\.json$/.test(n));
  const probe = JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', f), 'utf8'));
  assert.equal(probe.toolCalls, 2);
  assert.equal(probe.toolCallsVisible, true);
  assert.equal(probe.outsideTree.length, 1);
  assert.match(probe.outsideTree[0], /\.claudedocs/);
  assert.equal(probe.blind, 'violated');
});

test('authorGroup probe reports when stream-json shows no tool calls', async (t) => {
  const stream = [{ type: 'system' }, { type: 'result', subtype: 'success', is_error: false, result: GOOD }].map((o) => JSON.stringify(o)).join('\n');
  const s = authorSetup(t, { run: () => ({ status: 0, stdout: stream, stderr: '', timedOut: false }) });
  await authorGroup('S18', { ...s.opts, probe: true }, s.deps);
  const f = cacheFiles(s.root).find((n) => /trex-author-probe\.json$/.test(n));
  assert.equal(JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', f), 'utf8')).toolCallsVisible, false);
});

test('the rendered prompt holds no bench sha', async (t) => {
  const s = authorSetup(t);
  await authorGroup('S18', s.opts, s.deps);
  const prompt = s.state.runs[0].args.at(-1);
  for (const g of Object.values(GROUPS)) {
    for (const sha of [g.fix, g.pre]) if (sha) assert.ok(!prompt.includes(sha.slice(0, 8)), `prompt names ${sha}`);
  }
  assert.ok(prompt.includes('scripts/github/pre-pr.mjs'));
  assert.ok(prompt.includes('scripts/trex/bench/flows/S18'));
  assert.ok(prompt.length <= 24_000);
});

test('the group table matches the spec', () => {
  assert.equal(Object.keys(GROUPS).length, 16);
  assert.equal(GROUPS.S18.range, '6bc94082^1..6bc94082');
  assert.equal(GROUPS.S1.range, 'beb9d5ef..23b62e5d');
});

test('every group author range holds at least one commit (real git)', () => {
  // Breaks when a range is written the wrong way round: git rev-list then counts 0 and Grok gets an empty PR.diff (S15, 2026-11-03).
  const git = benchGit(fileURLToPath(new URL('../../..', import.meta.url)));
  for (const [id, g] of Object.entries(GROUPS)) {
    const r = git(['rev-list', '--count', g.range]);
    assert.equal(r.status, 0, `${id} ${g.range}: ${r.stderr}`);
    assert.ok(Number(r.stdout.trim()) > 0, `${id} range ${g.range} is empty`);
  }
});

// ---------- P0 scope: prompt and lint share one list ----------

const TEMPLATE = readFileSync(fileURLToPath(new URL('./author-prompt.md', import.meta.url)), 'utf8');
const ruleList = (label) => {
  const m = new RegExp(`^- ${label}: (.+)\\.$`, 'm').exec(TEMPLATE);
  assert.ok(m, `the prompt has no "- ${label}:" line`);
  return m[1].split(',').map((x) => x.trim()).sort();
};
const NOT_P0 = /\b(?:api|browser|playwright|status)\b|\bbody:|!body/;

test('the prompt names exactly the P0 drivers and checks, and nothing else about the P1 ones', () => {
  assert.deepEqual(ruleList('Drivers'), [...P0_DRIVERS].sort());
  assert.deepEqual(ruleList('Checks'), [...P0_CHECKS].sort());
  const beforeOutput = TEMPLATE.split('## Output format')[0];
  assert.doesNotMatch(beforeOutput, NOT_P0);
});

test('the prompt asks for 1 or 2 flows, short helper scripts and a time budget', () => {
  assert.match(TEMPLATE, /Write 1 or 2 flows/);
  assert.doesNotMatch(TEMPLATE, /1 to 3 flows/);
  assert.match(TEMPLATE, /under 60 lines/);
  assert.match(TEMPLATE, /You have about 20 minutes\. When you have one good flow, write the answer\./);
  assert.match(TEMPLATE, /simplest flow/i);
});

test('the rendered prompt of a host group does not offer an api or browser driver either', async (t) => {
  const s = authorSetup(t, { run: streamRun() });
  await authorGroup('S15', s.opts, s.deps);
  assert.doesNotMatch(s.state.runs[0].args.at(-1).split('## Output format')[0], NOT_P0);
});

test('lintFlow rejects the api and browser drivers as not runnable in P0', () => {
  const api = flowYaml().replace('driver: hook', 'driver: api').replace(/action: \{hook.*\}/, 'action: {method: GET, path: /health}');
  assert.ok(lintFlow(api, CHANGED).some((m) => /not runnable in P0/.test(m) && /api/.test(m)), lintFlow(api, CHANGED).join('|'));
  const browser = flowYaml().replace('driver: hook', 'driver: browser').replace(/action: \{hook.*\}/, 'action: {playwright: e2e/a.spec.ts, config: pw.config.ts, projects: [chromium]}');
  assert.ok(lintFlow(browser, CHANGED).some((m) => /not runnable in P0/.test(m) && /browser/.test(m)), lintFlow(browser, CHANGED).join('|'));
});

test('lintFlow rejects the status, body, !body and playwright checks as not runnable in P0', () => {
  for (const check of ['status: 200', 'body: ok', '"!body": bad', 'playwright: passed']) {
    const yaml = flowYaml().replace('stdout: "BLOCKED"', check);
    assert.ok(lintFlow(yaml, CHANGED).some((m) => /not runnable in P0/.test(m)), `${check} passed the lint: ${lintFlow(yaml, CHANGED).join('|')}`);
  }
});

test('lintFlow accepts every P0 check on a cli flow', () => {
  const checks = ['exit: 0', 'stdout: ok', '"!stdout": bad', 'json: {file: out.json, path: a.b, equals: 1}', 'file: out.txt, "~": ok'];
  const yaml = flowYaml().replace('driver: hook', 'driver: cli').replace(/action: \{hook.*\}/, 'action: {cmd: [node, x.mjs]}').replace('stdout: "BLOCKED"}', 'exit: 0}');
  assert.deepEqual(lintFlow(yaml, CHANGED), []);
  for (const c of checks) {
    const one = yaml.replace('exit: 0}', `${c}}`);
    assert.ok(!lintFlow(one, CHANGED).some((m) => /not runnable in P0/.test(m)), `${c}: ${lintFlow(one, CHANGED).join('|')}`);
  }
});

// ---------- stream-json for every group run ----------

test('analyzeStream reads the real probe fixture: tool calls visible, reads inside the tree', () => {
  const dir = path.join(os.tmpdir(), 'trex-fixture-tree');
  const a = analyzeStream(treeIn(dir), dir);
  assert.equal(a.toolCalls, 10);
  assert.equal(a.toolCallsVisible, true);
  assert.ok(a.reads.length >= 5);
  assert.deepEqual(a.outsideTree, []);
  assert.ok(a.eventTypes.includes('thinking') && a.eventTypes.includes('assistant'));
  assert.equal(analyzeStream(treeIn(dir), path.join(os.tmpdir(), 'another-tree')).outsideTree.length, a.reads.length, 'a different tree makes every read outside');
});

test('authorGroup takes the answer from the result event of a stream, not from an earlier assistant event', async (t) => {
  const s = authorSetup(t, { run: streamRun() });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.deepEqual(r.manifest.flows.map((f) => f.id), ['gate-blocks-inline-body']);
  assert.ok(existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18/gate.yaml')));
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
});

test('authorGroup fails the run and writes no flows when the stream shows a read outside the tree', async (t) => {
  const outside = { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'C:/Users/someone/continuous-claude/.claudedocs/answers.md' } } } };
  const s = authorSetup(t, { run: streamRun({ extra: [outside] }) });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 1);
  assert.match(r.problems.join(' '), /outside the tree/);
  assert.match(r.problems.join(' '), /answers\.md/);
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18')), 'no flow of a violated run is used');
  const mf = JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', cacheFiles(s.root).find((f) => f.endsWith('S18.manifest.json'))), 'utf8'));
  assert.equal(mf.blind, 'violated');
  assert.equal(mf.status, 'failed');
  assert.equal(mf.outsideTree.length, 1);
  assert.equal(ledgerLines(s.ledger).find((l) => l.phase === 'end').exit, 1);
});

test('authorGroup keeps the best-effort label when the stream shows no tool calls', async (t) => {
  const s = authorSetup(t);
  assert.equal((await authorGroup('S18', s.opts, s.deps)).exit, 0);
  const mf = JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', cacheFiles(s.root).find((f) => f.endsWith('S18.manifest.json'))), 'utf8'));
  assert.match(mf.blind, /best-effort \(no read audit\)/);
  assert.equal(mf.toolCallsVisible, false);
});

// ---------- timeout and budget ----------

test('the bench timeout is 2400 s unless --timeout-sec is given', async (t) => {
  assert.equal(BENCH_TIMEOUT_SEC, 2400);
  const s = authorSetup(t, { run: streamRun() });
  await authorGroup('S18', s.opts, s.deps);
  assert.equal(s.state.runs[0].timeoutMs, 2_400_000);
  const s2 = authorSetup(t, { run: streamRun(), opts: { timeoutMs: 90_000 } });
  await authorGroup('S18', s2.opts, s2.deps);
  assert.equal(s2.state.runs[0].timeoutMs, 90_000);
  assert.equal(parseArgs(['--group', 'S1', '--timeout-sec', '90']).timeoutMs, 90_000);
});

test('the probe run counts toward the 18 and leaves S1 its first group run', async (t) => {
  const s = authorSetup(t, { ledger: `${startLines(1, 'trex-probe')}\n`, run: streamRun() });
  assert.equal(benchRuns(s.ledger).used, 1);
  const dry = await cli(s, ['--group', 'S1', '--dry-run']);
  assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, new RegExp(`bench runs: 1 of ${BENCH_CAP}`));
  const r = await authorGroup('S1', s.opts, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.deepEqual(benchRuns(s.ledger).byRef, { 'trex-probe': 1, 'trex-S1': 1 });
});

// ---------- host .ps1 at every sha the group's flows run at ----------

const HOST_ANSWER = answer([['host.yaml', hostYaml('cli', '{cmd: [pwsh, -NoProfile, -File, scripts/land.ps1]}')]], { flows: [{ id: 'host-flow-one', file: 'host.yaml', risk: 'r' }], cannotVerify: [] });
// S15 runs at pre 73040918 and fix 6f36d24f (spec section 7). `shas` lists where the .ps1 exists. The range end is 'h' in these tests.
const headGit = (shas) => gitFrom([
  [/^log -1 --format=%s/, () => ({ status: 0, stdout: 'fix: something unrelated to any file\n' })],
  [/^ls-tree -z (\S+) -- (.+)$/, (m) => ({ status: 0, stdout: shas.includes(m[1]) ? `100644 blob ${BLOB_A}\t${m[2]}\0` : '' })],
]);

test('authorGroup accepts a host .ps1 that exists at the group pre and fix and refuses one that is missing at either', async (t) => {
  // Breaks when the lint checks only the range end: the runner runs the .ps1 at pre and at fix, not at the range end.
  const run = () => ({ status: 0, stdout: resultLine(HOST_ANSWER), stderr: '', timedOut: false });
  const yes = authorSetup(t, { run, deps: { git: headGit(['73040918', '6f36d24f']) } });
  const ok = await authorGroup('S15', yes.opts, yes.deps);
  assert.equal(ok.exit, 0, ok.problems.join('; '));
  for (const shas of [['73040918'], ['6f36d24f'], ['h'], []]) {
    const no = authorSetup(t, { run, deps: { git: headGit(shas) } });
    const refused = await authorGroup('S15', no.opts, no.deps);
    assert.equal(refused.exit, 1, shas.join());
    assert.ok(refused.problems.some((p) => /scripts\/land\.ps1/.test(p) && /does not exist/.test(p)));
    assert.ok(!existsSync(path.join(no.root, 'scripts/trex/bench/flows/S15')));
  }
});

// ---------- budget race ----------

test('two concurrent authorGroup calls at BENCH_CAP - 1 bench runs: exactly one reserves', async (t) => {
  const s = authorSetup(t, { ledger: `${startLines(BENCH_CAP - 1, 'trex-S1')}\n` });
  const [a, b] = await Promise.all([authorGroup('S18', s.opts, s.deps), authorGroup('S2', s.opts, s.deps)]);
  assert.deepEqual([a.exit, b.exit].sort(), [0, 3], `${a.problems.join(';')} | ${b.problems.join(';')}`);
  assert.equal(s.state.runs.length, 1);
  assert.equal(benchRuns(s.ledger).used, BENCH_CAP);
  assert.ok(!existsSync(`${s.ledger}.trex-bench.lock`), 'the bench lock is released');
});

test('two concurrent authorGroup calls for one group: exactly one reserves (2-per-group rule)', async (t) => {
  const s = authorSetup(t);
  const [a, b] = await Promise.all([authorGroup('S18', s.opts, s.deps), authorGroup('S18', s.opts, s.deps)]);
  assert.deepEqual([a.exit, b.exit].sort(), [0, 2]);
  assert.equal(s.state.runs.length, 1);
  assert.equal(ledgerLines(s.ledger).filter((l) => l.phase === 'start').length, 1);
});

test('authorGroup fails without a ledger line when another session holds the bench lock', async (t) => {
  const s = authorSetup(t);
  writeFileSync(`${s.ledger}.trex-bench.lock`, `${process.pid} held-by-test`);
  const r = await authorGroup('S18', { ...s.opts, lockWaitMs: 50 }, s.deps);
  assert.equal(r.exit, 1);
  assert.match(r.problems.join(' '), /lock/);
  assert.equal(s.state.runs.length, 0);
  assert.deepEqual(ledgerLines(s.ledger), []);
});

// ---------- CLI ----------

const cli = (s, argv) => {
  const out = [];
  const io = { stdout: (l) => out.push(l), stderr: (l) => out.push(l) };
  return main(argv, { ...s.deps, root: s.root, ledgerPath: s.ledger, ...io }).then((code) => ({ code, text: out.join('\n') }));
};

test('main --dry-run prints prompt size, tree path, leak scan and budget, and starts nothing', async (t) => {
  const s = authorSetup(t, { ledger: startLines(3, 'trex-S1') });
  const { code, text } = await cli(s, ['--group', 'S18', '--dry-run']);
  assert.equal(code, 0, text);
  assert.match(text, /prompt: \d+ chars/);
  assert.match(text, /tree: /);
  assert.match(text, /leak scan: clean/);
  assert.match(text, new RegExp(`bench runs: 3 of ${BENCH_CAP}`));
  assert.equal(s.state.runs.length, 0);
  assert.equal(ledgerLines(s.ledger).length, 3);
  assert.equal(s.state.cleaned, 1);
});

test('main --dry-run exits 2 and lists the hit when the tree leaks', async (t) => {
  const s = authorSetup(t, { treeFiles: { 'docs/x.md': `fixed in ${GROUPS.S18.fix.slice(0, 8)}` } });
  const { code, text } = await cli(s, ['--group', 'S18', '--dry-run']);
  assert.equal(code, 2);
  assert.match(text, /docs\/x\.md/);
});

test('main refuses a command line with no action or an unknown flag', async (t) => {
  const s = authorSetup(t);
  assert.equal((await cli(s, [])).code, 2);
  assert.equal((await cli(s, ['--group', 'S18', '--bogus'])).code, 2);
});

test('main refuses the --ledger flag and writes nothing to that path', async (t) => {
  const s = authorSetup(t);
  const other = path.join(s.root, 'other-ledger.jsonl');
  const r = await cli(s, ['--group', 'S18', '--dry-run', '--ledger', other]);
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /--ledger/);
  assert.equal(s.state.prepared, 0, 'nothing ran');
  assert.ok(!existsSync(other));
});

test('main refuses a live run when CURSOR_REVIEW_LEDGER is set, and runs a dry run', async (t) => {
  // Breaks when the env var is allowed to redirect the ledger and both caps of a live run.
  const env = { PATH: '/bin', CURSOR_REVIEW_LEDGER: 'C:/elsewhere/ledger.jsonl' };
  const s = authorSetup(t, { deps: { env } });
  for (const argv of [['--group', 'S18'], ['--all'], ['--probe']]) {
    const r = await cli(s, argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.text, /CURSOR_REVIEW_LEDGER/);
    assert.equal(r.text.trim().split('\n').length, 1, 'one line');
  }
  assert.equal(s.state.prepared, 0, 'nothing ran');
  assert.equal(s.state.runs.length, 0);
  assert.equal(ledgerLines(s.ledger).length, 0);
  assert.equal((await cli(s, ['--group', 'S18', '--dry-run'])).code, 0);
});

test('benchGit does not pass ANTHROPIC_API_KEY to the git child', () => {
  // Breaks when author.mjs goes back to the pre-pr makeGit, which passes the whole env to git hooks and aliases.
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret-xyz';
  try {
    const r = benchGit(process.cwd())(['-c', 'alias.showkey=!echo key=$ANTHROPIC_API_KEY', 'showkey']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('key='));
    assert.ok(!r.stdout.includes('sk-test-secret-xyz'));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('main --host-digest covers the graded negative heads from the negatives file', async (t) => {
  // Breaks when --host-digest ignores the negatives: it would print a digest that freeze later rejects.
  const run = async (blobs) => {
    const s = freezeSetup(t, { s1Flow: PS1_FLOW, diff: 'scripts/github/pre-pr.mjs\n', blobs, digest: NOSET });
    const file = put(s.root, 'negs.json', JSON.stringify([{ id: 'N2', head: 'nnn' }]));
    return cli({ deps: { git: s.git }, root: s.root, ledger: path.join(s.root, 'l.jsonl') }, ['--host-digest', '--sha', 'abc123', '--negatives', file]);
  };
  const a = await run(at(BLOB_A, BLOB_A, { [`nnn:${PS1}`]: BLOB_A }));
  const b = await run(at(BLOB_A, BLOB_A, { [`nnn:${PS1}`]: BLOB_B }));
  assert.equal(a.code, 0, a.text);
  assert.match(a.text, /^[0-9a-f]{64}$/);
  assert.notEqual(a.text, b.text);
});

// ---------- blobAt against real git ----------

test('blobAt reads the blob id of a file at a commit with real git, and null for a folder or a missing path', (t) => {
  const dir = tmp(t);
  const git = makeTrexGit(dir);
  const run = (...args) => assert.equal(git(args).status, 0, args.join(' '));
  run('init', '-q');
  put(dir, 'scripts/land.ps1', 'Write-Output hi\n');
  run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  const expected = git(['hash-object', 'scripts/land.ps1']).stdout.trim();
  assert.equal(blobAt(git, 'HEAD', 'scripts/land.ps1'), expected);
  assert.equal(blobAt(git, 'HEAD', 'scripts'), null);
  assert.equal(blobAt(git, 'HEAD', 'scripts/gone.ps1'), null);
  assert.equal(blobAt(git, 'nosuchrev', 'scripts/land.ps1'), null);
});

// ---------- --reparse ----------

const RAW_DAY = '2026-11-03';
const CHANGED_Z = `${CHANGED.join('\0')}\0`;
/** Git for a reparse: the merge base and the changed-file list of the group range. */
const reparseGit = () => gitFrom([
  [/^merge-base /, () => ({ status: 0, stdout: 'mergebase\n' })],
  [/^diff --name-only --no-renames -z mergebase /, () => ({ status: 0, stdout: CHANGED_Z })],
]);

/** A saved stream-json raw file in the e2e cache of a temp root, plus the manifest the live run wrote next to it. */
function reparseSetup(t, { group = 'S18', answer = GOOD, extra = [], manifest = { group, runId: 'run-orig-1', model: 'grok-4.7-high', status: 'failed' } } = {}) {
  const s = authorSetup(t, { deps: { git: reparseGit() } });
  const treeDir = path.join(s.root, 'old-tree');
  const raw = put(s.root, `.claude/cache/e2e/${RAW_DAY}-trex-author-${group}.raw.json`, streamFor(treeDir, { answer, extra }));
  if (manifest) put(s.root, `.claude/cache/e2e/${RAW_DAY}-trex-author-${group}.manifest.json`, JSON.stringify(manifest));
  s.deps.runner = async () => { throw new Error('reparse must not start an agent'); };
  return { ...s, raw, group, folder: path.join(s.root, 'scripts/trex/bench/flows', group) };
}
const reparseManifest = (s) => JSON.parse(readFileSync(path.join(path.dirname(s.raw), `${RAW_DAY}-trex-author-${s.group}-reparse.manifest.json`), 'utf8'));

test('--reparse writes the flows and a reparse manifest, with no agent call and no ledger line', async (t) => {
  // Breaks when reparse reserves a ledger run (the 18-run cap is spent) or calls the agent.
  const s = reparseSetup(t);
  const r = await cli(s, ['--reparse', s.raw, '--group', s.group]);
  assert.equal(r.code, 0, r.text);
  assert.ok(existsSync(path.join(s.folder, 'gate.yaml')) && existsSync(path.join(s.folder, 'fixtures/payload.json')));
  assert.deepEqual(ledgerLines(s.ledger), []);
  assert.equal(s.state.prepared, 0, 'no tree was built');
  const m = reparseManifest(s);
  assert.equal(m.reparsedFrom, s.raw);
  assert.equal(m.runId, 'run-orig-1');
  assert.equal(m.status, 'ok');
  assert.equal(m.blind, 'audited (stream-json reads in tree)');
  assert.deepEqual(m.files, ['gate.yaml', 'fixtures/payload.json']);
  assert.match(r.text, /gate\.yaml/);
});

test('--reparse reads a mid-line file fence from the saved answer (real S17 shape)', async (t) => {
  const prose = 'I will read the diff first.The change touches scripts/github/pre-pr.mjs.';
  const answer = `${prose}\`\`\`file path=gate.yaml\n${flowYaml()}\n\`\`\`\n\`\`\`file path=fixtures/payload.json\n{}\n\`\`\`\n\`\`\`json\n${JSON.stringify(MANIFEST)}\n\`\`\``;
  const s = reparseSetup(t, { answer });
  const r = await cli(s, ['--reparse', s.raw, '--group', s.group]);
  assert.equal(r.code, 0, r.text);
  assert.ok(existsSync(path.join(s.folder, 'gate.yaml')));
});

test('--reparse refuses a group folder that is not empty and keeps what is there', async (t) => {
  const s = reparseSetup(t);
  put(s.root, 'scripts/trex/bench/flows/S18/old.yaml', 'keep me');
  const r = await cli(s, ['--reparse', s.raw, '--group', s.group]);
  assert.equal(r.code, 2);
  assert.match(r.text, /not empty/);
  assert.deepEqual(readdirSync(s.folder), ['old.yaml']);
});

test('--reparse refuses a raw file whose audit is blind: violated, and writes nothing', async (t) => {
  const outside = { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'C:/Users/someone/continuous-claude/.claudedocs/answers.md' } } } };
  const s = reparseSetup(t, { extra: [outside] });
  const r = await cli(s, ['--reparse', s.raw, '--group', s.group]);
  assert.equal(r.code, 2);
  assert.match(r.text, /outside the tree|violated/);
  assert.ok(!existsSync(s.folder) || readdirSync(s.folder).length === 0);
});

test('--reparse exits 1 and writes no flow when the lint fails, and still records the reparse', async (t) => {
  const s = reparseSetup(t, { answer: answer([['gate.yaml', flowYaml().replace('scripts/github/pre-pr.mjs', 'other/file.mjs')]], { flows: [{ id: 'gate-blocks-inline-body', file: 'gate.yaml', risk: 'r' }], cannotVerify: [] }) });
  const r = await cli(s, ['--reparse', s.raw, '--group', s.group]);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /paths hit no changed file/);
  assert.ok(!existsSync(s.folder) || readdirSync(s.folder).length === 0);
  assert.equal(reparseManifest(s).status, 'failed');
});

test('--reparse refuses a raw file that belongs to another group, a missing file and a stream with no result', async (t) => {
  const s = reparseSetup(t);
  assert.equal((await cli(s, ['--reparse', s.raw, '--group', 'S1'])).code, 2, 'wrong group');
  assert.equal((await cli(s, ['--reparse', path.join(s.root, 'nope.raw.json'), '--group', s.group])).code, 2, 'missing file');
  const empty = put(s.root, `.claude/cache/e2e/${RAW_DAY}-trex-author-S9.raw.json`, '{"type":"system","subtype":"init","cwd":"x"}\n');
  const r = await cli(s, ['--reparse', empty, '--group', 'S9']);
  assert.equal(r.code, 1, r.text);
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S9')) || readdirSync(path.join(s.root, 'scripts/trex/bench/flows/S9')).length === 0);
});

test('parseArgs: --reparse needs --group and takes no --dry-run', () => {
  assert.equal(parseArgs(['--reparse', 'a.raw.json', '--group', 'S17']).action, 'reparse');
  assert.equal(parseArgs(['--reparse', 'a.raw.json', '--group', 'S17']).reparse, 'a.raw.json');
  assert.ok(parseArgs(['--reparse', 'a.raw.json']).error);
  assert.ok(parseArgs(['--reparse', 'a.raw.json', '--group', 'S17', '--dry-run']).error);
  assert.ok(parseArgs(['--reparse']).error);
});

test('freeze reads the reparse manifest of a group whose live run failed', (t) => {
  // Breaks when latestManifest ignores "-reparse.manifest.json": S17 would never freeze.
  const s = freezeSetup(t);
  const cacheDir = s.opts.cacheDir;
  put(cacheDir, '2026-11-03-trex-author-S1.manifest.json', JSON.stringify({ group: 'S1', runId: 'run-S1', status: 'failed', usage: { in: 1 } }));
  put(cacheDir, '2026-11-03-trex-author-S1-reparse.manifest.json', JSON.stringify({ group: 'S1', runId: 'run-S1', status: 'ok', usage: { in: 1 }, reparsedFrom: 'x', blind: 'audited (stream-json reads in tree)' }));
  const frozen = freeze('abc123', s.opts, { git: s.git });
  assert.equal(frozen.groups.S1.blind, 'audited (stream-json reads in tree)');
});

// ---------- not-started runs (the grok gate returns no slot: the agent never spawned) ----------

/** The result runAgent gives when it did not spawn: cursor-review.mjs runAgent, grok-busy branch (other errors share the shape). */
const busyRun = (error = 'grok-busy') => () => ({ status: null, stdout: '', stderr: `grok gate: ${error}`, timedOut: false, error, notStarted: true, durationMs: 0, waitedMs: 120_000 });
const timedOutRun = () => ({ status: null, stdout: '', stderr: '', timedOut: true, durationMs: 9 });
/** n runs that never started: a start line and an end line with notStarted, as finishRun writes them. */
const notStartedLines = (n, ref = 'trex-S18') => Array.from({ length: n }, (_, i) => [
  { ts: '2026-11-01T00:00:00.000Z', phase: 'start', id: `ns-${ref}-${i}`, ref, model: 'grok-4.7-high' },
  { ts: '2026-11-01T00:00:01.000Z', phase: 'end', id: `ns-${ref}-${i}`, ref, exit: 1, notStarted: true, error: 'grok-busy' },
].map((l) => JSON.stringify(l)).join('\n')).join('\n');
const manifestOf = (s, re) => JSON.parse(readFileSync(path.join(s.root, '.claude/cache/e2e', cacheFiles(s.root).find((f) => re.test(f))), 'utf8'));

for (const [error, viaRealRunAgent] of [['grok-busy', true], ['hook-bash-hang', false], ['cli-config-race', false], ['bash-hang', false]]) {
  test(`authorGroup ends a not-started run (${error}) with notStarted, writes no flows and a not-started manifest, and exits 3`, async (t) => {
    const run = viaRealRunAgent ? (spec) => runAgent(spec, { gate: async () => ({ ok: false, reason: 'busy', waitedMs: 120_000 }), gateEnv: {}, spawnFn: () => { throw new Error('spawn forbidden in test'); } }) : busyRun(error);
    const s = authorSetup(t, { run });
    const r = await authorGroup('S18', s.opts, s.deps);
    assert.equal(r.exit, 3, r.problems.join('; '));
    assert.equal(r.notStarted, true);
    assert.match(r.problems[0], new RegExp(`^not started: .*${error}`));
    assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18')), 'no flows');
    const lines = ledgerLines(s.ledger);
    assert.deepEqual(lines.map((l) => l.phase), ['start', 'end']);
    assert.equal(lines[1].id, lines[0].id);
    assert.equal(lines[1].notStarted, true);
    assert.match(lines[1].error, new RegExp(error));
    const m = manifestOf(s, /not-started/);
    assert.equal(m.status, 'not-started');
    assert.equal(m.error.includes(error), true);
    assert.equal(m.runId, lines[0].id);
    assert.equal(s.state.cleaned, 1);
    assert.deepEqual(benchRuns(s.ledger), { used: 0, byRef: {} });
  });
}

test('benchRuns skips a run whose end line says notStarted, by id and by ref', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trex-author-test-'));
  try {
    const ledger = path.join(dir, 'l.jsonl');
    writeFileSync(ledger, `${notStartedLines(2, 'trex-S18')}\n${startLines(1, 'trex-S18')}\n`);
    assert.deepEqual(benchRuns(ledger), { used: 1, byRef: { 'trex-S18': 1 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('not-started runs use neither a bench run nor a group run: BENCH_CAP of them and GROUP_CAP for one group still allow a run', async (t) => {
  const s = authorSetup(t, { ledger: `${notStartedLines(BENCH_CAP, 'trex-S1')}\n${notStartedLines(GROUP_CAP, 'trex-S18')}\n` });
  const r = await authorGroup('S18', s.opts, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.equal(s.state.runs.length, 1);
});

test('a not-started run needs no --retry for the next attempt, but a run that ran still does', async (t) => {
  const s = authorSetup(t, { ledger: `${notStartedLines(1, 'trex-S18')}\n` });
  assert.equal((await authorGroup('S18', s.opts, s.deps)).exit, 0, 'never ran: no retry flag');
  const f = authorSetup(t, { ledger: `${startLines(1, 'trex-S18')}\n${notStartedLines(1, 'trex-S18')}\n` });
  assert.equal((await authorGroup('S18', f.opts, f.deps)).exit, 2, 'an earlier run did run: --retry is still needed');
  assert.equal(f.state.runs.length, 0);
});

test('a not-started retry does not hide the outcome of the run before it', async (t) => {
  const ok = JSON.stringify({ ts: '2026-11-01T00:00:01.000Z', phase: 'end', id: 'id-trex-S18-0', ref: 'trex-S18', exit: 0 });
  const s = authorSetup(t, { ledger: `${startLines(1, 'trex-S18')}\n${ok}\n${notStartedLines(1, 'trex-S18')}\n` });
  assert.equal((await authorGroup('S18', { ...s.opts, retry: true }, s.deps)).exit, 2, 'the last run that ran succeeded: --retry-harness only');
});

test('a not-started retry keeps the manifest of the failed run, and the next real retry is numbered r1', async (t) => {
  let busy = false;
  const s = authorSetup(t, { run: (spec) => (busy ? busyRun()(spec) : timedOutRun()) });
  assert.equal((await authorGroup('S18', s.opts, s.deps)).exit, 1);
  const first = manifestOf(s, /S18\.manifest\.json$/);
  busy = true;
  assert.equal((await authorGroup('S18', { ...s.opts, retry: true }, s.deps)).exit, 3);
  assert.deepEqual(manifestOf(s, /S18\.manifest\.json$/), first, 'the failed run manifest is untouched');
  busy = false;
  assert.equal((await authorGroup('S18', { ...s.opts, retry: true }, s.deps)).exit, 1);
  assert.equal(manifestOf(s, /S18-r1\.manifest\.json$/).retries, 1);
});

test('main --group prints one line for a not-started run and exits 3', async (t) => {
  const s = authorSetup(t, { run: busyRun() });
  const { code, text } = await cli(s, ['--group', 'S18']);
  assert.equal(code, 3);
  assert.equal(text.split('\n').length, 1, text);
  assert.match(text, /^S18: exit 3 \(not started: /);
});

test('freeze refuses a group whose latest manifest is a not-started record', (t) => {
  const s = freezeSetup(t);
  put(s.opts.cacheDir, '2026-11-03-trex-author-S1.manifest.json', JSON.stringify({ group: 'S1', runId: 'run-S1', status: 'not-started', error: 'grok-busy' }));
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /S1/);
});

// ---------- model arms (arms spec section 4) ----------

const otherArmLines = () => ['trex-composer-S1', 'trex-xhigh-S8', 'trex-grok2-S14'].map((ref) => startLines(1, ref)).join('\n');

test('benchRuns for the grok arm does not count the composer, xhigh or grok2 prefixes', (t) => {
  // Breaks when benchRuns goes back to counting every "trex-" ref: the grok cap of 24 would be spent by other arms.
  const s = authorSetup(t, { ledger: `${startLines(2, 'trex-S1')}\n${otherArmLines()}\n` });
  assert.equal(benchRuns(s.ledger).used, 2);
  assert.deepEqual(Object.keys(benchRuns(s.ledger).byRef), ['trex-S1']);
});

test('freeze with zero host flows needs no marker and records hostFlows: 0', (t) => {
  // Breaks when freeze checks the marker for an arm that has only container flows.
  const s = freezeSetup(t, { s1Flow: flowYaml().replace('gate-blocks-inline-body', 'first-flow-here'), noMarker: true });
  const r = freeze('abc123', s.opts, { git: s.git });
  assert.equal(r.hostFlows, 0);
  assert.equal(JSON.parse(readFileSync(path.join(s.root, 'scripts/trex/bench/frozen.json'), 'utf8')).hostFlows, 0);
});

test('freeze with a host flow still needs the marker, and records the host flow count', (t) => {
  // Breaks when the zero-host shortcut also skips the marker for an arm that has a host flow.
  assert.throws(() => freeze('abc123', freezeSetup(t, { noMarker: true }).opts, { git: freezeSetup(t).git }), /review/i);
  const s = freezeSetup(t);
  assert.equal(freeze('abc123', s.opts, { git: s.git }).hostFlows, 1);
});

test('parseArgs reads --arm for a run, a freeze and a reparse, and refuses an unknown arm', () => {
  // Breaks when --arm is not parsed: every arm would write to the grok flows dir and count against the grok cap.
  assert.equal(parseArgs(['--group', 'S1', '--arm', 'composer']).arm, 'composer');
  assert.equal(parseArgs(['--group', 'S1']).arm, 'grok');
  assert.equal(parseArgs(['--freeze', '--sha', 'abc', '--arm', 'xhigh']).arm, 'xhigh');
  assert.equal(parseArgs(['--reparse', 'a.raw.json', '--group', 'S1', '--arm', 'grok2']).arm, 'grok2');
  assert.match(parseArgs(['--group', 'S1', '--arm', 'opus']).error, /arm/);
  assert.match(parseArgs(['--group', 'S1', '--arm']).error, /arm/);
});

const ARM_DIR = (arm) => `scripts/trex/bench/flows-${arm}`;
const runsOf = (s) => s.state.runs.length;
const modelOf = (spec) => spec.args[spec.args.indexOf('--model') + 1];
const armLedger = (arm, n) => `${Array.from({ length: n }, (_, i) => JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', phase: 'start', id: `id-${arm}-${i}`, ref: `trex-${arm}-S${i + 100}`, model: 'x' })).join('\n')}\n`;

test('authorGroup --arm composer: composer-2.5, its own ref, flows folder and cache stem', async (t) => {
  // Breaks when an arm run writes to the grok folder or stem: it would clobber the grok flows and manifest of the same group.
  const s = authorSetup(t, { run: streamRun() });
  const r = await authorGroup('S18', { ...s.opts, arm: 'composer' }, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.equal(modelOf(s.state.runs[0]), 'composer-2.5');
  assert.deepEqual(ledgerLines(s.ledger).map((l) => [l.phase, l.ref, l.model]), [['start', 'trex-composer-S18', 'composer-2.5'], ['end', 'trex-composer-S18', 'composer-2.5']]);
  assert.ok(existsSync(path.join(s.root, ARM_DIR('composer'), 'S18', 'gate.yaml')));
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18')));
  assert.ok(cacheFiles(s.root).some((f) => /-trex-author-composer-S18\.manifest\.json$/.test(f)));
  assert.ok(!cacheFiles(s.root).some((f) => /-trex-author-S18\./.test(f)), 'no grok-stem file');
  const m = manifestOf(s, /-trex-author-composer-S18\.manifest\.json$/);
  assert.equal(m.model, 'composer-2.5');
  assert.equal(m.ref, 'trex-composer-S18');
});

test('authorGroup --arm xhigh uses its model, ref and folder', async (t) => {
  // Breaks when an arm table row is wrong: xhigh would run high. (grok2 has cap 0 since Dave 11-03 and no longer runs live.)
  const s = authorSetup(t, { run: streamRun() });
  const r = await authorGroup('S8', { ...s.opts, arm: 'xhigh' }, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.equal(modelOf(s.state.runs[0]), 'grok-4.7-xhigh');
  assert.equal(ledgerLines(s.ledger)[0].ref, 'trex-xhigh-S8');
  assert.ok(existsSync(path.join(s.root, ARM_DIR('xhigh'), 'S8', 'gate.yaml')));
});

test('grok2 has a cap of 0: a live run exits 3, starts no agent and writes no ledger line', async (t) => {
  // Breaks when the grok2 cap goes back to 4: its 4 runs belong to the intent probe (Dave 11-03).
  const s = authorSetup(t, { run: streamRun() });
  const r = await authorGroup('S8', { ...s.opts, arm: 'grok2' }, s.deps);
  assert.equal(r.exit, 3);
  assert.match(r.problems[0], /0 of 0/);
  assert.equal(runsOf(s), 0);
  assert.deepEqual(ledgerLines(s.ledger), []);
});

test('each arm has its own cap: 24 composer, 4 xhigh, 0 grok2, 4 intent, and other arms never spend the grok 24', async (t) => {
  // Breaks when the cap or the count is shared between arms.
  for (const [arm, cap] of [['composer', 24], ['xhigh', 4], ['grok2', 0], ['intent', 4]]) {
    const full = authorSetup(t, { ledger: armLedger(arm, cap), run: streamRun() });
    assert.equal(benchRuns(full.ledger, arm).used, cap, arm);
    assert.equal((await authorGroup('S1', { ...full.opts, arm }, full.deps)).exit, 3, `${arm} is full`);
    assert.equal(runsOf(full), 0, `${arm} starts no agent`);
    assert.equal(benchRuns(full.ledger).used, 0, `${arm} runs are not grok runs`);
    assert.equal((await authorGroup('S1', full.opts, full.deps)).exit, 0, `grok still runs when ${arm} is full`);
  }
});

test('an arm run one below its cap passes', async (t) => {
  // Breaks when the arm cap is off by one.
  const s = authorSetup(t, { ledger: armLedger('xhigh', 3), run: streamRun() });
  assert.equal((await authorGroup('S1', { ...s.opts, arm: 'xhigh' }, s.deps)).exit, 0);
});

test('authorGroup refuses a group outside the arm: xhigh and grok2 run S1, S8, S14 and S18 only', async (t) => {
  // Breaks when the groups of an arm are not enforced: a 4-run arm would spend its cap on the wrong rows.
  const s = authorSetup(t);
  for (const arm of ['xhigh', 'grok2']) {
    assert.equal((await authorGroup('S3', { ...s.opts, arm }, s.deps)).exit, 2, arm);
    assert.equal((await authorGroup('S1', { ...s.opts, arm, dryRun: true }, s.deps)).exit, 0, `${arm} S1`);
  }
  assert.equal(runsOf(s), 0);
});

test('authorGroup allows the authoring models and refuses fast, auto and a model of another arm', async (t) => {
  // Breaks when the allow-list is wrong: a -fast or Auto run would be billed, or an arm would run the wrong model.
  const s = authorSetup(t, { run: streamRun() });
  const exit = async (arm, model) => (await authorGroup('S18', { ...s.opts, arm, model, dryRun: true }, s.deps)).exit;
  for (const [arm, model] of [['grok', 'grok-4.7-high'], ['composer', 'composer-2.5'], ['xhigh', 'grok-4.7-xhigh'], ['grok2', 'grok-4.7-high'], ['composer2', 'composer-2.5']]) assert.equal(await exit(arm, model), 0, `${arm} ${model}`);
  for (const [arm, model] of [['grok', 'grok-4.7-fast'], ['grok', 'auto'], ['grok', 'Auto'], ['composer', 'composer-2.5-fast'], ['composer', 'auto'], ['composer', 'grok-4.7-high'], ['grok', 'composer-2.5'], ['grok', 'grok-4.7-xhigh'], ['composer2', 'grok-4.7-high'], ['xhigh', 'grok-4.7-high'], ['grok2', 'grok-4.7-xhigh'], ['grok', 'grok-4.7-low']]) assert.equal(await exit(arm, model), 2, `${arm} ${model}`);
});

test('authorGroup refuses an unknown arm', async (t) => {
  const s = authorSetup(t);
  assert.equal((await authorGroup('S18', { ...s.opts, arm: 'opus' }, s.deps)).exit, 2);
  assert.equal(runsOf(s), 0);
});

test('an arm run that never starts exits 3, is not counted, and writes a not-started manifest with the arm stem', async (t) => {
  // Breaks when the not-started path ignores the arm: a busy slot would write a grok-stem file or spend an arm run.
  const s = authorSetup(t, { run: busyRun() });
  const r = await authorGroup('S18', { ...s.opts, arm: 'composer' }, s.deps);
  assert.equal(r.exit, 3);
  assert.equal(benchRuns(s.ledger, 'composer').used, 0);
  assert.ok(cacheFiles(s.root).some((f) => /-trex-author-composer-S18-not-started-[0-9a-f]{8}\.manifest\.json$/.test(f)), cacheFiles(s.root).join(','));
  assert.ok(!existsSync(path.join(s.root, ARM_DIR('composer'), 'S18')));
});

test('an arm run keeps the stream-json audit: a read outside the tree fails the run and writes no flow', async (t) => {
  const outside = { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'C:/Users/someone/continuous-claude/.claudedocs/answers.md' } } } };
  const s = authorSetup(t, { run: streamRun({ extra: [outside] }) });
  const r = await authorGroup('S18', { ...s.opts, arm: 'composer' }, s.deps);
  assert.equal(r.exit, 1);
  assert.match(r.problems[0], /blind violated/);
  assert.ok(!existsSync(path.join(s.root, ARM_DIR('composer'), 'S18')));
});

test('an arm probe uses the arm ref and counts for that arm only', async (t) => {
  const s = authorSetup(t, { run: streamRun() });
  await authorGroup('S18', { ...s.opts, arm: 'composer', probe: true }, s.deps);
  assert.equal(ledgerLines(s.ledger)[0].ref, 'trex-composer-probe');
  assert.equal(benchRuns(s.ledger, 'composer').used, 1);
  assert.equal(benchRuns(s.ledger).used, 0);
});

test('a composer retry after a failed run is numbered and keeps the group cap', async (t) => {
  // The second composer run on S1, S8, S14 and S18 and its retries share the group cap, as in the grok arm.
  const s = authorSetup(t, { run: () => timedOutRun() });
  const o = { ...s.opts, arm: 'composer' };
  assert.equal((await authorGroup('S18', o, s.deps)).exit, 1);
  assert.equal((await authorGroup('S18', o, s.deps)).exit, 2, 'a second run needs a retry flag');
  for (let i = 1; i < GROUP_CAP; i++) assert.equal((await authorGroup('S18', { ...o, retry: true }, s.deps)).exit, 1);
  assert.equal((await authorGroup('S18', { ...o, retry: true }, s.deps)).exit, 3);
  assert.ok(cacheFiles(s.root).some((f) => /-trex-author-composer-S18-r1\.manifest\.json$/.test(f)));
});

test('main --arm: the dry run names the arm, model and folder and shows the arm count and cap', async (t) => {
  // Breaks when the dry run prints the grok count or cap for another arm.
  const s = authorSetup(t, { ledger: `${startLines(3, 'trex-S1')}\n${armLedger('composer', 1)}${armLedger('xhigh', 1)}` });
  const c = await cli(s, ['--group', 'S1', '--arm', 'composer', '--dry-run']);
  assert.equal(c.code, 0, c.text);
  assert.match(c.text, /arm: composer \(composer-2\.5\)/);
  assert.match(c.text, /flows: scripts\/trex\/bench\/flows-composer\/S1/);
  assert.match(c.text, /bench runs: 1 of 20/);
  const x = await cli(s, ['--group', 'S8', '--arm', 'xhigh', '--dry-run']);
  assert.match(x.text, /arm: xhigh \(grok-4\.7-xhigh\)/);
  assert.match(x.text, /bench runs: 1 of 4/);
  const g = await cli(s, ['--group', 'S1', '--dry-run']);
  assert.match(g.text, /bench runs: 3 of 24/);
  assert.match(g.text, /arm: grok \(grok-4\.7-high\)/);
  assert.equal(runsOf(s), 0);
});

test('main --all --arm xhigh runs the four variance groups and no others', async (t) => {
  // Breaks when --all walks all 16 groups for an arm with a cap of 4.
  const s = authorSetup(t, { run: streamRun() });
  const r = await cli(s, ['--all', '--arm', 'xhigh']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(ledgerLines(s.ledger).filter((l) => l.phase === 'start').map((l) => l.ref), ['S1', 'S8', 'S14', 'S18'].map((g) => `trex-xhigh-${g}`));
});

test('main --all --arm composer --dry-run walks all 16 groups', async (t) => {
  const s = authorSetup(t);
  const r = await cli(s, ['--all', '--arm', 'composer', '--dry-run']);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.text.split('\n').filter((l) => l.startsWith('dry run: ')).length, 16);
});

test('freeze --arm xhigh reads the arm manifests and flows dir and writes frozen-xhigh.json, not frozen.json', (t) => {
  // Breaks when an arm freeze reads grok manifests or overwrites frozen.json.
  const s = freezeSetup(t, { flowsDir: ARM_DIR('xhigh'), stem: 'trex-author-xhigh', s1Flow: flowYaml().replace('gate-blocks-inline-body', 'first-flow-here'), noMarker: true, opts: { groups: undefined, fixes: undefined, arm: 'xhigh' } });
  for (const g of ['S14', 'S18']) put(s.opts.cacheDir, `2026-11-02-trex-author-xhigh-${g}.manifest.json`, JSON.stringify({ group: g, runId: `run-${g}`, model: 'grok-4.7-xhigh', retries: 0 }));
  put(s.opts.cacheDir, '2026-11-02-trex-author-S1.manifest.json', JSON.stringify({ group: 'S1', runId: 'grok-run', model: 'grok-4.7-high', retries: 0 }));
  const r = freeze('abc123', s.opts, { git: s.git });
  assert.deepEqual(Object.keys(r.groups), ['S1', 'S8', 'S14', 'S18']);
  assert.equal(r.groups.S1.runId, 'run-S1', 'the xhigh manifest, not the grok one');
  assert.equal(r.hostFlows, 0);
  const file = JSON.parse(readFileSync(path.join(s.root, 'scripts/trex/bench/frozen-xhigh.json'), 'utf8'));
  assert.equal(file.arm, 'xhigh');
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/frozen.json')));
});

test('freeze --arm composer with a host flow keeps the marker rule', (t) => {
  const s = freezeSetup(t, { flowsDir: ARM_DIR('composer'), stem: 'trex-author-composer', noMarker: true, opts: { arm: 'composer', groups: ['S1', 'S8'], fixes: { S1: 'f1', S8: 'f8' } } });
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /review/i);
});

test('freeze for the grok arm still writes frozen.json and records the arm', (t) => {
  const s = freezeSetup(t);
  const file = freeze('abc123', s.opts, { git: s.git });
  assert.equal(file.arm, 'grok');
  assert.ok(existsSync(path.join(s.root, 'scripts/trex/bench/frozen.json')));
});

test('--reparse --arm composer writes to the composer folder and refuses a raw file of another arm', async (t) => {
  // Breaks when reparse ignores the arm: composer flows would land in the grok folder.
  const s = reparseSetup(t);
  const composerRaw = put(s.root, `.claude/cache/e2e/${RAW_DAY}-trex-author-composer-S18.raw.json`, streamFor(path.join(s.root, 'old-tree')));
  assert.equal((await cli(s, ['--reparse', s.raw, '--group', 'S18', '--arm', 'composer'])).code, 2, 'a grok raw file is not a composer raw file');
  assert.equal((await cli(s, ['--reparse', composerRaw, '--group', 'S18'])).code, 2, 'a composer raw file is not a grok raw file');
  const ok = await cli(s, ['--reparse', composerRaw, '--group', 'S18', '--arm', 'composer']);
  assert.equal(ok.code, 0, ok.text);
  assert.ok(existsSync(path.join(s.root, ARM_DIR('composer'), 'S18', 'gate.yaml')));
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S18')));
  assert.ok(existsSync(path.join(s.root, `.claude/cache/e2e/${RAW_DAY}-trex-author-composer-S18-reparse.manifest.json`)));
});

// ---------- principal review fixes (2026-11-03): findings 5, 6, 7 and 13 ----------

const ranOk = (ref) => `${JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', phase: 'start', id: `id-${ref}`, ref, model: 'composer-2.5' })}\n${JSON.stringify({ ts: '2026-11-01T00:01:00.000Z', phase: 'end', id: `id-${ref}`, ref, exit: 0 })}\n`;

test('F7: the default arm refuses grok-4.7-xhigh before a run, a ledger line or a folder change', async (t) => {
  // Breaks when ARMS.grok.models lists grok-4.7-xhigh: it spends the grok cap and replaces the control flows with xhigh flows.
  const s = authorSetup(t, { run: streamRun() });
  const r = await authorGroup('S8', { ...s.opts, retry: true, model: 'grok-4.7-xhigh' }, s.deps);
  assert.equal(r.exit, 2);
  assert.equal(runsOf(s), 0);
  assert.deepEqual(ledgerLines(s.ledger), []);
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/flows/S8')));
});

test('F6: --arm composer2 runs composer-2.5 under its own ref, folder and stem, and composer runs are not its runs', async (t) => {
  // Breaks when composer2 is missing from ARMS: the second composer run cannot be stored apart from the first.
  const s = authorSetup(t, { run: streamRun(), ledger: ranOk('trex-composer-S1') });
  const r = await authorGroup('S1', { ...s.opts, arm: 'composer2' }, s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.equal(modelOf(s.state.runs[0]), 'composer-2.5');
  assert.deepEqual(ledgerLines(s.ledger).slice(-2).map((l) => [l.phase, l.ref]), [['start', 'trex-composer2-S1'], ['end', 'trex-composer2-S1']]);
  assert.ok(existsSync(path.join(s.root, ARM_DIR('composer2'), 'S1', 'gate.yaml')));
  assert.ok(!existsSync(path.join(s.root, ARM_DIR('composer'), 'S1')), 'the composer folder is untouched');
  assert.ok(cacheFiles(s.root).some((f) => /-trex-author-composer2-S1\.manifest\.json$/.test(f)));
  assert.equal(benchRuns(s.ledger, 'composer').used, 1);
  assert.equal(benchRuns(s.ledger, 'composer2').used, 1);
  assert.equal(benchRuns(s.ledger).used, 0);
});

test('F6: composer2 has a cap of 4 and runs the four variance groups only', async (t) => {
  const full = authorSetup(t, { ledger: armLedger('composer2', 4), run: streamRun() });
  assert.equal((await authorGroup('S1', { ...full.opts, arm: 'composer2' }, full.deps)).exit, 3);
  assert.equal(runsOf(full), 0);
  assert.equal(benchRuns(full.ledger).used, 0, 'composer2 runs are not grok runs');
  assert.equal((await authorGroup('S3', { ...authorSetup(t).opts, arm: 'composer2' }, authorSetup(t).deps)).exit, 2);
  assert.equal(parseArgs(['--all', '--arm', 'composer2']).arm, 'composer2');
});

test('F6: a second composer success on a variance group is refused, with every retry flag, and composer2 takes it', async (t) => {
  // Breaks when --retry-harness may rerun a composer variance group that succeeded: it replaces the first answer the variance run compares.
  const s = authorSetup(t, { run: streamRun(), ledger: ranOk('trex-composer-S1') });
  for (const retry of [undefined, true, 'harness']) {
    const r = await authorGroup('S1', { ...s.opts, arm: 'composer', retry }, s.deps);
    assert.equal(r.exit, 2, String(retry));
    assert.match(r.problems.join(' '), /composer2/);
  }
  assert.equal(runsOf(s), 0);
  assert.ok(!existsSync(path.join(s.root, ARM_DIR('composer'), 'S1')));
  assert.equal((await authorGroup('S1', { ...s.opts, arm: 'composer2' }, s.deps)).exit, 0);
  const other = authorSetup(t, { run: streamRun(), ledger: ranOk('trex-composer-S2') });
  assert.equal((await authorGroup('S2', { ...other.opts, arm: 'composer', retry: 'harness' }, other.deps)).exit, 0, 'a group outside the variance set keeps the harness retry');
});

test('F6: freeze --arm composer2 writes frozen-composer2.json', (t) => {
  const s = freezeSetup(t, {
    flowsDir: ARM_DIR('composer2'), stem: 'trex-author-composer2', s1Flow: flowYaml().replace('gate-blocks-inline-body', 'first-flow-here'), noMarker: true,
    opts: { arm: 'composer2', groups: ['S1', 'S8'], fixes: { S1: 'f1', S8: 'f8' } },
  });
  const r = freeze('abc123', s.opts, { git: s.git });
  assert.equal(r.arm, 'composer2');
  assert.equal(JSON.parse(readFileSync(path.join(s.root, 'scripts/trex/bench/frozen-composer2.json'), 'utf8')).arm, 'composer2');
});

test('F13: the host review marker is per arm: composer reads host-review-composer.json, grok keeps host-review.json', (t) => {
  // Breaks when every arm reads host-review.json: a marker for one arm then fails or passes the freeze of another.
  const c = freezeSetup(t, { flowsDir: ARM_DIR('composer'), stem: 'trex-author-composer', noMarker: true, opts: { arm: 'composer', groups: ['S1', 'S8'], fixes: { S1: 'f1', S8: 'f8' } } });
  put(c.root, 'scripts/trex/bench/host-review.json', JSON.stringify({ sha256: c.digest }));
  assert.throws(() => freeze('abc123', c.opts, { git: c.git }), /review/i, 'the grok marker does not cover composer');
  put(c.root, 'scripts/trex/bench/host-review-composer.json', JSON.stringify({ sha256: c.digest }));
  assert.equal(freeze('abc123', c.opts, { git: c.git }).hostFlows, 1);
  const g = freezeSetup(t);
  assert.equal(freeze('abc123', g.opts, { git: g.git }).hostFlows, 1, 'grok still reads host-review.json');
});

test('F5: freeze pins the negative heads and the blob ids of negatives.json and proofs-trex.json', (t) => {
  // Breaks when the freeze records no pins: a head or a defectFiles edit after the freeze then goes unseen by the bench preflight.
  const s = freezeSetup(t);
  const r = freeze('abc123', s.opts, { git: s.git });
  assert.deepEqual(r.pins, { negatives: { N2: 'nnn' }, files: { negatives: 'blob:negatives.json', proofs: 'blob:proofs-trex.json' } });
  assert.deepEqual(JSON.parse(readFileSync(path.join(s.root, 'scripts/trex/bench/frozen.json'), 'utf8')).pins, r.pins);
});

test('F5: freeze refuses when an input cannot be hashed, and writes no frozen file', (t) => {
  const s = freezeSetup(t, { noHash: true });
  assert.throws(() => freeze('abc123', s.opts, { git: s.git }), /negatives\.json/);
  assert.ok(!existsSync(path.join(s.root, 'scripts/trex/bench/frozen.json')));
});

// ---------- the intent arm (Dave 11-03: grok2's 4 runs moved to the intent probe) ----------

const SEPR = '\x1f';
const INTENT = { pr: 193, title: 'feat(pre-pr): run every gate before a PR opens', body: 'The gate runs the checks.\nA PR that skips the review is blocked.', source: 'pr', fetchedAt: '2026-11-03T00:00:00.000Z' };
const intentPath = (root, g = 'S18') => path.join(root, 'scripts/trex/bench/intent', `${g}.json`);
const storeIntent = (root, intent = INTENT, g = 'S18') => put(root, `scripts/trex/bench/intent/${g}.json`, JSON.stringify(intent));
const PR_JSON = { number: 193, title: INTENT.title, body: 'Fetched body.', merged_at: '2026-10-30T00:00:00Z' };
const promptOf = (spec) => spec.args.at(-1);
const IGIT = (extra = []) => gitFrom([
  [/^log -1 --format=%s%x1f%B 6bc94082$/, () => ({ status: 0, stdout: `Merge pull request #193 from Rev4nchist/feat/review-budget-prepr-gate${SEPR}Merge pull request #193 from x\n\n${INTENT.title}\n` })],
  ...extra,
  [/^log -1 --format=%s/, () => ({ status: 0, stdout: 'fix: something unrelated to any file\n' })],
]);

function intentSetup(t, { intent = INTENT, gh, git, ...over } = {}) {
  const s = authorSetup(t, { run: streamRun(), ...over });
  if (intent) storeIntent(s.root, intent);
  s.gh = (args) => { s.gh.calls.push(args); return gh ? gh(args) : { status: 0, stdout: JSON.stringify(PR_JSON), stderr: '' }; };
  s.gh.calls = [];
  s.deps.gh = s.gh;
  if (git) s.deps.git = git;
  return s;
}
const iopts = (s, extra = {}) => ({ ...s.opts, arm: 'intent', ...extra });

test('authorGroup --arm intent: grok-4.7-high, its own ref, folder and stem, and the prompt holds the stored intent', async (t) => {
  // Breaks when the arm row is wrong, or when the arm still uses the plain template: the author would get no statement of intent.
  const s = intentSetup(t);
  const r = await authorGroup('S18', iopts(s), s.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.equal(modelOf(s.state.runs[0]), 'grok-4.7-high');
  assert.deepEqual(ledgerLines(s.ledger).map((l) => [l.phase, l.ref]), [['start', 'trex-intent-S18'], ['end', 'trex-intent-S18']]);
  assert.ok(existsSync(path.join(s.root, ARM_DIR('intent'), 'S18', 'gate.yaml')));
  assert.ok(cacheFiles(s.root).some((f) => /-trex-author-intent-S18\.manifest\.json$/.test(f)));
  const prompt = promptOf(s.state.runs[0]);
  assert.match(prompt, /## What the change is meant to do/);
  assert.ok(prompt.includes(INTENT.title) && prompt.includes('A PR that skips the review is blocked.'));
  assert.match(prompt, /Test what the change is meant to do, not what the code happens to output\./);
  assert.ok(!/undefined/.test(prompt));
  assert.equal(s.gh.calls.length, 0, 'a stored intent is never fetched');
});

test('the intent prompt strips lines written after the merge, and a body that holds {files} is not filled again', async (t) => {
  // Breaks when the strip runs only on fetch (a hand-edited file would leak) or when the body is rendered before the file list.
  const s = intentSetup(t, { intent: { ...INTENT, body: 'Keep {files} and {ref} literal.\nAlso fixed in #300.\nDone.' } });
  await authorGroup('S18', iopts(s), s.deps);
  const prompt = promptOf(s.state.runs[0]);
  assert.ok(prompt.includes('Keep {files} and {ref} literal.'));
  assert.ok(!prompt.includes('#300'));
  assert.ok(JSON.parse(readFileSync(intentPath(s.root), 'utf8')).body.includes('#300'), 'the stored file keeps the raw body');
});

test('the intent arm refuses xhigh and composer models, a group outside S1, S8, S14 and S18, and a full cap, before any run', async (t) => {
  const s = intentSetup(t);
  for (const model of ['grok-4.7-xhigh', 'composer-2.5', 'grok-4.7-fast']) assert.equal((await authorGroup('S18', iopts(s, { model }), s.deps)).exit, 2, model);
  assert.equal((await authorGroup('S3', iopts(s), s.deps)).exit, 2);
  const full = intentSetup(t, { ledger: armLedger('intent', 4) });
  assert.equal((await authorGroup('S18', iopts(full), full.deps)).exit, 3);
  assert.equal(runsOf(s) + runsOf(full), 0);
});

test('a live intent run with no stored file and a failing gh exits 1, starts no agent and writes no ledger line', async (t) => {
  // Breaks when a failed fetch falls through to an empty intent: the probe would burn a run with no intent.
  const s = intentSetup(t, { intent: null, git: IGIT(), gh: () => ({ status: 1, stdout: '', stderr: 'gh: not logged in' }) });
  const r = await authorGroup('S18', iopts(s), s.deps);
  assert.equal(r.exit, 1);
  assert.match(r.problems[0], /not logged in/);
  assert.equal(runsOf(s), 0);
  assert.deepEqual(ledgerLines(s.ledger), []);
  assert.ok(!existsSync(intentPath(s.root)));
});

test('main --arm intent --dry-run fetches and stores a missing intent once, shows its title, and reads the file on the next dry run', async (t) => {
  // Breaks when the dry run skips the intent (no title shown) or fetches again each time.
  const s = intentSetup(t, { intent: null, git: IGIT() });
  const a = await cli(s, ['--group', 'S18', '--arm', 'intent', '--dry-run']);
  assert.equal(a.code, 0, a.text);
  assert.match(a.text, /intent: PR #193 "feat\(pre-pr\): run every gate before a PR opens"/);
  assert.match(a.text, /scripts\/trex\/bench\/intent\/S18\.json \(fetched\)/);
  assert.match(a.text, /leak scan: clean/);
  assert.match(a.text, /bench runs: 0 of 4/);
  assert.match(a.text, /flows: scripts\/trex\/bench\/flows-intent\/S18/);
  assert.equal(JSON.parse(readFileSync(intentPath(s.root), 'utf8')).body, 'Fetched body.');
  const b = await cli(s, ['--group', 'S18', '--arm', 'intent', '--dry-run']);
  assert.match(b.text, /\(stored\)/);
  assert.equal(s.gh.calls.length, 1);
  assert.equal(runsOf(s), 0);
  assert.deepEqual(ledgerLines(s.ledger), []);
});

test('main --refetch-intent replaces the stored file; it needs the intent arm', async (t) => {
  // Breaks when the flag is ignored or when another arm accepts it.
  const s = intentSetup(t, { git: IGIT() });
  const r = await cli(s, ['--group', 'S18', '--arm', 'intent', '--dry-run', '--refetch-intent']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\(refetched\)/);
  assert.equal(JSON.parse(readFileSync(intentPath(s.root), 'utf8')).body, 'Fetched body.');
  assert.equal(parseArgs(['--group', 'S18', '--arm', 'intent', '--refetch-intent']).refetchIntent, true);
  assert.match(parseArgs(['--group', 'S18', '--refetch-intent']).error, /intent arm/);
});

test('dry run reports what the strip removed', async (t) => {
  const s = intentSetup(t, { intent: { ...INTENT, body: 'Gate.\nFollow-up: spaces.' } });
  const r = await cli(s, ['--group', 'S18', '--arm', 'intent', '--dry-run']);
  assert.match(r.text, /stripped 1 line\(s\)/);
  assert.match(r.text, /Follow-up: spaces\./);
});

test('an intent that names the fix sha refuses a live run with exit 2, prints the hit, and starts no agent', async (t) => {
  // Breaks when the intent text skips the leak scan: the answer would reach the author.
  const s = intentSetup(t, { intent: { ...INTENT, body: `Reverted to ${GROUPS.S18.fix.slice(0, 8)} later.` } });
  const r = await authorGroup('S18', iopts(s), s.deps);
  assert.equal(r.exit, 2);
  assert.ok(r.problems.some((p) => /intent/.test(p) && p.includes('fix sha')), r.problems.join('; '));
  assert.equal(runsOf(s), 0);
  assert.deepEqual(ledgerLines(s.ledger), []);
  const dry = await cli(s, ['--group', 'S18', '--arm', 'intent', '--dry-run']);
  assert.equal(dry.code, 2);
  assert.match(dry.text, /leak scan: 1 hit/);
  assert.match(dry.text, /intent.*fix sha/);
});

test('an intent that holds the fix PR title or a later commit subject refuses the run (a line that names the later fix PR is stripped first)', async (t) => {
  // Breaks when the PR and later-commit rules are not wired to git: they would pass in the unit test and miss in a run.
  const git = IGIT([
    [/^log -1 --format=%s%x1f%b 82a06d63$/, () => ({ status: 0, stdout: `Merge pull request #197 from a/b${SEPR}fix: the gate findings\n` })],
    [/^log -1 --format=%s%x1f%b 6bc94082$/, () => ({ status: 0, stdout: `Merge pull request #193 from a/c${SEPR}${INTENT.title}\n` })],
    [/^log --format=%s 6bc94082\.\.82a06d63$/, () => ({ status: 0, stdout: 'a later commit subject that repairs it\n' })],
  ]);
  for (const body of ['Note: fix: the gate findings in pre-pr', 'then a later commit subject that repairs it']) {
    const s = intentSetup(t, { intent: { ...INTENT, body }, git });
    const r = await authorGroup('S18', iopts(s), s.deps);
    assert.equal(r.exit, 2, body);
    assert.equal(runsOf(s), 0);
  }
  const stripped = intentSetup(t, { intent: { ...INTENT, body: 'See #197.' }, git });
  assert.equal((await authorGroup('S18', iopts(stripped), stripped.deps)).exit, 0, 'a later PR number is stripped, so it never reaches the author');
  assert.ok(!promptOf(stripped.state.runs[0]).includes('#197'));
  const clean = intentSetup(t, { git });
  assert.equal((await authorGroup('S18', iopts(clean), clean.deps)).exit, 0);
});

test('the other arms never read the intent: no gh call, no intent section in the prompt', async (t) => {
  // Breaks when the intent code runs for every arm: the grok control prompt would change.
  const s = intentSetup(t);
  for (const arm of ['grok', 'composer', 'xhigh']) await authorGroup('S18', { ...s.opts, arm, retry: true }, s.deps);
  assert.equal(s.state.runs.length, 3);
  for (const spec of s.state.runs) assert.ok(!/meant to do/.test(promptOf(spec)));
  assert.equal(s.gh.calls.length, 0);
});

// ---------- the intent prompt template ----------

const benchFile = (name) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
const between = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);

test('author-prompt-intent.md keeps the rules, schema and output format of author-prompt.md and adds the intent section', () => {
  // Breaks when one template is edited alone: the intent arm would be graded on a different task than the control.
  const plain = benchFile('author-prompt.md');
  const intent = benchFile('author-prompt-intent.md');
  assert.equal(between(intent, '## Rules', '## The change'), between(plain, '## Rules', '## The change'));
  assert.ok(intent.includes('You have about 20 minutes.'));
  assert.match(intent, /## What the change is meant to do\n[\s\S]*\{intentTitle\}[\s\S]*\{intentBody\}/);
  for (const line of [
    'Test what the change is meant to do, not what the code happens to output.',
    'Assume the change may contain a bug.',
    'Aim each flow at an edge case or a promise in the description that the code might break.',
    'Do not assert exact message text that this change itself adds or rewords; assert behaviour (exit code, decision, file state, presence of a key fact).',
    'A flow must pass on a correct implementation of the description.',
  ]) assert.ok(intent.includes(line), line);
});

test('the plain template has no intent variable, and renderPrompt never fills a value again', () => {
  assert.ok(!/intentTitle|intentBody/.test(benchFile('author-prompt.md')));
  assert.equal(renderPrompt('{ref} {intentTitle}|{intentBody}', { ref: 'r', intentTitle: 'T', intentBody: '{ref}' }), 'r T|{ref}');
});
