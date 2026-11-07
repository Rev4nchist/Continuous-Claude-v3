/**
 * decision-gate: PreToolUse. It denies a PR create, a land, a merge and a write to the decision store unless Dave's tap is on record.
 * It does NOT deny `git push` (the push gate is left out of this PR). The decision store is real (a temp file); git and the config
 * file are small fakes, because the hook asks git for the branch head and reads review-router.config.json.
 *
 * Failure modes, one test group each:
 *   G1  a PR create (gh api .../pulls POST, gh pr create) runs with no open-pr decision, or with the wrong label or head
 *   G2  a land or merge (land-pr.ps1, gh pr merge, gh api .../merge) runs with no land decision for the PR, or with Keep open
 *   G3  git push is denied (it must pass: the gate is not in this PR)
 *   G4  the model writes the store: Write, Edit, NotebookEdit, the Desktop Commander writes, or shell text
 *   G5  the Desktop Commander process tools are not read (their text is in `command` and in `input`)
 *   G6  a subagent opens, lands or merges on the main session's tap
 *   G7  enforce false (or missing, or a string "true") denies; or enforce is read from checkpoint instead of decisions
 *   G8  a foreign repo, a push from main, or a normal command is denied
 *   G9  an override (SKIP_*) lets a gated command through
 *   G10 a gated shape that cannot be judged (git fails, no PR number) is allowed
 *   G11 a command with two lands or merges is judged on the first one only (every segment needs its own tap and its own sha)
 *   G12 the model moves a file onto the store (Desktop Commander move_file, write_pdf), or reaches it with a .. path
 *   G13 the model burns taps from a shell (land-decision.mjs use, a loop of pr-checkpoint.mjs --json --pr)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRecord, decisionRows, offerWrite, type Step } from '../shared/decisions-store.js';
import { COMMAND_TOOLS, WRITE_TOOLS, decide, handle, type Deps } from '../decision-gate.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
let dir = '';
let storeFile = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-'));
  storeFile = join(dir, 'decisions.json');
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = storeFile;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

interface World { enforce?: unknown; config?: string | null; remote?: string; branch?: string; gitFails?: boolean; heads?: Record<string, string> }

/** A fake git and config for a checkout at /repo. */
function deps(w: World = {}): Deps {
  const config = w.config !== undefined ? w.config : JSON.stringify({ decisions: { enforce: 'enforce' in w ? w.enforce : true } });
  const heads = w.heads ?? { 'feat/x': HEAD };
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: storeFile },
    home: '/home/nobody',
    readFile: (p) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (_cwd, args) => {
      if (w.gitFails) throw new Error('git exploded');
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\t${w.remote ?? `https://github.com/${REPO}.git`} (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: `${w.branch ?? 'feat/x'}\n` };
      const m = /^rev-parse (.+)\^\{commit\}$/.exec(a);
      if (m && heads[m[1]]) return { status: 0, stdout: `${heads[m[1]]}\n` };
      return { status: 1, stdout: '' };
    },
  };
}

