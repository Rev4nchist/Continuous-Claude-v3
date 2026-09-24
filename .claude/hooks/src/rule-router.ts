#!/usr/bin/env node
/**
 * rule-router -- PreToolUse hook (matcher: Bash|PowerShell|Task|Agent|Skill|mcp__Neon__.*|mcp__linear__.*|mcp__sentry__.*).
 *
 * Loads a tool-specific rule at the moment it applies, instead of keeping it in every session's
 * always-loaded context (phase 2 of docs/self-improvement/proposals/2026-09-24-context-loading.md).
 * The rules live in ~/.claude/rules-ondemand/ with a manifest.json that says which tool call
 * loads which rule. The always-loaded index is rules/on-demand-rules.md.
 *
 * Per matched rule, once per session (and per subagent):
 *   - mode 'deny-first': refuse the call, with the rule text as the reason. The model re-plans
 *     with the rule in view and re-issues the call if it still fits. Used for rules that must
 *     change the DECISION (confirm-first Codex/Grok/CMA runs, commit and PR text), because
 *     context injected at PreToolUse arrives after the command was already chosen.
 *   - mode 'inject': add the rule text as additionalContext and let the call run.
 *
 * Every fire is appended to ~/.claude/logs/rule-router.jsonl, so false fires can be audited.
 * Fails open: any error emits "continue" and the call runs.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname } from 'path';
import { outputContinue, outputDeny } from './shared/output.js';
import { stripQuotedStrings } from './shared/destructive-classifier.js';

export interface RuleEntry {
  id: string;
  files: string[];
  mode: 'deny-first' | 'inject';
  command?: string[];
  raw?: string[];
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
}

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);

export function rulesDir(): string {
  return process.env.CLAUDE_RULES_ONDEMAND_DIR || join(homedir(), '.claude', 'rules-ondemand');
}

/** A command split into segments, each with leading env assignments, `env`, `&` and `cmd /c` dropped. */
export function commandSegments(command: string, tool: string): string[] {
  const stripped = stripQuotedStrings(command, tool);
  return stripped
    .split(/\|\||&&|[;|\n]/)
    .map((seg) => {
      let s = seg.trim();
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
    })
    .filter(Boolean);
}

const test = (patterns: string[] | undefined, value: string): boolean =>
  !!patterns && patterns.some((p) => new RegExp(p).test(value));

/** The manifest entries this tool call matches, in manifest order. */
export function matchRules(input: HookInput, manifest: Manifest): RuleEntry[] {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  return manifest.rules.filter((r) => {
    if (COMMAND_TOOLS.has(tool)) {
      const command = typeof ti.command === 'string' ? ti.command : '';
      if (!command) return false;
      return commandSegments(command, tool).some((seg) => test(r.command, seg)) || test(r.raw, command);
    }
    if (AGENT_TOOLS.has(tool)) return test(r.agent, String(ti.subagent_type || ''));
    if (tool === 'Skill') return test(r.skill, String(ti.skill || ''));
    return test(r.tools, tool);
  });
}

function statePath(input: HookInput): string {
  const key = `${input.session_id || 'no-session'}-${input.agent_id || process.env.CLAUDE_AGENT_ID || 'main'}`;
  return join(process.env.CLAUDE_RULE_ROUTER_STATE_DIR || tmpdir(), `rule-router-${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readSeen(path: string): string[] {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).seen ?? []) : []; } catch { return []; }
}

function ruleText(entry: RuleEntry, dir: string): string {
  return entry.files
    .map((f) => `----- ~/.claude/rules-ondemand/${f} -----\n${readFileSync(join(dir, f), 'utf8').trim()}`)
    .join('\n\n');
}

export interface Decision { kind: 'none' | 'deny' | 'inject'; ids: string[]; text: string }

/** What to emit for the unseen matches. A deny-first match turns the whole emission into a deny. */
export function decide(matched: RuleEntry[], seen: string[], dir: string): Decision {
  const fresh = matched.filter((r) => !seen.includes(r.id));
  if (fresh.length === 0) return { kind: 'none', ids: [], text: '' };
  const ids = fresh.map((r) => r.id);
  const body = fresh.map((r) => ruleText(r, dir)).join('\n\n');
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

function logFire(input: HookInput, d: Decision): void {
  try {
    const path = process.env.CLAUDE_RULE_ROUTER_LOG || join(homedir(), '.claude', 'logs', 'rule-router.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    const ti = input.tool_input || {};
    const what = String(ti.command ?? ti.subagent_type ?? ti.skill ?? '').slice(0, 120);
    appendFileSync(path, JSON.stringify({
      ts: new Date().toISOString(), session: (input.session_id || '').slice(0, 8), agent: input.agent_id || null,
      tool: input.tool_name, rules: d.ids, kind: d.kind, what,
    }) + '\n');
  } catch { /* logging never blocks a tool call */ }
}

export function run(raw: string): void {
  let input: HookInput;
  try { input = JSON.parse(raw); } catch { outputContinue(); return; }
  const dir = rulesDir();
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const matched = matchRules(input, manifest);
  if (matched.length === 0) { outputContinue(); return; }
  const state = statePath(input);
  const seen = readSeen(state);
  const d = decide(matched, seen, dir);
  if (d.kind === 'none') { outputContinue(); return; }
  writeFileSync(state, JSON.stringify({ seen: [...seen, ...d.ids] }));
  logFire(input, d);
  if (d.kind === 'deny') {
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
