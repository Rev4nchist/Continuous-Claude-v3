#!/usr/bin/env node
/**
 * Post-Plan ROADMAP Hook
 *
 * Fires on PostToolUse for ExitPlanMode to update ROADMAP.md with planning decisions.
 * This enables the Knowledge Tree to track project goals and progression.
 *
 * Hook: PostToolUse (ExitPlanMode)
 * Output: Updates {project}/ROADMAP.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';
import { getProjectIdentity, isContentRelevantToProject } from './shared/project-relevance.js';
import {
  parseRoadmap,
  type RoadmapDoc,
  type PlanningSession as SharedPlanningSession,
} from './shared/roadmap-parser.js';
import {
  applySplices,
  insertAfterHeader,
  insertAtEof,
  findSessionBlock,
  replaceLine,
  type SpliceOp,
  type LineRange,
} from './shared/roadmap-splice.js';
import { writeRoadmapGuarded } from './shared/roadmap-audit.js';
import { localDateStamp } from './shared/roadmap-sync-guards.js';

interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
  tool_result?: string;
  session_id?: string;
}

// PlanningSession + parseRoadmap moved to shared/roadmap-parser.ts (Phase 3A).
type PlanningSession = SharedPlanningSession;
type RoadmapSection = RoadmapDoc;

/**
 * Render one managed section's body lines VERBATIM — the `## Header` line plus
 * its content, with NO trailing-blank normalization. This is the exact
 * per-section emit the pre-refactor generateRoadmap produced (sessions
 * sub-blocks keep their own trailing blanks). Used ONLY by generateRoadmap
 * (the fresh/empty-file byte-for-byte path) -- the append-only splice path in
 * `applyRoadmapUpdate` never regenerates a managed section from this.
 */
function renderSectionBody(
  key: 'current' | 'completed' | 'planned' | 'sessions',
  sections: RoadmapSection,
): string[] {
  const lines: string[] = [];

  if (key === 'current') {
    lines.push('## Current Focus');
    if (sections.current) {
      lines.push(`**${sections.current.title}**`);
      if (sections.current.description) {
        lines.push(`- ${sections.current.description}`);
      }
      if (sections.current.started) {
        lines.push(`- Started: ${sections.current.started}`);
      }
    } else {
      lines.push('No current focus set.');
    }
  } else if (key === 'completed') {
    lines.push('## Completed');
    if (sections.completed.length > 0) {
      for (const item of sections.completed) {
        const dateStr = item.completed ? ` (${item.completed})` : '';
        lines.push(`- [x] ${item.title}${dateStr}`);
      }
    } else {
      lines.push('_No completed items yet._');
    }
  } else if (key === 'planned') {
    lines.push('## Planned');
    if (sections.planned.length > 0) {
      for (const item of sections.planned) {
        // priorityBucket is normalized 'high' | 'medium' | 'low' (Phase 3A shared parser).
        const bucket = item.priorityBucket || 'medium';
        lines.push(`- [ ] ${item.title} (${bucket} priority)`);
      }
    } else {
      lines.push('_No planned items yet._');
    }
  } else {
    // key === 'sessions'
    lines.push('## Recent Planning Sessions');
    if (sections.sessions.length > 0) {
      for (const session of sections.sessions.slice(0, 5)) {
        lines.push(...renderSessionBlock(session));
      }
    } else {
      lines.push('_No planning sessions recorded._');
    }
  }

  return lines;
}

/**
 * Render ONE `### YYYY-MM-DD: Title` session sub-block, including its own
 * trailing blank lines exactly as each present field emits one. Byte-neutral
 * lift out of `renderSectionBody`'s old inline `sessions` loop body (used to
 * live at roughly lines 86-122) -- verbatim, not rewritten, so every existing
 * caller renders identically. Also the unit the append-only writer inserts
 * for a brand-new `### <today>` block (see `applyRoadmapUpdate` below).
 */
