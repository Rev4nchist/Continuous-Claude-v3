// Tests for scripts/checks/cli-smoke.mjs. The run tests spawn real node processes on temp scripts.
// Run: node --test scripts/checks/cli-smoke.test.mjs
//
// How the unit can fail, and the test that catches it:
//   a script that reads argv at top level is not a candidate (or a library is)   -> S1  (change readsArgvAtTop or the shebang check)
//   a test file, a file outside scripts/, or a missing file is run               -> S2  (drop a filter in isCandidateFile)
//   a crash is read as a pass, or a usage exit is read as a fail                 -> S3  (change classify)
//   a hang is not killed, or a timeout counts as a failure                       -> S4  (drop the timeout, or count TIMEOUT in failed)
//   the child sees the real HOME or cwd, or gets a mutating flag                 -> S5  (drop the sandbox env or the cwd)
//   the CLI exit code does not follow the verdicts                               -> S6  (flip the exit rule)
//   a script writes next to itself and changes the real checkout                 -> S9  (spawn path.join(root, rel) instead of the copy)
//   argv read in an arrow chain or after a multi-line template is missed         -> S1b (test the whole line for =>, drop the template state)
//   an ENOENT that names a path outside the arg counts as an argv error         -> S3b (use stderr.includes(arg))
//   a relative --root points the child at a path that does not exist             -> S8  (drop path.resolve in runSmoke)
//   the pre-fix remove-maestro script passes, or the fixed one fails             -> S7  (the real E2E: commits 2aabe283 and 574eb221)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidates, classify, readsArgvAtTop, runSmoke } from './cli-smoke.mjs';

const CLI = fileURLToPath(new URL('./cli-smoke.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Makes a temp tree. files: { 'scripts/a.mjs': 'source' }. */
function tree(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), src);
  }
  return root;
}

const withTree = (files, fn) => {
  const root = tree(files);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('S1: top-level argv reads and shebangs are candidates; argv inside a function is not', () => {
  assert.equal(readsArgvAtTop("const f = process.argv[2] || 'x';\n"), true);
  assert.equal(readsArgvAtTop("if (isMain()) {\n  process.exitCode = main(process.argv.slice(2));\n}\n"), true);
  assert.equal(readsArgvAtTop("function main() {\n  const a = process.argv[2];\n}\n"), false);
  assert.equal(readsArgvAtTop("export const run = () => {\n  return process.argv;\n};\n"), false);
  assert.equal(readsArgvAtTop("// uses process.argv later\nconst s = 'process.argv';\n/* process.argv */\n"), false);
  assert.equal(readsArgvAtTop("export function f() {\n  if (x) {\n    return process.argv;\n  }\n}\n"), false);
  assert.equal(readsArgvAtTop("export const x = 1;\n"), false);
});

test('S1b: an arrow chain on the argv line and a multi-line template before the read do not hide the read', () => {
  assert.equal(readsArgvAtTop("const a = process.argv.slice(2).filter((x) => x !== '');\n"), true);
  assert.equal(readsArgvAtTop("const a = () => process.argv[2];\n"), false);
  assert.equal(readsArgvAtTop('const t = `\nfoo = {\n`;\nconst a = process.argv[2];\n'), true);
  assert.equal(readsArgvAtTop('const t = `\n process.argv \n`;\n'), false);
});

test('S2: only changed non-test scripts/**.mjs files that are CLIs are candidates', () => {
  withTree({
    'scripts/shebang.mjs': '#!/usr/bin/env node\nexport const x = 1;\n',
    'scripts/argv.mjs': 'const a = process.argv[2];\n',
    'scripts/lib.mjs': 'export const x = 1;\n',
    'scripts/argv.test.mjs': 'const a = process.argv[2];\n',
    'tools/argv.mjs': 'const a = process.argv[2];\n',
    'scripts/argv.js': 'const a = process.argv[2];\n',
  }, (root) => {
    const files = ['scripts\\shebang.mjs', './scripts/argv.mjs', 'scripts/lib.mjs', 'scripts/argv.test.mjs', 'tools/argv.mjs', 'scripts/argv.js', 'scripts/gone.mjs', 'scripts/argv.mjs'];
    assert.deepEqual(candidates(root, files), ['scripts/shebang.mjs', 'scripts/argv.mjs']);
  });
});

test('S3: classify follows the contract', () => {
  const frame = "node:fs:440\nError: ENOENT: no such file or directory, open '--help'\n    at readFileSync (node:fs:441:20)\n    at file:///C:/x/a.mjs:4:6\n";
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: frame }).verdict, 'FAIL');
  assert.equal(classify({ args: [], exit: 1, stderr: 'usage: a.mjs <file>\n' }).verdict, 'PASS');
  assert.equal(classify({ args: [], exit: 2, stderr: 'bad argument\n' }).verdict, 'PASS');
  assert.equal(classify({ args: [], exit: 0, stderr: '    at x (a.mjs:1:1)\n' }).verdict, 'PASS');
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: "error: ENOENT '--help' not found\n" }).verdict, 'FAIL');
  assert.equal(classify({ args: [], exit: 1, stderr: 'error: ENOENT: settings.json missing\n' }).verdict, 'PASS');
  assert.equal(classify({ args: [], exit: 1, stderr: 'SyntaxError: bad\n\nNode.js v22.13.1\n' }).verdict, 'FAIL');
  assert.equal(classify({ args: [], exit: null, timedOut: true, stderr: '' }).verdict, 'TIMEOUT');
  assert.equal(classify({ args: [], exit: null, spawnError: 'EPERM', stderr: '' }).verdict, 'FAIL');
});

