/**
 * Raw-text readers for the PR Checkpoint rules of pre-pr-gate (PR B). Pure: no git, no file, no env.
 *
 * There is no shell lexer on purpose: hand lexers in guards never converge. Each reader works on the raw command
 * text and fails CLOSED: a doubt reads as a deny. A few small helpers are the only structure:
 *   - quoted spans ("..." and '...') are blanked before a flag token is looked for, so a title such as "add -d flag"
 *     is text and not a flag;
 *   - the text is cut into command segments at ; & | and newlines, so a flag counts only inside the command it follows;
 *   - a segment is read only up to its first `#`, `<`, `>`, `$(` or backtick: a comment, a here-string, a redirect or a
 *     substitution can hold a flag word (`# --undo`, `<<< --draft`) that the shell never passes to gh;
 *   - a backslash-quote, or a quote left unpaired after blanking, is doubt: the quote edges cannot be trusted, so a ready
 *     is a ready and a create is a non-draft create;
 *   - for the subcommand and the label, the text is also read with every quote and backslash deleted, because the shell
 *     joins `rea''dy` and `"review":deep` into one word;
 *   - `gh.exe` and a quoted `"gh"` are normalised to `gh` (normalizeGh) before any shape is read.
 * A shape found only inside quotes (bash -c 'gh pr ready 201') has no matching segment in the blanked text, so it
 * is never excused by a flag elsewhere.
 * Residual (accepted): a subcommand built from a variable (`gh pr $sub 201` is not read; a `$` label value is blind), and a script
 * reached by an alias or a wrapper the text does not name. Brace expansion in the subcommand word (`gh pr {create,x}`) is read as a
 * ready (fail closed).
 */
import { isPrOpenCommand, isPrOpenText, normalizeGh, squashQuotes } from '../pr-opened-review-loop.js';

export interface LabelShape {
  /** The review:<name> tokens the command adds, lower case, once each. */
  labels: string[];
  /** The command adds a label but its text cannot be checked (a file-fed or --input label list, a GraphQL label mutation, a $ or brace value). */
  blind: boolean;
}

export interface Shapes {
  create: boolean;
  nonDraft: boolean;
  ready: boolean;
  label: LabelShape | null;
  self: boolean;
  /** A --repo, -R or GH_REPO value that holds $, a backtick or %VAR%, on a create, ready or label shape. */
  nonLiteral: boolean;
}

const QUOTED = /"[^"]*"|'[^']*'/g;
const stripQuotes = (text: string): string => text.replace(QUOTED, ' ');
const segmentsOf = (text: string): string[] => text.split(/[;&|\r\n]+/);
const countOf = (re: RegExp, text: string): number => (text.match(re) ?? []).length;
/** The part of a segment the shell passes to the command: up to the first comment, here-string, redirect, substitution or backtick. */
const plainPart = (segment: string): string => segment.split(/#|<|>|\$\(|`/)[0];
/** A backslash-quote or a backtick-quote, or an unpaired quote after blanking: the quote edges cannot be trusted. */
const quoteDoubt = (raw: string): boolean => /\\["']|`["']/.test(raw) || countOf(/["']/g, stripQuotes(raw)) % 2 === 1;

/**
 * True when `re` (global) matches the command (quotes deleted, so spliced words count) more often than the segments that
 * pass `ok` (comments and redirects cut off, quotes blanked) hold it. Doubt about the quote edges excuses nothing.
 */
function uncovered(raw: string, re: RegExp, ok: (segment: string) => boolean): boolean {
  const total = countOf(re, squashQuotes(raw));
  if (total === 0) return false;
  if (quoteDoubt(raw)) return true;
  const covered = segmentsOf(stripQuotes(raw)).map(plainPart).filter(ok).reduce((n, s) => n + countOf(re, s), 0);
  return total > covered;
}

// ---------- create: draft or not ----------

