#!/usr/bin/env node
// V7.10 check: does a head that is the GO head plus one merge of fork/main keep the seat's GO? (card coord-v710-merge-check)
//   node scripts/coordination/v710-check.mjs --go <GO head> --new <new head> [--files a,b]
// Exit 0 = the GO stays. 1 = the seat must read the head. 2 = a usage or git error.
//
// The new head must be a merge of exactly two parents. Its first parent is the GO head. Its second parent is an ancestor of
// refs/remotes/fork/main (no fetch here: run `git fetch fork` first). A style commit between the GO head and the merge fails this
// on purpose: the seat reads it.
// Check 1 (own lines): the branch's own +/- lines on the card files, before the merge (merge-base of the GO head and the second
//   parent, to the GO head) and after it (the second parent, to the new head). Equal lines keep the GO. Main touching a card file
//   in another place changes neither list. The old command, `git diff <GO> <new> -- <files>`, fails there by its letter.
// Check 2 (names): `git diff --name-only fork/main...<new>` lists only card files and their dist files. A hook source card file
//   .claude/hooks/src/<name>.ts has the dist files .claude/hooks/dist/<name>.mjs and .claude/hooks/dist/.build-inputs.json.
// --files defaults to the name-only list itself, so check 2 then passes by construction: pass the card files to make it bite.
// Read-only: it changes nothing.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORK_MAIN = 'refs/remotes/fork/main';
const SHOW_MAX = 60;

class GitError extends Error {}

const unique = (xs) => [...new Set(xs)];
const linesOf = (text) => text.split(/\r?\n/).filter(Boolean);

/** The dist files of a hook source card file: dist/<name>.mjs and dist/.build-inputs.json. Other files have none. */
export function distOf(file) {
  const m = /^\.claude\/hooks\/src\/(?:.*\/)?([^/]+)\.ts$/.exec(file);
  return m ? [`.claude/hooks/dist/${m[1]}.mjs`, '.claude/hooks/dist/.build-inputs.json'] : [];
}

/** The own +/- lines of a `git diff -U0` text, each tagged with its file. Lines before the first @@ of a file (headers) are skipped. */
export function ownLines(diff) {
  const out = [];
  let file = '';
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) { file = head[2]; inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk && (line.startsWith('+') || line.startsWith('-'))) out.push(`${file}\t${line}`);
  }
  return out;
}

function makeGit(cwd) {
  return (args, { okStatus = [0] } = {}) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (r.error || !okStatus.includes(r.status)) throw new GitError(`git ${args[0]} failed: ${String(r.stderr || r.error?.message || '').split('\n')[0]}`);
    return { status: r.status, stdout: r.stdout };
  };
}

const commitOf = (git, rev) => git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).stdout.trim();

/** The refusals of the merge shape: not two parents, first parent not the GO head, second parent not on fork/main. Empty when the shape holds. */
function shapeProblems(git, go, head) {
  const parents = git(['rev-list', '--parents', '-n', '1', head]).stdout.trim().split(/\s+/).slice(1);
  if (parents.length !== 2) return { problems: [`FAIL shape: ${head.slice(0, 8)} is not a merge of two parents (${parents.length} parent(s))`] };
  const [first, second] = parents;
  const problems = [];
  if (first !== go) problems.push(`FAIL shape: the first parent ${first.slice(0, 8)} is not the GO head ${go.slice(0, 8)}: a commit between them needs a seat read`);
  const onMain = git(['merge-base', '--is-ancestor', second, FORK_MAIN], { okStatus: [0, 1] }).status === 0;
  if (!onMain) problems.push(`FAIL shape: the second parent ${second.slice(0, 8)} is not an ancestor of fork/main`);
  return { problems, second };
}

/** Check 2: the names the merge brings against fork/main are card files or their dist files. */
function namesCheck(git, head, files) {
  const names = linesOf(git(['diff', '--name-only', `${FORK_MAIN}...${head}`]).stdout);
  const card = files ?? names;
  const allowed = new Set([...card, ...card.flatMap(distOf)]);
  const extra = names.filter((n) => !allowed.has(n));
  const line = extra.length ? `FAIL check 2 (names): not card files: ${extra.join(', ')}` : `PASS check 2 (names): ${names.length} file(s), all card files or their dist files`;
  return { ok: extra.length === 0, line, allowed: [...allowed] };
}

/** Check 1: the branch's own lines on the card files, before and after the merge. */
function ownLinesCheck(git, go, head, second, paths) {
  const base = git(['merge-base', go, second]).stdout.trim();
  const diff = (a, b) => ownLines(git(['diff', '-U0', '--no-color', '--no-ext-diff', a, b, '--', ...paths]).stdout);
  const before = diff(base, go);
  const after = diff(second, head);
  if (before.length === after.length && before.every((l, i) => l === after[i])) return { ok: true, lines: [`PASS check 1 (own lines): ${before.length} line(s) equal before and after the merge`] };
  const show = (tag, xs) => [`  ${tag} (${xs.length}):`, ...xs.slice(0, SHOW_MAX).map((l) => `    ${l}`), ...(xs.length > SHOW_MAX ? [`    ... ${xs.length - SHOW_MAX} more`] : [])];
  return { ok: false, lines: [`FAIL check 1 (own lines): the merge changed the branch's own lines`, ...show('before the merge', before), ...show('after the merge', after)] };
}

/** { exitCode, lines }: 0 keeps the GO, 1 needs a seat read, 2 is a usage or git error. */
export function v710Check({ cwd, go, head, files }) {
  const git = makeGit(cwd);
  try {
    const goSha = commitOf(git, go);
    const headSha = commitOf(git, head);
    git(['rev-parse', '--verify', '--quiet', FORK_MAIN]);
    const shape = shapeProblems(git, goSha, headSha);
    if (shape.problems.length) return { exitCode: 1, lines: [...shape.problems, 'V7.10: the seat must read this head'] };
    const names = namesCheck(git, headSha, files);
    const own = ownLinesCheck(git, goSha, headSha, shape.second, names.allowed);
    const ok = names.ok && own.ok;
    return { exitCode: ok ? 0 : 1, lines: [own.lines, names.line, ok ? 'V7.10: the GO stays' : 'V7.10: the seat must read this head'].flat() };
  } catch (err) {
    return { exitCode: 2, lines: [`v710-check: ${err.message}`] };
  }
}

function parseArgs(argv) {
  const opts = { go: null, head: null, files: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--go') opts.go = argv[(i += 1)] ?? null;
    else if (argv[i] === '--new') opts.head = argv[(i += 1)] ?? null;
    else if (argv[i] === '--files') opts.files = unique(String(argv[(i += 1)] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!opts.go || !opts.head) throw new Error('usage: v710-check.mjs --go <GO head> --new <new head> [--files a,b]');
  return opts;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`v710-check: ${err.message}`); process.exit(2); }
  const r = v710Check({ cwd: process.cwd(), ...opts });
  for (const l of r.lines) console.log(l);
  process.exit(r.exitCode);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main();
