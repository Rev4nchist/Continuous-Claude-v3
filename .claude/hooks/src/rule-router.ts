#!/usr/bin/env node
/**
 * rule-router -- PreToolUse hook (matcher: Bash|PowerShell|Task|Agent|Skill|mcp__Neon__.*|mcp__linear__.*|mcp__claude_ai_Linear__.*|mcp__sentry__.*|mcp__playwright__.*|mcp__claude-in-chrome__.*|WebFetch|WebSearch).
 *
 * Loads a tool-specific rule at the moment it applies, instead of keeping it in every session's
 * always-loaded context (phase 2 of docs/self-improvement/proposals/2026-09-24-context-loading.md).
 * The rules live in ~/.claude/rules-ondemand/ with a manifest.json that says which tool call
 * loads which rule. The always-loaded index is rules/on-demand-rules.md.
 *
 * Per matched rule, once per session (and per subagent):
 *   - mode 'deny-first': refuse the call, with the rule text as the reason. The model re-plans
 *     with the rule in view and re-issues the call if it still fits. Used for rules that must
 *     change the DECISION (confirm-first runs of Grok and of CMA, commit and PR text), because
 *     context injected at PreToolUse arrives after the command was already chosen.
 *     The block happens once per SESSION. A subagent is a fresh context and still needs the rule
 *     text, but once the session has had the block, a subagent gets the rule as additionalContext
 *     instead of a second block (about 302 of 339 denies were such repeats). The main thread
 *     always keeps its own block-once. A gate rule (manifest `"subagent": "block"`: the grok gate and the cma gate,
 *     kie-spend, browser-deprecated) is exempt: each fresh subagent is blocked once for it.
 *   - mode 'inject': add the rule text as additionalContext and let the call run.
 *
 * Also registered on SessionStart (matcher compact|clear): it removes the main agent's markers so
 * every rule fires again once the summary has dropped its text (logged as kind 'rearm').
 *
 * Every fire is appended to ~/.claude/logs/rule-router.jsonl, so false fires can be audited.
 * Fails open: any error emits "continue" and the call runs.
 */

import { readFileSync, readdirSync, appendFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname } from 'path';
import { outputContinue, outputDeny } from './shared/output.js';
import { logGuardDecision } from './shared/guard-log.js';
import { stripQuotedStrings, parseExecutable, extractShellWrapperPayloads } from './shared/destructive-classifier.js';

export interface RuleEntry {
  id: string;
  files: string[];
  mode: 'deny-first' | 'inject';
  /** 'block': a gate (spend, confirm-first). Every fresh subagent is blocked once, never downgraded to an inject. */
  subagent?: 'block';
  command?: string[];
  segment?: string[];
  agent?: string[];
  skill?: string[];
  tools?: string[];
}

export interface Manifest { rules: RuleEntry[] }

export interface HookInput {
  session_id?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  hook_event_name?: string;
  source?: string;
}

/** SessionStart sources after which the main context no longer holds the rule texts it was shown. */
const REARM_SOURCES = new Set(['compact', 'clear']);

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);

export function rulesDir(): string {
  return process.env.CLAUDE_RULES_ONDEMAND_DIR || join(homedir(), '.claude', 'rules-ondemand');
}

/**
 * Split a command at separators OUTSIDE quotes (`;`, `|`, `&`, newline, so also `&&` and `||`).
 * Quotes are kept, so a quoted path stays visible to `segment` matchers, while a separator inside
 * a quoted string never starts a segment.
 */
export function splitUnquoted(command: string, tool: string): string[] {
  const escape = tool === 'PowerShell' ? '`' : '\\';
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === escape && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === escape && i + 1 < command.length) { cur += c + command[++i]; continue; }
    // A `#` that starts a word begins a comment (Bash and PowerShell): nothing up to the newline
    // runs, so it must not become a segment. A `#` inside a word (a URL fragment) is not a comment.
    if (c === '#' && (cur === '' || /\s$/.test(cur))) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Drop what runs a command without being it: leading `&`, `cmd /c`, `env -u X`, `VAR=x`, `sudo`, `npx`. */
