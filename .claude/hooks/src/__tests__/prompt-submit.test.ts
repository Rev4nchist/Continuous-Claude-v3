/**
 * prompt-submit: ONE node process runs the 5 UserPromptSubmit jobs.
 *
 * Why: Windows Defender scans every node start. Five parallel starts took up to
 * 4.8 s and hit the 5 s hook timeout, so their output was discarded.
 *
 * Ways it can fail, one test each (the source change that turns it red is in
 * brackets):
 *   1  a job throws and the other outputs are lost          [per-job catch removed]
 *   2  a hung job with a live handle keeps the process up   [exit after write, or deadline race, removed]
 *   3  stdout is more than ONE JSON object                   [heartbeat or memory-awareness loses its import guard]
 *   4  a stray console.log in a job corrupts stdout          [stdout guard removed]
 *   5  merge follows completion order, not the fixed order   [merge iterates results as they finish]
 *   6  a systemMessage is dropped by the merge               [merge copies only additionalContext]
 *   7  continue:false / decision:block lost in the merge     [merge copies only additionalContext]
 *   8  all-empty results give an empty additionalContext     [hookSpecificOutput always emitted]
 *   9  a SessionStart payload runs the jobs                  [event guard removed]
 *  10  a job is skipped on bad stdin, or sees pre-parsed data [prompt-submit pre-parses stdin]
 *  11  a late rejection changes the exit code                [unhandledRejection handler removed]
 *  13  a job blocks the loop, so a sibling job misses its timer [jobs run one after another]
 *  13b the sync prefix of a job is charged to the wrong job    [syncMs removed]
 *   3b a late console.log lands on stdout before the write     [guard restored before the write]
 *   4b an uncaught exception stalls every prompt for 12 s      [deadline not cut by the handler]
 *   9  memory-awareness blocks the loop on the RAM probe       [spawnSync probe back in memory-awareness]
 *   7  a JOBS name maps to the wrong run function              [JOBS entry swapped]
 *  16  main() passes DEADLINE_MS through without the uptime    [budget subtraction removed]
 *  lane-context-end.test.ts: a slow client.end() drops the output after the watermark write
 *  15  a standalone dist stops printing, or runs on import   [main() guard or writer changes]
 *
 * Tests 2, 3, 4, 10, 11 and 15 run the BUILT dist, as Claude Code does.
 * Test 12 is in memory-awareness-outcome.test.ts, 14 in store-learning-injection.test.ts,
 * 16 in settings-template-validation.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(HERE, '..', '..', 'dist');
const PROMPT_SUBMIT = join(DIST, 'prompt-submit.mjs');
const PROMPT_SUBMIT_URL = pathToFileURL(PROMPT_SUBMIT).href;

import { runHeartbeat } from '../heartbeat.js';
import { runMemoryAwareness } from '../memory-awareness.js';
import { runUserConfirmationDetector } from '../user-confirmation-detector.js';
import { runBusSessionPopulator } from '../bus-session-populator.js';
import { runLaneContext } from '../lane-context.js';

type PS = typeof import('../prompt-submit.js');
const load = (): Promise<PS> => import('../prompt-submit.js');

interface FakeJob { name: string; run: (raw: string) => Promise<unknown> }
const job = (name: string, output: unknown, delayMs = 0): FakeJob => ({
  name,
  run: () => new Promise((res) => setTimeout(() => res(output), delayMs)),
});
const ctx = (text: string) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });

const UPS = JSON.stringify({ session_id: 'ps-test', hook_event_name: 'UserPromptSubmit', prompt: 'remember this for later please' });

/** Env that keeps a dist run away from the real DB, the real HOME and the live bus. */
function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITEST')) env[k] = v;
  return {
    ...env,
    CLAUDE_AGENT_ID: 'ps-test',
    CONTINUOUS_CLAUDE_DB_URL: '',
    DATABASE_URL: '',
    OPC_POSTGRES_URL: '',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PROJECT_DIR: home,
    CCV3_EMBEDDING_NO_SPAWN: '1',
    ...extra,
  };
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'ps-home-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Run `body` in a fresh node that has imported dist/prompt-submit.mjs as `m`. */
function runInDist(body: string, home: string, extra: Record<string, string> = {}, timeout = 15000) {
  const script = `import * as m from ${JSON.stringify(PROMPT_SUBMIT_URL)};\n${body}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8', timeout, env: isolatedEnv(home, extra),
  });
}

describe('mergeOutputs', () => {
  it('5: merges in the fixed order, even when lane-context resolves first', async () => {
    const { runPromptSubmit } = await load();
    const jobs = [
      job('memory-awareness', ctx('MEMORY'), 150),
      job('lane-context', ctx('LANE'), 0),
    ];
    const { output } = await runPromptSubmit(UPS, jobs, 5000);
    expect((output as any).hookSpecificOutput.additionalContext).toBe('MEMORY\n\nLANE');
    expect((output as any).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });

  it('5b: the order is by job name, not by the order of the result list', async () => {
    const { mergeOutputs } = await load();
    const merged = mergeOutputs([
      { name: 'lane-context', output: ctx('LANE') },
      { name: 'memory-awareness', output: ctx('MEMORY') },
    ]);
    expect((merged as any).hookSpecificOutput.additionalContext).toBe('MEMORY\n\nLANE');
  });

  it('6: systemMessage passes through, and two join with a newline', async () => {
    const { mergeOutputs } = await load();
    const one = mergeOutputs([{ name: 'user-confirmation-detector', output: { continue: true, systemMessage: 'A' } }]);
    expect(one).toEqual({ systemMessage: 'A' });
    const two = mergeOutputs([
      { name: 'heartbeat', output: { systemMessage: 'first' } },
      { name: 'user-confirmation-detector', output: { continue: true, systemMessage: 'second' } },
    ]);
    expect(two).toEqual({ systemMessage: 'first\nsecond' });
  });

  it('7: continue:false keeps the first stopReason in fixed order', async () => {
    const { mergeOutputs } = await load();
    const merged = mergeOutputs([
      { name: 'lane-context', output: { continue: false, stopReason: 'late' } },
      { name: 'heartbeat', output: { continue: false, stopReason: 'early' } },
    ]);
    expect(merged).toEqual({ continue: false, stopReason: 'early' });
  });

  it('7b: decision:block keeps the first block and its reason', async () => {
    const { mergeOutputs } = await load();
    const merged = mergeOutputs([
      { name: 'memory-awareness', output: { decision: 'block', reason: 'mem says no' } },
      { name: 'bus-session-populator', output: { decision: 'block', reason: 'bus says no' } },
    ]);
    expect(merged).toEqual({ decision: 'block', reason: 'mem says no' });
  });

  it('7c: another top-level key is won by the first job in fixed order', async () => {
    const { mergeOutputs } = await load();
    const merged = mergeOutputs([
      { name: 'lane-context', output: { suppressOutput: false } },
      { name: 'heartbeat', output: { suppressOutput: true } },
    ]);
    expect(merged).toEqual({ suppressOutput: true });
  });

  it('8: all-empty results give {} with no empty additionalContext', async () => {
    const { mergeOutputs } = await load();
    const merged = mergeOutputs([
      { name: 'heartbeat', output: { result: 'continue' } },
      { name: 'memory-awareness', output: { result: 'continue' } },
      { name: 'user-confirmation-detector', output: { continue: true } },
      { name: 'bus-session-populator', output: null },
      { name: 'lane-context', output: {} },
    ]);
    expect(merged).toEqual({});
  });

  it('8b: an empty additionalContext string is dropped', async () => {
    const { mergeOutputs } = await load();
    expect(mergeOutputs([{ name: 'lane-context', output: ctx('') }])).toEqual({});
  });
});

describe('runPromptSubmit', () => {
  it('1: a job that throws does not lose the other outputs', async () => {
    const { runPromptSubmit } = await load();
    const boom: FakeJob = { name: 'heartbeat', run: async () => { throw new Error('boom'); } };
    const { output, report } = await runPromptSubmit(UPS, [
      boom,
      job('memory-awareness', ctx('MEMORY')),
      job('user-confirmation-detector', { continue: true, systemMessage: 'SM' }),
    ], 5000);
    expect(output).toEqual({ ...ctx('MEMORY'), systemMessage: 'SM' });
    expect(report.map((r) => [r.name, r.status])).toEqual([
      ['heartbeat', 'error'], ['memory-awareness', 'ok'], ['user-confirmation-detector', 'ok'],
    ]);
  });

  it('2a: a job that misses the deadline is cut, and the others still ship', async () => {
    const { runPromptSubmit } = await load();
    const hang: FakeJob = { name: 'lane-context', run: () => new Promise(() => {}) };
    const t0 = Date.now();
    const { output, report } = await runPromptSubmit(UPS, [job('memory-awareness', ctx('MEMORY')), hang], 300);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(output).toEqual(ctx('MEMORY'));
    expect(report.find((r) => r.name === 'lane-context')?.status).toBe('timeout');
  });

  it('4: a stray console.log in a job goes to stderr and never reaches stdout', () => {
    withHome((home) => {
      const r = runInDist(`
        const noisy = { name: 'heartbeat', run: async () => { console.log('STRAY-LOG'); process.stdout.write('STRAY-WRITE'); return {}; } };
        const ok = { name: 'memory-awareness', run: async () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'MEM' } }) };
        const res = await m.runPromptSubmit(${JSON.stringify(UPS)}, [noisy, ok], 3000);
        m.emitAndExit(res.output);
      `, home);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual(ctx('MEM'));
      expect(r.stdout).not.toContain('STRAY');
      expect(r.stderr).toContain('[prompt-submit stray]');
      expect(r.stderr).toContain('STRAY-LOG');
    });
  });

  it('9: a SessionStart payload gives {} and runs no job', async () => {
    const { runPromptSubmit } = await load();
    const calls: string[] = [];
    const spy = (name: string): FakeJob => ({ name, run: async () => { calls.push(name); return ctx(name); } });
    const raw = JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart' });
    const { output } = await runPromptSubmit(raw, [spy('heartbeat'), spy('lane-context')], 3000);
    expect(output).toEqual({});
    expect(calls).toEqual([]);
  });

  it('9b: no hook_event_name, a UserPromptSubmit name, and bad JSON all run the jobs', async () => {
    const { runPromptSubmit } = await load();
    for (const raw of ['{"session_id":"s"}', UPS, 'not json']) {
      const calls: string[] = [];
      const spy: FakeJob = { name: 'heartbeat', run: async () => { calls.push('x'); return {}; } };
      await runPromptSubmit(raw, [spy], 3000);
      expect(calls, raw).toEqual(['x']);
    }
  });

  it('10: every job gets the raw stdin text unchanged, including empty and bad JSON', async () => {
    const { runPromptSubmit } = await load();
    for (const raw of ['', 'not json', '{"prompt": "x"', UPS]) {
      const seen: string[] = [];
      const spy = (name: string): FakeJob => ({ name, run: async (r) => { seen.push(r); return {}; } });
      const { output } = await runPromptSubmit(raw, [spy('heartbeat'), spy('lane-context')], 3000);
      expect(seen, JSON.stringify(raw)).toEqual([raw, raw]);
      expect(output).toEqual({});
    }
  });

  it('13: an async child process in one job does not block a sibling timer', async () => {
    const { runPromptSubmit } = await load();
    const slowChild: FakeJob = {
      name: 'memory-awareness',
      run: () => new Promise((res) => {
        const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], { stdio: 'ignore' });
        c.on('close', () => res({}));
      }),
    };
    const timer = job('lane-context', ctx('LANE'), 500);
    const { report } = await runPromptSubmit(UPS, [slowChild, timer], 8000);
    const t = report.find((r) => r.name === 'lane-context')!;
    expect(t.status).toBe('ok');
    expect(t.ms).toBeLessThan(1500);
  });

  it('13b: syncMs is reported per job, and a sync prefix is charged to the job that ran it', async () => {
    const { runPromptSubmit } = await load();
    const blocker: FakeJob = { name: 'memory-awareness', run: () => { const end = Date.now() + 300; while (Date.now() < end) { /* sync work */ } return Promise.resolve({}); } };
    const quick = job('lane-context', ctx('LANE'), 0);
    const { report } = await runPromptSubmit(UPS, [blocker, quick], 5000);
    const [mem, lane] = report;
    expect(mem.syncMs, 'blocker syncMs').toBeGreaterThanOrEqual(250);
    expect(lane.syncMs, 'quick job syncMs').toBeLessThan(100);
  });

  it('DEADLINE_MS: the env override is clamped to 100..13000 and defaults to 12000', () => {
    const read = (v?: string) => withHome((home) => {
      const extra: Record<string, string> = v === undefined ? {} : { CCV3_PROMPT_SUBMIT_DEADLINE_MS: v };
      const r = runInDist('process.stdout.write(String(m.DEADLINE_MS));', home, extra);
      return Number(r.stdout);
    });
    expect(read(undefined)).toBe(12000);
    expect(read('5')).toBe(100);
    expect(read('999999')).toBe(13000);
    expect(read('2500')).toBe(2500);
  });
});

describe('JOBS', () => {
  it('7: each job name maps to its own run function', async () => {
    const { JOBS } = await load();
    const want: Record<string, unknown> = {
      'bus-session-populator': runBusSessionPopulator,
      'user-confirmation-detector': runUserConfirmationDetector,
      'memory-awareness': runMemoryAwareness,
      'heartbeat': runHeartbeat,
      'lane-context': runLaneContext,
    };
    expect(JOBS.map((j) => j.name).sort()).toEqual(Object.keys(want).sort());
    for (const j of JOBS) expect(j.run === want[j.name], `${j.name} runs the wrong function`).toBe(true);
  });
});

describe('the built prompt-submit.mjs, run as Claude Code runs it', () => {
  it('2: a hung job with a live handle: merged JSON is written and the process exits 0', () => {
    withHome((home) => {
      const r = runInDist(`
        const hang = { name: 'lane-context', run: () => { setInterval(() => {}, 1000); return new Promise(() => {}); } };
        const ok = { name: 'memory-awareness', run: async () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'MEM' } }) };
        const res = await m.runPromptSubmit(${JSON.stringify(UPS)}, [ok, hang], 300);
        m.emitAndExit(res.output);
      `, home, { CCV3_PROMPT_SUBMIT_DEADLINE_MS: '300' }, 10000);
      expect(r.error, 'process did not exit (live handle kept it open)').toBeUndefined();
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual(ctx('MEM'));
    });
  });

  it('11: a rejection that fires after the deadline does not change the exit code', () => {
    withHome((home) => {
      const r = runInDist(`
        const late = { name: 'lane-context', run: () => { setTimeout(() => { Promise.reject(new Error('late-boom')); }, 150); return new Promise(() => {}); } };
        const res = await m.runPromptSubmit(${JSON.stringify(UPS)}, [late], 100);
        await new Promise((r) => setTimeout(r, 400));
        m.emitAndExit(res.output);
      `, home, {}, 10000);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('{}');
    });
  });

  it('3 and 10: stdout is exactly ONE JSON object for a real payload', () => {
    withHome((home) => {
      const r = spawnSync(process.execPath, [PROMPT_SUBMIT], { input: UPS, encoding: 'utf-8', timeout: 30000, env: isolatedEnv(home) });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({
        systemMessage: '[UserConfirm:L1] Memory request detected - watching for content to remember',
      });
      for (const name of ['heartbeat', 'memory-awareness', 'user-confirmation-detector', 'bus-session-populator', 'lane-context']) {
        expect(r.stderr, name).toMatch(new RegExp(`\\[prompt-submit\\] ${name} ok \\d+ms`));
      }
    });
  });

  it('3b: a late console.log from a timed-out job never reaches stdout, even between the deadline and the write', () => {
    withHome((home) => {
      const r = runInDist(`
        const late = { name: 'lane-context', run: () => { setTimeout(() => { console.log('LATE-LOG'); process.stdout.write('LATE-WRITE'); }, 150); return new Promise(() => {}); } };
        const res = await m.runPromptSubmit(${JSON.stringify(UPS)}, [late], 100);
        await new Promise((r) => setTimeout(r, 400));
        m.emitAndExit(res.output);
      `, home, {}, 10000);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('{}');
      expect(r.stderr).toContain('LATE-LOG');
    });
  });

  it('4b: an uncaught exception cuts the deadline after a short grace, and the other outputs ship', () => {
    withHome((home) => {
      const t0 = Date.now();
      const r = runInDist(`
        const bad = { name: 'lane-context', run: () => { setTimeout(() => { throw new Error('emitter-boom'); }, 50); return new Promise(() => {}); } };
        const ok = { name: 'memory-awareness', run: async () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'MEM' } }) };
        const res = await m.runPromptSubmit(${JSON.stringify(UPS)}, [ok, bad], 8000);
        m.emitAndExit({ ...res.output, status: res.report.map((x) => x.name + ':' + x.status).join(',') });
      `, home, { CCV3_PROMPT_SUBMIT_GRACE_MS: '200' }, 10000);
      expect(r.status).toBe(0);
      expect(Date.now() - t0, 'waited for the 8 s deadline').toBeLessThan(5000);
      const out = JSON.parse(r.stdout.trim());
      expect(out.hookSpecificOutput.additionalContext).toBe('MEM');
      expect(out.status).toBe('memory-awareness:ok,lane-context:timeout');
      expect(r.stderr).toContain('emitter-boom');
    });
  });

  it('9: the real memory-awareness and user-confirmation-detector do no long sync work before their first await', () => {
    withHome((home) => {
      const r = runInDist(`
        const jobs = m.JOBS.filter((j) => j.name === 'memory-awareness' || j.name === 'user-confirmation-detector');
        const res = await m.runPromptSubmit(${JSON.stringify(UPS)}, jobs, 8000);
        m.emitAndExit({ sync: Object.fromEntries(res.report.map((x) => [x.name, x.syncMs])) });
      `, home, { CLAUDE_AGENT_ID: '' }, 20000);
      expect(r.status).toBe(0);
      const { sync } = JSON.parse(r.stdout.trim());
      expect(typeof sync['memory-awareness'], r.stderr).toBe('number');
      expect(sync['memory-awareness'], 'memory-awareness blocked the loop (host RAM probe?)').toBeLessThan(200);
      expect(sync['user-confirmation-detector']).toBeLessThan(200);
    });
  });

  it('16: main() takes the time already spent starting out of the deadline budget', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ps-home-'));
    try {
      const child = spawn(process.execPath, [PROMPT_SUBMIT], {
        env: isolatedEnv(home, { CCV3_PROMPT_SUBMIT_DEADLINE_MS: '3000' }), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      const exited = new Promise<number | null>((res) => child.on('close', res));
      await new Promise((r) => setTimeout(r, 1000)); // the process is 1 s old when stdin arrives
      child.stdin.end(UPS);
      expect(await exited).toBe(0);
      const budget = Number(/\[prompt-submit\] budget (\d+)ms/.exec(stderr)?.[1]);
      expect(Number.isFinite(budget), stderr).toBe(true);
      expect(budget).toBeLessThan(2200); // 3000 passed straight through would be 3000
      expect(budget).toBeGreaterThan(800);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);

  it('10b: empty stdin, bad JSON and a SessionStart payload each give {} and exit 0', () => {
    withHome((home) => {
      for (const input of ['', 'not json', JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart' })]) {
        const r = spawnSync(process.execPath, [PROMPT_SUBMIT], { input, encoding: 'utf-8', timeout: 30000, env: isolatedEnv(home) });
        expect(r.status, input).toBe(0);
        expect(r.stdout.trim(), input).toBe('{}');
      }
    });
  });
});

describe('standalone dists keep their output and are import-safe', () => {
  const HOOKS = ['heartbeat', 'memory-awareness', 'user-confirmation-detector', 'bus-session-populator', 'lane-context'];

  // Fixtures: what the pre-refactor dists (git aef1e7e2) printed for these exact inputs,
  // saved by the E2E script. Not hand-typed. Line endings are normalised because git may
  // check the files out with CRLF.
  const FIXTURES = join(HERE, 'fixtures', 'prompt-submit-pre-refactor');
  const lf = (text: string): string => text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const fixture = (hook: string, prompt: string) =>
    lf(readFileSync(join(FIXTURES, `${hook}.${prompt === 'hi' ? 'hi' : 'remember'}.stdout`), 'utf-8'));

  it('15: every standalone dist prints what the pre-refactor dist printed', () => {
    withHome((home) => {
      const run = (hook: string, prompt: string) => spawnSync(process.execPath, [join(DIST, `${hook}.mjs`)], {
        input: JSON.stringify({ session_id: 'ps-parity', hook_event_name: 'UserPromptSubmit', cwd: home, prompt }),
        encoding: 'utf-8', timeout: 30000, env: isolatedEnv(home),
      });
      const cases: Array<[string, string]> = [
        ['heartbeat', 'remember this for later please'],
        ['user-confirmation-detector', 'remember this for later please'],
        ['user-confirmation-detector', 'hi'],
        ['bus-session-populator', 'remember this for later please'],
        ['memory-awareness', 'remember this for later please'],
        ['lane-context', 'remember this for later please'],
      ];
      for (const [hook, prompt] of cases) {
        expect(lf(run(hook, prompt).stdout), `${hook} / ${prompt}`).toBe(fixture(hook, prompt));
      }
    });
  });

  for (const hook of HOOKS) {
    it(`15b: importing dist/${hook}.mjs prints nothing and runs no main()`, () => {
      withHome((home) => {
        const url = pathToFileURL(join(DIST, `${hook}.mjs`)).href;
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
          input: UPS, encoding: 'utf-8', timeout: 20000, env: isolatedEnv(home),
        });
        expect(r.stdout, `${hook} wrote to stdout on import`).toBe('');
      });
    });
  }

  it('15c: a script inside a directory named like a hook does not start that hook', () => {
    withHome((home) => {
      const dir = join(home, 'lane-context-fix', 'heartbeat-v2');
      mkdirSync(dir, { recursive: true });
      const imports = HOOKS.map((h) => `await import(${JSON.stringify(pathToFileURL(join(DIST, `${h}.mjs`)).href)});`).join('\n');
      const entry = join(dir, 'entry.mjs');
      writeFileSync(entry, imports);
      const r = spawnSync(process.execPath, [entry], { input: UPS, encoding: 'utf-8', timeout: 30000, env: isolatedEnv(home) });
      expect(r.stdout).toBe('');
    });
  });
});
