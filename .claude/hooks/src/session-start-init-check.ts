#!/usr/bin/env node
/**
 * Session Start Init Check Hook
 *
 * Detects uninitialized projects and generates knowledge tree if missing.
 * Uses lazy tree generation - generates inline if missing, skips if fresh.
 * Lightweight check - only runs on startup, not resume/clear/compact.
 *
 * Hook: SessionStart (startup only)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

interface SessionStartInput {
  type?: 'startup' | 'resume' | 'clear' | 'compact';
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  session_id: string;
}

interface SkillCatalogEntry {
  name: string;
  source: string;
  publisher: string;
  description: string;
}

interface StackDefinition {
  indicators: string[];
  indicatorFiles?: string[];
  fileIndicators?: string[];
  skills: SkillCatalogEntry[];
}

interface SkillCatalog {
  version: string;
  stacks: Record<string, StackDefinition>;
}

interface SkillRecommendation {
  name: string;
  source: string;
  publisher: string;
  description: string;
  stackName: string;
}

const TREE_MAX_AGE_SECONDS = 300; // 5 minutes

function getOpcDir(): string {
  return process.env.CLAUDE_OPC_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'continuous-claude', 'opc');
}

/**
 * FH-01a: fire-and-forget warm of the tldr code-analysis daemon at session
 * start. Returns true if a warm was attempted, false if skipped/failed.
 *
 * Idempotent via the daemon's OWN pidfile lock (msvcrt LK_NBLCK / fcntl
 * LOCK_NB): a second `start` while one is already running self-terminates, and
 * it correctly (re)starts when the prior daemon died — the tldr daemon is known
 * not to persist reliably on Windows, so re-warming each session is the intent.
 * No TS-side pidfile/hash check (that would false-skip on a stale pidfile after
 * the daemon died); the daemon's lock is the single source of truth.
 *
 * If a daemon is already alive for a DIFFERENT project, this start self-
 * terminates and that project's daemon keeps running — this session's tldr
 * queries then fall through to on-demand rather than benefiting from the warm.
 * That is NOT a regression: without warming they would be cold anyway, and the
 * non-persistence means the prior-project daemon has usually already died by
 * the time a new session starts, so the warm fires fresh in practice.
 *
 * Detached + unref'd + stdio:'ignore' so it adds ZERO latency to session start
 * and never blocks. `tldr` is a real .exe on Windows (NOT a .cmd shim), so a
 * direct array-arg spawn is safe without shell:true (no spaced-path /
 * CVE-2024-27980 hardening issue). Kill-switch: CCV3_TLDR_WARM_OFF.
 */
