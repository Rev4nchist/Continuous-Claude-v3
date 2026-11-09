/**
 * Guard decision log.
 *
 * Every PreToolUse hook that can deny or ask appends ONE JSON line per deny, ask or override to
 * ~/.claude/logs/guard-decisions.jsonl:
 *
 *   {ts, hook, tool, decision: 'deny'|'ask'|'override'|'warn'|'inject'|'allow', reason, session_id, agent, source,
 *    agent_id?, cwd?, permission_mode?, target?, command?}
 *
 * `source` is 'live', 'test' or 'probe' (see guardSource). The harness doctor ignores a row whose source is 'test' or 'probe'.
 *
 * `agent` is true when the payload has agent_id or CLAUDE_AGENT_ID is set. `cwd` and `permission_mode` come from
 * the payload: they decide a guard's result, so a replay needs them. `target` is the thing a non-command tool acts
 * on: file_path (Read, Edit, Write), subagent_type (Agent), skill (Skill). `cwd` and a file_path `target` are paths:
 * they are masked, then cut at 300 characters (mask first, so a token across the cut leaks no head). A skill or
 * agent name is cut but not masked. Hyphenated folder names are kept. A standalone UUID path segment, with or
 * without an extension, is kept, because a replay needs it. A secret-shaped folder or NAME=value
 * segment is written as `***`. This stores more than the 80-character command did. The file is owner-only (0o600).
 * 'inject' = a hook blocked the call to inject context (tldr-read-enforcer): not a denial of a bad action.
 * 'override' = a guard let a command through because of an override (SKIP_DESTRUCTIVE_GUARD). Count these for SKIP uses.
 * 'allow' = a guard let a command through under a built-in allow rule (destructive-command-guard scoped cleanup,
 * reason 'scoped-cleanup:scratchpad' or ':worktree'). It is not a bypass, so it is not an 'override'.
 * 'warn' = a guard rule in warn mode let a command through and recorded the rule that would have denied it (pre-pr-gate, PR B).
 * This log records the hooks this process runs.
 *
 * A crash line is different: {ts, hook, kind:'error', message, stack, source}. It has no `decision`. A guard writes it
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

export type GuardDecisionKind = 'deny' | 'ask' | 'override' | 'warn' | 'inject' | 'allow';

/** The subset of a PreToolUse payload the log reads. */
export interface GuardInput {
  tool?: string;
  tool_name?: string;
  session_id?: string;
  agent_id?: string;
  cwd?: string;
  permission_mode?: string;
  /** file_path (Read, Edit, Write), subagent_type (Agent), skill (Skill). Set it, or leave it to be read from tool_input. */
  target?: string;
  tool_input?: unknown;
}

export const COMMAND_HEAD_CHARS = 80;
const REASON_CHARS = 200;
const PATH_CHARS = 300;

/** The tool_input field that names the target, per tool. A tool not listed has no target. */
const TARGET_FIELD: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Agent: 'subagent_type',
  Task: 'subagent_type',
  Skill: 'skill',
};

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

/**
 * False under VITEST with no CCV3_GUARD_DECISIONS_LOG: a test must never write the real log.
 * VITEST set to an empty string counts as set. A test that clears it with `VITEST: ''` still has the marker.
 */
export function shouldWrite(env: NodeJS.ProcessEnv): boolean {
  return !!env.CCV3_GUARD_DECISIONS_LOG || !Object.hasOwn(env, 'VITEST');
}

/**
 * Where a row came from: 'test' (VITEST is set), 'probe' (a log path override and no VITEST), else 'live'.
 * CCV3_GUARD_SOURCE may name 'test' or 'probe' when a caller knows better. Any other value is ignored.
 * The harness doctor counts a row with any other source, or none, as a fault.
 */
export function guardSource(env: NodeJS.ProcessEnv): string {
  const named = env.CCV3_GUARD_SOURCE;
  if (named === 'test' || named === 'probe') return named;
  if (Object.hasOwn(env, 'VITEST')) return 'test';
  return env.CCV3_GUARD_DECISIONS_LOG ? 'probe' : 'live';
}

/** A non-empty string cut to `max` characters, or undefined. Not masked: use it for short enums such as permission_mode, and for skill and agent names. */
function pathText(value: unknown, max = PATH_CHARS): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

// A UUID that is a whole path segment, or a segment plus an extension (session scratchpad folders,
// `<uuid>.jsonl` transcripts). The long-run mask would erase it.
const UUID_SEGMENT = /(^|[\\/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\\/.])/gi;
// Private-use characters carry the index of a shielded UUID through the mask. Written as escapes on purpose.
const MARK_OPEN = String.fromCharCode(0xe000);
const MARK_CLOSE = String.fromCharCode(0xe001);
const UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, 'g');

// A path keeps its hyphenated names: a kebab-case worktree folder of 32+ characters is not a secret.
// The generic long-run rule (the last MASKS entry) is swapped for one that has no hyphen.
const PATH_MASKS: Array<[RegExp, string]> = [
  ...MASKS.slice(0, -1),
  [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, '***'],
];

/**
 * A path with secrets masked, then cut to `max` characters. Mask first: a token that straddles the cut
 * cannot leak its head. A standalone UUID path segment is kept, because a replay needs it.
 * A 32+ character hex or alphanumeric segment, such as a git SHA, is masked. Pure.
 */
function maskedPath(value: unknown, max = PATH_CHARS): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const kept: string[] = [];
  const shielded = value.replace(UUID_SEGMENT, (_m, sep: string, uuid: string) => {
    kept.push(uuid);
    return `${sep}${MARK_OPEN}${kept.length - 1}${MARK_CLOSE}`;
  });
  const masked = PATH_MASKS.reduce((acc, [re, to]) => acc.replace(re, to), shielded);
  return masked.replace(UUID_MARK, (m, i: string) => kept[Number(i)] ?? m).slice(0, max);
}

/** The explicit `target`, else the tool_input field that names the target of this tool. */
function targetOf(input: GuardInput | null | undefined, tool: string): string | undefined {
  const explicit = maskedPath(input?.target);
  if (explicit) return explicit;
  const field = Object.hasOwn(TARGET_FIELD, tool) ? TARGET_FIELD[tool] : undefined;
  const toolInput = input?.tool_input;
  if (!field || typeof toolInput !== 'object' || toolInput === null) return undefined;
  const raw = (toolInput as Record<string, unknown>)[field];
  // A file path is masked. A skill or agent name is not a path: `auth-tools:login` must stay readable.
  return field === 'file_path' ? maskedPath(raw) : pathText(raw);
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
    const tool = input?.tool_name || input?.tool || '';
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      hook,
      tool,
      decision,
      reason: maskSecrets(String(reason)).replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS),
      session_id: input?.session_id || '',
      agent: !!agent,
      source: guardSource(env),
    };
    if (agent) entry.agent_id = agent;
    const cwd = maskedPath(input?.cwd);
    if (cwd) entry.cwd = cwd;
    const mode = pathText(input?.permission_mode, 40);
    if (mode) entry.permission_mode = mode;
    const target = targetOf(input, tool);
    if (target) entry.target = target;
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
    const entry = { ts: new Date().toISOString(), hook, kind: 'error', message: errorMessage(err), stack: firstFrame(err), source: guardSource(env) };
    const path = guardLogPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* logging never blocks a tool call */ }
}
