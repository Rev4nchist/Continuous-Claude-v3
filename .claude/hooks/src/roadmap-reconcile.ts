#!/usr/bin/env node
/**
 * ROADMAP Reconciliation Hook (SessionStart)
 *
 * Detects contradictions between ROADMAP.md claims and actual project state.
 * Checks: package.json packages, git log commits, file existence.
 * Returns system message listing contradictions if 2+ found.
 *
 * Hook: SessionStart
 * Output: { values: { system: "..." } } or {}
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { isCompactSource, parseSessionSource } from './shared/session-source.js';
import { isEngineHost } from './shared/engine-host.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Decision {
  decision: string;
  rationale: string;
}

interface Milestone {
  title: string;
  completed: boolean;
  date: string | null;
}

interface CurrentFocus {
  title: string;
  details: string;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ReconcileResult {
  values?: { system: string };
}

// ---------------------------------------------------------------------------
// Known package name patterns
// (Maps common library mentions to npm package names)
// ---------------------------------------------------------------------------

const PACKAGE_ALIASES: Record<string, string[]> = {
  'passport': ['passport', 'passport.js'],
  'redis': ['redis', 'ioredis'],
  'mongoose': ['mongoose'],
  'prisma': ['prisma', '@prisma/client'],
  'apollo-server': ['apollo-server', '@apollo/server'],
  'socket.io': ['socket.io'],
  'helmet': ['helmet'],
  'express': ['express'],
  'fastify': ['fastify'],
  'next': ['next', 'next.js', 'nextjs'],
  'react': ['react'],
  'vue': ['vue', 'vue.js', 'vuejs'],
  'angular': ['@angular/core', 'angular'],
  'tailwind': ['tailwindcss', 'tailwind'],
  'jest': ['jest'],
  'vitest': ['vitest'],
  'mocha': ['mocha'],
  'webpack': ['webpack'],
  'vite': ['vite'],
  'esbuild': ['esbuild'],
  'typeorm': ['typeorm'],
  'sequelize': ['sequelize'],
  'knex': ['knex'],
  'graphql': ['graphql'],
  'axios': ['axios'],
  'lodash': ['lodash'],
  'moment': ['moment'],
  'dayjs': ['dayjs'],
  'zod': ['zod'],
  'joi': ['joi'],
};

// Build reverse lookup: mention text -> package name
function buildPackageLookup(): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [pkg, aliases] of Object.entries(PACKAGE_ALIASES)) {
    for (const alias of aliases) {
      lookup.set(alias.toLowerCase(), pkg);
    }
  }
  return lookup;
}

const PACKAGE_LOOKUP = buildPackageLookup();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function extractPaths(text: string): string[] {
  const matches = text.match(/\b(?:src|lib|app|packages|modules|components)\/[\w/.-]+/g);
  return matches ? matches.map(p => p.replace(/\/+$/, '')) : [];
}

// ---------------------------------------------------------------------------
// Extraction functions
// ---------------------------------------------------------------------------

/**
 * Extract Key Decisions table rows from ROADMAP content.
 * Looks for | Decision | ... | table patterns.
 */
export function extractDecisions(content: string): Decision[] {
  const decisions: Decision[] = [];
  const lines = content.split('\n');

  let inDecisionTable = false;
  let headerSeen = false;
  let separatorSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect table start: header row with "Decision"
    if (trimmed.startsWith('|') && /decision/i.test(trimmed) && !headerSeen) {
      inDecisionTable = true;
      headerSeen = true;
      continue;
    }

    // Skip separator row (|---|---|)
    if (inDecisionTable && !separatorSeen && /^\|[\s-|]+\|$/.test(trimmed)) {
      separatorSeen = true;
      continue;
    }

    // Parse data rows
    if (inDecisionTable && separatorSeen && trimmed.startsWith('|')) {
      const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length >= 2) {
        decisions.push({
          decision: cells[0],
          rationale: cells[1],
        });
      }
      continue;
    }

    // End of table -- any non-pipe line exits table mode
    if (inDecisionTable && !trimmed.startsWith('|')) {
      inDecisionTable = false;
      headerSeen = false;
      separatorSeen = false;
    }
  }

  return decisions;
}

/**
 * Extract milestone checkboxes from ROADMAP content.
 * Matches - [x] (completed) and - [ ] (planned) patterns.
 */
