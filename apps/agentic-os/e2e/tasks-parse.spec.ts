import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { nextFireMs, parseTasksFile } from '../src/lib/tasks-parse';

/**
 * Pure checks of the scheduled tasks reader (card agentic-os-readers, reader 5).
 * Source: scripts/scheduled/tasks.json, {tasks:[{name, trigger, maxAgeHours, ...}]}. Trigger shapes in the real file:
 * `daily HH:MM`, `weekly <Day> HH:MM`, `every Nm`. The file has no last-run time. The backup card adds a task and a
 * `catchUp` field (seat ruling 06:51), so the parser accepts extra fields and fails only on a broken shape.
 * Times are America/Chicago. Pure Node. Each test names the source change that breaks it.
 */

const at = (iso: string): number => Date.parse(iso);

test.describe('nextFireMs', () => {
  test('T1 daily HH:MM is the next wall time in Chicago, today or tomorrow', () => {
    // 07:50 CST is 13:50Z in November. Breaks when the zone is UTC or the day rolls the wrong way.
    expect(nextFireMs('daily 07:50', at('2026-11-25T12:49:00Z'))).toBe(at('2026-11-25T13:50:00Z'));
    expect(nextFireMs('daily 07:50', at('2026-11-25T14:00:00Z'))).toBe(at('2026-11-26T13:50:00Z'));
    expect(nextFireMs('daily 07:50', at('2026-11-25T13:50:00Z'))).toBe(at('2026-11-26T13:50:00Z')); // at the instant: next one
  });

  test('T2 weekly <Day> HH:MM is the next such weekday, across a day change', () => {
    // 09:07 CST Monday is 15:07Z. Wed 25 Nov 2026 to Mon 30 Nov.
    expect(nextFireMs('weekly Monday 09:07', at('2026-11-25T12:49:00Z'))).toBe(at('2026-11-30T15:07:00Z'));
    expect(nextFireMs('weekly Monday 09:07', at('2026-11-30T15:08:00Z'))).toBe(at('2026-12-07T15:07:00Z'));
    expect(nextFireMs('weekly Monday 09:07', at('2026-11-30T14:00:00Z'))).toBe(at('2026-11-30T15:07:00Z'));
  });

  test('T3 "every Nm" has no anchor in the file, so the next fire is not measured (null)', () => {
    expect(nextFireMs('every 5m', at('2026-11-25T12:49:00Z'))).toBeNull();
    expect(nextFireMs('every 30m', at('2026-11-25T12:49:00Z'))).toBeNull();
  });

  test('T4 an unknown or malformed trigger is null', () => {
    for (const bad of ['', 'hourly', 'daily 25:00', 'daily 7:5', 'weekly Funday 09:00', 'every 0m', 'every m', 'daily', 42, null]) {
      expect(nextFireMs(bad as never, at('2026-11-25T12:49:00Z')), String(bad)).toBeNull();
    }
  });

  test('T8 a daylight-saving change day keeps the Chicago wall time', () => {
    // Sun 14 Mar 2027: clocks go forward at 02:00. 07:50 is CST (13:50Z) on Sat and CDT (12:50Z) on Sun.
    expect(nextFireMs('daily 07:50', at('2027-03-13T20:00:00Z'))).toBe(at('2027-03-14T12:50:00Z'));
    // Autumn: Sun 1 Nov 2026 clocks go back at 02:00; 07:50 CDT (12:50Z) on Sat, CST (13:50Z) on Sun.
    expect(nextFireMs('daily 07:50', at('2026-10-31T20:00:00Z'))).toBe(at('2026-11-01T13:50:00Z'));
  });
});

test.describe('parseTasksFile', () => {
  const good = { tasks: [{ name: 'CCv3-Health-Check', trigger: 'daily 07:50', maxAgeHours: 48 }] };

  test('T6 lastRun is always the text "not measured", never a time', () => {
    const out = parseTasksFile(JSON.stringify(good), at('2026-11-25T12:49:00Z'));
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.tasks[0]).toEqual({ name: 'CCv3-Health-Check', trigger: 'daily 07:50', nextFireMs: at('2026-11-25T13:50:00Z'), maxAgeHours: 48, lastRun: 'not measured' });
  });

  test('T5 invalid JSON, a missing tasks array and a task with no name are source errors', () => {
    // Breaks when the parser returns an empty list for a corrupt file.
    expect(parseTasksFile('{oops', 0)).toEqual({ ok: false, reason: 'unreadable' });
    expect(parseTasksFile(JSON.stringify({}), 0)).toEqual({ ok: false, reason: 'bad-shape' });
    expect(parseTasksFile(JSON.stringify({ tasks: {} }), 0)).toEqual({ ok: false, reason: 'bad-shape' });
    expect(parseTasksFile(JSON.stringify({ tasks: [{ trigger: 'daily 07:50' }] }), 0)).toEqual({ ok: false, reason: 'bad-shape' });
    expect(parseTasksFile(JSON.stringify({ tasks: [{ name: 'x' }] }), 0)).toEqual({ ok: false, reason: 'bad-shape' });
    expect(parseTasksFile(null, 0)).toEqual({ ok: false, reason: 'missing' });
  });

  test('T5b an unknown extra field (catchUp) passes; an unknown trigger shape keeps the task with next fire null', () => {
    const doc = { tasks: [{ name: 'CCv3-State-Backup', trigger: 'daily 03:10', catchUp: 'daily 07:40', maxAgeHours: 30, someFutureField: true }, { name: 'Odd', trigger: 'monthly 1st' }] };
    const out = parseTasksFile(JSON.stringify(doc), at('2026-11-25T12:49:00Z'));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.tasks.map((t) => t.name)).toEqual(['CCv3-State-Backup', 'Odd']);
      expect(out.tasks[1].nextFireMs).toBeNull();
      expect(out.tasks[1].maxAgeHours).toBeNull();
    }
  });

  test('T7 every task of the real file parses and every trigger has a known shape (no pin on the count)', () => {
    // Breaks when a new task adds a trigger shape that the reader does not know: the guard against drift in tasks.json.
    const here = dirname(fileURLToPath(import.meta.url)); // apps/agentic-os/e2e: three levels up is the repo root
    const text = readFileSync(join(here, '..', '..', '..', 'scripts', 'scheduled', 'tasks.json'), 'utf8');
    const out = parseTasksFile(text, at('2026-11-25T12:49:00Z'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.tasks.length).toBeGreaterThanOrEqual(9);
    for (const task of out.tasks) expect(task.trigger, task.name).toMatch(/^(daily \d\d:\d\d|weekly [A-Z][a-z]+ \d\d:\d\d|every \d+m)$/);
    for (const task of out.tasks.filter((t) => !t.trigger.startsWith('every '))) expect(task.nextFireMs, task.name).not.toBeNull();
  });
});