const CLI_CREATE = /\bgh\s+pr\s+create\b/gi;
const GH_API = /\bgh\s+api\b/gi;
const CLI_DRAFT = /(?:^|\s)(?:--draft|-d)(?=\s|$)/;
const API_DRAFT = /(?:^|\s)(?:-F|-f|--field|--raw-field)(?:=|\s+)draft=true(?=\s|$)/;
const DRAFT_FALSE = /\bdraft=false\b/i;

/** A `gh api` segment that opens a PR (POST to .../pulls) and holds no draft=true field outside quotes and comments. */
const apiCreateUncovered = (raw: string): boolean =>
  segmentsOf(raw).some((s) => /\bgh\s+api\b/i.test(s) && isPrOpenText(s) && !API_DRAFT.test(plainPart(stripQuotes(s))));

/**
 * True when a PR create has no explicit draft-true token. `gh pr create --draft | -d`; `gh api -F draft=true | -f draft=true`.
 * Any draft=false, --draft=true, -dx, --drafts, and a token inside quotes, a comment or a substitution are non-draft. A quoted
 * -F "draft=true" is a real draft in the shell but counts as non-draft here: type it unquoted. When the text holds both a
 * `gh pr create` and a `gh api` create, each one needs its own draft token.
 */
export function isNonDraftCreate(raw: string): boolean {
  if (DRAFT_FALSE.test(raw)) return true;
  if (!/\bgh\s+pr\s+create\b/i.test(squashQuotes(raw))) return uncovered(raw, GH_API, (s) => API_DRAFT.test(s));
  return uncovered(raw, CLI_CREATE, (s) => CLI_DRAFT.test(s)) || apiCreateUncovered(raw);
}

// ---------- ready ----------

const READY_CLI = /\bgh\s+pr\s+ready\b/gi;
const READY_GRAPHQL = /markPullRequestReadyForReview/i;
/** Brace expansion in the subcommand word (`gh pr {ready,x}`) hides the subcommand: read it as a ready. */
const READY_BRACE = /\bgh\s+pr\s+\S*[{}]/i;
const UNDO = /(?:^|\s)--undo(?=\s|$)/;

/**
 * `gh pr ready` or the GraphQL mutation. `--undo` (back to draft, the recovery path) excuses a `gh pr ready` only when the token
 * sits in the same command segment, before any comment or redirect, outside quotes. `--undo=false` is a real ready.
 */
export function isReadyShape(raw: string): boolean {
  return READY_GRAPHQL.test(raw) || READY_BRACE.test(raw) || uncovered(raw, READY_CLI, (s) => UNDO.test(s));
}

// ---------- labels ----------

