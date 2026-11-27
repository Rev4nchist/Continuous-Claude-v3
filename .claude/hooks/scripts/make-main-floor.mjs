// Card coord-guard-deny-floor, true floor (Dave 11-27, seat ruling 10:01 and 10:03). Writes src/main-floor/: a copy of main's decision-gate.ts and every local module it imports,
// taken from one commit of main with git show. The only changes: the import paths, one no-op writer for the guard log, and the removal of the auto-run block.
// The manifest (src/main-floor/MANIFEST.json) records, per file, the sha256 of main's text and the exact edits, so a test can prove "the copy is main's file plus these edits"
// without git. Run: node scripts/make-main-floor.mjs [--ref <commit>]   (from .claude/hooks of the primary checkout or a worktree; needs the commit in the local repo)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REF = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : '6c3e71a544d4bec6f43249b86de4c86fd5f37075';
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const ROOT = join(HOOKS, '..', '..').replace(/\\/g, '/');
const DEST = `${HOOKS}/src/main-floor`;
const SRC = '.claude/hooks/src/';
const sha = (t) => createHash('sha256').update(t).digest('hex');
const show = (p) => {
  const r = spawnSync('git', ['show', `${REF}:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git show ${REF}:${p} failed: ${r.stderr}`);
  return r.stdout.replace(/\r\n/g, '\n');
};
const once = (text, find, replace, file) => {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`${file}: expected exactly one "${find.slice(0, 70)}", found ${n}`);
  return { text: text.replace(find, () => replace), edit: { find, replace } };
};

// The closure of the local imports of decision-gate.ts at REF (computed once with git show; guard-log.ts is not imported by the copy: its two calls become no-ops).
const MODULES = [
  'pr-opened-review-loop.ts', 'decision-gate.ts',
  'shared/checkpoint-shapes.ts', 'shared/answer-paths-door.ts', 'shared/decisions-store.ts', 'shared/holdout-ids.ts', 'shared/git-call.ts',
  'shared/inert-quotes.ts', 'shared/mask-quotes.ts', 'shared/router-config.ts', 'shared/shell-tools.ts', 'shared/shell-ast.ts', 'shared/shell-judge.ts',
  'shared/tap-scope.ts', 'shared/gh-open-prefix.ts', 'shared/doc-heredoc.ts',
];
const LIBS = ['repo-identity.mjs', 'answer-key.mjs', 'decisions.mjs', 'holdout-ids.mjs', 'file-lock.mjs'];
const files = [];
for (const m of MODULES) files.push({ main: SRC + m, copy: m });
for (const l of LIBS) files.push({ main: `scripts/github/lib/${l}`, copy: `lib/${l}` });
files.push({ main: SRC + 'shell-ast-walk.ps1', copy: 'shell-ast-walk.ps1' }); // the walker the parser reads next to its file (src mode); copied as is

const manifest = { ref: REF, note: 'Copy of main decision-gate.ts and its local imports. Only the listed edits differ from main. Checked by __tests__/main-floor-copy.test.ts.', files: [] };
for (const f of files) {
  let text = show(f.main);
  const edits = [];
  const apply = (find, replace) => { const r = once(text, find, replace, f.main); text = r.text; edits.push(r.edit); };
  const libImport = text.match(/'((?:\.\.\/)+scripts\/github\/lib\/([a-z-]+\.mjs))'/g) ?? [];
  for (const q of libImport) {
    const name = q.match(/lib\/([a-z-]+\.mjs)/)[1];
    const depth = posix.dirname(f.copy) === '.' ? './lib/' : '../lib/';
    apply(q, `'${depth}${name}'`);
  }
  if (f.copy === 'decision-gate.ts') {
    apply("import { logGuardDecision, logGuardError } from './shared/guard-log.js';",
      "const logGuardDecision = (..._args: unknown[]): void => undefined; // main-floor: no guard log write (the head writes its own row)\nconst logGuardError = (..._args: unknown[]): void => undefined; // main-floor: no guard log write");
    const auto = text.match(/\/\/ Auto-run only as a hook; VITEST imports the pure functions above\.\nif \(!process\.env\.VITEST\) \{\n[\s\S]*?\n\}\n?$/);
    if (!auto) throw new Error('auto-run block not found');
    apply(auto[0], '// main-floor: the auto-run block of main is removed (the floor is imported, never run as a hook)\nexport { main as floorMainNeverCalled };\n');
  }
  const out = `${DEST}/${f.copy}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  manifest.files.push({ main: f.main, copy: f.copy, sha256Main: sha(show(f.main)), edits });
}
writeFileSync(`${DEST}/MANIFEST.json`, JSON.stringify(manifest, null, 1) + '\n');
console.log(`main-floor written: ${files.length} files at ${REF}`);
