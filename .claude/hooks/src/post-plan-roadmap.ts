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

interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
  tool_result?: string;
}

// PlanningSession + parseRoadmap moved to shared/roadmap-parser.ts (Phase 3A).
type PlanningSession = SharedPlanningSession;
type RoadmapSection = RoadmapDoc;

/**
 * Render one managed section's body lines VERBATIM — the `## Header` line plus
 * its content, with NO trailing-blank normalization. This is the exact
 * per-section emit the pre-refactor generateRoadmap produced (sessions
 * sub-blocks keep their own trailing blanks). Used by both generateRoadmap
 * (byte-for-byte fresh-file output) and renderManagedSection (splice form).
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
      }
    } else {
      lines.push('_No planning sessions recorded._');
    }
  }

  return lines;
}

/**
 * Render a single managed section's lines, INCLUDING its `## Header` line and
 * exactly one trailing blank line.
 *
 * The body byte-matches what generateRoadmap emits for that section; the
 * uniform single trailing blank lets applyRoadmapUpdate splice sections in
 * place without accumulating or dropping blank lines.
 */
function renderManagedSection(
  key: 'current' | 'completed' | 'planned' | 'sessions',
  sections: RoadmapSection,
): string[] {
  const lines = renderSectionBody(key, sections);
  // Collapse any trailing blanks (sessions sub-blocks may leave one) to exactly one.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push('');
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
 * Regenerate ONLY the 4 managed sections in place, splicing every other line
 * (intro prose, `## Notes` / custom sections, loose prose) back verbatim from
 * the original file. Uses the parser's rawSections line-range map.
 *
 * Pure: depends only on `sections.rawContent` (original text) and
 * `sections.rawSections` (original line ranges — unaffected by main()'s later
 * mutation of the structured fields), plus the mutated structured fields the
 * managed sections are regenerated from.
 */
export function applyRoadmapUpdate(sections: RoadmapDoc): string {
  const original = sections.rawContent;
  if (!original.trim()) return generateRoadmap(sections);   // fresh/empty file -> canonical

  const lines = original.split('\n');
  const MANAGED: Array<'current' | 'completed' | 'planned' | 'sessions'> = ['current', 'completed', 'planned', 'sessions'];

  // present managed ranges, sorted by original start line
  const present = MANAGED
    .map(key => ({ key, range: sections.rawSections.get(key) }))
    .filter(x => x.range)
    .sort((a, b) => a.range!.start - b.range!.start);

  const out: string[] = [];
  let cursor = 0;
  for (const { key, range } of present) {
    // verbatim unmanaged lines before this managed section (preamble / custom sections / loose prose)
    for (let i = cursor; i < range!.start; i++) out.push(lines[i]);
    // regenerated managed block in place
    out.push(...renderManagedSection(key, sections));
    cursor = range!.end;
  }
  // trailing verbatim content after the last managed section
  for (let i = cursor; i < lines.length; i++) out.push(lines[i]);

  // append any managed section that did not exist in the original (canonical order)
  for (const key of MANAGED) {
    if (!sections.rawSections.get(key)) out.push(...renderManagedSection(key, sections));
  }
  return out.join('\n');
}

export function demoteCurrentFocusToPlanned(sections: RoadmapDoc, newTitle: string): void {
  if (!sections.current || sections.current.title === newTitle) return;
  const old = sections.current;
  if (sections.planned.some(p => p.title === old.title)) return; // dedup
  // Switching focus ≠ finishing the prior goal — return it to the backlog.
  sections.planned.unshift({ title: old.title, priority: 'high', priorityBucket: 'high' });
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

function extractBullets(content: string, keywords?: string[]): string[] {
  const bullets: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('-') && !trimmed.startsWith('*') && !trimmed.match(/^\d+\./)) {
      continue;
    }

    const bulletText = trimmed.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim();
    if (!bulletText) continue;

    // Skip checkbox syntax but keep content
    let cleanText = bulletText.replace(/^\[[ x]\]\s*/i, '');

    // Clean up markdown formatting artifacts
    cleanText = cleanText
      .replace(/^\*\*([^*]+)\*\*:?\s*/, '$1: ')  // **Bold:** → Bold:
      .replace(/^`([^`]+)`\s*[-–]\s*/, '')       // `code` - description → description
      .replace(/^\*([^*]+)\*:?\s*/g, '$1 ')      // *Italic* → Italic (global)
      .replace(/::\s*\*/g, ': ')                 // ::* → :
      .replace(/\*\s+/g, ' ')                    // trailing * → space
      .replace(/\s+/g, ' ')                      // normalize whitespace
      .trim();

    // Skip if too short (likely markdown fragments) or starts with special chars
    if (cleanText.length < 15) continue;
    if (cleanText.startsWith('|') || cleanText.startsWith('```')) continue;

    // Skip pure code references without context
    if (cleanText.match(/^`[^`]+`$/) || cleanText.match(/^[A-Za-z_]+\.[a-z]+$/)) continue;

    // Skip lines that are mostly placeholders/variables
    if (cleanText.match(/\{[^}]+\}/) && cleanText.length < 50) continue;

    if (keywords) {
      const lower = cleanText.toLowerCase();
      if (keywords.some(kw => lower.includes(kw))) {
        bullets.push(cleanText);
      }
    } else {
      bullets.push(cleanText);
    }
  }

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

function extractPlanInfo(planContent: string, filePath?: string): PlanInfo {
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

  // Extract decisions with expanded keywords
  const decisionSection = sections['decisions'] || sections['key decisions'] || sections['approach'] || '';
  let decisions = extractBullets(decisionSection);
  if (decisions.length === 0) {
    // Fallback to keyword matching across entire content
    decisions = extractBullets(planContent, CAPTURE_KEYWORDS);
  }

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

  const today = new Date().toISOString().split('T')[0];

  if (planInfo.title && planInfo.title !== 'Planning Session') {
    demoteCurrentFocusToPlanned(sections, planInfo.title);   // was: sections.completed.unshift(...)
    sections.current = {
      title: planInfo.title,
      description: planInfo.decisions.slice(0, 2).join('; ') || '',
      started: today,
    };
  }

  const newSession: PlanningSession = {
    date: today,
    title: planInfo.title,
    summary: planInfo.summary || undefined,
    decisions: planInfo.decisions.slice(0, 5),
    steps: planInfo.steps.length > 0 ? planInfo.steps.slice(0, 5) : undefined,
    verification: planInfo.verification.length > 0 ? planInfo.verification.slice(0, 3) : undefined,
    files: planInfo.affectedFiles.length > 0 ? planInfo.affectedFiles.slice(0, 8) : undefined,
  };

  const existingToday = sections.sessions.findIndex(s => s.date === today);
  if (existingToday >= 0) {
    sections.sessions[existingToday] = newSession;
  } else {
    sections.sessions.unshift(newSession);
  }

  sections.sessions = sections.sessions.slice(0, 5);

  const newContent = applyRoadmapUpdate(sections);
  fs.mkdirSync(path.dirname(roadmapPath), { recursive: true });
  fs.writeFileSync(roadmapPath, newContent, 'utf-8');

  console.error(`[post-plan-roadmap] ROADMAP.md updated: ${planInfo.title}`);

  // Store planning decisions in archival_memory for future recall
  storePlanningLearnings(planInfo, projectDir);

  const stats = [
    `Goal: ${planInfo.title}`,
    `Decisions: ${planInfo.decisions.length}`,
    `Steps: ${planInfo.steps.length}`,
    `Files: ${planInfo.affectedFiles.length}`,
  ].join(' | ');

  const output = {
    result: 'continue',
    message: `📋 ROADMAP.md updated: ${planInfo.title}`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Planning session recorded:\n${stats}\nROADMAP: ${roadmapPath}`
    }
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
