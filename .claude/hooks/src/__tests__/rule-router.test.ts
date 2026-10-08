/**
 * rule-router: a block rule must not block every fresh subagent again.
 *
 * Telemetry: about 302 of 339 rule-router denies were repeats inside subagents, because each
 * subagent has its own marker folder. A subagent is a fresh context, so it still needs the rule
 * text, but a second block costs a turn for nothing. Once the session has had the block, a
 * subagent gets the rule as additionalContext instead.
 *
 * Ways it can fail (one test each):
 *  1. A subagent is blocked again after the session already got the block.
 *  2. The main thread stops blocking once (it must keep block-once).
 *  3. A subagent that is the FIRST caller in the session is not blocked.
 *  4. The injected rule text is missing the rule body.
 *  5. A rule the session has NOT had blocked is injected instead of blocked in a subagent.
 *  6. A subagent sees the same rule twice (per-agent once is lost).
 *  7. A session's block leaks into another session.
 *  8. The main thread is injected instead of blocked after a subagent was blocked first.
 *  9. Inject-mode rules change behaviour.
 * 10. The downgrade is not visible in the fire log.
 * 11. The blocked marker survives a failed rule read, so nobody ever sees the block.
 * 12. A gate rule (subagent: block) is downgraded to an inject, so a paid call in a subagent runs unasked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { run } from '../rule-router.js';

let root: string;
let rules: string;
let state: string;
let fireLog: string;
let out: string[];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CLAUDE_RULES_ONDEMAND_DIR', 'CLAUDE_RULE_ROUTER_STATE_DIR', 'CLAUDE_RULE_ROUTER_LOG', 'CCV3_GUARD_DECISIONS_LOG', 'CLAUDE_AGENT_ID'];

const MANIFEST = {
  rules: [
    { id: 'block-a', files: ['block-a.md'], mode: 'deny-first', command: ['^alpha\\b'] },
    { id: 'block-b', files: ['block-b.md'], mode: 'deny-first', command: ['^beta\\b'] },
    { id: 'note-c', files: ['note-c.md'], mode: 'inject', command: ['^gamma\\b'] },
    // A confirm-first or spend gate: every fresh subagent is blocked, never downgraded.
    { id: 'gate-s', files: ['gate-s.md'], mode: 'deny-first', subagent: 'block', command: ['^sigma\\b'] },
  ],
};

const call = (command: string, session: string, agent?: string): string =>
  JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, ...(agent ? { agent_id: agent } : {}) });

/** Run the hook once and say what it did. */
function fire(payload: string): { kind: 'deny' | 'inject' | 'none'; text: string } {
  out = [];
  run(payload);
  const j = JSON.parse(out[out.length - 1] || '{}');
  const h = j.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return { kind: 'deny', text: h.permissionDecisionReason };
  if (h.additionalContext) return { kind: 'inject', text: h.additionalContext };
  return { kind: 'none', text: '' };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rule-router-test-'));
  rules = join(root, 'rules');
  state = join(root, 'state');
  fireLog = join(root, 'fires.jsonl');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'manifest.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(rules, 'block-a.md'), 'RULE-A-BODY');
  writeFileSync(join(rules, 'block-b.md'), 'RULE-B-BODY');
  writeFileSync(join(rules, 'note-c.md'), 'RULE-C-BODY');
  writeFileSync(join(rules, 'gate-s.md'), 'RULE-S-BODY');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.CLAUDE_AGENT_ID;
  process.env.CLAUDE_RULES_ONDEMAND_DIR = rules;
  process.env.CLAUDE_RULE_ROUTER_STATE_DIR = state;
  process.env.CLAUDE_RULE_ROUTER_LOG = fireLog;
  process.env.CCV3_GUARD_DECISIONS_LOG = join(root, 'guard.jsonl');
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

describe('main thread keeps block-once', () => {
  it('blocks the first call and lets the same rule through afterwards', () => {
    expect(fire(call('alpha run', 's1')).kind).toBe('deny');
    expect(fire(call('alpha run', 's1')).kind).toBe('none');
  });
});

describe('a subagent after the session got the block gets the rule injected', () => {
  it('injects, with the rule body, instead of blocking again', () => {
    fire(call('alpha run', 's2')); // the main thread takes the block
    const sub = fire(call('alpha run', 's2', 'sub-1'));
    expect(sub.kind).toBe('inject');
    expect(sub.text).toContain('RULE-A-BODY');
    expect(sub.text).toContain('block-a');
  });

  it('gives every later subagent the same inject, never a block', () => {
    fire(call('alpha run', 's3'));
    const kinds = ['sub-1', 'sub-2', 'sub-3'].map((a) => fire(call('alpha run', 's3', a)).kind);
    expect(kinds).toEqual(['inject', 'inject', 'inject']);
  });

  it('shows a subagent the rule once, not on each of its calls', () => {
    fire(call('alpha run', 's4'));
    expect(fire(call('alpha run', 's4', 'sub-1')).kind).toBe('inject');
    expect(fire(call('alpha run', 's4', 'sub-1')).kind).toBe('none');
  });

  it('also works when the agent id comes from CLAUDE_AGENT_ID', () => {
    fire(call('alpha run', 's5'));
    process.env.CLAUDE_AGENT_ID = 'env-sub';
    expect(fire(call('alpha run', 's5')).kind).toBe('inject');
  });
});

describe('the block still happens where it has not happened yet', () => {
  it('blocks a subagent that is the first caller in the session', () => {
    expect(fire(call('alpha run', 's6', 'sub-1')).kind).toBe('deny');
  });

  it('then injects the next subagent, and still blocks the main thread once', () => {
    fire(call('alpha run', 's7', 'sub-1'));
    expect(fire(call('alpha run', 's7', 'sub-2')).kind).toBe('inject');
    expect(fire(call('alpha run', 's7')).kind).toBe('deny');
    expect(fire(call('alpha run', 's7')).kind).toBe('none');
  });

  it('blocks a subagent for a rule the session has not had blocked, while another rule injects', () => {
    fire(call('alpha run', 's8')); // block-a is taken, block-b is not
    expect(fire(call('beta run', 's8', 'sub-1')).kind).toBe('deny');
    expect(fire(call('alpha run', 's8', 'sub-2')).kind).toBe('inject');
  });

  it('keeps sessions apart', () => {
    fire(call('alpha run', 's9'));
    expect(fire(call('alpha run', 's9-other', 'sub-1')).kind).toBe('deny');
  });
});

describe('a gate rule (subagent: block) is never downgraded', () => {
  it('blocks a fresh subagent even after the main thread had the block', () => {
    expect(fire(call('sigma run', 's14')).kind).toBe('deny');
    const sub = fire(call('sigma run', 's14', 'sub-1'));
    expect(sub.kind).toBe('deny');
    expect(sub.text).toContain('RULE-S-BODY');
  });

  it('blocks every later subagent once, then lets that subagent re-issue', () => {
    fire(call('sigma run', 's15'));
    const kinds = ['sub-1', 'sub-2'].map((a) => fire(call('sigma run', 's15', a)).kind);
    expect(kinds).toEqual(['deny', 'deny']);
    expect(fire(call('sigma run', 's15', 'sub-1')).kind).toBe('none');
  });

  it('still downgrades an ordinary block rule in the same session', () => {
    fire(call('sigma run', 's16'));
    fire(call('alpha run', 's16'));
    expect(fire(call('sigma run', 's16', 'sub-1')).kind).toBe('deny');
    expect(fire(call('alpha run', 's16', 'sub-2')).kind).toBe('inject');
  });

  it('logs the gate block as a deny with no downgrade', () => {
    fire(call('sigma run', 's17'));
    fire(call('sigma run', 's17', 'sub-1'));
    const rows = readFileSync(fireLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.kind)).toEqual(['deny', 'deny']);
    expect(rows[1].downgraded).toBeUndefined();
  });
});

