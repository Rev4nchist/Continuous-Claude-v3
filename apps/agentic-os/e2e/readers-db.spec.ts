import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { clearStateDir, step, writeState } from './state-fixture';

/**
 * Database-backed checks of the readers (card agentic-os-readers): stalls (S), clock (C), open Question (Q),
 * decisions (D), tasks (T) and the source rows (R), read through GET /api/mission-control.
 *
 * Runs ONLY through the scratch harness (.claudedocs/e2e-agentic-os-readers/harness/run-scratch.mjs): it makes a
 * scratch database, seeds the lanes named by the E2E_RD_* variables, sets AGENTIC_OS_DECISIONS_FILE (E2E_RD_DECISIONS_FILE)
 * and AGENTIC_OS_TASKS_FILE, and drops the database after. A missing variable fails the spec: it must never
 * read the live board. Each test names the source change that breaks it.
 */

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run this spec through the scratch harness (run-scratch.mjs)`);
  return value;
};

type Stall = { kind: string; subject: string; ageMin: number | null; certainty: string; sentence: string };
type ClockEntry = { kind: string; label: string; atMs: number; inMin: number };
type Source = { id: string; status: string; detail: string; readAtMs?: number; ageSec?: number };
type Snapshot = {
  stalls: Stall[];
  clock: ClockEntry[];
  openQuestions: { session: string; certainty: string; startedAtMs: number | null }[];
  decisionsOpen: number | null;
  scheduledTasks: { name: string; trigger: string; lastRun: string }[];
  sources: Source[];
};

async function snapshot(request: APIRequestContext): Promise<{ body: Snapshot; text: string }> {
  const response = await request.get('/api/mission-control');
  expect(response.status(), 'GET /api/mission-control').toBe(200);
  const text = await response.text();
  return { body: JSON.parse(text) as Snapshot, text };
}

const NOTE_CANARY = 'RD_NOTE_CANARY_7f3a';

/** Save evidence to the file the harness names (a path in the evidence folder), when it names one. */
function save(envName: string, value: unknown): void {
  const target = process.env[envName];
  if (!target) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}
`);
}

test.describe('stalls from the lane table (S)', () => {
  test('S12 each seeded lane gives its stall; re-program, a parked note, a review lane and a done lane give none', async ({ request }) => {
    // Breaks when a state or note filter of stall-watch.mjs:79-97 is dropped, or the lease query reads the wrong column.
    const { body } = await snapshot(request);
    const got = body.stalls.map((s) => `${s.kind}:${s.subject}`).sort();
    expect(got).toEqual(
      [
        `lease-ran-out:${need('E2E_RD_LEASE_LANE')}`,
        `waits-on-seat:${need('E2E_RD_WAITS_LANE')}`,
        `start-no-end:${need('E2E_RD_START_LANE')}`,
      ].sort(),
    );
    const byKind = Object.fromEntries(body.stalls.map((s) => [s.kind, s]));
    expect(byKind['lease-ran-out'].certainty).toBe('sure');
    expect(byKind['waits-on-seat'].certainty).toBe('guessed');
    expect(byKind['start-no-end'].certainty).toBe('guessed');
  });

  test('S10b the note canary and the full owner session id never reach the snapshot', async ({ request }) => {
    // Breaks when the new server-only query lets note text or the owner id into any field of the response.
    const { text } = await snapshot(request);
    expect(text).not.toContain(NOTE_CANARY);
    expect(text).not.toContain(need('E2E_RD_OWNER_SID'));
  });
});

