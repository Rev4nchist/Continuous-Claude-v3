/**
 * Reviewer-2 round (card coord-decision-gate-app-repos). git, the registry and the router config are small fakes; the store is a temp file.
 *
 * Ways it can fail (one row or a row group each; each names the change that turns it red):
 *   Q1  a here-string or heredoc body with one unpaired quote masks a later push, force push, cd or -R, so the gate passes
 *       -> drop the body blanker (blankBodies) from readCommand
 *   Q2  the blanker declines (an unquoted delimiter with $( in its body, no closing line) and the unpaired quote still hides the push
 *       -> drop hiddenSpans from rawVerdict (item 1a), or read force only in the push segments
 *   Q3  the blanker hides a real command: a body that runs (bash <<EOF), an opener inside quotes, an opener of an unlisted command
 *       -> blank every body (no DATA_CMD or quote test in opensData)
 *   Q4  over-deny: a commit message in a heredoc or here-string with an odd quote and no push is denied (app and CCv3)
 *       -> hiddenSpans on the whole text instead of the spans; a deny for any unpaired quote
 *   T1  a user:token URL remote reaches stdout, in block and in warn mode, or through the stop line -> drop noCreds in askCmd and scrub in out()
 *   M1  after cd ~/homeapp, a subagent push, a delete refspec, --tags, --all, --prune, --branches, --repo, an o bundle or a widening option
 *       only warns with enforceAppPush false -> unexpandedDeny sets tapPath for every push again (no softPush)
 *   S1  a store write in the same command hides a force push (decisions.enforce not true: a warn) -> the early return of judgeCommand
 *   P1  an app Push only tap is single use, or a changed head or tree still passes (known limit, pinned both sides)
 *       -> consume the tap in the gate; drop pushOnlyHead or the tree compare
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRecord, offerWrite } from '../shared/decisions-store.js';
import { readRegistry } from '../shared/tap-scope.js';
import { type Decision, type Deps } from '../decision-gate.js';
import { decideParsed, handleParsed } from './helpers/parse-first.js';
import './helpers/walker-timeout.js'; // C2c: the long test timeout, scoped to the files that start a pwsh walker

const HEAD = 'a'.repeat(40);
const HEAD2 = 'c'.repeat(40);
const TREE = 't'.repeat(40);
const TREE2 = 'u'.repeat(40);
const TOKEN = 'ghp_SECRETTOKEN123';
const CCV3_URL = 'https://github.com/Rev4nchist/Continuous-Claude-v3.git';
const APP = '/work/app-x';
const HOMEAPP = '/home/tester/homeapp';
const CC = '/work/cc';
const STRAY = '/work/stray';
let scratch = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CCV3_GUARD_DECISIONS_LOG'];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dg-here-')).replace(/\\/g, '/');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCV3_DECISIONS_FILE = `${scratch}/decisions.json`;
  process.env.LANE_REGISTRY_PATH = `${scratch}/no-registry.json`;
  delete process.env.CCV3_GUARD_DECISIONS_LOG;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(scratch, { recursive: true, force: true });
});

interface Folder { remotes: Record<string, string>; remoteHead: string; heads?: Record<string, string>; trees?: Record<string, string> }
const FOLDERS: Record<string, Folder> = {
  [APP]: { remotes: { up: 'https://github.com/acme/app-x.git' }, remoteHead: 'develop' },
  [HOMEAPP]: { remotes: { up: 'https://github.com/acme/homeapp.git' }, remoteHead: 'main' },
  [CC]: { remotes: { fork: CCV3_URL }, remoteHead: 'main' },
  [STRAY]: { remotes: { up: 'https://github.com/acme/stray.git' }, remoteHead: 'main' },
};
const REGISTRY = JSON.stringify({ projects: [{ key: 'app-x', path: APP }, { key: 'homeapp', path: HOMEAPP }, { key: 'continuous-claude', path: '/work/ccroot' }] });
const ON = JSON.stringify({ decisions: { enforce: true } });
const SOFT = JSON.stringify({ decisions: { enforce: true, enforceAppPush: false } });
const LAX = JSON.stringify({ decisions: { enforce: false } });

/** One fake git answer. A URL typed as the remote is no configured remote (status 2). Status 1 for anything not listed. */
function answer(f: Folder, dir: string, a: string): { status: number; stdout: string } {
  const ok = (s: string) => ({ status: 0, stdout: `${s}\n` });
  if (a === 'remote -v') return ok(Object.entries(f.remotes).map(([n, u]) => `${n}\t${u} (fetch)\n${n}\t${u} (push)`).join('\n'));
  if (a === 'remote') return ok(Object.keys(f.remotes).join('\n'));
  if (a === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir') return ok(`${dir}\n${dir}/.git`);
  const gu = /^remote get-url (?:--push (?:--all )?)?(?:--end-of-options )?(.+)$/.exec(a);
  if (gu) return f.remotes[gu[1]] ? ok(f.remotes[gu[1]]) : { status: 2, stdout: '' };
  const sr = /^symbolic-ref --quiet --short refs\/remotes\/(.+)\/HEAD$/.exec(a);
  if (sr) return f.remotes[sr[1]] ? ok(`${sr[1]}/${f.remoteHead}`) : { status: 1, stdout: '' };
  if (a.startsWith('config --get-regexp ')) return { status: 1, stdout: '' };
  if (a === 'branch --show-current') return ok('feat');
  const heads = f.heads ?? { feat: HEAD, main: HEAD };
  const c = /^rev-parse (?:--verify )?(?:--quiet )?(?:--end-of-options )?(.+)\^\{commit\}$/.exec(a);
  if (c) { const n = c[1] === 'HEAD' ? 'feat' : c[1]; return heads[n] ? ok(heads[n]) : { status: 1, stdout: '' }; }
  const t = /^rev-parse (?:--verify )?(?:--end-of-options )?(.+)\^\{tree\}$/.exec(a);
  const trees = f.trees ?? { HEAD: TREE, feat: TREE, main: TREE };
  if (t && trees[t[1]]) return ok(trees[t[1]]);
  return { status: 1, stdout: '' };
}

function deps(config = ON, folders: Record<string, Folder> = FOLDERS): Deps {
  return {
    env: { ...process.env },
    home: '/home/tester',
    readFile: (p) => (p.replace(/\\/g, '/') === '/home/tester/continuous-claude/review-router.config.json' ? config : null),
    git: (cwd, args) => {
      const dir = cwd.replace(/\\/g, '/');
      const f = folders[dir];
      return f ? answer(f, dir, args.join(' ')) : { status: 128, stdout: '' };
    },
    tapScope: {
      registry: () => readRegistry({ path: '/reg/project-registry.json', deps: { readFile: () => REGISTRY, realpath: (p) => p } }),
      realpath: (p) => p,
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  };
}
const bash = (command: string, cwd = APP, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's-here', ...extra });
const ps = (command: string, cwd = APP) => ({ ...bash(command, cwd), tool_name: 'PowerShell' });
const sub = (p: object) => ({ ...p, agent_id: 'agent-1' });
const verdict = async (input: object, config = ON, folders?: Record<string, Folder>): Promise<Decision> => await decideParsed(input, deps(config, folders));
const allowed = (d: Decision): boolean => d.action === 'allow' && !d.warn;
const warned = (d: Decision): boolean => d.action === 'allow' && Boolean(d.warn);
function tap(step: 'ship' | 'land' | 'open-pr', key: string, head: string, label: string, tree?: string): void {
  expect(offerWrite({ step, key, head, tree, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}

// The reviewer's shapes. G = the gh word, split so no live hook of this session reads the test text as a PR command.
const G = ['g', 'h'].join('');
const hereA = (word: string, tail: string): string => `git commit -m @'\n${word} drop it\n'@; ${tail}`;
const hereB = (word: string, tail: string): string => `git commit -m "$(cat <<'EOF'\nAdd ${word} panel\nEOF\n)" && ${tail} && echo "done"`;
/** The blanker declines: an unquoted delimiter whose body holds $( ) (bash expands it), so only item 1a can see the push. */
const hereC = (tail: string): string => `git commit -m "$(cat <<EOF\nAdd 27" panel $(date)\nEOF\n)" && ${tail} && echo "done"`;

describe('Q1 a body with an unpaired quote no longer hides what follows it', () => {
  it('Q1a PS here-string (Don\'t), then git push up main: denied (tap path)', async () => {
    expect(await verdict(ps(hereA("Don't", "git push up main; Write-Host 'ok'")))).toMatchObject({ action: 'deny', scope: 'app-push' });
  });
  it('Q1b bash heredoc (27"), then git push up main: denied (tap path)', async () => {
    expect(await verdict(bash(hereB('27"', 'git push up main')))).toMatchObject({ action: 'deny', scope: 'app-push' });
  });
  it('Q1c bash heredoc (27"), then git push -f: push-unsafe, also with enforceAppPush false', async () => {
    expect(await verdict(bash(hereB('27"', 'git push -f up feat')))).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
    expect(await verdict(bash(hereB('27"', 'git push -f up feat')), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
  it('Q1d PS here-string, then a force push: push-unsafe', async () => {
    expect(await verdict(ps(hereA("Don't", "git push -f up feat; Write-Host 'ok'")), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
  it('Q1e from a CCv3 cwd: heredoc, then cd <app> && git push -f: push-unsafe in the app', async () => {
    expect(await verdict(bash(hereB('27"', `cd ${APP} && git push -f up feat`), CC))).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
  });
  it('Q1f one remote: heredoc, then a merge that names another repo with -R is not cleared by the folder tap', async () => {
    tap('land', 'acme/app-x#7', HEAD, 'Merge now (no READY check)');
    expect(allowed(await verdict(bash(`${G} pr merge 7 --match-head-commit ${HEAD}`)))).toBe(true);
    expect(await verdict(bash(hereB('27"', `${G} pr merge 7 -R other/repo --match-head-commit ${HEAD}`)))).toMatchObject({ action: 'deny' });
  });
  it('Q1g from an uncovered cwd: heredoc, then cd <app> && a merge or a create is judged in the app', async () => {
    expect(await verdict(bash(hereB('27"', `cd ${APP} && ${G} pr merge 7 --match-head-commit ${HEAD}`), STRAY))).toMatchObject({ action: 'deny' });
    expect(await verdict(bash(hereB('27"', `cd ${APP} && ${G} pr create --draft --head feat`), STRAY))).toMatchObject({ action: 'deny' });
  });
});

describe('Q2 item 1a: the unpaired quote fails closed when the blanker declines', () => {
  it('Q2a force push behind it: push-unsafe, hard with enforceAppPush false', async () => {
    expect(await verdict(bash(hereC('git push -f up feat')), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
  });
  it('Q2b a wide spelling (--tags) behind it: hard', async () => {
    expect(await verdict(bash(hereC('git push --tags up')), SOFT)).toMatchObject({ action: 'deny', scope: 'app-push' });
  });
  it('Q2c a plain push behind it: the tap path (a deny; a warn with enforceAppPush false)', async () => {
    expect(await verdict(bash(hereC('git push up topic')))).toMatchObject({ action: 'deny', scope: 'app-push' });
    expect(warned(await verdict(bash(hereC('git push up topic')), SOFT))).toBe(true);
  });
  it('Q2d a subagent push behind it: hard with enforceAppPush false', async () => {
    expect(await verdict(sub(bash(hereC('git push up topic'))), SOFT)).toMatchObject({ action: 'deny', scope: 'app-push' });
  });
  it('Q2e from an uncovered cwd: cd <app> && a merge behind it is denied', async () => {
    expect(await verdict(bash(hereC(`cd ${APP} && ${G} pr merge 7 --match-head-commit ${HEAD}`), STRAY))).toMatchObject({ action: 'deny' });
  });
  it('Q2f no closing line: PS here-string with no closing line, then a push, is denied', async () => {
    expect(await verdict(ps("git commit -m @'\nDon't drop it\n  '@; git push -f up feat; Write-Host 'ok'"), SOFT)).toMatchObject({ action: 'deny', pattern: 'parse-error' }); // C2b (class C): main with a parse gives this answer; the hand reader is retired. A here-string with no closing line is a parse error, still a deny.
  });
});

describe('Q3 the blanker never hides a command that runs', () => {
  it('Q3a bash <<EOF runs its body: the force push in it stays push-unsafe', async () => {
    expect(await verdict(bash("bash <<'EOF'\ngit push -f up feat\nEOF"))).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
  it('Q3b an opener inside quotes is no heredoc: the push on the next line stays push-unsafe', async () => {
    expect(await verdict(bash('echo "see <<EOF"\ngit push -f up feat\nEOF'))).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
    expect(await verdict(bash('git commit -m "see <<EOF"\ngit push -f up feat\nEOF'))).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
  // Change that breaks Q3d: accept cat as the first word of a segment, or cut the segment at ( (the advisor review of this round).
  it('Q3d a body sent on to a shell (cat | bash, eval "$(cat)", bash -c "$(cat)") keeps its force push: push-unsafe', async () => {
    for (const c of ["cat <<'EOF' | bash\ngit push -f up feat\nEOF", "eval \"$(cat <<'EOF'\ngit push -f up feat\nEOF\n)\"", "bash -c \"$(cat <<'EOF'\ngit push -f up feat\nEOF\n)\""]) {
      expect(await verdict(bash(c)), c).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
    }
  });
  it('Q3c a here-string of an unlisted command (Write-Output) keeps its body: an unpaired quote in it still fails closed', async () => {
    expect(await verdict(ps("Write-Output @'\nDon't\n'@; git push -f up feat; Write-Host 'ok'"))).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
});

describe('Q4 over-deny guards: a message with an odd quote and no push passes', () => {
  const rows: [string, object][] = [
    ['heredoc commit, app', bash("git commit -F - <<'EOF'\nDon't push the fix yet\nEOF")],
    ['heredoc commit, CCv3', bash("git commit -F - <<'EOF'\nDon't push the fix yet\nEOF", CC)],
    ['PS here-string commit, no push, app', ps("git commit -m @'\nDon't drop it\n'@; Write-Host 'ok'")],
    ['PS here-string commit, no push, CCv3', ps("git commit -m @'\nDon't drop it\n'@; Write-Host 'ok'", CC)],
    ['bash heredoc commit (27"), no push, app', bash(`git commit -m "$(cat <<'EOF'\nAdd 27" panel\nEOF\n)" && echo "done"`)],
    ['bash heredoc commit (27"), no push, CCv3', bash(`git commit -m "$(cat <<'EOF'\nAdd 27" panel\nEOF\n)" && echo "done"`, CC)],
    ['blanker declines, no push, app', bash(hereC('git status'))],
  ];
  it.each(rows)('%s', async (_n, input) => {
    expect(allowed(await verdict(input))).toBe(true);
  });
});

describe('T1 seat 3d: a user:token remote never reaches stdout or the guard log', () => {
  const url = (token = TOKEN) => `https://user:${token}@github.com/acme/app-x.git`;
  const out = async (input: object, config = ON): Promise<string> => await handleParsed(JSON.stringify(input), deps(config));
  it('T1a block mode: the deny names the remote without the token, as app-ask reads it', async () => {
    const o = await out(bash(`git push ${url()} main`));
    expect(o).toContain('deny');
    expect(o).not.toContain(TOKEN);
    expect(o).toContain('--remote https://github.com/acme/app-x.git --branch main');
  });
  it('T1b warn mode (enforceAppPush false): no token', async () => {
    const o = await out(bash(`git push ${url()} main`), SOFT);
    expect(o).toContain('WARNING');
    expect(o).not.toContain(TOKEN);
  });
  it('T1c a token with a character the offer word refuses is stripped before the word test: the offer is printed, with no token', async () => {
    const o = await out(bash(`git push ${url('ghp_SECRET%TOKEN123')} main`));
    expect(o).not.toContain('SECRET%TOKEN123');
    expect(o).toContain('--remote https://github.com/acme/app-x.git --branch main');
  });
  it('T1d the guard log row holds no token', async () => {
    const log = `${scratch}/guard.jsonl`;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    appendFileSync(log, '');
    await out(bash(`git push ${url()} main`));
    await out(bash(`git push ${url()} main`), SOFT);
    const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(text).toContain('"hook":"decision-gate"');
    expect(text).not.toContain(TOKEN);
  });
});

describe('M1 item 3: after cd ~/homeapp only the plain tap path warns with enforceAppPush false', () => {
  const hard: [string, object][] = [
    ['a subagent push', sub(bash('cd ~/homeapp && git push up feat', CC))],
    ['git push up :old', bash('cd ~/homeapp && git push up :old', CC)],
    ['git push --tags up', bash('cd ~/homeapp && git push --tags up', CC)],
    ['git push --all up', bash('cd ~/homeapp && git push --all up', CC)],
    ['git push --prune up feat', bash('cd ~/homeapp && git push --prune up feat', CC)],
    ['git push --branches up', bash('cd ~/homeapp && git push --branches up', CC)],
    ['git push --repo up feat', bash('cd ~/homeapp && git push --repo up feat', CC)],
    // -uo x, as H7 of the hard rows: -oh reads as a help word to the shape reader (no shape), so it is the round 6 unread push (tap path).
    ['git push -uo x up feat', bash('cd ~/homeapp && git push -uo x up feat', CC)],
    ['git push --follow-tags up feat', bash('cd ~/homeapp && git push --follow-tags up feat', CC)],
  ];
  it.each(hard)('%s: a hard deny', async (_n, input) => {
    expect(await verdict(input, SOFT)).toMatchObject({ action: 'deny', scope: 'app-push' });
  });
  it('a plain git push up feat: a warn (unchanged)', async () => {
    expect(warned(await verdict(bash('cd ~/homeapp && git push up feat', CC), SOFT))).toBe(true);
  });
});

describe('S1 item 4: a store write does not hide a force push in the same command', () => {
  const cmd = 'echo x > ~/.claude/state/ccv3-mods/decisions.json; git push -f up feat';
  it('decisions.enforce not true: the force push still denies (push-unsafe)', async () => {
    expect(await verdict(bash(cmd), LAX)).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
  it('decisions.enforce true: a deny (the store write first)', async () => {
    expect(await verdict(bash(cmd))).toMatchObject({ action: 'deny', pattern: 'store-write' });
  });
  // Change that breaks it: drop the store scope that unjudgeable adds (a git throw then turns the store write into a push-scope warn).
  it('a git throw while the shapes are judged keeps the store write a deny (decisions.enforce true)', async () => {
    const throwing: Deps = { ...deps(), git: () => { throw new Error('spawnSync git ETIMEDOUT'); } };
    const o = JSON.parse(await handleParsed(JSON.stringify(bash('echo x > ~/.claude/state/ccv3-mods/decisions.json; git push up feat', STRAY)), throwing)).hookSpecificOutput;
    expect(o.permissionDecision).toBe('deny');
  });
  it('a store write alone keeps its deny', async () => {
    expect(await verdict(bash('echo x > ~/.claude/state/ccv3-mods/decisions.json'))).toMatchObject({ action: 'deny', pattern: 'store-write' });
  });
});

describe('P1 seat 3c: an app tap is not single use (known limit); a new head or tree needs a new tap', () => {
  // Change that breaks the first row: consume the tap in the gate. The second: drop pushOnlyHead or the tree compare in shipTap.
  const at = (heads: Record<string, string>, trees?: Record<string, string>) => ({ ...FOLDERS, [APP]: { ...FOLDERS[APP], heads, ...(trees ? { trees } : {}) } });
  it('the same head and tree pass twice', async () => {
    tap('ship', 'acme/app-x@main', HEAD, 'Push only', TREE);
    expect(allowed(await verdict(bash('git push up main')))).toBe(true);
    expect(allowed(await verdict(bash('git push up main')))).toBe(true);
  });
  it('a changed head, or a changed tree, is refused', async () => {
    tap('ship', 'acme/app-x@main', HEAD, 'Push only', TREE);
    expect(await verdict(bash('git push up main'), ON, at({ feat: HEAD, main: HEAD2 }))).toMatchObject({ action: 'deny', pattern: 'ship' });
    expect(await verdict(bash('git push up main'), ON, at({ feat: HEAD, main: HEAD }, { HEAD: TREE2, feat: TREE2, main: TREE2 }))).toMatchObject({ action: 'deny', pattern: 'ship' });
  });
});

// ---------- reviewer-2, full-file round (the seat's reviewer on this file) ----------
const FORCE = ['--', 'force'].join('');
describe('W1 blocker and major 1: a hard spelling counts only in a hidden push piece at a command position; # comments are dropped', () => {
  // Change that breaks it: test forceSpelled or wideSpelled on the whole text, count a span with git at its start, or keep comments.
  const rows: [string, object][] = [
    ['(a) cat > NOTES.md heredoc that quotes "git push --force"', bash(`cat > NOTES.md <<'EOF'\nWe don't "git push ${FORCE}" to main.\nEOF`)],
    ['(b) a commit naming git push, ls, a comment with an apostrophe', bash('git commit -m "docs: git push steps" && ls tmp  # don\'t keep')],
    ['(c) PowerShell Set-Content with a here-string of the same body', ps(`Set-Content NOTES.md -Value @'\nWe don't "git push ${FORCE}" to main.\n'@`)],
    ['(d) major 1: a commit naming git push, then a comment with an apostrophe', bash('git commit -m "docs: git push steps"  # don\'t push yet')],
  ];
  it.each(rows)('%s passes', async (_n, input) => {
    expect(allowed(await verdict(input))).toBe(true);
  });
  // Advisor review of this round. Change that breaks it: drop a comment even when a quote mark follows it (a # line in a body the
  // blanker leaves alone is data; its apostrophe still pairs with a later quote in the readers' mask).
  it('a # line inside a cat heredoc, then a force push between quotes: push-unsafe', async () => {
    expect(await verdict(bash("cat > notes.md <<'EOF'\n# Don't forget\nEOF\ngit commit -m 'notes' && git push -f up feat && echo 'done'"))).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
});

describe('W1b a wrapper or control word before a hidden push still counts (the header: a wrapper before git is still a push)', () => {
  // Change that breaks it: read the first word of a hidden piece as its program (programOf without LEAD_WORD).
  it.each(['sudo git push -f up feat', 'env A=1 git push -f up feat', 'timeout 5 git push -f up feat'])('%s behind an odd quote: push-unsafe', async (c) => {
    expect(await verdict(bash(hereC(c)), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
});

describe('W2 major 2: an opener line that goes on (a backslash, an open quote) is not blanked', () => {
  // Change that breaks it: drop the plainLine test of blankHeredocs (the body then starts at the first physical line end).
  it('a backslash at the end of the opener line: the force push on the next line is push-unsafe', async () => {
    expect(await verdict(bash(`git commit -F - <<'EOF' \\\n  && git push ${FORCE} up feat\nmsg\nEOF`), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
  it('a quoted -m that spans the opener line: the force push after it is push-unsafe', async () => {
    expect(await verdict(bash(`git commit -F - <<'EOF' -m "first\nsecond" && git push ${FORCE} up feat\nbody\nEOF`), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
});

describe('W3 major 3: a payload push with a force, delete or wide spelling stays hard with enforceAppPush false', () => {
  // Change that breaks it: read only forceSpelled in the push segments again (no wide or :dst).
  it.each(['bash -c "git push --tags up"', 'bash -c "git push -f up feat"', 'bash -c "git push up :old"'])('%s: push-unsafe', async (c) => {
    expect(await verdict(bash(c), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
  });
  it('bash -c "git push up feat" keeps the tap path (a warn with enforceAppPush false)', async () => {
    expect(warned(await verdict(bash('bash -c "git push up feat"'), SOFT))).toBe(true);
  });
});

describe('W6 F1: a separator inside a quoted word does not start the segment of an opener', () => {
  // Change that breaks it: find the segment start and the first word on the raw lead (lastIndexOf of ; & | and line ends) again.
  const opener = "bash -s -- 'x; git y' <<'EOF'\n";
  it('Q3 bash -s with a quoted "; git" before the opener runs its body: the force push in it is push-unsafe', async () => {
    expect(await verdict(bash(`${opener}git push -f up feat\nEOF`), SOFT)).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
  });
  it('CCv3: the same opener with a merge in the body gets the CCv3 merge deny (decisions.enforce true, no tap)', async () => {
    expect(await verdict(bash(`${opener}${G} pr merge 12\nEOF`, CC))).toMatchObject({ action: 'deny', scope: 'other' });
  });
});

describe('W4 minor 1: an opener inside a quoted span is no opener, even when the marks count even', () => {
  // Change that breaks it: test the quote marks by count (pairedQuotes) in opensData.
  it("git commit -m 'a\"' \"b <<EOF ... x\" && git push -f: the force push is push-unsafe", async () => {
    expect(await verdict(bash("git commit -m 'a\"' \"b <<EOF\nx\" && git push -f up feat\nEOF"))).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
});

describe('W5 minor 2: one row for the blanker alone and one for the out() scrub alone', () => {
  // Change that breaks it: drop blankBodies from readCommand (the body line "run git push up main" is then a push word no shape reads).
  it('a commit message body that names git push passes only because the body is blanked', async () => {
    expect(allowed(await verdict(bash("git commit -F - <<'EOF'\nDocs: run git push up main after review\nEOF")))).toBe(true);
  });
  // Change that breaks it: drop the CREDS_RE replace in out(). The widening option text is printed by prose(opt), not through noCreds.
  it('a credential URL in a widening option value reaches the deny text only without its user:token part', async () => {
    const o = await handleParsed(JSON.stringify(bash(`git push --recurse-submodules=https://user:${TOKEN}@github.com/acme/sub.git up feat`)), deps());
    expect(o).toContain('deny');
    expect(o).toContain('--recurse-submodules=https://github.com/acme/sub.git');
    expect(o).not.toContain(TOKEN);
  });
});
