/**
 * L0 observability appender for the cohesive-intelligence system (WS-2 Phase A.2).
 *
 * Writes one JSON line per telemetry event to:
 *   <projectDir>/.claude/logs/intel-bus.jsonl
 * where projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
 * (project-relative, matching the other CCv3 JSONL logs).
 *
 * Event schema: design doc "v3" section 6. Most fields are optional; the only
 * required fields are `ts` (stamped here if absent), `bus_id`, and
 * `schema_version` (forced to 1). This layer is namespaced `intel-bus` /
 * `intel_observability` so it is NOT confused with the memory-extraction "L0"
 * score-gate (a different L0).
 *
 * Append safety (design doc section 6, mitigation #16):
 *  - bare appendFileSync (matches the 6+ existing CCv3 JSONL appenders)
 *  - every string field has embedded \r / \n stripped so ONE event == ONE line
 *  - 4 KB per-line assertion: a serialized event that exceeds MAX_LINE_BYTES is
 *    never written as an over-long line -- the largest string field is truncated
 *    and, if that is still too big, the event is dropped. The file is never
 *    corrupted with a partial record.
 *
 * Fail-open: telemetry must NEVER throw into the hot path. Any serialization or
 * disk error is swallowed.
 *
 * Test seam: appendIntelBus accepts an injected `append` / `now` / `projectDir`
 * (host-ram.ts style) so tests verify behavior without touching real disk.
 *
 * ASCII only.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Hard per-line cap. A single JSONL record must never exceed this many bytes. */
export const MAX_LINE_BYTES = 4096;

/**
 * Default max live-file size before single-generation rotation. Overridable per
 * call via process.env.CCV3_INTEL_BUS_MAX_BYTES (parsed as a base-10 int).
 * Single-generation rotation bounds total on-disk size to ~2x this cap.
 */
export const MAX_INTEL_BUS_BYTES = 2_000_000;

/** Default retention window for rotated files in pruneIntelBus: 7 days. */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * intel-bus event (design doc section 6). Every field except the three required
 * ones is optional; callers fill in only what they have.
 */
export interface IntelBusEvent {
  /** ISO timestamp. Stamped by appendIntelBus when absent. Required on disk. */
  ts?: string;
  /** Session bus id (from shared/session-bus-id.ts). Required. */
  bus_id: string;
  /** Which agent emitted: main | kraken | |... */
  agent?: string;
  /** Facade entry point, e.g. "/code-intel". */
  facade?: string;
  /** L3 specialist, e.g. "codegraph" | "serena" | "tldr" | ... */
  specialist?: string;
  /** Query type, e.g. "find_callers" | "bus_read_latency" | ... */
  query_type?: string;
  /** SCIP-style subject id the query was about. */
  subject_id?: string;
  /** Number of results returned. */
  result_count?: number;
  /** Rank of the top result for this source. */
  rank?: number;
  /** Escalation provenance. */
  escalated_from?: string | null;
  escalated_to?: string | null;
  /** Wall-clock duration of the operation in ms. */
  duration_ms?: number;
  /** Correlation id tying related events together. */
  correlation_id?: string;
  /** Parent event id for escalation chains. */
  parent_event_id?: string | null;
  /** Task id, when emitted inside a tracked task. */
  task_id?: string | null;
  /** Computed offline; emitter always leaves null. */
  downstream_used?: unknown;
  /** Summary of bus mutations this event caused, e.g. ["focus_symbols+1"]. */
  bus_updates?: string[];
  /** codegraph-only corpus fingerprint. */
  corpus_signature?: Record<string, unknown>;
  /** Schema version. Forced to 1 here. */
  schema_version?: 1;
  /** True for rows imported by the backfill script; excluded from gates. */
  backfilled?: boolean;
  /** Forward-compat: allow extra fields without a type error. */
  [key: string]: unknown;
}

