#!/usr/bin/env node
/**
 * app-ask.mjs: the offer writer of the tap gate for a COVERED app repo (card coord-decision-gate-app-repos, section 3 T-A).
 * It builds the AskUserQuestion spec of one action and writes the offer to the decision store, so the AskUserQuestion hook can record Dave's tap.
 * ship-ask.mjs does the same for CCv3 only; this script refuses a CCv3 checkout. Tests: scripts/github/app-ask.test.mjs.
 *
 * Usage: node scripts/github/app-ask.mjs <push|open-pr|merge> [--dir D] [--remote R] [--branch B] [--src S] [--base B] [--pr N] [--json]
 *   push     [--remote R] [--branch B] [--src S]: store step `ship`, key repo@B, head = the commit of S, tree = the index tree (`git write-tree`)
 *            when S is the checked-out HEAD and files are staged, else the tree of S. B is the DESTINATION branch the push updates; S is the
 *            source ref (default: HEAD for the current branch, else B). A Push only offer is written even when nothing is ahead.
 *   open-pr  [--remote R] [--branch B] [--base B]: store step `open-pr`, key repo@branch (plus :base with --base B, fix round 5 F8:
 *            lib/repo-identity.mjs openPrKey, the rule the gate reads), head = the branch tip, no tree.
 *   merge    --pr N [--remote R]: store step `land`, key repo#N, head = the PR head sha (gh pr view N -R repo). A draft or a closed PR is refused.
 *   --dir    the folder of the checkout (default: the cwd). --json prints the spec only ({ header, question, options }), to pass to AskUserQuestion.
 * Key repo: ONE rule with the decision gate, in lib/repo-identity.mjs (pushKey, ghKey), over the same git questions.
 *   push     the push URLs of the remote (every pushurl; two repos: refused). The remote is --remote R (a remote name, resolved by git first,
 *            or a URL or path), else the remote of @{push}. With neither: exit 1, name the remote. A push with no --branch updates the branch
 *            of @{push} when the push goes to that remote (push.default=upstream), else the current branch.
 *   open-pr, merge   the FETCH URL of the remote (gh reads it): --remote R, else the remote of @{push}, else the only remote.
 *   A URL with no github.com slug: the github field of the registry entry when the URL's owner/repo equals it (an SSH host alias), else
 *   `local:<registry entry key>:<target>` (push only; gh cannot take it with -R).
 * Test seam: --facts f.json (merge only, the gh facts) needs APP_ASK_TEST=1 and CCV3_DECISIONS_FILE set to a store under the temp folder
 *   that is not the real store (compared by real path, case-folded on Windows). Otherwise it is ignored with one warning on stderr and gh runs.
 * Every value that comes from a repo (branch, remote, URL, base, PR title) is made one plain line and clipped (oneLine), in the question, the
 * descriptions and the messages. The key keeps the raw branch. The last question line is `State: ...` and holds shas, counts and the PR number only.
 * Exit 0 = the offer is written and the spec printed. 1 = no question can be asked (the reason is on stderr, nothing written). 2 = bad usage. 3 = internal error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS_ENV, decisionKey, decisionsPath, offerWrite } from './lib/decisions.mjs';
import { fetchKey, ghRemote, needsGithubField, normPath, oneLine, openPrKey, pushKey, remoteNames, repoSlug, stripCredentials } from './lib/repo-identity.mjs';

const CCV3_SLUG = 'rev4nchist/continuous-claude-v3';
const RECOMMENDED = ' (Recommended)';
const NOT_NOW = 'Not now';
/** The store step of each sub-command. */
export const STORE_STEP = Object.freeze({ push: 'ship', 'open-pr': 'open-pr', merge: 'land' });
const FLAGS = { push: ['dir', 'remote', 'branch', 'src'], 'open-pr': ['dir', 'remote', 'branch', 'base'], merge: ['dir', 'remote', 'pr', 'facts'] };

/** A reason that no question can be asked: exit 1. */
class Refuse extends Error {}

const plain = (v, n = 60) => oneLine(v, n);
/** Seat review 1, item 2: a remote as it is shown or stored (question, offer, stdout, refusal): no user or token part, one plain line. */
const rem = (v, n = 60) => plain(stripCredentials(v), n);
const short = (sha) => String(sha ?? '').slice(0, 7);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const opt = (label, description, first = false) => ({ label: `${label}${first ? RECOMMENDED : ''}`, description });
const notNow = () => opt(NOT_NOW, 'Nothing runs.');

// ---------- the specs: pure ----------

