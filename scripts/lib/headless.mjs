// Shared headless `claude -p` wrapper (main spec 13.6): one key strip, one ledger, one day cap.
// - The prompt goes on stdin (a long argv arrived empty for claude on Windows; trigger-probe.mjs:154).
// - ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are deleted from the child env, so the run bills the subscription.
// - No tools, one turn, strict empty MCP config, hooks off, never --bare, never Opus.
// - Ledger ~/.claude/state/headless-review-ledger.jsonl. 200 start rows per America/Chicago day, counted under withLock
//   (HEADLESS_DAILY_CAP; Dave, 2026-11-14: "cap 200 - at least"; it was 30).
//   The cap counts EVERY headless run in that ledger, whatever its purpose.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readLedger, runAgent } from '../github/cursor-review.mjs';
import { withLock } from '../github/lib/file-lock.mjs';

export const HEADLESS_DAILY_CAP = 200;
export const HEADLESS_LEDGER = path.join(os.homedir(), '.claude', 'state', 'headless-review-ledger.jsonl');
export const defaultHeadlessLedger = (env = process.env) => env.CCV3_HEADLESS_LEDGER || HEADLESS_LEDGER;

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The America/Chicago calendar day of a time, as YYYY-MM-DD. Never an offset: the zone database handles the November change. */
export function chicagoDay(ms) {
  return DAY_FORMAT.format(new Date(ms));
}

/** A copy of the env without the Anthropic credentials. */
export function childEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export const readHeadlessLedger = (file) => readLedger(file);

/** The start rows of one Chicago day, any purpose. The day comes from ts, so a row with no `day` field still counts. */
export function countDay(entries, ms) {
  const day = chicagoDay(ms);
  const ids = new Set();
  let anon = 0;
  for (const e of entries) {
    if (e.phase !== 'start') continue;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t) || chicagoDay(t) === day) ids.add(e.id ?? `anon-${anon++}`); // an unreadable time counts: the cap errs safe
  }
  return ids.size;
}

/** { ok: true, id, count } or { ok: false, reason: 'cap' | 'lock', count? }. Counts, then appends the start row, under a lock. */
export function reserveHeadless(file, entry, { now = Date.now, cap = HEADLESS_DAILY_CAP, ...lockOpts } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, lockOpts, () => {
    const t = now();
    const used = countDay(readLedger(file).entries, t);
    if (used >= cap) return { ok: false, reason: 'cap', count: used };
    const id = randomUUID();
    const row = { ts: new Date(t).toISOString(), day: chicagoDay(t), phase: 'start', id, purpose: entry.purpose ?? null, model: entry.model ?? null, sessionId: entry.sessionId ?? null };
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return { ok: true, id, count: used + 1 };
  });
}

export function finishHeadless(file, id, patch, { now = Date.now } = {}) {
  appendFileSync(file, `${JSON.stringify({ ts: new Date(now()).toISOString(), phase: 'end', id, ...patch })}\n`);
}

const fwd = (p) => p.replace(/\\/g, '/');

/** The claude argv. The prompt is NOT in it. */
export function buildArgs({ model = 'sonnet', effort = 'high', mcpConfig, settings } = {}) {
  const args = ['-p', '--output-format', 'json', '--tools', '', '--max-turns', '1', '--strict-mcp-config'];
  if (mcpConfig) args.push('--mcp-config', fwd(mcpConfig));
  if (settings) args.push('--settings', fwd(settings));
  args.push('--no-session-persistence', '--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

// The claude exe and the two config files come from trigger-probe.mjs, loaded on demand (it is a CLI script with a main guard).
async function realClaude() {
  const probe = await import('../skills/trigger-probe.mjs');
  return { command: probe.resolveClaude(), mcpConfig: probe.emptyMcpConfigPath(), settings: probe.noHooksSettingsPath() };
}

/** The result line of `--output-format json`: { result, costUsd, usage } or nulls. */
export function readResult(stdout) {
  for (const l of String(stdout ?? '').split(/\r?\n/).reverse()) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object' && o.type === 'result') return { result: typeof o.result === 'string' ? o.result : null, costUsd: o.total_cost_usd ?? o.cost_usd ?? null, usage: o.usage ?? null, isError: o.is_error === true };
    } catch { /* not a JSON line */ }
  }
  return { result: null, costUsd: null, usage: null, isError: false };
}

/**
 * One headless run. deps (tests and E2E): { ledgerPath, cap, now, command, prefixArgs, spawnFn, env, cwd, sessionId, skipConfigFiles, agentDeps }.
 * Returns { ok, id, exit, stdout, stderr, result, costUsd, usage, timedOut, durationMs } or { ok: false, reason: 'cap' | 'lock' | 'no-claude' }.
 * It never throws for a failed run.
 */