/** Options for appendIntelBus -- all optional; defaults hit real disk. */
export interface AppendIntelBusOptions {
  /** Project root override (default: CLAUDE_PROJECT_DIR || cwd). */
  projectDir?: string;
  /** Clock override (default: () => new Date().toISOString()). Test seam. */
  now?: () => string;
  /** Append sink override (default: appendFileSync). Test seam. */
  append?: (path: string, line: string) => void;
  /** Live-file byte size probe (default: statSync().size). Test seam. */
  size?: (path: string) => number;
  /** Rotate rename (default: renameSync). Test seam. */
  rename?: (from: string, to: string) => void;
}

/** Options for pruneIntelBus -- all optional; defaults hit real disk. */
export interface PruneIntelBusOptions {
  /** Project root override (default: CLAUDE_PROJECT_DIR || cwd). */
  projectDir?: string;
  /** Max age of a rotated file before it is pruned (default: 7 days). */
  maxAgeMs?: number;
  /** Clock override in epoch ms (default: () => Date.now()). Test seam. */
  now?: () => number;
  /** mtime probe (default: statSync). Test seam. */
  stat?: (path: string) => { mtimeMs: number };
  /** Delete sink (default: unlinkSync). Test seam. */
  unlink?: (path: string) => void;
}

/** Resolve the project-relative intel-bus.jsonl path. */
export function intelBusPath(projectDir?: string): string {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(root, '.claude', 'logs', 'intel-bus.jsonl');
}

/** Strip embedded CR/LF from every string field so one event stays one line. */
function stripNewlinesDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/[\r\n]+/g, ' ');
  }
  if (Array.isArray(value)) {
    return value.map(stripNewlinesDeep);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNewlinesDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Substring (case-insensitive) test for an ASSIGNMENT key token (e.g. the `KEY`
 * in `OPENAI_API_KEY=...`). Substring is right here because the key token is a
 * single identifier; `OPENAI_API_KEY` contains `API_KEY`.
 */
const SECRET_KEY_RE =
  /API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|CONNECTION_?STRING|ACCESS_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL/i;

/**
 * ANCHORED test for an OBJECT FIELD NAME whose entire value should be redacted
 * (the field IS a credential). Anchored (not substring) to avoid false friends:
 * `token_count` / `secret_santa_id` end in count/id, NOT a credential word, so
 * they are NOT redacted; `password`, `api_key`, `my_secret`, `auth_token`,
 * `database_url` are. This is what catches an opaque value (no recognizable
 * shape) that only the field name reveals as sensitive.
 */
const SECRET_FIELD_NAME_RE =
  /^(.*[_-])?(password|passwd|secret|token|api_?key|access_?key|private_?key|authorization|credential|database_url|connection_?string)s?$/i;

/**
 * Assignment matcher: an identifier token, then `=`/`:`, then a value that runs
 * to whitespace. Key/value lengths are BOUNDED ({1,128}/{1,2048}) so a long
 * non-matching run cannot trigger O(n^2) backtracking -- effectively linear
 * (ReDoS-safe). The value class is `[^\s]` (NOT stopping at ;,'/" -- finding F1:
 * a password like `p;ss` must not be split, leaking the tail). Whether the KEY
 * is secret is decided in the callback (SECRET_KEY_RE), keeping the regex linear.
 */
const ASSIGNMENT_RE = /([A-Za-z0-9_]{1,128})(\s*[:=]\s*)("?)([^\s]{1,2048})/g;

/**
 * Redact secrets from a single string. Applied to every string field before the
 * newline-strip and size-cap, so secrets never reach disk. This is DEFENSE IN
 * DEPTH: intel-bus events are allowlist-constructed (no raw content), so this
 * backstops an accidental inclusion (e.g. a grep_hit that scooped a `.env` line).
 *
 * `keyHint` is the parent object field name (when this string is an object
 * value). If the field is itself credential-named, the WHOLE value is redacted
 * regardless of shape (catches opaque secrets only the field name reveals).
 */
function redactSecretString(s: string, keyHint?: string): string {
  // 0. Field-name wholesale redaction: the field IS a credential -> hide it all.
  if (keyHint && s.length > 0 && SECRET_FIELD_NAME_RE.test(keyHint)) {
    return '[REDACTED]';
  }

  let out = s;

  // 1. Standalone secret SHAPES first. Running these BEFORE the generic assignment
  // pass is what catches `Authorization: Bearer <opaque>` (session-3 review#2):
  //    the assignment pass would otherwise consume "Bearer" as Authorization's
  //    value and leave the real token behind, defeating the Bearer shape below.
  //    All quantifiers are upper-bounded so every pattern stays linear (ReDoS-safe).
  out = out
    .replace(/sk-[A-Za-z0-9_-]{16,512}/g, 'sk-[REDACTED]') // OpenAI
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED-AWS-KEY]') // AWS access key id
    .replace(/gh[posru]_[A-Za-z0-9]{30,255}/g, '[REDACTED-GH-TOKEN]') // GitHub
    .replace(/xox[abprs]-[A-Za-z0-9-]{10,512}/gi, '[REDACTED-SLACK-TOKEN]') // Slack
    .replace(
      /eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{6,2048}/g,
      '[REDACTED-JWT]',
    ) // JWT (header.payload.signature)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,2048}/gi, 'Bearer [REDACTED]') // bearer token
    .replace(/postgres(ql)?:\/\/[^:@\s/]+:[^@\s/]+@/gi, 'postgresql://[REDACTED]@'); // DB creds

  // 2. Generic secret assignments: KEY=VALUE / KEY: VALUE where the KEY name
  //    contains a secret keyword. Redact the VALUE (runs to whitespace, finding F1).
  out = out.replace(ASSIGNMENT_RE, (m, key, sep, quote) =>
    SECRET_KEY_RE.test(key) ? `${key}${sep}${quote}[REDACTED]` : m,
  );

  return out;
}

/**
 * Recurse redactSecretString into every string field. When recursing into an
 * object, the field name is threaded as `keyHint` so a credential-named field
 * (password/token/...) has its whole value redacted. Array elements INHERIT the
 * parent field name as `keyHint`, so an array under a credential-named field
 * (e.g. `tokens: ['opaque', ...]`) has each element redacted too (session-3
 * review#3 -- the keyHint used to be dropped on the array branch, leaking it).
 */
function redactSecretsDeep(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') {
    return redactSecretString(value, keyHint);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecretsDeep(v, keyHint));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsDeep(v, k);
    }
    return out;
  }
  return value;
}