/** push. data: { repo, branch, remote, head, tree, staged, ahead }. staged > 0 offers Commit and push; else Push only. */
export function pushSpec({ repo, branch, remote, head, tree, staged, ahead }) {
  const where = `${plain(branch)} to ${rem(remote)} (${plain(repo, 80)})`;
  const ready = staged > 0;
  const first = ready ? `Commit ${plural(staged, 'file')} on ${plain(branch)} and push to ${rem(remote)} (${plain(repo, 80)})?` : `Push ${where}? Nothing is staged.`;
  const state = `State: HEAD ${short(head)}, tree ${short(tree)}, ${plural(ahead, 'commit')} not on the remote.`;
  const go = ready ? opt('Commit and push', 'Commits the staged files, then pushes this branch. The tap binds this tree.', true) : opt('Push only', 'No commit is made. The tap binds the tree of the pushed ref.', true);
  return { header: 'App push', question: [first, state].join('\n'), options: [go, notNow()] };
}

/** open-pr. data: { repo, branch, base, head }. */
export function openPrSpec({ repo, branch, base, head }) {
  const into = base ? ` into ${plain(base)}` : '';
  const first = `Open a draft PR for ${plain(branch)}${into} on ${plain(repo, 80)}?`;
  const state = `State: branch tip ${short(head)}.`;
  return { header: 'App PR', question: [first, state].join('\n'), options: [opt('Open draft PR', 'Opens a draft PR for this head. The tap binds this head.', true), notNow()] };
}

/** merge. data: { repo, pr, head, title }. The first label is not marked Recommended: no READY or CI check backs this merge. */
export function mergeSpec({ repo, pr, head, title }) {
  const first = `Merge PR #${pr} "${plain(title, 80)}" in ${plain(repo, 80)}?`;
  const state = `State: PR #${pr} is open, not a draft, head ${short(head)}.`;
  const go = opt('Merge now (no READY check)', 'Merges this head only. Add --merge, --squash or --rebase to the gh command. No pre-pr, CI, review or READY check runs: the tap is the only gate.');
  return { header: 'App merge', question: [first, state].join('\n'), options: [go, notNow()] };
}

/** The next step the model runs after the tap. It always names the repo and the head. */
export const mergeNext = ({ repo, pr, head }) => `gh pr merge ${pr} -R ${repo} --match-head-commit ${head}`;

// ---------- git: one runner per folder, the shape of the gate's Deps git ----------

/** git in one folder: (args) -> { status, stdout }, as repo-identity.mjs and the gate read it. */
const runnerOf = (dir) => (args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};
const outOf = (git, args) => {
  const r = git(args);
  return r && r.status === 0 ? String(r.stdout ?? '').trim() : null;
};
const remotesText = (git) => plain(remoteNames(git).join(', ') || 'none', 120);

// ---------- the registry entry of the checkout ----------

