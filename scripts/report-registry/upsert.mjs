// upsert.mjs — the Report Runs registry spine (Phase 2b).
//
// Reads one `report-run.json` (the structured-run contract every pipeline emits)
// and UPSERTS it into the Report Runs Notion DB keyed by the unique `Run ID`:
//   - query the DS for a row whose `Run ID` equals runId
//   - 1 match  -> updatePageProperties (in-place UPDATE, same run retried)
//   - 0 match  -> createPage           (APPEND, a new run — incl. failures)
//   - >1 match -> loud dedup warning, then update the NEWEST (by Run Date)
//
// Model = append-all-attempts: a DISTINCT runId always yields a NEW row (never
// overwrites a different run); the SAME runId updates in place. `Period` is a
// grouping field, NOT unique.
//
// NON-FATAL-BUT-LOUD contract: on any failure this process prints
// `[report-registry] ERROR: …` to stderr and exits NONZERO. The DESIGN INTENT is
// that CALLERS invoke it so a nonzero exit NEVER fails the parent report run —
// e.g. wrap the call in the parent bat/ps1 so a registry outage can't block a
// report. A Phase-4 missing-row detector catches any resulting drift.
//
// CLI usage (input resolved in this precedence):
//   node upsert.mjs path/to/report-run.json      # first non-flag arg = file path
//   node upsert.mjs --emit '<json-string>'        # inline JSON
//   echo '<json>' | node upsert.mjs               # stdin (no path, no --emit)
//
// EVENT-DRIVEN HUB (optimization 02): after a SUCCESSFUL row write, the CLI runs a
// SCOPED surface refresh (refresh-pages.mjs --type "<run.type>": that type's child
// page + the hub launcher row) so the registry and its Notion surfaces can never
// disagree for longer than one write. Strictly non-fatal — a refresh failure is
// logged and never changes the upsert's exit code (the row IS the truth; the
// surfaces self-heal on the next refresh). Opt out with --no-refresh (e.g. a bulk
// backfill that will run one refresh at the end).
//
// Reuses scripts/project-cards/lib/notion.mjs (absolute-NTN_EXE non-interactive
// contract + queryDataSource / createPage / updatePageProperties). No new deps.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  queryDataSource, createPage, updatePageProperties, trashPage, richText, dateStart,
} from '../project-cards/lib/notion.mjs';
import {
  REPORT_RUNS_DS_ID, REPORT_TYPES, STATUSES, SOURCES, REPORT_RUN_KEYS,
} from './config.mjs';

// ACCEPTED RISK (T6.1): two same-job processes that both re-query and see 0 matches
// can each CREATE a row for the same runId (a create/create race), and any two runs
// of the same source share the $TEMP/report-run-<source>.json emit path. Both require
// OVERLAPPING invocations of the SAME scheduled job, which Task Scheduler's no-overlap
// setting (MultipleInstances=IgnoreNew) prevents. Not guarded here; the >1-match
// orphan-cleanup below is the self-heal if it ever fires.

const REQUIRED_KEYS = ['runId', 'type', 'period', 'runDate', 'status', 'source'];

// Transient failure signature (mirrors lib/notion.mjs). A create POST that fails
// with one of these MAY have already committed server-side (a timed-out POST can
// still land), so before retrying we re-query by the unique Run ID and adopt an
// existing row instead of blindly creating a duplicate (T5.1).
const TRANSIENT_RE = /429|rate|timeout|5\d\d|ECONN|ETIMEDOUT|Failed to execute public API request|failed after \d+ attempts/i;
const CREATE_MAX_ATTEMPTS = 3;

function isTransientError(err) {
  return TRANSIENT_RE.test(String((err && err.message) || err || ''));
}