/**
 * Find the longest string-valued field (top level) and return its key, so an
 * oversized event can be trimmed at the most likely offender before dropping.
 */
function longestStringKey(obj: Record<string, unknown>): string | null {
  let key: string | null = null;
  let len = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > len) {
      len = v.length;
      key = k;
    }
  }
  return key;
}

/**
 * Append one telemetry event as a single JSONL line. Fail-open: never throws.
 *
 * @param event Partial event; `ts` is stamped and `schema_version` forced to 1.
 * @param opts  Injected seams (path/clock/append) -- defaults write to disk.
 */
export function appendIntelBus(event: IntelBusEvent, opts: AppendIntelBusOptions = {}): void {
  // Kill switch: CCV3_BUS_OFF=1 silences ALL bus I/O, telemetry included. This is
  // the single choke point every intel-bus write passes through, so gating here is
  // what makes the plan's "CCV3_BUS_OFF kills all bus I/O" property hold for every
  // caller -- including the B.3 recall readers that will call appendIntelBus
  // directly to log source_age/injected (critic F6). Reading env cannot throw, so
  // the fail-open contract is preserved.
  if (process.env.CCV3_BUS_OFF === '1') return;
  try {
    const now = opts.now ?? (() => new Date().toISOString());
    const append = opts.append ?? defaultAppend;
    const path = intelBusPath(opts.projectDir);

    // Normalize: stamp ts, force schema_version, then redact secrets BEFORE the
    // newline-strip and size-cap so secret material never reaches disk.
    const stamped = {
      ...event,
      ts: event.ts ?? now(),
      schema_version: 1,
    };
    const normalized = stripNewlinesDeep(redactSecretsDeep(stamped)) as Record<string, unknown>;

    let line = JSON.stringify(normalized) + '\n';

    // 4 KB assertion: if the line is too long, trim the largest string field
    // once; if it is still too long, drop the event entirely. Never write a
    // line longer than MAX_LINE_BYTES.
    if (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) {
      const key = longestStringKey(normalized);
      if (key) {
        // Reserve budget for the rest of the record + the truncation marker.
        const marker = '...(truncated)';
        const withoutField = { ...normalized, [key]: '' };
        const overhead = Buffer.byteLength(JSON.stringify(withoutField) + '\n', 'utf-8');
        const budget = MAX_LINE_BYTES - overhead - marker.length;
        if (budget > 0) {
          const original = String(normalized[key]);
          normalized[key] = original.slice(0, budget) + marker;
          line = JSON.stringify(normalized) + '\n';
        }
      }
      // If trimming did not get us under budget, drop the event (do not write).
      if (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) {
        return;
      }
    }

    // Size-based rotation: if the live file is at/over the cap, rotate it to a
    // single .1 generation, then append to a fresh file. Fail-open: if probing
    // or rotating throws, fall through and still attempt the append.
    maybeRotate(path, opts.size, opts.rename);

    append(path, line);
  } catch {
    // Fail-open: telemetry must never break the hot path.
  }
}

