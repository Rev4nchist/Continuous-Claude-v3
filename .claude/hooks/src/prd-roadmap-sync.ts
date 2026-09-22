#!/usr/bin/env node
/**
 * PRD/Tasks → ROADMAP Sync Hook
 *
 * Syncs ai-dev-tasks workflow with ROADMAP.md:
 *
 * 1. PRD Created → Adds to ROADMAP "Planned" section
 * 2. Tasks Started → Moves to ROADMAP "Current" section
 * 3. Tasks Completed → Moves to ROADMAP "Completed" section
 *
 * Triggers: PostToolUse (Write|Edit) for files matching:
 *   - prd-*.md, PRD-*.md
 *   - tasks-*.md, TASKS-*.md
 *
 * Hook: PostToolUse (Write|Edit)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseRoadmap, type RoadmapItem as SharedRoadmapItem } from './shared/roadmap-parser.js';
import { isPathInsideProject, isTasksRelatedToGoal, localDateStamp } from './shared/roadmap-sync-guards.js';
import { writeRoadmapGuarded } from './shared/roadmap-audit.js';
import { insertUnderSection } from './shared/roadmap-splice.js';

/**
 * A content edit plus the lines it INTENDS to remove.
 *
 * `writeRoadmapGuarded`'s deletion-free invariant needs an allowlist that is
 * DERIVED FROM THE OPERATION, never from the observed diff -- an allowlist
 * built by looking at what actually disappeared would permit anything and make
 * the guard vacuous. So each helper below declares its own removals.
 */
interface RoadmapEdit {
  content: string;
  /** Exact lines this edit deliberately removes. Empty for pure appends. */
  removed: string[];
}

interface PostToolUseInput {
  tool_name: string;
  tool_input: {
    file_path?: string;
    content?: string;
  };
  tool_result?: string;
}

interface HookOutput {
  result: 'continue' | 'block';
  message?: string;
}

interface PRDMetadata {
  title: string;
  status: string;
  priority: string;
  version: string;
  created: string;
}

interface TaskProgress {
  featureName: string;
  prdFile: string | null;
  total: number;
  completed: number;
  percentage: number;
  isComplete: boolean;
}

// RoadmapItem now lives in shared/roadmap-parser.ts (Phase 3A).
type RoadmapItem = SharedRoadmapItem;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 100).unref();
  });
}

function isPRDFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return basename.startsWith('prd-') && basename.endsWith('.md');
}

function isTasksFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return basename.startsWith('tasks-') && basename.endsWith('.md');
}

function extractPRDMetadata(content: string): PRDMetadata {
  const result: PRDMetadata = {
    title: 'Untitled PRD',
    status: 'Draft',
    priority: 'Normal',
    version: '1.0',
    created: localDateStamp(),
  };

  const lines = content.split('\n');

  for (const line of lines) {
    const stripped = line.trim();

    // Title from # heading
    if (stripped.startsWith('# ') && result.title === 'Untitled PRD') {
      result.title = stripped.slice(2).trim();
    }

    // Metadata fields
    if (stripped.toLowerCase().startsWith('**status:**')) {
      result.status = stripped.replace(/^\*\*status:\*\*/i, '').trim();
    }
    if (stripped.toLowerCase().startsWith('**priority:**')) {
      result.priority = stripped.replace(/^\*\*priority:\*\*/i, '').trim();
    }
    if (stripped.toLowerCase().startsWith('**version:**')) {
      result.version = stripped.replace(/^\*\*version:\*\*/i, '').trim();
    }
    if (stripped.toLowerCase().startsWith('**created:**')) {
      result.created = stripped.replace(/^\*\*created:\*\*/i, '').trim();
    }
  }

  return result;
}

function extractTaskProgress(content: string, filePath: string): TaskProgress {
  const basename = path.basename(filePath);
  const featureMatch = basename.match(/tasks?-(.+)\.md/i);
  const featureName = featureMatch ? featureMatch[1].replace(/-/g, ' ') : 'Unknown Feature';

  // Find associated PRD
  const dir = path.dirname(filePath);
  const prdPattern = basename.replace(/^tasks?-/i, 'prd-');
  const prdPath = path.join(dir, prdPattern.replace('tasks-', 'PRD-'));
  const prdFile = fs.existsSync(prdPath) ? prdPath : null;

  // Count tasks
  const taskPattern = /^-\s*\[([ x])\]/gm;
  let match;
  let total = 0;
  let completed = 0;

  while ((match = taskPattern.exec(content)) !== null) {
    total++;
    if (match[1].toLowerCase() === 'x') {
      completed++;
    }
  }

  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    featureName,
    prdFile,
    total,
    completed,
    percentage,
    isComplete: total > 0 && completed === total,
  };
}

