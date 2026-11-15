/**
 * decision-gate round 3 (card coord-decision-gate-round3; design note
 * C:/Users/dkhay/continuous-claude/.claudedocs/e2e-coord-decision-gate-round3/01-design-note.md). Own file: one red test per item,
 * one test per class with a spelling not in the list, one cost test per class. Every row runs in the shipped state: decisions.enforce
 * true, decisions.enforcePush ABSENT (a deny of scope push only warns today).
 *
 * Item 18 (Dave: "Land now, fix first in round 3"): a throw in a LATER member of a command that holds a push must not lose the hard
 * deny found before it, and a throw in a command that holds a push never ends in a warning.
 *   - an origin push, then a -C push to a folder whose git throws: the origin hard deny     -> R18-1 (red today: warn)
 *   - a force push to main, then a push in a folder whose git throws (`;` chain)             -> R18-2 (class: a spelling not in the list)
 *   - one push whose judging throws, no deny found before                                    -> R18-3 (hard deny, not a warn)
 *   - a command with no push whose judging throws                                            -> R18-C1 (cost: today's result kept)
 *   - a command with no gated shape whose judging throws                                     -> R18-C2 (cost: still allowed)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionKey, decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, handle, type Deps } from '../decision-gate.js';
import { isPrOpenCommand } from '../pr-opened-review-loop.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-r3-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

interface World {
  /** git THROWS for every call whose folder contains this text (a spawn error, a deadline). */
  throwIn?: string;
}

