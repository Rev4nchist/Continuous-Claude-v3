#!/usr/bin/env node
/**
 * Guardrail Enforcer Hook
 *
 * Enforces mandatory skill loading for critical actions.
 * These are HARD BLOCKS - Claude must load the skill before proceeding.
 *
 * Tier 1 Guardrails:
 * - systematic-debugging: Required before bug/error/fix work
 * - databases: Required before SQL/query/schema work
 * - code-review: Required before PR/review/merge work
 *
 * Session Tracking:
 * - Uses temp file to track which skills have been "acknowledged" this session
 * - First trigger blocks, subsequent prompts pass through
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { outputContinue, outputWithMessage } from './shared/output.js';
import { isMachineGeneratedPrompt } from './shared/intent-extractor.js';

interface Guardrail {
  name: string;
  skill: string;
  triggers: RegExp;
  antiTriggers?: RegExp;
  message: string;
}

const GUARDRAILS: Guardrail[] = [
  {
    name: 'systematic-debugging',
    skill: 'systematic-debugging',
    triggers: /\b(bug|error|fix|debug|broken|failing|crash|exception|stack\s*trace)\b/i,
    antiTriggers: /\b(commit\s+to|commit\s+the\s+approach|no\s+bugs?|without\s+errors?)\b/i,
    message: `🛑 GUARDRAIL: Debugging methodology required

Before investigating bugs/errors, you MUST load the systematic-debugging skill.

**ACTION REQUIRED:**
1. Invoke the Skill tool: { "skill": "systematic-debugging" }
2. THEN respond to the user's debugging request

This ensures proper root cause analysis before fixes.
Do NOT attempt fixes without understanding the root cause first.`
  },
  {
    name: 'databases',
    skill: 'databases',
    // Bare `table` / `column` / `index` fired on markdown tables, INDEX.md and prose (2026-09-23
    // eval, P22); they now count only in SQL-shaped phrases.
    triggers: /\b(database|sql|postgres|postgresql|mysql|sqlite|psql|migration|schema|(?:create|alter|drop|truncate)\s+(?:table|index|column)|select\s+\S+\s+from)\b/i,
    antiTriggers: /\b(no\s+database|without\s+database|skip\s+database)\b/i,
    message: `🛑 GUARDRAIL: Database skill required

Before database operations, you MUST load the databases skill.

**ACTION REQUIRED:**
1. Invoke the Skill tool: { "skill": "databases" }
2. THEN proceed with database work

This ensures query optimization and safety checks.
Do NOT write SQL without the database skill loaded.`
  },
  {
    name: 'code-review',
    skill: 'code-review',
    // Bare `review` / `approve` / `merge` fired on "review this tweet" and "approve deletion"
    // (2026-09-23 eval, P22). Now: code or PR context only. "merge 43 and 44" still counts.
    triggers: /\b(pull\s*requests?|code\s*review|prs?\s*#?\d+|#\d+|review\s+(?:the\s+|this\s+|my\s+|a\s+)?(?:pr|diff|code|changes|commit|patch|branch)|merge\s+(?:pr\s*)?#?\d+|merge\s+(?:the\s+|this\s+)?(?:pr|branch|pull))\b/i,
    antiTriggers: /\b(no\s+review|skip\s+review|review\s+later)\b/i,
    message: `🛑 GUARDRAIL: Code review methodology required

Before PR/review work, you MUST load the code-review skill.

**ACTION REQUIRED:**
1. Invoke the Skill tool: { "skill": "code-review" }
2. THEN proceed with review work

This ensures thorough review methodology.
Do NOT approve PRs without proper verification.`
  }
];

interface HookInput {
  prompt?: string;
  session_id?: string;
  conversation_id?: string;
}

interface HookOutput {
  result: 'continue' | 'block';
  reason?: string;
}

interface SessionState {
  acknowledgedGuardrails: string[];
  lastUpdated: number;
}

function getSessionId(): string {
  return process.env.CLAUDE_SESSION_ID || String(process.ppid || process.pid);
}

function getSessionFilePath(): string {
  const sessionId = getSessionId().slice(0, 8);
  return join(tmpdir(), `claude-guardrails-${sessionId}.json`);
}

function readSessionState(): SessionState {
  const filePath = getSessionFilePath();
  if (!existsSync(filePath)) {
    return { acknowledgedGuardrails: [], lastUpdated: Date.now() };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const state = JSON.parse(content) as SessionState;
    const hourAgo = Date.now() - (60 * 60 * 1000);
    if (state.lastUpdated < hourAgo) {
      return { acknowledgedGuardrails: [], lastUpdated: Date.now() };
    }
    return state;
  } catch {
    return { acknowledgedGuardrails: [], lastUpdated: Date.now() };
  }
}

function writeSessionState(state: SessionState): void {
  const filePath = getSessionFilePath();
  try {
    writeFileSync(filePath, JSON.stringify(state), 'utf-8');
  } catch {
  }
}

function acknowledgeGuardrail(guardrailName: string): void {
  const state = readSessionState();
  if (!state.acknowledgedGuardrails.includes(guardrailName)) {
    state.acknowledgedGuardrails.push(guardrailName);
    state.lastUpdated = Date.now();
    writeSessionState(state);
  }
}

function isGuardrailAcknowledged(guardrailName: string): boolean {
  const state = readSessionState();
  return state.acknowledgedGuardrails.includes(guardrailName);
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

/**
 * Which guardrails a prompt triggers, ignoring session state. Pure; unit tested.
 * Harness turns (task notifications, system reminders, command output) never trigger:
 * they fired the debugging and database guardrails on background events (P22).
 */