function findRoadmapPath(startDir: string): string | null {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    // Hard boundary: never walk outside the project
    const roadmap = path.join(projectDir, 'ROADMAP.md');
    if (fs.existsSync(roadmap)) return roadmap;
    const claudeRoadmap = path.join(projectDir, '.claude', 'ROADMAP.md');
    if (fs.existsSync(claudeRoadmap)) return claudeRoadmap;
    // Return project-root path even if it doesn't exist yet (caller creates on write)
    return roadmap;
  }

  // Fallback: find project root first, then look for ROADMAP within it.
  // This prevents escaping the boundary when a parent dir has ROADMAP.md.
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  // Step 1: Walk up to find the project boundary
  let projectRoot: string | null = null;
  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git')) ||
        fs.existsSync(path.join(current, 'package.json'))) {
      projectRoot = current;
      break;
    }
    current = path.dirname(current);
  }

  // Step 2: Look for ROADMAP only within the bounded project root
  if (projectRoot) {
    const candidate = path.join(projectRoot, 'ROADMAP.md');
    if (fs.existsSync(candidate)) return candidate;
    const claudeCandidate = path.join(projectRoot, '.claude', 'ROADMAP.md');
    if (fs.existsSync(claudeCandidate)) return claudeCandidate;
    // Return path for creation even if it doesn't exist yet
    return candidate;
  }

  return null;
}

// parseRoadmap moved to shared/roadmap-parser.ts (Phase 3A).

function itemExists(items: RoadmapItem[], title: string): boolean {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  return items.some(item => {
    const itemNormalized = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    return itemNormalized.includes(normalized) || normalized.includes(itemNormalized);
  });
}

function addToPlanned(content: string, item: RoadmapItem): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let addedToPlanned = false;
  let inPlanned = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim().toLowerCase();

    if (stripped.startsWith('## planned')) {
      inPlanned = true;
      result.push(lines[i]);
      // Add new item after header
      const priority = item.priority || 'normal';
      const source = item.source ? ` [${item.source}]` : '';
      result.push(`- [ ] ${item.title}${source} (${priority})`);
      addedToPlanned = true;
      continue;
    } else if (stripped.startsWith('## ') && inPlanned) {
      inPlanned = false;
    }

    result.push(lines[i]);
  }

  // If no planned section exists, create one
  if (!addedToPlanned) {
    result.push('');
    result.push('## Planned');
    const priority = item.priority || 'normal';
    const source = item.source ? ` [${item.source}]` : '';
    result.push(`- [ ] ${item.title}${source} (${priority})`);
  }

  return result.join('\n');
}

/**
 * Refresh the `- Progress:` line under the current goal.
 *
 * Deliberately deletes exactly ONE line (the previous `- Progress:` value) and
 * declares it via `removed`, so the guarded write's deletion-free invariant can
 * permit that single line and nothing else. Every other line is passed through.
 */
