/**
 * agent-model-guard: a hint, never a gate. Claude Code rejects an unknown agent type itself
 * (probe 2026-11-17: "Agent type 'no-such-agent-xyz' not found. Available agents: ..."), so this hook
 * never denies. It adds a "did you mean" hint for a near typo, flags an unknown name for a warn row,
 * and warns when an agent file shadows a built-in name.
 *
 * Failure modes covered (each test names the source change that breaks it):
 *  1. project agent in <cwd>/.claude/agents not found         -> drop the cwd lookup
 *  2. project agent found only via CLAUDE_PROJECT_DIR missed   -> drop the env lookup
 *  3. cwd missing from payload crashes                         -> assume cwd is a string
 *  4. CLAUDE_PROJECT_DIR unset crashes                         -> assume env is set
 *  5. Windows separators (forward slash cwd)                   -> build paths by string concat
 *  6. plugin agent "plugin:name" flagged unknown               -> drop the ':' allow
 *  7. built-in web-fetch, fork or claude flagged or denied     -> drop it from BUILTIN_AGENTS
 *  8. an unknown name is denied, or is not flagged unknown     -> keep the old deny / drop the flag
 *  9. path traversal name read as an agent file or in a hint   -> drop the separator check
 * 10. "did you mean" ignores project dirs                      -> suggest from home dir only
 * 11. fs error flagged unknown (a false warn row)              -> set unknown on the catch path
 * 12. a far name gets a hint (noise)                           -> widen the matcher
 * 13. near-but-not-close fork vs spark gets a hint             -> keep the substring rule or <=3 edits
 * 14. a same-name file shadows a built-in with no hint         -> skip the shadow check
 * 15. the output auto-approves or denies                       -> print permissionDecision on any path
 * 16. a repo agent file takes a built-in name                  -> add web-fetch.md or similar to .claude/agents
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { decide, agentDirs, buildOutput, BUILTIN_AGENTS } from '../agent-model-guard.js';

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
  agentFile(home, 'spark');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('agent-model-guard decide(): found agents', () => {
  it('finds a project agent under <cwd>/.claude/agents: allow, not unknown', () => {
    agentFile(project, 'probe-pinned');
    const d = decide(call('probe-pinned', project) as never, { home });
    expect(d).toEqual({ allow: true });
  });

  it('finds a project agent only via CLAUDE_PROJECT_DIR', () => {
    agentFile(project, 'probe-pinned');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    expect(decide(call('probe-pinned', elsewhere) as never, { home, projectDir: project })).toEqual({ allow: true });
  });

  it('does not crash when cwd is missing, and still finds the home agent', () => {
    expect(decide(call('scout') as never, { home })).toEqual({ allow: true });
  });

  it('works with CLAUDE_PROJECT_DIR unset', () => {
    agentFile(project, 'probe-pinned');
    expect(decide(call('probe-pinned', project) as never, { home, projectDir: undefined })).toEqual({ allow: true });
  });

  it('accepts a cwd written with forward slashes on Windows', () => {
    agentFile(project, 'probe-pinned');
    const slashed = project.replace(/\\/g, '/');
    expect(decide(call('probe-pinned', slashed) as never, { home })).toEqual({ allow: true });
  });

  it('allows plugin agents (name contains a colon) and does not flag them unknown', () => {
    expect(decide(call('plugin-dev:agent-creator', project) as never, { home })).toEqual({ allow: true });
  });
});

describe('agent-model-guard decide(): built-ins', () => {
  for (const name of ['web-fetch', 'fork', 'claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup']) {
    it(`allows the built-in ${name} with no agent file, not unknown, no hint`, () => {
      expect(BUILTIN_AGENTS.has(name)).toBe(true);
      expect(decide(call(name, project) as never, { home, projectDir: project })).toEqual({ allow: true });
    });
  }

  it('hints and flags a shadow when an agents dir holds a file with a built-in name (any case)', () => {
    agentFile(project, 'Web-Fetch');
    const d = decide(call('web-fetch', project) as never, { home });
    expect(d.allow).toBe(true);
    expect(d.unknown).toBeUndefined();
    expect(d.shadow).toBe(path.join(project, '.claude', 'agents', 'Web-Fetch.md'));
    expect(d.hint).toContain('web-fetch is overridden by');
  });

  it('finds a shadow in the home agents dir too', () => {
    agentFile(home, 'fork');
    const d = decide(call('fork', project) as never, { home });
    expect(d.shadow).toBe(path.join(home, '.claude', 'agents', 'fork.md'));
  });
});

describe('agent-model-guard decide(): unknown names never deny', () => {
  it('allows an unknown name and flags it unknown, with no hint for a far name', () => {
    const d = decide(call('no-such-agent-xyz', project) as never, { home, projectDir: project });
    expect(d).toEqual({ allow: true, unknown: true });
  });

  it('allows a never-seen built-in name and flags it unknown (drift signal)', () => {
    expect(decide(call('brand-new-builtin-xyz', project) as never, { home })).toEqual({ allow: true, unknown: true });
  });

  it('ignores a relative or non-string cwd and still allows', () => {
    expect(decide({ ...call('nope'), cwd: 42 } as never, { home }).allow).toBe(true);
    expect(decide({ ...call('nope'), cwd: '.' } as never, { home }).allow).toBe(true);
  });

  it('hints a near typo of a custom agent', () => {
    const d = decide(call('scuot', project) as never, { home });
    expect(d.allow).toBe(true);
    expect(d.unknown).toBe(true);
    expect(d.hint).toContain('Did you mean: scout');
  });

  it('suggests a project-only agent in "did you mean"', () => {
    agentFile(project, 'probe-pinned');
    const d = decide(call('probe-pinnd', path.join(root, 'elsewhere')) as never, { home, projectDir: project });
    expect(d.hint).toContain('Did you mean: probe-pinned');
  });

  it('gives no hint for a name 3 edits from a custom agent (the old matcher tied fork to spark this way)', () => {
    // gork -> spark is 3 edits, like fork -> spark; fork itself is a built-in and never reaches the matcher.
    const d = decide(call('gork', project) as never, { home });
    expect(d).toEqual({ allow: true, unknown: true });
  });

  it('gives no hint for a short name that is only a substring of a custom agent', () => {
    const d = decide(call('spa', project) as never, { home });
    expect(d.hint).toBeUndefined();
  });

  it('never reads a traversal name as an agent file and never puts it in a hint', () => {
    fs.mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'secret.md'), 'x');
    const d = decide(call('../secret', project) as never, { home });
    expect(d.allow).toBe(true);
    expect(d.unknown).toBe(true);
    expect(d.hint ?? '').not.toContain('secret');
  });

  it('fails open on a non-ENOENT fs error and does not flag it unknown', () => {
    // A NUL byte in the path makes statSync throw ERR_INVALID_ARG_VALUE, which is not ENOENT.
    const d = decide(call('ghost', project + '\0bad') as never, { home });
    expect(d).toEqual({ allow: true });
  });

  it('allows non-Agent tools and empty subagent_type with no flag', () => {
    expect(decide({ tool_name: 'Bash', tool_input: {} } as never, { home })).toEqual({ allow: true });
    expect(decide({ tool_name: 'Agent', tool_input: {} } as never, { home })).toEqual({ allow: true });
  });
});

describe('agent-model-guard buildOutput()', () => {
  it('prints an empty object for a plain allow: no permissionDecision, so no auto-approve', () => {
    expect(buildOutput({ allow: true })).toEqual({});
    expect(buildOutput({ allow: true, unknown: true })).toEqual({});
  });

  it('prints the hint as additionalContext, with no permissionDecision', () => {
    const out = buildOutput({ allow: true, unknown: true, hint: 'Did you mean: scout?' }) as Record<string, any>;
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Did you mean: scout?' } });
    expect(JSON.stringify(out)).not.toContain('permissionDecision');
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

describe('repo agents folder', () => {
  it('holds no agent file with the name of a Claude Code built-in (it would shadow the built-in)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const agentsDir = path.resolve(here, '..', '..', '..', 'agents');
    const names = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3).toLowerCase());
    expect(names.length).toBeGreaterThan(5);
    const builtins = [...BUILTIN_AGENTS].map(b => b.toLowerCase());
    expect(names.filter(n => builtins.includes(n))).toEqual([]);
  });
});