describe('inject-mode rules are unchanged', () => {
  it('injects once per agent, in the main thread and in a subagent', () => {
    expect(fire(call('gamma go', 's10')).kind).toBe('inject');
    expect(fire(call('gamma go', 's10')).kind).toBe('none');
    expect(fire(call('gamma go', 's10', 'sub-1')).kind).toBe('inject');
  });
});

describe('the fire log records the downgrade', () => {
  it('writes kind inject and the downgraded rule ids for a subagent', () => {
    fire(call('alpha run', 's11'));
    fire(call('alpha run', 's11', 'sub-1'));
    const rows = readFileSync(fireLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.kind)).toEqual(['deny', 'inject']);
    expect(rows[1].downgraded).toEqual(['block-a']);
    expect(rows[1].agent).toBe('sub-1');
    expect(rows[0].downgraded).toBeUndefined();
  });

  it('writes a guard decision for the block and none for the downgrade', () => {
    fire(call('alpha run', 's12'));
    fire(call('alpha run', 's12', 'sub-1'));
    const rows = readFileSync(join(root, 'guard.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hook: 'rule-router', decision: 'deny', session_id: 's12' });
  });
});

describe('a failed rule read releases the session block too', () => {
  it('lets the next subagent still get the block', () => {
    rmSync(join(rules, 'block-a.md'));
    // The rule file is missing, so run() throws (main() turns that into "continue").
    expect(() => run(call('alpha run', 's13', 'sub-1'))).toThrow();
    writeFileSync(join(rules, 'block-a.md'), 'RULE-A-BODY');
    expect(fire(call('alpha run', 's13', 'sub-2')).kind).toBe('deny');
    expect(existsSync(state) ? readdirSync(state).length : 0).toBeGreaterThan(0);
  });
});