export function extractMilestones(content: string): Milestone[] {
  const milestones: Milestone[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Completed milestone: - [x] Title (date)
    const completedMatch = trimmed.match(/^-\s*\[x\]\s+(.+?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?(?:\s*`[^`]*`)?$/i);
    if (completedMatch) {
      milestones.push({
        title: completedMatch[1].trim(),
        completed: true,
        date: completedMatch[2] || null,
      });
      continue;
    }

    // Planned milestone: - [ ] Title
    const plannedMatch = trimmed.match(/^-\s*\[\s*\]\s+(.+)$/);
    if (plannedMatch) {
      milestones.push({
        title: plannedMatch[1].trim(),
        completed: false,
        date: null,
      });
    }
  }

  return milestones;
}

/**
 * Extract Current Focus section from ROADMAP content.
 * Returns title and detail text, or null if no current focus / placeholder.
 */
export function extractCurrentFocus(content: string): CurrentFocus | null {
  const currentMatch = content.match(/## Current Focus\n([\s\S]*?)(?=\n## |$)/);
  if (!currentMatch) return null;

  const section = currentMatch[1].trim();

  // Check for "no current goal" placeholder
  if (/no current goal/i.test(section)) return null;

  // Extract bold title
  const titleMatch = section.match(/\*\*([^*]+)\*\*/);
  if (!titleMatch) return null;

  const title = titleMatch[1].trim();
  const details = section
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.trim().replace(/^-\s*/, ''))
    .join(' ');

  return { title, details };
}

/**
 * Extract file paths mentioned in ROADMAP (from **Files:** lines).
 */
export function extractMentionedFiles(content: string): string[] {
  const files: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Match "**Files:**" or "Files:" patterns
    const filesMatch = trimmed.match(/^\*?\*?Files:\*?\*?\s*(.+)$/i);
    if (filesMatch) {
      const fileList = filesMatch[1].split(',').map(f => f.trim()).filter(f => f.length > 0);
      files.push(...fileList);
    }
  }

  return files;
}

/**
 * Extract package names mentioned in decision text.
 * Uses known package aliases to match mentions.
 */
export function extractMentionedPackages(content: string): string[] {
  const packages: string[] = [];
  const contentLower = content.toLowerCase();

  // Check each known package alias
  for (const [alias, pkgName] of PACKAGE_LOOKUP) {
    // Word-boundary check: the alias should appear as a distinct word/term
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(contentLower)) {
      if (!packages.includes(pkgName)) {
        packages.push(pkgName);
      }
    }
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

/**
 * Validate decisions against package.json.
 * Flags packages mentioned in decisions but missing from dependencies.
 */
export function validateDecisions(
  decisions: Decision[],
  packageJson: PackageJson
): string[] {
  const issues: string[] = [];
  const allDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };
  const depNames = new Set(Object.keys(allDeps).map(d => d.toLowerCase()));

  for (const decision of decisions) {
    const text = decision.decision.toLowerCase();

    // Check each known package alias in the decision text
    for (const [alias, pkgName] of PACKAGE_LOOKUP) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(text)) {
        // Check if this package (or any of its aliases) is in dependencies
        const allAliases = PACKAGE_ALIASES[pkgName] || [pkgName];
        const found = allAliases.some(a => depNames.has(a.toLowerCase()));
        if (!found) {
          issues.push(`Decision mentions "${pkgName}" but it is not in package.json`);
        }
      }
    }
  }

  return issues;
}

/**
 * Validate completed milestones against git log.
 * Flags milestones marked [x] that have no matching commit message.
 */
export function validateMilestones(
  milestones: Milestone[],
  gitLog: string
): string[] {
  const issues: string[] = [];
  const logLower = gitLog.toLowerCase();

  const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'been', 'will', 'been', 'into', 'also', 'some', 'than', 'then', 'when', 'what', 'which', 'about', 'after', 'before']);

  for (const milestone of milestones) {
    if (!milestone.completed) continue;

    // Extract key words from milestone title (5+ char, no stop words)
    const titleWords = milestone.title
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 5 && !STOP_WORDS.has(w));

    // Check if at least 2 key words appear in git log
    const matchCount = titleWords.filter(w => logLower.includes(w)).length;
    const threshold = Math.min(2, titleWords.length);

    if (matchCount < threshold) {
      issues.push(`Completed milestone "${milestone.title}" has no matching commit in recent git log`);
    }
  }

  return issues;
}

/**
 * Validate current focus paths against file system.
 * Flags mentioned paths (src/...) that don't exist.
 */
export function validateCurrentFocus(
  focus: CurrentFocus | null,
  existingPaths: Set<string>
): string[] {
  if (!focus) return [];

  const issues: string[] = [];
  const allText = `${focus.title} ${focus.details}`;
  const paths = extractPaths(allText);

  for (const normalized of paths) {
    if (!existingPaths.has(normalized)) {
      issues.push(`Current focus mentions "${normalized}" but it does not exist`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main reconciliation
// ---------------------------------------------------------------------------

/**
 * Run full reconciliation of ROADMAP.md against project state.
 * Returns hook output: { values: { system: "..." } } or {} if few/no issues.
 */
export function reconcile(projectDir: string): ReconcileResult {
  const roadmapPath = path.join(projectDir, 'ROADMAP.md');

  // No ROADMAP.md => exit silently
  if (!fs.existsSync(roadmapPath)) {
    return {};
  }

  let content: string;
  try {
    content = fs.readFileSync(roadmapPath, 'utf-8');
  } catch {
    return {};
  }

  const allIssues: string[] = [];

  // 1. Extract claims
  const decisions = extractDecisions(content);
  const milestones = extractMilestones(content);
  const focus = extractCurrentFocus(content);
  const mentionedFiles = extractMentionedFiles(content);

  // 2. Validate decisions against package.json
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(packageJsonPath) && decisions.length > 0) {
    try {
      const pkgContent = fs.readFileSync(packageJsonPath, 'utf-8');
      const packageJson: PackageJson = JSON.parse(pkgContent);
      allIssues.push(...validateDecisions(decisions, packageJson));
    } catch {
      // Ignore malformed package.json
    }
  } else if (!fs.existsSync(packageJsonPath) && decisions.length > 0) {
    // Check if decisions mention packages but there's no package.json
    const mentionedPkgs = extractMentionedPackages(content);
    if (mentionedPkgs.length > 0) {
      allIssues.push(...validateDecisions(decisions, { dependencies: {}, devDependencies: {} }));
    }
  }

  // 3. Validate milestones against git log
  let gitLog = '';
  try {
    gitLog = execSync('git log --oneline -10', {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Not a git repo or git not available - skip
  }

  if (gitLog && milestones.length > 0) {
    allIssues.push(...validateMilestones(milestones, gitLog));
  }

  // 4. Validate current focus paths
  if (focus) {
    const existingPaths = new Set<string>();
    const allText = `${focus.title} ${focus.details}`;
    const paths = extractPaths(allText);
    for (const normalized of paths) {
      const fullPath = path.join(projectDir, normalized);
      if (fs.existsSync(fullPath)) {
        existingPaths.add(normalized);
      }
    }
    allIssues.push(...validateCurrentFocus(focus, existingPaths));
  }

  // 5. Validate mentioned files exist
  for (const filePath of mentionedFiles) {
    const fullPath = path.join(projectDir, filePath);
    if (!fs.existsSync(fullPath)) {
      allIssues.push(`Referenced file "${filePath}" does not exist`);
    }
  }

  // 6. Return results (only if 2+ contradictions)
  if (allIssues.length < 2) {
    return {};
  }

  const deduped = [...new Set(allIssues)];
  const message = `ROADMAP Reconciliation (${deduped.length} issues):\n` +
    deduped.map(i => `- ${i}`).join('\n');

  return {
    values: {
      system: message,
    },
  };
}

// ---------------------------------------------------------------------------
// Hook entry point (stdin → stdout)
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  // Read stdin (SessionStart input)
  const input = await readStdin();
  // Under cursor-agent (the review engine) print no values.system: SessionStart text can reach
  // the review model (seat ruling, Tier B). The reconcile only reads, so nothing is lost.
  let payload: unknown = null;
  try { payload = JSON.parse(input); } catch { /* empty or invalid: not the engine host */ }
  if (isEngineHost(payload)) {
    console.log(JSON.stringify({}));
    return;
  }
  // SessionStart hooks receive { session_id, source }. After /compact the roadmap
  // was reconciled at this session's start: skip it.
  if (isCompactSource(parseSessionSource(input))) {
    console.log(JSON.stringify({}));
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = reconcile(projectDir);

  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.error('roadmap-reconcile error:', err.message || err);
  console.log(JSON.stringify({}));
});
