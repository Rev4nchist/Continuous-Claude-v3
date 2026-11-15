/**
 * pre-pr-gate: a CLI-review skip that Dave decided (card prflow-cli-partial-run-rule, rule B; design note
 * .claudedocs/e2e-prflow-cli-skip-decision/01-design-note.md). Own file: pre-pr-gate.test.ts is not part of this change.
 *
 *   - a flag stamp with no decision passes (the flag alone must stay refused)         -> K2
 *   - the decision label is not compared (a "Keep the CLI review" tap passes)        -> K3
 *   - the head or the branch of the decision is not compared                         -> K4
 *   - an unreadable decision store lets the skip through (fail open)                 -> K5
 *   - the decision opens a skip of another reason (cap with no earn)                 -> K6
 *   - the decision is not used up at the allow (one tap opens two PRs)               -> K7
 *   - the allow path never reads the decision (the new rule does nothing)            -> K1
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, handle, type Deps } from '../pre-pr-gate.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ROOT = '/work/ccv3';
const REMOTES = 'fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (fetch)\nfork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (push)\n';
const BODY_TEXT = 'default body\n';
const BODY_PATH = resolve('/work/default-body.md');
const BODY_ARG = BODY_PATH.replace(/\\/g, '/');
const CREATE = `gh pr create --body-file ${BODY_ARG}`;
const SKIP_LABEL = 'Skip the CLI review for this head';
const KEY = 'Rev4nchist/Continuous-Claude-v3@feat/x';
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

const stampJson = (over: Record<string, unknown> = {}): string => JSON.stringify({ head: HEAD, branch: 'feat/x', at: new Date(NOW - 3_600_000).toISOString(), body_sha256: sha256(BODY_TEXT), results: [], ...over });
const flagStamp = (over: Record<string, unknown> = {}) => stampJson({ cr_skipped: true, cr_skip_reason: 'flag', cr_finished_runs: 0, ...over });

type Row = { label: string };
/** A store of decisions keyed "step\nkey\nhead", the shape of decisions.mjs. `unreadable` makes every read throw. */
function store(rows: Record<string, Row> = {}, unreadable = false) {
  const used: string[] = [];
  const idOf = (t: { step: string; key: string; head: string }) => `${t.step}\n${t.key}\n${t.head.toLowerCase()}`;
  return {
    used,
    decisionRead: (t: { step: string; key: string; head: string }): Row | null => {
      if (unreadable) throw new Error('store unreadable');
      return rows[idOf(t)] ?? null;
    },
    decisionUse: (t: { step: string; key: string; head: string }): { ok: boolean } => {
      const id = idOf(t);
      used.push(id);
      const had = id in rows;
      delete rows[id];
      return { ok: had };
    },
  };
}

