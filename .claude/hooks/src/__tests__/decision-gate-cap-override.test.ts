/**
 * decision-gate cap-override rule (card coord-cap-override, PART B / PR B). One deny rule on the RAW shell text: a command that names the
 * USD flag or the extra-run flag of the CLI cap override runs only with Dave's tap. No hand parser (V7.6): the text is tested whole.
 * The tap (a ship-ask cap-override question) is stored as step cli-skip, key `repo@branch!cap:<flag set>`, head = the head. The flag set is
 * `usd=N`, `extra` or `usd=N,extra`. The command is allowed only when, after every APPROVED flag spelling (`--cli-cap-usd N`,
 * `--cli-extra-run`, each followed by a space, a quote or the end) is cut out of the raw text, no flag name is left.
 * The script (pre-pr.mjs, cr-fix.mjs) uses the tap up once: this rule only reads.
 *
 * Failure modes, one group each (each fails on main before the rule):
 *   G1  a command with a flag and no tap is allowed (miss), in any spelling: glued =, quoted, in a variable, uppercase, after a continuation
 *   G2  a tap for another head, another branch, another flag set or another USD value lets the command through
 *   G3  the keep label, or a used-up decision, lets the command through
 *   G4  a second flag mention beside the approved one is allowed (the approved spelling covers only itself)
 *   G5  the rule skips a command tool, or a subagent that has no tap is allowed
 *   G6  the rule fires on text that names neither flag (a self-block)
 *   G7  git cannot name the branch or the head and the command is allowed (it must fail closed)
 *   G8  the deny follows decisions.enforce as the paid tripwire does
 *   G9  the built hook, a real payload, gives the same answers
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, type Deps } from '../decision-gate.js';
import { decisionRecord, decisionUse, offerWrite } from '../shared/decisions-store.js';
// @ts-ignore TS7016: the .mjs helper has no declaration file. The REAL helper: the labels and the key come from it, so the two sides cannot drift.
import * as cap from '../../../../scripts/github/lib/cap-override.mjs';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
let dir = '';
let storeFile = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-cap-'));
  storeFile = join(dir, 'decisions.json');
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = storeFile;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

interface World { enforce?: boolean; branch?: string | null; head?: string | null; gitThrows?: boolean }
/** A fake git and config for a CCv3 checkout at /repo. */
function deps(w: World = {}): Deps {
  const { enforce = true, branch = 'feat/x', head = HEAD, gitThrows = false } = w;
  const config = JSON.stringify({ decisions: { enforce, enforcePush: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: storeFile },
    home: '/home/nobody',
    readFile: (p) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (_cwd, args) => {
      if (gitThrows) throw new Error('git is gone');
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return branch === null ? { status: 1, stdout: '' } : { status: 0, stdout: `${branch}\n` };
      if (a === 'rev-parse HEAD') return head === null ? { status: 1, stdout: '' } : { status: 0, stdout: `${head}\n` };
      return { status: 1, stdout: '' };
    },
  };
}

/** Dave's tap for a branch, head and flag set (usd, extra), with a label. */
function tap({ branch = 'feat/x', head = HEAD, usd = null as number | null, extraRun = false, label = cap.CAP_LIFT_LABEL as string } = {}): string {
  const key = cap.capOverrideKey({ branch, usd, extraRun }) as string;
  expect(offerWrite({ step: 'cli-skip', key, head, spec: { header: 'CLI cap', question: 'Q?', options: [{ label: cap.CAP_KEEP_LABEL }, { label: cap.CAP_LIFT_LABEL }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'cli-skip', key, head, label })).toEqual({ ok: true });
  return key;
}

const bash = (command: string, extra: object = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: 's-cap', ...extra });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', session_id: 's-cap' });
const capDeny = (input: object, w?: World): boolean => {
  const d = decide(input as Parameters<typeof decide>[0], deps(w));
  return d.action === 'deny' && d.pattern === 'cap-override';
};
const PRE = 'node scripts/github/pre-pr.mjs --body C:/x/body.md --wait-lock';

describe('G1: a flag with no tap is denied, in every spelling', () => {
  const rows: Array<[string, string]> = [
    ['the USD flag', `${PRE} --cli-cap-usd 6`],
    ['the extra-run flag', `${PRE} --cli-extra-run`],
    ['both flags', `${PRE} --cli-cap-usd 6 --cli-extra-run`],
    ['glued with an equals sign', `${PRE} --cli-cap-usd=6`],
    ['a quoted flag name', `${PRE} "--cli-cap-usd" 6`],
    ['a single-quoted flag name', `${PRE} '--cli-extra-run'`],
    ['uppercase', `${PRE} --CLI-EXTRA-RUN`],
    ['mixed case', `${PRE} --Cli-Cap-Usd 6`],
    ['a variable that holds the flag', "$f = '--cli-extra-run'; node scripts/github/pre-pr.mjs --body b.md $f"],
    ['after a backtick continuation', `${PRE} \`\n  --cli-extra-run`],
    ['after a backslash continuation', `${PRE} \\\n  --cli-extra-run`],
    ['in an echo, which only names it', 'echo --cli-cap-usd 6'],
    ['in a commit message (the known cost of raw text)', 'git commit -m "use --cli-extra-run once"'],
    ['in a heredoc body', 'cat <<EOF\n--cli-cap-usd 6\nEOF'],
    ['cr-fix with the USD flag', 'node scripts/github/cr-fix.mjs --pr 5 --cli-cap-usd 6'],
    ['after a semicolon', 'cd /repo; node scripts/github/pre-pr.mjs --body b.md --cli-extra-run'],
    ['in a subshell', '(node scripts/github/pre-pr.mjs --body b.md --cli-extra-run)'],
  ];
  for (const [name, command] of rows) {
    it(`Bash: ${name}`, () => { expect(capDeny(bash(command))).toBe(true); });
  }
  it('PowerShell: the USD flag', () => { expect(capDeny(pwsh(`${PRE} --cli-cap-usd 6`))).toBe(true); });
  it('Desktop Commander start_process and interact_with_process', () => {
    expect(capDeny({ tool_name: `${DC}start_process`, tool_input: { command: `${PRE} --cli-extra-run`, shell: 'cmd' }, cwd: '/repo', session_id: 's-cap' })).toBe(true);
    expect(capDeny({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input: `${PRE} --cli-extra-run` }, cwd: '/repo', session_id: 's-cap' })).toBe(true);
  });
  it('the deny names the question to ask and does not name a way around it', () => {
    const d = decide(bash(`${PRE} --cli-cap-usd 6`) as Parameters<typeof decide>[0], deps());
    expect(d.action).toBe('deny');
    if (d.action === 'deny') {
      expect(d.reason).toContain('ship-ask.mjs cap-override');
      expect(d.reason).toContain('Dave');
    }
  });
});

describe('G2, G3: a tap opens only its own branch, head, flag set and value, and only with the lift label', () => {
  it('a tap for the USD flag and 6 lets that command through', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`))).toBe(false);
  });
  it('the same tap lets the flag through in any place of the command line', () => {
    tap({ usd: 6 });
    expect(capDeny(bash('node scripts/github/pre-pr.mjs --cli-cap-usd 6 --body b.md --wait-lock'))).toBe(false);
    expect(capDeny(pwsh(`${PRE} --cli-cap-usd 6`))).toBe(false);
  });
  it('a tap for the extra-run flag lets that command through', () => {
    tap({ extraRun: true });
    expect(capDeny(bash(`${PRE} --cli-extra-run`))).toBe(false);
  });
  it('a tap for both flags lets both through, in either order', () => {
    tap({ usd: 6, extraRun: true });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6 --cli-extra-run`))).toBe(false);
    expect(capDeny(bash(`${PRE} --cli-extra-run --cli-cap-usd 6`))).toBe(false);
  });
  it('another head: denied', () => {
    tap({ usd: 6, head: OTHER });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`))).toBe(true);
  });
  it('another branch: denied', () => {
    tap({ usd: 6, branch: 'feat/y' });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`))).toBe(true);
  });
  it('another USD value: 6 does not open 60, 6.5, 600 or 5', () => {
    tap({ usd: 6 });
    for (const v of ['60', '6.5', '600', '5', '06']) expect(capDeny(bash(`${PRE} --cli-cap-usd ${v}`)), v).toBe(true);
  });
  it('another flag set: a USD tap does not open the extra-run flag, and the reverse', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-extra-run`))).toBe(true);
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6 --cli-extra-run`))).toBe(true);
  });
  it('an extra-run tap does not open the USD flag', () => {
    tap({ extraRun: true });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`))).toBe(true);
  });
  it('the keep label opens nothing', () => {
    tap({ usd: 6, label: cap.CAP_KEEP_LABEL });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`))).toBe(true);
  });
  it('a tap that the script used up opens nothing (single use)', () => {
    const key = tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`))).toBe(false);
    expect(decisionUse({ step: 'cli-skip', key, head: HEAD, label: cap.CAP_LIFT_LABEL }).ok).toBe(true);
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`))).toBe(true);
  });
  it('the flag-skip decision of the same branch and head (step cli-skip, plain key) opens nothing here', () => {
    expect(offerWrite({ step: 'cli-skip', key: `${REPO}@feat/x`, head: HEAD, spec: { header: 'CLI skip', question: 'Q?', options: [{ label: 'Skip the CLI review for this head' }, { label: 'Keep the CLI review' }] } }).ok).toBe(true);
    expect(decisionRecord({ step: 'cli-skip', key: `${REPO}@feat/x`, head: HEAD, label: 'Skip the CLI review for this head' })).toEqual({ ok: true });
    expect(capDeny(bash(`${PRE} --cli-extra-run`))).toBe(true);
  });
});

