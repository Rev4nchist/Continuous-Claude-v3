/**
 * Card guard-skip-prefix-unattended: a typed SKIP_ override must not lift a guard in an unattended run.
 *
 * Every row runs the BUILT hook (dist/<guard>.mjs) with a real PreToolUse payload in a child process, so the
 * hook reads its own env and payload exactly as Claude Code gives them. The registry is stubbed for the package guard.
 *
 * Run kinds (the hook's own view of the run):
 *   interactive: permission_mode default, ATTENDED=1            -> the override works as before (control rows)
 *   bypass:      permission_mode bypassPermissions              -> locked
 *   agent:       env CLAUDE_AGENT_ID set (a subagent)           -> locked
 *   ci:          env CI=true                                    -> locked
 *   headless:    env CLAUDE_CODE_SESSION_ATTENDED=0 (claude -p) -> locked (read from a real run: capture 02 of the card)
 * Forms per guard: the typed leading prefix (sh and PowerShell) and, where the guard has one, the env form.
 * GREEN needs `npm run build` in .claude/hooks first: the rows read dist/*.mjs.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NET_STUB = fileURLToPath(new URL('./package-guard-net-stub.cjs', import.meta.url));
const distOf = (name: string) => fileURLToPath(new URL(`../../dist/${name}.mjs`, import.meta.url));

type Guard = 'destructive-command-guard' | 'package-install-guard' | 'pre-pr-gate';
type Kind = 'interactive' | 'bypass' | 'agent' | 'ci' | 'headless';

interface RunKind { mode: string; env: Record<string, string> }

const KINDS: Record<Kind, RunKind> = {
  interactive: { mode: 'default', env: {} },
  bypass: { mode: 'bypassPermissions', env: {} },
  agent: { mode: 'default', env: { CLAUDE_AGENT_ID: 'sub-agent-1' } },
  ci: { mode: 'default', env: { CI: 'true' } },
  headless: { mode: 'default', env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } },
};
const LOCKED: Kind[] = ['bypass', 'agent', 'ci', 'headless'];

interface Run { decision: string | undefined; reason: string; log: Array<Record<string, unknown>> }

function runGuard(guard: Guard, tool: string, command: string, kind: Kind, extraEnv: Record<string, string> = {}, agentId?: string): Run {
  const dist = distOf(guard);
  expect(existsSync(dist)).toBe(true);
  const home = mkdtempSync(join(tmpdir(), 'gsp-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'gsp-cwd-'));
  const logPath = join(home, 'guard-decisions.jsonl');
  const run = KINDS[kind];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The control state first: nothing unattended, no override in the env, a registry stub for the package guard.
    CLAUDE_AGENT_ID: '',
    CI: '',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    SKIP_DESTRUCTIVE_GUARD: '',
    SKIP_PACKAGE_GUARD: '',
    SKIP_PRE_PR_GATE: '',
    CCV3_GUARD_DECISIONS_LOG: logPath,
    CCV3_GUARD_RC_HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PIG_STUB_AGE_HOURS: '1', // a package published an hour ago: a detected install is denied
    PIG_STUB_NEXT_HOURS: '1',
    ...run.env,
    ...extraEnv,
  };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.CDPATH;
  const args = guard === 'package-install-guard' ? ['-r', NET_STUB, dist] : [dist];
  const res = spawnSync(process.execPath, args, {
    input: JSON.stringify({ session_id: 'gsp-session', tool_name: tool, tool_input: { command }, cwd, permission_mode: run.mode, ...(agentId === undefined ? {} : { agent_id: agentId }) }),
    encoding: 'utf8',
    timeout: 25_000,
    env,
    cwd,
  });
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout.trim().split('\n').pop() || '{}');
  const log = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return {
    decision: out.hookSpecificOutput?.permissionDecision,
    reason: String(out.hookSpecificOutput?.permissionDecisionReason ?? ''),
    log,
  };
}

const IGNORED_TEXT = /override is ignored in an unattended or bypass run/i;
const allowed = (r: Run) => r.decision === undefined || r.decision === 'allow';
const gated = (r: Run) => r.decision === 'ask' || r.decision === 'deny';
const ignoredRow = (r: Run) => r.log.some((row) => row.decision === 'warn' && /override-ignored/.test(String(row.reason)));

interface Form { name: string; guard: Guard; tool: 'Bash' | 'PowerShell'; command: string; env?: Record<string, string> }

const FORMS: Form[] = [
  // destructive-command-guard: leading sh prefix (:139), leading PowerShell statement (:140), env form (:139)
  { name: 'destructive sh prefix', guard: 'destructive-command-guard', tool: 'Bash', command: 'SKIP_DESTRUCTIVE_GUARD=1 rm -rf zz-skip-target' },
  { name: 'destructive PowerShell statement', guard: 'destructive-command-guard', tool: 'PowerShell', command: "$env:SKIP_DESTRUCTIVE_GUARD='1'; Remove-Item -Recurse -Force .\\zz-skip-target" },
  { name: 'destructive env form', guard: 'destructive-command-guard', tool: 'Bash', command: 'rm -rf zz-skip-target', env: { SKIP_DESTRUCTIVE_GUARD: '1' } },
  // package-install-guard: BASH_OVERRIDE (:1329), assignments before it, PS_OVERRIDE (:1333). No env form.
  { name: 'package sh prefix', guard: 'package-install-guard', tool: 'Bash', command: 'SKIP_PACKAGE_GUARD=1 npm install zz-fake-pkg-a1' },
  { name: 'package sh prefix among assignments', guard: 'package-install-guard', tool: 'Bash', command: 'FOO=bar SKIP_PACKAGE_GUARD=1 npm install zz-fake-pkg-a1' },
  { name: 'package PowerShell statement', guard: 'package-install-guard', tool: 'PowerShell', command: '$env:SKIP_PACKAGE_GUARD=1; npm install zz-fake-pkg-a1' },
  // pre-pr-gate: leading sh prefix (:466), leading PowerShell statement (:467), env form (:465). The cwd is no git folder: the gate cannot verify.
  { name: 'pre-pr sh prefix', guard: 'pre-pr-gate', tool: 'Bash', command: 'SKIP_PRE_PR_GATE=1 gh pr create --fill' },
  { name: 'pre-pr PowerShell statement', guard: 'pre-pr-gate', tool: 'PowerShell', command: "$env:SKIP_PRE_PR_GATE='1'; gh pr create --fill" },
  { name: 'pre-pr env form', guard: 'pre-pr-gate', tool: 'Bash', command: 'gh pr create --fill', env: { SKIP_PRE_PR_GATE: '1' } },
];

describe('guard-skip-prefix-unattended: the guard without any override (control)', { timeout: 40_000 }, () => {
  const PLAIN: Array<[Guard, 'Bash' | 'PowerShell', string]> = [
    ['destructive-command-guard', 'Bash', 'rm -rf zz-skip-target'],
    ['package-install-guard', 'Bash', 'npm install zz-fake-pkg-a1'],
    ['pre-pr-gate', 'Bash', 'gh pr create --fill'],
  ];
  it.each(PLAIN)('%s gates %s "%s" in an interactive run', (guard, tool, command) => {
    expect(gated(runGuard(guard, tool, command, 'interactive'))).toBe(true);
  });
  it.each(['bypass', 'agent', 'ci'] as Kind[])('destructive-command-guard denies a plain rm -rf in a %s run (today: also true)', (kind) => {
    expect(runGuard('destructive-command-guard', 'Bash', 'rm -rf zz-skip-target', kind).decision).toBe('deny');
  });
  // Known limit (follow-up card): isUnattended does not read ATTENDED, so a headless run with no override still gets an ask, not a deny.
  it('destructive-command-guard still gates a plain rm -rf in a headless run (ask today; deny is the follow-up card)', () => {
    expect(gated(runGuard('destructive-command-guard', 'Bash', 'rm -rf zz-skip-target', 'headless'))).toBe(true);
  });
});

describe('guard-skip-prefix-unattended: interactive path unchanged (the override still works)', { timeout: 40_000 }, () => {
  it.each(FORMS)('$name is honoured in an interactive run', (f) => {
    const r = runGuard(f.guard, f.tool, f.command, 'interactive', f.env);
    expect(allowed(r), `decision ${r.decision}: ${r.reason}`).toBe(true);
    expect(ignoredRow(r)).toBe(false);
  });
});

describe('guard-skip-prefix-unattended: a locked run ignores the override', { timeout: 40_000 }, () => {
  const ROWS = FORMS.flatMap((f) => LOCKED.map((kind) => [f.name, kind, f] as const));
  it.each(ROWS)('%s in a %s run is gated, says why and logs the ignored override', (_name, kind, f) => {
    const r = runGuard(f.guard, f.tool, f.command, kind, f.env);
    expect(gated(r), `decision ${r.decision}`).toBe(true);
    expect(r.reason).toMatch(IGNORED_TEXT);
    expect(ignoredRow(r)).toBe(true);
  });
});

describe('guard-skip-prefix-unattended: a subagent payload (agent_id) locks the override with no env flag', { timeout: 40_000 }, () => {
  const SUB: Array<[Guard, 'Bash', string]> = [
    ['destructive-command-guard', 'Bash', 'SKIP_DESTRUCTIVE_GUARD=1 rm -rf zz-skip-target'],
    ['package-install-guard', 'Bash', 'SKIP_PACKAGE_GUARD=1 npm install zz-fake-pkg-a1'],
    ['pre-pr-gate', 'Bash', 'SKIP_PRE_PR_GATE=1 gh pr create --fill'],
  ];
  // Interactive kind: mode default, no CLAUDE_AGENT_ID, ATTENDED=1. Only the payload says "subagent".
  it.each(SUB)('%s: agent_id in the payload, no env flag: the typed override is ignored', (guard, tool, command) => {
    const r = runGuard(guard, tool, command, 'interactive', {}, 'sub-agent-9');
    expect(gated(r), `decision ${r.decision}`).toBe(true);
    expect(r.reason).toMatch(IGNORED_TEXT);
    expect(ignoredRow(r)).toBe(true);
  });
  it.each(SUB)('%s control: no agent_id, same text: the override still works', (guard, tool, command) => {
    expect(allowed(runGuard(guard, tool, command, 'interactive'))).toBe(true);
  });
  it('an empty agent_id counts as none', () => {
    expect(allowed(runGuard('destructive-command-guard', 'Bash', 'SKIP_DESTRUCTIVE_GUARD=1 rm -rf zz-skip-target', 'interactive', {}, ''))).toBe(true);
  });
});

describe('guard-skip-prefix-unattended: the hook reads its own env, not the command text', { timeout: 40_000 }, () => {
  const TYPED_ATTENDED: Array<[string, Guard, 'Bash', string]> = [
    // The SKIP assignment comes first: each guard honours it only as the leading assignment, so the row would pass without the lock otherwise.
    ['destructive', 'destructive-command-guard', 'Bash', 'SKIP_DESTRUCTIVE_GUARD=1 CLAUDE_CODE_SESSION_ATTENDED=1 rm -rf zz-skip-target'],
    ['package', 'package-install-guard', 'Bash', 'SKIP_PACKAGE_GUARD=1 CLAUDE_CODE_SESSION_ATTENDED=1 npm install zz-fake-pkg-a1'],
    ['pre-pr', 'pre-pr-gate', 'Bash', 'SKIP_PRE_PR_GATE=1 CLAUDE_CODE_SESSION_ATTENDED=1 gh pr create --fill'],
  ];
  it.each(TYPED_ATTENDED)('%s: a typed ATTENDED=1 prefix does not unlock a headless run', (_n, guard, tool, command) => {
    const r = runGuard(guard, tool, command, 'headless');
    expect(gated(r), `decision ${r.decision}`).toBe(true);
  });
  it('a missing CLAUDE_CODE_SESSION_ATTENDED counts as attended (known limit): the override still works', () => {
    const r = runGuard('destructive-command-guard', 'Bash', 'SKIP_DESTRUCTIVE_GUARD=1 rm -rf zz-skip-target', 'interactive', { CLAUDE_CODE_SESSION_ATTENDED: '' });
    expect(allowed(r)).toBe(true);
  });
});
