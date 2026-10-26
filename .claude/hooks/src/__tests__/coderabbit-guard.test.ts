import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  classifyShellSegment,
  decide,
  readState,
  recordRun,
  repoBranchKey,
  statePath,
  writeState,
  checkRunCap,
} from '../coderabbit-guard.js';

const HOOK = resolve(__dirname, '../../dist/coderabbit-guard.mjs');

function runHook(input: Record<string, unknown>): { stdout: string; status: number | null } {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    env: (() => {
      const env = { ...process.env };
      delete env.VITEST;
      delete env.VITEST_WORKER_ID;
      return env;
    })(),
  });
  return { stdout: res.stdout.trim(), status: res.status };
}

function deny(stdout: string): boolean {
  const o = JSON.parse(stdout);
  return o.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('coderabbit-guard classifyShellSegment', () => {
  it('blocks --use-credits on cr review --agent', () => {
    expect(classifyShellSegment('cr review --agent --use-credits').verdict).toBe('block');
  });

  it('blocks --api-key', () => {
    expect(classifyShellSegment('coderabbit review --agent --api-key=foo').verdict).toBe('block');
  });

  it('blocks code new and code push', () => {
    expect(classifyShellSegment('cr code new').verdict).toBe('block');
    expect(classifyShellSegment('cr code push').verdict).toBe('block');
  });

  it('allows plain cr review --agent', () => {
    expect(classifyShellSegment('cr review --agent').verdict).toBe('allow');
  });

  it('blocks other cr commands', () => {
    expect(classifyShellSegment('cr doctor').verdict).toBe('block');
  });

  it('blocks skill installs', () => {
    expect(classifyShellSegment('npx skills add coderabbitai/skills -g -y').verdict).toBe('block');
    expect(classifyShellSegment('coderabbit skills install').verdict).toBe('block');
  });

  it('ignores unrelated commands', () => {
    expect(classifyShellSegment('git status').verdict).toBe('ignore');
  });

  it('checks chained segments', () => {
    expect(classifyShellSegment('git status && cr review --agent --use-credits').verdict).toBe('block');
  });
});

describe('coderabbit-guard run cap', () => {
  let stateFile: string;

  beforeEach(() => {
    stateFile = join(mkdtempSync(join(tmpdir(), 'cr-guard-')), 'state.json');
  });

  afterEach(() => {
    rmSync(join(stateFile, '..'), { recursive: true, force: true });
  });

  it('allows runs 1-2 and blocks run 3 for the same repo+branch key', () => {
    const env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'repo#main' };
    const cmd = { tool_name: 'Bash', tool_input: { command: 'cr review --agent' } };
    expect(decide(cmd, env).allow).toBe(true);
    expect(decide(cmd, env).allow).toBe(true);
    expect(decide(cmd, env).allow).toBe(false);
  });

  it('state stores only counts, no secrets', () => {
    const env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'repo#main' };
    decide({ tool_name: 'Bash', tool_input: { command: 'cr review --agent --prompt secret-token' } }, env);
    const raw = readFileSync(stateFile, 'utf8');
    expect(raw).not.toMatch(/secret-token/);
    expect(raw).not.toMatch(/api-key/);
    const state = readState(stateFile);
    expect(state.counts['repo#main']).toBe(1);
  });

  it('recordRun increments', () => {
    const s = recordRun({ counts: {} }, 'a#b');
    expect(s.counts['a#b']).toBe(1);
    expect(checkRunCap(s, 'a#b').ok).toBe(true);
    const s2 = recordRun(s, 'a#b');
    expect(checkRunCap(s2, 'a#b').ok).toBe(false);
  });
});

describe('coderabbit-guard Skill and delegate', () => {
  it('blocks coderabbit:autofix skill', () => {
    expect(decide({ tool_name: 'Skill', tool_input: { skill: 'coderabbit:autofix' } }).allow).toBe(false);
  });

  it('allows read-only autofix Task delegate', () => {
    expect(
      decide({
        tool_name: 'Task',
        tool_input: { prompt: 'Run a read-only autofix review of the diff', subagent_type: 'critic' },
      }).allow,
    ).toBe(true);
  });
});

describe('coderabbit-guard dist e2e', () => {
  let stateFile: string;

  beforeEach(() => {
    stateFile = join(mkdtempSync(join(tmpdir(), 'cr-guard-dist-')), 'state.json');
    process.env.CCV3_CODERABBIT_GUARD_STATE = stateFile;
    process.env.CCV3_CODERABBIT_GUARD_KEY = 'e2e#main';
  });

  afterEach(() => {
    delete process.env.CCV3_CODERABBIT_GUARD_STATE;
    delete process.env.CCV3_CODERABBIT_GUARD_KEY;
    if (existsSync(stateFile)) rmSync(join(stateFile, '..'), { recursive: true, force: true });
  });

  it('blocks use-credits via dist', () => {
    const r = runHook({
      session_id: 'g1',
      tool_name: 'Bash',
      tool_input: { command: 'cr review --agent --use-credits' },
    });
    expect(deny(r.stdout)).toBe(true);
  });

  it('allows review --agent twice then blocks third via dist', () => {
    const base = { session_id: 'g1', tool_name: 'Bash', tool_input: { command: 'cr review --agent' } };
    expect(deny(runHook(base).stdout)).toBe(false);
    expect(deny(runHook(base).stdout)).toBe(false);
    expect(deny(runHook(base).stdout)).toBe(true);
  });

  it('blocks autofix skill via dist', () => {
    const r = runHook({ session_id: 'g1', tool_name: 'Skill', tool_input: { skill: 'coderabbit:autofix' } });
    expect(deny(r.stdout)).toBe(true);
  });
});
