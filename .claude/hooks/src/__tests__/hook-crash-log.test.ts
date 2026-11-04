/**
 * A guard that crashes must leave one 'error' line in guard-decisions.jsonl and keep its outcome.
 *
 * Before this test, five guards caught a crash in a bare `catch` and printed `{}` or "continue".
 * A crashing guard looked the same as a guard that allows. This test runs the BUILT hook (dist),
 * as the harness does, so it fails when a src edit is not built or a catch does not call the logger.
 *
 * Ways it can fail (one case each, per hook):
 *  1. The crash catch prints its allow output but writes no 'error' line.
 *  2. The unreadable-input catch writes no 'error' line.
 *  3. The logger changes the outcome: the hook must still allow (fail-open guards stay fail-open).
 *
 * The payload `null` is valid JSON, so the parse succeeds. The first property read then throws a
 * TypeError inside main, which is the crash path.
 *
 * Run `npm run build` in .claude/hooks first: this test reads dist/*.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const HOOKS = [
  'destructive-command-guard',
  'package-install-guard',
  'no-haiku-enforcer',
  'rule-router',
  'scan-scope-guard',
  'dc-config-guard',
] as const;

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hook-crash-log-'));
  log = join(dir, 'guard-decisions.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(hook: string, stdin: string): { stdout: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, CCV3_GUARD_DECISIONS_LOG: log, HOME: dir, USERPROFILE: dir };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  const res = spawnSync('node', [resolve(__dirname, `../../dist/${hook}.mjs`)], { input: stdin, encoding: 'utf8', timeout: 20000, env });
  return { stdout: (res.stdout ?? '').trim(), status: res.status };
}

const rows = (): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/** The hook outputs "allow": empty object or a continue message, never a deny or ask. */
function allows(stdout: string): boolean {
  const out = JSON.parse(stdout || '{}');
  const decision = out.hookSpecificOutput?.permissionDecision;
  return decision === undefined || decision === 'allow';
}

describe.each(HOOKS)('%s', (hook) => {
  it('logs one error line when main crashes, and still allows', () => {
    const r = run(hook, 'null');
    expect(r.status).toBe(0);
    expect(allows(r.stdout), r.stdout).toBe(true);
    const errors = rows().filter((x) => x.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ hook, kind: 'error' });
    expect(String(errors[0].message)).toMatch(/null|undefined|Cannot read/i);
    expect(typeof errors[0].stack).toBe('string');
  });

  it('logs one error line when the input is not JSON, and still allows', () => {
    const r = run(hook, '{ this is not json');
    expect(r.status).toBe(0);
    expect(allows(r.stdout), r.stdout).toBe(true);
    const errors = rows().filter((x) => x.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ hook, kind: 'error' });
  });
});
