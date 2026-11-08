import * as fs from 'fs';
import * as path from 'path';
import { parseTranscript, generateAutoHandoff } from './lib/transcript-parser.js';

interface PreCompactInput {
  trigger: 'manual' | 'auto';
  session_id: string;
  transcript_path: string;
  custom_instructions?: string;
}

interface HookOutput {
  continue?: boolean;
  systemMessage?: string;
}

async function main() {
  const input: PreCompactInput = JSON.parse(await readStdin());
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Find existing ledger files (guard against missing directory)
  const ledgerDir = path.join(projectDir, 'thoughts', 'ledgers');
  const ledgerFiles = fs.existsSync(ledgerDir)
    ? fs.readdirSync(ledgerDir)
        .filter(f => f.startsWith('CONTINUITY_CLAUDE-') && f.endsWith('.md'))
    : [];

  let handoffFile = '';
  let ledgerMessage = '';

  if (ledgerFiles.length > 0) {
    // Get most recent ledger
    const mostRecent = ledgerFiles.sort((a, b) => {
      const statA = fs.statSync(path.join(ledgerDir, a));
      const statB = fs.statSync(path.join(ledgerDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    })[0];

    const ledgerPath = path.join(ledgerDir, mostRecent);

    if (input.trigger === 'auto') {
      // Auto-compact: Use transcript parser to generate full handoff
      const sessionName = mostRecent.replace('CONTINUITY_CLAUDE-', '').replace('.md', '');

      if (input.transcript_path && fs.existsSync(input.transcript_path)) {
        // Parse transcript and generate handoff
        const summary = parseTranscript(input.transcript_path);
        const handoffContent = generateAutoHandoff(summary, sessionName);

        // Ensure handoff directory exists
        const handoffDir = path.join(projectDir, 'thoughts', 'shared', 'handoffs', sessionName);
        fs.mkdirSync(handoffDir, { recursive: true });

        // Write handoff with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        handoffFile = `auto-handoff-${timestamp}.yaml`;
        const handoffPath = path.join(handoffDir, handoffFile);

        fs.writeFileSync(handoffPath, handoffContent);

        // Also append brief summary to ledger for visibility
        const briefSummary = generateAutoSummary(projectDir, input.session_id);
        if (briefSummary) {
          appendToLedger(ledgerPath, briefSummary);
        }
      } else {
        // Fallback: no transcript, use legacy summary
        const briefSummary = generateAutoSummary(projectDir, input.session_id);
        if (briefSummary) {
          appendToLedger(ledgerPath, briefSummary);
        }
      }

      ledgerMessage = handoffFile
        ? `[PreCompact:auto] Created YAML handoff: thoughts/shared/handoffs/${mostRecent.replace('CONTINUITY_CLAUDE-', '').replace('.md', '')}/${handoffFile}`
        : `[PreCompact:auto] Session summary auto-appended to ${mostRecent}`;
    } else {
      // Manual compact with ledger
      ledgerMessage = `[PreCompact] Consider updating ledger before compacting: /continuity_ledger\nLedger: ${mostRecent}`;
    }
  }

  const output: HookOutput = {
    continue: true,
    systemMessage: ledgerMessage || handoffMessage(projectDir, input.session_id)
  };
  console.log(JSON.stringify(output));
}

export function formatAge(ms: number): string {
  if (!(ms >= 60_000)) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function listHandoffYaml(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // Symlinked/junction folders are skipped on purpose: isDirectory() is false for them (no loops, no leaving the tree).
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listHandoffYaml(full, out);
    else if (e.isFile() && /\.ya?ml$/i.test(e.name)) out.push(full);
  }
  return out;
}

function newestByMtime(files: string[]): { file: string; mtime: number } | null {
  let best: { file: string; mtime: number } | null = null;
  for (const file of files) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {}
  }
  return best;
}

// Message used when no ledger exists. Prefers a handoff whose file name carries
// the session's sid8; otherwise the newest yaml under thoughts/shared/handoffs.
export function handoffMessage(projectDir: string, sessionId?: string, now: number = Date.now()): string {
  const files = listHandoffYaml(path.join(projectDir, 'thoughts', 'shared', 'handoffs'));
  const sid8 = (sessionId || '').slice(0, 8);
  const mine = sid8.length === 8 ? files.filter(f => path.basename(f).includes(sid8)) : [];
  const best = newestByMtime(mine.length > 0 ? mine : files);
  if (!best) return '[PreCompact] no ledger and no handoff found';
  const rel = path.relative(projectDir, best.file).split(path.sep).join('/');
  return `[PreCompact] newest handoff: ${rel} (${formatAge(now - best.mtime)})`;
}

function generateAutoSummary(projectDir: string, sessionId: string): string | null {
  const timestamp = new Date().toISOString();
  const lines: string[] = [];

  // Read edited files from PostToolUse cache
  const cacheDir = path.join(projectDir, '.claude', 'tsc-cache', sessionId || 'default');
  const editedFilesPath = path.join(cacheDir, 'edited-files.log');

  let editedFiles: string[] = [];
  if (fs.existsSync(editedFilesPath)) {
    const content = fs.readFileSync(editedFilesPath, 'utf-8');
    // Format: timestamp:filepath:repo per line
    editedFiles = [...new Set(
      content.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split(':');
          // filepath is second part, remove project dir prefix
          return parts[1]?.replace(projectDir + '/', '') || '';
        })
        .filter(f => f)
    )];
  }

  // Read build attempts from .git/claude
  const gitClaudeDir = path.join(projectDir, '.git', 'claude', 'branches');
  let buildAttempts = { passed: 0, failed: 0 };

  if (fs.existsSync(gitClaudeDir)) {
    try {
      const branches = fs.readdirSync(gitClaudeDir);
      for (const branch of branches) {
        const attemptsFile = path.join(gitClaudeDir, branch, 'attempts.jsonl');
        if (fs.existsSync(attemptsFile)) {
          const content = fs.readFileSync(attemptsFile, 'utf-8');
          content.split('\n').filter(l => l.trim()).forEach(line => {
            try {
              const attempt = JSON.parse(line);
              if (attempt.type === 'build_pass') buildAttempts.passed++;
              if (attempt.type === 'build_fail') buildAttempts.failed++;
            } catch {}
          });
        }
      }
    } catch {}
  }

  // Only generate summary if we have something to report
  if (editedFiles.length === 0 && buildAttempts.passed === 0 && buildAttempts.failed === 0) {
    return null;
  }

  lines.push(`\n## Session Auto-Summary (${timestamp})`);

  if (editedFiles.length > 0) {
    lines.push(`- Files changed: ${editedFiles.slice(0, 10).join(', ')}${editedFiles.length > 10 ? ` (+${editedFiles.length - 10} more)` : ''}`);
  }

  if (buildAttempts.passed > 0 || buildAttempts.failed > 0) {
    lines.push(`- Build/test: ${buildAttempts.passed} passed, ${buildAttempts.failed} failed`);
  }

  return lines.join('\n');
}

function appendToLedger(ledgerPath: string, summary: string): void {
  try {
    let content = fs.readFileSync(ledgerPath, 'utf-8');

    // Find the "## State" section and append after "Done:" items
    const stateMatch = content.match(/## State\n/);
    if (stateMatch) {
      // Find end of Done section (before "- Now:" or "- Next:")
      const nowMatch = content.match(/(\n-\s*Now:)/);
      if (nowMatch && nowMatch.index) {
        // Insert summary before "Now:"
        content = content.slice(0, nowMatch.index) + summary + content.slice(nowMatch.index);
      } else {
        // Just append to end of State section
        const nextSection = content.indexOf('\n## ', content.indexOf('## State') + 1);
        if (nextSection > 0) {
          content = content.slice(0, nextSection) + summary + '\n' + content.slice(nextSection);
        } else {
          content += summary;
        }
      }
    } else {
      // No State section, append to end
      content += summary;
    }

    fs.writeFileSync(ledgerPath, content);
  } catch (err) {
    // Silently fail - don't break compact
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

if ((process.argv[1] || '').includes('pre-compact-continuity')) {
  main().catch(console.error);
}