test('S3b: an ENOENT counts only when the argument is inside the path the message names', () => {
  const enoent = (p) => `Error: ENOENT: no such file or directory, open '${p}'`;
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: enoent('C:/x/--help') }).verdict, 'FAIL');
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: enoent('--help') }).verdict, 'FAIL');
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: "ENOENT: no such file, open 'foo.json' (try --help)\n" }).verdict, 'PASS');
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: "ENOENT: open 'foo.json'\nusage: --help shows this\n" }).verdict, 'PASS');
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: 'EISDIR: illegal operation on a directory, read\n' }).verdict, 'PASS');
  assert.equal(classify({ args: ['a.b'], exit: 1, stderr: enoent('C:/x/aXb') }).verdict, 'PASS', 'a dot in the argument is not a wildcard');
});

test('S4: a script that never ends is killed and is a TIMEOUT fact, not a failure', () => {
  withTree({ 'scripts/hang.mjs': "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n" }, (root) => {
    const r = runSmoke({ root, files: ['scripts/hang.mjs'] }, { timeoutMs: 600 });
    assert.equal(r.failed, 0);
    assert.equal(r.timeouts, 1);
    assert.equal(r.checked, 1);
    assert.equal(r.results[0].verdict, 'TIMEOUT');
    assert.equal(r.results[0].runs[0].verdict, 'TIMEOUT');
    assert.match(r.results[0].runs[0].reason, /^timeout/);
    assert.equal(r.results[0].runs[0].exit, null);
  });
});

test('S4b: a crash on one run and a timeout on the other is a FAIL (breaks if TIMEOUT hides a FAIL)', () => {
  const src = "#!/usr/bin/env node\nif (process.argv[2] === '--help') throw new Error('boom');\nsetInterval(() => {}, 1000);\n";
  withTree({ 'scripts/both.mjs': src }, (root) => {
    const r = runSmoke({ root, files: ['scripts/both.mjs'] }, { timeoutMs: 600 });
    assert.deepEqual([r.failed, r.timeouts, r.results[0].verdict], [1, 0, 'FAIL']);
  });
});