function stripLeaders(segment: string): string {
  let s = segment.trim();
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^&\s*/, '')
      .replace(/^cmd(\.exe)?\s+\/[cC]\s+/, '')
      .replace(/^env(\s+-u\s+\S+|\s+-i)*\s+/, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
      .replace(/^(sudo|time|npx(\s+-y)?)\s+/, '')
      .trim();
  } while (s !== prev);
  return s;
}

/**
 * The executed segments of a command, quotes kept. Also the segments of what the command runs
 * INSIDE itself: command substitutions (`$(...)`, backticks outside single quotes) and shell-wrapper
 * payloads (`bash -c "..."`, `powershell -Command "..."`), so a paid call cannot hide in them.
 * Uses the destructive guard's parsers; depth-bounded; a parser error only drops the nested part.
 */
export function quotedSegments(command: string, tool: string, depth = 0): string[] {
  const top = splitUnquoted(command, tool).map(stripLeaders).filter(Boolean);
  if (depth >= 3) return top;
  let nested: string[] = [];
  try {
    nested = [...parseExecutable(command).substitutions, ...extractShellWrapperPayloads(command)];
  } catch { /* keep the top-level segments */ }
  return [...top, ...nested.flatMap((n) => quotedSegments(n, tool, depth + 1))];
}

/** The executed segments of a command with quoted strings removed. */
export function commandSegments(command: string, tool: string): string[] {
  return quotedSegments(command, tool).map((s) => stripLeaders(stripQuotedStrings(s, tool))).filter(Boolean);
}

const test = (patterns: string[] | undefined, value: string): boolean =>
  !!patterns && patterns.some((p) => new RegExp(p).test(value));

/**
 * The manifest entries this tool call matches, in manifest order. `command` regexes see each
 * segment without its quoted strings; `segment` regexes see it with quotes kept (for a quoted
 * script path). Both are anchored to an EXECUTED segment, never to text an `echo` prints: a
 * mention must not claim a once-per-session rule before the real call.
 */
export function matchRules(input: HookInput, manifest: Manifest): RuleEntry[] {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  return manifest.rules.filter((r) => {
    if (COMMAND_TOOLS.has(tool)) {
      const command = typeof ti.command === 'string' ? ti.command : '';
      if (!command) return false;
      return commandSegments(command, tool).some((seg) => test(r.command, seg))
        || quotedSegments(command, tool).some((seg) => test(r.segment, seg));
    }
    if (AGENT_TOOLS.has(tool)) return test(r.agent, String(ti.subagent_type || ''));
    if (tool === 'Skill') return test(r.skill, String(ti.skill || ''));
    return test(r.tools, tool);
  });
}

/** One folder per session and agent; one marker file per rule already shown there. */
function stateDir(input: HookInput): string {
  const key = `${input.session_id || 'no-session'}-${input.agent_id || process.env.CLAUDE_AGENT_ID || 'main'}`;
  return join(process.env.CLAUDE_RULE_ROUTER_STATE_DIR || tmpdir(), `rule-router-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`);
}

/** One folder per session: a marker per deny-first rule whose block this session has had. */
function blockedDir(input: HookInput): string {
  const key = (input.session_id || 'no-session').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(process.env.CLAUDE_RULE_ROUTER_STATE_DIR || tmpdir(), `rule-router-blocked-${key}`);
}

/** A call from a subagent: the payload names an agent, or the process runs inside one. */
function isSubagent(input: HookInput): boolean {
  return !!(input.agent_id || process.env.CLAUDE_AGENT_ID);
}

/**
 * Atomically claim a rule for this session: the 'wx' flag creates the marker only if it does not
 * exist, so when parallel tool calls race, exactly one of them emits the rule.
 */
