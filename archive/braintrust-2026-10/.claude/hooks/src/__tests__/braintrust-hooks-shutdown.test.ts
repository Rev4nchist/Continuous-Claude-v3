/**
 * Regression guard for the Braintrust shutdown path (braintrust_hooks.py).
 *
 * The bug this locks down: `session_end` and `stop` performed a BLOCKING HTTPS
 * POST while the CLI was tearing the session down. When the Braintrust
 * connection stalled -- routine on this machine; the hook log carries 166 SSL
 * handshake timeouts and 110 forcibly-closed connections -- the process was
 * still inside the POST when the harness cancelled it, producing
 *
 *     SessionEnd hook [python .../braintrust_hooks.py session_end] failed: Hook cancelled
 *
 * and destroying the batch. Measured before the fix: 82 of 720 turns (11%) in
 * 30 days never finalized, including single lost batches of 145 and 236 spans.
 *
 * Contract now enforced here:
 *   1. session_end NEVER blocks on the network -- it spools durably and returns.
 *   2. A failed POST (transport error OR non-200) spools instead of dropping.
 *   3. flush_spool drains, and is safe under concurrent flushers.
 *   4. Expired entries are dead-lettered, never silently discarded.
 *   5. Lone surrogates in transcript text no longer kill a batch.
 *   6. No test may read the real ~/.claude/.env -- HOME/USERPROFILE are isolated.
 *      A prior red test in this repo printed `Bearer sk-...` into its output.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { spawnSync, spawn } from 'child_process';
import { createServer, Server } from 'http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';

// Overridable so this guard can be demonstrated failing against a pre-fix copy
// of the hook. A guard never run against the broken code proves nothing.
const HOOK = process.env.BT_HOOK_PATH || resolve(__dirname, '../../braintrust_hooks.py');

/** Resolve a usable Python. These hooks cannot run without one. */
function pythonBin(): string {
  for (const bin of ['python', 'python3']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  throw new Error('No python on PATH — braintrust_hooks.py cannot run');
}
const PY = pythonBin();

/** Isolated fake HOME. Also isolates the ~/.claude/.env credential read. */
function makeHome(apiUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), 'bt-hook-'));
  mkdirSync(join(home, '.claude', 'state', 'braintrust_sessions'), { recursive: true });
  writeFileSync(
    join(home, '.claude', '.env'),
    [
      'TRACE_TO_BRAINTRUST=true',
      'BRAINTRUST_API_KEY=sk-fake-test-key-not-real',
      `BRAINTRUST_API_URL=${apiUrl}`,
      '',
    ].join('\n'),
  );
  return home;
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * MUST be async. The stub servers below run in this same worker, and spawnSync
 * blocks the event loop — the child would then wait out its full read timeout
 * for a response the blocked server can never send. That deadlock cost four
 * false failures before it was spotted.
 */