/** Record Dave's tap: an offer whose options hold the label, then the decision (the real ledger path). */
function tap(step: Step, key: string, head: string, label: string): void {
  expect(offerWrite({ step, key, head, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', ...extra });
const pwsh = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', ...extra });
const denied = (input: object, w?: World) => decide(input, deps(w)).action === 'deny';
const reasonOf = (input: object, w?: World): string => { const d = decide(input, deps(w)); return d.action === 'deny' ? d.reason : ''; };

const CREATE = `gh api repos/${REPO}/pulls -X POST -F draft=true -F head=feat/x -F base=main -F body=@b.md -F title=t`;
const branchKey = (b = 'feat/x') => `${REPO}@${b}`;
const prKey = (n: number) => `${REPO}#${n}`;

describe('G1 PR create', () => {
  it('denies a create with no open-pr decision, and the reason names the question to ask', () => {
    const r = reasonOf(bash(CREATE));
    expect(r).toContain('BLOCKED (decision-gate)');
    expect(r).toContain('ship-ask.mjs open-pr --branch feat/x');
    expect(r).toContain('AskUserQuestion');
  });
  it('denies gh pr create too, in both shells', () => {
    expect(denied(bash('gh pr create --draft --head feat/x --title t --body-file b.md'))).toBe(true);
    expect(denied(pwsh('gh pr create --draft --title t --body-file b.md'))).toBe(true);
  });
  it('allows the create after Open draft PR for this branch and head', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash(CREATE))).toBe(false);
  });
  it('denies when the tap was another label (Show the PR body first, Stop here, a re-run)', () => {
    for (const label of ['Show the PR body first', 'Stop here', 'Re-run pre-pr (up to $3.00 CLI) (Recommended)']) {
      tap('open-pr', branchKey(), HEAD, label);
      expect(denied(bash(CREATE)), label).toBe(true);
    }
  });
  it('denies when the tap is for an earlier head (the branch moved)', () => {
    tap('open-pr', branchKey(), OTHER, 'Open draft PR (Recommended)');
    expect(denied(bash(CREATE))).toBe(true);
  });
  it('denies when the tap is for another branch', () => {
    tap('open-pr', branchKey('feat/y'), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash(CREATE))).toBe(true);
  });
  it('reads the branch from the current branch when the command names none', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash('gh pr create --draft --title t --body-file b.md'))).toBe(false);
  });
});