export function renderSessionBlock(session: PlanningSession): string[] {
  const lines: string[] = [];
  lines.push(`### ${session.date}: ${session.title}`);

  // Summary if available
  if (session.summary) {
    lines.push(`**Summary:** ${session.summary}`);
    lines.push('');
  }

  // Key decisions
  if (session.decisions.length > 0) {
    lines.push('**Key Decisions:**');
    for (const decision of session.decisions) {
      lines.push(`- ${decision}`);
    }
    lines.push('');
  }

  // Implementation steps
  if (session.steps && session.steps.length > 0) {
    lines.push('**Implementation:**');
    for (const step of session.steps) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  // Affected files
  if (session.files && session.files.length > 0) {
    lines.push(`**Files:** ${session.files.join(', ')}`);
    lines.push('');
  }

  // Verification
  if (session.verification && session.verification.length > 0) {
    lines.push(`**Verification:** ${session.verification[0]}`);
    lines.push('');
  }

  return lines;
}

function generateRoadmap(sections: RoadmapSection): string {
  // Reproduce the pre-refactor byte output exactly: title, then each managed
  // section body followed by a single blank line — EXCEPT the trailing sessions
  // block, which keeps its raw body (no forced trailing blank) as before.
  const lines: string[] = ['# Project Roadmap', ''];
  lines.push(...renderSectionBody('current', sections), '');
  lines.push(...renderSectionBody('completed', sections), '');
  lines.push(...renderSectionBody('planned', sections), '');
  lines.push(...renderSectionBody('sessions', sections));
  return lines.join('\n');
}

/**
 * Function words common enough in a hand-written English title that their
 * PRESENCE is evidence the title is NOT the mechanical
 * `extractPlanInfo` filename fallback (`basename.split(/[-_]/).map(w =>
 * w.charAt(0).toUpperCase() + w.slice(1)).join(' ')`), which title-cases
 * every segment regardless of grammar.
 */
const FOCUS_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet',
  'to', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto', 'over',
  'under', 'via', 'is', 'are', 'as',
]);

/**
 * A filename-derived title (the `extractPlanInfo` fallback, or a bare
 * `'Planning Session'`) looks like: every word capitalized, no punctuation,
 * and short (<=4 words). A real hand-written plan title almost always has
 * SOME lowercase function word or punctuation. This is a heuristic with known
 * false positives (a genuinely title-cased short goal name reads the same
 * way) -- that is acceptable here because the only consequence of a false
 * positive is leaving Current Focus vacant with an advisory, never data loss.
 */
