/**
 * decision-gate: C5, the content scan of every outgoing commit (card coord-decision-gate-round3-content-scan; design note
 * .claudedocs/e2e-coord-decision-gate-round3-content-scan/01-design-note.md). Each row runs the real gate (decide) on a REAL temp git repo:
 * the git flags are what is under test. Only the id list is injected (holdoutIds). Every id here is made up.
 *
 * How the scan can fail, and the row that catches it:
 *   an id added in one commit and removed in a later one is sent unseen (item 9)                    -> C1
 *   an id only a side-branch commit carries, merged in and later removed (class test)               -> C2
 *   an id only in a merge commit's own resolution lines                                              -> C3
 *   an id in a file both parents changed, merge takes one side whole (no combined-diff line)         -> C4
 *   a non-re/ push: an answer-key file changed and reverted inside the range (item 9b)               -> C5
 *   an added line whose content starts with ++ is dropped (item 12, gate side)                       -> C6
 *   a short sha form is missed (F1)                                                                  -> C7
 *   a file git calls binary is not read                                                              -> C8
 *   an annotated tag message, --follow-tags, --tags, --mirror or a notes ref leaves unscanned        -> C9
 *   over the commit bound, the push is allowed or the text is not the bound text                     -> C10
 *   the deny text holds the id, or tells a way out that does not work under the superset range      -> C11
 *   a clean re/ push is denied as a hit, or a non-re/ push with no answer-key path reads content      -> C12
 *   a dash-led source pushed to main skips the scan (F2)                                             -> C13
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, realDeps, type Deps } from '../decision-gate.js';

const REPO_URL = 'https://github.com/Rev4nchist/Continuous-Claude-v3.git';
const CID = '987654321'; // a made-up comment id (9 digits: matches as a whole digit run)
const SHA = 'abcdef0123456789abcdef0123456789abcdef01'; // a made-up round sha
const KEY_FILE = 'probe/answer-key.json'; // a made-up answer-key path (the fake answerKeyHits names it)
let root = '';
let repo = '';
let saved: string | undefined;

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
const put = (path: string, text: string): void => { writeFileSync(join(repo, path), text); git('add', '--', path); };
const commit = (msg: string): string => { git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dg-c5-'));
  repo = join(root, 'repo');
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(root, 'decisions.json');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  git('config', 'user.email', 'c5@example.invalid');
  git('config', 'user.name', 'c5');
  git('config', 'core.autocrlf', 'false');
  git('remote', 'add', 'fork', REPO_URL);
  writeFileSync(join(repo, 'review-router.config.json'), JSON.stringify({ decisions: { enforce: true } }));
  put('base.txt', 'base\n');
  const base = commit('base');
  git('update-ref', 'refs/remotes/fork/main', base);
  git('checkout', '-q', '-b', 're/x');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(root, { recursive: true, force: true });
});

function deps(extra: Partial<Deps> = {}): Deps {
  return { ...realDeps(), holdoutIds: () => [CID, SHA], answerKeyHits: (paths: string[]) => paths.filter((p) => p === KEY_FILE), ...extra } as Deps;
}
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'c5-test' });
const reasonOf = (command: string, d: Deps = deps()): string => { const v = decide(bash(command), d); return v.action === 'deny' ? v.reason : `ALLOW${'warn' in v && v.warn ? ` warn: ${v.warn}` : ''}`; };
const isHit = (r: string): boolean => /carries \d+ holdout id/.test(r);

describe('C5: every outgoing commit is read', () => {
  it('C1: an id added in one commit and removed in a later one denies (item 9)', () => {
    // Breaks when: the scan reads the final three-dot diff, not each commit (-p).
    put('a.txt', `ref ${CID}\n`); commit('add');
    put('a.txt', 'clean\n'); commit('remove');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });

  it('C2: an id only a side-branch commit carried, merged in and later removed, denies (class test)', () => {
    // Breaks when: the range drops commits that only the second parent of a merge reaches.
    git('checkout', '-q', '-b', 'side', 'refs/remotes/fork/main');
    put('s.txt', `side ${CID}\n`); commit('side add');
    git('checkout', '-q', 're/x');
    put('r.txt', 'r\n'); commit('re work');
    git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    put('s.txt', 'clean\n'); commit('clean side');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });

  it('C3: an id only in a merge commit\'s own resolution lines denies', () => {
    // Breaks when: merges get no diff (--cc dropped, or --diff-merges=off).
    put('m.txt', 'one\n'); commit('re side');
    git('checkout', '-q', '-b', 'side', 'refs/remotes/fork/main');
    put('m.txt', 'two\n'); commit('side side');
    git('checkout', '-q', 're/x');
    try { git('merge', '-q', '-m', 'merge', 'side'); } catch { /* conflict, resolved below */ }
    writeFileSync(join(repo, 'm.txt'), `resolved ${CID}\n`); git('add', 'm.txt');
    git('commit', '-q', '--no-edit');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });

  it('C4: an id in a file both parents changed, merged by taking one side whole, is read in that side\'s own commit', () => {
    // Breaks when: the range is read as the merge diff only. --cc prints no line for a side taken whole; the side's own commit holds the id.
    put('b.txt', 'mine\n'); commit('re side');
    git('checkout', '-q', '-b', 'side', 'refs/remotes/fork/main');
    put('b.txt', `theirs ${CID}\n`); commit('side side');
    git('checkout', '-q', 're/x');
    try { git('merge', '-q', '-m', 'merge', 'side'); } catch { /* conflict */ }
    git('checkout', '--theirs', '--', 'b.txt'); git('add', 'b.txt'); git('commit', '-q', '--no-edit');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });

  it('C5: a non-re/ push whose answer-key file was changed and reverted inside the range denies (item 9b)', () => {
    // Breaks when: the trigger reads the names of the final diff only.
    git('checkout', '-q', '-b', 'feat/y');
    mkdirSync(join(repo, 'probe'));
    put(KEY_FILE, `{"id":"${CID}"}\n`); commit('key add');
    git('rm', '-q', KEY_FILE); commit('key revert');
    expect(isHit(reasonOf('git push fork feat/y'))).toBe(true);
  });

  it('C6: an added line whose content starts with ++ denies (item 12, gate side)', () => {
    // Breaks when: lines that start with +++ are dropped.
    put('p.txt', `++ ${CID}\n`); commit('plusplus');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });

  it('C7: a short sha form denies, in both directions (F1)', () => {
    // Breaks when: the gate matcher has no sha prefix rule.
    commit(`merge of ${SHA.slice(0, 8)} done`);
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
    git('reset', '-q', '--hard', 'refs/remotes/fork/main');
    commit(`full ${SHA.slice(0, 12)}${'0'.repeat(28)} done`);
    expect(isHit(reasonOf('git push fork re/x', deps({ holdoutIds: () => [SHA.slice(0, 12)] })))).toBe(true);
  });

  it('C8: an id in a file git calls binary denies', () => {
    // Breaks when: --text is dropped ("Binary files differ" hides the line).
    writeFileSync(join(repo, 'bin.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(` ${CID} `)]));
    git('add', 'bin.dat'); commit('binary');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });
});