describe('G2 land and merge', () => {
  const LAND = 'pwsh -File scripts/github/land-pr.ps1 -Pr 12';
  it('denies land-pr.ps1 with no land decision, and names the question', () => {
    const r = reasonOf(bash(LAND));
    expect(r).toContain('ship-ask.mjs land --pr 12');
    expect(r).toContain('-CleanupOnly');
  });
  it('allows after Land now, or Land when READY, for that PR', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash(LAND))).toBe(false);
    rmSync(storeFile);
    tap('land', prKey(12), HEAD, 'Land when READY (Recommended)');
    expect(denied(pwsh(LAND))).toBe(false);
  });
  it('denies after Keep open or Return to draft', () => {
    for (const label of ['Keep open', 'Return to draft']) {
      tap('land', prKey(12), HEAD, label);
      expect(denied(bash(LAND)), label).toBe(true);
    }
  });
  it('denies a decision for another PR', () => {
    tap('land', prKey(13), HEAD, 'Land now (Recommended)');
    expect(denied(bash(LAND))).toBe(true);
  });
  it('reads -Pr in the short and colon forms', () => {
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -P 12'))).toBe(true);
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr:12 -Method squash'))).toBe(true);
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr:12 -Method squash'))).toBe(false);
  });
  it('lets -CleanupOnly through (it never merges, and the tap is used up after the merge)', () => {
    expect(denied(bash(`${LAND} -CleanupOnly`))).toBe(false);
  });
  it('denies gh pr merge and gh api .../merge with no land decision', () => {
    expect(denied(bash('gh pr merge 12 --merge'))).toBe(true);
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f merge_method=merge`))).toBe(true);
  });
  it('a raw merge passes only with the tapped head in the text (sha= or --match-head-commit)', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f sha=${HEAD}`))).toBe(false);
    expect(denied(bash(`gh pr merge 12 --merge --match-head-commit ${HEAD}`))).toBe(false);
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f sha=${OTHER}`))).toBe(true);
    expect(denied(bash(`gh pr merge 12 --merge --match-head-commit ${OTHER}`))).toBe(true);
  });
  it('a raw merge with no head is denied even with a tap on record: the tap may be for an older head', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(reasonOf(bash('gh pr merge 12 --merge'))).toContain('land-pr.ps1 -Pr 12');
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f merge_method=merge`))).toBe(true);
  });
  it('reads a merge endpoint with GET as a read', () => {
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X GET`))).toBe(false);
  });
});

describe('G3 git push is not gated', () => {
  it.each([
    'git push fork feat/x',
    'pwsh -File scripts/git-safe.ps1 push fork feat/x',
    'git push --force-with-lease fork feat/x',
    'git push origin main',
  ])('passes %s', (cmd) => {
    expect(decide(bash(cmd), deps()).action).toBe('allow');
    expect(handle(JSON.stringify(bash(cmd)), deps())).toBe('{}');
  });
});

describe('G4 the model writes the store', () => {
  it('denies Write, Edit and NotebookEdit to the store, its lock and its tmp file', () => {
    for (const tool of ['Write', 'Edit']) {
      expect(denied({ tool_name: tool, tool_input: { file_path: storeFile }, cwd: '/repo' }), tool).toBe(true);
    }
    expect(denied({ tool_name: 'NotebookEdit', tool_input: { notebook_path: storeFile }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: `${storeFile}.lock` }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: `${storeFile}.123.tmp` }, cwd: '/repo' })).toBe(true);
  });
  it('denies the default store path of the real home folder', () => {
    const p = join('C:\\Users\\dave', '.claude', 'state', 'ccv3-mods', 'decisions.json');
    expect(denied({ tool_name: 'Write', tool_input: { file_path: p }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dave/.claude/state/ccv3-mods/decisions.json' }, cwd: '/repo' })).toBe(true);
  });
  it('denies the Desktop Commander write tools', () => {
    expect(denied({ tool_name: `${DC}write_file`, tool_input: { path: storeFile, content: '{}' }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}edit_block`, tool_input: { file_path: storeFile, old_string: 'a', new_string: 'b' }, cwd: '/repo' })).toBe(true);
  });
  it('allows a write to any other file, including another decisions.json', () => {
    expect(denied({ tool_name: 'Write', tool_input: { file_path: '/repo/docs/decisions.json' }, cwd: '/repo' })).toBe(false);
    expect(denied({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts' }, cwd: '/repo' })).toBe(false);
  });
  it('denies shell text that writes the store, and passes a read of it', () => {
    expect(denied(bash(`echo '{}' > ${storeFile}`))).toBe(true);
    expect(denied(pwsh(`Set-Content -Path ${storeFile} -Value '{}'`))).toBe(true);
    expect(denied(bash(`node -e "import('./scripts/github/lib/decisions.mjs').then(m=>m.decisionRecord({}))"`))).toBe(true);
    expect(denied(bash(`cat ${storeFile}`))).toBe(false);
    expect(denied(pwsh(`Get-Content ${storeFile} -Raw`))).toBe(false);
    expect(denied(bash('rg decisionRecord scripts/github'))).toBe(false);
  });
  it('passes a node -e that only READS the store, and still denies node code that can write it', () => {
    expect(denied(bash(`node -e "const d=require('${storeFile}');console.log(Object.keys(d))"`))).toBe(false);
    expect(denied(bash(`node -e "console.log(require('fs').readFileSync('${storeFile}','utf8').length)"`))).toBe(false);
    expect(denied(bash(`node -e "require('fs').writeFileSync('${storeFile}','{}')"`))).toBe(true);
    expect(denied(bash(`node -e "require('fs').createWriteStream('${storeFile}').end('{}')"`))).toBe(true);
    expect(denied(bash(`node -e "require('fs').copyFileSync('/tmp/x.json','${storeFile}')"`))).toBe(true);
    expect(denied(bash(`node -e "const f=require('fs').openSync('${storeFile}','w');require('fs').closeSync(f)"`))).toBe(true);
    expect(denied(bash(`node -e "require('child_process').execSync('echo {} > ${storeFile}')"`))).toBe(true);
    expect(denied(bash(`node -e "import('./scripts/github/lib/decisions.mjs').then(m=>m.decisionRecord({}))"`))).toBe(true);
    expect(denied(bash(`node -e "require('/tmp/evil.js');console.log(require('${storeFile}'))"`))).toBe(true);
    expect(denied(bash(`node -e "const m=process.argv[1];require(m);console.log(require('${storeFile}'))" x`))).toBe(true);
    expect(denied(bash(`node -e "const f=require('fs');f['wri'+'teFileSync']('${storeFile}','{}')"`))).toBe(true);
  });
  it('passes a copy that only READS the store (the store is the first source) and still denies a copy that writes it', () => {
    expect(denied(bash(`cp ${storeFile} /tmp/before.json`))).toBe(false);
    expect(denied(bash(`cp -f ${storeFile} /tmp/before.json`))).toBe(false);
    expect(denied(pwsh(`Copy-Item ${storeFile} C:\\tmp\\before.json`))).toBe(false);
    expect(denied(bash(`cp /tmp/x.json ${storeFile}`))).toBe(true);
    expect(denied(pwsh(`Copy-Item C:\\tmp\\x.json ${storeFile}`))).toBe(true);
    expect(denied(bash(`cp ${storeFile} ${storeFile}.bak`))).toBe(true);
    expect(denied(bash(`cp ${storeFile} /tmp/b.json && echo '{}' > ${storeFile}`))).toBe(true);
    expect(denied(pwsh(`Copy-Item -Destination ${storeFile} C:\\tmp\\x.json`))).toBe(true);
    expect(denied(pwsh(`Copy-Item -Path C:\\tmp\\x.json -Destination ${storeFile}`))).toBe(true);
    expect(denied(bash(`cp -t ${storeFile} /tmp/x.json`))).toBe(true);
    expect(denied(bash(`cp --target-directory ${storeFile} /tmp/x.json`))).toBe(true);
    expect(denied(pwsh(`Copy-Item -Force ${storeFile} C:\\tmp\\before.json`))).toBe(false);
    expect(denied(bash(`cp ${storeFile} /tmp/b.json; mv /tmp/x.json ${storeFile}`))).toBe(true);
  });
});

describe('G5 Desktop Commander process tools', () => {
  it('reads command for start_process and input for interact_with_process', () => {
    expect(denied({ tool_name: `${DC}start_process`, tool_input: { command: CREATE }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input: 'pwsh -File scripts/github/land-pr.ps1 -Pr 12' }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}start_process`, tool_input: { command: 'git status' }, cwd: '/repo' })).toBe(false);
  });
  it('passes a process call with no readable text (nothing to judge)', () => {
    expect(denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1 }, cwd: '/repo' })).toBe(false);
  });
  it('lists the tools the matcher must cover', () => {
    expect([...COMMAND_TOOLS].sort()).toEqual(['Bash', 'PowerShell', `${DC}interact_with_process`, `${DC}start_process`].sort());
    expect([...WRITE_TOOLS].sort()).toEqual(['Edit', 'NotebookEdit', 'Write', `${DC}edit_block`, `${DC}move_file`, `${DC}write_file`, `${DC}write_pdf`].sort());
  });
});

describe('G6 subagent', () => {
  it('denies a create, a land and a merge even with the tap on record', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash(CREATE, { agent_id: 'a1' }))).toBe(true);
    expect(denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 12', { agent_id: 'a1' }))).toBe(true);
    expect(denied(bash('gh pr merge 12', { agent_id: 'a1' }))).toBe(true);
    expect(reasonOf(bash(CREATE, { agent_id: 'a1' }))).toContain('subagent');
  });
  it('lets a subagent run a normal command', () => {
    expect(denied(bash('git status', { agent_id: 'a1' }))).toBe(false);
    expect(denied(bash('git push fork feat/x', { agent_id: 'a1' }))).toBe(false);
  });
});

describe('G7 enforce flag', () => {
  it('only a literal true under decisions.enforce denies; every other value warns', () => {
    for (const w of [{ enforce: false }, { enforce: 'true' }, { enforce: 1 }, { config: null }, { config: 'not json' }, { config: JSON.stringify({ checkpoint: { enforce: true } }) }]) {
      const d = decide(bash(CREATE), deps(w));
      expect(d.action, JSON.stringify(w)).toBe('allow');
      expect(d.action === 'allow' && d.warn, JSON.stringify(w)).toBeTruthy();
    }
    expect(decide(bash(CREATE), deps({ enforce: true })).action).toBe('deny');
  });
  it('warn mode prints the would-be deny as context and does not block', () => {
    const out = JSON.parse(handle(JSON.stringify(bash(CREATE)), deps({ enforce: false }))) as { hookSpecificOutput: { permissionDecision?: string; additionalContext?: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('would be blocked');
  });
  it('a deny is a deny output', () => {
    const out = JSON.parse(handle(JSON.stringify(bash(CREATE)), deps())) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('G8 what is not gated', () => {
  it('passes a create in a foreign checkout', () => {
    expect(denied(bash('gh pr create --draft --title t --body-file b.md'), { remote: 'https://github.com/someone/else.git' })).toBe(false);
  });
  it('passes a create from main', () => {
    expect(denied(bash('gh pr create --draft --head main --title t --body-file b.md'))).toBe(false);
  });
  it('passes ordinary commands and other tools', () => {
    for (const c of ['git status', 'gh pr view 12', 'gh pr ready 12 --undo', 'node scripts/github/pr-checkpoint.mjs --json --pr 12', 'gh api repos/x/y/pulls/12/reviews']) {
      expect(denied(bash(c)), c).toBe(false);
    }
    expect(denied({ tool_name: 'Read', tool_input: { file_path: storeFile }, cwd: '/repo' })).toBe(false);
  });
  it('passes unreadable input', () => {
    expect(handle('not json', deps())).toBe('{}');
  });
  // Unreadable input has no visible shape, so the documented posture (deny only a gated shape) allows it. It says so on stderr, once, and the log row holds no input text.
  it('passes unreadable input, says so on stderr once, and logs none of the input text', () => {
    const log = join(dir, 'guard.jsonl');
    const savedLog = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      for (const raw of ['SECRET-TOKEN-abc123 gh pr merge', '{"tool_name": "Bash", SECRET-TOKEN-abc123']) {
        writes.length = 0;
        expect(handle(raw, deps())).toBe('{}');
        expect(writes, raw).toHaveLength(1);
        expect(writes[0]).toMatch(/^decision-gate: [^\n]*not readable[^\n]*allowed\.\n$/);
        expect(writes[0]).not.toContain('SECRET-TOKEN');
      }
    } finally {
      process.stderr.write = orig;
      if (savedLog === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG; else process.env.CCV3_GUARD_DECISIONS_LOG = savedLog;
    }
    const logged = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(logged).not.toContain('SECRET-TOKEN');
  });
  it('a readable payload prints nothing on stderr', () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { expect(handle(JSON.stringify(bash('git status')), deps())).toBe('{}'); } finally { process.stderr.write = orig; }
    expect(writes).toEqual([]);
  });
});

describe('G9 there is no override', () => {
  it('a leading SKIP_ assignment or env value does not let a create through', () => {
    for (const cmd of [`SKIP_DECISION_GATE=1 ${CREATE}`, `$env:SKIP_DECISION_GATE='1'; ${CREATE}`, `SKIP_PRE_PR_GATE=1 ${CREATE}`]) {
      expect(denied(bash(cmd)), cmd).toBe(true);
    }
    const d = { ...deps(), env: { ...deps().env, SKIP_DECISION_GATE: '1', SKIP_PRE_PR_GATE: '1' } };
    expect(decide(bash(CREATE), d).action).toBe('deny');
  });
});

describe('G10 fail closed on a gated shape', () => {
  it('denies a create when git fails', () => {
    const out = JSON.parse(handle(JSON.stringify(bash(CREATE)), deps({ gitFails: true }))) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies a land with no readable PR number', () => {
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr $n'))).toBe(true);
    expect(denied(bash('gh pr merge --squash'))).toBe(true);
  });
  it('does not fail a harmless command when git fails', () => {
    expect(handle(JSON.stringify(bash('git push fork feat/x')), deps({ gitFails: true }))).toBe('{}');
  });
});

describe('G11 every land and merge shape of a command is judged', () => {
  const M43 = `gh pr merge 43 --squash --match-head-commit ${HEAD}`;
  const A44 = `gh api repos/${REPO}/pulls/44/merge -X PUT -f sha=${HEAD}`;
  it('denies two gh pr merge commands when only the first PR has a tap', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    const cmd = `${M43} && gh pr merge 44 --squash --match-head-commit ${HEAD}`;
    expect(reasonOf(bash(cmd))).toContain('PR #44');
  });
  it('denies a gh pr merge followed by a gh api merge when only the first PR has a tap', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    expect(reasonOf(bash(`${M43} && ${A44}`))).toContain('PR #44');
  });
  it('allows both when each PR has its tap', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    tap('land', prKey(44), HEAD, 'Land now (Recommended)');
    expect(denied(bash(`${M43} && ${A44}`))).toBe(false);
  });
  it('splits on ; | and newlines too, and in PowerShell', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    expect(denied(bash(`${M43}; ${A44}`))).toBe(true);
    expect(denied(bash(`${M43}\n${A44}`))).toBe(true);
    expect(denied(pwsh(`${M43}; ${A44}`))).toBe(true);
  });
  it('reads the sha of each segment: the sha of the first merge does not cover the second', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    tap('land', prKey(44), HEAD, 'Land now (Recommended)');
    expect(reasonOf(bash(`${M43} && gh pr merge 44 --squash`))).toContain('names no head');
    expect(denied(bash(`${M43} && gh api repos/${REPO}/pulls/44/merge -X PUT -f sha=${OTHER}`))).toBe(true);
  });
  it('judges a land-pr.ps1 after another land, each with its own PR', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 12 && pwsh -File scripts/github/land-pr.ps1 -Pr 13'))).toBe(true);
    expect(denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 13 -CleanupOnly && pwsh -File scripts/github/land-pr.ps1 -Pr 12'))).toBe(false);
  });
});

describe('G12 the store through move_file, write_pdf and a .. path', () => {
  it('denies Desktop Commander move_file whose destination is the store', () => {
    expect(denied({ tool_name: `${DC}move_file`, tool_input: { source: '/tmp/forged.json', destination: storeFile }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}move_file`, tool_input: { source: '/tmp/forged.json', destination: '/tmp/other.json' }, cwd: '/repo' })).toBe(false);
  });
  it('denies Desktop Commander write_pdf whose path is the store', () => {
    expect(denied({ tool_name: `${DC}write_pdf`, tool_input: { path: storeFile }, cwd: '/repo' })).toBe(true);
  });
  it('denies a Write whose path reaches the store through ..', () => {
    expect(denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dkhay/.claude/state/ccv3-mods/x/../decisions.json' }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: `${dir.replace(/\\/g, '/')}/x/../decisions.json` }, cwd: '/repo' })).toBe(true);
  });
  it('allows a Write whose .. path leaves the store folder', () => {
    expect(denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dkhay/.claude/state/ccv3-mods/x/../../notes.txt' }, cwd: '/repo' })).toBe(false);
  });
});

describe('G14 shell text that writes the default store path, with text after the path', () => {
  const DEF = 'C:/Users/dave/.claude/state/ccv3-mods/decisions.json';
  it('denies a write with arguments after the path', () => {
    expect(denied(bash(`cp /tmp/forged.json ${DEF} -f`))).toBe(true);
    expect(denied(bash(`echo '{}' > ${DEF} 2>/dev/null`))).toBe(true);
    expect(denied(pwsh(`Set-Content -Path ${DEF} -Value '{}'`))).toBe(true);
    expect(denied(bash(`echo '{}' > ${DEF}; echo done`))).toBe(true);
  });
  it('denies the $HOME, ~ and %USERPROFILE% spellings', () => {
    expect(denied(bash(`echo '{}' > $HOME/.claude/state/ccv3-mods/decisions.json; echo ok`))).toBe(true);
    expect(denied(bash(`echo '{}' > "$HOME/.claude/state/ccv3-mods/decisions.json" && true`))).toBe(true);
    expect(denied(bash(`echo '{}' > ~/.claude/state/ccv3-mods/decisions.json && true`))).toBe(true);
    expect(denied(pwsh('Set-Content -Path "$HOME\\.claude\\state\\ccv3-mods\\decisions.json" -Value \'{}\''))).toBe(true);
    expect(denied(pwsh('Set-Content -Path "%USERPROFILE%\\.claude\\state\\ccv3-mods\\decisions.json" -Value \'{}\''))).toBe(true);
  });
  it('denies a quoted path with text after it', () => {
    expect(denied(pwsh(`Set-Content -Path 'C:\\Users\\dave\\.claude\\state\\ccv3-mods\\decisions.json' -Value '{}'`))).toBe(true);
    expect(denied(bash(`tee "${DEF}" < /tmp/forged.json`))).toBe(true);
  });
  it('denies a write to the lock file, with text after it', () => {
    expect(denied(bash(`rm -f ${DEF}.lock -v`))).toBe(true);
  });
  it('passes a read, and a file that only starts with the same letters', () => {
    expect(denied(bash(`cat ${DEF} | head -5`))).toBe(false);
    expect(denied(bash(`cp /tmp/a.json ${DEF.replace('decisions.json', 'decisions-old.json')} -f`))).toBe(false);
    expect(denied(bash(`cp /tmp/a.json ${DEF.replace('decisions.json', 'decisions.jsonx')} -f`))).toBe(false);
  });
});

describe('G15 the store path as a tool path: streams, trailing dots and spaces, source, outputPath', () => {
  const write = (file_path: string) => denied({ tool_name: 'Write', tool_input: { file_path }, cwd: '/repo' });
  it('denies a path with ::$DATA or a :stream name', () => {
    expect(write(`${storeFile}::$DATA`)).toBe(true);
    expect(write(`${storeFile}:evil`)).toBe(true);
  });
  it('denies a path with trailing dots or spaces', () => {
    expect(write(`${storeFile} `)).toBe(true);
    expect(write(`${storeFile}.`)).toBe(true);
    expect(write(`${storeFile}. . `)).toBe(true);
  });
  it('denies a move_file whose source is the store', () => {
    expect(denied({ tool_name: `${DC}move_file`, tool_input: { source: storeFile, destination: '/tmp/gone.json' }, cwd: '/repo' })).toBe(true);
  });
  it('denies a write_pdf whose outputPath is the store', () => {
    expect(denied({ tool_name: `${DC}write_pdf`, tool_input: { outputPath: storeFile }, cwd: '/repo' })).toBe(true);
  });
  it('still allows another file, a .. leaf and a stream of another file', () => {
    expect(write(`${dir.replace(/\\/g, '/')}/notes.txt::$DATA`)).toBe(false);
    expect(write(`${dir.replace(/\\/g, '/')}/x/..`)).toBe(false);
    expect(write('/repo/docs/decisions.json ')).toBe(false);
  });
});

describe('G13 the model burns taps from a shell', () => {
  it('denies land-decision.mjs use, in both shells, and passes check', () => {
    expect(denied(bash('node scripts/github/land-decision.mjs use 12 --head ' + HEAD))).toBe(true);
    expect(denied(pwsh('node .\\scripts\\github\\land-decision.mjs use 12 --head ' + HEAD))).toBe(true);
    expect(denied(bash('node scripts/github/land-decision.mjs check 12 --head ' + HEAD))).toBe(false);
  });
  it('denies a loop of pr-checkpoint.mjs --json --pr, and passes one run', () => {
    expect(denied(bash('for i in 1 2 3; do node scripts/github/pr-checkpoint.mjs --json --pr 12; done'))).toBe(true);
    expect(denied(pwsh('1..5 | ForEach-Object { node scripts/github/pr-checkpoint.mjs --json --pr 12 }'))).toBe(true);
    expect(denied(bash('while true; do node scripts/github/pr-checkpoint.mjs --json --pr 12; done'))).toBe(true);
    expect(denied(bash('node scripts/github/pr-checkpoint.mjs --json --pr 12'))).toBe(false);
  });
});

describe('decisions-store reader', () => {
  it('reads the rows the real store writes (a change of the row id breaks this)', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(decisionRows({ CCV3_DECISIONS_FILE: storeFile })).toEqual([{ step: 'land', key: prKey(12), head: HEAD, label: 'Land now (Recommended)' }]);
  });

  it('reads a store with any section that is not a plain object as empty, like decisions.mjs (fail closed)', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    const good = JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>;
    for (const bad of ['offers', 'misses', 'decisions']) {
      writeFileSync(storeFile, JSON.stringify({ ...good, [bad]: [] }));
      expect(decisionRows({ CCV3_DECISIONS_FILE: storeFile }), bad).toEqual([]);
    }
  });
});