test('S5: the child runs in the sandbox on a copy of the tree, gets only --help and no args, and writes nothing into the root', () => {
  const probe = [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "import os from 'node:os';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const here = path.dirname(fileURLToPath(import.meta.url));",
    "fs.writeFileSync(new URL('../out.txt', import.meta.url), 'x');",
    'console.error(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), here, home: os.homedir(), profile: process.env.USERPROFILE,',
    '  appdata: process.env.APPDATA, local: process.env.LOCALAPPDATA, key: process.env.ANTHROPIC_API_KEY ?? null,',
    "  settings: fs.readFileSync(os.homedir() + '/.claude/settings.json', 'utf8').trim() }));",
    '',
  ].join('\n');
  withTree({ 'scripts/probe.mjs': probe }, (root) => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    let r;
    try {
      r = runSmoke({ root, files: ['scripts/probe.mjs'] });
      assert.equal(r.failed, 0, JSON.stringify(r));
    } finally { delete process.env.ANTHROPIC_API_KEY; }
    assert.ok(!existsSync(path.join(root, 'out.txt')), 'the script wrote into the real tree');
    const seen = r.results[0].runs.map((run) => JSON.parse(run.stderr.at(-1)));
    assert.deepEqual(seen.map((x) => x.argv), [['--help'], []]);
    for (const x of seen) {
      assert.match(path.basename(x.cwd), /^cli-smoke-/);
      assert.notEqual(path.resolve(x.cwd), path.resolve(root));
      assert.ok(!path.resolve(x.here).startsWith(path.resolve(root)), 'the script ran from the real tree: ' + x.here);
      assert.equal(x.home, x.cwd);
      assert.equal(x.profile, x.cwd);
      assert.ok(x.appdata.startsWith(x.cwd) && x.local.startsWith(x.cwd));
      assert.equal(x.key, null);
      assert.equal(x.settings, '{"hooks":{}}');
    }
  });
});

test('S6: the CLI exits 1 on a FAIL, 0 on a PASS, 2 on bad usage', () => {
  withTree({
    'scripts/bad.mjs': "#!/usr/bin/env node\nthrow new Error('boom');\n",
    'scripts/good.mjs': "#!/usr/bin/env node\nconsole.log('usage: good.mjs');\n",
  }, (root) => {
    const run = (files) => spawnSync(process.execPath, [CLI, '--root', root, '--files', files], { encoding: 'utf8', windowsHide: true });
    const bad = run('scripts/bad.mjs');
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).results[0].runs[0].verdict, 'FAIL');
    const good = run('scripts/good.mjs');
    assert.equal(good.status, 0);
    assert.equal(JSON.parse(good.stdout).checked, 1);
    assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8', windowsHide: true }).status, 2);
  });
  withTree({ 'scripts/hang.mjs': '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n' }, (root) => {
    const hang = spawnSync(process.execPath, [CLI, '--root', root, '--files', 'scripts/hang.mjs', '--timeout-ms', '600'], { encoding: 'utf8', windowsHide: true });
    assert.equal(hang.status, 0, 'a timeout is a fact, not a failure');
    assert.equal(JSON.parse(hang.stdout).timeouts, 1);
  });
});

test('S7: E2E - remove-maestro-registrations.mjs FAILS before the fix (2aabe283) and PASSES after it (574eb221)', (t) => {
  const rel = 'scripts/settings/remove-maestro-registrations.mjs';
  const show = (sha) => spawnSync('git', ['-C', REPO, 'show', `${sha}:${rel}`], { encoding: 'utf8', windowsHide: true });
  const pre = show('2aabe283');
  const post = show('574eb221');
  if (pre.status !== 0 || post.status !== 0) return t.skip('commits 2aabe283 or 574eb221 are not in this clone');
  withTree({ [rel]: pre.stdout }, (root) => {
    const r = runSmoke({ root, files: [rel] });
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.equal(r.results[0].runs[0].verdict, 'FAIL');
    assert.match(r.results[0].runs[0].stderr.join('\n'), /ENOENT/);
  });
  withTree({ [rel]: post.stdout }, (root) => {
    const r = runSmoke({ root, files: [rel] });
    assert.equal(r.failed, 0, JSON.stringify(r));
    assert.equal(r.checked, 1);
  });
});

test('S9: a script that writes beside itself and up the tree leaves the real tree unchanged (breaks if the child runs at path.join(root, rel))', () => {
  const src = [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "fs.writeFileSync(new URL('./side.txt', import.meta.url), 'x');",
    "fs.writeFileSync(new URL('../root.txt', import.meta.url), 'x');",
    "fs.appendFileSync(new URL('../package.json', import.meta.url), ' ');",
    '',
  ].join('\n');
  withTree({ 'scripts/writer.mjs': src, 'package.json': '{"type":"module"}\n' }, (root) => {
    const r = runSmoke({ root, files: ['scripts/writer.mjs'] });
    assert.equal(r.failed, 0, JSON.stringify(r));
    assert.equal(r.checked, 1);
    assert.ok(!existsSync(path.join(root, 'scripts', 'side.txt')) && !existsSync(path.join(root, 'root.txt')));
    assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), '{"type":"module"}\n');
    assert.equal(typeof r.copyMs, 'number');
  });
});

