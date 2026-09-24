#!/usr/bin/env node
// @hook-kind injector
/**
 * Maestro Detector Hook
 *
 * Auto-detects complex multi-step requests and suggests Maestro orchestration.
 * Runs on UserPromptSubmit - analyzes user prompt for complexity signals.
 *
 * Complexity Signals:
 * - Multi-task indicators (and, also, then, plus)
 * - List patterns (numbered, bulleted)
 * - Scope indicators (system, architecture, full, complete)
 * - Process keywords (plan, design, build, implement, research)
 * - Complexity keywords (complex, multiple, integrate, coordinate)
 *
 * If total weight > threshold, suggests Maestro orchestration.
 * Re-entrancy guard: if .claude/maestro-state.json exists and is fresh
 * (mtime within SESSION_WINDOW_MS), skip the suggestion entirely.
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { outputContinue } from './shared/output.js';
import { isHarnessWrappedPrompt } from './shared/intent-extractor.js';

interface ComplexitySignal {
  name: string;
  pattern: RegExp;
  weight: number;
  global?: boolean;
}

const COMPLEXITY_SIGNALS: ComplexitySignal[] = [
  // Multi-task indicators
  { name: 'conjunction', pattern: /\b(and then|and also|plus|as well as)\b/i, weight: 0.25 },
  { name: 'sequence', pattern: /\b(first|then|after that|finally|next)\b/i, weight: 0.2 },
  { name: 'list_numbered', pattern: /\d+\.\s+\w/g, weight: 0.15, global: true },
  { name: 'list_bulleted', pattern: /^[\-\*]\s+\w/gm, weight: 0.15, global: true },

  // Scope indicators
  { name: 'system_scope', pattern: /\b(system|architecture|full|complete|entire|whole)\b/i, weight: 0.2 },
  { name: 'feature_scope', pattern: /\b(feature|module|component|service)\b/i, weight: 0.15 },

  // Process keywords (multiple phases)
  { name: 'research', pattern: /\b(research|explore|understand|investigate|analyze)\b/i, weight: 0.15 },
  { name: 'planning', pattern: /\b(plan|design|architect|strategy|approach)\b/i, weight: 0.15 },
  { name: 'implementation', pattern: /\b(build|create|implement|develop|add)\b/i, weight: 0.15 },
  { name: 'testing', pattern: /\b(test|validate|verify|check)\b/i, weight: 0.1 },
  { name: 'review', pattern: /\b(review|audit|assess)\b/i, weight: 0.1 },

  // Complexity indicators
  { name: 'complexity_explicit', pattern: /\b(complex|complicated|sophisticated|comprehensive)\b/i, weight: 0.25 },
  { name: 'multiplicity', pattern: /\b(multiple|several|various|many)\b/i, weight: 0.2 },
  { name: 'integration', pattern: /\b(integrate|coordinate|orchestrate|combine)\b/i, weight: 0.25 },

  // Cross-cutting concerns
  { name: 'cross_cutting', pattern: /\b(across|throughout|all|every)\s+(the\s+)?(codebase|project|system|modules?)/i, weight: 0.2 },
];

const COMPLEXITY_THRESHOLD = 0.65;
const SESSION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

interface HookInput {
  prompt?: string;
  session_id?: string;
}

interface DetectedSignal {
  name: string;
  weight: number;
  matches: number;
}

/**
 * Returns true if a fresh maestro session is active.
 * Checks .claude/maestro-state.json mtime; fails open on any error.
 */
