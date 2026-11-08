import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { getProjectIdentity, isContentRelevantToProject } from './shared/project-relevance.js';
import { sanitizeMemoryContent, wrapMemoryContext } from './shared/memory-sanitize.js';
import { buildHandoffPointer, handoffSkipReason, selectSessionHandoff } from './shared/handoff-select.js';
import { previousFromClear, readIdentity } from './shared/session-identity.js';

interface SessionStartInput {
  type?: 'startup' | 'resume' | 'clear' | 'compact';  // Legacy field
  source?: 'startup' | 'resume' | 'clear' | 'compact'; // Per docs
  session_id: string;
  cwd?: string;
}

// The 7-day stale rule and the terminal-outcome rule live in shared/handoff-select.ts.

// ============================================
// UUID ISOLATION: Path construction & parsing
// ============================================

/**
 * Build handoff directory name with UUID suffix for isolation.
 * Format: {sessionName}-{first8CharsOfUUID}
 * Example: "auth-refactor-550e8400"
 */
export function buildHandoffDirName(sessionName: string, sessionId: string): string {
  const uuidShort = sessionId.replace(/-/g, '').slice(0, 8);
  return `${sessionName}-${uuidShort}`;
}

/**
 * Parse handoff directory name to extract session name and UUID suffix.
 * Returns { sessionName, uuidShort } where uuidShort is null for legacy dirs.
 */
export function parseHandoffDirName(dirName: string): { sessionName: string; uuidShort: string | null } {
  // Check if ends with -[8 hex chars]
  const match = dirName.match(/^(.+)-([0-9a-f]{8})$/i);
  if (match) {
    return { sessionName: match[1], uuidShort: match[2].toLowerCase() };
  }
  // Legacy format: no UUID suffix
  return { sessionName: dirName, uuidShort: null };
}

/**
 * Find handoff with UUID isolation support.
 * Priority:
 * 1. Exact UUID match: {sessionName}-{uuidShort}/
 * 2. Legacy path: {sessionName}/
 * 3. Any other UUID-suffixed dir for same session name (fallback)
 */
export function findSessionHandoffWithUUID(sessionName: string, sessionId: string): string | null {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const handoffsBase = path.join(projectDir, 'thoughts', 'shared', 'handoffs');

  if (!fs.existsSync(handoffsBase)) return null;

  const uuidShort = sessionId.replace(/-/g, '').slice(0, 8).toLowerCase();

  // Priority 1: Exact UUID match
  const exactDir = path.join(handoffsBase, `${sessionName}-${uuidShort}`);
  if (fs.existsSync(exactDir)) {
    return findMostRecentMdFile(exactDir);
  }

  // Priority 2: Legacy path (no UUID suffix)
  const legacyDir = path.join(handoffsBase, sessionName);
  if (fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory()) {
    const result = findMostRecentMdFile(legacyDir);
    if (result) return result;
  }

  // Priority 3: Any UUID-suffixed dir for same session name
  const allDirs = fs.readdirSync(handoffsBase).filter(d => {
    const stat = fs.statSync(path.join(handoffsBase, d));
    if (!stat.isDirectory()) return false;
    const { sessionName: parsedName } = parseHandoffDirName(d);
    return parsedName === sessionName;
  });

  // Sort by mtime (most recent first)
  allDirs.sort((a, b) => {
    const statA = fs.statSync(path.join(handoffsBase, a));
    const statB = fs.statSync(path.join(handoffsBase, b));
    return statB.mtime.getTime() - statA.mtime.getTime();
  });

  for (const dir of allDirs) {
    const result = findMostRecentMdFile(path.join(handoffsBase, dir));
    if (result) return result;
  }

  return null;
}

/**
 * Check if file is a handoff file (.md, .yaml, .yml)
 */
function isHandoffFile(filename: string): boolean {
  return filename.endsWith('.md') || filename.endsWith('.yaml') || filename.endsWith('.yml');
}

/**
 * Find most recent handoff file (.md, .yaml, .yml) in a directory by mtime.
 */