function runHook(home: string, apiUrl: string, sub: string, stdin = '{}'): Promise<HookResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(PY, [HOOK, sub], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        BRAINTRUST_API_URL: apiUrl,
        // Belt and braces: even if isolation regressed, no real key is in scope.
        BRAINTRUST_API_KEY: 'sk-fake-test-key-not-real',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const statePath = (home: string, f: string) => join(home, '.claude', 'state', f);
const spoolLines = (home: string): string[] => {
  const p = statePath(home, 'braintrust_spool.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
};
const hookLog = (home: string): string => {
  const p = statePath(home, 'braintrust_hook.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

function seedSession(home: string, sessionId: string) {
  writeFileSync(
    join(home, '.claude', 'state', 'braintrust_sessions', `${sessionId}.json`),
    JSON.stringify({
      root_span_id: sessionId,
      project_id: 'proj-test',
      turn_count: 2,
      started: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }),
  );
}

/** Servers ------------------------------------------------------------------ */

let stallServer: Server;
let okServer: Server;
let errServer: Server;
let sizeServer: Server;
let stallUrl = '';
let okUrl = '';
let errUrl = '';
let sizeUrl = '';

/**
 * Stands in for Braintrust's 10 MiB request cap, scaled down so tests stay fast.
 * A body over this returns 413, exactly as production does.
 */
const SIZE_LIMIT = 2_000;
let sizeAccepted = { events: 0, rejections: 0 };
const openSockets = new Set<Socket>();
let received = { posts: 0, events: 0 };

function track(s: Server) {
  s.on('connection', (sock: Socket) => {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
  });
}

beforeAll(async () => {
  // Accepts the connection and never responds — reproduces the stall exactly.
  stallServer = createServer(() => {
    /* intentionally no response */
  });
  okServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let n = 0;
      try {
        n = (JSON.parse(body || '{}').events || []).length;
      } catch {
        n = 0;
      }
      received.posts += 1;
      received.events += n;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ row_ids: Array(n).fill('r') }));
    });
  });
  errServer = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    });
  });

  sizeServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (Buffer.byteLength(body) > SIZE_LIMIT) {
        sizeAccepted.rejections += 1;
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('HTTP content length exceeded 10485760 bytes.');
        return;
      }
      let n = 0;
      try {
        n = (JSON.parse(body || '{}').events || []).length;
      } catch {
        n = 0;
      }
      sizeAccepted.events += n;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ row_ids: Array(n).fill('r') }));
    });
  });

  for (const s of [stallServer, okServer, errServer, sizeServer]) track(s);
  await Promise.all(
    [stallServer, okServer, errServer, sizeServer].map(
      (s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r)),
    ),
  );
  stallUrl = `http://127.0.0.1:${(stallServer.address() as AddressInfo).port}`;
  okUrl = `http://127.0.0.1:${(okServer.address() as AddressInfo).port}`;
  errUrl = `http://127.0.0.1:${(errServer.address() as AddressInfo).port}`;
  sizeUrl = `http://127.0.0.1:${(sizeServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const sock of openSockets) sock.destroy();
  await Promise.all(
    [stallServer, okServer, errServer, sizeServer].map(
      (s) => new Promise<void>((r) => s.close(() => r())),
    ),
  );
});

/** Tests -------------------------------------------------------------------- */

describe('braintrust_hooks.py session_end — never blocks on the network', () => {
  it('returns fast against a stalled Braintrust and spools the root-span close', async () => {
    const home = makeHome(stallUrl);
    seedSession(home, 'sess-stall');

    const t0 = Date.now();
    const r = await runHook(home, stallUrl, 'session_end', JSON.stringify({ session_id: 'sess-stall' }));
    const elapsed = Date.now() - t0;

    expect(r.status).toBe(0);
    // Registered SessionEnd budget is 10s. Pre-fix this took ~31s (measured),
    // guaranteeing cancellation. 5s leaves headroom for this machine's
    // documented spawn latency without ever tolerating a blocking POST.
    expect(elapsed).toBeLessThan(5_000);
    // The event must be durable, not merely "not lost in flight".
    expect(spoolLines(home).length).toBe(1);

    rmSync(home, { recursive: true, force: true });
  }, 30_000);

  it('does not read the real ~/.claude/.env credential', async () => {
    const home = makeHome(stallUrl);
    seedSession(home, 'sess-cred');
    const r = await runHook(home, stallUrl, 'session_end', JSON.stringify({ session_id: 'sess-cred' }));
    const blob = `${r.stdout ?? ''}${r.stderr ?? ''}${hookLog(home)}`;
    expect(blob).not.toContain('sk-ant');
    rmSync(home, { recursive: true, force: true });
  }, 30_000);
});

describe('spool durability', () => {
  it('keeps the entry and names the status when Braintrust returns a non-200', async () => {
    const home = makeHome(errUrl);
    // Seed the spool directly rather than going through session_end: that hook
    // also spawns a DETACHED flush child, which would race this explicit one
    // for the spool lock and make the assertion non-deterministic.
    writeFileSync(
      statePath(home, 'braintrust_spool.jsonl'),
      JSON.stringify({
        project_id: 'p',
        events: [{ id: 'rejected' }],
        spooled_at: Date.now() / 1000,
      }) + '\n',
    );

    await runHook(home, errUrl, 'flush');

    // A rejected batch is retried later, never dropped.
    expect(spoolLines(home).length).toBe(1);
    // Pre-fix a non-200 returned [] with NO log line at all, so every rejected
    // batch was invisible.
    expect(hookLog(home)).toMatch(/HTTP 500/);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it('drains the spool against a healthy endpoint', async () => {
    const home = makeHome(okUrl);
    const before = received.events;
    writeFileSync(
      statePath(home, 'braintrust_spool.jsonl'),
      Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({
          project_id: 'p',
          events: [{ id: `drain-${i}` }],
          spooled_at: Date.now() / 1000,
        }),
      ).join('\n') + '\n',
    );

    await runHook(home, okUrl, 'flush');

    expect(received.events - before).toBe(5);
    expect(spoolLines(home).length).toBe(0);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it('loses and duplicates nothing under concurrent flushers', async () => {
    const home = makeHome(okUrl);
    const COUNT = 20;
    const before = received.events;
    writeFileSync(
      statePath(home, 'braintrust_spool.jsonl'),
      Array.from({ length: COUNT }, (_, i) =>
        JSON.stringify({
          project_id: 'p',
          events: [{ id: `conc-${i}` }],
          spooled_at: Date.now() / 1000,
        }),
      ).join('\n') + '\n',
    );

    // 3+ sessions run concurrently on this machine. An unlocked
    // read-modify-write rewrite of the spool loses entries.
    const runs = await Promise.all([0, 1, 2, 3].map(() => runHook(home, okUrl, 'flush')));
    for (const r of runs) expect(r.status).toBe(0);

    expect(received.events - before).toBe(COUNT);
    expect(spoolLines(home).length).toBe(0);
    expect(existsSync(statePath(home, 'braintrust_spool.lock'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  }, 120_000);

  it('dead-letters expired entries instead of discarding them silently', async () => {
    const home = makeHome(okUrl);
    writeFileSync(
      statePath(home, 'braintrust_spool.jsonl'),
      JSON.stringify({
        project_id: 'p',
        events: [{ id: 'ancient' }],
        spooled_at: Date.now() / 1000 - 8 * 24 * 3600,
      }) + '\n',
    );

    await runHook(home, okUrl, 'flush');

    const dl = statePath(home, 'braintrust_spool.deadletter.jsonl');
    expect(existsSync(dl)).toBe(true);
    expect(readFileSync(dl, 'utf8')).toContain('ancient');
    expect(spoolLines(home).length).toBe(0);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});

describe('oversized batches (HTTP 413)', () => {
  it('splits an oversized batch until every span lands', async () => {
    const home = makeHome(sizeUrl);
    const before = sizeAccepted.events;
    // 8 spans, ~400 bytes each, well over the limit as one request but fine in
    // halves. Production hit this for real: a 94-span batch at 19.4 MB.
    const events = Array.from({ length: 8 }, (_, i) => ({
      id: `big-${i}`,
      input: 'x'.repeat(400),
    }));
    writeFileSync(
      statePath(home, 'braintrust_spool.jsonl'),
      JSON.stringify({ project_id: 'p', events, spooled_at: Date.now() / 1000 }) + '\n',
    );

    await runHook(home, sizeUrl, 'flush');

    // Every span delivered, nothing left behind, nothing dead-lettered.
    expect(sizeAccepted.events - before).toBe(8);
    expect(spoolLines(home).length).toBe(0);
    expect(existsSync(statePath(home, 'braintrust_spool.deadletter.jsonl'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it('dead-letters a single span that is too large instead of retrying it forever', async () => {
    const home = makeHome(sizeUrl);
    // One span that exceeds the cap on its own. Halving cannot help, so retrying
    // it would burn a session-start flush every day for 7 days and then expire.
    writeFileSync(
      statePath(home, 'braintrust_spool.jsonl'),
      JSON.stringify({
        project_id: 'p',
        events: [{ id: 'colossus', input: 'x'.repeat(SIZE_LIMIT * 3) }],
        spooled_at: Date.now() / 1000,
      }) + '\n',
    );

    await runHook(home, sizeUrl, 'flush');

    const dl = statePath(home, 'braintrust_spool.deadletter.jsonl');
    expect(existsSync(dl)).toBe(true);
    expect(readFileSync(dl, 'utf8')).toContain('colossus');
    // The whole point: it must NOT stay queued for retry.
    expect(spoolLines(home).length).toBe(0);
    expect(hookLog(home)).toMatch(/oversized single span/);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});

describe('encoding', () => {
  it('sends a payload containing a lone surrogate instead of losing the batch', async () => {
    const home = makeHome(okUrl);
    const before = received.events;
    // '\udc90' is the exact character class behind ~47 logged failures:
    // json.dumps accepts it, .encode('utf-8') does not, so the whole batch died.
    writeFileSync(
      statePath(home, 'braintrust_spool.jsonl'),
      JSON.stringify({
        project_id: 'p',
        events: [{ id: 'surr', input: 'before\\udc90after' }],
        spooled_at: Date.now() / 1000,
      }) + '\n',
    );

    const r = await runHook(home, okUrl, 'flush');

    expect(r.status).toBe(0);
    expect(received.events - before).toBe(1);
    expect(spoolLines(home).length).toBe(0);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});

/**
 * `stop` moving from SessionEnd (once per session) to Stop (once per TURN).
 * Scope and evidence: docs/hooks/braintrust-stop-event-scope.md.
 *
 * There is deliberately NO concurrent stop + user_prompt_submit test here.
 * Probe 3.1 established that the CLI does not fire UserPromptSubmit until every
 * Stop hook has returned, so such a test would assert against a fiction. What is
 * guarded instead is the change that makes the concurrency moot: stop no longer
 * writes current_turn_span_id at all.
 */
function readSession(home: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(home, '.claude', 'state', 'braintrust_sessions', `${sessionId}.json`), 'utf8'),
  );
}

function seedTurn(home: string, sessionId: string, turnSpanId: string, turnLastLine = 0) {
  writeFileSync(
    join(home, '.claude', 'state', 'braintrust_sessions', `${sessionId}.json`),
    JSON.stringify({
      root_span_id: sessionId,
      project_id: 'proj-test',
      turn_count: 1,
      current_turn_span_id: turnSpanId,
      turn_last_line: turnLastLine,
      started: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }),
  );
}

/** One turn's worth of transcript: a user message then an assistant reply. */
function turnLines(n: number): string[] {
  return [
    JSON.stringify({
      type: 'user',
      timestamp: `2026-08-11T00:0${n}:00Z`,
      message: { content: `prompt ${n}` },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: `2026-08-11T00:0${n}:01Z`,
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'text', text: `reply ${n}` }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ];
}

function writeTranscript(home: string, sessionId: string, turns: number): string {
  const dir = join(home, '.claude', 'projects', 'proj');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  for (let i = 1; i <= turns; i += 1) lines.push(...turnLines(i));
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const stopStdin = (sessionId: string, transcript: string) =>
  JSON.stringify({ session_id: sessionId, transcript_path: transcript });

describe('stop on the Stop event — per-turn finalization', () => {
  it('leaves current_turn_span_id alone so user_prompt_submit is its only writer', async () => {
    const home = makeHome(okUrl);
    const sid = 'sess-keep-key';
    seedTurn(home, sid, 'turn-A');
    const transcript = writeTranscript(home, sid, 1);

    const r = await runHook(home, okUrl, 'stop', stopStdin(sid, transcript));

    expect(r.status).toBe(0);
    // Pre-change this was cleared to ''. Clearing it is what made the key
    // two-writer, and stop's whole-dict rewrite would take every other key with
    // it on a collision.
    expect(readSession(home, sid).current_turn_span_id).toBe('turn-A');
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it('advances turn_last_line monotonically and re-sends nothing across turns', async () => {
    const home = makeHome(okUrl);
    const sid = 'sess-advance';
    seedTurn(home, sid, 'turn-1');

    const t1 = writeTranscript(home, sid, 1);
    await runHook(home, okUrl, 'stop', stopStdin(sid, t1));
    const afterTurn1 = readSession(home, sid).turn_last_line as number;

    // Turn 2 arrives: the transcript grows and user_prompt_submit hands stop a
    // new span id, exactly as it does in a live session.
    seedTurn(home, sid, 'turn-2', afterTurn1);
    const t2 = writeTranscript(home, sid, 2);
    const before = received.events;
    await runHook(home, okUrl, 'stop', stopStdin(sid, t2));
    const afterTurn2 = readSession(home, sid).turn_last_line as number;

    expect(afterTurn1).toBeGreaterThan(0);
    expect(afterTurn2).toBeGreaterThan(afterTurn1);
    // Turn 2 must cost one LLM span plus one turn-close merge. More than that
    // means it reprocessed turn 1's lines.
    expect(received.events - before).toBe(2);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it('does not re-finalize a turn when SessionEnd runs stop a second time', async () => {
    const home = makeHome(okUrl);
    const sid = 'sess-idempotent';
    seedTurn(home, sid, 'turn-only');
    const transcript = writeTranscript(home, sid, 1);

    await runHook(home, okUrl, 'stop', stopStdin(sid, transcript));
    const before = received.events;
    // stop stays registered on SessionEnd as a safety net for an abrupt exit, so
    // the last turn is always seen twice. Without the guard the second pass
    // merges a later metrics.end and stretches the turn's duration.
    const second = await runHook(home, okUrl, 'stop', stopStdin(sid, transcript));

    expect(second.status).toBe(0);
    expect(received.events - before).toBe(0);
    expect(hookLog(home)).toMatch(/already finalized/);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});