const slugOfName = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isAbs = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p);
/** normPath of the real path; a network path (// or \\) is never resolved: a sync call there has no time limit (as tap-scope.ts). */
function realNorm(p) {
  if (/^\/\//.test(normPath(p))) return normPath(p);
  try { return normPath(realpathSync.native(p)); } catch { return normPath(p); }
}

/** The roots to try, in order: the toplevel, then the main root of a worktree. */
function rootsOf(git) {
  const top = outOf(git, ['rev-parse', '--show-toplevel']);
  const common = outOf(git, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return [top, common && path.basename(common) === '.git' ? path.dirname(common) : null].filter(Boolean);
}

function registryEntries(env) {
  const file = env.LANE_REGISTRY_PATH || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude', 'project-registry.json');
  let projects;
  try { projects = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).projects; } catch { return []; }
  if (!Array.isArray(projects)) return [];
  return projects.filter((e) => e && typeof e === 'object' && typeof e.path === 'string' && isAbs(e.path))
    .map((e) => ({ key: typeof e.key === 'string' && e.key ? e.key : slugOfName(e.name), github: typeof e.github === 'string' ? e.github : null, raw: e.path, root: normPath(e.path) }))
    .filter((e) => e.key);
}

/**
 * { key, github } of the first registry entry whose root EQUALS a root of the checkout (toplevel first, then the main root), folded by the
 * normPath of tap-scope.ts: the raw spelling first, then the real path. Null when none.
 */
export function registryEntry(dir, env = process.env) {
  const entries = registryEntries(env);
  if (entries.length === 0) return null;
  for (const root of rootsOf(runnerOf(dir))) {
    const spellings = [normPath(root), realNorm(root)];
    const hit = entries.find((e) => spellings.includes(e.root)) ?? entries.find((e) => spellings.includes(realNorm(e.raw)));
    if (hit) return { key: hit.key, github: hit.github };
  }
  return null;
}
/** The key of that entry, or null. */
export const registryEntryKey = (dir, env = process.env) => registryEntry(dir, env)?.key ?? null;

// ---------- the plans: over an injected git (planWith), so a test can run them on the gate's own fake ----------

const PUSH_REFUSAL = {
  'name-remote': () => 'name the remote: pass --remote R. This branch has no @{push} remote.',
  'unknown-remote': (k) => `name the remote: ${rem(k.remote)} is not a remote of this checkout and not a URL.`,
  'no-key': (k) => `remote ${rem(k.remote)} is not a GitHub remote, and this checkout is the root of no registry entry, so the repo has no key.`,
  'multi-pushurl': (k) => `remote ${rem(k.remote)} pushes to more than one repo (${plain(k.keys.join(', '), 160)}); one tap covers one push URL. Push to one URL.`,
  'no-branch': () => 'HEAD is detached: pass --branch B.',
};

/**
 * { head, headTree, ref, isCurrent } of the source of a push or the head of a PR: --src S when given, else HEAD for the current branch, else B.
 * git reads @ as HEAD, so --src @ is the current branch too: its staged files count (fixer F, item 5; the gate reads the index for it).
 */
function sourceOf(git, { src, branch, remote, current }) {
  const name = src ?? branch;
  if (name === 'HEAD' || name === '@' || (current !== '' && name === current)) return { head: outOf(git, ['rev-parse', 'HEAD']), headTree: outOf(git, ['rev-parse', 'HEAD^{tree}']), ref: 'HEAD', isCurrent: true };
  const refs = src !== undefined && src !== null ? [src] : [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`];
  // Seat review 1, item 5: --end-of-options before every ref from the command (rev-parse needs --verify for it: without, it echoes the marker).
  for (const ref of refs) {
    const head = outOf(git, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    if (head) return { head, headTree: outOf(git, ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`]), ref, isCurrent: false };
  }
  throw new Refuse(`the ref ${plain(src ?? branch)} does not exist here. Pass a branch or ref that exists.`);
}

function planPush(git, o, id, current) {
  const k = pushKey(git, { remote: o.remote ?? null, branch: o.branch ?? null, ...id });
  if (!k.ok) throw new Refuse(`${PUSH_REFUSAL[k.why](k)} Remotes here: ${remotesText(git)}.`);
  // No --branch: the push sends HEAD (to the branch of @{push} or the current branch), so its tree is HEAD's, as the gate reads it.
  const src = o.src ?? (o.branch === undefined ? 'HEAD' : undefined);
  const t = sourceOf(git, { src, branch: k.branch, remote: k.remote, current });
  if (!t.head || !t.headTree) throw new Refuse(`the ref ${plain(src ?? k.branch)} has no commit.`);
  const staged = t.isCurrent ? (outOf(git, ['diff', '--cached', '--name-only']) ?? '').split('\n').filter(Boolean).length : 0;
  const scope = remoteNames(git).includes(k.remote) ? `--remotes=${k.remote}` : '--remotes';
  // --not flips the refs after it, so the second --not turns it back before --end-of-options and the ref (git takes no option after the ref).
  const ahead = Number(outOf(git, ['rev-list', '--count', '--not', scope, '--not', '--end-of-options', t.ref]) ?? 0);
  const tree = staged > 0 ? outOf(git, ['write-tree']) : t.headTree;
  if (!tree) throw new Refuse('the index tree could not be read (an unmerged path?).');
  const spec = pushSpec({ repo: k.key, branch: k.branch, remote: k.remote, head: t.head, tree, staged, ahead });
  return { spec, key: decisionKey({ repo: k.key, branch: k.branch }), head: t.head, tree };
}

