import * as fs from 'fs';
import * as path from 'path';
import { parseTranscript, generateAutoHandoff } from './transcript-parser.js';
import { readRalphUnifiedState } from './shared/state-schema.js';

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

/**
 * Generate Ralph state YAML snippet for inclusion in auto-handoff.
 * Returns null if no active Ralph session.
 */
function getRalphStateYaml(projectDir: string): string | null {
  try {
    const state = readRalphUnifiedState(projectDir);
    if (!state) return null;

    const hasActive = state.session?.active === true;
    const inProgress = (state.tasks || []).filter(t => t.status === 'in_progress' || t.status === 'in-progress');
    const completed = (state.tasks || []).filter(t => t.status === 'complete' || t.status === 'completed');
    const problemTasks = (state.tasks || []).filter(t =>
      ['failed', 'blocked', 'paused', 'cancelled'].includes(t.status)
    );
    const total = (state.tasks || []).length;

    if (!hasActive && inProgress.length === 0 && problemTasks.length === 0) return null;

    const currentTaskName = inProgress.length > 0
      ? (inProgress[0].name || inProgress[0].id || 'current task').replace(/"/g, '\\"')
      : 'orchestration complete';

    const lines: string[] = [];
    lines.push(`ralph_state:`);
    lines.push(`  story_id: "${state.story_id || 'unknown'}"`);
    lines.push(`  stage: "${state.stage || 'unknown'}"`);
    lines.push(`  iteration: ${state.iteration || 0}`);
    lines.push(`  max_iterations: ${state.max_iterations || 30}`);
    lines.push(`  progress: "${completed.length}/${total} tasks complete"`);
    lines.push(`  retry_queue_size: ${(state.retry_queue || []).length}`);

    if (inProgress.length > 0) {
      lines.push(`  active_task:`);
      lines.push(`    id: "${inProgress[0].id}"`);
      lines.push(`    name: "${(inProgress[0].name || '').replace(/"/g, '\\"')}"`);
      lines.push(`    agent: "${inProgress[0].agent || 'unassigned'}"`);
    }

    const pending = (state.tasks || []).filter(t => t.status === 'pending');
    if (pending.length > 0) {
      lines.push(`  pending_tasks: [${pending.slice(0, 10).map(t => `"${t.id}"`).join(', ')}]`);
    }

    if (problemTasks.length > 0) {
      lines.push(`  problem_tasks: [${problemTasks.slice(0, 10).map(t => `"${t.id}(${t.status})"`).join(', ')}]`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
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

        // Append Ralph state to handoff if active
        const ralphYaml = getRalphStateYaml(projectDir);
        const finalContent = ralphYaml
          ? handoffContent + '\n\n' + ralphYaml + '\n'
          : handoffContent;
        fs.writeFileSync(handoffPath, finalContent);

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

  // ALWAYS attempt Ralph state preservation (independent of ledger existence)
  const ralphYaml = getRalphStateYaml(projectDir);

  if (ralphYaml) {
    if (handoffFile) {
      // Ralph state already included in the ledger-based handoff above
      ledgerMessage += ' (Ralph state preserved)';
    } else {
      // No ledger handoff was created, but Ralph is active — write standalone Ralph handoff
      const handoffDir = path.join(projectDir, 'thoughts', 'shared', 'handoffs', 'ralph-auto');
      fs.mkdirSync(handoffDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ralphHandoffFile = `ralph-handoff-${timestamp}.yaml`;
      const storyId = ralphYaml.match(/story_id:\s*"([^"]+)"/)?.[1] || '';
      const currentTask = ralphYaml.match(/name:\s*"([^"]+)"/)?.[1] || 'orchestration';
      // When story_id is unknown, describe the goal by the current task rather than
      // a fixed "story unknown" placeholder — the fixed string was being extracted into
      // archival_memory as identical WORKING_SOLUTION rows (curated out 2026-07-16).
      const goal = storyId
        ? `Ralph orchestration for story ${storyId}`
        : `Ralph orchestration: ${currentTask}`;
      fs.writeFileSync(
        path.join(handoffDir, ralphHandoffFile),
        `---\ntype: auto-handoff\nsession: ralph-auto\ndate: ${new Date().toISOString().split('T')[0]}\n---\n\ngoal: "${goal}"\nnow: "${currentTask}"\n\n${ralphYaml}\n`
      );
      ledgerMessage = `[PreCompact] Ralph state preserved to thoughts/shared/handoffs/ralph-auto/${ralphHandoffFile}`;
    }
  }

  const output: HookOutput = {
    continue: true,
    systemMessage: ledgerMessage || '[PreCompact] No continuity data to preserve'
  };
  console.log(JSON.stringify(output));
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
