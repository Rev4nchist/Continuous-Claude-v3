/**
 * rule-router: after a compact, an inject rule that was shown earlier in the session gives one pointer line.
 *
 * Card coord-rule-inject-once (seat ruling 2026-11-15). Log read: a second fire inside a session is already silent;
 * the repeats are re-sends after a compact or clear re-arm. A deny-first rule and a gate rule keep the full text
 * (the block reason is their only carrier). An inject rule of 2,000 bytes or more gets one line with the full path.
 *
 * Ways it can fail (one test each):
 *  1. The pointer line is missing the rule name, the absolute path or the words "Read this file before you act in its area".
 *  2. The pointer is more than one line, or carries the rule body or the false-fire footer.
 *  3. The pointer is not once per re-arm and rule (second fire silent; the next re-arm points again).
 *  4. A deny-first rule after a re-arm loses its full text (lane-board is one).
 *  5. A gate rule after a re-arm loses its full text.
 *  6. The size floor is wrong: 1,999 bytes must keep the full text, 2,000 bytes must point.
 *  7. A fresh subagent gets a pointer on its first fire.
 *  8. A new session gets a pointer on its first fire.
 *  9. A ledger that cannot be read (a folder in place of the file) gives a pointer or silence, not the full text.
 * 10. A ledger that cannot be parsed, or has a wrong version or rule id, gives a pointer.
 * 11. A ledger that cannot be written gives a pointer after the re-arm.
 * 12. An unknown session id (no session_id in the payload) gives a pointer.
 * 13. A /clear re-arm gives a pointer (the model then holds no summary at all).
 * 14. The first fire of a session gives a pointer (it must be the full text).
 * 15. A pointer and a full rule in one call do not both come out.
 * 16. The fire log does not name the pointed rules and the emitted bytes.
 * 17. A compact that comes before any fire turns the next fire into a pointer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'fs';
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

const pad = (marker: string, bytes: number): string => marker + ' ' + 'x'.repeat(Math.max(0, bytes - marker.length - 1));

const MANIFEST = {
  rules: [
    { id: 'big-i', files: ['big-i.md'], mode: 'inject', command: ['^iota\\b'] },
    { id: 'big-j', files: ['big-j.md'], mode: 'inject', command: ['^jota\\b'] },
    { id: 'small-k', files: ['small-k.md'], mode: 'inject', command: ['^kappa\\b'] },
    { id: 'edge-lo', files: ['edge-lo.md'], mode: 'inject', command: ['^lowedge\\b'] },
    { id: 'edge-hi', files: ['edge-hi.md'], mode: 'inject', command: ['^highedge\\b'] },
    { id: 'block-a', files: ['block-a.md'], mode: 'deny-first', command: ['^alpha\\b'] },
    { id: 'gate-s', files: ['gate-s.md'], mode: 'deny-first', subagent: 'block', command: ['^sigma\\b'] },
  ],
};

const call = (command: string, session: string | null, agent?: string): string =>
  JSON.stringify({ ...(session ? { session_id: session } : {}), tool_name: 'Bash', tool_input: { command }, ...(agent ? { agent_id: agent } : {}) });

const rearmPayload = (session: string | null, source = 'compact'): string =>
  JSON.stringify({ ...(session ? { session_id: session } : {}), hook_event_name: 'SessionStart', source });

function fire(payload: string): { kind: 'deny' | 'inject' | 'none'; text: string } {
  out = [];
  run(payload);
  const j = JSON.parse(out[out.length - 1] || '{}');
  const h = j.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return { kind: 'deny', text: h.permissionDecisionReason };
  if (h.additionalContext) return { kind: 'inject', text: h.additionalContext };
  return { kind: 'none', text: '' };
}

const rulePath = (f: string): string => join(rules, f).replace(/\\/g, '/');
const ledgerDirs = (): string[] => (existsSync(state) ? readdirSync(state).filter((n) => n.startsWith('rule-router-shown-')) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rule-router-pointer-'));
  rules = join(root, 'rules');
  state = join(root, 'state');
  fireLog = join(root, 'fires.jsonl');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'manifest.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(rules, 'big-i.md'), pad('BODY-I', 5000));
  writeFileSync(join(rules, 'big-j.md'), pad('BODY-J', 3000));
  writeFileSync(join(rules, 'small-k.md'), pad('BODY-K', 400));
  writeFileSync(join(rules, 'edge-lo.md'), pad('BODY-LO', 1999));
  writeFileSync(join(rules, 'edge-hi.md'), pad('BODY-HI', 2000));
  writeFileSync(join(rules, 'block-a.md'), pad('BODY-A', 9000));
  writeFileSync(join(rules, 'gate-s.md'), pad('BODY-S', 4000));
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

describe('an inject rule shown before a compact gives one pointer line after it', () => {
  it('1+2. the line names the rule, the absolute path and the instruction, with no body and no footer', () => {
    expect(fire(call('iota one', 's1')).text).toContain('BODY-I');
    fire(rearmPayload('s1'));
    const r = fire(call('iota two', 's1'));
    expect(r.kind).toBe('inject');
    expect(r.text).toContain('big-i');
    expect(r.text).toContain(rulePath('big-i.md'));
    expect(r.text).toContain('Read this file before you act in its area');
    expect(r.text).not.toContain('BODY-I');
    expect(r.text).not.toContain('NOT about this call');
    expect(r.text.split('\n').length).toBe(1);
    expect(r.text.length).toBeLessThan(400);
  });

  it('3. the pointer comes once per re-arm and rule', () => {
    fire(call('iota one', 's1'));
    fire(rearmPayload('s1'));
    expect(fire(call('iota two', 's1')).text).toContain('Read this file');
    expect(fire(call('iota three', 's1')).kind).toBe('none');
    fire(rearmPayload('s1'));
    expect(fire(call('iota four', 's1')).text).toContain('Read this file');
  });

  it('14. the first fire of a session is the full text', () => {
    const r = fire(call('iota one', 's1'));
    expect(r.text).toContain('BODY-I');
    expect(r.text).not.toContain('Read this file before you act in its area');
  });

  it('17. a compact before any fire gives the full text (nothing was shown to point at)', () => {
    fire(rearmPayload('s1'));
    expect(fire(call('iota one', 's1')).text).toContain('BODY-I');
  });
});

describe('what keeps the full text after a re-arm', () => {
  it('4. a deny-first rule blocks again with its full text', () => {
    expect(fire(call('alpha one', 's1')).kind).toBe('deny');
    fire(rearmPayload('s1'));
    const r = fire(call('alpha two', 's1'));
    expect(r.kind).toBe('deny');
    expect(r.text).toContain('BODY-A');
  });

  it('5. a gate rule (subagent: block) keeps its full text', () => {
    expect(fire(call('sigma one', 's1')).kind).toBe('deny');
    fire(rearmPayload('s1'));
    const r = fire(call('sigma two', 's1'));
    expect(r.kind).toBe('deny');
    expect(r.text).toContain('BODY-S');
  });

  it('4b. a ledger entry for a deny-first or gate rule never turns its block into a pointer', () => {
    const dir = join(state, 'rule-router-shown-s1');
    mkdirSync(dir, { recursive: true });
    for (const id of ['block-a', 'gate-s']) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ v: 1, id }));
    for (const [cmd, body] of [['alpha one', 'BODY-A'], ['sigma one', 'BODY-S']]) {
      const r = fire(call(cmd, 's1'));
      expect(r.kind).toBe('deny');
      expect(r.text).toContain(body);
    }
    fire(rearmPayload('s1'));
    for (const [cmd, body] of [['alpha two', 'BODY-A'], ['sigma two', 'BODY-S']]) {
      const r = fire(call(cmd, 's1'));
      expect(r.kind).toBe('deny');
      expect(r.text).toContain(body);
    }
  });

  it('6. size floor: 1,999 bytes keep the full text, 2,000 bytes point', () => {
    fire(call('lowedge a', 's1'));
    fire(call('highedge a', 's1'));
    fire(rearmPayload('s1'));
    const lo = fire(call('lowedge b', 's1'));
    expect(lo.text).toContain('BODY-LO');
    const hi = fire(call('highedge b', 's1'));
    expect(hi.text).toContain('Read this file before you act in its area');
    expect(hi.text).not.toContain('BODY-HI');
  });

  it('6b. a small inject rule keeps its full text after a re-arm', () => {
    fire(call('kappa a', 's1'));
    fire(rearmPayload('s1'));
    expect(fire(call('kappa b', 's1')).text).toContain('BODY-K');
  });

  it('7. a fresh subagent gets the full text on its first fire', () => {
    fire(call('iota one', 's1'));
    fire(rearmPayload('s1'));
    const r = fire(call('iota two', 's1', 'sub1'));
    expect(r.text).toContain('BODY-I');
  });

  it('8. a new session gets the full text', () => {
    fire(call('iota one', 's1'));
    fire(rearmPayload('s1'));
    expect(fire(call('iota two', 's2')).text).toContain('BODY-I');
  });

  it('13. a clear re-arm gives the full text', () => {
    fire(call('iota one', 's1'));
    fire(rearmPayload('s1', 'clear'));
    expect(fire(call('iota two', 's1')).text).toContain('BODY-I');
  });
});

describe('every doubt gives the full text, never silence and never a pointer', () => {
  const armed = (): string => {
    fire(call('iota one', 's1'));
    const dirs = ledgerDirs();
    expect(dirs.length).toBe(1);
    return join(state, dirs[0]);
  };

  it('9. a ledger entry that cannot be read (a folder in place of the file)', () => {
    const dir = armed();
    const file = readdirSync(dir)[0];
    rmSync(join(dir, file), { force: true });
    mkdirSync(join(dir, file));
    fire(rearmPayload('s1'));
    expect(fire(call('iota two', 's1')).text).toContain('BODY-I');
  });

  it('10a. a ledger entry that cannot be parsed', () => {
    const dir = armed();
    writeFileSync(join(dir, readdirSync(dir)[0]), 'not json {');
    fire(rearmPayload('s1'));
    expect(fire(call('iota two', 's1')).text).toContain('BODY-I');
  });

  it('10b. a ledger entry with a wrong version', () => {
    const dir = armed();
    writeFileSync(join(dir, readdirSync(dir)[0]), JSON.stringify({ v: 99, id: 'big-i' }));
    fire(rearmPayload('s1'));
    expect(fire(call('iota two', 's1')).text).toContain('BODY-I');
  });

  it('10c. a ledger entry that names another rule', () => {
    const dir = armed();
    writeFileSync(join(dir, readdirSync(dir)[0]), JSON.stringify({ v: 1, id: 'other' }));
    fire(rearmPayload('s1'));
    expect(fire(call('iota two', 's1')).text).toContain('BODY-I');
  });

  it('11. a ledger that cannot be written', () => {
    mkdirSync(state, { recursive: true });
    // A plain file where the ledger folder must go: mkdir fails, so no entry is written.
    writeFileSync(join(state, 'rule-router-shown-s1'), 'blocker');
    expect(fire(call('iota one', 's1')).text).toContain('BODY-I');
    fire(rearmPayload('s1'));
    expect(fire(call('iota two', 's1')).text).toContain('BODY-I');
  });

  it('12. an unknown session id (no session_id in the payload)', () => {
    expect(fire(call('iota one', null)).text).toContain('BODY-I');
    fire(rearmPayload(null));
    expect(fire(call('iota two', null)).text).toContain('BODY-I');
  });
});

describe('mixed calls and the log', () => {
  it('15. a pointer and a full rule in one call both come out, once', () => {
    fire(call('iota one', 's1'));
    fire(call('kappa one', 's1'));
    fire(rearmPayload('s1'));
    const r = fire(call('iota two; kappa two', 's1'));
    expect(r.text).toContain(rulePath('big-i.md'));
    expect(r.text).toContain('BODY-K');
    expect(r.text).not.toContain('BODY-I');
  });

  it('15b. two pointers are two lines', () => {
    fire(call('iota one; jota one', 's1'));
    fire(rearmPayload('s1'));
    const r = fire(call('iota two; jota two', 's1'));
    expect(r.text.split('\n').length).toBe(2);
  });

  it('16. the fire log names the pointed rules and the emitted bytes', () => {
    fire(call('iota one', 's1'));
    fire(rearmPayload('s1'));
    fire(call('iota two', 's1'));
    const rows = readFileSync(fireLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind !== 'rearm');
    expect(rows[0].bytes).toBeGreaterThan(5000);
    expect(rows[1].pointed).toEqual(['big-i']);
    expect(rows[1].bytes).toBeLessThan(400);
  });
});