test.describe('clock from the lane table (C)', () => {
  test('C4b park end, lease end and future reminders come from the right rows, soonest first', async ({ request }) => {
    // Breaks when a lease or reminder predicate drifts from the CLI (the drift spec checks the SQL text, this checks rows).
    const { body } = await snapshot(request);
    const label = (kind: string) => body.clock.filter((e) => e.kind === kind).map((e) => e.label);
    // The stall lanes hold 60 minute leases, so they are lease ends too: assert membership, not equality.
    expect(label('park-end')).toEqual([need('E2E_RD_PARK_LANE')]);
    expect(label('lease-end')).toContain(need('E2E_RD_LEASEEND_LANE'));
    expect(label('lease-end')).not.toContain(need('E2E_RD_PARK_LANE'));
    expect(label('reminder')).toContain(need('E2E_RD_REMIND_FUTURE'));
    for (const none of [need('E2E_RD_REMIND_ACKED'), need('E2E_RD_REMIND_PAST'), need('E2E_RD_UNOWNED_LANE'), need('E2E_RD_LEASE_LANE')]) {
      expect(body.clock.map((e) => e.label), none).not.toContain(none);
    }
    const times = body.clock.map((e) => e.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test('C9b each kind keeps at most 20 entries when 22 reminders are seeded', async ({ request }) => {
    const { body } = await snapshot(request);
    expect(body.clock.filter((e) => e.kind === 'reminder')).toHaveLength(20);
  });
});

test.describe('open Question flag from the state files (Q)', () => {
  test.beforeEach(() => clearStateDir());
  test.afterEach(() => clearStateDir());

  test('Q9 a state file with an AskUserQuestion step gives one flag; with no step it gives none', async ({ request }) => {
    const sid = '5e5e5e5e-0000-4000-8000-0123456789ab';
    writeState(sid, { step: step('AskUserQuestion', 'QUESTION_LABEL_CANARY_91c2', 90) });
    const open = await snapshot(request);
    expect(open.body.openQuestions).toHaveLength(1);
    expect(open.body.openQuestions[0].certainty).toBe('sure');
    expect(open.text).not.toContain('QUESTION_LABEL_CANARY_91c2');
    expect(open.text).not.toContain(sid);
    writeState(sid, { step: null });
    expect((await snapshot(request)).body.openQuestions).toEqual([]);
  });
});

test.describe('decisions.json and tasks.json readers (D, T)', () => {
  const decisionsFile = (): string => need('E2E_RD_DECISIONS_FILE');
  test.afterEach(() => rmSync(decisionsFile(), { force: true }));

  test('D11 a corrupt file is an error row and a null count; a valid empty store is zero; no file is degraded', async ({ request }) => {
    // The card's done line: a corrupt decisions.json gives a source error, not the zero state.
    mkdirSync(dirname(decisionsFile()), { recursive: true });
    const row = (s: Snapshot) => s.sources.find((x) => x.id === 'decisions');

    writeFileSync(decisionsFile(), '{"version":1,"offers":{');
    const corruptRead = await snapshot(request);
    const corrupt = corruptRead.body;
    expect(corrupt.decisionsOpen).toBeNull();
    expect(row(corrupt)?.status).toBe('error');
    save('E2E_RD_CORRUPT_FILE', { decisionsOpen: corrupt.decisionsOpen, decisionsSource: row(corrupt), note: 'decisions.json was corrupt: a source error and a null count, not the zero state' });

    writeFileSync(decisionsFile(), JSON.stringify({ version: 1, offers: {}, decisions: {}, misses: {} }));
    const empty = (await snapshot(request)).body;
    expect(empty.decisionsOpen).toBe(0);
    expect(row(empty)?.status).toBe('ok');

    rmSync(decisionsFile(), { force: true });
    const missing = (await snapshot(request)).body;
    expect(missing.decisionsOpen).toBeNull();
    expect(row(missing)?.status).toBe('degraded');
  });

  test('T9 the tasks reader lists the fixture file, accepts catchUp, and says last run is not measured', async ({ request }) => {
    const { body } = await snapshot(request);
    const names = body.scheduledTasks.map((t) => t.name);
    expect(names).toContain('CCv3-State-Backup');
    for (const task of body.scheduledTasks) expect(task.lastRun).toBe('not measured');
  });
});

test.describe('source rows (R)', () => {
  test.beforeEach(() => clearStateDir());
  test.afterEach(() => { clearStateDir(); rmSync(need('E2E_RD_DECISIONS_FILE'), { force: true }); });

  test('R9 the saved snapshot shows stalls, the open Question flag, clock entries and one source row per reader', async ({ request }) => {
    // The card's done line: this is the artifact (snapshot.json in the evidence folder). Fixtures only: no live state.
    writeState('5e5e5e5e-0000-4000-8000-0123456789ab', { step: step('AskUserQuestion', 'x', 90) });
    mkdirSync(dirname(need('E2E_RD_DECISIONS_FILE')), { recursive: true });
    writeFileSync(need('E2E_RD_DECISIONS_FILE'), JSON.stringify({ version: 1, offers: { a: { step: 'land' } }, decisions: {}, misses: {} }));
    const { body } = await snapshot(request);
    expect(body.stalls.length).toBeGreaterThanOrEqual(3);
    expect(body.openQuestions).toHaveLength(1);
    expect(body.clock.length).toBeGreaterThan(0);
    expect(body.decisionsOpen).toBe(1);
    const ids = body.sources.map((s) => s.id).filter((id) => ['stalls', 'open-question', 'decisions', 'clock', 'tasks'].includes(id));
    expect(ids.sort()).toEqual(['clock', 'decisions', 'open-question', 'stalls', 'tasks']);
    save('E2E_RD_SNAPSHOT_FILE', { stalls: body.stalls, openQuestions: body.openQuestions, clock: body.clock, decisionsOpen: body.decisionsOpen, scheduledTasks: body.scheduledTasks, sources: body.sources });
  });

  test('R8 one row per reader with a read time and an age, and no row holds a path', async ({ request }) => {
    const { body } = await snapshot(request);
    for (const id of ['stalls', 'open-question', 'decisions', 'clock', 'tasks']) {
      const rows = body.sources.filter((s) => s.id === id);
      expect(rows, id).toHaveLength(1);
      expect(typeof rows[0].readAtMs, id).toBe('number');
      expect(typeof rows[0].ageSec, id).toBe('number');
      expect(rows[0].detail, id).not.toMatch(/[A-Za-z]:\\|\/Users\//);
    }
  });
});