function updateProgress(content: string, title: string, progress: TaskProgress): RoadmapEdit {
  const lines = content.split('\n');
  const result: string[] = [];
  const removed: string[] = [];
  let inCurrent = false;
  let foundTitle = false;
  let progressUpdated = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    const lower = stripped.toLowerCase();

    if (lower.startsWith('## current')) {
      inCurrent = true;
      result.push(lines[i]);
      continue;
    } else if (lower.startsWith('## ') && inCurrent) {
      inCurrent = false;
    }

    if (inCurrent) {
      // Check if this is our feature
      if (stripped.startsWith('**') && stripped.includes(title.split(' ')[0])) {
        foundTitle = true;
        result.push(lines[i]);
        continue;
      }

      // Update progress line if found
      if (foundTitle && stripped.toLowerCase().startsWith('- progress:')) {
        removed.push(lines[i]); // the superseded Progress line -- the only intended deletion
        result.push(`- Progress: ${progress.completed}/${progress.total} tasks (${progress.percentage}%)`);
        progressUpdated = true;
        continue;
      }
    }

    result.push(lines[i]);
  }

  // If we found the title but no progress line, add one
  if (foundTitle && !progressUpdated) {
    // Find where to insert progress (after the current item header)
    const newResult: string[] = [];
    let inserted = false;
    inCurrent = false;

    for (let i = 0; i < result.length; i++) {
      newResult.push(result[i]);
      const stripped = result[i].trim();
      const lower = stripped.toLowerCase();

      if (lower.startsWith('## current')) {
        inCurrent = true;
        continue;
      }

      if (inCurrent && !inserted && stripped.startsWith('**') && stripped.includes(title.split(' ')[0])) {
        newResult.push(`- Progress: ${progress.completed}/${progress.total} tasks (${progress.percentage}%)`);
        inserted = true;
      }
    }

    // Insert-only path: nothing was replaced, so nothing is removed.
    return { content: newResult.join('\n'), removed: [] };
  }

  return { content: result.join('\n'), removed };
}

/**
 * Record a finished goal in `## Completed`. APPEND-ONLY (2026-08-05).
 *
 * It used to also wipe `## Current Focus`: on finding a `**Title**` line whose
 * text contained the first word of `title`, it set `skipUntilNextSection` and
 * dropped every remaining line of that section, substituting a placeholder.
 * That destroyed hand-written detail bullets -- the identical clobber removed
 * from `post-plan-roadmap` in this same change, and from `roadmap-completion`
 * back in `091f19f`. Two things made it worse than it looks: the match was a
 * substring test on ONE word, so an unrelated goal sharing a first word was
 * enough to trigger it; and the bullets it deleted are routinely the only
 * record of open follow-ups.
 *
 * Finishing a goal is now recorded WITHOUT touching Current Focus. The caller
 * advises the session to clear it deliberately (`/roadmap complete`), which is
 * a visible, self-correcting state -- unlike silently eaten content. Same
 * posture as post-plan-roadmap SS3 and roadmap-completion: a hook may record a
 * fact, but a human owns Current Focus.
 *
 * Uses the shared, parity-tested `insertUnderSection`, which also handles the
 * create-if-missing case the old inline loop silently skipped (no `## Completed`
 * header meant the entry was dropped on the floor).
 */
function moveToCompleted(content: string, title: string): RoadmapEdit {
  const today = localDateStamp();
  return {
    content: insertUnderSection(content, '## completed', `- [x] ${title} (${today})`),
    removed: [],
  };
}

/**
 * Seed `## Current Focus` from a Planned item. Only ever called when there is
 * NO current goal (see the `inPlanned && !roadmap.current` branch), so it
 * cannot overwrite a real hand-written focus block.
 *
 * Two intended deletions, both declared via `removed`: the "no current goal"
 * placeholder it replaces, and the Planned entry being promoted (an item should
 * not sit in both sections). Note the Planned match is a substring test on the
 * title's FIRST WORD -- pre-existing and fragile, but now at least the exact
 * line it drops is recorded in the audit trail instead of vanishing silently.
 */
function promoteToCurrent(content: string, item: RoadmapItem): RoadmapEdit {
  const lines = content.split('\n');
  const result: string[] = [];
  const removed: string[] = [];
  let inCurrent = false;
  let inPlanned = false;
  let removedFromPlanned = false;
  const today = localDateStamp();

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    const lower = stripped.toLowerCase();

    if (lower.startsWith('## current')) {
      inCurrent = true;
      result.push(lines[i]);
      result.push('');
      result.push(`**${item.title}**`);
      result.push(`- Started: ${today}`);
      if (item.source) {
        result.push(`- Source: ${item.source}`);
      }
      result.push(`- Progress: 0/? tasks (0%)`);
      result.push('');
      continue;
    } else if (lower.startsWith('## planned')) {
      inCurrent = false;
      inPlanned = true;
      result.push(lines[i]);
      continue;
    } else if (lower.startsWith('## ')) {
      inCurrent = false;
      inPlanned = false;
    }

    // Skip "no current goal" placeholder
    if (inCurrent && stripped.includes('No current goal')) {
      removed.push(lines[i]); // placeholder being replaced by the real goal
      continue;
    }

    // Remove item from planned
    if (inPlanned && !removedFromPlanned && stripped.includes(item.title.split(' ')[0])) {
      removed.push(lines[i]); // promoted out of Planned into Current
      removedFromPlanned = true;
      continue;
    }

    result.push(lines[i]);
  }

  return { content: result.join('\n'), removed };
}