/** The shipped state: enforce true, enforcePush absent. A fake git for a CCv3 checkout at /repo. */
function deps(w: World = {}): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  const base = {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null),
    git: (cwd: string, args: string[]) => {
      if (w.throwIn && cwd.replace(/\\/g, '/').includes(w.throwIn)) throw new Error('git exploded');
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (a === 'rev-parse --abbrev-ref @{push}') return { status: 128, stdout: '' };
      // A remote name the text does not show as upstream: only git can tell that `up` points at parcadei (R18-5).
      if (a === 'remote get-url up') return { status: 0, stdout: 'https://github.com/parcadei/Continuous-Claude-v3.git\n' };
      if (/^rev-parse (.+)\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse (.+)\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      return { status: 1, stdout: '' };
    },
    // The registry: only the CCv3 root, at /repo. /elsewhere is under no root (an unregistered folder).
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  };
  return base as unknown as Deps;
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: 'r3-test' });
interface Out { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
const run = (input: object, w?: World): Out => {
  const raw = handle(JSON.stringify(input), deps(w));
  return raw === '{}' ? {} : (JSON.parse(raw).hookSpecificOutput ?? {});
};

describe('R18: a throw in a command that holds a push keeps the deny found so far, else denies hard', () => {
  it('R18-1: an origin push, then a -C push to a folder whose git throws, gives the origin hard deny', () => {
    // Breaks when: the outer catch of handle() reads only the enforcement flags (today: a warning, and the origin push runs).
    const o = run(bash('git push origin feat/x && git -C /gone push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-2: a force push to main, then a push in a folder whose git throws (; chain), gives the force-push hard deny', () => {
    // Breaks when: the deny found before the throw is dropped, in a chain spelled with ; and a cd (not the R18-1 shape).
    const o = run(bash('git push --force fork main; cd /gone && git push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).not.toMatch(/could not verify/);
  });

  it('R18-3: one push whose judging throws, with no deny found before, is a hard deny, not a warning', () => {
    // Breaks when: a throw in a push ends in warnOut while enforcePush is absent.
    const o = run(bash('git push fork feat/x'), { throwIn: '/repo' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.additionalContext).toBeUndefined();
    // Seat request: the text says the check failed, not a policy, and to run the push again (pins the throw-only deny text).
    expect(o.permissionDecisionReason).toMatch(/push check could not run/);
    expect(o.permissionDecisionReason).toMatch(/not a policy block/);
    expect(o.permissionDecisionReason).toMatch(/Run the push again/);
  });

  it('R18-4: the throwing push FIRST, then an origin push, still gives the origin hard deny (the catch reads every push shape)', () => {
    // Breaks when: the catch reads only the denies judged before the throw, so a push after the throwing member is never read.
    const o = run(bash('git -C /gone push fork feat/x && git push origin feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-5: a push to a remote that git shows is upstream, then a push whose git throws, keeps the origin deny found by git', () => {
    // Breaks when: the catch drops the denies judged before the throw. The text alone (intentDeny) cannot see that `up` is parcadei.
    const o = run(bash('git push up feat/x && git -C /gone push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin|parcadei|upstream/i);
    expect(o.permissionDecisionReason).not.toMatch(/could not verify/);
  });

  it('R18-C3 (cost, seat 20:00, Dave D1): a lone push in a resolved unregistered folder whose git throws keeps the old warning', () => {
    // Breaks when: the item 18 hard deny reaches a folder outside every registry root (a policy change that is Dave's).
    const o = run({ ...bash('git push up feat/x'), cwd: '/elsewhere/app' }, { throwIn: '/elsewhere' });
    expect(o.permissionDecision).toBeUndefined();
    expect(o.additionalContext).toContain('could not verify');
  });

  it('R18-6: the unregistered exemption is not a hole: a push there whose git throws, then an origin push, denies', () => {
    // Breaks when: the exemption for an unregistered folder also skips the intent read of the other push shapes.
    const o = run({ ...bash('git push up feat/x; git push origin main'), cwd: '/elsewhere/app' }, { throwIn: '/elsewhere' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-C1 (cost): a PR create whose judging throws keeps today\'s result (decisions.enforce true: deny)', () => {
    // Breaks when: the item 18 change alters a command with no push.
    const o = run(bash(`gh pr create --repo ${REPO} --head feat/x --base main --title t --body b`), { throwIn: '/repo' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/could not verify/);
  });

  it('R18-C2 (cost): a command with no gated shape whose git throws is still allowed', () => {
    // Breaks when: the new catch denies a call that holds no push, create, land or merge.
    expect(run(bash('git status && ls'), { throwIn: '/repo' })).toEqual({});
  });
});

/**
 * C2: a merge names its head sha in one known way, once. The head is read only from the --match-head-commit token of gh pr merge, or the
 * sha field (-f, -F, --raw-field, --field, with = or a space) of gh api .../pulls/<n>/merge. Text inside a value (--body, commit_message)
 * is never read. Two different values, a flag with no literal 40-hex value, an unpaired quote or an unknown gh pr merge flag: merge-no-head.
 *   - R3-c: --match-head-commit A --match-head-commit B                     -> C2-1 (red today: judged at A, gh uses B)
 *   - F-5: --body "sha=<tapped>" and no head flag                           -> C2-2 (red today: the sha is read from the body)
 *   - api commit_message="sha=<tapped>" -f sha=<other> (not in the list)    -> C2-3 (class)
 *   - a sha value that is a variable                                        -> C2-4
 *   - an unknown gh pr merge flag, an unpaired quote                        -> C2-5, C2-6
 *   - costs: the same sha twice, the = form, the api field forms still pass -> C2-C1..C3
 */
const OTHER = 'b'.repeat(40);
function tap(step: Step, key: string, head: string, label: string): void {
  expect(offerWrite({ step, key, head, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}
const landTap = (n: number) => tap('land', `${REPO}#${n}`, HEAD, 'Land now (Recommended)');
const verdictOf = (command: string) => decide(bash(command), deps());
const patternOf = (command: string): string => { const d = verdictOf(command); return d.action === 'deny' ? d.pattern : 'allow'; };
const MERGE = 'gh pr merge';

describe('C2: the merge head is read from one known place, once', () => {
  it('C2-1 (R3-c): two different --match-head-commit values deny merge-no-head', () => {
    // Breaks when: the sha is the first match of a regex over the segment (gh takes the LAST value).
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --match-head-commit ${OTHER}`)).toBe('merge-no-head');
  });
  it('C2-2 (F-5): a sha= inside --body is not a head: merge-no-head', () => {
    // Breaks when: the sha is read from any sha= text of the segment.
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --body "sha=${HEAD}"`)).toBe('merge-no-head');
  });
  it('C2-3 (class): an api merge whose commit_message holds sha=<tapped> and whose sha field is another head denies', () => {
    // Breaks when: a sha= inside another field value is read as the head.
    landTap(5);
    expect(verdictOf(`gh api repos/${REPO}/pulls/5/merge -X PUT -f commit_message="sha=${HEAD}" -f sha=${OTHER}`).action).toBe('deny');
  });
  it('C2-3b (class): an api merge with sha=<tapped> only inside commit_message names no head: merge-no-head', () => {
    // Breaks when: any sha= text of a field value is read as the head (today: the tapped head is read and the merge passes).
    landTap(5);
    expect(patternOf(`gh api repos/${REPO}/pulls/5/merge -X PUT -f commit_message="sha=${HEAD}" -f merge_method=squash`)).toBe('merge-no-head');
  });
  it('C2-4: a sha value that is not a literal (a variable, a substitution) denies merge-no-head', () => {
    landTap(5);
    for (const v of ['$SHA', '"$SHA"', '$(git rev-parse HEAD)', '`git rev-parse HEAD`', '%SHA%']) {
      expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${v}`), v).toBe('merge-no-head');
    }
  });
  it('C2-5: an unknown gh pr merge flag denies merge-no-head (the reader cannot know what it takes)', () => {
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --weird x`)).toBe('merge-no-head');
  });
  it('C2-6: an unpaired quote in the merge command denies merge-no-head', () => {
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --body "open`)).toBe('merge-no-head');
  });
  it('C2-C1 (cost): the same sha given twice still passes with the tap', () => {
    // Breaks when: a repeat of ONE value is treated as two values.
    landTap(5);
    expect(verdictOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --match-head-commit=${HEAD}`).action).toBe('allow');
  });
  it('C2-C2 (cost): the plain forms still pass with the tap (space, =, quoted)', () => {
    landTap(5);
    for (const c of [`${MERGE} 5 --squash --match-head-commit ${HEAD}`, `${MERGE} 5 --squash --match-head-commit=${HEAD}`, `${MERGE} 5 --squash --match-head-commit "${HEAD}" --body "ok"`]) {
      expect(verdictOf(c).action, c).toBe('allow');
    }
  });
  it('C2-C4 (cost, named in the PR body): a merge that only shows with its quotes deleted (gh pr "merge") is merge-no-head even with the tap', () => {
    // Breaks when: the head is read from the quotes-deleted view, whose words are not what gh gets.
    landTap(5);
    expect(patternOf(`gh pr "merge" 5 --squash --match-head-commit ${HEAD}`)).toBe('merge-no-head');
  });
  it('C2-C5 (cost): a short-flag cluster of known flags still passes (-sd, -dR <repo>)', () => {
    // Breaks when: a cluster of known short flags is read as an unknown flag.
    landTap(5);
    expect(verdictOf(`${MERGE} 5 -sd --match-head-commit ${HEAD}`).action).toBe('allow');
    expect(verdictOf(`${MERGE} 5 -sdR ${REPO} --match-head-commit ${HEAD}`).action).toBe('allow');
  });
  it('C2-C3 (cost): the api sha field forms still pass with the tap', () => {
    landTap(5);
    for (const f of [`-f sha=${HEAD}`, `-F sha=${HEAD}`, `--raw-field sha=${HEAD}`, `--raw-field=sha=${HEAD}`, `--field sha=${HEAD}`, `-f "sha=${HEAD}"`, `-fsha=${HEAD}`]) {
      const c = `gh api repos/${REPO}/pulls/5/merge -X PUT ${f} -f merge_method=squash`;
      expect(verdictOf(c).action, c).toBe('allow');
    }
  });
});

/**
 * C2 seat findings (delta read of 429ca031, 2026-11-15): one rule, a character the merge reader does not model makes the head unread.
 *   - (a) a word the shell can expand ($VAR, "$VAR", $(...), `...`, {a,b}, a glob, @splat) can become more flags, a second head among them
 *   - (b) PowerShell quoting: a backtick escapes a quote, a backslash does not, so the words gh gets differ from the bash pairing
 *   - doubled single quotes split the same in bash and PowerShell: a green test, no change
 */
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', session_id: 'r3-test' });
const patternIn = (input: object): string => { const d = decide(input, deps()); return d.action === 'deny' ? d.pattern : 'allow'; };

describe('C2 seat findings: a character the merge reader does not model makes the head unread', () => {
  it('C2-7 (a): an expandable word in a gh pr merge segment denies merge-no-head, for Bash and PowerShell', () => {
    // Breaks when: cliMergeHead skips a word that does not start with a dash, so a word the shell turns into a second head is not read.
    landTap(5);
    for (const extra of ['$EXTRA', '"$EXTRA"', '$(cat f)', '`cat f`', '{--match-head-commit,x}', '--match-head-commi?', '--m*', '${EXTRA}']) {
      const c = `${MERGE} 5 --squash --match-head-commit ${HEAD} ${extra}`;
      expect(patternIn(bash(c)), `bash ${extra}`).toBe('merge-no-head');
    }
    for (const extra of ['$EXTRA', '@EXTRA', '$(Get-Content f)', '"$EXTRA"']) {
      const c = `${MERGE} 5 --squash --match-head-commit ${HEAD} ${extra}`;
      expect(patternIn(pwsh(c)), `pwsh ${extra}`).toBe('merge-no-head');
    }
  });
  it('C2-7b (a, api): an expandable word in a gh api merge segment denies merge-no-head', () => {
    // Breaks when: apiMergeHead skips a word that is not a field flag, so an expansion that becomes -f sha=<other> is not read.
    landTap(5);
    for (const extra of ['$EXTRA', '$(cat f)', '"$EXTRA"', '{-f,sha=x}']) {
      expect(patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} ${extra}`)), extra).toBe('merge-no-head');
    }
  });
  it('C2-C8 (cost): the gh placeholders {owner}/{repo} in the api path still pass with the tap', () => {
    // Breaks when: the rule reads gh's own placeholders (no comma: bash does not expand them) as a brace expansion.
    landTap(5);
    expect(patternIn(bash(`gh api repos/{owner}/{repo}/pulls/5/merge -X PUT -f sha=${HEAD}`))).toBe('allow');
  });
  it('C2-8 (b): a PowerShell backtick quote or a backslash before a quote denies merge-no-head', () => {
    // Breaks when: the reader pairs quotes by bash rules only. PowerShell: `" is a literal quote and \ escapes nothing, so a second head
    // that the bash pairing reads as --body text is a real flag for gh (gh takes the last head).
    landTap(5);
    const tick = `${MERGE} 5 --squash --match-head-commit ${HEAD} --body \`"x --match-head-commit ${OTHER} --body y\`"`;
    const slash = `${MERGE} 5 --squash --match-head-commit ${HEAD} --body "x\\" --match-head-commit ${OTHER} \\"y"`;
    for (const c of [tick, slash]) {
      expect(patternIn(pwsh(c)), `pwsh ${c}`).toBe('merge-no-head');
      expect(patternIn(bash(c)), `bash ${c}`).toBe('merge-no-head');
    }
  });
  it('C2-C6 (cost, green today): doubled single quotes split the same in bash and PowerShell, so the one head still passes', () => {
    // Breaks when: a fix for (b) treats '' as unmodelled. Both shells read 'x '' --match-head-commit B '' y' as ONE body word.
    landTap(5);
    const c = `${MERGE} 5 --squash --body 'it''s x '' --match-head-commit ${OTHER} '' y' --match-head-commit ${HEAD}`;
    expect(patternIn(pwsh(c))).toBe('allow');
    expect(patternIn(bash(c))).toBe('allow');
  });
  it('C2-9 (seat delta i): a word that opens a comment (#) makes the head unread: the shell drops the head flag after it', () => {
    // Breaks when: a # word is read as text, so the gate reads a tapped head that gh never gets (gh then merges with no head check).
    landTap(5);
    expect(patternIn(bash(`${MERGE} 5 --squash # --match-head-commit ${HEAD}`))).toBe('merge-no-head');
    expect(patternIn(pwsh(`${MERGE} 5 --squash #x --match-head-commit ${HEAD}`))).toBe('merge-no-head');
    expect(patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT # -f sha=${HEAD}`))).toBe('merge-no-head');
  });
  it('C2-10 (seat delta ii): a redirect word with no target takes the next word as its file name', () => {
    // Breaks when: a lone > is skipped as a word, so the next word (--match-head-commit) is read as a flag; the shell makes it a file name.
    landTap(5);
    expect(patternIn(bash(`${MERGE} 5 --squash > --match-head-commit ${HEAD}`))).toBe('merge-no-head');
    expect(patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT 2> -f sha=${HEAD}`))).toBe('merge-no-head');
  });
  it('C2-10b (seat delta ii): a separator in the merge text cuts it before the reader, so a head after it is not the merge head', () => {
    // Breaks when: MERGE_CLI_RE reads past ; && || | or a newline (a head of the NEXT command would be read as the merge head).
    landTap(5);
    for (const sep of [';', '&&', '||', '|', '\n']) {
      expect(patternIn(bash(`${MERGE} 5 --squash ${sep} echo --match-head-commit ${HEAD}`)), JSON.stringify(sep)).toBe('merge-no-head');
    }
  });
  it('C2-11 (seat delta iii): a curly quote makes the head unread: PowerShell takes it as a quote, the reader does not', () => {
    // Breaks when: curly quotes are plain text to the reader, so a head flag inside a PowerShell string is read as a flag.
    landTap(5);
    for (const [o, c] of [['‘', '’'], ['“', '”'], ['„', '”']]) {
      // The closing quote stands alone: the head value stays a clean 40-hex word, so only the quote rule can deny it.
      expect(patternIn(pwsh(`${MERGE} 5 --squash --body ${o}x --match-head-commit ${HEAD} ${c}`)), o).toBe('merge-no-head');
      expect(patternIn(pwsh(`gh api repos/${REPO}/pulls/5/merge -X PUT -f merge_method=${o}squash -f sha=${HEAD} ${c}`)), o).toBe('merge-no-head');
    }
  });
  it('C2-C9 (cost, seat ruling A): any redirect in the merge text (2>err.txt, 2>&1) now makes the head unread', () => {
    // Breaks when: the allowlist lets < > or a lone & through (the & of 2>&1 cuts the segment before a later head: pre-read finding 1).
    landTap(5);
    expect(patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>err.txt`))).toBe('merge-no-head');
    expect(patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>&1`))).toBe('merge-no-head');
  });
  it('C2-12 (pre-read 1): a head after 2>&1 or &>log is read: the & of a redirect does not end the merge text', () => {
    // Breaks when: the head is read from the segment cut at &, so gh takes OTHER (the last) while the gate read TAPPED.
    landTap(5);
    for (const tool of [bash, pwsh]) {
      expect(patternIn(tool(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>&1 --match-head-commit ${OTHER}`))).toBe('merge-no-head');
      expect(patternIn(tool(`${MERGE} 5 --squash --match-head-commit ${HEAD} &>log --match-head-commit ${OTHER}`))).toBe('merge-no-head');
      expect(patternIn(tool(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} 2>&1 -f sha=${OTHER}`))).toBe('merge-no-head');
    }
  });
  it('C2-13 (pre-read 2): an attached or unknown api field flag (-fsha=, -Fsha=, -f=sha=, -if sha=) makes the head unread', () => {
    // Breaks when: apiMergeHead skips a dash word it does not know, so a second sha in an attached form is never read.
    landTap(5);
    for (const f of [`-fsha=${OTHER}`, `-Fsha=${OTHER}`, `-f=sha=${OTHER}`, `-if sha=${OTHER}`]) {
      expect(patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} ${f}`)), f).toBe('merge-no-head');
    }
  });
  it('C2-14 (pre-read 3, 4): a non-ASCII space, a \\v or \\f, or a lone CR makes the head unread', () => {
    // Breaks when: pairedWords splits on every JS \s (NBSP and the Unicode spaces are word characters for bash), or a lone CR is a
    // segment break for the gate and a word character for bash.
    landTap(5);
    for (const sp of [' ', ' ', '\v', '\f', '\r']) {
      expect(patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} --body x${sp}y`)), JSON.stringify(sp)).toBe('merge-no-head');
      expect(patternIn(bash(`gh pr create --head feat/x --title a${sp}b`)), `create ${JSON.stringify(sp)}`).toBe('head-unresolved');
    }
  });
  it('C2-16 (allowlist, inside quotes): a curly quote inside an ASCII double-quoted word makes the head unread', () => {
    // Breaks when: non-ASCII is allowed inside quotes. PowerShell closes "x“ at the curly quote and joins the rest into ONE word, so gh
    // gets no head flag while the gate reads the tapped one.
    landTap(5);
    expect(patternIn(pwsh(`${MERGE} 5 --squash --body "x“" --match-head-commit ${HEAD} "y”"`))).toBe('merge-no-head');
  });
  it('C2-15 (pre-read 6): a positional glob, brace, paren or comma word makes the head unread', () => {
    // Breaks when: the allowlist lets * ? [ ] { } ( ) or , through outside quotes.
    landTap(5);
    for (const w of ['x*', 'x?', '[x]', '{x}', '(x)', 'a,b']) {
      expect(patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} ${w}`)), w).toBe('merge-no-head');
    }
  });
  it('C2-C7b (cost): a $ or a glob inside single quotes is literal in both shells (api form)', () => {
    landTap(5);
    expect(patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} -f commit_message='costs $5 (*)'`))).toBe('allow');
  });
  it('C2-C7 (cost): a $ or a glob inside single quotes is literal in both shells and still passes', () => {
    // Breaks when: the rule reads characters inside single quotes as expandable.
    landTap(5);
    const c = `${MERGE} 5 --squash --body 'costs $5 (*)' --match-head-commit ${HEAD}`;
    expect(patternIn(bash(c))).toBe('allow');
    expect(patternIn(pwsh(c))).toBe('allow');
  });
});

/**
 * C1: a create names its head and base in one known way, once. gh pr create / gh pr new: --head, --head=, -H (else the checked-out branch),
 * --base, --base=, -B; every word belongs to the known flag set; -F is --body-file. gh api .../pulls POST: the head and base fields (-f, -F,
 * --raw-field, --field; space or =). head-unresolved for --input, a field from a file (=@), head_repo, two values, an unknown flag or field,
 * a value that is not literal, an unpaired quote. In the fake checkout every branch resolves to HEAD; the checked-out branch is feat/x.
 *   - R3-a: gh pr create --input <file>                       -> C1-1 (red today: the checked-out branch is judged, its tap passes)
 *   - F-2: gh pr new ...                                      -> C1-2 (red today: not seen as a create)
 *   - F-3: gh api .../pulls --raw-field=head=topic            -> C1-3 (red today: the = form is not read, feat/x is judged)
 *   - F-4: gh pr create -F head=approved                      -> C1-4 (red today: read as head `approved`)
 *   - class (not in the list): --head a -H b, -F head=@h.txt, head_repo, an unknown flag, a variable head, an unpaired quote -> C1-5..C1-9
 */
const API_CREATE = `gh api repos/${REPO}/pulls -X POST`;
const openTap = (branch: string) => tap('open-pr', decisionKey({ branch }), HEAD, 'Open draft PR (Recommended)');

describe('C1: a create names its head and base in one known way, once', () => {
  it('C1-1 (R3-a): --input on gh pr create or on the api create is head-unresolved, even with a tap for the checked-out branch', () => {
    // Breaks when: an unknown create flag (or the api --input body file) leaves the head to fall back to the checked-out branch.
    openTap('feat/x');
    expect(patternOf('gh pr create --input body.json --title t')).toBe('head-unresolved');
    expect(patternOf(`${API_CREATE} --input body.json`)).toBe('head-unresolved');
  });
  it('C1-2 (F-2): gh pr new is a create (the gate and the review-loop reader)', () => {
    // Breaks when: PR_CREATE_RE / the create reader match only `create`.
    expect(isPrOpenCommand('gh pr new --head feat/y --base main --title t')).toBe(true);
    expect(patternOf('gh pr new --head feat/y --base main --title t')).toBe('open-pr');
  });
  it('C1-3 (F-3): the --raw-field=head= and --field=head= forms are read as the head', () => {
    // Breaks when: HEAD_FIELD_RE takes only the space form, so the checked-out branch (tapped) is judged in place of `topic`.
    openTap('feat/x');
    for (const f of ['--raw-field=head=topic', '--field=head=topic']) {
      expect(patternOf(`${API_CREATE} ${f} -f base=main -f title=t`), f).toBe('open-pr');
    }
    openTap('topic');
    expect(verdictOf(`${API_CREATE} --raw-field=head=topic -f base=main -f title=t`).action).toBe('allow');
  });
  it('C1-4 (F-4): -F on gh pr create is the body file, never a head field', () => {
    // Breaks when: -F head=<x> is read as a head on gh pr create (a tap for `approved` then opens feat/x).
    openTap('approved');
    expect(patternOf('gh pr create -F head=approved --title t')).toBe('open-pr');
  });
  it('C1-5 (class): two different heads on gh pr create (--head a -H b) are head-unresolved in a CCv3 checkout', () => {
    // Breaks when: the CCv3 path reads the first head while gh takes the last.
    openTap('feat/a');
    expect(patternOf('gh pr create --head feat/a -H feat/b --title t')).toBe('head-unresolved');
    expect(patternOf(`${API_CREATE} -f head=feat/a -f head=feat/b -f base=main`)).toBe('head-unresolved');
  });
  it('C1-6 (class): a head or base field from a file (=@) is head-unresolved', () => {
    openTap('feat/x');
    expect(patternOf(`${API_CREATE} -F head=@h.txt -f base=main -f title=t`)).toBe('head-unresolved');
    expect(patternOf(`${API_CREATE} -f head=feat/x -F base=@b.txt -f title=t`)).toBe('head-unresolved');
  });
  it('C1-7 (class, seat 2026-11-14): a head_repo field is head-unresolved', () => {
    // Breaks when: head_repo (a branch of another repository) is ignored and the tap for the local branch passes.
    openTap('feat/x');
    expect(patternOf(`${API_CREATE} -f head=feat/x -f head_repo=someone/fork -f base=main -f title=t`)).toBe('head-unresolved');
  });
  it('C1-8 (class): an unknown flag on gh pr create or an unknown field on the api create is head-unresolved', () => {
    openTap('feat/x');
    expect(patternOf('gh pr create --some-new-flag x --title t')).toBe('head-unresolved');
    expect(patternOf(`${API_CREATE} -f head=feat/x -f base=main -f odd=1`)).toBe('head-unresolved');
  });
  it('C1-9 (class): a head that is not literal, or an unpaired quote, is head-unresolved', () => {
    openTap('feat/x');
    for (const c of ['gh pr create --head $B --title t', 'gh pr create --head %B% --title t', 'gh pr create --title "open', `${API_CREATE} -f head=$B -f base=main`]) {
      expect(patternOf(c), c).toBe('head-unresolved');
    }
  });
  it('C1-10 (pre-read 1): a head after 2>&1 on gh pr create is read (CCv3 path, which reads the &-cut text)', () => {
    openTap('feat/a');
    expect(patternOf('gh pr create --head feat/a --title t 2>&1 --head feat/b')).toBe('head-unresolved');
  });
  it('C1-11 (advisor 3): an api create whose quoted title holds "gh pr new" is read by the api reader', () => {
    // Breaks when: createRead takes the CLI reader when gh pr new|create appears anywhere, so the api head fields are not read.
    openTap('feat/x');
    expect(patternOf(`${API_CREATE} -f head=topic -f base=main -f title="use gh pr new"`)).toBe('open-pr');
  });
  it('C1-C3 (cost, seat ruling 7): a heredoc body or a backslash path denies, and the deny text names the way out', () => {
    // Breaks when: the deny text stops naming --body-file and -F body=@ (the way out of the cost).
    openTap('feat/x');
    const d = verdictOf(`gh pr create --head feat/x --title t --body "$(cat <<'EOF'\nx\nEOF\n)"`);
    expect(d.action === 'deny' && d.pattern).toBe('head-unresolved');
    expect(d.action === 'deny' && d.reason).toMatch(/--body-file <path>/);
    expect(patternOf('gh pr create --head feat/x --title t --body-file C:\\tmp\\b.md')).toBe('head-unresolved');
    expect(verdictOf("gh pr create --head feat/x --title t --body-file 'C:/tmp/b.md'").action).toBe('allow');
  });
  it('C1-12 (seat item 3): a backslash inside a path passes for the PowerShell tool only; next to a quote it is refused in every tool', () => {
    // Breaks when: the PowerShell fact is lost (pwsh path refused), reaches Bash (bash path passes), or lets a backslash-quote through.
    openTap('feat/x');
    const body = '-F body=@C:\\Users\\me\\pr-body.md';
    expect(verdictOf(`${API_CREATE} -f head=feat/x -f base=main -f title=t ${body}`).action).toBe('deny');
    expect(patternIn(pwsh(`${API_CREATE} -f head=feat/x -f base=main -f title=t ${body}`))).toBe('allow');
    expect(patternIn(pwsh(`${API_CREATE} -f head=feat/x -f base=main -f title="a\\" -f head=feat/y"`))).toBe('head-unresolved');
    expect(patternIn(pwsh(`${API_CREATE} -f head=feat/x -f base=main -f title='a\\' -F body=@C:\\b.md`))).toBe('head-unresolved');
    expect(patternIn(pwsh(`gh pr create --head feat/x --title t --body-file 'C:\\tmp\\b.md'`))).toBe('allow');
  });
  it('C1-C4 (seat item 2): the deny texts name the way out for a redirect and for a variable', () => {
    openTap('feat/x');
    const d = verdictOf('gh pr create --head feat/x --title t 2>&1');
    expect(d.action === 'deny' && d.reason).toMatch(/run the call with no redirect/);
    expect(d.action === 'deny' && d.reason).toMatch(/put the value in the command as plain text or use a body file/);
    landTap(5);
    const m = verdictOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>&1`);
    expect(m.action === 'deny' && m.reason).toMatch(/run the call with no redirect/);
  });
  it('C1-C1 (cost): the plain gh pr create forms still pass with the tap', () => {
    // Breaks when: a known flag or form of the plain create is read as unknown.
    openTap('feat/x');
    for (const c of [
      'gh pr create --head feat/x --base main --title "a b" --body "c d" --draft',
      'gh pr create --head=feat/x --base=main -t t -b b',
      'gh pr create -H feat/x -B main -t t -F body.md -l bug -a me -r you',
      'gh pr create --title t --body-file b.md --fill',
      'gh pr create -dF b.md --title t',
      `gh pr create -R ${REPO} --title t`,
      'gh pr new --title t --body b',
    ]) expect(verdictOf(c).action, c).toBe('allow');
  });
  it('C1-C2 (cost): the plain api create forms still pass with the tap', () => {
    openTap('feat/x');
    for (const c of [
      `${API_CREATE} -f head=feat/x -f base=main -f title=t -F body=@b.md`,
      `gh api repos/${REPO}/pulls --method POST --raw-field=head=feat/x --field base=main -f title=t -F draft=true`,
      `gh api repos/{owner}/{repo}/pulls -X POST -f head=feat/x -f base=main -f title="a b" -f body='c $d'`,
    ]) expect(verdictOf(c).action, c).toBe('allow');
  });
});