export function warmTldrDaemon(projectDir: string): boolean {
  if (process.env.CCV3_TLDR_WARM_OFF) return false;
  try {
    const cmd = process.platform === 'win32' ? 'tldr.exe' : 'tldr';
    const child = spawn(cmd, ['daemon', 'start', '--project', projectDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Without an 'error' handler a missing `tldr` throws asynchronously and
    // could crash the hook process. Swallow it — warming is best-effort.
    child.on('error', () => { /* tldr not installed / spawn failed — ignore */ });
    child.unref();
    return true;
  } catch {
    // Never block session start on a warm failure.
    return false;
  }
}

function isTreeStale(projectDir: string): boolean {
  const treePath = path.join(projectDir, '.claude', 'knowledge-tree.json');

  if (!fs.existsSync(treePath)) {
    return true;
  }

  try {
    // Check content for stale marker (set by tree-invalidate hook)
    const content = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
    if (content._stale) return true;
    // Also check mtime as fallback for age-based staleness
    const stats = fs.statSync(treePath);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
    return ageSeconds >= TREE_MAX_AGE_SECONDS;
  } catch {
    return true;
  }
}

function generateTree(projectDir: string): boolean {
  const opcDir = getOpcDir();
  const lazyTreePath = path.join(opcDir, 'scripts', 'core', 'lazy_tree.py');

  if (!fs.existsSync(lazyTreePath)) {
    // Fall back to knowledge_tree.py
    const knowledgeTreePath = path.join(opcDir, 'scripts', 'core', 'knowledge_tree.py');
    if (!fs.existsSync(knowledgeTreePath)) {
      return false;
    }

    try {
      execSync(
        `cd "${opcDir}" && uv run python scripts/core/knowledge_tree.py --project "${projectDir}"`,
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return true;
    } catch {
      return false;
    }
  }

  try {
    execSync(
      `cd "${opcDir}" && uv run python scripts/core/lazy_tree.py regenerate --project "${projectDir}"`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return true;
  } catch {
    return false;
  }
}

function isInitialized(projectDir: string): { tree: boolean; roadmap: boolean } {
  const treePath = path.join(projectDir, '.claude', 'knowledge-tree.json');
  const roadmapPath = path.join(projectDir, 'ROADMAP.md');

  return {
    tree: fs.existsSync(treePath),
    roadmap: fs.existsSync(roadmapPath)
  };
}

function hasCodeFiles(projectDir: string): boolean {
  const codeIndicators = [
    'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
    'requirements.txt', 'pom.xml', 'build.gradle', 'Gemfile',
    'README.md', 'readme.md', '.git'
  ];

  for (const indicator of codeIndicators) {
    if (fs.existsSync(path.join(projectDir, indicator))) {
      return true;
    }
  }

  // Phase 3 (cross-project isolation): also recognize bare-file projects
  // that lack a build manifest. Top-level scan only -- no recursion.
  const codeExtensions = new Set([
    '.py', '.ts', '.tsx', '.js', '.jsx', '.go', '.rs', '.rb',
    '.java', '.c', '.cpp', '.h', '.cs', '.kt', '.swift',
  ]);
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (codeExtensions.has(ext)) {
          return true;
        }
      }
    }
  } catch {
    // Unreadable directory -- treat as no code files.
  }

  return false;
}

interface SkillStalenessResult {
  needsRevetting: string[];
  stale: string[];
}

function checkExternalSkillStaleness(): SkillStalenessResult {
  const result: SkillStalenessResult = { needsRevetting: [], stale: [] };
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  const rulesPath = path.join(homeDir, '.claude', 'skills', 'skill-rules.json');
  const lockPath = path.join(homeDir, '.agents', '.skill-lock.json');

  if (!fs.existsSync(rulesPath)) return result;

  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    const skills = rules.skills || {};

    // Load lock file if available
    let lockData: Record<string, any> = {};
    if (fs.existsSync(lockPath)) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        lockData = lock.skills || {};
      } catch { /* ignore lock file errors */ }
    }

    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    for (const [name, skill] of Object.entries(skills) as [string, any][]) {
      if (!skill.source || skill.source.registry !== 'skills.sh') continue;

      // Check staleness by age — prefer updatedAt, fall back to installedAt
      const dateStr = skill.source.updatedAt || skill.source.installedAt;
      if (dateStr) {
        const timestamp = new Date(dateStr).getTime();
        if (now - timestamp > THIRTY_DAYS_MS) {
          result.stale.push(name);
        }
      }

      // Check if lock file shows a different hash (skill was updated externally)
      if (lockData[name] && skill.source.folderHash) {
        if (lockData[name].skillFolderHash !== skill.source.folderHash) {
          result.needsRevetting.push(name);
        }
      }
    }
  } catch {
    // Fail silently -- don't block session start
  }

  return result;
}