export function isMaestroActive(projectDir?: string): boolean {
  try {
    const dir = projectDir ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const stateFile = join(dir, '.claude', 'maestro-state.json');
    const stat = statSync(stateFile);
    const ageMsec = Date.now() - stat.mtimeMs;
    return ageMsec < SESSION_WINDOW_MS;
  } catch {
    // File missing or unreadable — no active session
    return false;
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

export function analyzeComplexity(prompt: string): { score: number; signals: DetectedSignal[] } {
  const detected: DetectedSignal[] = [];
  let totalScore = 0;

  for (const signal of COMPLEXITY_SIGNALS) {
    if (signal.global) {
      const matches = prompt.match(signal.pattern);
      if (matches && matches.length > 0) {
        const weight = Math.min(signal.weight * matches.length, signal.weight * 3);
        detected.push({ name: signal.name, weight, matches: matches.length });
        totalScore += weight;
      }
    } else {
      if (signal.pattern.test(prompt)) {
        detected.push({ name: signal.name, weight: signal.weight, matches: 1 });
        totalScore += signal.weight;
      }
    }
  }

  return { score: Math.min(totalScore, 1.5), signals: detected };
}

export function countProcessPhases(prompt: string): number {
  const phases = [
    /\b(research|explore|understand|investigate)\b/i,
    /\b(plan|design|architect)\b/i,
    /\b(build|create|implement|develop)\b/i,
    /\b(test|validate|verify)\b/i,
    /\b(review|audit|deploy)\b/i,
  ];

  return phases.filter(p => p.test(prompt)).length;
}

function formatSignals(signals: DetectedSignal[]): string {
  const top = signals
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map(s => `  - ${s.name.replace(/_/g, ' ')} (+${(s.weight * 100).toFixed(0)}%)`)
    .join('\n');
  return top;
}

function makeSuggestionOutput(score: number, signals: DetectedSignal[], phases: number): void {
  // The score is capped at 1.5, so this printed "165% confidence" (2026-09-23 eval, P22).
  const confidencePct = Math.min(100, Math.round(score * 100));

  const message = [
    '--- MAESTRO ORCHESTRATION SUGGESTED ---',
    '',
    `This looks like a complex multi-step task (${confidencePct}% confidence).`,
    '',
    '**Detected signals:**',
    formatSignals(signals),
    '',
    `**Estimated phases:** ${phases}`,
    '',
    '**Recommended approach:**',
    '1. Use Maestro orchestrator for coordination',
    '2. Discovery interview for thorough requirements',
    '3. Delegate to specialized agents',
    '',
    '**To proceed with Maestro:**',
    'Say "Yes, use Maestro" or "orchestrate this"',
    '',
    '**To skip:**',
    'Continue with your request normally.',
    '--------------------------------------',
  ].join('\n');

  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } }));
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

    const prompt = input.prompt;

    // Skip very short prompts, and harness turns (task notifications, system reminders):
    // it suggested Maestro for a background task-notification (2026-09-23 eval, P22).
    if (prompt.length < 50 || isHarnessWrappedPrompt(prompt)) {
      outputContinue();
      return;
    }

    // Skip if already invoking maestro
    if (/\b(maestro|orchestrat)/i.test(prompt)) {
      outputContinue();
      return;
    }

    // Re-entrancy guard: skip if a maestro session is already active
    if (isMaestroActive()) {
      outputContinue();
      return;
    }

    // Skip simple questions
    if (/^(what|how|why|where|when|can you|could you|is there)\s/i.test(prompt) && prompt.length < 100) {
      outputContinue();
      return;
    }

    const { score, signals } = analyzeComplexity(prompt);
    const phases = countProcessPhases(prompt);

    // Boost score if multiple distinct phases detected
    const adjustedScore = phases >= 3 ? score + 0.15 : score;

    if (adjustedScore >= COMPLEXITY_THRESHOLD && signals.length >= 2) {
      makeSuggestionOutput(adjustedScore, signals, Math.max(phases, 2));
    } else {
      outputContinue();
    }

  } catch (err) {
    // Fail silently - don't block user prompt
    outputContinue();
  }
}

// Auto-run ONLY when invoked directly as the hook (argv[1] is this script).
// A bare `main()` here HUNG THE WHOLE TEST SUITE: main() awaits readStdin(), and
// stdin never closes under vitest, so importing this module to unit-test its pure
// helpers (isMaestroActive / analyzeComplexity / countProcessPhases) blocked
// forever. `npx vitest run` therefore produced no verdict at all -- one file's
// import cost the entire suite. Same guard as session-start-init-check.ts.
// Production is unchanged: it is registered as
// `node ~/.claude/hooks/dist/maestro-detector.mjs`, so argv[1] contains this name.
if ((process.argv[1] || '').includes('maestro-detector')) {
  main();
}