export async function runClaude({ prompt, model = 'sonnet', timeoutMs = 180_000, purpose = 'headless', effort = 'high' }, deps = {}) {
  const ledgerPath = deps.ledgerPath ?? defaultHeadlessLedger();
  const now = deps.now ?? Date.now;
  const sessionId = deps.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
  const reserved = reserveHeadless(ledgerPath, { purpose, model, sessionId }, { now, cap: deps.cap ?? HEADLESS_DAILY_CAP });
  if (!reserved.ok) return { ok: false, reason: reserved.reason, count: reserved.count, detail: reserved.detail };

  let command = deps.command;
  let mcpConfig;
  let settings;
  try {
    if (deps.skipConfigFiles) {
      mcpConfig = 'empty-mcp.json';
      settings = 'no-hooks.json';
    } else if (!command) {
      ({ command, mcpConfig, settings } = await realClaude());
    } else {
      const probe = await import('../skills/trigger-probe.mjs');
      mcpConfig = probe.emptyMcpConfigPath();
      settings = probe.noHooksSettingsPath();
    }
  } catch (err) {
    finishHeadless(ledgerPath, reserved.id, { exit: null, error: String(err.message).slice(0, 300), keyStripped: true }, { now });
    return { ok: false, reason: 'no-claude', id: reserved.id, error: String(err.message) };
  }

  const args = [...(deps.prefixArgs ?? []), ...buildArgs({ model, effort, mcpConfig, settings })];
  // A temp cwd: no repo CLAUDE.md or settings load. It is removed after the run; a cwd the caller passed in is the caller's to remove.
  const ownCwd = deps.cwd == null;
  const cwd = ownCwd ? mkdtempSync(path.join(os.tmpdir(), 'headless-run-')) : deps.cwd;
  const spawnFn = deps.spawnFn ?? spawn;
  const withStdin = (cmd, a, opts) => {
    const child = spawnFn(cmd, a, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin?.on?.('error', () => {}); // the child may exit before it reads
    child.stdin?.end?.(prompt);
    return child;
  };
  let run;
  try {
    run = await runAgent({ command, args, cwd, timeoutMs, env: childEnv(deps.env ?? process.env) }, { spawnFn: withStdin, ...(deps.agentDeps ?? {}) });
  } finally {
    // A child that outlives a kill can still hold the folder on Windows (EBUSY): a failed removal must not turn the result into a throw.
    if (ownCwd) try { rmSync(cwd, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for the OS temp cleanup */ }
  }
  const parsed = readResult(run.stdout);
  const ok = run.status === 0 && !run.timedOut && !run.error && parsed.result !== null && !parsed.isError;
  finishHeadless(ledgerPath, reserved.id, {
    exit: run.status, durationMs: run.durationMs ?? null, timedOut: Boolean(run.timedOut), costUsd: parsed.costUsd, usage: parsed.usage, keyStripped: true,
    ...(run.error ? { error: String(run.error).slice(0, 300) } : {}),
  }, { now });
  return { ok, id: reserved.id, exit: run.status, stdout: run.stdout, stderr: run.stderr, result: parsed.result, costUsd: parsed.costUsd, usage: parsed.usage, timedOut: Boolean(run.timedOut), durationMs: run.durationMs, error: run.error };
}

// The served model that a run for each requested alias must report. The alias 'opus' is not version-pinned, so an older Opus is a fault.
const SERVED = { opus: /^claude-opus-5-5\b/, sonnet: /^claude-sonnet-/ };

/** The model names in the modelUsage of the claude -p result line, joined by comma; null when there is none. */
export function servedModelOf(stdout) {
  for (const l of String(stdout ?? '').split(/\r?\n/).reverse()) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === 'object' && o.type === 'result') {
        const names = o.modelUsage && typeof o.modelUsage === 'object' ? Object.keys(o.modelUsage) : [];
        return names.length ? names.join(',') : null;
      }
    } catch { /* not the result line */ }
  }
  return null;
}

/** Every served model name matches the requested model (a run can report a helper model too: then all must match). */
export function servedMatches(model, served) {
  if (!served) return false;
  return served.split(',').every((n) => SERVED[model].test(n));
}

/**
 * The judge call: Opus at effort high (Dave 2026-11-13), purpose eval-judge. The prompt carries the whole job; no tools run.
 * The prompt stays v0 (judge.mjs judgePrompt): prompt v1 is measured only on the label pre-check pair type.
 * A finished run whose served model is not Opus 5.5 (or is not reported) is an error result, reason 'served-model'. There is no retry.
 */
export async function runJudge(prompt, { timeoutMs = 180_000, ...deps } = {}) {
  const res = await runClaude({ prompt, model: 'opus', effort: 'high', timeoutMs, purpose: 'eval-judge' }, deps);
  const servedModel = servedModelOf(res.stdout);
  // A failed run that still names another model is a served-model fault; a failed run with no model (cap, timeout) stays as it is.
  if (!res.ok) return servedModel && !servedMatches('opus', servedModel) ? { ...res, reason: 'served-model', servedModel } : res;
  return servedMatches('opus', servedModel) ? { ...res, servedModel } : { ...res, ok: false, reason: 'served-model', servedModel };
}