describe('G4: the approved spelling covers only itself', () => {
  it('a second mention with another value beside the approved one is denied', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6; node scripts/github/cr-fix.mjs --pr 5 --cli-cap-usd 600`))).toBe(true);
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6 --cli-cap-usd 7`))).toBe(true);
  });
  it('the approved spelling plus a quoted or glued mention is denied', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6 "--cli-cap-usd=7"`))).toBe(true);
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6 --cli-extra-run`))).toBe(true);
  });
  it('the approved spelling twice is the same flag twice: allowed by this rule (the script refuses a repeat)', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6 --cli-cap-usd 6`))).toBe(false);
  });
  it('a value glued to the approved one is another value: 6 then a digit', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6${'0'}`))).toBe(true);
  });
  it('the approved spelling quoted is not the approved spelling (fail closed)', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} "--cli-cap-usd 6"`))).toBe(false);
    expect(capDeny(bash(`${PRE} "--cli-cap-usd" 6`))).toBe(true);
  });
});

describe('G5: every command tool, and a subagent', () => {
  it('a subagent has no tap: denied even when the tap exists', () => {
    tap({ usd: 6 });
    expect(capDeny(bash(`${PRE} --cli-cap-usd 6`, { agent_id: 'agent-1' }))).toBe(true);
  });
  it('Desktop Commander gets the same answer as Bash with a tap', () => {
    tap({ extraRun: true });
    expect(capDeny({ tool_name: `${DC}start_process`, tool_input: { command: `${PRE} --cli-extra-run`, shell: 'cmd' }, cwd: '/repo', session_id: 's-cap' })).toBe(false);
  });
  it('a non-command tool that holds the flag text is not read', () => {
    expect(capDeny({ tool_name: 'Read', tool_input: { file_path: '--cli-cap-usd' }, cwd: '/repo', session_id: 's-cap' })).toBe(false);
  });
});

describe('G6: text that names neither flag is not denied', () => {
  for (const command of [PRE, `${PRE} --skip-cr`, 'node scripts/github/ship-ask.mjs cap-override --branch feat/x --usd 6 --extra-run --json', 'git status', 'echo --cli-cap', 'echo --cli-extra', 'rg "cli-cap-usd" scripts', 'echo cli-extra-run']) {
    it(command, () => { expect(capDeny(bash(command))).toBe(false); });
  }
});

describe('G7: git cannot name the branch or the head: fail closed', () => {
  it('no branch (detached HEAD)', () => { tap({ usd: 6 }); expect(capDeny(bash(`${PRE} --cli-cap-usd 6`), { branch: null })).toBe(true); });
  it('no head', () => { tap({ usd: 6 }); expect(capDeny(bash(`${PRE} --cli-cap-usd 6`), { head: null })).toBe(true); });
  it('git throws', () => { tap({ usd: 6 }); expect(capDeny(bash(`${PRE} --cli-cap-usd 6`), { gitThrows: true })).toBe(true); });
});

describe('G8: the deny follows decisions.enforce, as the paid tripwire does', () => {
  it('enforce true: deny', () => { expect(capDeny(bash(`${PRE} --cli-extra-run`), { enforce: true })).toBe(true); });
  it('enforce false: allow with a warning', () => {
    const d = decide(bash(`${PRE} --cli-extra-run`) as Parameters<typeof decide>[0], deps({ enforce: false }));
    expect(d.action).toBe('allow');
    expect(typeof (d as { warn?: string }).warn).toBe('string');
  });
});

// ---- G9: the built hook against this real checkout ----
describe('G9: the built hook, a real payload', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_DIR = resolve(HERE, '..', '..', '..', '..');
  const DIST = join(REPO_DIR, '.claude', 'hooks', 'dist', 'decision-gate.mjs');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: REPO_DIR, encoding: 'utf8', windowsHide: true }).stdout.trim();
  /** The hook's answer: the permission decision, or '' for an allow ({}). A hook that did not run is a test failure, never an allow. */
  function ask(command: string): string {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: REPO_DIR, session_id: 's-cap-built' });
    const env: NodeJS.ProcessEnv = { ...process.env, CCV3_DECISIONS_FILE: storeFile, CCV3_GUARD_DECISIONS_LOG: join(dir, 'guard.jsonl') };
    delete env.VITEST;
    const r = spawnSync('node', [DIST], { input: payload, encoding: 'utf8', windowsHide: true, env });
    expect(r.error, 'the hook did not start').toBeUndefined();
    expect(r.status, `exit code; stderr: ${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return out.hookSpecificOutput?.permissionDecision === 'deny' ? (out.hookSpecificOutput.permissionDecisionReason ?? 'deny') : '';
  }
  it('no tap: deny, and the reason names the question', () => {
    expect(ask(`${PRE} --cli-extra-run`)).toContain('ship-ask.mjs cap-override');
  });
  it('a tap for this branch and head: allow; the control without flags stays allowed', () => {
    const branch = git('branch', '--show-current');
    const head = git('rev-parse', 'HEAD');
    const key = cap.capOverrideKey({ branch, usd: null, extraRun: true }) as string;
    expect(offerWrite({ step: 'cli-skip', key, head, spec: { header: 'CLI cap', question: 'Q?', options: [{ label: cap.CAP_KEEP_LABEL }, { label: cap.CAP_LIFT_LABEL }] } }).ok).toBe(true);
    expect(decisionRecord({ step: 'cli-skip', key, head, label: cap.CAP_LIFT_LABEL })).toEqual({ ok: true });
    expect(ask(`${PRE} --cli-extra-run`)).toBe('');
    expect(ask(`${PRE} --cli-cap-usd 6`)).toContain('ship-ask.mjs cap-override');
    expect(ask(PRE)).toBe('');
  });
});