function detectProjectStack(projectDir: string): string[] {
  const stack: string[] = [];

  // Check package.json dependencies
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      stack.push(...Object.keys(allDeps));
    } catch { /* skip */ }
  }

  // Check pyproject.toml for Python deps (simple pattern, no TOML parser)
  const pyprojectPath = path.join(projectDir, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf-8');
      const depMatches = content.match(/^\s*"?([a-zA-Z0-9_-]+)"?\s*[>=<~^]/gm);
      if (depMatches) {
        stack.push(...depMatches.map(m => m.trim().replace(/[">=<~^ ]/g, '')));
      }
    } catch { /* skip */ }
  }

  // Check for file-based indicators at top level and one level deep
  try {
    const topLevelFiles = fs.readdirSync(projectDir);
    if (topLevelFiles.some(f => f.endsWith('.bicep') || f.endsWith('.bicepparam'))) {
      stack.push('@azure/bicep-indicator');
    }
    if (topLevelFiles.includes('Cargo.toml')) {
      stack.push('rust-indicator');
    }
    if (topLevelFiles.includes('go.mod')) {
      stack.push('go-indicator');
    }

    // Scan one level deep for monorepo structures
    for (const entry of topLevelFiles) {
      try {
        const subPath = path.join(projectDir, entry);
        const stat = fs.statSync(subPath);
        if (!stat.isDirectory() || entry.startsWith('.') || entry === 'node_modules') continue;

        const subFiles = fs.readdirSync(subPath);

        // Check subdirectory package.json
        if (subFiles.includes('package.json')) {
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(subPath, 'package.json'), 'utf-8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            stack.push(...Object.keys(allDeps));
          } catch { /* skip */ }
        }

        // Check subdirectory pyproject.toml
        if (subFiles.includes('pyproject.toml')) {
          try {
            const content = fs.readFileSync(path.join(subPath, 'pyproject.toml'), 'utf-8');
            const depMatches = content.match(/^\s*"?([a-zA-Z0-9_-]+)"?\s*[>=<~^]/gm);
            if (depMatches) {
              stack.push(...depMatches.map(m => m.trim().replace(/[">=<~^ ]/g, '')));
            }
          } catch { /* skip */ }
        }

        // Check for Bicep files in subdirectories
        if (subFiles.some(f => f.endsWith('.bicep') || f.endsWith('.bicepparam'))) {
          if (!stack.includes('@azure/bicep-indicator')) {
            stack.push('@azure/bicep-indicator');
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return stack;
}

function findRecommendedSkills(projectStack: string[], installedSkills: Set<string>): SkillRecommendation[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const catalogPath = path.join(homeDir, '.claude', 'skills', 'skill-catalog.json');
  if (!fs.existsSync(catalogPath)) return [];

  let catalog: SkillCatalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
  } catch {
    return [];
  }

  const recommendations: SkillRecommendation[] = [];

  for (const [stackName, stackDef] of Object.entries(catalog.stacks)) {
    const matched = stackDef.indicators.some(ind =>
      projectStack.some(dep => dep.toLowerCase() === ind.toLowerCase())
    );

    // Also check file-based indicators
    const fileMatched = (stackDef.fileIndicators || []).some(pattern => {
      const ext = pattern.replace('*', '');
      return projectStack.some(dep => dep.includes(ext + '-indicator') || dep.toLowerCase().includes(ext));
    });

    if (matched || fileMatched) {
      for (const skill of stackDef.skills) {
        if (!installedSkills.has(skill.name)) {
          recommendations.push({ ...skill, stackName });
        }
      }
    }
  }

  return recommendations;
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let data: SessionStartInput;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const sessionType = data.source || data.type || 'startup';

  if (sessionType !== 'startup') {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (projectDir.includes('.claude') && !projectDir.includes('continuous-claude')) {
    // Phase 3 (cross-project isolation): warn so the user knows why bootstrap
    // was skipped instead of silently no-oping.
    console.error(
      `[init-check] Skipping bootstrap: project path contains '.claude' (cwd=${projectDir}). ` +
      `Set CLAUDE_PROJECT_DIR explicitly to override.`
    );
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // FH-01a: warm the tldr code-analysis daemon for code projects on startup
  // (fire-and-forget — never blocks; see warmTldrDaemon for the idempotency
  // contract). Best-effort: a warm failure is silent and non-fatal.
  if (hasCodeFiles(projectDir) && warmTldrDaemon(projectDir)) {
    console.error('[init-check] warming tldr daemon (background)');
  }

  const status = isInitialized(projectDir);
  let treeGenFailed = false;

  // Generate tree lazily if missing or stale
  if (!status.tree || isTreeStale(projectDir)) {
    if (hasCodeFiles(projectDir)) {
      console.error('[*] Generating knowledge tree...');
      const generated = generateTree(projectDir);
      if (generated) {
        console.error('[ok] Knowledge tree generated');
        status.tree = true;
      } else {
        console.error('[!] Failed to generate knowledge tree');
        treeGenFailed = true;
      }
    }
  }

  // Check external skill staleness
  const skillStaleness = checkExternalSkillStaleness();
  const hasSkillIssues = skillStaleness.needsRevetting.length > 0 || skillStaleness.stale.length > 0;

  // Check for available skills based on project stack
  let skillRecommendations: SkillRecommendation[] = [];
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const rulesPath = path.join(homeDir, '.claude', 'skills', 'skill-rules.json');
    const installedSkills = new Set<string>();
    if (fs.existsSync(rulesPath)) {
      try {
        const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
        for (const name of Object.keys(rules.skills || {})) {
          installedSkills.add(name);
        }
      } catch { /* skip */ }
    }

    const projectStack = detectProjectStack(projectDir);
    if (projectStack.length > 0) {
      skillRecommendations = findRecommendedSkills(projectStack, installedSkills);
    }
  } catch { /* never block session start */ }

  const hasRecommendations = skillRecommendations.length > 0;

  // If fully initialized, no failures, and no skill issues, continue silently
  if (status.tree && status.roadmap && !treeGenFailed && !hasSkillIssues && !hasRecommendations) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (!hasCodeFiles(projectDir) && !hasSkillIssues && !hasRecommendations) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Collect missing/failed items
  const missing: string[] = [];
  if (!status.roadmap) missing.push('ROADMAP.md');
  if (treeGenFailed) missing.push('knowledge-tree.json (generation failed - agents will lack project context)');

  // Collect skill staleness warnings
  const skillWarnings: string[] = [];
  if (skillStaleness.needsRevetting.length > 0) {
    skillWarnings.push(`[!] ${skillStaleness.needsRevetting.length} skill(s) updated externally, need re-vetting: ${skillStaleness.needsRevetting.join(', ')}. Run /vet-skill --all-unvetted`);
  }
  if (skillStaleness.stale.length > 0) {
    skillWarnings.push(`[i] ${skillStaleness.stale.length} skill(s) installed 30+ days ago without update check: ${skillStaleness.stale.join(', ')}. Run npx skills check`);
  }

  // Build skill recommendation messages
  const skillRecommendationMessages: string[] = [];
  if (skillRecommendations.length > 0) {
    const lines = skillRecommendations.map(r =>
      `  - ${r.name} (${r.publisher}): npx skills add ${r.source} -g -y`
    );
    skillRecommendationMessages.push(
      `[i] Skills available for this project stack:\n${lines.join('\n')}\nInstall relevant skills to enhance your work on this project.`
    );
  }

  // Check ROADMAP bloat
  const maintenanceWarnings: string[] = [];
  const roadmapPath = path.join(projectDir, 'ROADMAP.md');
  if (fs.existsSync(roadmapPath)) {
    try {
      const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
      const completedCount = (roadmapContent.match(/^- \[x\]/gm) || []).length;
      if (completedCount > 50) {
        maintenanceWarnings.push(`[i] ROADMAP has ${completedCount} completed items (threshold: 50). Consider archiving old entries.`);
      }
    } catch { /* fail silently */ }
  }

  // Check hook build freshness (CCv3 repo only)
  if (projectDir.includes('continuous-claude')) {
    const hookSrcDir = path.join(projectDir, '.claude', 'hooks', 'src');
    const hookDistDir = path.join(projectDir, '.claude', 'hooks', 'dist');
    if (fs.existsSync(hookSrcDir) && fs.existsSync(hookDistDir)) {
      try {
        // Compare against the newest dist BUNDLE, not the dist DIRECTORY. A
        // directory's mtime only moves when entries are added/removed/renamed, so
        // a rebuild that overwrites every .mjs in place leaves it untouched — the
        // old predicate reported "stale" on a freshly built tree, every session.
        const bundles = fs.readdirSync(hookDistDir).filter(f => f.endsWith('.mjs'));
        const newestBundleMtime = bundles.reduce((max, f) => {
          try { return Math.max(max, fs.statSync(path.join(hookDistDir, f)).mtimeMs); } catch { return max; }
        }, 0);
        // Walk src recursively: shared/*.ts are bundled into dist too, so a
        // non-recursive readdir cannot see the edits most likely to need a build.
        const srcFiles: string[] = [];
        const walk = (dir: string) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === '__tests__' || e.name === 'node_modules') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.ts')) srcFiles.push(full);
          }
        };
        walk(hookSrcDir);
        const staleFiles = newestBundleMtime === 0 ? srcFiles : srcFiles.filter(f => {
          try { return fs.statSync(f).mtimeMs > newestBundleMtime; } catch { return false; }
        });
        if (staleFiles.length > 0) {
          const names = staleFiles.slice(0, 3).map(f => path.relative(hookSrcDir, f)).join(', ');
          const more = staleFiles.length > 3 ? `, +${staleFiles.length - 3} more` : '';
          maintenanceWarnings.push(`[!] Hook dist/ is stale -- ${staleFiles.length} of ${srcFiles.length} sources newer than the newest bundle (${names}${more}). Run: cd ~/.claude/hooks && npm run build`);
        }
      } catch { /* fail silently */ }
    }
  }

  if (missing.length === 0 && skillWarnings.length === 0 && skillRecommendationMessages.length === 0 && maintenanceWarnings.length === 0) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let message = '';
  if (missing.length > 0) {
    message += `[!] Project partially initialized. Missing: ${missing.join(', ')}. Run /init-project for full Continuous Claude setup.`;
  }
  if (skillWarnings.length > 0) {
    if (message) message += ' | ';
    message += skillWarnings.join(' | ');
  }
  if (skillRecommendationMessages.length > 0) {
    if (message) message += '\n';
    message += skillRecommendationMessages.join('\n');
  }
  if (maintenanceWarnings.length > 0) {
    if (message) message += '\n';
    message += maintenanceWarnings.join('\n');
  }

  console.error(message);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: message,
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
  });
}

// Auto-run ONLY when invoked directly as the hook (argv[1] is this script).
// When a unit test imports this module (to test warmTldrDaemon), vitest sets
// argv[1] to its own runner, so main() — whose readStdin() would block — does
// NOT run. Production is unchanged: the hook is always executed as
// `node dist/session-start-init-check.mjs`, whose argv[1] contains this name.
if ((process.argv[1] || '').includes('session-start-init-check')) {
  main().catch(err => {
    console.error('session-start-init-check error:', err);
    console.log(JSON.stringify({ result: 'continue' }));
  });
}