function claim(dir: string, id: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(join(dir, id), 'wx'));
    return true;
  } catch {
    return false;
  }
}

function ruleText(entry: RuleEntry, dir: string): string {
  return entry.files
    .map((f) => `----- ~/.claude/rules-ondemand/${f} -----\n${readFileSync(join(dir, f), 'utf8').trim()}`)
    .join('\n\n');
}

export interface Decision { kind: 'none' | 'deny' | 'inject' | 'rearm'; ids: string[]; text: string }

/**
 * The session that sees a rule fire is the best judge of whether it applies. When it does not,
 * this line lets the session record the false fire at once; the weekly review judges the rest.
 */
function falseFireFooter(ids: string[]): string {
  const script = join(process.env.CCV3_REPO || join(homedir(), 'continuous-claude'), 'scripts', 'rules', 'rule-router-false-fires.mjs')
    .replace(/\\/g, '/');
  return `\n\n----- If a rule above is NOT about this call -----\nRecord the false fire, then carry on: ` +
    `\`node ${script} add --rule <${ids.join('|')}> --what "<first words of the call>" --note "<why it does not apply>" --source agent\``;
}

/** What to emit for the unseen matches. A deny-first match turns the whole emission into a deny. */
export function decide(matched: RuleEntry[], seen: string[], dir: string): Decision {
  const fresh = matched.filter((r) => !seen.includes(r.id));
  if (fresh.length === 0) return { kind: 'none', ids: [], text: '' };
  const ids = fresh.map((r) => r.id);
  const body = fresh.map((r) => ruleText(r, dir)).join('\n\n') + falseFireFooter(ids);
  if (fresh.some((r) => r.mode === 'deny-first')) {
    return {
      kind: 'deny',
      ids,
      text:
        `[rule-router] Read the rule below before this call runs (${ids.join(', ')}). It blocks once per ` +
        `session per rule. If the call still fits the rule, re-issue it unchanged; otherwise change course ` +
        `(for a confirm-first action, ask Dave first).\n\n${body}`,
    };
  }
  return { kind: 'inject', ids, text: `[rule-router] On-demand rule for this call (${ids.join(', ')}):\n\n${body}` };
}

/**
 * The words that fired: for a command, the first two words of the segment that matched one of the
 * fired rules (quoted strings removed), so an audit can judge each fire. Never the raw command,
 * whose arguments can hold a credential. For other tools: the agent type, skill or tool name.
 */