// --- validation (pure) ---------------------------------------------------------
// Throws on the first violation with an actionable message. Verified keys:
// required set present + non-empty, type in REPORT_TYPES, status in STATUSES.
export function validateRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error('report-run must be a JSON object');
  }
  for (const k of REQUIRED_KEYS) {
    if (run[k] == null || String(run[k]).trim() === '') {
      throw new Error(`missing required field "${k}" (required: ${REQUIRED_KEYS.join(', ')})`);
    }
  }
  if (!REPORT_TYPES.includes(run.type)) {
    throw new Error(`invalid type "${run.type}" (allowed: ${REPORT_TYPES.join(', ')})`);
  }
  if (!STATUSES.includes(run.status)) {
    throw new Error(`invalid status "${run.status}" (allowed: ${STATUSES.join(', ')})`);
  }
  // Guard `source` against the known Source select values so a typo can't mint a
  // stray option in the shared Notion select (T6.1 #4).
  if (!SOURCES.includes(run.source)) {
    throw new Error(`invalid source "${run.source}" (allowed: ${SOURCES.join(', ')})`);
  }
  // Unknown keys are non-fatal but surfaced (schema-drift signal for out-of-repo
  // pipelines coding against the pinned contract).
  const known = new Set([...REPORT_RUN_KEYS, 'attempt']);
  const unknown = Object.keys(run).filter((k) => !known.has(k));
  if (unknown.length) {
    console.error(`[report-registry] WARN: unknown field(s) ignored: ${unknown.join(', ')}`);
  }
  return run;
}

const rt = (s) => [{ type: 'text', text: { content: String(s) } }];

// A Notion `url`-typed property rejects a value that is not a real URL — a bare
// filesystem path (deploy-fail fallback) would 400 the whole request and drop the
// entire row. Accept only http(s) values (T6.1 #2).
const HTTP_URL_RE = /^https?:\/\//i;

// Set a `url`-typed property ONLY when the value is a real http(s) URL; otherwise
// OMIT it (and log loudly) so one bad path can never 400 and drop the whole row.
function setUrlProp(props, field, value) {
  if (value == null || value === '') return;
  const v = String(value);
  if (HTTP_URL_RE.test(v)) {
    props[field] = { url: v };
  } else {
    console.error(`[report-registry] non-URL ${field} omitted: ${v}`);
  }
}

// --- field -> Notion property mapping (pure) -----------------------------------
// Title = "<type> — <period> — <runDate>". Optional fields are omitted (not sent
// as null) when absent, so a partial retry never clobbers a prior value with null.
export function buildProperties(run) {
  const props = {
    'Report Run': { title: rt(`${run.type} — ${run.period} — ${run.runDate}`) },
    'Run ID': { rich_text: rt(run.runId) },
    'Report Type': { select: { name: run.type } },
    Status: { select: { name: run.status } },
    Source: { select: { name: run.source } },
    'Run Date': { date: { start: run.runDate } },
    Period: { rich_text: rt(run.period) },
  };
  if (run.summary != null && run.summary !== '') props.Summary = { rich_text: rt(run.summary) };
  if (run.commit != null && run.commit !== '') props.Commit = { rich_text: rt(run.commit) };
  setUrlProp(props, 'Artifact URL', run.artifactUrl);
  setUrlProp(props, 'Docx/Deck', run.docxUrl);
  if (run.attempt != null && Number.isFinite(Number(run.attempt))) props.Attempt = { number: Number(run.attempt) };
  return props;
}

// Parse a date-ish string to epoch ms; unparseable/empty -> -Infinity (sorts as the
// OLDEST). CHRONOLOGICAL, not lexicographic: different pipelines emit `-05:00` / `Z` /
// bare `YYYY-MM-DD` for the same type, so a string compare picks the wrong "newest"
// (T6.1 #5). Never throws.
function toEpochMs(s) {
  const ms = Date.parse(s || '');
  return Number.isNaN(ms) ? -Infinity : ms;
}
function runDateMs(row) {
  return toEpochMs(dateStart(row?.properties?.['Run Date']) || row?.last_edited_time || '');
}
function editedMs(row) {
  return toEpochMs(row?.last_edited_time || '');
}

// Pick the newest row from a >1-match dedup set: max Run Date (numeric/chronological),
// tie-broken by Notion last_edited_time. Deterministic so concurrent double-writes
// converge.
function newestRow(rows) {
  return [...rows].sort((a, b) => {
    const da = runDateMs(a);
    const db = runDateMs(b);
    if (da !== db) return db - da; // descending: newest first
    const ea = editedMs(a);
    const eb = editedMs(b);
    if (ea !== eb) return eb - ea;
    return 0;
  })[0];
}