function looksFilenameDerived(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (/[.,;:!?()[\]{}"'`]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length === 0 || words.length > 4) return false;
  if (words.some(w => FOCUS_FUNCTION_WORDS.has(w.toLowerCase()) && w === w.toLowerCase())) return false;
  return words.every(w => /^[A-Z]/.test(w));
}

/**
 * Seed quality gate for Current Focus (see the plan's SS3). Refuses to seed a
 * title that is exactly `'Planning Session'` (the extractPlanInfo default) or
 * that looks filename-derived. A refusal leaves the section vacant -- it does
 * NOT fall back to seeding anyway.
 */
function isSeedableFocusTitle(title: string | null | undefined): title is string {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed || trimmed === 'Planning Session') return false;
  if (looksFilenameDerived(trimmed)) return false;
  return true;
}

const CURRENT_FOCUS_PLACEHOLDER = 'No current focus set.';

/** Index of the placeholder line within `range`, or null if not present. */
function findPlaceholderLine(lines: string[], range: LineRange): number | null {
  for (let i = range.start; i < range.end; i++) {
    if (lines[i].trim() === CURRENT_FOCUS_PLACEHOLDER) return i;
  }
  return null;
}

export interface RoadmapUpdateOpSummary {
  label: string;
  lines_removed: number;
  lines_added: number;
}

/**
 * Build the ROADMAP.md content for a new planning session, append-only.
 *
 * This NEVER regenerates a managed section from a lossy structured re-parse
 * (that was the whole bug class this rewrite exists to remove). Instead it
 * builds a small list of `SpliceOp`s against the ORIGINAL line array --
 * inserts only, plus the ONE declared exception (seeding the vacant Current
 * Focus placeholder) -- and applies them all in one `applySplices` pass.
 *
 * - Current Focus: written ONLY when vacant (`doc.current === null`) AND
 *   `update.focusTitle` passes the seed quality gate. When occupied, this
 *   emits NO op for that section at all -- the caller is responsible for
 *   surfacing an advisory that the new goal was not recorded there.
 * - Recent Planning Sessions: pure append. No block for `today` -> insert
 *   right after the header. A block for `today` under a DIFFERENT title ->
 *   append a second block (still newest-first, still a pure insert). A block
 *   for `today` under the SAME title -> emit NO op (caller records noop).
 *   There is no cap and no trim, ever.
 *
 * Pure: never mutates `doc` or its nested fields.
 */
export function applyRoadmapUpdate(
  doc: RoadmapDoc,
  update: { session: PlanningSession; today: string; focusTitle: string | null },
): { content: string; ops: RoadmapUpdateOpSummary[] } {
  const original = doc.rawContent;

  if (!original.trim()) {
    // Fresh/empty file: the canonical byte-for-byte generateRoadmap output is
    // the correct shape, but it needs to reflect this update -- build a LOCAL
    // seeded copy for rendering only; `doc` itself is never mutated.
    const seededCurrent =
      doc.current === null && isSeedableFocusTitle(update.focusTitle)
        ? { title: update.focusTitle, started: update.today }
        : doc.current;
    const seeded: RoadmapDoc = {
      ...doc,
      current: seededCurrent,
      sessions: [update.session, ...doc.sessions],
    };
    const content = generateRoadmap(seeded);
    return {
      content,
      ops: [{ label: 'fresh-file', lines_removed: 0, lines_added: content.split('\n').length }],
    };
  }

  const lines = original.split('\n');
  const ops: SpliceOp[] = [];
  const opSummaries: RoadmapUpdateOpSummary[] = [];

  const addOp = (op: SpliceOp): void => {
    ops.push(op);
    opSummaries.push({
      label: op.label,
      lines_removed: op.range.end - op.range.start,
      lines_added: op.lines.length,
    });
  };

  // --- Current Focus: vacant-only seed ------------------------------------
  if (doc.current === null && isSeedableFocusTitle(update.focusTitle)) {
    const currentRange = doc.rawSections.get('current');
    if (currentRange) {
      const placeholderIdx = findPlaceholderLine(lines, currentRange);
      if (placeholderIdx !== null) {
        // The ONE declared deletion in this whole module: the caller MUST
        // pass CURRENT_FOCUS_PLACEHOLDER in `allowedDeletions`.
        addOp(replaceLine(placeholderIdx, `**${update.focusTitle}**`, 'focus-seed'));
      } else {
        addOp(insertAfterHeader(currentRange, [`**${update.focusTitle}**`], 'focus-seed-insert'));
      }
    } else {
      addOp(
        insertAtEof(
          lines,
          ['', '## Current Focus', `**${update.focusTitle}**`, ''],
          'focus-seed-new-section',
        ),
      );
    }
  }
  // If occupied (doc.current !== null), or the gate refused: emit NO op here.
  // The caller (main()) surfaces the advisory -- this function never touches
  // an occupied Current Focus and never silently drops a low-quality title.

  // --- Recent Planning Sessions: pure append, no replace, no cap ----------
  const sessionsRange = doc.rawSections.get('sessions');
  const sessionBlockLines = [...renderSessionBlock(update.session), ''];

  if (sessionsRange) {
    const existing = findSessionBlock(lines, sessionsRange, update.today);
    if (!existing) {
      addOp(insertAfterHeader(sessionsRange, sessionBlockLines, 'session-insert'));
    } else {
      const titleMatch = existing.header.match(/^###\s*\d{4}-\d{2}-\d{2}:\s*(.+)$/);
      const existingTitle = titleMatch ? titleMatch[1].trim() : '';
      if (existingTitle !== update.session.title) {
        addOp(insertAfterHeader(sessionsRange, sessionBlockLines, 'session-insert-same-day'));
      }
      // else: same date + same title -> emit NO op (noop, hand edits survive).
    }
  } else {
    addOp(
      insertAtEof(lines, ['## Recent Planning Sessions', ...sessionBlockLines], 'session-insert-new-section'),
    );
  }

  const content = applySplices(lines, ops).join('\n');
  return { content, ops: opSummaries };
}

// Expanded keywords for content capture
const CAPTURE_KEYWORDS = [
  // Decisions
  'decision', 'decided', 'approach', 'strategy', 'chose', 'selected',
  // Goals
  'goal', 'objective', 'purpose', 'target', 'aim',
  // Implementation
  'implement', 'create', 'add', 'modify', 'update', 'fix', 'build',
  'step', 'action', 'task', 'change',
  // Verification
  'verify', 'test', 'check', 'confirm', 'validate', 'ensure',
  // Risks
  'risk', 'edge case', 'caveat', 'limitation', 'warning', 'note',
  // Analysis
  'problem', 'issue', 'cause', 'root cause', 'reason', 'why',
];

interface PlanInfo {
  title: string;
  summary: string;
  decisions: string[];
  steps: string[];
  verification: string[];
  affectedFiles: string[];
}

function parseSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split('\n');
  let currentSection = '_intro';
  let sectionContent: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      if (sectionContent.length > 0) {
        sections[currentSection] = sectionContent.join('\n');
      }
      currentSection = h2Match[1].trim().toLowerCase();
      sectionContent = [];
    } else {
      sectionContent.push(line);
    }
  }
  if (sectionContent.length > 0) {
    sections[currentSection] = sectionContent.join('\n');
  }

  return sections;
}