describe('C5: what git sends besides the commit range', () => {
  it('C9a: an annotated tag whose message holds an id does not leave unscanned', () => {
    // Breaks when: a tag push reads only the commit range (the tag message is not in git log).
    put('t.txt', 't\n'); commit('tagged');
    git('tag', '-a', 'v-probe', '-m', `release ${CID}`);
    const forms = ['git push fork v-probe', 'git push fork refs/tags/v-probe', 'git push fork tag v-probe', 'git push fork re/x v-probe'];
    expect(forms.map((c) => `${c} => ${reasonOf(c).slice(0, 90)}`).filter((x) => /=> ALLOW/.test(x))).toEqual([]);
  });

  it('C9b: --follow-tags, --tags, --mirror and a notes ref toward a re/ push do not leave unscanned', () => {
    // Breaks when: a wide or extra-ref form of a re/ push is allowed or only warned.
    put('t.txt', 't\n'); commit('tagged');
    git('tag', '-a', 'v-probe', '-m', `release ${CID}`);
    const forms = ['git push --follow-tags fork re/x', 'git push --tags fork re/x', 'git push --mirror fork', 'git push fork refs/notes/commits', 'git push fork re/x refs/notes/commits', 'git -c push.followTags=true push fork re/x'];
    expect(forms.map((c) => `${c} => ${reasonOf(c).slice(0, 90)}`).filter((x) => /=> ALLOW/.test(x))).toEqual([]);
  });
});