async function handlePRDChange(
  filePath: string,
  content: string,
  toolName: string,
): Promise<HookOutput> {
  const metadata = extractPRDMetadata(content);
  const fileDir = path.dirname(filePath);

  // Path containment check - don't update ROADMAP for files outside this project
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!isPathInsideProject(filePath, projectDir)) {
    return {
      result: 'continue',
      message: 'PRD file is outside current project directory',
    };
  }

  const roadmapPath = findRoadmapPath(fileDir);

  if (!roadmapPath) {
    return {
      result: 'continue',
      message: `PRD detected: "${metadata.title}" - No ROADMAP.md found to sync`,
    };
  }

  const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
  const roadmap = parseRoadmap(roadmapContent);

  // Check if already exists
  const allItems = [
    ...(roadmap.current ? [roadmap.current] : []),
    ...roadmap.completed,
    ...roadmap.planned,
  ];

  if (itemExists(allItems, metadata.title)) {
    return {
      result: 'continue',
      message: `PRD "${metadata.title}" already in ROADMAP`,
    };
  }

  // Add to planned section
  const newItem: RoadmapItem = {
    title: metadata.title,
    priority: metadata.priority.toLowerCase(),
    source: path.basename(filePath),
  };

  const updated = addToPlanned(roadmapContent, newItem);
  // Guarded write (2026-08-05): .bak + deletion-free invariant + audit record.
  // addToPlanned is a pure insert, so the deletion guard has nothing to allow.
  const { outcome } = writeRoadmapGuarded({
    hook: 'prd-roadmap-sync',
    tool: toolName,
    roadmapPath,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    before: roadmapContent,
    after: updated,
    ops: [{ label: 'prd-add-planned', lines_removed: 0, lines_added: 1 }],
  });

  if (outcome !== 'written') {
    return {
      result: 'continue',
      message: `ROADMAP NOT updated for PRD "${metadata.title}" (${outcome}) -- see .claude/logs/roadmap-sync.jsonl`,
    };
  }

  return {
    result: 'continue',
    message: `ROADMAP updated: Added "${metadata.title}" to Planned (from PRD)`,
  };
}