test('S9b: the copy keeps what a script reads (root files, .claude, docs, sibling imports) and leaves node_modules, .claude/cache and .claude/worktrees out', () => {
  const main = [
    '#!/usr/bin/env node',
    "import { ok } from './lib/dep.mjs';",
    "import fs from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    "const has = (rel) => fs.existsSync(fileURLToPath(new URL(rel, import.meta.url)));",
    "console.error(JSON.stringify({ ok, nm: has('./node_modules'), pkg: has('../package.json'), rootCfg: has('../router.config.json'), tmpl: has('../.claude/settings.json.template'), docs: has('../docs/a.md'), cache: has('../.claude/cache/big.txt'), wt: has('../.claude/worktrees/w/x.txt') }));",
    '',
  ].join('\n');
  withTree({
    'package.json': '{"type":"module"}\n',
    'router.config.json': '{}\n',
    '.claude/settings.json.template': '{}\n',
    '.claude/cache/big.txt': 'x',
    '.claude/worktrees/w/x.txt': 'x',
    'docs/a.md': 'x',
    'scripts/lib/dep.mjs': 'export const ok = 1;\n',
    'scripts/node_modules/x/index.mjs': 'export const big = 1;\n',
    'scripts/main.mjs': main,
  }, (root) => {
    const r = runSmoke({ root, files: ['scripts/main.mjs'] });
    assert.equal(r.failed, 0, JSON.stringify(r));
    assert.deepEqual(JSON.parse(r.results[0].runs[0].stderr.at(-1)), { ok: 1, nm: false, pkg: true, rootCfg: true, tmpl: true, docs: true, cache: false, wt: false });
  });
});

test('S8: a relative root works, because the child runs in another cwd', () => {
  withTree({ 'scripts/ok.mjs': "#!/usr/bin/env node\nconsole.log('usage');\n" }, (root) => {
    const before = process.cwd();
    process.chdir(path.dirname(root));
    try {
      const r = runSmoke({ root: path.basename(root), files: ['scripts/ok.mjs'] });
      assert.deepEqual([r.checked, r.failed], [1, 0], JSON.stringify(r));
    } finally { process.chdir(before); }
  });
});

// Fails when a missing npm package (absent from the sandbox copy) is a FAIL, or a missing relative module is not.
test('S10: a missing bare package is an ENV fact; a missing relative module stays a FAIL', () => {
  const bare = "node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from C:\t\scripts\a.mjs\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\n";
  const scoped = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@types/x' imported from /t/a.mjs\n    at x (node:internal/a:1:1)\n";
  const rel = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\t\scripts\b.mjs' imported from C:\t\scripts\a.mjs\n    at finalizeResolution (node:internal/modules/esm/resolve:265:11)\n";
  assert.equal(classify({ args: ['--help'], exit: 1, stderr: bare }).verdict, 'ENV');
  assert.equal(classify({ args: [], exit: 1, stderr: scoped }).verdict, 'ENV');
  assert.equal(classify({ args: [], exit: 1, stderr: rel }).verdict, 'FAIL');
});

// Fails when a semgrep rule fixture (wrong on purpose, marked "// ruleid:") is smoked.
test('S11: semgrep rule fixtures are not smoke candidates', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'smoke-s11-'));
  try {
    mkdirSync(path.join(root, 'scripts', 'ratchets', 'semgrep-ccv3'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'ratchets', 'semgrep-ccv3', 'fx.mjs'), "import fs from 'node:fs';\n// ruleid: some-rule\nfs.readFileSync(process.argv[2]);\n");
    writeFileSync(path.join(root, 'scripts', 'cli.mjs'), "#!/usr/bin/env node\nconsole.log(process.argv[2]);\n");
    assert.deepEqual(candidates(root, ['scripts/ratchets/semgrep-ccv3/fx.mjs', 'scripts/cli.mjs']), ['scripts/cli.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
