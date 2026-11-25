/**
 * decision-gate on the shared parser (card coord-guard-shell-parser, PR B, design note 63-design-note-pr-b.md): RED rows.
 * Each row names one round 3 Known limit or one deny-to-allow of the hand reader. Every row is a deny the hand reader misses today.
 * Failure modes, one row each:
 *   PB-1  a `$( )` inside double quotes in a pipe consumer after a push is read as data (round 3 limit, decision-gate.ts:2418)
 *   PB-3  a `heads/re/x` push source skips the re/ holdout scan (limit :2799; only `refs/heads/` is read)
 *   PB-5  a remote NAME that git config points at a local folder is not a local push (limit :2401)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionKey, decisionRecord, offerWrite } from '../shared/decisions-store.js';
import { decide, withParsed, type Deps } from '../decision-gate.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-pb-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

interface World {
  /** `git remote get-url <name>` answers with this text, by remote name. */
  remoteUrls?: Record<string, string>;
  /** The holdout scan seams: the id list, and the one line every outgoing diff adds. */
  scan?: { ids: string[]; added: string };
}

/** The shipped state: enforce true, enforcePush absent. A fake git for a CCv3 checkout at /repo. */
function deps(w: World = {}): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  const base = {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null),
    git: (cwd: string, args: string[]) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (w.scan && args[0] === 'log' && args.includes('--name-only')) return { status: 0, stdout: `\u0001c5\0${HEAD}\0\0src/x.ts\0` };
      if (w.scan && args[0] === 'log' && args.includes('-p')) return { status: 0, stdout: `\u0001c5 ${HEAD}\n a message\ndiff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+${w.scan.added}\n` };
      if (w.scan && args[0] === 'for-each-ref') return { status: 0, stdout: '' };
      if (w.scan && a.startsWith('ls-files')) return { status: 0, stdout: '' };
      if (a === 'rev-parse --abbrev-ref @{push}') return { status: 128, stdout: '' };
      const url = /^remote get-url (?:--push --all )?(\S+)$/.exec(a); // C1: the fetch URL and the push URLs read the same table
      if (url) { const u = w.remoteUrls?.[url[1]]; return u ? { status: 0, stdout: `${u}\n` } : { status: 2, stdout: '' }; }
      if (/^rev-parse (.+)\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse (.+)\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      if (a === 'write-tree') return { status: 0, stdout: `${'i'.repeat(40)}\n` };
      if (a === 'rev-parse --path-format=absolute --show-toplevel') return { status: 0, stdout: `${cwd.replace(/\\/g, '/').startsWith('/other') ? '/other' : '/repo'}\n` };
      return { status: 1, stdout: '' };
    },
    ...(w.scan ? { holdoutIds: () => w.scan!.ids, answerKeyHits: () => [] } : {}),
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  };
  return base as unknown as Deps;
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: 'pb-test' });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', session_id: 'pb-test' });
const shipTapOn = (tree: string) => {
  expect(offerWrite({ step: 'ship', key: decisionKey({ branch: 'feat/x' }), head: HEAD, tree, spec: { header: 'T', question: 'Q?', options: [{ label: 'Commit and push (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'ship', key: decisionKey({ branch: 'feat/x' }), head: HEAD, label: 'Commit and push (Recommended)' })).toEqual({ ok: true });
};
/** The verdict the way main reaches it: the text is parsed first (card coord-guard-shell-parser, port step 1), then decided. */
const decideParsed = async (input: object, d: Deps): Promise<ReturnType<typeof decide>> => decide(input, await withParsed(JSON.stringify(input), d));
/** The pattern of a deny, `warn:<first word>` of a soft deny that comes back as a warning, else allow. */
const patIn = async (input: object, w: World = {}): Promise<string> => {
  const d = await decideParsed(input, deps(w));
  if (d.action === 'deny') return d.pattern;
  return 'warn' in d && typeof d.warn === 'string' ? `warn:${d.warn.split(':')[0]}` : 'allow';
};

describe('PB-1: a substitution in a pipe consumer after a push is a state change', () => {
  it('PB-1 (limit :2418): a $( ) inside double quotes in the consumer is push-state-unknown', async () => {
    // Breaks when: the consumer check reads the quote-masked text, so the substitution inside "..." looks like a quoted word.
    shipTapOn(TREE);
    for (const c of ['git push fork feat/x | grep "$(git reset --hard other)"', 'git push fork feat/x | grep "`git reset --hard other`"']) {
      expect(await patIn(bash(c)), c).toBe('push-state-unknown');
    }
    expect(await patIn(pwsh('git push fork feat/x | Select-String "$(git reset --hard other)"'))).toBe('push-state-unknown');
  });
  it('PB-1c (cost): a quoted word with no substitution, and a single-quoted $( ), stay allowed', async () => {
    shipTapOn(TREE);
    expect(await patIn(bash('git push fork feat/x | grep "rejected"'))).toBe('allow');
    expect(await patIn(bash("git push fork feat/x | grep '$(git status)'"))).toBe('allow');
  });
});

describe('PB-3: a push source spelled heads/<b> is read as <b>', () => {
  const ID = 'HOLD-ID-1';
  const w: World = { scan: { ids: [ID], added: `see ${ID}` } };
  it('PB-3 (limit :2799): heads/re/x:feat/out is scanned for holdout ids like re/x:feat/out', async () => {
    // Breaks when: only refs/heads/ is stripped from a source, so heads/re/x is no re/ source and the scan is skipped.
    expect(await patIn(bash('git push fork re/x:feat/out'), w)).toBe('holdout-id');
    expect(await patIn(bash('git push fork heads/re/x:feat/out'), w)).toBe('holdout-id');
    expect(await patIn(bash('git push fork +heads/re/x:feat/out'), w)).toBe('holdout-id');
  });
  it('PB-3c (cost): heads/feat/z as a source is not a re/ scan', async () => {
    expect(await patIn(bash('git push fork heads/feat/z:feat/out'), { scan: { ids: [ID], added: `see ${ID}` } })).toBe('warn:ship');
  });
});

describe('PB-5: a remote name that git config points at a local folder is a local push', () => {
  it('PB-5 (limit :2401): `up` pointing at a path before a later push gives the local-push deny', async () => {
    // Breaks when: LOCAL_REMOTE tests only the word in the text (`up`), never the url git holds for that name.
    const w: World = { remoteUrls: { up: '/home/nobody/clone.git' } };
    shipTapOn(TREE);
    expect(await patIn(bash('git push up feat/x && git push fork feat/x'), w)).toBe('push-state-unknown');
  });
  it('PB-5c (cost): a name that points at a url keeps the old verdict', async () => {
    const w: World = { remoteUrls: { up: `https://github.com/${REPO}.git` } };
    shipTapOn(TREE);
    expect(await patIn(bash('git push up feat/x && git push fork feat/x'), w)).not.toBe('push-state-unknown');
  });
});

describe('PB-7: the AST rule for a doc append (note 03 section 1 items 3 and 4); the 57 rows of decision-gate-doc-append.test.ts stay the acceptance rows', () => {
  const denied = async (input: object): Promise<boolean> => (await decideParsed(input, deps())).action === 'deny';
  // Each is a named widening: today the isDocAppend anchored regex refuses it, the AST rule allows it. One red row each.
  const WIDENED: Array<[string, string]> = [
    ['double-quoted value with no substitution', `Add-Content -LiteralPath x.md -Value "land-pr.ps1"`],
    ['here-string value', `Add-Content -LiteralPath x.md -Value @'\nland-pr.ps1\n'@`],
    ['target set by one literal assignment (F2c)', `$p = 'x.md'; Add-Content -LiteralPath $p -Value 'land-pr.ps1'`],
    ['the ac alias (F2b)', `ac -LiteralPath x.md -Value 'land-pr.ps1'`],
    ['the sc alias (F2b)', `sc -LiteralPath x.md -Value 'land-pr.ps1'`],
  ];
  for (const [why, cmd] of WIDENED) {
    it(`PB-7 widened: allows ${why}`, async () => {
      // Breaks when: the guard still reads the append with the anchored regex (isDocAppend), which allows only single-quoted strings and a literal path.
      expect(await denied(pwsh(cmd))).toBe(false);
    });
  }
  // Each stays a deny: a substitution, a dynamic or script target, a PR number, a merge, a second step. Green today and after.
  const STAY: Array<[string, string]> = [
    ['a variable inside a double-quoted value', `$t = 'x'; Add-Content -LiteralPath x.md -Value "$t land-pr.ps1"`],
    ['a variable target that holds a script', `$p = 'run.ps1'; Add-Content -LiteralPath $p -Value 'land-pr.ps1'`],
    ['the ac alias with a script target', `ac -LiteralPath run.ps1 -Value 'land-pr.ps1'`],
    ['a variable target with a merge text', `$p = 'x.md'; Add-Content -LiteralPath $p -Value 'gh pr merge 12'`],
    ['a here-string with a PR number', `Add-Content -LiteralPath x.md -Value @'\nland-pr.ps1 -Pr 12\n'@`],
    ['a dynamic target set by a command', `$p = (Get-Item x.md); Add-Content -LiteralPath $p -Value 'land-pr.ps1'`],
  ];
  for (const [why, cmd] of STAY) {
    it(`PB-7 stays denied: ${why}`, async () => {
      expect(await denied(pwsh(cmd))).toBe(true);
    });
  }
});

const API_CREATE = `gh api repos/${REPO}/pulls -X POST`;
const openTap = (branch: string) => {
  const key = decisionKey({ branch });
  expect(offerWrite({ step: 'open-pr', key, head: HEAD, spec: { header: 'T', question: 'Q?', options: [{ label: 'Open draft PR (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'open-pr', key, head: HEAD, label: 'Open draft PR (Recommended)' })).toEqual({ ok: true });
};

describe('PB-2: a PowerShell doubled single quote in a head value is one quote', () => {
  it("PB-2 (limit :780): head='it''s' is the branch it's, so a tap for the branch its does not open it", async () => {
    // Breaks when: the head reader drops the doubled quote ('it''s' read as its) and judges the branch its, which has a tap.
    openTap('its');
    expect(await patIn(pwsh(`${API_CREATE} -f head='it''s' -f base=main -f title=t`))).toBe('open-pr'); // a deny, not a warn (CLI run 3, minor; C1)
    expect(await patIn(pwsh(`${API_CREATE} -f head='its' -f base=main -f title=t`))).toBe('allow');
  });
});

/** The reason of a deny, or '' for any other verdict. */
const reasonIn = async (input: object, w: World = {}): Promise<string> => {
  const d = await decideParsed(input, deps(w));
  return d.action === 'deny' ? d.reason : '';
};

describe('PB-6 (Ask B, Dave: R1): a script-runner text whose code names a full guarded call is denied', () => {
  // Synthetic texts (no corpus text). R1: no reader of JavaScript or Python code (V7.6). Two classes of the 7-day count: code that reaches a
  // child-process API (6 of 116) and code that only holds the text as data (110 of 116). Both are denied; the way out is a script file.
  const CHILD = [
    `node -e "require('child_process').execSync('git push fork re/x')"`,
    `node -e "require('child_process').spawnSync('gh', ['pr', 'create', '--head', 're/x'])"`,
    `python -c "import subprocess; subprocess.run('git push fork re/x', shell=True)"`,
    `python - <<'PY'\nimport os\nos.system('git push fork re/x')\nPY`,
    `node <<'JS'\nrequire('child_process').exec('gh pr create --head re/x')\nJS`,
    `node -e "const {execFileSync}=require('node:child_process'); execFileSync('git', ['push', 'fork', 'feat/x'])"`,
  ];
  const DATA = [
    `node -e "console.log('git push fork feat/x')"`,
    `node -e "console.log(/git push fork re\\/x/.test(process.argv[1]))" x`,
    `python -c "print('gh pr create --head feat/x')"`,
    `node <<'JS'\nconst s = 'git push fork feat/x'; console.log(s.length)\nJS`,
    `python - <<'PY'\nprint('git push fork feat/x')\nPY`,
  ];
  it('PB-6a: code that reaches a child-process API is denied with the script-file way out', async () => {
    // Breaks when: the guard reads the text with the hand reader, which treats the quoted code as one inert word.
    shipTapOn(TREE);
    for (const c of CHILD) {
      expect(await patIn(bash(c)), c).not.toBe('allow');
      expect(await reasonIn(bash(c)), c).toMatch(/script file/i);
    }
  });
  it('PB-6b: code that only holds the guarded text as data is denied too (R1, about 16.6 a day on the 7-day corpus)', async () => {
    // Breaks when: a rule reads the code for a child-process API. That reader is a new hand parser (V7.6), so the deny must not depend on the code.
    shipTapOn(TREE);
    for (const c of DATA) {
      expect(await patIn(bash(c)), c).not.toBe('allow');
      expect(await reasonIn(bash(c)), c).toMatch(/script file/i);
    }
  });
  it('PB-6c: the same texts through PowerShell are denied', async () => {
    shipTapOn(TREE);
    expect(await reasonIn(pwsh(`node -e "require('child_process').execSync('git push fork re/x')"`))).toMatch(/script file/i);
    expect(await reasonIn(pwsh(`python -c "print('gh pr create --head feat/x')"`))).toMatch(/script file/i);
  });
  it('PB-6d (cost): a script runner with no guarded call, a script file, and a data-only program keep their verdict', async () => {
    // Breaks when: the rule keys on the runner word alone, so every node call is refused (7,000 Bash calls a week).
    shipTapOn(TREE);
    for (const c of [`node -e "console.log(1+1)"`, 'node scripts/tool.mjs', `python -c "print('hello')"`, `grep "git push fork feat/x" notes.md`,
      `echo "gh pr create --head feat/x"`, `git log --oneline -3`]) {
      expect(await reasonIn(bash(c)), c).not.toMatch(/script file/i);
    }
  });
});
