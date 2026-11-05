// Match claude.exe processes to lane board sessions by start time (lane lane-pid-session-match).
//
// The sessions table holds no pid, and the identity files hold none either. A claude.exe process and its session start
// within a few seconds of each other, so the join is: process start time vs sessions.started_at.
// sessions.started_at is `timestamp without time zone` and holds UTC. Read it with extract(epoch ...), never as a JS Date:
// node-pg parses a naive timestamp as local time and shifts it by the machine's offset.
//
// A resumed session keeps its old started_at but runs in a new process, so the start-time join misses it. The SessionStart hook
// therefore writes CLAUDE_PID (set by Claude Code, the claude.exe pid) into the identity file on every start, resume included.
// The board joins on that pid first and on start time second.
// Windows only for the process list. Elsewhere listClaudeProcesses() returns null, and callers print nothing.
import { spawnSync } from 'node:child_process';
import { listIdentities } from './session-label.mjs';

/** A process and a session count as the same when their start times are within this many ms. Measured gap on 5 live pairs: under 3 s. */
export const MATCH_TOLERANCE_MS = 10_000;

/**
 * An identity file is written by SessionStart, after the process exists. One written more than this long before the process
 * started belongs to an older process that had the same pid (Windows reuses pids). The slack covers clock rounding.
 */
export const IDENTITY_SKEW_MS = 2_000;

/** Sessions not ended, seen inside this window. Older unended rows are crash leftovers, not live processes. */
export const SESSION_WINDOW_HOURS = 48;

/**
 * Two passes. Pass 1, by pid: a live session whose identity file names the process pid, written no earlier than the process
 * started. Pass 2, by start time, for what is left: every (process, session) pair inside the tolerance is a candidate; the
 * smallest gap is taken first, so two processes near one session give the session to the closer one.
 * @param {{pid:number,startMs:number}[]} procs
 * @param {{id:string,startMs:number}[]} sessions live sessions only (an ended session never matches)
 * @param {{toleranceMs?:number, identities?:{id:string,pid:number,updatedMs:number}[]}} [opts]
 */
export function matchProcesses(procs, sessions, { toleranceMs = MATCH_TOLERANCE_MS, identities = [] } = {}) {
  const usedPids = new Set();
  const usedIds = new Set();
  const matched = [];
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const take = (pid, id, gapMs, by) => {
    usedPids.add(pid);
    usedIds.add(id);
    matched.push({ pid, id, gapMs, by });
  };

  // Newest identity first: two live sessions that claim one pid give it to the newer file.
  const claims = [...identities].sort((x, y) => y.updatedMs - x.updatedMs);
  for (const p of procs) {
    const c = claims.find((i) => i.pid === p.pid && i.updatedMs >= p.startMs - IDENTITY_SKEW_MS && sessionById.has(i.id) && !usedIds.has(i.id));
    if (c) take(p.pid, c.id, Math.abs(p.startMs - sessionById.get(c.id).startMs), 'pid');
  }

  const pairs = [];
  for (const p of procs) {
    if (usedPids.has(p.pid)) continue;
    for (const s of sessions) {
      if (usedIds.has(s.id)) continue;
      const gapMs = Math.abs(p.startMs - s.startMs);
      if (gapMs <= toleranceMs) pairs.push({ pid: p.pid, id: s.id, gapMs });
    }
  }
  pairs.sort((x, y) => x.gapMs - y.gapMs || x.pid - y.pid);
  for (const pr of pairs) {
    if (usedPids.has(pr.pid) || usedIds.has(pr.id)) continue;
    take(pr.pid, pr.id, pr.gapMs, 'start');
  }
  matched.sort((x, y) => x.pid - y.pid);
  return {
    matched,
    unmatchedProcs: procs.filter((p) => !usedPids.has(p.pid)),
    unmatchedSessions: sessions.filter((s) => !usedIds.has(s.id)),
  };
}