function findMostRecentMdFile(dirPath: string): string | null {
  if (!fs.existsSync(dirPath)) return null;

  const handoffFiles = fs.readdirSync(dirPath)
    .filter(f => isHandoffFile(f))
    .sort((a, b) => {
      const statA = fs.statSync(path.join(dirPath, a));
      const statB = fs.statSync(path.join(dirPath, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });

  return handoffFiles.length > 0 ? path.join(dirPath, handoffFiles[0]) : null;
}

/**
 * Extract goal and now from YAML handoff content.
 * Returns { goal, now } or null if neither found.
 */
export function extractYamlFields(content: string): { goal: string; now: string } | null {
  const goalMatch = content.match(/^goal:\s*(.+)$/m);
  const nowMatch = content.match(/^now:\s*(.+)$/m);

  if (!goalMatch && !nowMatch) return null;

  return {
    goal: goalMatch ? goalMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    now: nowMatch ? nowMatch[1].trim().replace(/^["']|["']$/g, '') : ''
  };
}

/**
 * Extract the Ledger section from handoff content.
 * Matches from "## Ledger" to the first "---" separator or next "## " heading (but not ### subsections).
 * Returns the full Ledger section with header, or null if not found.
 */
export function extractLedgerSection(handoffContent: string): string | null {
  // (?:^|\n) - match start of string or after newline
  // ## Ledger\n - the section header
  // ([\s\S]*?) - capture content (non-greedy)
  // (?=\n---\n|\n## [^#]|$) - stop at:
  //   - \n---\n: separator line
  //   - \n## [^#]: another ## heading (but not ### which starts with ##)
  //   - $: end of string
  const match = handoffContent.match(/(?:^|\n)## Ledger\n([\s\S]*?)(?=\n---\n|\n## [^#]|$)/);
  return match ? `## Ledger\n${match[1].trim()}` : null;
}

/**
 * Extract hand-written notes blocks from ROADMAP.md content.
 *
 * For each of `## Notes`, `## For Next Session`, `## Scratch`, matches the
 * header through its body up to the next `## ` header or EOF (mirroring the
 * Current Focus regex in buildUnifiedContext). Returns a
 * `"## <Header>\n<trimmed body>"` block for each header that exists with a
 * non-empty body; `[]` if none.
 */
/**
 * Extract the ROADMAP `## Current Focus` body, gated through the cross-project
 * contamination guard (D2F-03). Returns the trimmed focus body if it passes the
 * guard, or null if the section is absent OR appears to belong to a different
 * project (SEED-02 — a foreign Salesforce/FastMCP focus must not propagate into
 * this project's unified context).
 *
 * Pure + testable: takes the raw ROADMAP content and projectDir, so the guard
 * decision can be tested without invoking buildUnifiedContext's memory-recall
 * side effects.
 */
export function extractGuardedCurrentFocus(roadmapContent: string, projectDir: string): string | null {
  const currentMatch = roadmapContent.match(/## Current Focus\n([\s\S]*?)(?=\n## |$)/);
  if (!currentMatch) return null;
  const currentFocus = currentMatch[1].trim();
  if (!currentFocus) return null;

  const identity = getProjectIdentity(projectDir);
  const relevance = isContentRelevantToProject(currentFocus, identity);
  if (!relevance.relevant) {
    console.error(`[session-start-continuity] buildUnifiedContext: ROADMAP focus appears contaminated, skipping: ${relevance.reason}`);
    return null;
  }
  return currentFocus;
}

export function extractNotesSections(roadmapContent: string): string[] {
  const HEADERS = ['Notes', 'For Next Session', 'Scratch'];
  const blocks: string[] = [];
  for (const header of HEADERS) {
    const re = new RegExp(`## ${header}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = roadmapContent.match(re);
    if (match) {
      const body = match[1].trim();
      if (body) {
        blocks.push(`## ${header}\n${body}`);
      }
    }
  }
  return blocks;
}

/**
 * Find the most recent handoff file for a given session.
 * Looks in thoughts/shared/handoffs/{sessionName}/ directory.
 * Returns absolute path to the most recent handoff file (.md, .yaml, .yml) by mtime, or null if not found.
 */
export function findSessionHandoff(sessionName: string): string | null {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const handoffDir = path.join(projectDir, 'thoughts', 'shared', 'handoffs', sessionName);

  if (!fs.existsSync(handoffDir)) return null;

  const handoffFiles = fs.readdirSync(handoffDir)
    .filter(f => isHandoffFile(f))
    .sort((a, b) => {
      const statA = fs.statSync(path.join(handoffDir, a));
      const statB = fs.statSync(path.join(handoffDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });

  return handoffFiles.length > 0 ? path.join(handoffDir, handoffFiles[0]) : null;
}

interface HandoffSummary {
  filename: string;
  taskNumber: string;
  status: string;
  summary: string;
  isAutoHandoff: boolean;
}

/**
 * Prune ledger to prevent bloat:
 * 1. Remove all "Session Ended" entries
 * 2. Keep only the last 10 agent reports
 */
function pruneLedger(ledgerPath: string): void {
  let content = fs.readFileSync(ledgerPath, 'utf-8');
  const originalLength = content.length;

  // 1. Remove all "Session Ended" entries
  content = content.replace(/\n### Session Ended \([^)]+\)\n- Reason: \w+\n/g, '');

  // 2. Keep only the last 10 agent reports
  const agentReportsMatch = content.match(/## Agent Reports\n([\s\S]*?)(?=\n## |$)/);
  if (agentReportsMatch) {
    const agentReportsSection = agentReportsMatch[0];
    const reports = agentReportsSection.match(/### [^\n]+ \(\d{4}-\d{2}-\d{2}[^)]*\)[\s\S]*?(?=\n### |\n## |$)/g);

    if (reports && reports.length > 10) {
      // Keep only the last 10 reports
      const keptReports = reports.slice(-10);
      const newAgentReportsSection = '## Agent Reports\n' + keptReports.join('');
      content = content.replace(agentReportsSection, newAgentReportsSection);
    }
  }

  // Only write if content changed
  if (content.length !== originalLength) {
    fs.writeFileSync(ledgerPath, content);
    console.error(`Pruned ledger: ${originalLength} → ${content.length} bytes`);
  }
}

function getLatestHandoff(handoffDir: string): HandoffSummary | null {
  if (!fs.existsSync(handoffDir)) return null;

  // Match any handoff files (.md, .yaml, .yml) — no prefix filter
  const handoffFiles = fs.readdirSync(handoffDir)
    .filter(f => isHandoffFile(f))
    .sort((a, b) => {
      // Sort by modification time (most recent first)
      const statA = fs.statSync(path.join(handoffDir, a));
      const statB = fs.statSync(path.join(handoffDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });

  if (handoffFiles.length === 0) return null;

  const latestFile = handoffFiles[0];
  const content = fs.readFileSync(path.join(handoffDir, latestFile), 'utf-8');
  const isAutoHandoff = latestFile.startsWith('auto-handoff-');

  // Extract key info from handoff based on type
  let taskNumber: string;
  let status: string;
  let summary: string;

  if (isAutoHandoff) {
    // Auto-handoff format: type: auto-handoff in frontmatter
    const typeMatch = content.match(/type:\s*auto-handoff/i);
    status = typeMatch ? 'auto-handoff' : 'unknown';

    // Extract timestamp from filename as "task number"
    const timestampMatch = latestFile.match(/auto-handoff-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
    taskNumber = timestampMatch ? timestampMatch[1] : 'auto';

    // Get summary from In Progress section
    const inProgressMatch = content.match(/## In Progress\n([\s\S]*?)(?=\n## |$)/);
    summary = inProgressMatch
      ? inProgressMatch[1].trim().split('\n').slice(0, 3).join('; ').substring(0, 150)
      : 'Auto-handoff from pre-compact';
  } else {
    // Task handoff format: status: success/partial/blocked
    const taskMatch = latestFile.match(/task-(\d+)/);
    taskNumber = taskMatch ? taskMatch[1] : '??';

    const statusMatch = content.match(/status:\s*(success|partial|blocked)/i);
    status = statusMatch ? statusMatch[1] : 'unknown';

    const summaryMatch = content.match(/## What Was Done\n([\s\S]*?)(?=\n## |$)/);
    summary = summaryMatch
      ? summaryMatch[1].trim().split('\n').slice(0, 2).join('; ').substring(0, 150)
      : 'No summary available';
  }

  return {
    filename: latestFile,
    taskNumber,
    status,
    summary,
    isAutoHandoff
  };
}

// Artifact Index precedent query removed - redundant with:
// 1. Learnings now compounded into .claude/rules/ (permanent)
// 2. Ledger already provides session context
// 3. Hierarchical --learn uses handoff context at extraction time
// Kept: unmarked outcomes prompt (drives data quality)

interface UnmarkedHandoff {
  id: string;
  session_name: string;
  task_number: string | null;
  task_summary: string;
}

interface UnifiedContextOptions {
  /** The caller already injects the ROADMAP Current Focus block. */
  skipRoadmapFocus?: boolean;
  /** Skip the `uv run` memory recall (5 s timeout). */
  skipRecall?: boolean;
}

async function buildUnifiedContext(projectDir: string, opts: UnifiedContextOptions = {}): Promise<string> {
  const sections: string[] = [];
  let currentGoal = '';

  // 1. ROADMAP Current Focus + Recent Planning
  const roadmapPath = path.join(projectDir, 'ROADMAP.md');
  if (fs.existsSync(roadmapPath)) {
    try {
      const roadmap = fs.readFileSync(roadmapPath, 'utf-8');

      // Extract Current Focus section -- gated by the cross-project
      // contamination guard (D2F-03). A foreign focus is dropped, never
      // re-injected into the unified context.
      const guardedFocus = extractGuardedCurrentFocus(roadmap, projectDir);
      if (guardedFocus) {
        const focusSection = `## ROADMAP - Current Focus\n${guardedFocus.substring(0, 500)}`;
        currentGoal = focusSection.match(/\*\*([^*]+)\*\*/)?.[1] ?? '';
        if (!opts.skipRoadmapFocus) sections.push(focusSection);
      }

      // Extract most recent planning session
      const sessionMatch = roadmap.match(/### (\d{4}-\d{2}-\d{2}): ([^\n]+)\n([\s\S]*?)(?=\n### |\n## |$)/);
      if (sessionMatch) {
        const sessionContent = sessionMatch[3].substring(0, 400);
        sections.push(`## Recent Planning: ${sessionMatch[2]}\n${sessionContent}`);
      }

      // Surface hand-written notes (## Notes / ## For Next Session / ## Scratch)
      // preserved across plan-approval regeneration.
      const roadmapNotes = extractNotesSections(roadmap);
      for (const note of roadmapNotes) {
        const [header, ...body] = note.split('\n');
        sections.push(`## ROADMAP - ${header.replace(/^##\s*/, '')}\n${body.join('\n').substring(0, 800)}`);
      }
    } catch (error) {
      console.error(`Warning: Error reading ROADMAP.md for unified context: ${error}`);
    }
  }

  // 2. Knowledge Tree Navigation
  const treePath = path.join(projectDir, '.claude', 'knowledge-tree.json');
  if (fs.existsSync(treePath)) {
    try {
      const treeContent = fs.readFileSync(treePath, 'utf-8');
      const tree = JSON.parse(treeContent);

      // Quick access navigation
      if (tree.navigation?.common_tasks) {
        const taskNav = Object.entries(tree.navigation.common_tasks)
          .slice(0, 5)
          .map(([task, paths]) => `- ${task}: ${(paths as string[]).slice(0, 2).join(', ')}`)
          .join('\n');
        if (taskNav) {
          sections.push(`## Quick Navigation\n${taskNav}`);
        }
      }

      // Entry points
      if (tree.navigation?.entry_points) {
        const entries = Object.entries(tree.navigation.entry_points)
          .slice(0, 3)
          .map(([name, p]) => `- ${name}: ${p}`)
          .join('\n');
        if (entries) {
          sections.push(`## Entry Points\n${entries}`);
        }
      }
    } catch (error) {
      // Ignore JSON parsing errors
    }
  }

  // 3. Relevant Memories based on current goal
  if (currentGoal && !opts.skipRecall) {
    const opcDir = process.env.CLAUDE_OPC_DIR || path.join(process.env.USERPROFILE || '', '.claude');
    try {
      const queryText = currentGoal.replace(/"/g, '').substring(0, 100);
      const proc = spawnSync('uv', [
        'run', 'python', 'scripts/core/recall_learnings.py',
        '--query', queryText, '--k', '3', '--text-only'
      ], {
        cwd: opcDir,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONPATH: '.' },
      });

      const result = proc.stdout || '';
      if (result && !result.includes('No results') && result.trim().length > 20) {
        // D5b-01: archival_memory recall is untrusted (auto-extracted; can be
        // poisoned). Sanitize + wrap as data-only before injecting at session
        // start. Only the recall result is wrapped — the handoff/ledger/ROADMAP
        // sections are the user's OWN trusted files and are left intact.
        sections.push(wrapMemoryContext(`## Relevant Memories\n${sanitizeMemoryContent(result, 600)}`));
      }
    } catch (error) {
      // Memory recall failed, continue without it
    }
  }

  return sections.join('\n\n---\n\n');
}

function getUnmarkedHandoffs(): UnmarkedHandoff[] {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dbPath = path.join(projectDir, '.claude', 'cache', 'artifact-index', 'context.db');

    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT id, session_name, task_number, task_summary FROM handoffs WHERE outcome = 'UNKNOWN' ORDER BY indexed_at DESC LIMIT 5"`,
      { encoding: 'utf-8', timeout: 3000 }
    );

    if (!result.trim()) {
      return [];
    }

    return result.trim().split('\n').map(line => {
      const [id, session_name, task_number, task_summary] = line.split('|');
      return { id, session_name, task_number: task_number || null, task_summary: task_summary || '' };
    });
  } catch (error) {
    return [];
  }
}

/**
 * Session ids whose handoff this SessionStart may load.
 * compact keeps the session id, so it is the one id. /clear changes the id, so the
 * session that ended with "clear" in this cwd (the identity `previous`) counts too.
 */
function ownSessionIds(input: SessionStartInput, sessionType: string | undefined, projectDir: string): string[] {
  const current = input.session_id;
  if (!current || current === 'unknown') return [];
  const ids = [current];
  if (sessionType === 'clear') {
    try {
      const previous = readIdentity(current)?.previous ?? previousFromClear(current, input.cwd || projectDir);
      if (previous) ids.push(previous);
    } catch {
      // No identity data: only the current id counts.
    }
  }
  return ids;
}

async function main() {
  let input: SessionStartInput;
  try {
    const stdin = await readStdin();
    input = stdin ? JSON.parse(stdin) : { session_id: 'unknown', source: 'cli' };
  } catch (e) {
    input = { session_id: 'unknown', source: 'cli' };
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Support both 'source' (per docs) and 'type' (legacy) fields
  const sessionType = input.source || input.type;

  let message = '';
  let additionalContext = '';
  let usedHandoffLedger = false;

  // ============================================
  // NEW: Check handoffs for embedded Ledger sections FIRST
  // ============================================
  const handoffsDir = path.join(projectDir, 'thoughts', 'shared', 'handoffs');
  if (fs.existsSync(handoffsDir)) {
    try {
      const sessionDirs = fs.readdirSync(handoffsDir)
        .filter(d => {
          const stat = fs.statSync(path.join(handoffsDir, d));
          return stat.isDirectory();
        });

      // Find most recent handoff with Ledger section
      let mostRecentLedger: {
        content: string;
        sessionName: string;
        handoffPath: string;
        mtime: number;
        goalSummary: string;
        currentFocus: string;
      } | null = null;

      // compact and clear belong to ONE session: select by session_id, never by mtime
      // across sessions. No match means no handoff (no cross-session fallback).
      const sessionScoped = sessionType === 'compact' || sessionType === 'clear';
      let pointer = '';
      if (sessionScoped) {
        const selected = selectSessionHandoff(handoffsDir, ownSessionIds(input, sessionType, projectDir));
        if (selected) {
          const fields = extractYamlFields(selected.content);
          pointer = buildHandoffPointer(selected.path, selected.content, projectDir);
          mostRecentLedger = {
            content: selected.content,
            sessionName: path.basename(path.dirname(selected.path)),
            handoffPath: selected.path,
            mtime: selected.mtime,
            goalSummary: (fields?.goal || 'No goal found').substring(0, 100),
            currentFocus: fields?.now || 'Unknown'
          };
        }
      }

      for (const sessionName of sessionScoped ? [] : sessionDirs) {
        const handoffPath = findSessionHandoff(sessionName);
        if (handoffPath) {
          const content = fs.readFileSync(handoffPath, 'utf-8');
          const isYaml = handoffPath.endsWith('.yaml') || handoffPath.endsWith('.yml');

          // Try YAML format first for .yaml/.yml files, then markdown format
          let goalSummary = 'No goal found';
          let currentFocus = 'Unknown';
          let ledgerContent = '';

          if (isYaml) {
            // YAML format: extract goal: and now: fields directly
            const yamlFields = extractYamlFields(content);
            if (yamlFields) {
              goalSummary = yamlFields.goal || 'No goal found';
              currentFocus = yamlFields.now || 'Unknown';
              ledgerContent = content; // Use full YAML content as context
            }
          } else {
            // Markdown format: look for ## Ledger section
            const ledgerSection = extractLedgerSection(content);
            if (ledgerSection) {
              const goalMatch = ledgerSection.match(/\*\*Goal:\*\*\s*([^\n]+)/);
              const nowMatch = ledgerSection.match(/### Now\n\[?-?>?\]?\s*([^\n]+)/);
              goalSummary = goalMatch ? goalMatch[1].trim().substring(0, 100) : 'No goal found';
              currentFocus = nowMatch ? nowMatch[1].trim() : 'Unknown';
              ledgerContent = ledgerSection;
            }
          }

          // Only process if we found content
          if (ledgerContent || (isYaml && (goalSummary !== 'No goal found' || currentFocus !== 'Unknown'))) {
            const mtime = fs.statSync(handoffPath).mtime.getTime();

            // Skip stale (over 7 days) and terminal (complete, SUCCEEDED, FAILED) handoffs
            // on every source. PARTIAL_PLUS and PARTIAL_MINUS stay resumable.
            const skipReason = handoffSkipReason(content, mtime);
            if (skipReason) {
              console.error(`Skipping ${skipReason} handoff: ${sessionName}`);
              continue;
            }

            if (!mostRecentLedger || mtime > mostRecentLedger.mtime) {
              mostRecentLedger = {
                content: ledgerContent || content,
                sessionName,
                handoffPath,
                mtime,
                goalSummary: goalSummary.substring(0, 100),
                currentFocus
              };
            }
          }
        }
      }

      // ============================================
      // ROADMAP: Primary context source (explicit "what we did, what's next")
      // ============================================
      const roadmapPath = path.join(projectDir, 'ROADMAP.md');
      let roadmapCurrentFocus = '';
      let roadmapContext = '';

      if (fs.existsSync(roadmapPath)) {
        try {
          const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');

          // Extract Current Focus section
          const currentMatch = roadmapContent.match(/## Current Focus\n([\s\S]*?)(?=\n## |$)/);
          if (currentMatch) {
            const currentSection = currentMatch[1].trim();
            // Get the first line (the main focus item, usually **bold**)
            const firstLine = currentSection.split('\n')[0];
            roadmapCurrentFocus = firstLine.replace(/\*\*/g, '').trim();
            roadmapContext = `## ROADMAP - Current Focus\n${currentSection}`;

            // Cross-project contamination guard
            const identity = getProjectIdentity(projectDir);
            const relevance = isContentRelevantToProject(roadmapCurrentFocus, identity);
            if (!relevance.relevant) {
              console.error(`[session-start-continuity] ROADMAP focus appears contaminated: ${relevance.reason}`);
              roadmapCurrentFocus = '';
              roadmapContext = '';
            }
          }
        } catch (error) {
          console.error(`Warning: Error reading ROADMAP.md: ${error}`);
        }
      }

      if (mostRecentLedger) {
        usedHandoffLedger = true;
        const { sessionName, goalSummary, currentFocus, handoffPath } = mostRecentLedger;
        const handoffFilename = path.basename(handoffPath);

        if (sessionType === 'startup') {
          // Fresh startup: prefer ROADMAP if available, otherwise handoff
          if (roadmapCurrentFocus) {
            message = `📍 Current: ${roadmapCurrentFocus} | 📋 Handoff: ${sessionName} (run /resume_handoff)`;
          } else {
            message = `📋 Handoff Ledger: ${sessionName} → ${currentFocus} (run /resume_handoff to continue)`;
          }
        } else {
          // resume/clear/compact. Resume only shows a banner.
          console.error(`✓ Handoff loaded: ${sessionName} → ${currentFocus}`);
          message = `[${sessionType}] Loaded from handoff: ${handoffFilename} | Goal: ${goalSummary} | Focus: ${currentFocus}`;

          if (sessionScoped) {
            // This session's own handoff: ROADMAP focus once, then a short pointer.
            // No full YAML, no deprecated `handoffs` table nag.
            if (roadmapContext) {
              additionalContext = `${roadmapContext}\n\n---\n\n`;
            }
            additionalContext += pointer;
          }
        }
      }
      // If no fresh handoff found but ROADMAP exists, use ROADMAP as primary context
      if (!mostRecentLedger && roadmapCurrentFocus) {
        usedHandoffLedger = true; // Prevent falling through to legacy ledger
        if (sessionType === 'startup') {
          message = `📍 Current: ${roadmapCurrentFocus}`;
        } else {
          message = `[${sessionType}] ROADMAP Focus: ${roadmapCurrentFocus}`;
          if (sessionType === 'clear' || sessionType === 'compact') {
            additionalContext = roadmapContext;
          }
        }
      }

      // For all session types, try to build unified context
      if (sessionType === 'startup' || sessionType === 'clear' || sessionType === 'compact') {
        try {
          // clear/compact already carry the ROADMAP focus block above; compact skips the 5 s recall.
          const unifiedContext = await buildUnifiedContext(projectDir, {
            skipRoadmapFocus: sessionScoped,
            skipRecall: sessionType === 'compact',
          });
          if (unifiedContext && unifiedContext.trim().length > 50) {
            if (additionalContext) {
              additionalContext = unifiedContext + '\n\n---\n\n' + additionalContext;
            } else {
              additionalContext = unifiedContext;
            }
          }
        } catch (error) {
          console.error(`Warning: Could not build unified context: ${error}`);
        }
      }
    } catch (error) {
      // Gracefully handle errors scanning handoffs directory
      console.error(`Warning: Error scanning handoffs: ${error}`);
    }
  }

  // ============================================
  // FALLBACK: Legacy ledger files (if no handoff Ledger found)
  // ============================================
  // Not on compact: the newest legacy ledger belongs to no particular session.
  const skipLegacyLedger = (sessionType as string | undefined) === 'compact';
  if (!usedHandoffLedger && !skipLegacyLedger) {
    const ledgerDir = path.join(projectDir, 'thoughts', 'ledgers');
    if (!fs.existsSync(ledgerDir)) {
      // No thoughts/ledgers directory - exit silently (normal for new projects)
      console.log(JSON.stringify({ result: 'continue' }));
      return;
    }
    const ledgerFiles = fs.readdirSync(ledgerDir)
      .filter(f => f.startsWith('CONTINUITY_CLAUDE-') && f.endsWith('.md'))
      .sort((a, b) => {
        const statA = fs.statSync(path.join(ledgerDir, a));
        const statB = fs.statSync(path.join(ledgerDir, b));
        return statB.mtime.getTime() - statA.mtime.getTime();
      });

    if (ledgerFiles.length > 0) {
      // DEPRECATED: Legacy ledger file path
      console.error('DEPRECATED: Using legacy ledger file. Migrate to handoff format with /create_handoff');

      const mostRecent = ledgerFiles[0];
      const ledgerPath = path.join(ledgerDir, mostRecent);

      // Prune ledger before reading to prevent bloat
      pruneLedger(ledgerPath);

      const ledgerContent = fs.readFileSync(ledgerPath, 'utf-8');

      // Extract key sections for summary
      const goalMatch = ledgerContent.match(/## Goal\n([\s\S]*?)(?=\n## |$)/);
      const nowMatch = ledgerContent.match(/- Now: ([^\n]+)/);

      const goalSummary = goalMatch
        ? goalMatch[1].trim().split('\n')[0].substring(0, 100)
        : 'No goal found';

      const currentFocus = nowMatch
        ? nowMatch[1].trim()
        : 'Unknown';

      const sessionName = mostRecent.replace('CONTINUITY_CLAUDE-', '').replace('.md', '');

      // Check for handoff directory
      const handoffDir = path.join(projectDir, 'thoughts', 'shared', 'handoffs', sessionName);
      const latestHandoff = getLatestHandoff(handoffDir);

      if (sessionType === 'startup') {
        // Fresh startup: just notify ledger exists, don't load full context
        let startupMsg = `📋 Ledger available: ${sessionName} → ${currentFocus}`;
        if (latestHandoff) {
          if (latestHandoff.isAutoHandoff) {
            startupMsg += ` | Last handoff: auto (${latestHandoff.status})`;
          } else {
            startupMsg += ` | Last handoff: task-${latestHandoff.taskNumber} (${latestHandoff.status})`;
          }
        }
        startupMsg += ' (run /resume_handoff to continue)';
        message = startupMsg;
      } else {
        // resume/clear/compact: load full context
        console.error(`✓ Ledger loaded: ${sessionName} → ${currentFocus}`);
        message = `[${sessionType}] Loaded: ${mostRecent} | Goal: ${goalSummary} | Focus: ${currentFocus}`;

        // For clear/compact, provide full ledger content as additional context
        if (sessionType === 'clear' || sessionType === 'compact') {
          additionalContext = `Continuity ledger loaded from ${mostRecent}:\n\n${ledgerContent}`;

          // Check for unmarked handoffs and prompt user to mark outcomes
          const unmarkedHandoffs = getUnmarkedHandoffs();
          if (unmarkedHandoffs.length > 0) {
            additionalContext += `\n\n---\n\n## Unmarked Session Outcomes\n\n`;
            additionalContext += `The following handoffs have no outcome marked. Consider marking them to improve future session recommendations:\n\n`;
            for (const h of unmarkedHandoffs) {
              const taskLabel = h.task_number ? `task-${h.task_number}` : 'handoff';
              const summaryPreview = h.task_summary ? h.task_summary.substring(0, 60) + '...' : '(no summary)';
              additionalContext += `- **${h.session_name}/${taskLabel}** (ID: \`${h.id.substring(0, 8)}\`): ${summaryPreview}\n`;
            }
            additionalContext += `\nTo mark an outcome:\n\`\`\`bash\ncd ~/.claude && uv run python scripts/core/artifact_mark.py --handoff <ID> --outcome SUCCEEDED|PARTIAL_PLUS|PARTIAL_MINUS|FAILED\n\`\`\`\n`;
          }

          // Add handoff context if available
          if (latestHandoff) {
            const handoffPath = path.join(handoffDir, latestHandoff.filename);
            const handoffContent = fs.readFileSync(handoffPath, 'utf-8');

            const handoffLabel = latestHandoff.isAutoHandoff ? 'Latest auto-handoff' : 'Latest task handoff';
            additionalContext += `\n\n---\n\n${handoffLabel} (${latestHandoff.filename}):\n`;
            additionalContext += `Status: ${latestHandoff.status}${latestHandoff.isAutoHandoff ? '' : ` | Task: ${latestHandoff.taskNumber}`}\n\n`;

            // Include truncated handoff content (first 2000 chars)
            const truncatedHandoff = handoffContent.length > 2000
              ? handoffContent.substring(0, 2000) + '\n\n[... truncated, read full file if needed]'
              : handoffContent;
            additionalContext += truncatedHandoff;

            // List other handoffs in directory
            const allHandoffs = fs.readdirSync(handoffDir)
              .filter(f => (f.startsWith('task-') || f.startsWith('auto-handoff-')) && isHandoffFile(f))
              .sort((a, b) => {
                // Sort by modification time (most recent first)
                const statA = fs.statSync(path.join(handoffDir, a));
                const statB = fs.statSync(path.join(handoffDir, b));
                return statB.mtime.getTime() - statA.mtime.getTime();
              });
            if (allHandoffs.length > 1) {
              additionalContext += `\n\n---\n\nAll handoffs in ${handoffDir}:\n`;
              allHandoffs.forEach(f => {
                additionalContext += `- ${f}\n`;
              });
            }
          }

          // Learnings are now extracted via --learn and compounded via /compound-learnings skill
          // No need to surface raw learnings at SessionStart - they become permanent rules
        }
      }
    } else {
      // No ledger found
      if (sessionType !== 'startup') {
        console.error(`⚠ No ledger found. Run /continuity_ledger to track session state.`);
        message = `[${sessionType}] No ledger found. Consider running /continuity_ledger to track session state.`;
      }
      // For startup without ledger, stay silent (normal case)
    }
  }

  // Load local project memory summary if available
  const memoryIndexPath = path.join(projectDir, '.claude', 'memory', 'index.json');
  if (fs.existsSync(memoryIndexPath)) {
    try {
      const indexContent = fs.readFileSync(memoryIndexPath, 'utf-8');
      const index = JSON.parse(indexContent);
      const sessionCount = Object.keys(index.sessions || {}).length;
      const topicCount = Object.keys(index.topic_index || {}).length;

      if (sessionCount > 0 || topicCount > 0) {
        const memorySummary = `\n\n---\n\n## Local Project Memory\n\n` +
          `Sessions indexed: ${sessionCount} | Topics: ${topicCount}\n` +
          `Query with: \`uv run python ~/.claude/scripts/core/core/project_memory.py query "<topic>" --project-dir "${projectDir}"\``;

        if (additionalContext) {
          additionalContext += memorySummary;
        } else if (sessionType === 'clear' || sessionType === 'compact') {
          additionalContext = memorySummary;
        }
      }
    } catch {
      // Ignore index parsing errors
    }
  }

  // Output with proper format per Claude Code docs
  const output: Record<string, unknown> = { result: 'continue' };

  if (message) {
    output.message = message;
    output.systemMessage = message;  // Try both fields for visibility
  }

  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: additionalContext
    };
  }

  console.log(JSON.stringify(output));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    // Fallback so importing this module in a test (which runs top-level main())
    // can't hang waiting on a stdin 'end' that never arrives. Mirrors
    // git-commit-roadmap.ts:57.
    setTimeout(() => resolve(data), 1000).unref();
  });
}

main().catch((err) => {
  console.error(err);
  console.log(JSON.stringify({ result: 'continue' }));
});