export function matchGuardrails(prompt: string): string[] {
  if (isMachineGeneratedPrompt(prompt)) return [];
  const lowerPrompt = prompt.toLowerCase();
  return GUARDRAILS
    .filter((g) => g.triggers.test(lowerPrompt) && !(g.antiTriggers && g.antiTriggers.test(lowerPrompt)))
    .map((g) => g.name);
}

function checkGuardrails(prompt: string): Guardrail | null {
  for (const name of matchGuardrails(prompt)) {
    if (isGuardrailAcknowledged(name)) continue;
    return GUARDRAILS.find((g) => g.name === name) ?? null;
  }
  return null;
}

/**
 * Emit the guardrail so the model actually receives it.
 *
 * The comment here used to say "Return valid JSON so Claude sees message as
 * additionalContext" -- directly above a line that emitted no additionalContext
 * at all. It was valid JSON in a shape the harness ignores, so this hook fired,
 * marked itself acknowledged, and said nothing, for months.
 *
 * Proven on 2026-07-28: it fired at 19:18:35 on a prompt containing "bugs"/"fix"
 * (state file written that second) and its text appeared nowhere in the
 * transcript, while memory-awareness injected fine on the same prompt.
 *
 * Acknowledgement still happens exactly once, on emit, so a guardrail continues
 * to fire once per session rather than on every prompt.
 */
function emitGuardrail(guardrail: Guardrail): void {
  acknowledgeGuardrail(guardrail.name);
  outputWithMessage(guardrail.message, 'UserPromptSubmit');
}

async function main() {
  try {
    const rawInput = readStdin();
    if (!rawInput.trim()) {
      outputContinue();
      return;
    }

    let input: HookInput;
    try {
      input = JSON.parse(rawInput);
    } catch {
      outputContinue();
      return;
    }

    if (!input.prompt || typeof input.prompt !== 'string') {
      outputContinue();
      return;
    }

    const triggeredGuardrail = checkGuardrails(input.prompt);

    if (triggeredGuardrail) {
      emitGuardrail(triggeredGuardrail);
      return;
    }

    // No guardrail triggered - output continue
    outputContinue();
  } catch (err) {
    console.error('guardrail-enforcer error:', err);
    outputContinue();
  }
}

if ((process.argv[1] || '').includes('guardrail-enforcer')) {
  main();
}
