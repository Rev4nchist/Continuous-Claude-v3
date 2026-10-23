/**
 * Transcript Parser Module
 *
 * Parses JSONL transcript files from Claude Code sessions and extracts
 * high-signal data for use by PreCompact hooks and auto-handoff generation.
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';

// ============================================================================
// Type Definitions
// ============================================================================

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolCall {
  name: string;
  timestamp?: string;
  input?: Record<string, unknown>;
  success?: boolean;
}

export interface TranscriptSummary {
  lastTodos: TodoItem[];
  recentToolCalls: ToolCall[];
  lastAssistantMessage: string;
  filesModified: string[];
  errorsEncountered: string[];
}

// Internal types for parsing
interface TranscriptEntry {
  type?: string;
  role?: string;
  content?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  timestamp?: string;
  error?: string;
}

interface TodoWriteInput {
  todos?: Array<{
    id?: string;
    content?: string;
    status?: string;
  }>;
}

interface EditWriteInput {
  file_path?: string;
  path?: string;
}

interface BashInput {
  command?: string;
}

interface BashResult {
  exit_code?: number;
  exitCode?: number;
  stderr?: string;
  error?: string;
}

// ============================================================================
// Parse Functions
// ============================================================================

/**
 * Parse a JSONL transcript file and extract high-signal data.
 *
 * @param transcriptPath - Absolute path to the JSONL transcript file
 * @returns TranscriptSummary with extracted data
 */
export function parseTranscript(transcriptPath: string): TranscriptSummary {
  const summary: TranscriptSummary = {
    lastTodos: [],
    recentToolCalls: [],
    lastAssistantMessage: '',
    filesModified: [],
    errorsEncountered: []
  };

  if (!fs.existsSync(transcriptPath)) {
    return summary;
  }

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return summary;
  }
  const lines = content.split('\n').filter(line => line.trim());

  const allToolCalls: ToolCall[] = [];
  const modifiedFiles = new Set<string>();
  const errors: string[] = [];
  let lastTodoState: TodoItem[] = [];
  let lastAssistant = '';

  for (const line of lines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);

      // Extract last assistant message
      if (entry.role === 'assistant' && typeof entry.content === 'string') {
        lastAssistant = entry.content;
      } else if (entry.type === 'assistant' && typeof entry.content === 'string') {
        lastAssistant = entry.content;
      }

      // Extract tool calls
      if (entry.tool_name || entry.type === 'tool_use') {
        const toolName = entry.tool_name || (entry as Record<string, unknown>).name as string;
        if (toolName) {
          const toolCall: ToolCall = {
            name: toolName,
            timestamp: entry.timestamp,
            input: entry.tool_input,
            success: true // Will be updated by result
          };

          // Check for TodoWrite to capture state
          if (toolName === 'TodoWrite' || toolName.toLowerCase().includes('todowrite')) {
            const input = entry.tool_input as TodoWriteInput | undefined;
            if (input?.todos) {
              lastTodoState = input.todos.map((t, idx) => {
                // Whitelist allowed status values; the type system can't
                // protect us from a transcript that contains arbitrary
                // strings (corrupt JSONL, schema drift, etc.).
                const rawStatus = t.status as unknown;
                const status: TodoItem['status'] =
                  rawStatus === 'pending' ||
                  rawStatus === 'in_progress' ||
                  rawStatus === 'completed'
                    ? rawStatus
                    : 'pending';
                return {
                  id: t.id || `todo-${idx}`,
                  content: t.content || '',
                  status,
                };
              });
            }
          }

          // Track file modifications from Edit/Write tools
          if (toolName === 'Edit' || toolName === 'Write' ||
              toolName.toLowerCase().includes('edit') ||
              toolName.toLowerCase().includes('write')) {
            const input = entry.tool_input as EditWriteInput | undefined;
            const filePath = input?.file_path || input?.path;
            if (filePath && typeof filePath === 'string') {
              modifiedFiles.add(filePath);
            }
          }

          // Track Bash commands for potential errors
          if (toolName === 'Bash' || toolName.toLowerCase().includes('bash')) {
            const input = entry.tool_input as BashInput | undefined;
            if (input?.command) {
              toolCall.input = { command: input.command };
            }
          }

          allToolCalls.push(toolCall);
        }
      }

      // Extract tool results and check for failures
      if (entry.type === 'tool_result' || entry.tool_result !== undefined) {
        const result = entry.tool_result as BashResult | undefined;

        // Check for Bash failures
        if (result) {
          const exitCode = result.exit_code ?? result.exitCode;
          if (exitCode !== undefined && exitCode !== 0) {
            // Mark last tool call as failed
            if (allToolCalls.length > 0) {
              allToolCalls[allToolCalls.length - 1].success = false;
            }

            // Extract error message
            const errorMsg = result.stderr || result.error || 'Command failed';
            const lastTool = allToolCalls[allToolCalls.length - 1];
            const command = (lastTool?.input as BashInput)?.command || 'unknown command';
            errors.push(`${command}: ${errorMsg.substring(0, 200)}`);
          }
        }

        // Check for explicit errors
        if (entry.error) {
          errors.push(entry.error.substring(0, 200));
          if (allToolCalls.length > 0) {
            allToolCalls[allToolCalls.length - 1].success = false;
          }
        }
      }

    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }

  // Populate summary
  summary.lastTodos = lastTodoState;
  summary.recentToolCalls = allToolCalls.slice(-5); // Last 5 tool calls
  summary.lastAssistantMessage = lastAssistant.substring(0, 500);
  summary.filesModified = Array.from(modifiedFiles);
  summary.errorsEncountered = errors.slice(-5); // Last 5 errors

  return summary;
}

