/**
 * C2d fix round (seat word 06:40 CST 11-27, Dave chose B). One rule for six holes: a gh call whose subcommand, verb or api endpoint word has no literal,
 * a land script word with no literal, and a CleanupOnly switch inside a word with no literal are an UNREAD HEAD. They fail closed: the create, land or
 * merge deny at its rank. Each hole row has a literal control that keeps its verdict.
 *   U1 H1  a REST PR create through gh api with a shell variable in the repo path (aegis, regression against main)
 *   U2 a brace suffix that builds the merge verb          (gh pr {merg,-b}e 7)
 *   U3 a brace suffix that builds the create verb         (gh pr {creat,-b}e ...)
 *   U4 a brace suffix that builds the land script path    (pwsh -File scripts/github/land-pr.p{s1,}  -Pr 7)
 *   U5 a parameter-expansion verb                         (gh pr ${x:-merge} 7)
 *   U6 -CleanupOnly hidden in a command substitution inside another word (a land with no tap)
 * Every row runs the real parse (withParsed) and the real rule (decide), as in shell-parser-c2c-holes.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 120000 });
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const R = `repos/${REPO}`;
const HEAD = 'a'.repeat(40);
let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shell-parser-c2d-uh-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

function deps(): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null),
    git: (_cwd: string, args: string[]) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (a.startsWith('rev-parse feat/x')) return { status: 0, stdout: `${HEAD}\n` };
      return { status: 1, stdout: '' };
    },
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  } as unknown as Deps;
}
function tap(step: Step, key: string, label: string): void {
  expect(offerWrite({ step, key, head: HEAD, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head: HEAD, label })).toEqual({ ok: true });
}
const landTap = (n: number) => tap('land', `${REPO}#${n}`, 'Land now (Recommended)');
const openTap = () => tap('open-pr', `${REPO}@feat/x`, 'Open draft PR (Recommended)');
type Tool = 'Bash' | 'PowerShell';
async function verdict(command: string, tool: Tool = 'Bash'): Promise<string> {
  const inp = { tool_name: tool, tool_input: { command }, cwd: '/repo', session_id: 'c2d-uh' };
  const d = decide(inp, { ...(await withParsed(JSON.stringify(inp), deps())) } as Deps);
  return d.action === 'deny' ? `deny:${d.pattern}` : typeof d.warn === 'string' ? 'warn' : 'allow';
}
const denied = (v: string): boolean => v.startsWith('deny:');
const LAND = 'scripts/github/land-pr.ps1';
const MERGE_TAIL = `--squash --match-head-commit ${HEAD}`;

describe('U: an unread head (a word with no literal) fails closed at its rank', () => {
  // Change that breaks it: createCallOf (decision-gate.ts) skips a non-literal api endpoint and returns null, or the verb detector reads only literal words.
  const holes: [string, Tool, string][] = [
    ['U1 H1 gh api create, a variable in the repo path (Bash)', 'Bash', `O=Rev4nchist; Rp=Continuous-Claude-v3; gh api repos/$O/$Rp/pulls -X POST -f head=feat/x -f base=main -f title=t`],
    ['U1b H1 gh api create, a variable in the repo path (PowerShell)', 'PowerShell', '$O="Rev4nchist"; $Rp="Continuous-Claude-v3"; gh api repos/$O/$Rp/pulls -X POST -f head=feat/x -f base=main -f title=t'],
    // A variable that the same text assigns a literal is read by the parse (a create of feat/x, covered by the open tap): not a hole. An unassigned variable is.
    ['U1c H1 gh api create, an unassigned variable is the whole endpoint', 'Bash', 'gh api "$ENDPOINT" -X POST -f head=feat/x -f base=main -f title=t'],
    // Seat note 07:09: endpoint forms that a last-segment test can miss. Change that breaks it: the tail is read after a split on "/" with no trailing slash or query strip.
    ['U1d H1 variable repo path, pulls/ with a trailing slash', 'Bash', 'gh api repos/$O/$Rp/pulls/ -X POST -f head=feat/x -f base=main -f title=t'],
    ['U1e H1 variable repo path, pulls with a query string that holds a slash', 'Bash', 'gh api "repos/$O/$Rp/pulls?base=a/b" -X POST -f head=feat/x -f base=main -f title=t'],
    ['U1f H1 variable repo path, pulls with a query string', 'Bash', 'gh api "repos/$O/$Rp/pulls?state=open" -X POST -f head=feat/x -f base=main -f title=t'],
    ['U1g H1 all-variable endpoint (PowerShell, bare)', 'PowerShell', 'gh api $EP -X POST -f head=feat/x -f base=main -f title=t'],
    ['U1h merge endpoint with a variable repo path and -X PUT', 'Bash', 'gh api -X PUT repos/$O/$Rp/pulls/5/merge'],
    ['U2 k1a a brace suffix builds the merge verb', 'Bash', 'gh pr {merg,-b}e --squash 9'],
    ['U3 k1b a brace suffix builds the create verb', 'Bash', 'gh pr {creat,-t}e -b x'],
    ['U4 k1c a brace suffix builds the land script path', 'Bash', 'pwsh -File {scripts/github/land-pr.ps,-Pr:74}1'],
    ['U5 k2a a parameter-expansion verb', 'Bash', 'gh pr ${x:-merge} 9 --squash'],
    ['U6 k7 -CleanupOnly inside another word (a substitution), a land of PR 9 with no tap', 'PowerShell', "& ./scripts/github/land-pr.ps1 -Pr 9 -Repo \"Rev4nchist/Continuous-Claude-v3$(' -CleanupOnly' * 0)\""],
  ];
  it.each(holes)('%s: denied with no tap', async (_n, tool, text) => {
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
  it.each(holes)('%s: denied even with a land tap and an open tap', async (_n, tool, text) => {
    landTap(7);
    openTap();
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
});

describe('V: the raw-text backstop for gh api (seat replan 11-27 07:31, Dave chose it)', () => {
  // A gh api call whose raw text names a pulls segment and that has ANY word with no literal fails closed at the create rank (scope other, no tap clears it),
  // except one narrow read: no method flag, no field or input flag, and the only word with no literal is the endpoint (a slash, a literal part, a variable owner or repo).
  // Change that breaks it: createCallOf reads the method or a field only from literal words, so a word with no literal hides the write.
  const F = '-f head=feat/x -f base=main -f title=t';
  const holes: [string, Tool, string][] = [
    ['P1a a method word with no literal, variable repo path (Bash)', 'Bash', `gh api -X $M repos/$O/$Rp/pulls ${F}`],
    ['P1b --method with a variable, quoted variable path (Bash)', 'Bash', `gh api --method $M "repos/$O/$Rp/pulls" ${F}`],
    ['P1c a method word with no literal, LITERAL repo path (Bash)', 'Bash', `gh api -X $M ${R}/pulls ${F}`],
    ['P1d -X "$M" with a trailing slash (Bash)', 'Bash', `gh api -X "$M" repos/$O/$Rp/pulls/ ${F}`],
    ['P1e a method word with no literal (PowerShell)', 'PowerShell', `gh api -X $m repos/$o/$rp/pulls ${F}`],
    ['P1f --method with a variable (PowerShell)', 'PowerShell', `gh api --method $m repos/$o/$rp/pulls ${F}`],
    ['V1 --method=$M in one word (Bash)', 'Bash', `gh api --method=$M repos/$O/$Rp/pulls ${F}`],
    ['V2 a read plus one bare variable word after the endpoint (Bash)', 'Bash', 'gh api repos/$O/$Rp/pulls/705 $EXTRA'],
    ['V3 a read plus one bare variable word after the endpoint (PowerShell)', 'PowerShell', 'gh api repos/$o/$rp/pulls/705 $extra'],
    ['V4 a PowerShell splat of an args array, variable repo path', 'PowerShell', 'gh api repos/$o/$rp/pulls @args'],
    ['V5 a PowerShell splat of an args array, literal repo path', 'PowerShell', `gh api repos/${REPO}/pulls @args`],
    ['V6 a variable field value with a literal path (Bash)', 'Bash', `gh api -X POST repos/${REPO}/pulls -f head=$B -f base=main -f title=t`],
    ['V7 a variable field value with a literal path (PowerShell)', 'PowerShell', `gh api -X POST repos/${REPO}/pulls -f head=$b -f base=main -f title=t`],
    ['V8 an unquoted variable title (it splits into more words)', 'Bash', `gh api -X POST repos/${REPO}/pulls -f head=feat/x -f base=main -f title=$T`],
  ];
  it.each(holes)('%s: denied with no tap', async (_n, tool, text) => {
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
  it.each(holes)('%s: denied even with a land tap and an open tap', async (_n, tool, text) => {
    landTap(7);
    openTap();
    expect(denied(await verdict(text, tool)), `${tool}: ${text}`).toBe(true);
  });
  const reads: [string, Tool, string][] = [
    ['VC1 a read with a variable repo path and no method or field flag (Bash)', 'Bash', 'gh api repos/$O/$Rp/pulls/705 --jq .title'],
    ['VC2 a read with a variable repo path and no method or field flag (PowerShell)', 'PowerShell', 'gh api repos/$o/$rp/pulls/705 --jq .title'],
    ['VC3 a paginated read with a variable repo path', 'Bash', 'gh api repos/$O/$Rp/pulls --paginate --jq ".[].number"'],
  ];
  it.each(reads)('%s: allowed with no tap and with taps', async (_n, tool, text) => {
    expect(await verdict(text, tool), `${tool}: ${text}`).toBe('allow');
    landTap(7);
    openTap();
    expect(await verdict(text, tool), `${tool} (taps): ${text}`).toBe('allow');
  });
  it('VC4 a literal POST create: denied with no tap, allowed with the open tap (as today)', async () => {
    const text = `gh api -X POST repos/${REPO}/pulls ${F}`;
    expect(denied(await verdict(text))).toBe(true);
    openTap();
    expect(await verdict(text)).toBe('allow');
  });
  it('VC5 a literal POST create in PowerShell: denied with no tap, allowed with the open tap (as today)', async () => {
    const text = `gh api -X POST repos/${REPO}/pulls ${F}`;
    expect(denied(await verdict(text, 'PowerShell'))).toBe(true);
    openTap();
    expect(await verdict(text, 'PowerShell')).toBe('allow');
  });
});

describe('UC: literal controls keep their verdict (the fix must not widen the deny)', () => {
  it('UC1 a literal api create with the open tap: allowed', async () => {
    openTap();
    expect(await verdict(`gh api ${R}/pulls -X POST -f head=feat/x -f base=main -f title=t`)).toBe('allow');
  });
  it('UC1b a literal api create with no tap: denied', async () => {
    expect(denied(await verdict(`gh api ${R}/pulls -X POST -f head=feat/x -f base=main -f title=t`))).toBe(true);
  });
  it('UC1c a read-only gh api GET with a variable repo path: allowed', async () => {
    expect(await verdict('gh api repos/$O/$Rp/pulls/705 --jq .title')).toBe('allow');
  });
  it('UC2 the literal merge with the land tap: allowed', async () => {
    landTap(7);
    expect(await verdict(`gh pr merge 7 ${MERGE_TAIL}`)).toBe('allow');
  });
  it('UC2b the literal merge with no tap: denied', async () => {
    expect(denied(await verdict(`gh pr merge 7 ${MERGE_TAIL}`))).toBe(true);
  });
  it('UC3 the literal create with the open tap: allowed', async () => {
    openTap();
    expect(await verdict('gh pr create --head feat/x --base main -t t -b b')).toBe('allow');
  });
  it('UC4 the literal land script with the land tap: allowed', async () => {
    landTap(7);
    expect(await verdict(`pwsh -File ${LAND} -Pr 7`)).toBe('allow');
  });
  it('UC6 the literal -CleanupOnly land call keeps the allow of main', async () => {
    expect(await verdict(`pwsh -File ${LAND} -Pr 12 -CleanupOnly`)).toBe('allow');
  });
  it('UC6b the literal -CleanupOnly:$true land call in PowerShell keeps the allow of main', async () => {
    expect(await verdict(`& ./${LAND} -Pr 9 -CleanupOnly:$true`, 'PowerShell')).toBe('allow');
  });
  it('UC2c a literal merge verb written with a quoted PR number and the land tap: allowed', async () => {
    landTap(9);
    expect(await verdict(`gh pr merge 9 ${MERGE_TAIL}`)).toBe('allow');
  });
  // Corpus cost rows: three real texts of the transcripts were denied by the first form of the rule. A literal last segment that is not pulls cannot be a create.
  it('UC8 a POST to an actions rerun endpoint with a variable run id: allowed', async () => {
    expect(await verdict('gh api -X POST "repos/Rev4nchist/Continuous-Claude-v3/actions/runs/$id/rerun-failed-jobs"')).toBe('allow');
  });
  // A named cost of the raw-text backstop (seat replan 07:31, Dave chose it): the raw text names pulls, the call has a field flag and words with no literal, so it fails closed. It was allowed before the replan.
  it('UC9 (named cost) a field POST to a PR comment reply endpoint with a variable repo: denied, as the raw-text rule says', async () => {
    expect(denied(await verdict('gh api "$repo/pulls/685/comments/$CID/replies" -f "body=$TEXT" --jq .id'))).toBe(true);
  });
  it('UC10 a literal api create with a trailing slash and the open tap: allowed', async () => {
    openTap();
    expect(await verdict(`gh api ${R}/pulls/ -X POST -f head=feat/x -f base=main -f title=t`)).toBe('allow');
  });
  it('UC11 a field POST to a variable path whose last segment is a literal other than pulls: allowed', async () => {
    expect(await verdict('gh api "repos/$O/$Rp/issues/$N/comments" -f body=x')).toBe('allow');
  });
  it('UC7 a gh call with no guarded verb and a variable word: allowed (gh pr view)', async () => {
    expect(await verdict('gh pr view $N --json title')).toBe('allow');
  });
});