describe('C5: the hook budget (seat change 2: a hook killed at 10 s writes no deny)', () => {
  const CLOCK_TEXT = /time of the hook ran out/;
  /** A clock the git stub moves: each scan log read "takes" its whole timeout and fails with ETIMEDOUT; other reads take 50 ms. */
  function slowWorld(): { d: Deps; at: () => number; logReads: number[] } {
    let t = 0;
    const logReads: number[] = [];
    const spawn = (cmd: string, args: string[], o: { cwd?: string; timeout?: number; maxBuffer?: number }) => {
      // The names read is slow (1.5 s) but ends; the content read takes its whole timeout and fails. Both scan reads are slow.
      if (args[0] === 'log' && args.includes('-p')) {
        logReads.push(o.timeout ?? -1);
        t += o.timeout ?? 0;
        return { status: null, stdout: '', error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
      }
      if (args[0] === 'log') { logReads.push(o.timeout ?? -1); t += 1500; } else t += 50;
      // PR 566 CI (semgrep detect-child-process): the literal 'git' only; `cmd` is always git here.
      void cmd;
      const r = spawnSync('git', args, { cwd: o.cwd, encoding: 'utf8', windowsHide: true });
      return { status: r.status, stdout: r.stdout, error: r.error };
    };
    const real = realDeps({ start: 0, now: () => t, spawn: spawn as never });
    return { d: deps({ git: real.git, scanLeft: real.scanLeft }), at: () => t, logReads };
  }

  it('C14: a slow git on both scan reads gives the clock deny inside the hook budget', () => {
    // Breaks when: a scan read times out to an allow, or the reads get their own fixed timeouts past the budget (no budget check).
    put('a.txt', 'clean\n'); commit('clean');
    const w = slowWorld();
    const r = reasonOf('git push fork re/x', w.d);
    expect(r).toMatch(CLOCK_TEXT);
    expect(w.logReads).toHaveLength(2);
    // The content read gets its own budgeted timeout, above the 2 s default of every other read (F5: the options reach makeGit).
    expect(w.logReads[1]).toBeGreaterThan(2000);
    expect(w.at()).toBeLessThanOrEqual(7000 - 1500);
    expect(w.logReads.every((ms) => ms > 0 && ms <= 6000)).toBe(true);
  });

  it('C15: a budget already spent denies before any scan read starts', () => {
    // Breaks when: the scan starts a read with no time left (the hook would be killed with no deny written).
    put('a.txt', 'clean\n'); commit('clean');
    const calls: string[][] = [];
    const real = realDeps();
    const d = deps({ scanLeft: () => 1000, git: ((cwd: string, args: string[], o?: never) => { calls.push(args); return real.git(cwd, args, o); }) as Deps['git'] });
    expect(reasonOf('git push fork re/x', d)).toMatch(CLOCK_TEXT);
    expect(calls.some((a) => a[0] === 'log')).toBe(false);
  });

  it('C16: a content read that times out gives the clock text, never an allow', () => {
    // Breaks when: ETIMEDOUT on the content read is mapped to allow or to the generic git-read text.
    put('a.txt', `ref ${CID}\n`); commit('add');
    const real = realDeps();
    const d = deps({ git: ((cwd: string, args: string[], o?: never) => {
      if (args[0] === 'log' && args.includes('-p')) throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return real.git(cwd, args, o);
    }) as Deps['git'] });
    expect(reasonOf('git push fork re/x', d)).toMatch(CLOCK_TEXT);
  });
});

describe('C5: tags outside the branch', () => {
  it('C9c: --tags on a re/ push reads a tagged commit that is not on the branch', () => {
    // Breaks when: the log reads start only from the branch head (a --tags push sends every tag and its commits).
    git('checkout', '-q', '-b', 'side', 'refs/remotes/fork/main');
    put('s.txt', `side ${CID}\n`); commit('side only');
    git('tag', 'light-probe');
    git('checkout', '-q', 're/x');
    put('r.txt', 'r\n'); commit('re work');
    expect(isHit(reasonOf('git push --tags fork re/x'))).toBe(true);
    // The same branch pushed alone does not send the side commit: no hit.
    expect(isHit(reasonOf('git push fork re/x'))).toBe(false);
  });
});

describe('C5: bounds, texts and cost', () => {
  it('C10: over 200 commits denies with the bound text', () => {
    // Breaks when: the commit bound is missing, or its deny is the generic git-read text.
    const base = git('rev-parse', 'HEAD');
    let stream = '';
    for (let i = 0; i < 201; i++) stream += `commit refs/heads/re/x\ncommitter c5 <c5@example.invalid> 1700000000 +0000\ndata ${`c${i}`.length}\nc${i}\n${i === 0 ? `from ${base}\n` : ''}\n`;
    execFileSync('git', ['fast-import', '--quiet', '--force'], { cwd: repo, input: stream, windowsHide: true });
    expect(reasonOf('git push fork re/x')).toMatch(/over the bound of 200/);
  });

  it('C11: the hit text is count-only and names the real ways out', () => {
    // Breaks when: the text holds the id, or says "split the push" (an old commit stays in fork/main..head).
    put('a.txt', `ref ${CID}\n`); commit('add');
    const r = reasonOf('git push fork re/x');
    expect(r).not.toContain(CID);
    expect(r).toMatch(/new branch from fork\/main/);
    expect(r).toMatch(/history rewrite/);
    expect(r).not.toMatch(/split the push/i);
  });

  it('C12: a clean re/ push is not a hit; a non-re/ push with no answer-key path makes no content read', () => {
    // Breaks when: the scan matches clean text, or runs its large read on every push.
    put('a.txt', 'clean\n'); commit('clean');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(false);
    git('checkout', '-q', '-b', 'feat/z');
    const calls: string[][] = [];
    const real = realDeps();
    const d = deps({ git: (cwd: string, args: string[], o?: unknown) => { calls.push(args); return (real.git as (c: string, a: string[], o?: unknown) => { status: number; stdout: string })(cwd, args, o); } } as Partial<Deps>);
    reasonOf('git push fork feat/z', d);
    expect(calls.some((a) => a[0] === 'log' && a.includes('-p'))).toBe(false);
    expect(calls.some((a) => a[0] === 'diff' && a.includes('--unified=0'))).toBe(false);
  });

  it('C13: a dash-led source pushed to main does not skip the scan (F2)', () => {
    // Breaks when: scanHoldoutRead returns null for a ref that starts with a dash and judgePush allows main before shipTap.
    git('checkout', '-q', 'main');
    mkdirSync(join(repo, 'probe'));
    put(KEY_FILE, `{"id":"${CID}"}
`); commit('key on main');
    for (const c of ['git push fork -- -x:main', 'git push fork --end-of-options -x:main']) expect(reasonOf(c), c).not.toMatch(/^ALLOW/);
  });
});

describe('C5: the real buffer, the message indent and false-deny controls (advisor read)', () => {
  it('C17: about 1.5 MB of clean added lines is read whole; the same with an id at the end is a hit (F5 on real git)', () => {
    // Breaks when: the content read keeps the 1 MiB default buffer (a normal large branch would deny "a git read failed").
    put('big.txt', `${'clean line of text\n'.repeat(80_000)}`); commit('big');
    expect(reasonOf('git push fork re/x')).not.toMatch(/holdout|cannot be checked/);
    put('big2.txt', `${'clean line of text\n'.repeat(80_000)}tail ${CID}\n`); commit('big with id');
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });

  it('C18: message lines that look like a diff or a hunk do not hide a later id', () => {
    // Breaks when: the message is not indented (%w), so "diff --" and "@@ " in a message switch the reader into a hunk.
    commit(`subject\n\ndiff --git a/x b/x\n@@ -1 +1 @@\nplain ${CID}\n`);
    expect(isHit(reasonOf('git push fork re/x'))).toBe(true);
  });

  it('C19: no false deny on lines that are on fork/main already', () => {
    // Breaks when: a removed line is read (a), main's own lines in a clean merge are read (b), or a merge line equal to main's is read (c).
    git('checkout', '-q', 'main');
    put('main.txt', `kept ${CID}\nother\n`); const mainTip = commit('main has an id line');
    git('update-ref', 'refs/remotes/fork/main', mainTip);
    git('checkout', '-q', '-b', 're/a', mainTip);
    put('main.txt', 'other\n'); commit('remove the id line');
    expect(isHit(reasonOf('git push fork re/a')), 'a: removal').toBe(false);
    git('checkout', '-q', '-b', 're/b', 're/x');
    put('b.txt', 'b\n'); commit('b work');
    git('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
    expect(isHit(reasonOf('git push fork re/b')), 'b: clean merge of main').toBe(false);
    git('checkout', '-q', '-b', 're/c', 're/x');
    put('main.txt', 'mine\nother\n'); commit('c conflicting line');
    try { git('merge', '-q', '-m', 'merge main', 'main'); } catch { /* conflict */ }
    writeFileSync(join(repo, 'main.txt'), `mine\nkept ${CID}\nother\n`); git('add', 'main.txt'); git('commit', '-q', '--no-edit');
    expect(isHit(reasonOf('git push fork re/c')), 'c: resolution keeps main\'s line').toBe(false);
  });

  it('C20: a feature branch over 200 commits with no answer-key path is not denied by the scan', () => {
    // Breaks when: the commit bound runs before the trigger (main let such a branch pass).
    git('checkout', '-q', '-b', 'feat/long');
    const base = git('rev-parse', 'HEAD');
    let stream = '';
    for (let i = 0; i < 201; i++) stream += `commit refs/heads/feat/long\ncommitter c5 <c5@example.invalid> 1700000000 +0000\ndata ${`c${i}`.length}\nc${i}\n${i === 0 ? `from ${base}\n` : ''}\n`;
    execFileSync('git', ['fast-import', '--quiet', '--force'], { cwd: repo, input: stream, windowsHide: true });
    expect(reasonOf('git push fork feat/long')).not.toMatch(/holdout|over the bound/);
  });

  it('C21: a binary file in a merge resolution denies as unreadable (--cc ignores --text)', () => {
    // Breaks when: "Binary files differ" in a merge is read as an empty change.
    writeFileSync(join(repo, 'b.bin'), Buffer.from([109, 0, 1])); git('add', 'b.bin'); commit('re bin');
    git('checkout', '-q', '-b', 'side', 'refs/remotes/fork/main');
    writeFileSync(join(repo, 'b.bin'), Buffer.from([115, 0, 2])); git('add', 'b.bin'); commit('side bin');
    git('checkout', '-q', 're/x');
    try { git('merge', '-q', '-m', 'merge', 'side'); } catch { /* conflict */ }
    writeFileSync(join(repo, 'b.bin'), Buffer.concat([Buffer.from([114, 0]), Buffer.from(` ${CID} `)])); git('add', 'b.bin'); git('commit', '-q', '--no-edit');
    expect(reasonOf('git push fork re/x')).toMatch(/Binary files differ/);
  });

  it('C22: a clean scan with the budget nearly gone denies on the clock before the ship reads (F6)', () => {
    // Breaks when: the push goes on to the shipTap reads with no time left (the hook is killed and no deny is written).
    git('checkout', '-q', '-b', 'feat/f6');
    put('f.txt', 'f\n'); commit('f');
    let logged = false;
    const real = realDeps();
    const d = deps({
      scanLeft: () => (logged ? 1000 : 6500),
      git: ((cwd: string, args: string[], o?: never) => { if (args[0] === 'log') logged = true; return real.git(cwd, args, o); }) as Deps['git'],
    });
    expect(reasonOf('git push fork feat/f6', d)).toMatch(/time of the hook ran out/);
  });
});
