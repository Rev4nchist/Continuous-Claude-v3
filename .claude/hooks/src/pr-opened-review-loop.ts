/**
 * pr-opened-review-loop -- PostToolUse hook (matcher: Bash|PowerShell).
 *
 * Detects a PR being opened (`gh pr create` or `gh api ... /pulls -X POST`)
 * and, when the tool response looks like a genuine success (a PR URL or a
 * "number" field), injects additionalContext telling the model to start the
 * PR review loop (see rules-ondemand/pr-review-loop.md) in the same turn.
 * Renamed from pr-opened-coderabbit-loop (Phase 1 hygiene, 2026-10); behaviour unchanged.
 *
 * Fires at most once per PR URL per session: a small state file under
 * os.tmpdir(), keyed by session_id + url, suppresses repeats. The pre-rename
 * state file is read too and migrated on the next write.
 *
 * Fails open on any error: exit 0, emit "{}", never block the tool call.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { routerFlag } from './shared/router-config.js';
import { GH_OPT_PREFIX } from './shared/gh-open-prefix.js';

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

// A global option may stand before `pr` (`gh -R owner/repo pr create`): GH_OPT_PREFIX, shared with OPEN_SEGMENT in pre-pr-gate.ts (PR 592, finding 2).
// Round 3 C1 (F-2): `gh pr new` is an alias of `gh pr create`.
const PR_CREATE_RE = new RegExp(String.raw`\bgh(?:\s+|${GH_OPT_PREFIX}[^\S\r\n]+)pr\s+(?:create|new)\b`, 'i');
const GH_API_RE = /\bgh\s+api\b/i;
// Only the collection endpoint `.../pulls` opens a PR. `/pulls/5/reviews` and thread replies do not:
// the path must end at "pulls" (whitespace, a quote, `?` or end of string follows).
const PULLS_PATH_RE = /\/pulls\/?(?=[\s"'?]|$)/i;
// gh accepts `-X POST`, `-XPOST`, `--method POST` and `--method=POST`.
const POST_METHOD_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))POST\b/i;
// Any explicit method (GET, PATCH, ...) switches off gh's default below.
const ANY_METHOD_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))\w/i;
// With no method, gh api sends POST as soon as a field or an input file is given. A field is
// `key=value`, so `Select-Object -First 1` or `grep -F` does not count.
const FIELD_FLAG_RE = /(?:^|\s)(?:-[fF]\s*["']?[\w.[\]-]+=|--(?:raw-field|field|input)[\s=])/;
// Only the `gh api` command itself counts, not what a pipe or a chained command does after it.
const GH_API_SEGMENT_RE = /\bgh\s+api\b[^|;&\n]*/i;

// The value of a flag that carries data (-f/-F field, -H header, --jq, --template, --input). It is never the
// endpoint, so a "/pulls" inside it must not make the call look like a PR create. A value is quotes and bare text
// joined: title="two words".
const DATA_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)+`;
const DATA_FLAG_RE = new RegExp(String.raw`(^|\s)(-[fFHqt]\s*|--(?:raw-field|field|header|jq|template|input)(?:\s+|=))${DATA_VALUE}`, 'g');

const PR_URL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/;

/**
 * Join continued lines the way each shell does. Bash deletes a backslash-newline outright, so `gh a\` + newline +
 * `pi` runs as `gh api`. PowerShell reads a backtick-newline as a space. A bare line end still separates two commands.
 * The hook does not know which shell runs the text, so isPrOpenCommand reads both forms and matches if either one is a
 * PR create: on doubt it matches more, never less (the pre-pr-gate guard then asks for a stamp).
 */
export function joinContinuations(command: string, shell: 'bash' | 'pwsh'): string {
  const text = command || '';
  return shell === 'bash' ? text.replace(/\\\r?\n/g, '') : text.replace(/[ \t]*`\r?\n[ \t]*/g, ' ');
}

/**
 * `gh.exe` and a quoted `"gh"` / `'gh'` are the gh command: they read as plain `gh`. Only a whole quoted word or a `.exe` suffix
 * changes, so the quote parity of the rest of the text is kept.
 */
