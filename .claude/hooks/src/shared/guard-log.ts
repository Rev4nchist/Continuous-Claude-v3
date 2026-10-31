/**
 * Guard decision log.
 *
 * Every PreToolUse hook that can deny or ask appends ONE JSON line per deny, ask or override to
 * ~/.claude/logs/guard-decisions.jsonl:
 *
 *   {ts, hook, tool, decision: 'deny'|'ask'|'override'|'warn', reason, session_id, agent_id?, command?}
 *
 * 'override' = a guard let a command through because of an override (SKIP_DESTRUCTIVE_GUARD).
 * 'warn' = a guard rule in warn mode let a command through and recorded the rule that would have denied it (pre-pr-gate, PR B).
 * This log records the hooks this process runs.
 *
 * A crash line is different: {ts, hook, kind:'error', message, stack}. It has no `decision`. A guard writes it
 * (logGuardError) in the catch that turns a crash into its allow or deny output.
 *
 * Secrets: the log never holds a raw command. `reason` is a rule name, and `command` is at most
 * the first 80 characters of the command after obvious tokens are masked. The mask runs on the
 * whole command BEFORE the cut, so a token that straddles character 80 cannot leak its head.
 *
 * Tests: set CCV3_GUARD_DECISIONS_LOG to a temp file. Under VITEST with no override this logger
 * does nothing. A test or probe that spawns a BUILT hook runs without VITEST, so it must set
 * CCV3_GUARD_DECISIONS_LOG in the child env, or the hook writes to the real log.
 *
 * Fail-open: any logging error is swallowed. A log bug must never block a tool call.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type GuardDecisionKind = 'deny' | 'ask' | 'override' | 'warn';

/** The subset of a PreToolUse payload the log reads. */
export interface GuardInput {
  tool?: string;
  tool_name?: string;
  session_id?: string;
  agent_id?: string;
}

export const COMMAND_HEAD_CHARS = 80;
const REASON_CHARS = 200;

export function guardLogPath(env: NodeJS.ProcessEnv = process.env): string {
  // Home comes from the env it is given, so a caller (or a test) with its own HOME stays inside it.
  const home = env.USERPROFILE || env.HOME || homedir();
  return env.CCV3_GUARD_DECISIONS_LOG || join(home, '.claude', 'logs', 'guard-decisions.jsonl');
}

const SECRET_NAME = '[\\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie)[\\w.-]*';