/**
 * Rows for the pid join from the identity files (session-label.mjs listIdentities: a Map keyed by uuid).
 * Keeps a file with an integer pid above 0 and a readable updatedAt. Older files have no pid and drop out.
 * @returns {{id:string,pid:number,updatedMs:number}[]}
 */
export function identityPids(identities) {
  const out = [];
  for (const [id, v] of identities) {
    const updatedMs = Date.parse(v?.updatedAt);
    if (Number.isSafeInteger(v?.pid) && v.pid > 0 && Number.isFinite(updatedMs)) out.push({ id, pid: v.pid, updatedMs });
  }
  return out;
}

/** @returns {{total:number, matched:number, unmatchedPids:number[]}} */
export function summarize(result) {
  return {
    total: result.matched.length + result.unmatchedProcs.length,
    matched: result.matched.length,
    unmatchedPids: result.unmatchedProcs.map((p) => p.pid),
  };
}

/**
 * Parse `ConvertTo-Json` output of rows {pid, startMs}. PowerShell prints one object (not an array) for a single row and
 * nothing for none. Returns [] for no processes and null when the text is not JSON or holds no usable row (unknown, not "zero").
 */
export function parseProcessList(text) {
  const t = String(text ?? '').trim();
  if (t === '') return [];
  let v;
  try { v = JSON.parse(t); } catch { return null; }
  const rows = Array.isArray(v) ? v : [v];
  const good = rows
    .filter((r) => r && Number.isInteger(r.pid) && Number.isFinite(r.startMs))
    .map((r) => ({ pid: r.pid, startMs: r.startMs }));
  // Rows came back but none are usable (an error object, a changed shape): unknown, not "zero processes".
  return rows.length > 0 && good.length === 0 ? null : good;
}

// Get-Process, not Get-CimInstance: same data, and the whole call is about 0.3 s instead of 1.3 s.
// -Name claude matches claude.exe in any case, so a Claude desktop app process would show up as an unmatched pid.
const PS_LIST =
  'Get-Process -Name claude -ErrorAction SilentlyContinue | ' +
  'ForEach-Object { [pscustomobject]@{ pid = $_.Id; startMs = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } } | ' +
  "ConvertTo-Json -Compress";

/**
 * claude.exe processes on this machine, or null when they cannot be listed (not Windows, PowerShell missing or slow).
 * LANE_CLAUDE_PROCESSES (JSON rows) replaces the real list. The tests use it; no real process list reaches them.
 */
export function listClaudeProcesses() {
  const override = process.env.LANE_CLAUDE_PROCESSES;
  if (override !== undefined) return parseProcessList(override);
  if (process.platform !== 'win32') return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000,
  });
  if (r.error || r.status !== 0) return null;
  return parseProcessList(r.stdout);
}

/**
 * Live sessions of every board: not ended, seen inside SESSION_WINDOW_HOURS. "Ended" is the same rule as the quiet count:
 * ended_at at or after the latest signal.
 * @param {{query:(sql:string)=>Promise<{rows:{id:string,ms:string|number}[]}>}} c a connected pg client
 */
export async function liveSessions(c) {
  const { rows } = await c.query(
    `SELECT s.id, (extract(epoch FROM s.started_at) * 1000)::float8 AS ms
       FROM sessions s
      WHERE NOT COALESCE(s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)), false)
        AND s.last_heartbeat > now() - interval '${SESSION_WINDOW_HOURS} hours'`,
  );
  return rows.map((r) => ({ id: r.id, startMs: Number(r.ms) }));
}

/** @returns {Promise<{total:number, matched:number, unmatchedPids:number[]}|null>} null when the process list is unknown. */
export async function processMatchSummary(c) {
  const procs = listClaudeProcesses();
  if (procs === null) return null;
  return summarize(matchProcesses(procs, await liveSessions(c), { identities: identityPids(listIdentities()) }));
}
