/**
 * pre-pr-gate: the cap skip earned by a partial CLI run (card prflow-cli-partial-run-rule, rule A).
 * Own file: pre-pr-gate.test.ts is held by another lane. The fixtures below copy only its input shapes (a stamp, a git stub, a body file).
 *
 *   - capEarned does not read cr_partial_earned                          -> G1
 *   - the type check is loose (truthy, Number(), no Number.isInteger)    -> G2
 *   - the new field lets a skip of another reason through                -> G3
 *   - the deny text keeps naming only cr_finished_runs, or offers an edit of the lines as the way out -> G4
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, type Deps } from '../pre-pr-gate.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const HEAD = 'a'.repeat(40);
const ROOT = '/work/ccv3';
const REMOTES = 'fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (fetch)\nfork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (push)\n';
const BODY_TEXT = 'default body\n';
const BODY_PATH = resolve('/work/default-body.md');
const BODY_ARG = BODY_PATH.replace(/\\/g, '/');
const CREATE = `gh pr create --body-file ${BODY_ARG}`;
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

const stampJson = (over: Record<string, unknown> = {}): string => JSON.stringify({ head: HEAD, branch: 'feat/x', at: new Date(NOW - 3_600_000).toISOString(), body_sha256: sha256(BODY_TEXT), results: [], ...over });

function deps(stamp: string): Deps {
  return {
    git: (cwd, args) => {
      const key = args.join(' ');
      // fork/main serves the same config text as the checkout, so these tests keep judging the checkout config (coord-cap-override PR A: the hook reads the stricter of the two).
      if (key === 'rev-parse --verify --quiet refs/remotes/fork/main') return { status: 0, stdout: '' };
      if (key === 'show refs/remotes/fork/main:review-router.config.json') return { status: 0, stdout: stamp }; // readFile serves the stamp for every path, the config path too
      if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${cwd}\n` };
      if (key === 'remote -v') return { status: 0, stdout: REMOTES };
      if (key === 'worktree list --porcelain') return { status: 0, stdout: '' };
      if (key === 'rev-parse HEAD') return { status: 0, stdout: `${HEAD}\n` };
      if (key === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (args[0] === 'rev-parse' && args[1]?.endsWith('^{commit}')) return { status: 0, stdout: `${HEAD}\n` };
      return { status: 1, stdout: '' };
    },
    readFile: (p) => (p === BODY_PATH ? BODY_TEXT : stamp),
    now: () => NOW,
    env: {},
  };
}

const run = (stamp: string) => decide({ tool_name: 'Bash', tool_input: { command: CREATE }, cwd: ROOT }, deps(stamp));
const cap = (over: Record<string, unknown>) => stampJson({ cr_skipped: true, cr_skip_reason: 'cap', ...over });
const reasonOf = (d: ReturnType<typeof run>) => (d.action === 'deny' ? d.reason : '');

describe('KP: the cap skip earned by a partial CLI run', () => {
  it('G1: cap with cr_partial_earned 1 and cr_finished_runs 0 allows; so does a larger whole number', () => {
    // Breaks when: capEarned does not read cr_partial_earned (today only cr_finished_runs earns).
    expect(run(cap({ cr_finished_runs: 0, cr_partial_earned: 1, cr_unreviewed_files: 3 })).action).toBe('allow');
    expect(run(cap({ cr_partial_earned: 2 })).action).toBe('allow');
    // The control: the old path still works.
    expect(run(cap({ cr_finished_runs: 1 })).action).toBe('allow');
  });

  it('G2: cr_partial_earned of 0, "1", 1.5, -1, null, true or missing denies', () => {
    // Breaks when: the type check is loose (a truthy test, Number(), or >= 1 without Number.isInteger).
    for (const n of [0, '1', 1.5, -1, null, true, undefined]) {
      const d = run(cap({ cr_finished_runs: 0, ...(n === undefined ? {} : { cr_partial_earned: n }) }));
      expect(d.action, String(n)).toBe('deny');
    }
  });

  it('G3: a flag skip is denied with today\'s text, even with the new fields set', () => {
    // Breaks when: the new field lets a skip of another reason through (capEarned must check reason === "cap").
    for (const stamp of [stampJson({ cr_skipped: true, cr_skip_reason: 'flag' }), stampJson({ cr_skipped: true, cr_skip_reason: 'flag', cr_partial_earned: 1, cr_finished_runs: 1 })]) {
      const d = run(stamp);
      expect(d.action).toBe('deny');
      expect(reasonOf(d)).toMatch(/skipped the CodeRabbit CLI review \(reason: flag\)/);
      expect(reasonOf(d)).toMatch(/Run pre-pr\.mjs again without --skip-cr/);
    }
  });

  it('G4: a cap skip with neither field denies, names both fields and points to Dave\'s recorded decision', () => {
    // Breaks when: the deny text keeps naming only cr_finished_runs, or offers an edit of the lines as the way out.
    const reason = reasonOf(run(cap({ cr_finished_runs: 0, cr_partial_earned: 0 })));
    expect(reason).toMatch(/cr_finished_runs/);
    expect(reason).toMatch(/cr_partial_earned/);
    expect(reason).toMatch(/judged false and not changed does not earn/);
    expect(reason).toMatch(/Dave's recorded decision/);
    expect(reason).toMatch(/not an edit of the lines/);
    expect(reasonOf(run(cap({})))).toMatch(/cr_partial_earned/);
  });
});