/** One shell word: quoted parts and bare parts joined, as the shell joins them (`rev''iew:deep`, `"review":deep`). */
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])+`;
const ADD_LABEL = new RegExp(String.raw`(?:^|\s)--add-label(?:=|\s+)(${WORD})`, 'g');
const CREATE_LABEL = new RegExp(String.raw`(?:^|\s)(?:--label(?:=|\s+)|-l\s*)(${WORD})`, 'g');
const REVIEW_TOKEN = /review:[\w-]+/gi;
const ISSUE_ENDPOINT = /repos\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/[^\s/"'?]+/gi;
const LABELS_PATH = /\/labels\b/i;
/** A labels field of a REST issue or pull update: -f labels[]=x, -F labels=x. */
const LABEL_FIELD = /\blabels(?:\[[^\]]*\])?=/i;
/** A labels field fed from a file: -F labels[]=@l.txt. */
const FILE_LABELS = /\blabels(?:\[[^\]]*\])?=@/i;
/** GraphQL mutations that set labels by id: the names are not in the text. */
const LABEL_MUTATION = /\b(?:labelIds|updatePullRequest|updateIssue)\b/;
const INPUT_FLAG = /(?:^|\s)--input(?:=|\s|$)/;

/** True when a `gh api` text holds a CCv3 issues or pulls endpoint. A foreign endpoint is never named: the hook names CCv3 or nothing. */
export function hasCcv3Endpoint(raw: string): boolean {
  if (!/\bgh\s+api\b/i.test(raw)) return false;
  return [...raw.matchAll(ISSUE_ENDPOINT)].some((m) => m[1].toLowerCase() === 'rev4nchist/continuous-claude-v3');
}

const valuesOf = (re: RegExp, raw: string): string[] => [...raw.matchAll(re)].map((m) => m[1]);
const unquote = (word: string): string => word.replace(/["'\\]/g, '');
const reviewTokens = (text: string): string[] => (text.match(REVIEW_TOKEN) ?? []).map((t) => t.toLowerCase());

/**
 * A label add that names a review: label: `--add-label`, `gh pr create --label | -l`, or a gh api labels write (a /labels path, or
 * a labels field on an issue or pull endpoint). Flag values are read as whole shell words with quotes and backslashes deleted,
 * and the text with every quote deleted is read too, so spliced words and spliced flags count.
 * Blind: a labels endpoint with --input, a labels field fed from a file, GraphQL addLabelsToLabelable, labelIds, updatePullRequest
 * or updateIssue, or a flag value with $, a backtick or a brace.
 * Residual (accepted): GraphQL with the query text in a file (-F query=@file) shows no label text.
 */
export function labelShape(raw: string, create: boolean): LabelShape | null {
  if (!/\bgh\b/i.test(raw)) return null;
  const squashed = squashQuotes(raw);
  const read = (re: RegExp): string[] => [...valuesOf(re, raw).map(unquote), ...valuesOf(re, squashed)];
  const values = [...read(ADD_LABEL), ...(create ? read(CREATE_LABEL) : [])];
  const api = /\bgh\s+api\b/i.test(squashed);
  const labelsApi = api && (LABELS_PATH.test(squashed) || (new RegExp(ISSUE_ENDPOINT.source, 'i').test(squashed) && LABEL_FIELD.test(squashed)));
  const labels = [...new Set(reviewTokens(values.join(' ') + (labelsApi ? ` ${squashed}` : '')))];
  const blind = /addLabelsToLabelable/i.test(raw)
    || (api && (LABEL_MUTATION.test(squashed) || FILE_LABELS.test(squashed) || (labelsApi && INPUT_FLAG.test(squashed))))
    || values.some((v) => /[$`{}]/.test(v));
  return labels.length > 0 || blind ? { labels, blind } : null;
}

// ---------- self-confirm and repo ----------

