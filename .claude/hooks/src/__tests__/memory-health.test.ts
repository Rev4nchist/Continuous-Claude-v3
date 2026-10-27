/**
 * Memory health line (phase 1). Ways it can fail, one test each:
 *
 *  1. A healthy store prints a wrong or missing field.
 *  2. An EMPTY store prints a clean line, or omits the restore command.
 *  3. A failed probe prints a clean line, throws, or leaks the URL.
 *  4. A probe that hangs blocks the hook past the hard timeout.
 *  5. A missing schema_meta table is read as an error instead of 'none'.
 *  6. A schema version mismatch is not flagged.
 *  7. A stale store (14+ days) is not flagged.
 *  8. Failed writes since the last session are not counted, or are counted twice.
 *  9. The SQL file and the TS constant name different versions (two-copy drift).
 * 10. Warning states do not ask for a systemMessage, or healthy ones do.
 * 11. The backup runs when the table is empty, or does not run when it is stale.
 * 12. Any error inside the whole flow escapes as a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_SCHEMA_VERSION,
  formatHealthLine,
  probeMemory,
  countFailedWritesSince,
  markSessionStart,
  runSessionHealth,
  type MemoryProbe,
  type HealthContext,
} from '../shared/memory-health.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const NOW = new Date('2026-10-27T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

function okProbe(over: Partial<Extract<MemoryProbe, { kind: 'ok' }>> = {}): MemoryProbe {
  return {
    kind: 'ok', database: 'continuous_claude', rows: 130, newest: hoursAgo(2),
    noEmbedding: 0, schema: EXPECTED_SCHEMA_VERSION, ...over,
  };
}
const ctx = (over: Partial<HealthContext> = {}): HealthContext => ({
  now: NOW, failedWrites: 0, failureLogPath: '/s/memory-write-failures.jsonl',
  restoreCommand: null, ...over,
});

describe('formatHealthLine', () => {
  it('healthy store: all fields, no warning', () => {
    const out = formatHealthLine(okProbe(), ctx());
    expect(out.line).toBe(
      `Memory: 130 lessons, newest 2h ago, 0 without embeddings, schema ${EXPECTED_SCHEMA_VERSION} (db continuous_claude)`,
    );
    expect(out.warn).toBe(false);
  });

  it('empty store: loud line with the exact restore command, and warns', () => {
    const cmd = 'uv run --directory "/opc" python scripts/core/memory_backup.py restore --file "/b/x.jsonl"';
    const out = formatHealthLine(okProbe({ rows: 0, newest: null }), ctx({ restoreCommand: cmd }));
    expect(out.line).toContain('Memory: EMPTY — archival_memory has 0 rows. Recall returns nothing.');
    expect(out.line).toContain(cmd);
    expect(out.warn).toBe(true);
  });

  it('empty store with no backup: no restore text', () => {
    const out = formatHealthLine(okProbe({ rows: 0, newest: null }), ctx());
    expect(out.line).toContain('EMPTY');
    expect(out.line).not.toContain('restore');
  });

  it('unknown probe: UNKNOWN line with the reason, never clean, warns', () => {
    const out = formatHealthLine({ kind: 'unknown', reason: 'ECONNREFUSED' }, ctx());
    expect(out.line).toBe('Memory: UNKNOWN (probe failed: ECONNREFUSED)');
    expect(out.warn).toBe(true);
  });

  it('schema mismatch: names found and expected, and warns', () => {
    const out = formatHealthLine(okProbe({ schema: 'none' }), ctx());
    expect(out.line).toContain(`schema MISMATCH (found none, expected ${EXPECTED_SCHEMA_VERSION})`);
    expect(out.warn).toBe(true);
  });

  it('stale store: reports whole days, does not warn by itself', () => {
    const out = formatHealthLine(okProbe({ newest: daysAgo(15) }), ctx());
    expect(out.line).toContain('no new lesson in 15 days');
    expect(out.warn).toBe(false);
  });

  it('13 days old is not stale', () => {
    expect(formatHealthLine(okProbe({ newest: daysAgo(13) }), ctx()).line).not.toContain('no new lesson');
  });

  it('failed writes: count and log path, and warns', () => {
    const out = formatHealthLine(okProbe(), ctx({ failedWrites: 3 }));
    expect(out.line).toContain('3 failed memory writes since last session (see /s/memory-write-failures.jsonl)');
    expect(out.warn).toBe(true);
  });

  it('failed writes also show when the probe is unknown', () => {
    const out = formatHealthLine({ kind: 'unknown', reason: 'timeout' }, ctx({ failedWrites: 1 }));
    expect(out.line).toContain('1 failed memory writes since last session');
  });
});

describe('probeMemory', () => {
  const fakeClient = (opts: { schema?: string | 'throw42P01'; failMain?: Error } = {}) => ({
    query: async (sql: string) => {
      if (sql.includes('schema_meta')) {
        if (opts.schema === 'throw42P01') throw Object.assign(new Error('relation "schema_meta" does not exist'), { code: '42P01' });
        return { rows: opts.schema ? [{ value: opts.schema }] : [] };
      }
      if (opts.failMain) throw opts.failMain;
      return { rows: [{ db: 'continuous_claude', rows: 7, newest: hoursAgo(1), no_emb: 2 }] };
    },
  });
  const runnerFor = (client: unknown) => async (fn: (c: never) => Promise<unknown>) => fn(client as never);

  it('maps the rows to a typed result', async () => {
    const out = await probeMemory(runnerFor(fakeClient({ schema: EXPECTED_SCHEMA_VERSION })) as never);
    expect(out).toEqual({
      kind: 'ok', database: 'continuous_claude', rows: 7, newest: hoursAgo(1), noEmbedding: 2,
      schema: EXPECTED_SCHEMA_VERSION,
    });
  });

  it("missing schema_meta table reads as 'none', not an error", async () => {
    const out = await probeMemory(runnerFor(fakeClient({ schema: 'throw42P01' })) as never);
    expect(out).toMatchObject({ kind: 'ok', schema: 'none' });
  });

  it('a query failure becomes UNKNOWN with a short reason', async () => {
    const err = Object.assign(new Error('boom'), { code: '42P01' });
    const out = await probeMemory(runnerFor(fakeClient({ failMain: err })) as never);
    expect(out.kind).toBe('unknown');
  });

  it('a runner that throws never throws out of probeMemory, and the reason hides the URL', async () => {
    const runner = async () => {
      throw new Error('connect failed postgresql://claude:hunter2@localhost:5432/continuous_claude');
    };
    const out = await probeMemory(runner as never);
    expect(out.kind).toBe('unknown');
    const text = JSON.stringify(out);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('postgresql://');
  });

  it('a runner that hangs ends at the hard timeout', async () => {
    const started = Date.now();
    const out = await probeMemory((() => new Promise(() => {})) as never, 60);
    expect(out).toEqual({ kind: 'unknown', reason: 'timeout after 60 ms' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a real unreachable database gives UNKNOWN with no URL in it', async () => {
    const saved = process.env.CONTINUOUS_CLAUDE_DB_URL;
    process.env.CONTINUOUS_CLAUDE_DB_URL = 'postgresql://claude:hunter2@127.0.0.1:1/continuous_claude';
    try {
      const out = await probeMemory();
      expect(out.kind).toBe('unknown');
      expect(JSON.stringify(out)).not.toMatch(/hunter2|postgresql:\/\//);
    } finally {
      if (saved === undefined) delete process.env.CONTINUOUS_CLAUDE_DB_URL;
      else process.env.CONTINUOUS_CLAUDE_DB_URL = saved;
    }
  });
});

describe('schema version', () => {
  it('docker/init-schema.sql carries the version the TS constant expects', () => {
    const sqlPath = resolve(HERE, '..', '..', '..', '..', 'docker', 'init-schema.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    const match = /INSERT INTO schema_meta \(key, value\) VALUES \('schema_version', '([^']+)'\)/.exec(sql);
    expect(match, 'schema_version insert missing from init-schema.sql').not.toBeNull();
    expect(match![1]).toBe(EXPECTED_SCHEMA_VERSION);
  });
});

describe('failed-write counting', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mem-health-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const line = (ts: string) => JSON.stringify({ ts, source: 'store_learning', error: 'x', session_id: 's' });

  it('counts only lines newer than the marker, skipping malformed lines', () => {
    const log = join(dir, 'f.jsonl');
    const marker = join(dir, 'm');
    writeFileSync(log, [line('2026-10-26T00:00:00Z'), 'not json', line('2026-10-27T08:00:00Z'), line('2026-10-27T09:00:00Z')].join('\n') + '\n');
    writeFileSync(marker, '2026-10-27T00:00:00Z');
    expect(countFailedWritesSince(log, marker)).toBe(2);
  });

  it('with no marker, counts every valid line', () => {
    const log = join(dir, 'f.jsonl');
    writeFileSync(log, line('2026-10-01T00:00:00Z') + '\n' + line('2026-10-02T00:00:00Z') + '\n');
    expect(countFailedWritesSince(log, join(dir, 'missing'))).toBe(2);
  });

  it('with no log file, counts zero', () => {
    expect(countFailedWritesSince(join(dir, 'nope.jsonl'), join(dir, 'm'))).toBe(0);
  });

  it('markSessionStart writes the marker so the next count starts from now', () => {
    const log = join(dir, 'f.jsonl');
    const marker = join(dir, 'state', 'm');
    writeFileSync(log, line('2026-10-27T08:00:00Z') + '\n');
    markSessionStart(marker, NOW);
    expect(readFileSync(marker, 'utf-8').trim()).toBe(NOW.toISOString());
    expect(countFailedWritesSince(log, marker)).toBe(0);
  });
});

describe('runSessionHealth', () => {
  let state: string;
  beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'mem-session-')); });
  afterEach(() => { rmSync(state, { recursive: true, force: true }); });

  const runnerWith = (rows: number, newest: Date | null) =>
    (async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string) =>
          sql.includes('schema_meta')
            ? { rows: [{ value: EXPECTED_SCHEMA_VERSION }] }
            : { rows: [{ db: 'continuous_claude', rows, newest, no_emb: 0 }] },
      })) as never;

  const writeBackup = (name: string, ageHours: number) => {
    const dir = join(state, 'memory-backup');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, '{}\n');
    const when = new Date(NOW.getTime() - ageHours * 3600_000);
    utimesSync(file, when, when);
    return file;
  };

  const spawns: unknown[][] = [];
  const spawnFn = ((cmd: string, args: string[], opts: unknown) => {
    spawns.push([cmd, args, opts]);
    return { unref() {} };
  }) as never;
  beforeEach(() => { spawns.length = 0; });

  it('healthy + no backup yet: spawns the backup via uv in the opc dir, no systemMessage', async () => {
    const out = await runSessionHealth({ stateDir: state, opcDir: '/opc', now: NOW, runner: runnerWith(5, hoursAgo(1)), spawnFn });
    expect(out.warn).toBe(false);
    expect(spawns).toHaveLength(1);
    const [, , opts] = spawns[0] as [string, string[], { cwd: string }];
    expect(opts.cwd).toBe('/opc');
    expect(JSON.stringify(spawns[0])).toContain('scripts/core/memory_backup.py');
    expect(JSON.stringify(spawns[0])).toContain('"backup"');
  });

  it('a backup younger than 24 h: no spawn', async () => {
    writeBackup('archival_memory-20261027.jsonl', 3);
    await runSessionHealth({ stateDir: state, opcDir: '/opc', now: NOW, runner: runnerWith(5, hoursAgo(1)), spawnFn });
    expect(spawns).toHaveLength(0);
  });

  it('a backup older than 24 h: spawn', async () => {
    writeBackup('archival_memory-20261025.jsonl', 30);
    await runSessionHealth({ stateDir: state, opcDir: '/opc', now: NOW, runner: runnerWith(5, hoursAgo(1)), spawnFn });
    expect(spawns).toHaveLength(1);
  });

  it('empty table: no backup spawn, line names the newest backup restore command, warns', async () => {
    const file = writeBackup('archival_memory-20261024.jsonl', 80);
    writeBackup('archival_memory-20261020.jsonl', 200);
    const out = await runSessionHealth({ stateDir: state, opcDir: '/opc', now: NOW, runner: runnerWith(0, null), spawnFn });
    expect(spawns).toHaveLength(0);
    expect(out.warn).toBe(true);
    expect(out.line).toContain('EMPTY');
    expect(out.line).toContain('memory_backup.py restore --file');
    expect(out.line).toContain(file);
    expect(out.line).not.toContain('--yes');
  });

  it('counts failed writes, then the marker makes the next session start at zero', async () => {
    writeFileSync(join(state, 'memory-write-failures.jsonl'),
      JSON.stringify({ ts: '2026-10-27T10:00:00Z', source: 'store_learning', error: 'e', session_id: 's' }) + '\n');
    const first = await runSessionHealth({ stateDir: state, opcDir: null, now: NOW, runner: runnerWith(5, hoursAgo(1)), spawnFn });
    expect(first.line).toContain('1 failed memory writes since last session');
    expect(first.warn).toBe(true);
    const second = await runSessionHealth({ stateDir: state, opcDir: null, now: NOW, runner: runnerWith(5, hoursAgo(1)), spawnFn });
    expect(second.line).not.toContain('failed memory writes');
    expect(existsSync(join(state, 'memory-health-last-session'))).toBe(true);
  });

  it('a runner that throws still returns an UNKNOWN line and spawns nothing', async () => {
    const runner = (async () => { throw new Error('down'); }) as never;
    const out = await runSessionHealth({ stateDir: state, opcDir: '/opc', now: NOW, runner, spawnFn });
    expect(out.line).toMatch(/^Memory: UNKNOWN \(probe failed: /);
    expect(out.warn).toBe(true);
    expect(spawns).toHaveLength(0);
  });

  it('an unwritable state dir does not throw', async () => {
    const blocker = join(state, 'file');
    writeFileSync(blocker, 'x');
    const out = await runSessionHealth({ stateDir: join(blocker, 'sub'), opcDir: '/opc', now: NOW, runner: runnerWith(5, hoursAgo(1)), spawnFn });
    expect(out.line).toContain('Memory: 5 lessons');
  });
});
