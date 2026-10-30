/**
 * Recall outcome codes (memory phase 1). Ways it can fail, one test each:
 *
 *  1. A non-zero exit from the recall script is read as "no results" (the 2026-10-24 outage).
 *  2. A JSON {"error": ...} body is read as "no results".
 *  3. A SIGKILL timeout is reported as an error instead of 'timeout', or as a miss.
 *  4. A spawn failure (uv missing) is read as "no results".
 *  5. A clean zero-result answer is reported as an error.
 *  6. Results that all fall under the floor are reported as 'miss' or 'hit'.
 *  7. Error beats the counts: an error with leftover results is still 'no-db'.
 *  8. The log entry loses an old field, or the new `outcome` field is absent.
 *  9. (async recall) the SIGKILL timeout mapping is dropped, so a timeout reads as an error.
 * 10. (async recall) stdout is read at 'exit', before the pipe is drained, so output is lost.
 * 11. (async recall) a spawn error never settles the promise, and the hook hangs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { classifyRecallOutcome, interpretRecallProcess, checkDbMemory } from '../memory-awareness.js';

const rows = [{ id: 'abcd1234', content: 'lesson', score: 0.5, learning_type: 'WORKING_SOLUTION' }];
const proc = (over: Record<string, unknown>) => ({ status: 0, signal: null, stdout: '', ...over }) as never;

describe('interpretRecallProcess', () => {
  it('non-zero exit is an error, not an empty result', () => {
    const [results, timedOut, error] = interpretRecallProcess(proc({ status: 1, stdout: '' }), false);
    expect(results).toEqual([]);
    expect(timedOut).toBe(false);
    expect(error).toMatch(/exit 1/);
  });

  it('JSON error body is an error', () => {
    const [, , error] = interpretRecallProcess(proc({ stdout: JSON.stringify({ error: 'relation archival_memory does not exist' }) }), false);
    expect(error).toContain('archival_memory');
  });

  it('timeout is a timeout, with no error', () => {
    const [, timedOut, error] = interpretRecallProcess(proc({ status: null, signal: 'SIGKILL' }), false);
    expect(timedOut).toBe(true);
    expect(error).toBeNull();
  });

  it('spawn failure is an error', () => {
    const [, , error] = interpretRecallProcess(proc({ status: null, error: Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }) }), false);
    expect(error).toContain('ENOENT');
  });

  it('clean zero results: no error', () => {
    const [results, timedOut, error] = interpretRecallProcess(proc({ stdout: JSON.stringify({ results: [] }) }), false);
    expect([results, timedOut, error]).toEqual([[], false, null]);
  });

  it('results come through mapped, no error', () => {
    const [results, , error] = interpretRecallProcess(proc({ stdout: JSON.stringify({ results: rows }) }), false);
    expect(results).toHaveLength(1);
    expect(error).toBeNull();
  });

  it('unparseable stdout is an error', () => {
    const [, , error] = interpretRecallProcess(proc({ stdout: 'Traceback (most recent call last)' }), false);
    expect(error).toMatch(/unparseable/);
  });
});

describe('classifyRecallOutcome', () => {
  const base = { error: null, timedOut: false, resultsCount: 0, keptCount: 0 };
  it.each([
    ['error -> no-db', { ...base, error: 'exit 1' }, 'no-db'],
    ['error beats leftover results', { ...base, error: 'x', resultsCount: 2, keptCount: 2 }, 'no-db'],
    ['timeout', { ...base, timedOut: true }, 'timeout'],
    ['no results, no error -> miss', base, 'miss'],
    ['results but none kept -> below-floor', { ...base, resultsCount: 2 }, 'below-floor'],
    ['results kept -> hit', { ...base, resultsCount: 2, keptCount: 1 }, 'hit'],
  ])('%s', (_name, input, expected) => {
    expect(classifyRecallOutcome(input)).toBe(expected);
  });
});

describe('built hook log entry', () => {
  const HOOK = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'dist', 'memory-awareness.mjs');

  it.skipIf(!existsSync(HOOK))('with no opc dir, logs outcome no-db and keeps the old fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'mem-outcome-'));
    try {
      const project = join(root, 'proj');
      const home = join(root, 'home');
      mkdirSync(project, { recursive: true });
      mkdirSync(home, { recursive: true });
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITEST')) env[k] = v;
      Object.assign(env, {
        CLAUDE_OPC_DIR: join(root, 'no-such-opc'), CLAUDE_PROJECT_DIR: project,
        HOME: home, USERPROFILE: home, CCV3_EMBEDDING_NO_SPAWN: '1',
      });
      delete env.CLAUDE_AGENT_ID;
      const prompt = 'how does the postgres archival memory recall pipeline work';
      spawnSync('node', [HOOK], {
        input: JSON.stringify({ prompt, session_id: 's-outcome', cwd: project }),
        encoding: 'utf-8', timeout: 20000, env,
      });
      const log = readFileSync(join(project, '.claude', 'logs', 'memory-recall.jsonl'), 'utf-8').trim();
      const entry = JSON.parse(log.split('\n').pop()!);
      expect(entry.outcome).toBe('no-db');
      expect(entry.recall_error).toBe('opc dir not found');
      for (const field of ['timestamp', 'session_id', 'results_count', 'kept_after_floor', 'mode', 'db_subprocess_timed_out', 'recall_via']) {
        expect(entry, field).toHaveProperty(field);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

/**
 * checkDbMemory is async so the event loop stays free for the other prompt jobs.
 * The spawn seam replaces the real `uv`: a fake child that Node would run as a .cmd
 * file is refused on Windows (EINVAL), so a PATH shim cannot stand in for it.
 */