function deps(stamp: string, s = store()): Deps {
  return {
    git: (cwd, args) => {
      const key = args.join(' ');
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
    decisionRead: s.decisionRead,
    decisionUse: s.decisionUse,
  } as Deps;
}

const payload = { tool_name: 'Bash', tool_input: { command: CREATE }, cwd: ROOT };
const run = (stamp: string, s = store()) => decide(payload, deps(stamp, s));
const reasonOf = (d: ReturnType<typeof run>) => (d.action === 'deny' ? d.reason : '');
const tap = (over: Partial<{ step: string; key: string; head: string }> = {}) => `${over.step ?? 'cli-skip'}\n${over.key ?? KEY}\n${over.head ?? HEAD}`;

describe('KS: a CLI skip that Dave decided', () => {
  it('K1: a flag stamp with an unused cli-skip decision for this branch and head, with the skip label, allows', () => {
    // Breaks when: the gate never reads the decision (today a flag skip is always denied).
    const s = store({ [tap()]: { label: SKIP_LABEL } });
    expect(run(flagStamp(), s).action).toBe('allow');
    // ship-ask marks the recommended option with a suffix; the same tap counts.
    const rec = store({ [tap()]: { label: `${SKIP_LABEL} (Recommended)` } });
    expect(run(flagStamp(), rec).action).toBe('allow');
  });

  it('K2: a flag stamp with no decision denies with today\'s text', () => {
    // Breaks when: the flag alone passes.
    const d = run(flagStamp());
    expect(d.action).toBe('deny');
    expect(reasonOf(d)).toMatch(/skipped the CodeRabbit CLI review \(reason: flag\)/);
    expect(reasonOf(d)).toMatch(/Run pre-pr\.mjs again without --skip-cr/);
  });

  it('K3: a decision with another label ("Keep the CLI review", any text but the skip label) denies', () => {
    // Breaks when: any recorded label opens the skip (a label that ends the question is still a decision).
    for (const label of ['Keep the CLI review', 'skip the cli review for this head', `${SKIP_LABEL} now`, '']) {
      const s = store({ [tap()]: { label } });
      expect(run(flagStamp(), s).action, label).toBe('deny');
    }
  });

  it('K4: a decision for another head, another branch, another repo or another step denies', () => {
    // Breaks when: the key or the head is not part of the lookup.
    const cases = [tap({ head: OTHER_HEAD }), tap({ key: 'Rev4nchist/Continuous-Claude-v3@feat/other' }), tap({ key: 'someone/else@feat/x' }), tap({ step: 'open-pr' }), tap({ step: 'ship' })];
    for (const id of cases) {
      const s = store({ [id]: { label: SKIP_LABEL } });
      expect(run(flagStamp(), s).action, id).toBe('deny');
    }
  });

  it('K5: an unreadable decision store denies (fail closed)', () => {
    // Breaks when: a read error counts as "no problem" or as a decision.
    const s = store({ [tap()]: { label: SKIP_LABEL } }, true);
    expect(run(flagStamp(), s).action).toBe('deny');
  });

  it('K6: the decision does not open a cap skip with no earn, nor any other reason', () => {
    // Breaks when: the decision check is not tied to reason === "flag".
    const s = store({ [tap()]: { label: SKIP_LABEL } });
    expect(run(stampJson({ cr_skipped: true, cr_skip_reason: 'cap', cr_finished_runs: 0, cr_partial_earned: 0 }), s).action).toBe('deny');
    expect(run(stampJson({ cr_skipped: true, cr_skip_reason: 'cli-error' }), s).action).toBe('deny');
    expect(run(stampJson({ cr_skipped: true, cr_skip_reason: 'rate-limited' }), s).action).toBe('deny');
  });

  it('K7: handle() uses the decision up at the allow: a second create with the same tap denies', () => {
    // Breaks when: the decision is never used (one tap would open any number of PRs), or is used when the create is denied.
    const rows: Record<string, Row> = { [tap()]: { label: SKIP_LABEL } };
    const s = store(rows);
    const raw = JSON.stringify(payload);
    const first = JSON.parse(handle(raw, deps(flagStamp(), s)) || '{}');
    expect(first.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(s.used).toEqual([tap()]);
    const second = JSON.parse(handle(raw, deps(flagStamp(), s)) || '{}');
    expect(second.hookSpecificOutput?.permissionDecision).toBe('deny');
    // A denied create (no decision) uses nothing.
    const none = store();
    handle(raw, deps(flagStamp(), none));
    expect(none.used).toEqual([]);
  });
});

describe('KM: one cli-skip tap serves one create (PR 576 follow-up, item 1)', () => {
  const REPO = 'Rev4nchist/Continuous-Claude-v3';
  // Second creates in other spellings: each is a PR open in the eyes of GitHub and must not ride on the tap of the first.
  const SECOND = [
    CREATE,
    `gh -R ${REPO} pr create --body-file ${BODY_ARG}`,
    `gh.exe pr create --body-file ${BODY_ARG}`,
    `gh   pr   create --body-file ${BODY_ARG}`,
    `gh api repos/${REPO}/pulls -X POST -F body=@${BODY_ARG}`,
    // A second create with no body flag: the body check sees only the first file, so only the count of creates can stop it.
    'gh pr create --fill',
    `gh -R ${REPO} pr create --fill`,
    `gh api repos/${REPO}/pulls -X POST -f title=x -f head=feat/x -f base=main`,
  ];
  const JOIN = [' && ', ' ; ', ' || ', '\n'];
  const verdict = (command: string, s: ReturnType<typeof store>): string =>
    JSON.parse(handle(JSON.stringify({ tool_name: 'Bash', session_id: 'ks-km', tool_input: { command }, cwd: ROOT }), deps(flagStamp(), s)) || '{}').hookSpecificOutput?.permissionDecision ?? 'allow';

  it('K9: two creates in one command, in any spelling and with any joiner, deny and leave the tap unused', () => {
    // Breaks when: one tap opens two PRs in one command (same branch and head), or a denied command still uses the tap up.
    for (const second of SECOND) {
      for (const join of JOIN) {
        const s = store({ [tap()]: { label: SKIP_LABEL } });
        expect(verdict(`${CREATE}${join}${second}`, s), JSON.stringify(`${join}${second}`)).toBe('deny');
        expect(s.used, JSON.stringify(`${join}${second}`)).toEqual([]);
      }
    }
  });

  it('K9b: control: one create still uses the tap up once', () => {
    const s = store({ [tap()]: { label: SKIP_LABEL } });
    expect(verdict(CREATE, s)).not.toBe('deny');
    expect(s.used).toEqual([tap()]);
  });

  it('K10: the use call carries the label that was read, so a changed row is not used up by the earlier read', () => {
    // Breaks when: decisionUse gets no label and deletes whatever row is there (item 2, the read and use race).
    const s = store({ [tap()]: { label: SKIP_LABEL } });
    const d = deps(flagStamp(), s);
    const seen: Array<string | undefined> = [];
    const inner = d.decisionUse as (t: unknown) => { ok: boolean };
    (d as { decisionUse: unknown }).decisionUse = (t: { label?: string }) => { seen.push(t.label); return inner(t); };
    handle(JSON.stringify({ tool_name: 'Bash', session_id: 'ks-k10', tool_input: { command: CREATE }, cwd: ROOT }), d);
    expect(seen).toEqual([SKIP_LABEL]);
  });
});

describe('KR: the tap is used up through the REAL store (CodeRabbit nitpick, PR 576)', () => {
  it('K8: with the real store, one tap allows one create, the second is denied, and another label never allows', async () => {
    // Breaks when: the real store changes its consumption behaviour (K7 uses a small fake that copies it).
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const real = await import('../shared/decisions-store.js');
    const file = join(mkdtempSync(join(tmpdir(), 'cli-skip-real-')), 'decisions.json');
    const saved = process.env.CCV3_DECISIONS_FILE;
    process.env.CCV3_DECISIONS_FILE = file;
    try {
      const spec = { header: 'CLI skip', question: 'Q?', options: [{ label: SKIP_LABEL }, { label: 'Keep the CLI review' }] };
      const record = (label: string) => {
        expect(real.offerWrite({ step: 'cli-skip', key: KEY, head: HEAD, spec }).ok).toBe(true);
        expect(real.decisionRecord({ step: 'cli-skip', key: KEY, head: HEAD, label })).toEqual({ ok: true });
      };
      const realDeps = (): Deps => ({ ...deps(flagStamp()), decisionRead: real.decisionRead, decisionUse: real.decisionUse } as Deps);
      const raw = JSON.stringify({ tool_name: 'Bash', session_id: 'ks-k8-session', tool_input: { command: CREATE }, cwd: ROOT });
      const verdictOf = (): string => JSON.parse(handle(raw, realDeps()) || '{}').hookSpecificOutput?.permissionDecision ?? 'allow';
      record('Keep the CLI review');
      expect(verdictOf()).toBe('deny');
      record(SKIP_LABEL);
      expect(verdictOf()).toBe('allow');
      expect(verdictOf()).toBe('deny');
    } finally {
      if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
      rmSync(file, { force: true });
    }
  });

  it('K11: with the real store, a use call with a label that differs from the stored row keeps the row; the same label uses it up', async () => {
    // Breaks when: the store door ignores the label argument (item 2: a tap with another label, recorded between the read and the use, would be used up).
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const real = await import('../shared/decisions-store.js');
    const file = join(mkdtempSync(join(tmpdir(), 'cli-skip-label-')), 'decisions.json');
    const saved = process.env.CCV3_DECISIONS_FILE;
    process.env.CCV3_DECISIONS_FILE = file;
    try {
      const spec = { header: 'CLI skip', question: 'Q?', options: [{ label: SKIP_LABEL }, { label: 'Keep the CLI review' }] };
      const record = (label: string) => {
        expect(real.offerWrite({ step: 'cli-skip', key: KEY, head: HEAD, spec }).ok).toBe(true);
        expect(real.decisionRecord({ step: 'cli-skip', key: KEY, head: HEAD, label })).toEqual({ ok: true });
      };
      const t = { step: 'cli-skip' as const, key: KEY, head: HEAD };
      record('Keep the CLI review');
      expect(real.decisionUse({ ...t, label: SKIP_LABEL })).toEqual({ ok: false, reason: 'label-changed' });
      expect(real.decisionRead(t)?.label).toBe('Keep the CLI review');
      record(SKIP_LABEL);
      expect(real.decisionUse({ ...t, label: SKIP_LABEL })).toEqual({ ok: true });
      expect(real.decisionUse(t)).toEqual({ ok: false, reason: 'no-decision' });
    } finally {
      if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
      rmSync(file, { force: true });
    }
  });
});
