/**
 * pr-opened-coderabbit-loop -- PostToolUse hook (matcher: Bash|PowerShell).
 *
 * Detects a PR being opened (`gh pr create` or `gh api ... /pulls -X POST`)
 * and, when the tool response looks like a genuine success (a PR URL or a
 * "number" field), injects additionalContext telling the model to start the
 * PR review loop (see rules-ondemand/pr-review-loop.md) in the same turn. The file keeps
 * its old name so neither settings.json copy changes; the reviewer is now Greptile.
 *
 * Fires at most once per PR URL per session: a small state file under
 * os.tmpdir(), keyed by session_id + url, suppresses repeats.
 *
 * Fails open on any error: exit 0, emit "{}", never block the tool call.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

const PR_CREATE_RE = /\bgh\s+pr\s+create\b/i;
const GH_API_RE = /\bgh\s+api\b/i;
const PULLS_PATH_RE = /\/pulls\b/i;
const POST_METHOD_RE = /(-X\s*POST|--method\s*POST)/i;

const PR_URL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/;

export function isPrOpenCommand(command: string): boolean {
  const cmd = command || '';
  if (PR_CREATE_RE.test(cmd)) return true;
  if (GH_API_RE.test(cmd) && PULLS_PATH_RE.test(cmd) && POST_METHOD_RE.test(cmd)) return true;
  return false;
}

export function responseText(resp: unknown): string {
  if (resp === null || resp === undefined) return '';
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const o = resp as Record<string, unknown>;
    const parts = [o.output, o.stdout, o.stderr, o.content].filter(
      (v): v is string => typeof v === 'string',
    );
    if (parts.length) return parts.join('\n');
  }
  try {
    return JSON.stringify(resp ?? '');
  } catch {
    return '';
  }
}

export interface PrInfo {
  owner: string;
  repo: string;
  number: string;
  url: string;
}

/**
 * A command "looking like" a PR-open request is not enough -- the call may
 * have failed. Require the response to carry a real PR URL, or (for `gh api`
 * JSON responses that don't echo the html_url) a "number" field alongside an
 * html_url/url we can still extract from.
 */
export function extractPrInfo(responseTxt: string): PrInfo | null {
  const urlMatch = responseTxt.match(PR_URL_RE);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3], url: urlMatch[0] };
  }
  return null;
}

/** Cheap signal a `gh api` JSON response contains a created-object "number" field. */
export function hasNumberField(responseTxt: string): boolean {
  return /"number"\s*:\s*\d+/.test(responseTxt);
}

function statePath(sessionId: string): string {
  const safeSession = (sessionId || 'no-session').replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(tmpdir(), `pr-opened-coderabbit-loop-${safeSession}.json`);
}

function alreadyFired(sessionId: string, url: string): boolean {
  try {
    const p = statePath(sessionId);
    if (!existsSync(p)) return false;
    const seen: string[] = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(seen) && seen.includes(url);
  } catch {
    return false;
  }
}

function markFired(sessionId: string, url: string): void {
  try {
    const p = statePath(sessionId);
    let seen: string[] = [];
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        if (Array.isArray(parsed)) seen = parsed;
      } catch {
        seen = [];
      }
    }
    if (!seen.includes(url)) seen.push(url);
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(p, JSON.stringify(seen), 'utf8');
  } catch {
    // Best-effort dedupe only; never break the tool call over this.
  }
}

/**
 * pr_watch (the ccv3-mods plugin) checks one fixed repo, so only that repo's PRs are sent to it.
 * Any other repo keeps the /loop.
 */
const WATCH_REPO = 'rev4nchist/continuous-claude-v3';

const loopText = (info: PrInfo): string =>
  `/loop 5m Check the review bot (Greptile; CodeRabbit on a repo not moved yet) on ${info.owner}/${info.repo} PR #${info.number} (stop when a review of the head lands or after 60 minutes; fix real findings; dismiss false positives with a reason; verify thread isResolved via GraphQL; never merge)`;

export function buildContext(info: PrInfo): string {
  const head = `PR OPENED: ${info.url}. Per ~/.claude/rules-ondemand/pr-review-loop.md, `;
  if (`${info.owner}/${info.repo}`.toLowerCase() === WATCH_REPO) {
    return (
      head +
      `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. ` +
      `It watches the Greptile review and CI for you and tells Dave and you at READY; never merge. ` +
      `Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. ` +
      `This applies to every PR in every session.`
    );
  }
  return (
    head +
    `START THE REVIEW LOOP NOW, in this same turn: ${loopText(info)}. ` +
    `This applies to every PR in every session.`
  );
}

export function main(): void {
  const raw = readFileSync(0, 'utf8');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log('{}');
    return;
  }
  const tool = (input.tool_name as string) || '';
  if (!COMMAND_TOOLS.has(tool)) {
    console.log('{}');
    return;
  }
  const command = ((input.tool_input as Record<string, unknown>)?.command as string) || '';
  if (!isPrOpenCommand(command)) {
    console.log('{}');
    return;
  }
  const text = responseText(input.tool_response);
  const info = extractPrInfo(text);
  if (!info) {
    // No PR URL in the response. A bare "number" field with no URL to key
    // owner/repo/dedupe on is not actionable -- skip rather than guess. In
    // practice every real gh pr-create/gh-api-POST-pulls success response
    // carries html_url alongside "number", so this is not a live gap.
    console.log('{}');
    return;
  }
  const sessionId = (input.session_id as string) || '';
  if (alreadyFired(sessionId, info.url)) {
    console.log('{}');
    return;
  }
  markFired(sessionId, info.url);
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: buildContext(info),
      },
    }),
  );
}

// Import guard: tests import the exported functions without running main().
if ((process.argv[1] || '').includes('pr-opened-coderabbit-loop')) {
  try {
    main();
  } catch {
    console.log('{}');
  }
}