/** Ordered: specific shapes first, the generic long-token catch last. */
const MASKS: Array<[RegExp, string]> = [
  // A URL inside quotes may hold a password with a space: the closing quote ends it, not the space.
  [/(["'])([a-z][\w+.-]*:\/\/)[^\s/@:"']+:(?:(?!\1)[^/@])+@/gi, '$1$2***@'],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@'],
  // `curl -u user:pass`, `curl --user user:pass`. A numeric user (`docker run -u 1000:1000`) is a uid:gid.
  // Quoting decides where the credential ends: `-u "user:two words"`, `-u user:"two words"`.
  [/(\s(?:-u[\s=]*|--user[\s=]+)")(?!\d+:)([^":]+):[^"]*"/g, '$1$2:***"'],
  [/(\s(?:-u[\s=]*|--user[\s=]+)')(?!\d+:)([^':]+):[^']*'/g, "$1$2:***'"],
  [/(\s(?:-u[\s=]*|--user[\s=]+))(?!\d+:)([^\s:"']+):(?:"[^"]*"|'[^']*'|[^\s"'])+/g, '$1$2:***'],
  // `mysql -uroot -pS3cret`: the password is glued to -p. Case matters: -P is the port.
  [/(\b(?:mysql|mariadb)\w*\b[^|;&\n]*?\s-p)(?:"[^"]*"|'[^']*'|[^\s"'])+/g, '$1***'],
  // `sshpass -p pw ssh host`
  [/(\bsshpass\s+-p\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/g, '$1***'],
  [/\b(Bearer|Basic|Token)\s+[^\s'"]+/gi, '$1 ***'],
  [new RegExp(`(${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s'"]+)`, 'gi'), '$1$2***'],
  [new RegExp(`(--?${SECRET_NAME})(\\s+)("[^"]*"|'[^']*'|[^\\s'"-][^\\s'"]*)`, 'gi'), '$1$2***'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  [/\bgithub_pat_\w+/g, '***'],
  [/\bxox[abprs]-[\w-]+/g, '***'],
  [/\bnpm_[A-Za-z0-9]{20,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bAIza[\w-]{30,}/g, '***'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***'],
  // Any other long opaque run that mixes letters and digits (hex, base64url keys).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g, '***'],
];

/** Replace obvious credentials with `***`. Pure. */
export function maskSecrets(text: string): string {
  return MASKS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

/** At most the first 80 characters of a command, tokens masked first. Pure. */
export function commandHead(command: string): string {
  return maskSecrets(command).replace(/\s+/g, ' ').trim().slice(0, COMMAND_HEAD_CHARS);
}

function shouldWrite(env: NodeJS.ProcessEnv): boolean {
  return !!env.CCV3_GUARD_DECISIONS_LOG || !env.VITEST;
}

/**
 * Append one decision line. `reason` is a short rule name; `opts.command` is the raw command (it
 * is masked and cut here, the caller does not have to).
 */
export function logGuardDecision(
  hook: string,
  input: GuardInput | null | undefined,
  decision: GuardDecisionKind,
  reason: string,
  opts: { command?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const env = opts.env ?? process.env;
  try {
    if (!shouldWrite(env)) return;
    const agent = input?.agent_id || env.CLAUDE_AGENT_ID || undefined;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      hook,
      tool: input?.tool_name || input?.tool || '',
      decision,
      reason: maskSecrets(String(reason)).replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS),
      session_id: input?.session_id || '',
    };
    if (agent) entry.agent_id = agent;
    if (typeof opts.command === 'string' && opts.command) entry.command = commandHead(opts.command);
    const path = guardLogPath(env);
    // Owner-only. The mode applies when the directory or file is created; Windows mostly ignores it.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* logging never blocks a tool call */ }
}

const ERROR_FIELD_CHARS = 200;

/** One line of text, secrets masked, cut to a safe length. Pure. */
function oneLine(text: string): string {
  return maskSecrets(text).replace(/\s+/g, ' ').trim().slice(0, ERROR_FIELD_CHARS);
}

/** The message of any thrown value, first line only. A value that is not an Error is turned into text. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : safeJson(err);
  return oneLine(String(raw).split(/\r?\n/)[0]);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** The first `at ...` line of the stack, or an empty string when the value has no stack. */
function firstFrame(err: unknown): string {
  const stack = err instanceof Error ? err.stack : undefined;
  const frame = typeof stack === 'string' ? stack.split(/\r?\n/).find((l) => /^\s*at\s/.test(l)) : undefined;
  return frame ? oneLine(frame) : '';
}

/**
 * Append one crash line: {ts, hook, kind:'error', message, stack}. A guard calls this in the catch
 * that turns a crash into allow (or deny), so a crashing guard is not the same as a guard that
 * allows. `message` is the first line of the error with secrets masked. `stack` is the first frame.
 * It has no `decision` field. Same file, same path rules and same test gate as logGuardDecision.
 * It never throws.
 */
export function logGuardError(hook: string, err: unknown, opts: { env?: NodeJS.ProcessEnv } = {}): void {
  try {
    const env = opts.env ?? process.env;
    if (!shouldWrite(env)) return;
    const entry = { ts: new Date().toISOString(), hook, kind: 'error', message: errorMessage(err), stack: firstFrame(err) };
    const path = guardLogPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* logging never blocks a tool call */ }
}
