#!/usr/bin/env node
/**
 * CodeRabbit CLI guard (PreToolUse: Bash|PowerShell|Task|Agent|Skill)
 *
 * Advisory CLI only: allow at most 2 `cr review --agent` runs per repo+branch; block billing,
 * API keys, code workspace commands, autofix skill, and skill installs.
 *
 * Output contract: ALWAYS exit 0; blocks use permissionDecision deny via shared/output.ts.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { outputContinue, outputDeny } from './shared/output.js';
import { logGuardDecision } from './shared/guard-log.js';

const BASH_TOOLS = new Set(['Bash', 'PowerShell']);
const DELEGATE_TOOLS = new Set(['Task', 'Agent', 'Skill']);

const STATE_BASENAME = 'coderabbit-guard-runs.json';
const MAX_RUNS = 2;
const OVERRIDE = 'SKIP_CODERABBIT_GUARD=1';

export interface PreToolUseInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    skill?: string;
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
}

export interface RunState {
  /** repo#branch -> count of allowed review runs (no command text stored). */
  counts: Record<string, number>;
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CCV3_CODERABBIT_GUARD_STATE || join(tmpdir(), STATE_BASENAME);
  return base;
}

export function readState(path: string): RunState {
  try {
    if (!existsSync(path)) return { counts: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunState>;
    return { counts: parsed?.counts && typeof parsed.counts === 'object' ? parsed.counts : {} };
  } catch {
    return { counts: {} };
  }
}

export function writeState(path: string, state: RunState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), 'utf8');
  } catch {
    // best-effort counter
  }
}

