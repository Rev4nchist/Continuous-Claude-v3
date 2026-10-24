#!/usr/bin/env node
/**
 * PageIndex Watch Hook
 *
 * Triggers PageIndex regeneration when indexed markdown files are modified.
 * Uses debouncing to avoid regenerating on every keystroke.
 *
 * Hook: PostToolUse (Write|Edit)
 * Condition: Modified file matches indexed patterns (ROADMAP.md, docs/*.md, etc.)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnDetachedHidden } from './lib/spawn-hidden.js';

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

// Patterns for files that are indexed by PageIndex
const INDEXED_PATTERNS: RegExp[] = [
  /ROADMAP\.md$/i,
  /README\.md$/i,
  /docs[\/\\].*\.md$/i,
  /\.claude[\/\\]docs[\/\\].*\.md$/i,
  /\.claude[\/\\]skills[\/\\][^\/\\]+[\/\\]SKILL\.md$/i,
  /\.claude[\/\\]agents[\/\\].*\.md$/i,
  /ARCHITECTURE\.md$/i,
];

// State file for debouncing
const STATE_DIR = process.env.CLAUDE_LOCAL_STATE_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'local-state');
const DEBOUNCE_FILE = path.join(STATE_DIR, 'pageindex-pending.json');
const DEBOUNCE_MS = 2000; // 2 second debounce

interface PendingReindex {
  files: string[];
  timestamp: number;
  projectDir: string;
}

function isIndexedFile(filePath: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');

  return INDEXED_PATTERNS.some(pattern => pattern.test(normalizedPath));
}

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadPending(): PendingReindex | null {
  try {
    if (fs.existsSync(DEBOUNCE_FILE)) {
      const content = fs.readFileSync(DEBOUNCE_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function savePending(pending: PendingReindex): void {
  ensureStateDir();
  fs.writeFileSync(DEBOUNCE_FILE, JSON.stringify(pending, null, 2));
}

function clearPending(): void {
  try {
    if (fs.existsSync(DEBOUNCE_FILE)) {
      fs.unlinkSync(DEBOUNCE_FILE);
    }
  } catch {
    // Ignore errors
  }
}

function triggerReindex(projectDir: string, files: string[]): void {
  // Get OPC directory from environment or derive from project
  const opcDir = process.env.CLAUDE_OPC_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'continuous-claude', 'opc');

  // Run batch_index in background with only Tier 1 (critical docs)
  const pythonPath = 'uv';
  const args = [
    'run', 'python', '-m', 'scripts.pageindex.batch_index',
    '--project', projectDir,
    '--tier', '1',
    '--quiet'
  ];

  try {
    const proc = spawnDetachedHidden(pythonPath, args, {
      cwd: opcDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        PYTHONPATH: opcDir
      }
    });

    proc.unref(); // Don't wait for process

    console.error(`[pageindex-watch] PageIndex regeneration triggered for: ${files.map(f => path.basename(f)).join(', ')}`);
  } catch (err) {
    console.error(`[WARN] PageIndex regeneration failed: ${err}`);
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

  // Check if file is indexed
  if (!isIndexedFile(filePath)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const now = Date.now();

  // Load existing pending state
  let pending = loadPending();

  if (pending && pending.projectDir === projectDir) {
    // Accumulate files -- timestamp is set only at batch creation
    // DO NOT update pending.timestamp here (preserves debounce start)
    if (!pending.files.includes(filePath)) {
      pending.files.push(filePath);
    }
  } else {
    // Different project or no pending state -- flush old pending first
    if (pending && pending.files.length > 0) {
      triggerReindex(pending.projectDir, pending.files);
    }
    pending = {
      files: [filePath],
      timestamp: now,
      projectDir
    };
  }

  // Save pending state
  savePending(pending);

  // Check if we should trigger reindex (debounce elapsed)
  const elapsed = now - pending.timestamp;
  if (elapsed >= DEBOUNCE_MS) {
    // Enough time has passed, trigger reindex
    triggerReindex(projectDir, pending.files);
    clearPending();
  } else {
    // Schedule check for later (if not already scheduled)
    // Since hooks are stateless, we rely on the next file edit to check
    console.error(`[pending] PageIndex update pending: ${path.basename(filePath)}`);
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
  console.error('pageindex-watch error:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
