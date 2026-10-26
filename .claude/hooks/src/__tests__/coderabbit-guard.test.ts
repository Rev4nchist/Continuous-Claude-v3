import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  classifyShellSegment,
  decide,
  readState,
  recordRun,
  statePath,
  writeState,
  checkRunCap,
  repoBranchKey,
} from '../coderabbit-guard.js';

const HOOK = resolve(__dirname, '../../dist/coderabbit-guard.mjs');

function runHook(
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): { stdout: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  return { stdout: res.stdout.trim(), status: res.status };
}

function deny(stdout: string): boolean {
  const o = JSON.parse(stdout);
  return o.hookSpecificOutput?.permissionDecision === 'deny';
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command } });

describe('coderabbit-guard classifyShellSegment: blocks', () => {
  it('blocks --use-credits on cr review --agent', () => {
    expect(classifyShellSegment('cr review --agent --use-credits').verdict).toBe('block');
  });

  it('blocks --api-key', () => {
    expect(classifyShellSegment('coderabbit review --agent --api-key=foo').verdict).toBe('block');
  });

  it('blocks forbidden flags even on a read-only subcommand', () => {
    expect(classifyShellSegment('cr auth login --api-key abc').verdict).toBe('block');
    expect(classifyShellSegment('cr doctor --use-credits').verdict).toBe('block');
  });

  it('blocks code new and code push', () => {
    expect(classifyShellSegment('cr code new').verdict).toBe('block');
    expect(classifyShellSegment('cr code push').verdict).toBe('block');
    expect(classifyShellSegment('coderabbit code push').verdict).toBe('block');
  });

  it('blocks skill installs, bare and wrapped', () => {
    expect(classifyShellSegment('npx skills add coderabbitai/skills -g -y').verdict).toBe('block');
    expect(classifyShellSegment('npx -y skills@latest add coderabbitai/skills').verdict).toBe('block');
    expect(classifyShellSegment('coderabbit skills install').verdict).toBe('block');
  });

  it('blocks cr subcommands outside the allow list', () => {
    expect(classifyShellSegment('cr').verdict).toBe('block');
    expect(classifyShellSegment('cr auth logout').verdict).toBe('block');
    expect(classifyShellSegment('cr review').verdict).toBe('block');
    expect(classifyShellSegment('cr billing upgrade').verdict).toBe('block');
  });

  it('blocks a forbidden segment hidden in a chain', () => {
    const env = { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never.json') };
    expect(decide(bash('git status && cr review --agent --use-credits'), env).allow).toBe(false);
    expect(decide(bash('cr doctor; cr code push'), env).allow).toBe(false);
    expect(decide(pwsh('git status; coderabbit skills install'), env).allow).toBe(false);
  });
});

describe('coderabbit-guard classifyShellSegment: leading executable', () => {
  it.each([
    'cr review --agent',
    'cr.exe review --agent',
    'coderabbit review --agent',
    'coderabbit.exe review --agent',
    './cr review --agent',
    'C:\\Tools\\cr.exe review --agent',
    '"C:\\Program Files\\CodeRabbit\\cr.exe" review --agent',
    'FOO=bar BAZ="a b" cr review --agent',
    'npx cr review --agent',
    'npx -y coderabbit review --agent',
    'cmd /c cr review --agent',
    'pwsh -NoProfile -c "cr review --agent"',
    'bash -c "cr review --agent"',
  ])('counts as one run: %s', (seg) => {
    const c = classifyShellSegment(seg);
    expect(c.verdict).toBe('allow');
    expect(c.countsRun).toBe(true);
  });

  it.each([
    'git push fork feat/ccv3-cr-install',
    'git checkout feat/ccv3-cr-install',
    'git add .claude/rules-ondemand/coderabbit-cli.md',
    'git commit -m "feat(review): CodeRabbit gate --api-key docs"',
    'cat .coderabbit.yaml',
    'gh api repos/x/y/pulls/155',
    'echo cr',
    'grep -n coderabbit file',
    'git status',
    'echo "npx skills add coderabbitai/skills"',
  ])('ignores a segment that only mentions the word: %s', (seg) => {
    expect(classifyShellSegment(seg).verdict).toBe('ignore');
  });
});

describe('coderabbit-guard classifyShellSegment: read-only allow list', () => {
  it.each([
    'cr doctor',
    'cr usage',
    'cr usage --agent',
    'cr auth login',
    'cr auth status',
    'cr --help',
    'cr -h',
    'cr review --help',
    'cr review --agent --help',
    'cr --version',
    'coderabbit.exe doctor',
    'coderabbit usage --agent',
    'coderabbit auth status',
    'coderabbit --version',
  ])('allows without counting a run: %s', (seg) => {
    const c = classifyShellSegment(seg);
    expect(c.verdict).toBe('allow');
    expect(c.countsRun).toBeFalsy();
  });

  it('still blocks code new even when --help is present', () => {
    expect(classifyShellSegment('cr code new --help').verdict).toBe('block');
  });
});

describe('coderabbit-guard run cap', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'repo#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the env override for the state path', () => {
    expect(statePath(env)).toBe(stateFile);
  });

  it('allows runs 1-2 and blocks run 3 for the same repo+branch key', () => {
    const cmd = bash('cr review --agent');
    expect(decide(cmd, env).allow).toBe(true);
    expect(decide(cmd, env).allow).toBe(true);
    expect(decide(cmd, env).allow).toBe(false);
  });

  it.each(['&&', '||', ';', '|', '\n'])('counts both cr review segments joined by %j as 2 runs', (sep) => {
    const chained = `cr review --agent ${sep} cr review --agent`;
    expect(decide(bash(chained), env).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(2);
    expect(decide(bash('cr review --agent'), env).allow).toBe(false);
  });

  it('counts PowerShell ; chains and a pwsh -c wrapper with two runs inside', () => {
    expect(decide(pwsh('cr review --agent; cr review --agent'), env).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(2);
    rmSync(stateFile);
    expect(decide(bash('pwsh -c "cr review --agent && cr review --agent"'), env).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(2);
  });

  it('blocks a chain with 3 runs and records nothing', () => {
    const three = 'cr review --agent && cr review --agent && cr review --agent';
    expect(decide(bash(three), env).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('blocks a chain that would cross the cap and keeps the old count', () => {
    expect(decide(bash('cr review --agent'), env).allow).toBe(true);
    expect(decide(bash('cr review --agent && cr review --agent'), env).allow).toBe(false);
    expect(readState(stateFile).counts['repo#main']).toBe(1);
  });

  it('blocked run 3 does not raise the stored count', () => {
    for (let i = 0; i < 4; i++) decide(bash('cr review --agent'), env);
    expect(readState(stateFile).counts['repo#main']).toBe(2);
  });

  it('counts a run at PreToolUse time, before any result exists, so failed or rate-limited runs consume a slot', () => {
    // The guard never sees the exit code or output of the run. Allowing the call is the count.
    expect(decide(bash('cr review --agent'), env).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(1);
  });

  it('read-only commands never count and never write state', () => {
    for (const c of ['cr doctor', 'cr usage --agent', 'cr auth status', 'cr --help', 'cr --version']) {
      expect(decide(bash(c), env).allow).toBe(true);
    }
    expect(existsSync(stateFile)).toBe(false);
    expect(decide(bash('cr doctor && cr review --agent'), env).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(1);
  });

  it('keeps separate counts per repo+branch key', () => {
    const other = { ...env, CCV3_CODERABBIT_GUARD_KEY: 'repo#other' };
    decide(bash('cr review --agent'), env);
    decide(bash('cr review --agent'), env);
    expect(decide(bash('cr review --agent'), other).allow).toBe(true);
  });

  it('state holds only a counts map of numbers, no args or tokens', () => {
    decide(bash('cr review --agent --prompt secret-token'), env);
    const raw = readFileSync(stateFile, 'utf8');
    expect(raw).not.toMatch(/secret-token/);
    expect(raw).not.toMatch(/prompt|agent|review/);
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual(['counts']);
    expect(parsed.counts).toEqual({ 'repo#main': 1 });
  });

  it('writes state atomically: no temp file is left behind and the file stays valid JSON', () => {
    for (let i = 0; i < 2; i++) decide(bash('cr review --agent'), env);
    expect(readdirSync(dirname(stateFile))).toEqual(['state.json']);
    expect(() => JSON.parse(readFileSync(stateFile, 'utf8'))).not.toThrow();
  });

  it('writeState replaces an existing file in place', () => {
    writeState(stateFile, { counts: { a: 1 } });
    writeState(stateFile, { counts: { a: 2 } });
    expect(readState(stateFile).counts.a).toBe(2);
    expect(readdirSync(dirname(stateFile))).toEqual(['state.json']);
  });

  it('recordRun increments', () => {
    const s = recordRun({ counts: {} }, 'a#b');
    expect(s.counts['a#b']).toBe(1);
    expect(checkRunCap(s, 'a#b').ok).toBe(true);
    const s2 = recordRun(s, 'a#b');
    expect(checkRunCap(s2, 'a#b').ok).toBe(false);
  });
});

describe('coderabbit-guard decide: no over-block', () => {
  it.each([
    'git push fork feat/ccv3-cr-install',
    'git checkout feat/ccv3-cr-install',
    'git add .claude/rules-ondemand/coderabbit-cli.md',
    'git commit -m "feat(review): CodeRabbit gate --api-key docs"',
    'cat .coderabbit.yaml',
    'gh api repos/x/y/pulls/155',
    'echo cr',
    'grep -n coderabbit file',
  ])('allows %s on Bash and PowerShell', (command) => {
    expect(decide(bash(command), { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never.json') }).allow).toBe(true);
    expect(decide(pwsh(command), { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never.json') }).allow).toBe(true);
    expect(existsSync(join(tmpdir(), 'cr-guard-never.json'))).toBe(false);
  });
});

describe('coderabbit-guard PowerShell tool follows the Bash rules', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-ps-'));
    env = { CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'), CCV3_CODERABBIT_GUARD_KEY: 'ps#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows runs 1-2 of a call-operator path and blocks run 3', () => {
    const cmd = pwsh('& "C:\\Tools\\CodeRabbit\\cr.exe" review --agent');
    expect(decide(cmd, env).allow).toBe(true);
    expect(decide(cmd, env).allow).toBe(true);
    expect(decide(cmd, env).allow).toBe(false);
  });

  it('blocks forbidden flags, code push and read-only passes', () => {
    expect(decide(pwsh('cr review --agent --use-credits'), env).allow).toBe(false);
    expect(decide(pwsh('coderabbit.exe code push'), env).allow).toBe(false);
    expect(decide(pwsh('cr doctor'), env).allow).toBe(true);
  });
});

describe('coderabbit-guard Skill and delegate', () => {
  it('blocks coderabbit:autofix skill', () => {
    expect(decide({ tool_name: 'Skill', tool_input: { skill: 'coderabbit:autofix' } }).allow).toBe(false);
  });

  it('allows other skills', () => {
    expect(decide({ tool_name: 'Skill', tool_input: { skill: 'commit' } }).allow).toBe(true);
  });

  it.each(['Task', 'Agent'])('allows a read-only autofix %s delegate', (tool_name) => {
    expect(
      decide({
        tool_name,
        tool_input: { prompt: 'Run a read-only autofix review of the diff', subagent_type: 'critic' },
      }).allow,
    ).toBe(true);
  });

  it('blocks a delegate that carries the autofix skill', () => {
    expect(
      decide({
        tool_name: 'Agent',
        tool_input: { skill: 'coderabbit:autofix', prompt: 'read-only autofix' },
      }).allow,
    ).toBe(false);
  });
});

describe('coderabbit-guard dist e2e', () => {
  let dir: string;
  let childEnv: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-dist-'));
    childEnv = {
      CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'),
      CCV3_CODERABBIT_GUARD_KEY: 'e2e#main',
      // The built hook runs without VITEST. Without this it appends to the real ~/.claude log.
      CCV3_GUARD_DECISIONS_LOG: join(dir, 'guard-decisions.jsonl'),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks use-credits via dist', () => {
    const r = runHook({ session_id: 'g1', ...bash('cr review --agent --use-credits') }, childEnv);
    expect(deny(r.stdout)).toBe(true);
  });

  it('allows review --agent twice then blocks third via dist', () => {
    const base = { session_id: 'g1', ...bash('cr review --agent') };
    expect(deny(runHook(base, childEnv).stdout)).toBe(false);
    expect(deny(runHook(base, childEnv).stdout)).toBe(false);
    expect(deny(runHook(base, childEnv).stdout)).toBe(true);
  });

  it('counts a chained pair as two runs via dist', () => {
    const chain = { session_id: 'g1', ...bash('cr review --agent && cr review --agent') };
    expect(deny(runHook(chain, childEnv).stdout)).toBe(false);
    expect(deny(runHook({ session_id: 'g1', ...bash('cr review --agent') }, childEnv).stdout)).toBe(true);
  });

  it('allows cr doctor and a git push of a cr branch via dist', () => {
    expect(deny(runHook({ session_id: 'g1', ...bash('cr doctor') }, childEnv).stdout)).toBe(false);
    expect(
      deny(runHook({ session_id: 'g1', ...pwsh('git push fork feat/ccv3-cr-install') }, childEnv).stdout),
    ).toBe(false);
  });

  it('allows a commit message and a PR body that talk about CodeRabbit, and uses no slot, via dist', () => {
    const commit = bash('git commit -m "feat: add guard (CodeRabbit CLI) for runs"');
    const body = pwsh("gh pr create --body @'\nCodeRabbit gate\ncr review --agent runs are capped at 2.\n'@");
    expect(deny(runHook({ session_id: 'g1', ...commit }, childEnv).stdout)).toBe(false);
    expect(deny(runHook({ session_id: 'g1', ...body }, childEnv).stdout)).toBe(false);
    expect(existsSync(childEnv.CCV3_CODERABBIT_GUARD_STATE)).toBe(false);
  });

  it('blocks billing flags behind sudo and Start-Process via dist', () => {
    expect(deny(runHook({ session_id: 'g1', ...bash('sudo cr review --agent --use-credits') }, childEnv).stdout)).toBe(true);
    expect(deny(runHook({ session_id: 'g1', ...pwsh('Start-Process cr -ArgumentList "review --agent --use-credits"') }, childEnv).stdout)).toBe(true);
  });

  it('writes an override line to the decision log, and only for a leading assignment, via dist', () => {
    const log = childEnv.CCV3_GUARD_DECISIONS_LOG;
    const echoed = runHook({ session_id: 'g1', ...bash('echo SKIP_CODERABBIT_GUARD=1 && cr review --use-credits') }, childEnv);
    expect(deny(echoed.stdout)).toBe(true);
    const led = runHook({ session_id: 'g2', ...bash('SKIP_CODERABBIT_GUARD=1 cr review --use-credits') }, childEnv);
    expect(deny(led.stdout)).toBe(false);
    const kinds = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).decision);
    expect(kinds).toEqual(['deny', 'override']);
  });

  it('blocks autofix skill via dist', () => {
    const r = runHook({ session_id: 'g1', tool_name: 'Skill', tool_input: { skill: 'coderabbit:autofix' } }, childEnv);
    expect(deny(r.stdout)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Review round. Failure modes:
//  1. Quoted text and heredoc bodies are split like shell code, so ordinary git and gh commands
//     that talk about CodeRabbit are denied, or burn a run slot.
//  2. Shell constructs and wrappers that run a command are not unwrapped, so billing flags pass.
//  3. The run counter key ignores the payload cwd and shares one key across repos and detached HEADs.
//  4. The override matches anywhere in the command and leaves no audit line.
// ---------------------------------------------------------------------------------------------
describe('coderabbit-guard: prose about CodeRabbit inside quotes and heredocs is not a CodeRabbit call', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-prose-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'prose#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, string]> = [
    ['parenthesis inside a double-quoted commit message', 'git commit -m "feat: add guard (CodeRabbit CLI) for runs"'],
    [
      'unquoted-delimiter heredoc body line starting with the tool name',
      'git commit -F - <<EOF\nfeat: gate\n\nCodeRabbit reviews are advisory.\ncr review --agent runs are capped at 2.\nEOF',
    ],
    [
      'quoted-delimiter heredoc body',
      "git commit -F - <<'EOF'\nfeat: gate\n\nCodeRabbit reviews are advisory.\ncr review --agent runs are capped at 2.\ncr review --use-credits is blocked.\nEOF",
    ],
    ['dash heredoc with tab-indented delimiter', 'cat <<-EOF\n\tcr review --agent --use-credits\n\tEOF'],
    ['markdown table row in a gh body', 'gh pr create --title "t" --body "| CodeRabbit | label gated |"'],
    ['semicolon and ampersand inside single quotes', "git commit -m 'a; cr review --use-credits && b'"],
    ['newline inside a double-quoted message', 'git commit -m "line one\ncr review --agent runs are capped\nline three"'],
    ['two heredocs on one line', "cat <<'A' <<'B'\ncr review --use-credits\nA\ncr review --api-key x\nB"],
  ];

  it.each(cases)('allows and uses no slot on Bash: %s', (_name, cmd) => {
    expect(decide(bash(cmd), env).allow).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('allows a PowerShell here-string body that names the tool and a forbidden flag', () => {
    const cmd = "gh pr create --title 't' --body @'\nCodeRabbit gate: it's advisory\ncr review --agent --use-credits is forbidden\n'@";
    expect(decide(pwsh(cmd), env).allow).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('does not treat a backtick in a PowerShell double-quoted string as command substitution', () => {
    expect(decide(pwsh('gh pr comment 1 --body "Run `cr review --use-credits` never"'), env).allow).toBe(true);
    expect(decide(bash('gh pr comment 1 --body "Run `cr review --use-credits` never"'), env).allow).toBe(false);
  });

  it('still scans real commands next to quoted text', () => {
    expect(decide(bash('git commit -m "a; b" && cr review --use-credits'), env).allow).toBe(false);
    expect(decide(bash("cat <<'EOF'\nprose\nEOF\ncr review --use-credits"), env).allow).toBe(false);
    expect(decide(bash('echo "$(cr review --use-credits)"'), env).allow).toBe(false);
    expect(decide(bash('echo "a `cr review --use-credits` b"'), env).allow).toBe(false);
    expect(decide(bash("echo 'x' ; cr review --use-credits"), env).allow).toBe(false);
  });

  it('reads a heredoc or here-string that feeds a shell as a script', () => {
    expect(decide(bash("bash <<'EOF'\ncr review --use-credits\nEOF"), env).allow).toBe(false);
    expect(decide(bash('sh <<-EOF\n\tcr code push\n\tEOF'), env).allow).toBe(false);
    expect(decide(bash('bash <<< "cr review --use-credits"'), env).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    expect(decide(bash('sh <<EOF\ncr review --agent\nEOF'), env).allow).toBe(true);
    expect(readState(stateFile).counts['prose#main']).toBe(1);
  });

  it('keeps a command after a heredoc separate, and lets two heredocs share one command', () => {
    expect(decide(bash("cat <<'A' <<'B'\nprose\nA\nprose\nB\ncr review --use-credits"), env).allow).toBe(false);
    expect(decide(bash("cat <<'A' <<'B'\ncr review --use-credits\nA\ncr review --api-key x\nB"), env).allow).toBe(true);
  });

  it('treats an unclosed quote as a literal, so a command after it is still scanned', () => {
    expect(decide(bash('echo "oops; cr review --use-credits'), env).allow).toBe(false);
    expect(decide(bash("echo it's; cr review --use-credits"), env).allow).toBe(false);
  });

  it('counts two runs inside one quoted wrapper string', () => {
    expect(decide(bash("bash -c 'cr review --agent; cr review --agent'"), env).allow).toBe(true);
    expect(readState(stateFile).counts['prose#main']).toBe(2);
  });
});

describe('coderabbit-guard: wrappers and shell constructs that run a command', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-wrap-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'wrap#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const wrap = (flags: string): Array<[string, string]> => [
    ['if/then', `if true; then cr review ${flags}; fi`],
    ['if condition', `if cr review ${flags}; then echo done; fi`],
    ['brace group', `{ cr review ${flags}; }`],
    ['negation', `! cr review ${flags}`],
    ['sudo', `sudo cr review ${flags}`],
    ['doas', `doas cr review ${flags}`],
    ['xargs', `echo x | xargs cr review ${flags}`],
    ['eval', `eval "cr review ${flags}"`],
    ['for loop', `for i in 1 2 3 4 5; do cr review ${flags}; done`],
    ['while loop', `while true; do cr review ${flags}; done`],
    ['iex', `iex "cr review ${flags}"`],
    ['Invoke-Expression', `Invoke-Expression 'cr review ${flags}'`],
    ['Start-Process ArgumentList', `Start-Process cr -ArgumentList "review ${flags}"`],
    ['Start-Process FilePath and list', `Start-Process -FilePath cr -ArgumentList review,${flags.split(' ').join(',')}`],
    ['Start-Job', `Start-Job { cr review ${flags} }`],
    ['ForEach-Object', `1..5 | ForEach-Object { cr review ${flags} }`],
    ['percent alias', `1..5 | % { cr review ${flags} }`],
    ['bash -c', `bash -c 'cr review ${flags}'`],
    ['nested wrappers', `sudo bash -c "eval 'cr review ${flags}'"`],
  ];

  it.each(wrap('--agent --use-credits'))('blocks billing flags behind %s', (_name, cmd) => {
    expect(decide(bash(cmd), env).allow).toBe(false);
    expect(decide(pwsh(cmd), env).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  it.each(wrap('--agent'))('counts exactly one run behind %s (a loop is counted once: the iteration count is not visible)', (_name, cmd) => {
    expect(decide(bash(cmd), env).allow).toBe(true);
    expect(readState(stateFile).counts['wrap#main']).toBe(1);
  });

  it.each([
    ['sudo', 'sudo cr code push'],
    ['eval', 'eval "cr skills install"'],
    ['Start-Process', 'Start-Process cr -ArgumentList "code new"'],
    ['xargs', 'echo x | xargs coderabbit --api-key=abc'],
  ])('blocks other forbidden commands behind %s', (_name, cmd) => {
    expect(decide(bash(cmd), env).allow).toBe(false);
  });

  it('does not unwrap a wrapper that runs something else', () => {
    for (const c of ['sudo apt update', 'eval "echo cr"', 'Start-Process notepad', 'echo x | xargs echo cr', 'if true; then git status; fi']) {
      expect(decide(bash(c), env).allow).toBe(true);
    }
    expect(existsSync(stateFile)).toBe(false);
  });
});

// Real git runs are slow on this machine (seconds each under load), so this block gets a long timeout.
describe('coderabbit-guard: run counter key', { timeout: 180_000 }, () => {
  let dir: string;
  // git on this machine sometimes dies at start-up (the MSYS fork storm, see CONTEXT.md), so retry.
  const git = (cwd: string, ...args: string[]): string => {
    for (let attempt = 1; ; attempt++) {
      try {
        return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch (err) {
        if (attempt >= 3) throw err;
      }
    }
  };
  const makeRepo = (name: string, branch: string, remote?: string, commit = false) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', branch);
    if (remote) git(path, 'remote', 'add', 'fork', remote);
    if (commit) git(path, 'commit', '-q', '--allow-empty', '-m', `init ${name}`);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-key-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps two repos with the same branch name apart when neither has an origin remote', () => {
    const a = makeRepo('a', 'feat/x');
    const b = makeRepo('b', 'feat/x');
    expect(repoBranchKey(a, {})).not.toBe(repoBranchKey(b, {}));
  });

  it('uses the first remote, not only origin, and never puts credentials in the key', () => {
    const a = makeRepo('a', 'feat/x', 'https://user:secret@github.com/Rev4nchist/Continuous-Claude-v3.git');
    const key = repoBranchKey(a, {});
    expect(key).toBe('Continuous-Claude-v3#feat/x');
    expect(key).not.toMatch(/secret/);
  });

  it('keys a detached HEAD by commit, not by the shared name HEAD', () => {
    const a = makeRepo('a', 'main', undefined, true);
    git(a, 'checkout', '-q', '--detach');
    const first = repoBranchKey(a, {});
    git(a, 'commit', '-q', '--allow-empty', '-m', 'second');
    const second = repoBranchKey(a, {});
    expect(first).not.toMatch(/#HEAD$/);
    expect(second).not.toBe(first);
  });

  it('reads the payload cwd, not the hook process cwd', () => {
    const a = makeRepo('a', 'feat/a');
    const b = makeRepo('b', 'feat/b');
    const stateFile = join(dir, 'state.json');
    const env = { CCV3_CODERABBIT_GUARD_STATE: stateFile };
    expect(decide({ ...bash('cr review --agent'), cwd: a }, env).allow).toBe(true);
    expect(decide({ ...bash('cr review --agent'), cwd: b }, env).allow).toBe(true);
    expect(Object.keys(readState(stateFile).counts).sort()).toEqual([repoBranchKey(a, {}), repoBranchKey(b, {})].sort());
  });

  it('follows a leading cd, because subagents run every command as cd <worktree> && ...', () => {
    const a = makeRepo('a', 'feat/a');
    const b = makeRepo('b', 'feat/b');
    const stateFile = join(dir, 'state.json');
    const env = { CCV3_CODERABBIT_GUARD_STATE: stateFile };
    expect(decide({ ...bash(`cd "${b}" && cr review --agent`), cwd: a }, env).allow).toBe(true);
    expect(Object.keys(readState(stateFile).counts)).toEqual([repoBranchKey(b, {})]);
  });
});

describe('coderabbit-guard: override', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let logFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-ovr-'));
    logFile = join(dir, 'decisions.jsonl');
    env = {
      CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'),
      CCV3_CODERABBIT_GUARD_KEY: 'ovr#main',
      CCV3_GUARD_DECISIONS_LOG: logFile,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    'echo SKIP_CODERABBIT_GUARD=1 && cr review --use-credits',
    'echo "SKIP_CODERABBIT_GUARD=1"; cr review --use-credits',
    '# SKIP_CODERABBIT_GUARD=1\ncr review --use-credits',
    'cr review --use-credits # SKIP_CODERABBIT_GUARD=1',
    'SKIP_CODERABBIT_GUARD=10 cr review --use-credits',
  ])('does not accept the marker anywhere but the start: %s', (cmd) => {
    expect(decide(bash(cmd), env).allow).toBe(false);
    expect(existsSync(logFile)).toBe(false);
  });

  it.each([
    ['Bash', bash('SKIP_CODERABBIT_GUARD=1 cr review --use-credits')],
    ['PowerShell', pwsh('$env:SKIP_CODERABBIT_GUARD=1; cr review --use-credits')],
  ])('accepts a leading assignment on %s and writes an override line', (_t, input) => {
    expect(decide({ session_id: 's1', ...input }, env).allow).toBe(true);
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ hook: 'coderabbit-guard', decision: 'override', session_id: 's1' });
  });
});