/** The key repo of open-pr or merge: the fetch URL of --remote R, else of the remote gh reads (repo-identity.mjs ghRemote). */
function ghRepoOf(git, o, id) {
  const remote = o.remote ?? ghRemote(git);
  if (!remote) throw new Refuse(`name the remote: pass --remote R. This branch has no @{push} remote and the checkout has not one remote only. Remotes here: ${remotesText(git)}.`);
  const repo = fetchKey(git, remote, id);
  if (!repo) throw new Refuse(`name the remote: ${rem(remote)} is not a remote of this checkout with a URL. Remotes here: ${remotesText(git)}.`);
  // Fixer G (item 7): an SSH host alias of an entry with no github field has a way out, and it is Dave's: a github field in the entry.
  if (repo.startsWith('local:') && needsGithubField(outOf(git, ['remote', 'get-url', '--end-of-options', remote]) ?? '', id.github)) {
    throw new Refuse(`the registry entry ${plain(id.entryKey ?? '')} needs a github field naming owner/repo: remote ${rem(remote)} is an SSH host alias, so gh has no repo to act on. Tell Dave.`);
  }
  if (repo.startsWith('local:')) throw new Refuse(`${o.sub} needs a GitHub remote: gh cannot take ${plain(repo, 120)} with -R. ${rem(remote)} is not a GitHub remote.`);
  return { repo, remote };
}

function planOpenPr(git, o, id, current) {
  const { repo, remote } = ghRepoOf(git, o, id);
  const branch = o.branch ?? current;
  if (!branch) throw new Refuse('HEAD is detached: pass --branch B.');
  const t = sourceOf(git, { src: undefined, branch, remote, current });
  if (!t.head) throw new Refuse(`branch ${plain(branch)} has no commit.`);
  // Fix round 5 (F8): the key holds the base the PR targets (one rule with the gate, repo-identity.mjs openPrKey).
  return { spec: openPrSpec({ repo, branch, base: o.base, head: t.head }), key: openPrKey({ repo, branch, base: o.base }), head: t.head, tree: null };
}

function planMerge(git, o, id, view) {
  const { repo } = ghRepoOf(git, o, id);
  const f = view(o.pr, repo);
  const head = String(f?.headRefOid ?? '').toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(head)) throw new Refuse(`PR #${o.pr} has no readable head sha.`);
  if (f.isDraft === true) throw new Refuse(`PR #${o.pr} is a draft. A draft PR is not merged.`);
  if (String(f.state).toUpperCase() !== 'OPEN') throw new Refuse(`PR #${o.pr} is ${plain(String(f.state).toLowerCase(), 20)}, not open.`);
  const next = mergeNext({ repo, pr: o.pr, head });
  return { spec: mergeSpec({ repo, pr: o.pr, head, title: f.title }), key: decisionKey({ repo, pr: o.pr }), head, tree: null, next };
}

/**
 * { spec, key, head, tree, next? } for a parsed command (parseArgs), from the git facts of one folder. Throws Refuse.
 * deps: { git: (args) -> { status, stdout } in the folder, entry: { key, github } of its registry entry or null, view: (pr, repo) -> gh facts }.
 */
export function planWith(o, { git, entry = null, view }) {
  const id = { entryKey: entry?.key ?? null, github: entry?.github ?? null };
  const current = outOf(git, ['branch', '--show-current']) ?? '';
  if (o.sub === 'push') return planPush(git, o, id, current);
  if (o.sub === 'open-pr') return planOpenPr(git, o, id, current);
  return planMerge(git, o, id, view);
}

/** The checkout: { dir, top, git, entry }. Refuses a folder that is no checkout and a CCv3 checkout. */
function checkoutOf(o, env) {
  const dir = path.resolve(o.dir ?? process.cwd());
  const git = runnerOf(dir);
  const top = outOf(git, ['rev-parse', '--show-toplevel']);
  if (!top) throw new Refuse(`${plain(dir, 100)} is not a git checkout.`);
  const urls = (outOf(git, ['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']) ?? '').split('\n').map((row) => row.slice(row.indexOf(' ') + 1).trim());
  if (urls.some((u) => repoSlug(u) === CCV3_SLUG)) throw new Refuse('this is a CCv3 checkout. Use node scripts/github/ship-ask.mjs for it, not app-ask.mjs.');
  return { dir, top, git, entry: registryEntry(dir, env) };
}

// ---------- gh and the test seam ----------