async function handleTasksChange(
  filePath: string,
  content: string,
  toolName: string,
): Promise<HookOutput> {
  const progress = extractTaskProgress(content, filePath);
  const fileDir = path.dirname(filePath);

  // Path containment check - don't update ROADMAP for files outside this project
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!isPathInsideProject(filePath, projectDir)) {
    return {
      result: 'continue',
      message: 'Tasks file is outside current project directory',
    };
  }

  const roadmapPath = findRoadmapPath(fileDir);

  if (!roadmapPath) {
    return {
      result: 'continue',
      message: `Tasks progress: ${progress.completed}/${progress.total} (${progress.percentage}%)`,
    };
  }

  const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
  const roadmap = parseRoadmap(roadmapContent);

  // Check if this feature is in planned (needs promotion to current)
  const inPlanned = roadmap.planned.find(item =>
    item.title.toLowerCase().includes(progress.featureName.toLowerCase().split(' ')[0])
  );

  // Check if already current
  const isCurrent = roadmap.current &&
    roadmap.current.title.toLowerCase().includes(progress.featureName.toLowerCase().split(' ')[0]);

  // `edit.removed` carries each helper's DECLARED deletions straight through to
  // the guarded write's allowlist. Nothing infers deletions from the diff.
  let edit: RoadmapEdit = { content: roadmapContent, removed: [] };
  let message = '';
  // Set when a goal is recorded complete: Current Focus is intentionally left
  // alone (see moveToCompleted), so the session is told to clear it deliberately.
  let clearFocusAdvice = '';

  if (progress.isComplete) {
    // D2d-09: only mark the CURRENT goal complete when the tasks file actually
    // relates to it. A fully-checked but unrelated tasks-*.md must NOT falsely
    // complete whatever happens to be the current goal.
    if (roadmap.current) {
      if (isTasksRelatedToGoal(progress.featureName, roadmap.current.title)) {
        const titleToComplete = roadmap.current.title;
        edit = moveToCompleted(roadmapContent, titleToComplete);
        message = `ROADMAP updated: "${titleToComplete}" marked complete (100%)`;
        clearFocusAdvice =
          ` Current Focus still shows "${titleToComplete}" and its detail bullets --` +
          ` they are hand-written, so this hook leaves them alone. Run \`/roadmap complete\`` +
          ` (or \`/roadmap focus <next goal>\`) to clear it once you have salvaged anything still open.`;
      } else {
        message = `Tasks complete (100%) for "${progress.featureName}" but unrelated to current goal "${roadmap.current.title}" -- ROADMAP completion skipped`;
      }
    } else {
      // No current goal: record the actually-completed feature (not a false
      // completion of some other goal).
      edit = moveToCompleted(roadmapContent, progress.featureName);
      message = `ROADMAP updated: "${progress.featureName}" marked complete (100%)`;
    }
  } else if (inPlanned && !roadmap.current) {
    // Promote to current if no current goal
    edit = promoteToCurrent(roadmapContent, {
      title: inPlanned.title,
      source: path.basename(filePath),
    });
    message = `ROADMAP updated: Promoted "${inPlanned.title}" to Current`;
  } else if (isCurrent) {
    // Update progress
    edit = updateProgress(roadmapContent, roadmap.current!.title, progress);
    message = `ROADMAP progress: ${progress.completed}/${progress.total} (${progress.percentage}%)`;
  } else if (inPlanned) {
    message = `Tasks started for planned item "${inPlanned.title}" - will promote when current goal completes`;
  } else {
    message = `Tasks progress: ${progress.completed}/${progress.total} (${progress.percentage}%)`;
  }

  if (edit.content !== roadmapContent) {
    // Guarded write (2026-08-05): .bak + deletion-free invariant + audit record.
    //
    // `allowedDeletions` comes from the helper's own `removed` list, so the
    // guard permits exactly the lines the operation meant to drop (a superseded
    // `- Progress:` value, a "no current goal" placeholder, a promoted Planned
    // entry) and refuses anything else. `moveToCompleted` is now a pure append
    // and declares nothing.
    const { outcome, record } = writeRoadmapGuarded({
      hook: 'prd-roadmap-sync',
      tool: toolName,
      roadmapPath,
      projectDir,
      before: roadmapContent,
      after: edit.content,
      allowedDeletions: edit.removed,
      ops: [
        {
          label: 'prd-tasks-sync',
          lines_removed: edit.removed.length,
          lines_added:
            edit.content.split('\n').length - roadmapContent.split('\n').length + edit.removed.length,
        },
      ],
    });

    if (outcome !== 'written') {
      const detail = record.refused_deletions?.length
        ? ` Would have removed: ${record.refused_deletions.slice(0, 3).join(' | ')}`
        : '';
      message =
        `ROADMAP NOT updated (${outcome}${record.reason ? `: ${record.reason}` : ''}).` +
        `${detail} See .claude/logs/roadmap-sync.jsonl`;
    } else {
      message += clearFocusAdvice;
    }
  }

  // PostToolUse:Write|Edit. {result,message} is discarded by the harness, so
  // this advisory never reached the model -- see scripts/hooks/hook-contract-guard.mjs.
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
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

  // Only handle Write/Edit
  if (!['Write', 'Edit'].includes(data.tool_name)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const filePath = data.tool_input.file_path;
  if (!filePath) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Check if PRD or Tasks file
  let result: HookOutput;

  if (isPRDFile(filePath)) {
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    result = await handlePRDChange(filePath, content, data.tool_name);
  } else if (isTasksFile(filePath)) {
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    result = await handleTasksChange(filePath, content, data.tool_name);
  } else {
    result = { result: 'continue' };
  }

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error('[prd-roadmap-sync] Error:', err.message);
  console.log(JSON.stringify({ result: 'continue' }));
});