export function normalizeGh(command: string): string {
  return (command || '').replace(/(["'])gh(?:\.exe)?\1(?=\s)|\bgh\.exe(?=\s)/gi, 'gh');
}

/** The text with every quote character and backslash deleted: the shell joins `rea''dy` and `"ready"` into one word. */
export const squashQuotes = (text: string): string => text.replace(/["'\\]/g, '');

export function isPrOpenCommand(command: string): boolean {
  const text = normalizeGh(command);
  return isPrOpenText(joinContinuations(text, 'bash')) || isPrOpenText(joinContinuations(text, 'pwsh'));
}

export function isPrOpenText(cmd: string): boolean {
  // A spliced subcommand (`gh pr "create"`, `gh pr cre''ate`) is the same create: read the text with the quotes deleted too.
  if (PR_CREATE_RE.test(cmd) || PR_CREATE_RE.test(squashQuotes(cmd))) return true;
  if (!GH_API_RE.test(cmd)) return false;
  const api = cmd.match(GH_API_SEGMENT_RE)?.[0] ?? '';
  // The endpoint and the method are read with the data values removed; the implicit-POST check needs the flags.
  const bare = api.replace(DATA_FLAG_RE, '$1$2');
  if (!PULLS_PATH_RE.test(bare)) return false;
  if (POST_METHOD_RE.test(bare)) return true;
  return FIELD_FLAG_RE.test(api) && !ANY_METHOD_RE.test(bare);
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

function safeSession(sessionId: string): string {
  return (sessionId || 'no-session').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function statePath(sessionId: string): string {
  return join(tmpdir(), `pr-opened-review-loop-${safeSession(sessionId)}.json`);
}

/**
 * State file written before the rename (pr-opened-coderabbit-loop). A session
 * open across the rename keeps its dedup state here, so it is read too.
 */
export function legacyStatePath(sessionId: string): string {
  return join(tmpdir(), `pr-opened-coderabbit-loop-${safeSession(sessionId)}.json`);
}

/** URLs in one state file. A missing or corrupt file gives []. */
function readSeen(p: string): string[] {
  try {
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function alreadyFired(sessionId: string, url: string): boolean {
  return (
    readSeen(statePath(sessionId)).includes(url) ||
    readSeen(legacyStatePath(sessionId)).includes(url)
  );
}

/**
 * Write the URL to the new state file. Legacy URLs are merged in first, and
 * the legacy file is deleted only after the new file is written.
 */
export function markFired(sessionId: string, url: string): void {
  try {
    const legacy = legacyStatePath(sessionId);
    const seen = [...new Set([...readSeen(statePath(sessionId)), ...readSeen(legacy), url])];
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(seen), 'utf8');
    if (existsSync(legacy)) unlinkSync(legacy);
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
  `/loop 5m Check the PR review bots that must review the head (in CCv3, the bots \`node scripts/github/review-status.mjs ${info.number}\` requires; elsewhere, the repo's configured bots) on ${info.owner}/${info.repo} PR #${info.number} (stop when reviews of the head land or after 60 minutes; fix real findings; dismiss false positives with a reason; verify thread isResolved via GraphQL; never merge)`;

/**
 * The pr_checkpoint sentence. Flag off (checkpoint.ledger false): today's text. Flag on: the tool returns the review question,
 * the model asks it with AskUserQuestion and calls the tool again, and only Dave's tap records. The tool still needs `body`.
 */
function checkpointText(info: PrInfo, ledger: boolean): string {
  const call = `the pr_checkpoint tool with pr: ${info.number} and body: the path of the PR body file that pre-pr.mjs --body checked (mcp__ccv3-mods__pr_checkpoint)`;
  const never = 'Never mark it ready or add a review: label yourself; the checkpoint does both. ';
  if (ledger) {
    return (
      `Either way, also call ${call}. ` +
      'If it returns a question, ask Dave that question with AskUserQuestion, word for word, then call pr_checkpoint again with the same pr and body. ' +
      'Only his tap records a pick. An answer that matches no option records nothing, and the PR stays a draft. ' + never
    );
  }
  return (
    `Either way, also call ${call}. ` +
    'Without that call /pathway has no checkpoint to record, and the PR stays a draft. ' + never
  );
}

export function buildContext(info: PrInfo, ledger = false): string {
  const head = `PR OPENED: ${info.url}. Per ~/.claude/rules-ondemand/pr-review-loop.md, `;
  if (`${info.owner}/${info.repo}`.toLowerCase() === WATCH_REPO) {
    return (
      head +
      `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. ` +
      `It watches the review bots the labels require (CodeRabbit while Greptile auto review is off) and CI for you and tells Dave and you at READY; never merge. ` +
      `Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. ` +
      checkpointText(info, ledger) +
      `This applies to every PR in every session.`
    );
  }
  return (
    head +
    `START THE REVIEW LOOP NOW, in this same turn: ${loopText(info)}. ` +
    `This applies to every PR in every session.`
  );
}

/** checkpoint.ledger of review-router.config.json, from the payload cwd upward (no git). Only a literal true is on. */
function ledgerOn(cwd: string): boolean {
  const readFile = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  return routerFlag(cwd || process.cwd(), readFile, homedir(), 'checkpoint', 'ledger');
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
        additionalContext: buildContext(info, ledgerOn((input.cwd as string) || '')),
      },
    }),
  );
}

// Import guard: tests import the exported functions without running main().
if ((process.argv[1] || '').includes('pr-opened-review-loop')) {
  try {
    main();
  } catch {
    console.log('{}');
  }
}