/** A path for an equality test: the real path of its nearest existing parent plus the rest, lower case on Windows (NTFS folds case). */
function canonPath(p) {
  const abs = path.resolve(p);
  const rest = [];
  let base = abs;
  for (;;) {
    try {
      const real = path.join(realpathSync.native(base), ...rest);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch {
      const up = path.dirname(base);
      if (up === base) return process.platform === 'win32' ? abs.toLowerCase() : abs;
      rest.unshift(path.basename(base));
      base = up;
    }
  }
}
/** The real store of this account: the home of the account (os.userInfo), not of the env (USERPROFILE, HOME). */
function accountStore() {
  let home;
  try { home = os.userInfo().homedir; } catch { home = os.homedir(); }
  return path.join(home, '.claude', 'state', 'ccv3-mods', 'decisions.json');
}

/**
 * True only when APP_ASK_TEST=1 and CCV3_DECISIONS_FILE names a store that sits under the temp folder and is not the real store, both
 * compared by real path (case-folded on Windows): the account default and the env default (decisionsPath).
 */
export function seamsOn(env = process.env) {
  if (env.APP_ASK_TEST !== '1' || !env[DECISIONS_ENV]) return false;
  const store = canonPath(env[DECISIONS_ENV]);
  if ([accountStore(), decisionsPath({})].some((p) => canonPath(p) === store)) return false;
  const tmp = canonPath(os.tmpdir());
  return store.startsWith(tmp.endsWith(path.sep) ? tmp : `${tmp}${path.sep}`);
}

/** The gh facts of a PR: { headRefOid, state, isDraft, title }. Reads gh; never throws a non-Refuse error for a gh failure. */
function ghView(pr, repo) {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '-R', repo, '--json', 'headRefOid,state,isDraft,title'], { encoding: 'utf8', windowsHide: true });
  try { return JSON.parse(r.stdout); } catch { throw new Refuse(`gh pr view ${pr} -R ${repo} gave no JSON (${plain(r.stderr, 120)}).`); }
}

/** The facts of one PR. --facts is honoured only in test mode (seamsOn); else gh runs. Deps: { env, runGh, warn }. */
export function mergeFactsOf({ facts, pr, repo }, { env = process.env, runGh = ghView, warn = console.error } = {}) {
  if (facts) {
    if (seamsOn(env)) return JSON.parse(readFileSync(facts, 'utf8'));
    warn('app-ask: ignored --facts: it is a test seam and needs APP_ASK_TEST=1 and a temp CCV3_DECISIONS_FILE. gh runs.');
  }
  return runGh(pr, repo);
}

/** { spec, key, head, tree, next?, top } for a parsed command, or throws Refuse. */
export function planOf(o, env = process.env) {
  const c = checkoutOf(o, env);
  const view = (pr, repo) => mergeFactsOf({ facts: o.facts, pr, repo }, { env });
  return { ...planWith(o, { git: c.git, entry: c.entry, view }), top: c.top };
}

// ---------- CLI ----------

/** { o } or { error }. */
export function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (!Object.hasOwn(STORE_STEP, sub ?? '')) return { error: `the first word must be one of ${Object.keys(STORE_STEP).join(', ')}` };
  const o = { sub, json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') { o.json = true; continue; }
    const name = rest[i].slice(2);
    if (!rest[i].startsWith('--') || !FLAGS[sub].includes(name) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) return { error: `bad argument ${plain(rest[i], 40)} for ${sub}` };
    // Seat review 1, item 5: a ref or a remote that starts with - would reach git as an option. The value is not echoed (a URL may hold a token).
    if ((name === 'src' || name === 'remote') && rest[i + 1].startsWith('-')) return { error: `the --${name} value must not start with -` };
    o[name] = rest[++i];
  }
  if (sub === 'merge' && !/^[1-9]\d*$/.test(o.pr ?? '')) return { error: 'merge needs --pr N' };
  return { o: { ...o, pr: o.pr === undefined ? undefined : Number(o.pr) } };
}

const textOf = (spec) => [`${spec.header}: ${spec.question}`, ...spec.options.map((x, i) => `  ${i + 1}. ${x.label} - ${x.description}`)].join('\n');
const USAGE = 'node scripts/github/app-ask.mjs <push|open-pr|merge> [--dir D] [--remote R] [--branch B] [--src S] [--base B] [--pr N] [--json]';

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) { console.error(`app-ask: usage: ${parsed.error}. ${USAGE}`); process.exit(2); }
  const { o } = parsed;
  try {
    const plan = planOf(o);
    const w = offerWrite({ step: STORE_STEP[o.sub], key: plan.key, head: plan.head, spec: plan.spec, tree: plan.tree, cwd: plan.top });
    if (!w.ok) { console.error(`app-ask: the offer was not written (${w.reason}). Do not ask.`); process.exit(1); }
    console.log(o.json ? JSON.stringify(plan.spec) : textOf(plan.spec));
    if (plan.next) (o.json ? console.error : console.log)(`next: ${plan.next}`);
  } catch (err) {
    if (err instanceof Refuse) { console.error(`app-ask: no question: ${err.message}`); process.exit(1); }
    console.error(`app-ask: could not build the question (${plain(String(err.message).split('\n')[0], 160)})`);
    process.exit(3);
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main();