/** Split on shell separators; does not unwrap quotes (matches scan-scope-guard). */
export function segmentize(command: string): string[] {
  return command.split(/\|\||&&|[;|&\n(]|\$\(|`/).map((p) => p.trim()).filter(Boolean);
}

function leadingExe(segment: string): string {
  let s = segment.trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, '');
  } while (s !== prev);
  const m = s.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return '';
  let tok = m[1] || m[2] || m[3] || '';
  tok = tok.replace(/\\/g, '/');
  const base = tok.slice(tok.lastIndexOf('/') + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/, '');
}

export function isCrExecutable(exe: string): boolean {
  return exe === 'cr' || exe === 'coderabbit';
}

export function hasForbiddenFlags(segment: string): string | null {
  if (/(?:^|\s)--use-credits\b/i.test(segment)) return '--use-credits';
  if (/(?:^|\s)--api-key\b/i.test(segment)) return '--api-key';
  return null;
}

export function isCodeWorkspace(segment: string): boolean {
  return /\b(?:cr|coderabbit)\b[^&|;]*\bcode\s+(?:new|push)\b/i.test(segment);
}

export function isAllowedReviewAgent(segment: string): boolean {
  if (!/\breview\b/i.test(segment)) return false;
  if (!/--agent\b/i.test(segment)) return false;
  if (hasForbiddenFlags(segment)) return false;
  if (isCodeWorkspace(segment)) return false;
  const exe = leadingExe(segment);
  if (!isCrExecutable(exe)) return false;
  return true;
}

export function isSkillInstall(segment: string): boolean {
  if (/\bnpx\s+skills\s+add\b/i.test(segment) && /coderabbit/i.test(segment)) return true;
  if (/\bcoderabbit\s+skills\b/i.test(segment)) return true;
  return false;
}

export type SegmentVerdict = 'allow' | 'block' | 'ignore';

export function classifyShellSegment(segment: string): { verdict: SegmentVerdict; reason?: string } {
  const exe = leadingExe(segment);
  const touchesCr =
    isCrExecutable(exe) ||
    /\b(?:cr|coderabbit)\b/i.test(segment) ||
    isSkillInstall(segment);
  if (!touchesCr) return { verdict: 'ignore' };

  const forbidden = hasForbiddenFlags(segment);
  if (forbidden) return { verdict: 'block', reason: `CodeRabbit guard: ${forbidden} is forbidden` };
  if (isCodeWorkspace(segment)) {
    return { verdict: 'block', reason: 'CodeRabbit guard: code new/push is forbidden' };
  }
  if (isSkillInstall(segment)) {
    return { verdict: 'block', reason: 'CodeRabbit guard: CodeRabbit skill installs are forbidden' };
  }
  if (isAllowedReviewAgent(segment)) return { verdict: 'allow' };
  if (isCrExecutable(exe) || /\b(?:cr|coderabbit)\b/i.test(segment)) {
    return { verdict: 'block', reason: 'CodeRabbit guard: only plain `cr review --agent` is allowed (≤2 runs/PR)' };
  }
  return { verdict: 'ignore' };
}

export function repoBranchKey(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CCV3_CODERABBIT_GUARD_KEY;
  if (fromEnv) return fromEnv;
  try {
    const root = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let remote = 'local';
    try {
      remote = execSync('git remote get-url origin', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      /* no origin */
    }
    const slug = remote.replace(/\.git$/, '').replace(/^.*[/:]/, '');
    return `${slug || 'local'}#${branch}`;
  } catch {
    return `cwd#${cwd}`;
  }
}

export function checkRunCap(state: RunState, key: string): { ok: boolean; count: number } {
  const count = state.counts[key] ?? 0;
  return { ok: count < MAX_RUNS, count };
}

export function recordRun(state: RunState, key: string): RunState {
  const count = (state.counts[key] ?? 0) + 1;
  return { counts: { ...state.counts, [key]: count } };
}

export function isReadOnlyAutofixDelegate(input: PreToolUseInput): boolean {
  const text = [input.tool_input?.prompt, input.tool_input?.description].filter(Boolean).join('\n');
  if (!/autofix/i.test(text)) return false;
  if (!/read[- ]only/i.test(text)) return false;
  return true;
}

export function classifySkill(input: PreToolUseInput): { verdict: SegmentVerdict; reason?: string } {
  const skill = String(input.tool_input?.skill ?? '');
  if (!skill) return { verdict: 'ignore' };
  if (/^coderabbit:autofix$/i.test(skill) || skill.toLowerCase().includes('coderabbit:autofix')) {
    return { verdict: 'block', reason: 'CodeRabbit guard: coderabbit:autofix skill is forbidden' };
  }
  return { verdict: 'ignore' };
}

export function classifyDelegate(input: PreToolUseInput): { verdict: SegmentVerdict; reason?: string } {
  const skill = classifySkill(input);
  if (skill.verdict === 'block') return skill;
  if (isReadOnlyAutofixDelegate(input)) return { verdict: 'allow' };
  const cmd = input.tool_input?.command;
  if (cmd) {
    for (const seg of segmentize(cmd)) {
      const c = classifyShellSegment(seg);
      if (c.verdict !== 'ignore') return c;
    }
  }
  return { verdict: 'ignore' };
}

export interface DecideResult {
  allow: boolean;
  reason?: string;
  increment?: boolean;
}

export function decide(input: PreToolUseInput, env: NodeJS.ProcessEnv = process.env): DecideResult {
  const tool = input.tool_name || '';
  const command = input.tool_input?.command || '';

  if (command.includes(OVERRIDE)) return { allow: true };

  if (tool === 'Skill') {
    const s = classifySkill(input);
    if (s.verdict === 'block') return { allow: false, reason: s.reason };
    return { allow: true };
  }

  if (DELEGATE_TOOLS.has(tool)) {
    const d = classifyDelegate(input);
    if (d.verdict === 'block') return { allow: false, reason: d.reason };
    if (d.verdict === 'allow') return { allow: true };
    return { allow: true };
  }

  if (!BASH_TOOLS.has(tool)) return { allow: true };

  let needsIncrement = false;
  for (const seg of segmentize(command)) {
    const c = classifyShellSegment(seg);
    if (c.verdict === 'block') return { allow: false, reason: c.reason };
    if (c.verdict === 'allow') needsIncrement = true;
  }

  if (!needsIncrement) return { allow: true };

  const path = statePath(env);
  const state = readState(path);
  const key = repoBranchKey(process.cwd(), env);
  const cap = checkRunCap(state, key);
  if (!cap.ok) {
    return {
      allow: false,
      reason: `CodeRabbit guard: run cap reached (${MAX_RUNS} cr review --agent runs for ${key})`,
    };
  }
  writeState(path, recordRun(state, key));
  return { allow: true, increment: true };
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function main(): void {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }

  const result = decide(input);
  if (!result.allow) {
    logGuardDecision('coderabbit-guard', input, 'deny', result.reason || 'blocked', {
      command: input.tool_input?.command,
    });
    outputDeny(result.reason || 'CodeRabbit guard: blocked');
    return;
  }
  outputContinue();
}

if (!process.env.VITEST) {
  try {
    main();
  } catch {
    outputContinue();
  }
}