const SELF_FLAG = /(?:^|\s)--(?:confirm|apply)(?:=|\s|$)/;
const NODE_CMD = /\bnode(?:\.exe)?["']?\s/i;
/** `--apply 2>&1` is a stderr redirect, not PR 2: the number must not run into a digit or a `>`. */
const APPLY_N = /(?:^|\s)--apply(?:=|\s+)["']?\d+(?![\d>])/;
const CONFIRM_PATHWAY = /(?:^|\s)--confirm(?:=|\s+)["']?(?:none|coderabbit|both|wait)\b/;
const BY_FLAG = /(?:^|\s)--by(?:=|\s)/;
/** A glob character in a scripts/github path: `pr-c*.mjs` reaches pr-checkpoint.mjs without naming it. */
const SCRIPT_GLOB = /scripts[\\/]+github[\\/]+[^\s"']*[*?[]/i;
const NONLITERAL_REPO = new RegExp(
  String.raw`(?:^|\s)(?:-R\s*=?|--repo(?:\s+|=))["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)`
  + String.raw`|(?:^|[\s;])(?:\$env:)?GH_REPO\s*=\s*["']?[^\s"';]*(?:\$|\x60|%[A-Za-z_]\w*%)`,
  'i',
);

/**
 * Text that runs pr-checkpoint with --confirm or --apply: it names pr-checkpoint with either flag; or it is a `node` command
 * line that passes `--apply <n>` or `--confirm <pathway> --by` whatever the script is called; or it passes either flag to a
 * glob path under scripts/github. Known false positive: any shell text that only quotes both.
 */
export function isSelfConfirm(raw: string): boolean {
  if (/pr-checkpoint/i.test(raw) && SELF_FLAG.test(raw)) return true;
  if (NODE_CMD.test(raw) && (APPLY_N.test(raw) || (CONFIRM_PATHWAY.test(raw) && BY_FLAG.test(raw)))) return true;
  return SELF_FLAG.test(raw) && SCRIPT_GLOB.test(raw);
}

export const hasNonLiteralRepo = (raw: string): boolean => NONLITERAL_REPO.test(raw);

/** Every shape of the command, from its text alone. `command` has its continued lines joined already; gh.exe and "gh" are normalised here. */
export function shapesOf(command: string): Shapes {
  const text = normalizeGh(command);
  const create = isPrOpenCommand(text);
  const ready = isReadyShape(text);
  const label = labelShape(text, create);
  const nonLiteral = (create || ready || label !== null) && hasNonLiteralRepo(text);
  return { create, nonDraft: create && isNonDraftCreate(text), ready, label, self: isSelfConfirm(text), nonLiteral };
}

export const isGated = (s: Shapes): boolean => s.create || s.ready || s.label !== null || s.self;

export const CCV3_REPO = 'rev4nchist/continuous-claude-v3';

// ---------- repo identity (moved from pre-pr-gate.ts so the shapes CLI can import it without running a hook main()) ----------

/** A gh repo value: OWNER/REPO, HOST/OWNER/REPO or a URL. Only the last two segments name the repo. */
const REPO_VALUE = '((?:https?:\\/\\/)?[\\w.-]+(?:\\/[\\w.-]+){1,2})';
const REPO_FLAG = new RegExp(`(?:^|\\s)(?:-R\\s*=?|--repo(?:\\s+|=))["']?${REPO_VALUE}`, 'g');
const GH_REPO_ASSIGN = new RegExp(`(?:^|[\\s;])(?:\\$env:)?GH_REPO\\s*=\\s*["']?${REPO_VALUE}`, 'gi');
/** A PR or issue URL names its repo: `gh pr ready https://github.com/<o>/<r>/pull/201`. */
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/\d+/gi;
const ownerRepo = (value: string): string => value.replace(/^https?:\/\//i, '').split('/').slice(-2).join('/').replace(/\.git$/i, '').toLowerCase();

const API_ENDPOINT = /repos\/([\w.-]+\/[\w.-]+)\/pulls\b/gi;
/**
 * `rev4nchist/continuous-claude-v3` when the raw text holds any CCv3 signal, else null (the checkout decides). The hook never names a foreign repo.
 * A CCv3 signal is a CCv3 `-R` / `--repo` / `GH_REPO=` value (also the process env GH_REPO), a CCv3 `repos/<o>/<r>/pulls` or issues or labels
 * endpoint text, or a CCv3 PR URL. Any one of them anywhere in the text means CCv3 (fail closed): gh may use the last -R, and a title can hold text.
 */
export function namedRepo(command: string, env: NodeJS.ProcessEnv = {}): string | null {
  const envRepo = env.GH_REPO && new RegExp(`^${REPO_VALUE}$`).exec(env.GH_REPO.trim())?.[1];
  const values = [...command.matchAll(REPO_FLAG), ...command.matchAll(GH_REPO_ASSIGN)].map((m) => m[1]);
  const explicits = [...values, ...(envRepo ? [envRepo] : [])].map(ownerRepo);
  const endpoints = [...command.matchAll(API_ENDPOINT)].map((m) => m[1].toLowerCase());
  const urls = [...command.matchAll(PR_URL)].map((m) => m[1].toLowerCase());
  const ccv3 = explicits.includes(CCV3_REPO) || endpoints.includes(CCV3_REPO) || urls.includes(CCV3_REPO) || hasCcv3Endpoint(command);
  return ccv3 ? CCV3_REPO : null;
}
