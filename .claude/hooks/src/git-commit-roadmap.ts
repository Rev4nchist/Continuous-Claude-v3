#!/usr/bin/env node
/**
 * Git Commit ROADMAP Sync Hook
 *
 * PostToolUse:Bash - Detects successful git commits and updates ROADMAP.md
 *
 * Parses conventional commit messages:
 * - feat: → adds to Completed as feature
 * - fix: → adds to Completed as fix
 * - chore: → skipped by default (configurable)
 *
 * Hook: PostToolUse (Bash matching git commit)
 * Output: Appends to {project}/ROADMAP.md Completed section
 */

import * as fs from 'fs';
import * as path from 'path';
import { commitRanInProject } from './shared/roadmap-sync-guards.js';

interface PostToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
}

interface HookOutput {
  result: 'continue' | 'block';
  message?: string;
}

interface ParsedCommit {
  type: string;
  scope: string | null;
  description: string;
  hash: string | null;
  isAmend: boolean;
  isMerge: boolean;
  isRevert: boolean;
}

const COMMIT_PATTERNS = {
  conventional: /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci)(?:\(([^)]+)\))?!?:\s*(.+)$/i,
  commitOutput: /^\[([^\s]+)\s+([a-f0-9]{7,})\]\s+(.+)$/m,
  amendIndicator: /\[.*\s+[a-f0-9]+\].*\(amend\)/i,
  mergeIndicator: /^Merge\s+(branch|pull request|remote-tracking)/i,
  revertIndicator: /^Revert\s+"/i,
};

const SKIP_TYPES = new Set(['chore', 'style', 'ci']);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000).unref();
  });
}

function isGitCommitCommand(command: string): boolean {
  const normalized = command.toLowerCase().trim();
  return normalized.includes('git commit') && !normalized.includes('--amend');
}

function isSuccessfulCommit(response: string): boolean {
  return COMMIT_PATTERNS.commitOutput.test(response) &&
         !COMMIT_PATTERNS.amendIndicator.test(response);
}

function parseCommitFromOutput(output: string): ParsedCommit | null {
  const commitMatch = output.match(COMMIT_PATTERNS.commitOutput);
  if (!commitMatch) {
    return null;
  }

  const [, branch, hash, message] = commitMatch;
  const trimmedMsg = message.trim();

  const isAmend = COMMIT_PATTERNS.amendIndicator.test(output);
  const isMerge = COMMIT_PATTERNS.mergeIndicator.test(trimmedMsg);
  const isRevert = COMMIT_PATTERNS.revertIndicator.test(trimmedMsg);

  const conventionalMatch = trimmedMsg.match(COMMIT_PATTERNS.conventional);
  if (conventionalMatch) {
    const [, type, scope, desc] = conventionalMatch;
    return {
      type: type.toLowerCase(),
      scope: scope || null,
      description: desc.trim(),
      hash,
      isAmend,
      isMerge,
      isRevert,
    };
  }

  return {
    type: 'other',
    scope: null,
    description: trimmedMsg,
    hash,
    isAmend,
    isMerge,
    isRevert,
  };
}

function findRoadmapPath(projectDir: string): string | null {
  const candidates = [
    path.join(projectDir, 'ROADMAP.md'),
    path.join(projectDir, '.claude', 'ROADMAP.md'),
    path.join(projectDir, 'roadmap.md'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function formatCommitEntry(commit: ParsedCommit, date: string): string {
  const typeLabel = commit.type !== 'other' ? commit.type : '';
  const scopeLabel = commit.scope ? `(${commit.scope})` : '';
  const prefix = typeLabel && scopeLabel ? `${typeLabel}${scopeLabel}: ` :
                 typeLabel ? `${typeLabel}: ` :
                 scopeLabel ? `${scopeLabel} ` : '';
  const hashLabel = commit.hash ? ` \`${commit.hash.slice(0, 7)}\`` : '';

  return `- [x] ${prefix}${commit.description} (${date})${hashLabel}`;
}

function isDuplicateEntry(content: string, commit: ParsedCommit): boolean {
  if (commit.hash) {
    if (content.includes(commit.hash.slice(0, 7))) {
      return true;
    }
  }

  const descLower = commit.description.toLowerCase();
  const lines = content.split('\n');

  for (const line of lines) {
    if (line.trim().startsWith('- [x]')) {
      const lineLower = line.toLowerCase();
      if (lineLower.includes(descLower.slice(0, 30))) {
        return true;
      }
    }
  }

  return false;
}

function appendToCompleted(content: string, entry: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let insertedEntry = false;
  let inCompleted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim().toLowerCase();

    if (stripped.startsWith('## completed')) {
      inCompleted = true;
      result.push(line);
      result.push(entry);
      insertedEntry = true;
      continue;
    }

    if (stripped.startsWith('## ') && inCompleted) {
      inCompleted = false;
    }

    result.push(line);
  }

  if (!insertedEntry) {
    const completedIndex = result.findIndex(l =>
      l.trim().toLowerCase().startsWith('## planned') ||
      l.trim().toLowerCase().startsWith('## recent')
    );

    if (completedIndex > 0) {
      result.splice(completedIndex, 0, '', '## Completed', entry, '');
    } else {
      result.push('', '## Completed', entry);
    }
  }

  return result.join('\n');
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

  if (data.tool_name !== 'Bash') {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const command = (data.tool_input?.command as string) || '';
  if (!isGitCommitCommand(command)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let response: string;
  if (typeof data.tool_response === 'string') {
    response = data.tool_response;
  } else if (data.tool_response && typeof (data.tool_response as any).output === 'string') {
    response = (data.tool_response as any).output;
  } else if (data.tool_response && typeof (data.tool_response as any).stdout === 'string') {
    response = (data.tool_response as any).stdout;
  } else {
    response = JSON.stringify(data.tool_response || '');
  }

  if (!isSuccessfulCommit(response)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const commit = parseCommitFromOutput(response);
  if (!commit) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (commit.isAmend) {
    console.error('ℹ Skipping amend commit (no duplicate entries)');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (commit.isMerge) {
    console.error('ℹ Skipping merge commit');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (SKIP_TYPES.has(commit.type)) {
    console.error(`ℹ Skipping ${commit.type} commit`);
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // D2d-10: verify the commit actually ran in THIS project before recording it.
  // A `cd <other-repo> && git commit` (routine for ~/.claude quick fixes) must
  // not write a foreign repo's commit into the session project's ROADMAP.
  if (!commitRanInProject(command, projectDir)) {
    console.error('ℹ Skipping commit that ran outside this project directory');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const roadmapPath = findRoadmapPath(projectDir);

  if (!roadmapPath) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const content = fs.readFileSync(roadmapPath, 'utf-8');

  if (isDuplicateEntry(content, commit)) {
    console.error('ℹ Skipping duplicate entry');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const entry = formatCommitEntry(commit, today);
  const updated = appendToCompleted(content, entry);

  fs.writeFileSync(roadmapPath, updated);

  const typeDesc = commit.type !== 'other' ? `${commit.type}: ` : '';
  const scopeDesc = commit.scope ? `(${commit.scope}) ` : '';

  console.error(`✓ ROADMAP.md: ${typeDesc}${scopeDesc}${commit.description}`);

  const output: HookOutput = {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `📋 ROADMAP updated: ${commit.description}` },
  };

  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error('[git-commit-roadmap] Error:', err.message);
  console.log(JSON.stringify({ result: 'continue' }));
});