describe('checkDbMemory (async uv recall)', () => {
  function withOpc<T>(fn: () => Promise<T>): Promise<T> {
    const opc = mkdtempSync(join(tmpdir(), 'mem-opc-'));
    const prev = process.env.CLAUDE_OPC_DIR;
    process.env.CLAUDE_OPC_DIR = opc;
    return fn().finally(() => {
      if (prev === undefined) delete process.env.CLAUDE_OPC_DIR; else process.env.CLAUDE_OPC_DIR = prev;
      rmSync(opc, { recursive: true, force: true });
    });
  }
  function fakeSpawn(script: (child: any) => void) {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const fn = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => script(child));
      return child;
    }) as never;
    return { fn, calls };
  }

  it('9: a SIGKILL close maps to timedOut=true with no error', async () => {
    const { fn, calls } = fakeSpawn((c) => c.emit('close', null, 'SIGKILL'));
    const out = await withOpc(() => checkDbMemory('postgres recall pipeline', '/p', true, { spawnFn: fn }));
    expect(out).toEqual([[], true, null]);
    expect(calls[0].cmd).toBe('uv');
    expect(calls[0].opts.killSignal).toBe('SIGKILL');
    expect(calls[0].opts.timeout).toBe(12000);
  });

  it('9b: text-only mode keeps the 5000 ms cap and the --text-only flag', async () => {
    const { fn, calls } = fakeSpawn((c) => c.emit('close', null, 'SIGKILL'));
    await withOpc(() => checkDbMemory('postgres recall pipeline', '/p', false, { spawnFn: fn }));
    expect(calls[0].opts.timeout).toBe(5000);
    expect(calls[0].args).toContain('--text-only');
  });

  it('10: stdout that arrives after exit and before close is not lost', async () => {
    const body = JSON.stringify({ results: rows });
    const { fn } = fakeSpawn((c) => {
      c.emit('exit', 0, null);
      c.stdout.emit('data', Buffer.from(body.slice(0, 10)));
      c.stdout.emit('data', Buffer.from(body.slice(10)));
      c.emit('close', 0, null);
    });
    const [results, timedOut, error] = await withOpc(() => checkDbMemory('postgres recall pipeline', '/p', true, { spawnFn: fn }));
    expect(error).toBeNull();
    expect(timedOut).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('abcd1234');
  });

  it('11: a spawn error settles with an error string, even if close also fires', async () => {
    const { fn } = fakeSpawn((c) => {
      c.emit('error', Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }));
      c.emit('close', null, null);
    });
    const [results, timedOut, error] = await withOpc(() => checkDbMemory('postgres recall pipeline', '/p', true, { spawnFn: fn }));
    expect(results).toEqual([]);
    expect(timedOut).toBe(false);
    expect(error).toMatch(/ENOENT/);
  });
});
