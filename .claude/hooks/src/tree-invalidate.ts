#!/usr/bin/env node
/**
 * Tree Invalidate Hook
 *
 * Invalidates the knowledge tree when significant files are edited.
 * Tree regenerates lazily on next access.
 *
 * Hook: PostToolUse (Write|Edit)
 * Condition: Modified file is a significant project file
 */

import * as fs from 'fs';
import { isEngineHost } from './shared/engine-host.js';
import * as path from 'path';

interface PostToolUseInput {
  tool_name: string;
  tool_input: {
    file_path?: string;
    content?: string;
  };
  tool_result?: {
    success?: boolean;
  };
}

// Files that should trigger tree invalidation
const SIGNIFICANT_FILES = new Set([
  'README.md',
  'readme.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'ROADMAP.md',
  'CLAUDE.md',
  'tsconfig.json',
  'docker-compose.yml',
  'Dockerfile',
]);

// Directories that should trigger tree invalidation when files are added/removed
const SIGNIFICANT_DIRS = new Set([
  'src',
  'lib',
  'components',
  'pages',
  'api',
  'routes',
  'models',
  'services',
  'hooks',
  'skills',
  'agents',
]);

function isSignificantFile(filePath: string): boolean {
  const fileName = path.basename(filePath);
  const dirName = path.dirname(filePath).split(path.sep).pop() || '';

  // Direct significant file match
  if (SIGNIFICANT_FILES.has(fileName)) {
    return true;
  }

  // New file in significant directory
  if (SIGNIFICANT_DIRS.has(dirName)) {
    return true;
  }

  // Any new TypeScript/Python module file at root level
  const ext = path.extname(fileName);
  if ((ext === '.ts' || ext === '.py') && !filePath.includes('node_modules')) {
    const depth = filePath.split(path.sep).length;
    if (depth <= 4) { // Within first few levels
      return true;
    }
  }

  return false;
}

function invalidateTree(projectDir: string): boolean {
  const treePath = path.join(projectDir, '.claude', 'knowledge-tree.json');

  // Ensure .claude directory exists before attempting write
  if (!fs.existsSync(path.dirname(treePath))) return false;

  if (fs.existsSync(treePath)) {
    try {
      // Instead of deleting, mark stale so tree stays available until regenerated
      const existing = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
      const staleMarker = { ...existing, _stale: true, _invalidated_at: new Date().toISOString() };
      fs.writeFileSync(treePath, JSON.stringify(staleMarker, null, 2));
      return true;
    } catch {
      // If we can't read existing tree, write minimal stale marker
      try {
        fs.writeFileSync(treePath, JSON.stringify({ _stale: true, _invalidated_at: new Date().toISOString() }, null, 2));
        return true;
      } catch {
        return false;
      }
    }
  }

  return false;
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

  // Under cursor-agent (the review engine): no knowledge-tree.json change in the reviewed tree. (card engine-run-hook-files).
  if (isEngineHost(data)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Only process Write/Edit
  if (!['Write', 'Edit'].includes(data.tool_name)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Check if tool succeeded
  if (data.tool_result?.success === false) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const filePath = data.tool_input?.file_path;
  if (!filePath) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Check if file is significant
  if (!isSignificantFile(filePath)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Invalidate tree
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const invalidated = invalidateTree(projectDir);

  if (invalidated) {
    console.error(`[tree-invalidate] Knowledge tree invalidated (${path.basename(filePath)} changed)`);
  }

  console.log(JSON.stringify({ result: 'continue' }));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

main().catch(err => {
  console.error('tree-invalidate error:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