// ============================================================================
// Auto-Handoff Generation
// ============================================================================

/**
 * Escape a dynamic value for safe embedding inside a YAML double-quoted string.
 * Handles: backslash, double-quote, control chars, unprintables, and the
 * non-printable characters YAML 1.2 forbids in flow scalars.
 *
 * Use as: `key: "${yamlSafe(value)}"` -- the surrounding quotes are caller-supplied.
 * Returns an empty string for null/undefined.
 */
function yamlSafe(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    // YAML 1.2 double-quoted: \\, \", \t, \n, \r, \0, \b, \f
    if (ch === 0x5c) { out += '\\\\'; continue; }      // backslash
    if (ch === 0x22) { out += '\\"'; continue; }       // double quote
    if (ch === 0x09) { out += '\\t'; continue; }       // tab
    if (ch === 0x0a) { out += '\\n'; continue; }       // newline
    if (ch === 0x0d) { out += '\\r'; continue; }       // carriage return
    if (ch === 0x00) { out += '\\0'; continue; }       // null
    if (ch === 0x08) { out += '\\b'; continue; }       // backspace
    if (ch === 0x0c) { out += '\\f'; continue; }       // form feed
    // Other C0/C1 controls: drop or hex-escape
    if (ch < 0x20 || (ch >= 0x7f && ch < 0xa0)) {
      out += '\\x' + ch.toString(16).padStart(2, '0');
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * Escape a dynamic value for safe embedding inside a YAML plain scalar
 * (no surrounding quotes). Strips/quotes characters that would break parsing
 * (`:`, `#`, leading `-`, control chars, leading/trailing whitespace).
 * Returns the value wrapped in double quotes when escaping is needed.
 */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const s = typeof value === 'string' ? value : String(value);
  // If the value is empty or contains chars that can confuse YAML, emit a quoted form.
  // We're conservative: any char outside [A-Za-z0-9 _./-] triggers quoting.
  if (s.length === 0 || /[^A-Za-z0-9 _./\-]/.test(s) || /^\s|\s$/.test(s) || /^[-?@`!&*|>'%,\[\]\{\}#]/.test(s)) {
    return `"${yamlSafe(s)}"`;
  }
  return s;
}

/**
 * Generate a YAML auto-handoff document from a transcript summary.
 * Uses the same format as /create_handoff for consistency.
 *
 * @param summary - TranscriptSummary from parseTranscript
 * @param sessionName - Name of the session for metadata
 * @returns YAML string suitable for writing to a handoff file
 */
export function generateAutoHandoff(summary: TranscriptSummary, sessionName: string): string {
  const timestamp = new Date().toISOString();
  const dateOnly = timestamp.split('T')[0];
  const lines: string[] = [];

  // Extract goal and now from todos
  const inProgress = summary.lastTodos.filter(t => t.status === 'in_progress');
  const pending = summary.lastTodos.filter(t => t.status === 'pending');
  const completed = summary.lastTodos.filter(t => t.status === 'completed');

  const currentTask = inProgress[0]?.content || pending[0]?.content || 'Continue from auto-compact';
  const goalSummary = completed.length > 0
    ? `Completed ${completed.length} task(s) before auto-compact`
    : 'Session auto-compacted';

  // YAML frontmatter
  lines.push('---');
  lines.push(`session: ${yamlScalar(sessionName)}`);
  lines.push(`date: ${yamlScalar(dateOnly)}`);
  lines.push('status: partial');
  lines.push('outcome: PARTIAL_PLUS');
  lines.push('---');
  lines.push('');

  // Required fields for statusline
  lines.push(`goal: ${yamlScalar(goalSummary)}`);
  lines.push(`now: ${yamlScalar(currentTask)}`);
  lines.push('test: # No test command captured');
  lines.push('');

  // Done this session
  lines.push('done_this_session:');
  if (completed.length > 0) {
    completed.forEach(t => {
      lines.push(`  - task: "${yamlSafe(t.content)}"`);
      lines.push('    files: []');
    });
  } else {
    lines.push('  - task: "Session started"');
    lines.push('    files: []');
  }
  lines.push('');

  // Blockers (from errors)
  lines.push('blockers:');
  if (summary.errorsEncountered.length > 0) {
    summary.errorsEncountered.slice(0, 3).forEach(e => {
      const safeError = yamlSafe(typeof e === 'string' ? e.substring(0, 100) : String(e).substring(0, 100));
      lines.push(`  - "${safeError}"`);
    });
  } else {
    lines.push('  []');
  }
  lines.push('');

  // Questions (pending tasks as questions)
  lines.push('questions:');
  if (pending.length > 0) {
    pending.slice(0, 3).forEach(t => {
      lines.push(`  - "Resume: ${yamlSafe(t.content)}"`);
    });
  } else {
    lines.push('  []');
  }
  lines.push('');

  // Decisions
  lines.push('decisions:');
  lines.push('  - auto_compact: "Context limit reached, auto-compacted"');
  lines.push('');

  // Findings
  lines.push('findings:');
  lines.push(`  - tool_calls: "${yamlSafe(summary.recentToolCalls.length + ' recent tool calls')}"`);
  lines.push(`  - files_modified: "${yamlSafe(summary.filesModified.length + ' files changed')}"`);
  lines.push('');

  // Worked/Failed
  lines.push('worked:');
  const successfulTools = summary.recentToolCalls.filter(t => t.success);
  if (successfulTools.length > 0) {
    lines.push(`  - "${yamlSafe(successfulTools.map(t => t.name).join(', ') + ' completed successfully')}"`);
  } else {
    lines.push('  []');
  }
  lines.push('');

  lines.push('failed:');
  const failedTools = summary.recentToolCalls.filter(t => !t.success);
  if (failedTools.length > 0) {
    lines.push(`  - "${yamlSafe(failedTools.map(t => t.name).join(', ') + ' encountered errors')}"`);
  } else {
    lines.push('  []');
  }
  lines.push('');

  // Next steps
  lines.push('next:');
  if (inProgress.length > 0) {
    lines.push(`  - "Continue: ${yamlSafe(inProgress[0].content)}"`);
  }
  if (pending.length > 0) {
    pending.slice(0, 2).forEach(t => {
      lines.push(`  - "${yamlSafe(t.content)}"`);
    });
  }
  if (inProgress.length === 0 && pending.length === 0) {
    lines.push('  - "Review session state and continue"');
  }
  lines.push('');

  // Files
  lines.push('files:');
  lines.push('  created: []');
  lines.push('  modified:');
  if (summary.filesModified.length > 0) {
    summary.filesModified.slice(0, 10).forEach(f => {
      lines.push(`    - "${yamlSafe(f)}"`);
    });
  } else {
    lines.push('    []');
  }

  return lines.join('\n');
}

// ============================================================================
// CLI Entry Point (for testing)
// ============================================================================

// Allow running as CLI for testing: npx tsx transcript-parser.ts /path/to/transcript.jsonl
// ES module compatible entry point check. Build the comparison via
// pathToFileURL() so platform-specific quirks (Windows drive letters,
// percent-encoded spaces) don't make a hand-built `file://...` string
// silently fail to match.
const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: npx tsx transcript-parser.ts <transcript-path> [session-name]');
    process.exit(1);
  }

  const transcriptPath = args[0];
  const sessionName = args[1] || 'test-session';

  console.log(`Parsing transcript: ${transcriptPath}`);
  const summary = parseTranscript(transcriptPath);

  console.log('\n--- Summary ---');
  console.log(JSON.stringify(summary, null, 2));

  console.log('\n--- Auto-Handoff ---');
  console.log(generateAutoHandoff(summary, sessionName));
}