/** Opens or closes a fenced code block. */
function isFenceLine(trimmed: string): boolean {
  return /^(```|~~~)/.test(trimmed);
}

/**
 * Starts a markdown list item. The whitespace after the marker is REQUIRED --
 * markdown demands it, and without it a shell flag inside a code block
 * (`--jq '...'`) reads as a bullet and loses one dash to the marker strip.
 * That is exactly how `- -jq '"mergeable=..."'` reached ROADMAP.md in a71e13e.
 */
function isListMarker(trimmed: string): boolean {
  return /^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed);
}

/**
 * Normalize one accumulated list item to its ROADMAP bullet text, or null if
 * it should be dropped. Split out of the old inline loop body so the cleanup
 * runs ONCE on the fully joined item rather than on a single physical line.
 */
function cleanBulletText(bulletText: string): string | null {
  if (!bulletText) return null;

  // Skip checkbox syntax but keep content
  let cleanText = bulletText.replace(/^\[[ x]\]\s*/i, '');

  // Clean up markdown formatting artifacts
  cleanText = cleanText
    // **Bold:** → "Bold: ". The trailing-punctuation class sits INSIDE the
    // bold: a colon or period written by the author used to survive into $1
    // while the replacement appended its own ": ", yielding "commit::" and
    // "merging.:" in the committed entries (defect D4).
    .replace(/^\*\*([^*]+?)[\s:.;,]*\*\*[\s:]*/, '$1: ')
    .replace(/^`([^`]+)`\s*[-–]\s*/, '')       // `code` - description → description
    .replace(/^\*([^*]+)\*:?\s*/g, '$1 ')      // *Italic* → Italic (global)
    .replace(/::\s*\*/g, ': ')                 // ::* → :
    // NOTE: a global, unanchored `.replace(/\*\s+/g, ' ')` used to live here
    // ("trailing * → space"). It ate the closing `*` of any `**bold**`
    // followed by whitespace -- "but **not** fix" became "but **not* fix" --
    // because the leading-emphasis cases above already anchor what this was
    // meant to mop up. Deleted rather than anchored: no fixture or test
    // depended on it (verified via grep before removal), and the two anchored
    // replaces are sufficient for every case this file's fixtures exercise.
    // (Vector 5, `roadmap-sync-clobber` plan.)
    .replace(/\s+/g, ' ')                      // normalize whitespace
    .replace(/\s*:\s*$/, '')                   // never emit a hanging colon
    .trim();

  // Skip if too short (likely markdown fragments) or starts with special chars
  if (cleanText.length < 15) return null;
  if (cleanText.startsWith('|') || cleanText.startsWith('```')) return null;

  // Skip pure code references without context
  if (cleanText.match(/^`[^`]+`$/) || cleanText.match(/^[A-Za-z_]+\.[a-z]+$/)) return null;

  // Skip lines that are mostly placeholders/variables
  if (cleanText.match(/\{[^}]+\}/) && cleanText.length < 50) return null;

  return cleanText;
}

/**
 * Collect markdown list items from `content`, one bullet per item.
 *
 * BLOCK-AWARE, deliberately. The previous implementation looped over physical
 * lines and `continue`d on anything without a leading marker, so every
 * hard-wrapped bullet lost all but its first line. Plan files here wrap at
 * ~95-100 columns, which is why the committed entries looked like they had
 * been cut at a ~90-character budget. There was never a budget.
 *
 * Capture rule: an item captures its FIRST PARAGRAPH. A blank line, a code
 * fence, a header, a table row, or the next list item ends it. Lines inside a
 * fence are never read at all.
 */
export function extractBullets(content: string, keywords?: string[]): string[] {
  const bullets: string[] = [];
  const lines = content.split('\n');

  let inFence = false;
  let current: string[] | null = null;

  const flush = (): void => {
    if (current === null) return;
    const raw = current.join(' ').trim();
    current = null;

    const cleanText = cleanBulletText(raw);
    if (cleanText === null) return;

    if (keywords) {
      const lower = cleanText.toLowerCase();
      if (!keywords.some(kw => lower.includes(kw))) return;
    }
    bullets.push(cleanText);
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // A fence both toggles the skip state and terminates the item it sits in.
    if (isFenceLine(trimmed)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (isListMarker(trimmed)) {
      flush();
      current = [trimmed.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim()];
      continue;
    }

    if (current === null) continue;

    // Anything that is not plain prose ends the item.
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith('|')) {
      flush();
      continue;
    }

    current.push(trimmed);
  }
  flush();

  return bullets;
}

function extractFirstParagraph(content: string): string {
  const lines = content.split('\n');
  const paragraphLines: string[] = [];
  let foundStart = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headers and empty lines at start
    if (!foundStart) {
      if (trimmed.startsWith('#') || !trimmed) continue;
      foundStart = true;
    }

    // Stop at next header or empty line after content
    if (foundStart && (!trimmed || trimmed.startsWith('#'))) {
      if (paragraphLines.length > 0) break;
      continue;
    }

    paragraphLines.push(trimmed);
  }

  const summary = paragraphLines.join(' ').slice(0, 300);
  return summary.length === 300 ? summary + '...' : summary;
}

function extractFilesFromContent(content: string): string[] {
  const files: string[] = [];

  // Match backtick-wrapped paths
  const backtickMatches = content.match(/`([^`]+\.[a-z]{2,4})`/gi) || [];
  for (const match of backtickMatches) {
    const file = match.replace(/`/g, '');
    if (file.includes('/') || file.includes('\\') || file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }

  // Match table rows with file paths
  const tableMatches = content.match(/\|\s*`?([^|`]+\.[a-z]{2,4})`?\s*\|/gi) || [];
  for (const match of tableMatches) {
    const file = match.replace(/[|`\s]/g, '');
    if (file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }

  return [...new Set(files)];
}

export function extractPlanInfo(planContent: string, filePath?: string): PlanInfo {
  const sections = parseSections(planContent);

  // Extract title
  let title = 'Planning Session';
  const titleMatch = planContent.match(/^#\s+(?:Plan:\s*)?(.+)/m);
  if (titleMatch && titleMatch[1].trim() !== 'Planning Session') {
    title = titleMatch[1].trim();
  } else if (filePath) {
    // Fallback: filename → "velvety-yawning-pillow" → "Velvety Yawning Pillow"
    const basename = filePath.replace(/\\/g, '/').split('/').pop()?.replace('.md', '') || '';
    if (basename && !basename.match(/^plan[-_]?\d*$/i)) {
      title = basename.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }

  // Extract summary from multiple possible sources
  let summary = '';
  const summarySection = sections['summary'] || sections['problem summary'] || sections['purpose'] || sections['overview'];
  if (summarySection) {
    summary = extractFirstParagraph(summarySection);
  } else if (sections['_intro']) {
    summary = extractFirstParagraph(sections['_intro']);
  }

  // Steps and verification are resolved FIRST so the decisions fallback below
  // can subtract them. Order is load-bearing, not cosmetic.

  // Extract implementation steps
  const implSection = sections['implementation plan'] || sections['implementation'] ||
                      sections['steps'] || sections['plan'] || '';
  let steps = extractBullets(implSection);
  if (steps.length === 0 && sections['step 1']) {
    // Handle numbered step sections
    steps = Object.keys(sections)
      .filter(k => k.match(/^step \d/))
      .map(k => sections[k].split('\n')[0]?.trim() || k)
      .filter(Boolean);
  }

  // Extract verification criteria
  const verifySection = sections['verification'] || sections['verification plan'] ||
                        sections['testing'] || sections['test plan'] || '';
  const verification = extractBullets(verifySection);

  // Extract decisions with expanded keywords.
  //
  // The fallback scans the WHOLE document with no section boundary, so on a
  // plan with no `## Decisions` header it re-collected the very `## Steps`
  // items already held by `steps` -- and `## Verification` items too. That is
  // defect D3: in a71e13e, Key Decisions carried "The SHAs the docs cite..."
  // and "The original symptom is gone", text that exists ONLY under
  // `## Verification` in the source plan. Subtract what the other two fields
  // already own so the three lists are disjoint.
  //
  // An explicit decisions section is authoritative and is never filtered --
  // if an author writes the same line under both headers, that is their call.
  const decisionSection = sections['decisions'] || sections['key decisions'] || sections['approach'] || '';
  let decisions = extractBullets(decisionSection);
  if (decisions.length === 0) {
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const taken = new Set([...steps, ...verification].map(norm));
    decisions = extractBullets(planContent, CAPTURE_KEYWORDS).filter(d => !taken.has(norm(d)));
  }

  // Extract affected files
  const filesSection = sections['files to modify'] || sections['files'] ||
                       sections['affected files'] || '';
  let affectedFiles = extractFilesFromContent(filesSection);
  if (affectedFiles.length === 0) {
    affectedFiles = extractFilesFromContent(planContent);
  }

  return {
    title,
    summary: summary.slice(0, 500),
    decisions: decisions.slice(0, 10),
    steps: steps.slice(0, 8),
    verification: verification.slice(0, 5),
    affectedFiles: affectedFiles.slice(0, 10),
  };
}

function storePlanningLearnings(planInfo: PlanInfo, projectDir: string): void {
  const decisions = planInfo.decisions.slice(0, 5);
  if (decisions.length === 0) {
    console.error('No decisions to store in memory');
    return;
  }

  const contentLines = [
    `Planning: ${planInfo.title}`,
    '',
    'Decisions:',
    ...decisions.map(d => `- ${d}`)
  ];

  if (planInfo.steps.length > 0) {
    contentLines.push('', 'Key Steps:', ...planInfo.steps.slice(0, 3).map(s => `- ${s}`));
  }

  const content = contentLines.join('\n');
  const opcDir = process.env.CLAUDE_OPC_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'continuous-claude', 'opc');

  const sessionId = `plan-${Date.now()}`;

  // Store plan learning in background (detached so hook doesn't block)
  try {
    const child = spawn('uv', ['run', 'python', 'scripts/core/store_learning.py',
      '--session-id', sessionId,
      '--type', 'ARCHITECTURAL_DECISION',
      '--content', content,
      '--context', `planning: ${planInfo.title}`,
      '--tags', 'planning,decisions,architecture',
      '--confidence', 'high',
    ], {
      cwd: opcDir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PYTHONPATH: '.' },
    });
    child.unref();
  } catch {
    // Background storage failure is non-blocking
  }
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let data: PostToolUseInput;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (data.tool_name !== 'ExitPlanMode') {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = path.join(projectDir, 'ROADMAP.md');

  // Check multiple plan locations (priority order):
  // 1. {projectDir}/.claude/plans (standard project structure)
  // 2. {projectDir}/plans (when projectDir IS ~/.claude)
  // 3. ~/.claude/plans (user-level fallback)
  const planDirNested = path.join(projectDir, '.claude', 'plans');
  const planDirDirect = path.join(projectDir, 'plans');
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const userPlanDir = path.join(userHome, '.claude', 'plans');

  const hasPlanFiles = (dir: string): boolean => {
    try {
      return fs.existsSync(dir) &&
             fs.readdirSync(dir).some(f => f.endsWith('.md'));
    } catch { return false; }
  };

  const planDir = hasPlanFiles(planDirNested) ? planDirNested :
                  hasPlanFiles(planDirDirect) ? planDirDirect :
                  hasPlanFiles(userPlanDir) ? userPlanDir : planDirNested;

  // When using the global ~/.claude/plans/ directory, apply a staleness guard
  // to prevent cross-project contamination. Only plan files modified within
  // the last 10 minutes are considered (i.e., the plan just written by THIS
  // ExitPlanMode call). Project-local plans are always trusted.
  const isGlobalPlanDir = planDir === userPlanDir;
  const STALENESS_THRESHOLD_MS = 600_000; // 10 minutes

  let planContent = '';
  let latestPlanPath: string | undefined;
  if (fs.existsSync(planDir)) {
    const now = Date.now();
    const planFiles = fs.readdirSync(planDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(planDir, f)).mtime.getTime(),
      }))
      .filter(f => {
        if (isGlobalPlanDir) return (now - f.mtime) < STALENESS_THRESHOLD_MS;
        return true;
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (planFiles.length > 0) {
      planContent = fs.readFileSync(path.join(planDir, planFiles[0].name), 'utf-8');
      latestPlanPath = path.join(planDir, planFiles[0].name);
    }
  }

  const toolOutput = data.tool_output || data.tool_result || '';
  if (!planContent && toolOutput) {
    planContent = toolOutput;
  }

  let sections: RoadmapSection;
  if (fs.existsSync(roadmapPath)) {
    const existingContent = fs.readFileSync(roadmapPath, 'utf-8');
    sections = parseRoadmap(existingContent);
  } else {
    sections = {
      current: null,
      completed: [],
      planned: [],
      sessions: [],
      rawContent: '',
      rawSections: new Map(),
    };
  }

  const planInfo = extractPlanInfo(planContent, latestPlanPath);

  // Cross-project contamination guard
  const identity = getProjectIdentity(projectDir);
  const relevance = isContentRelevantToProject(planContent, identity);
  if (!relevance.relevant) {
    console.error(`[post-plan-roadmap] BLOCKED: Plan is about a different project. ${relevance.reason}`);
    console.log(JSON.stringify({
      result: 'continue',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `ROADMAP update skipped: cross-project guard triggered. "${planInfo.title}" does not match project "${identity.dirName}". ${relevance.reason}`
      }
    }));
    return;
  }

  const today = localDateStamp();

  const newSession: PlanningSession = {
    date: today,
    title: planInfo.title,
    summary: planInfo.summary || undefined,
    decisions: planInfo.decisions.slice(0, 5),
    steps: planInfo.steps.length > 0 ? planInfo.steps.slice(0, 5) : undefined,
    verification: planInfo.verification.length > 0 ? planInfo.verification.slice(0, 3) : undefined,
    files: planInfo.affectedFiles.length > 0 ? planInfo.affectedFiles.slice(0, 8) : undefined,
  };

  // NOTE: sections.current / sections.sessions are NEVER mutated here anymore
  // (that mutation, plus the unshift+slice(0,5) cap, is exactly the class of
  // bug this rewrite removes). applyRoadmapUpdate decides everything from the
  // ORIGINAL parsed doc plus this explicit update.
  const { content: newContent, ops } = applyRoadmapUpdate(sections, {
    session: newSession,
    today,
    focusTitle: planInfo.title,
  });

  const wasFreshFile = !sections.rawContent.trim();
  const focusSeeded = ops.some(o => o.label === 'focus-seed');
  const allowedDeletions = focusSeeded ? [CURRENT_FOCUS_PLACEHOLDER] : [];

  const { outcome, record } = writeRoadmapGuarded({
    hook: 'post-plan-roadmap',
    tool: data.tool_name,
    roadmapPath,
    projectDir,
    before: sections.rawContent,
    after: newContent,
    ops,
    allowedDeletions,
    allowFullRewrite: wasFreshFile,
    sessionId: data.session_id ?? null,
  });

  // Store planning decisions in archival_memory regardless of write outcome
  // -- the plan itself happened even if the ROADMAP entry was skipped/noop.
  storePlanningLearnings(planInfo, projectDir);

  console.error(`[post-plan-roadmap] ROADMAP.md ${outcome}: ${planInfo.title}`);

  const stats = [
    `Goal: ${planInfo.title}`,
    `Decisions: ${planInfo.decisions.length}`,
    `Steps: ${planInfo.steps.length}`,
    `Files: ${planInfo.affectedFiles.length}`,
  ].join(' | ');

  // --- Advisory context: never a silent drop -------------------------------
  const advisories: string[] = [];

  const focusOpLabels = new Set(ops.map(o => o.label));
  const focusWasSeeded =
    focusOpLabels.has('focus-seed') ||
    focusOpLabels.has('focus-seed-insert') ||
    focusOpLabels.has('focus-seed-new-section');

  if (sections.current !== null) {
    advisories.push(
      `Current Focus unchanged ("${sections.current.title}" is still active) -- new goal "${planInfo.title}" was NOT recorded there. Run /roadmap focus to switch.`,
    );
  } else if (!focusWasSeeded) {
    advisories.push(
      `Current Focus left vacant -- "${planInfo.title}" did not pass the seed quality gate (looks like a placeholder or filename-derived title). Run /roadmap focus to set it manually.`,
    );
  }

  const sessionAdded = ops.some(o => o.label.startsWith('session-insert'));
  const totalSessionBlocks = sections.sessions.length + (sessionAdded ? 1 : 0);
  if (totalSessionBlocks > 8) {
    advisories.push(
      `Recent Planning Sessions now has ${totalSessionBlocks} entries -- consider an archive sweep into ROADMAP.archive.md.`,
    );
  }

  const contextLines: string[] =
    outcome === 'written'
      ? ['Planning session recorded:', stats, `ROADMAP: ${roadmapPath}`]
      : [
          `ROADMAP entry NOT recorded (outcome: ${outcome}${record.reason ? `, reason: ${record.reason}` : ''}).`,
          stats,
          `ROADMAP: ${roadmapPath}`,
        ];
  contextLines.push(...advisories);

  const output = {
    result: 'continue',
    message:
      outcome === 'written'
        ? `📋 ROADMAP.md updated: ${planInfo.title}`
        : `⚠️ ROADMAP.md NOT updated (${outcome}): ${planInfo.title}`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: contextLines.join('\n'),
    },
  };

  console.log(JSON.stringify(output));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000).unref();
  });
}

main().catch(err => {
  console.error('[post-plan-roadmap] Error:', err.message);
  console.log(JSON.stringify({ result: 'continue' }));
});
