/**
 * agent-model-guard: denies only when an agent definition is missing from every agents dir.
 *
 * Failure modes covered (each test names the source change that breaks it):
 *  1. project agent in <cwd>/.claude/agents denied          -> drop the cwd lookup
 *  2. project agent found only via CLAUDE_PROJECT_DIR denied -> drop the env lookup
 *  3. cwd missing from payload crashes or denies             -> assume cwd is a string
 *  4. CLAUDE_PROJECT_DIR unset crashes or denies             -> assume env is set
 *  5. Windows separators (forward slash cwd, mixed case)     -> build paths by string concat
 *  6. plugin agent "plugin:name" denied                      -> drop the ':' allow
 *  7. built-in "claude" denied                               -> drop it from BUILTIN_AGENTS
 *  8. unknown agent allowed                                  -> over-broad allow
 *  9. path traversal name resolves outside an agents dir     -> drop the separator check
 * 10. "did you mean" ignores project dirs                    -> suggest from home dir only
 * 11. fs error other than ENOENT denies                      -> deny on any throw
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { decide, agentDirs, BUILTIN_AGENTS } from '../agent-model-guard.js';

let root: string;
let home: string;
let project: string;

function agentFile(base: string, name: string): void {
  const dir = path.join(base, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), '---\nname: ' + name + '\n---\n');
}

function call(type: string, cwd?: string | null) {
  const input: Record<string, unknown> = { tool_name: 'Agent', tool_input: { subagent_type: type, prompt: 'hi' } };
  if (cwd !== null && cwd !== undefined) input.cwd = cwd;
  return input;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  agentFile(home, 'scout');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('agent-model-guard decide()', () => {
  it('allows a project agent found under <cwd>/.claude/agents', () => {
    agentFile(project, 'probe-pinned');
    expect(decide(call('probe-pinned', project) as never, { home }).allow).toBe(true);
  });

  it('allows a project agent found only via CLAUDE_PROJECT_DIR', () => {
    agentFile(project, 'probe-pinned');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    expect(decide(call('probe-pinned', elsewhere) as never, { home, projectDir: project }).allow).toBe(true);
  });

  it('does not crash when cwd is missing, and still finds the home agent', () => {
    expect(decide(call('scout') as never, { home }).allow).toBe(true);
    expect(decide(call('nope') as never, { home }).allow).toBe(false);
  });

  it('ignores a relative or non-string cwd', () => {
    expect(decide({ ...call('nope'), cwd: 42 } as never, { home }).allow).toBe(false);
    expect(decide({ ...call('nope'), cwd: '.' } as never, { home }).allow).toBe(false);
  });

  it('works with CLAUDE_PROJECT_DIR unset', () => {
    agentFile(project, 'probe-pinned');
    expect(decide(call('probe-pinned', project) as never, { home, projectDir: undefined }).allow).toBe(true);
  });

  it('accepts a cwd written with forward slashes on Windows', () => {
    agentFile(project, 'probe-pinned');
    const slashed = project.replace(/\\/g, '/');
    expect(decide(call('probe-pinned', slashed) as never, { home }).allow).toBe(true);
  });

  it('allows plugin agents (name contains a colon) without touching the fs', () => {
    expect(decide(call('plugin-dev:agent-creator', project) as never, { home }).allow).toBe(true);
  });

  it('allows the built-in claude agent', () => {
    expect(BUILTIN_AGENTS.has('claude')).toBe(true);
    expect(decide(call('claude', project) as never, { home }).allow).toBe(true);
  });

  it('denies an unknown agent and names every dir it searched', () => {
    const d = decide(call('no-such-agent-xyz', project) as never, { home, projectDir: project });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain(path.join(project, '.claude', 'agents'));
      expect(d.reason).toContain(path.join(home, '.claude', 'agents'));
    }
  });

  it('denies a traversal name that would resolve to a real file outside the agents dir', () => {
    fs.mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'secret.md'), 'x');
    const d = decide(call('../secret', project) as never, { home });
    expect(d.allow).toBe(false);
  });

  it('suggests a project-only agent in "did you mean"', () => {
    agentFile(project, 'probe-pinned');
    const d = decide(call('probe-pinnd', path.join(root, 'elsewhere')) as never, { home, projectDir: project });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('Did you mean: probe-pinned');
  });

  it('fails open when an agents path raises a non-ENOENT fs error', () => {
    // A NUL byte in the path makes statSync throw ERR_INVALID_ARG_VALUE, which is not ENOENT.
    const d = decide(call('ghost', project + '\0bad') as never, { home });
    expect(d.allow).toBe(true);
  });

  it('allows non-Agent tools and empty subagent_type', () => {
    expect(decide({ tool_name: 'Bash', tool_input: {} } as never, { home }).allow).toBe(true);
    expect(decide({ tool_name: 'Agent', tool_input: {} } as never, { home }).allow).toBe(true);
  });
});

describe('agent-model-guard agentDirs()', () => {
  it('keeps two dirs that differ only by case (case-sensitive filesystems; CodeRabbit PR #68)', () => {
    const cwd = path.join(path.sep, 'work', 'app');
    const projectDir = path.join(path.sep, 'work', 'App');
    const dirs = agentDirs(cwd, { home: path.join(path.sep, 'home', 'u'), projectDir });
    expect(dirs).toContain(path.join(cwd, '.claude', 'agents'));
    expect(dirs).toContain(path.join(projectDir, '.claude', 'agents'));
  });
});