export function triggerWords(input: HookInput, fired: RuleEntry[]): string {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  if (!COMMAND_TOOLS.has(tool)) return String(ti.subagent_type ?? ti.skill ?? tool).slice(0, 60);
  const segs = quotedSegments(String(ti.command ?? ''), tool);
  const plain = (seg: string) => stripLeaders(stripQuotedStrings(seg, tool));
  const hit = segs.find((seg) => fired.some((r) => test(r.command, plain(seg)) || test(r.segment, seg)));
  const seg = hit ?? segs[0] ?? '';
  const [cmd = '', arg] = plain(seg).split(/\s+/);
  // The second word stays only when it is a plain word or flag (`commit`, `-File`, `exec`). A URL,
  // a path or anything with `:`, `@` or `=` can carry a credential (psql postgresql://user:pass@...).
  const words = arg === undefined ? cmd : `${cmd} ${/^[-\w.]+$/.test(arg) ? arg : '<arg>'}`;
  // The script's file name, never its folder: `pwsh -File land-pr.ps1` says what ran, `pwsh -File` does not.
  const script = /(?:^|[\s"'\\/])([\w.-]+\.(?:ps1|mjs|cjs|js|py|sh|bat))(?=["'\s]|$)/i.exec(seg)?.[1];
  return script && !words.includes(script) ? `${words} ${script}` : words;
}

function logFire(input: HookInput, d: Decision, fired: RuleEntry[], extra: Record<string, unknown> = {}): void {
  try {
    const path = process.env.CLAUDE_RULE_ROUTER_LOG || join(homedir(), '.claude', 'logs', 'rule-router.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    const what = d.kind === 'rearm' ? `SessionStart ${input.source}` : triggerWords(input, fired);
    appendFileSync(path, JSON.stringify({
      // The same session and agent identity the claim markers use, so the audit's dedupe key matches.
      ts: new Date().toISOString(), session: input.session_id || 'no-session',
      agent: input.agent_id || process.env.CLAUDE_AGENT_ID || 'main',
      tool: input.tool_name, rules: d.ids, kind: d.kind, what, ...extra,
    }) + '\n');
  } catch { /* logging never blocks a tool call */ }
}

/**
 * After /compact or /clear the summary no longer holds the rule texts, but the markers still say
 * "shown", so the rules would never fire again this session. Remove the MAIN agent's markers only:
 * a subagent's context is not compacted with the main one. Returns how many markers were removed.
 */
export function rearm(input: HookInput): number {
  const dir = stateDir({ session_id: input.session_id });
  let ids: string[];
  try { ids = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const id of ids) {
    try { unlinkSync(join(dir, id)); removed++; } catch { /* a racing re-claim keeps its marker */ }
  }
  return removed;
}

function onSessionStart(input: HookInput): void {
  if (REARM_SOURCES.has(input.source || '')) {
    const removed = rearm(input);
    logFire(input, { kind: 'rearm', ids: [], text: '' }, [], { source: input.source, removed });
  }
  console.log('{}');
}

export function run(raw: string): void {
  let input: HookInput;
  try { input = JSON.parse(raw); } catch { outputContinue(); return; }
  if (input.hook_event_name === 'SessionStart') { onSessionStart(input); return; }
  const dir = rulesDir();
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const matched = matchRules(input, manifest);
  if (matched.length === 0) { outputContinue(); return; }
  const state = stateDir(input);
  const won = matched.filter((r) => claim(state, r.id));
  // A deny-first rule blocks once per session. The caller that takes the session marker blocks.
  // A subagent that finds the marker taken gets the rule injected instead; the main thread
  // takes the marker too but blocks regardless (block-once for the main thread is unchanged).
  // A rule flagged `subagent: "block"` (spend and confirm-first gates) is never downgraded: injected
  // text arrives after the command was chosen, so each fresh subagent is blocked once for it.
  const sessionClaims: string[] = [];
  const downgraded: string[] = [];
  const toShow = won.map((r): RuleEntry => {
    if (r.mode !== 'deny-first') return r;
    if (claim(blockedDir(input), r.id)) { sessionClaims.push(r.id); return r; }
    if (!isSubagent(input) || r.subagent === 'block') return r;
    downgraded.push(r.id);
    return { ...r, mode: 'inject' };
  });
  let d: Decision;
  try {
    d = decide(toShow, [], dir);
  } catch (err) {
    // A rule file could not be read: release the claims so a later call can still show the rule.
    for (const r of won) { try { unlinkSync(join(state, r.id)); } catch { /* already gone */ } }
    for (const id of sessionClaims) { try { unlinkSync(join(blockedDir(input), id)); } catch { /* already gone */ } }
    throw err;
  }
  if (d.kind === 'none') { outputContinue(); return; }
  logFire(input, d, won, downgraded.length ? { downgraded } : {});
  if (d.kind === 'deny') {
    logGuardDecision('rule-router', input, 'deny', `rule-block: ${d.ids.join(',')}`);
    outputDeny(d.text, 'deny');
  } else {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.text } }));
  }
}

function main(): void {
  try {
    run(readFileSync(0, 'utf8'));
  } catch {
    outputContinue(); // fail open: a router bug must never block a tool call
  }
}

if ((process.argv[1] || '').includes('rule-router')) {
  main();
}