// Trash every row in `matches` EXCEPT the kept `targetId` (the newest). Self-heals
// orphan duplicates that share an idempotency key (T6.1 #6). Loud + non-fatal: a
// trash that fails is logged but never aborts the upsert. Returns the count trashed.
function trashOlderDuplicates(matches, targetId, runId, trash) {
  const older = matches.filter((m) => m.id && m.id !== targetId);
  let trashed = 0;
  for (const dup of older) {
    try {
      trash(dup.id);
      trashed += 1;
      console.error(`[report-registry] trashed orphan duplicate row ${dup.id} for Run ID "${runId}" (kept newest ${targetId}).`);
    } catch (e) {
      console.error(`[report-registry] WARN: could not trash duplicate row ${dup.id} for Run ID "${runId}" (non-fatal): ${e.message}`);
    }
  }
  return trashed;
}

// Re-query the DS for the run's unique Run ID; return the matching rows (0..n).
function queryByRunId(run, dsId, query) {
  return query(dsId, {
    filter: { property: 'Run ID', rich_text: { equals: String(run.runId) } },
  }) || [];
}

// --- idempotent create (T5.1) --------------------------------------------------
// The create POST is NOT safe to blindly retry: a transient failure (timeout /
// 429 / 5xx / dropped connection) can surface AFTER the row has already committed
// server-side, so a naive retry appends a DUPLICATE. Guard: on a transient create
// failure, re-query by the unique Run ID BEFORE retrying — if a row now exists,
// ADOPT it (switch to update) instead of re-creating. Only when no row is found
// (the create genuinely never landed) do we retry the create, bounded. A
// non-transient failure (bad request/auth/validation) throws immediately.
function createOrAdopt(run, properties, { dsId, query, create, update, trash }) {
  let lastErr;
  for (let attempt = 1; attempt <= CREATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const page = create(dsId, properties);
      return { action: 'created', pageId: page?.id, duplicates: 0 };
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err)) throw err;
      const rows = queryByRunId(run, dsId, query);
      if (rows.length > 0) {
        const target = rows.length > 1 ? newestRow(rows) : rows[0];
        if (rows.length > 1) {
          console.error(`[report-registry] WARN: ${rows.length} rows share Run ID "${run.runId}" after a retried create — adopting the newest and trashing the older duplicate(s) (a timed-out create landed more than once).`);
        } else {
          console.error(`[report-registry] transient create failure for Run ID "${run.runId}" — the row landed server-side; adopting it instead of re-creating.`);
        }
        update(target.id, properties);
        if (rows.length > 1) trashOlderDuplicates(rows, target.id, run.runId, trash);
        return { action: 'adopted', pageId: target.id, duplicates: rows.length };
      }
      if (attempt < CREATE_MAX_ATTEMPTS) {
        console.error(`[report-registry] transient create failure for Run ID "${run.runId}" attempt ${attempt}/${CREATE_MAX_ATTEMPTS}; no row found on re-query — retrying create.`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// --- core upsert (transport injectable for tests) ------------------------------
// Returns { action: 'created'|'adopted'|'updated', pageId, duplicates }. Throws
// on failure.
export function upsertReportRun(run, {
  dsId = REPORT_RUNS_DS_ID,
  query = queryDataSource,
  create = createPage,
  update = updatePageProperties,
  trash = trashPage,
} = {}) {
  validateRun(run);
  const properties = buildProperties(run);
  const matches = queryByRunId(run, dsId, query);

  if (matches.length === 0) {
    return createOrAdopt(run, properties, { dsId, query, create, update, trash });
  }

  if (matches.length > 1) {
    console.error(`[report-registry] WARN: ${matches.length} rows share Run ID "${run.runId}" — updating the newest and trashing the older duplicate(s) (dedup drift; a distinct runId should never collide).`);
    const target = newestRow(matches);
    update(target.id, properties);
    trashOlderDuplicates(matches, target.id, run.runId, trash);
    return { action: 'updated', pageId: target.id, duplicates: matches.length };
  }

  const target = matches[0];
  update(target.id, properties);
  return { action: 'updated', pageId: target.id, duplicates: 1 };
}

// --- event-driven scoped refresh (optimization 02) -------------------------------

const REFRESH_PAGES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'refresh-pages.mjs');
// 6 DS reads + hub read/writes, each ntn call bounded at 30s — 240s covers the
// worst case with headroom while still hard-bounding a wedged refresh.
const REFRESH_TIMEOUT_MS = 240_000;

// PURE, exported for tests: the CLI refreshes surfaces after a successful write
// unless --no-refresh was passed.
export function wantsRefresh(argv) {
  return !argv.includes('--no-refresh');
}

// Run the SCOPED surface refresh for one report type as a child process
// (refresh-pages.mjs --type "<type>"). NON-FATAL by contract: any failure —
// spawn error, nonzero exit, timeout — is logged loudly and swallowed; the
// registry row already landed and the surfaces self-heal on the next refresh.
// Returns { ok, status } for observability/tests. `spawn` injectable for tests.
export function runScopedRefresh(type, { spawn = spawnSync } = {}) {
  try {
    const res = spawn(process.execPath, [REFRESH_PAGES_PATH, '--type', String(type)], {
      input: '',
      timeout: REFRESH_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      // MUST be piped, never 'inherit': emit-run.mjs's contract #2 ("stderr is
      // silent on the success path") holds only if the child's output flows
      // through THIS process's console, where captureConsole can intercept it.
      // 'inherit' hands the child the parent's real fds and leaked refresh
      // chatter straight past the capture (proven live 2026-08-03).
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Replay the child's output in-process — before the status branch, so a
    // failing child's detail is never dropped. Direct CLI use prints it as
    // before (buffered, not streamed — acceptable under the 240s hard bound).
    for (const chunk of [res.stdout, res.stderr]) {
      if (!chunk) continue;
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console.error(line);
      }
    }
    if (res.error) {
      console.error(`[report-registry] WARN: scoped refresh spawn failed (non-fatal): ${res.error.message}`);
      return { ok: false, status: null };
    }
    if (res.status !== 0) {
      console.error(`[report-registry] WARN: scoped refresh exited ${res.status} (non-fatal)`);
      return { ok: false, status: res.status };
    }
    console.error(`[report-registry] scoped refresh ok (type "${type}": child page + hub)`);
    return { ok: true, status: 0 };
  } catch (e) {
    console.error(`[report-registry] WARN: scoped refresh threw (non-fatal): ${e.message}`);
    return { ok: false, status: null };
  }
}

// --- input resolution (CLI) ----------------------------------------------------
export function readInput(argv) {
  const emitIdx = argv.indexOf('--emit');
  if (emitIdx !== -1) {
    const val = argv[emitIdx + 1];
    if (val == null) throw new Error('--emit requires a JSON string argument');
    return val;
  }
  const eq = argv.find((a) => a.startsWith('--emit='));
  if (eq) return eq.slice('--emit='.length);
  const firstArg = argv.find((a) => !a.startsWith('--'));
  if (firstArg) return readFileSync(firstArg, 'utf8');
  // No path, no --emit: read the whole of stdin.
  return readFileSync(0, 'utf8');
}

async function main() {
  const raw = readInput(process.argv.slice(2));
  let run;
  try {
    run = JSON.parse(raw);
  } catch (e) {
    throw new Error(`input is not valid JSON: ${e.message}`);
  }
  const result = upsertReportRun(run);
  console.log(`[report-registry] ${result.action} row for Run ID "${run.runId}" (page ${result.pageId})`);
  // Event-driven hub (optimization 02): a successful write triggers the scoped
  // surface refresh unless the caller opted out. Non-fatal — never changes the
  // upsert's outcome or exit code.
  if (wantsRefresh(process.argv.slice(2))) {
    runScopedRefresh(run.type);
  } else {
    console.error('[report-registry] --no-refresh: skipping scoped surface refresh');
  }
  return result;
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[report-registry] ERROR: ${e.message}`);
    process.exit(1);
  });
}

// Re-export the property helper used by extractors so tests can read back rows.
export { richText };