/** Default disk append: ensure the logs dir exists, then bare appendFileSync. */
function defaultAppend(path: string, line: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, line, 'utf-8');
}

/** Default live-file size probe: statSync().size, or 0 if the file is absent. */
function defaultSize(path: string): number {
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

/** Resolve the effective max-bytes cap (env override wins, else the default). */
function resolveMaxBytes(): number {
  const raw = process.env.CCV3_INTEL_BUS_MAX_BYTES;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MAX_INTEL_BUS_BYTES;
}

/**
 * Single-generation size rotation. If the live file is at/over the cap, rename
 * it to `<path>.1` (replacing any existing .1), so the next append starts a
 * fresh file. Fail-open: any probe/rename error is swallowed and the caller
 * still attempts its append.
 *
 * Concurrent-writer note (accepted, low severity -- cross-model review F3/F5):
 * two processes can both cross the cap, and one rotated GENERATION of telemetry
 * HISTORY may then be lost (a second rename replacing a just-rotated .1; likewise
 * prune vs rotation). The growth BOUND (the actual goal) and the fail-open
 * guarantee always hold -- only observability history can be lost under that rare
 * race. We deliberately do NOT lock the telemetry hot path for it: telemetry is
 * non-critical and a lock on every-append-near-cap is disproportionate.
 */
function maybeRotate(
  path: string,
  sizeFn?: (p: string) => number,
  renameFn?: (from: string, to: string) => void,
): void {
  try {
    const size = sizeFn ?? defaultSize;
    const rename = renameFn ?? renameSync;
    const cap = resolveMaxBytes();
    let live = 0;
    try {
      live = size(path);
    } catch {
      // Treat an unreadable/absent live file as size 0 (no rotation needed).
      return;
    }
    if (live >= cap) {
      // renameSync replaces an existing destination on POSIX and Windows, so a
      // stale .1 is overwritten -- single generation, ~2x cap total on disk.
      rename(path, `${path}.1`);
    }
  } catch {
    // Fail-open: rotation must never break the append.
  }
}

/**
 * Prune rotated intel-bus generations (`intel-bus.jsonl.1`, `.2`) whose mtime is
 * older than `maxAgeMs` (default 7 days). Best-effort: every step is guarded so
 * this never throws. Does NOT touch the live file. Not wired into any hook here.
 */
export function pruneIntelBus(opts: PruneIntelBusOptions = {}): void {
  try {
    const now = opts.now ?? (() => Date.now());
    const stat = opts.stat ?? ((p: string) => ({ mtimeMs: statSync(p).mtimeMs }));
    const unlink = opts.unlink ?? unlinkSync;
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RETENTION_MS;
    const live = intelBusPath(opts.projectDir);
    const cutoff = now() - maxAgeMs;

    for (const suffix of ['.1', '.2']) {
      const rotated = `${live}${suffix}`;
      try {
        const { mtimeMs } = stat(rotated);
        if (mtimeMs < cutoff) {
          unlink(rotated);
        }
      } catch {
        // Absent file or unlink failure -- best-effort, move on.
      }
    }
  } catch {
    // Fail-open: retention cleanup must never break the hot path.
  }
}
