// Gold C builder: turns two pinned external review datasets into gold rows (source 'C') for gold/gold-c.json.
// Subcommands (no argument or --help prints usage and exits 2, with no network and no file write):
//   stats     offline. Counts only: never a row, path, url or text.
//   pin-prs   network (gh api). Pins head, base and new-side hunk ranges of each Qodo PR that has an in-slice finding.
//             At most GH_CALL_CAP calls in one pass, no retry, a rate limit stops the pass. Writes <root>/gold-c-prs.json at the end only.
//   build     offline. Reads both pinned files and gold-c-prs.json, writes the gold rows (--out, default gold/gold-c.json).
// Both datasets are untrusted data: a file is read only when its sha256 equals the manifest written by external-pull.mjs.
// No dataset text is copied into a row (no title, description, note, snippet, rule name or model name). Every row passes validateRow.
// Exit codes: 0 ok, 1 error, 2 usage or refusal.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPinned, datasetDirName, DEFAULT_ROOT, PullRefusal } from './external-pull.mjs';
import { GOLD_DIR, validateRow } from './gold.mjs';

export const PINS = Object.freeze({
  qodo: Object.freeze({ id: 'Qodo/PR-Review-Bench', sha: 'a73957c450a70693a743260e5637fffc44625f16', file: 'git_code_review_bench_100_w_open_prs.jsonl', format: 'jsonl' }),
  aacr: Object.freeze({ id: 'Alibaba-Aone/aacr-bench', sha: '86705ac25e4da6d8fdf178ef12c07bf28de3f491', file: 'dataset.json', format: 'json' }),
});
/**
 * The sha256 of each pinned file, measured at the first pull (2026-11-13). build, stats and pin-prs refuse a cached file
 * with another hash, so the integrity guard is this value, not manifest.json (a second pull from one dataset rewrites it)
 * and not the byte count (external-pull checks that on the 3xx path only).
 */
export const FILE_SHA256 = Object.freeze({
  qodo: '2f0448ed1f9a55bea14039961d8d9e610ee8885b37559b80f5821f3f70cfe64d',
  aacr: '0804505f0a474765ce2840c832cfeaa6c4f0250dd6ccb169fe73c6758b245a86',
});
/** Bump when a severity or linkType map below changes. It is written to every row's provenance. */
export const SEVERITY_MAP_VERSION = 1;
export const SLICE_EXTS = Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
export const GH_CALL_CAP = 150;
export const PRS_FILE = 'gold-c-prs.json';
/** Version 2 adds `complete` per PR and null hunks for a file with no patch. */
export const PRS_VERSION = 2;

const SHA_RE = /^[0-9a-f]{40}$/;
const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
const SEVERITY = new Map([['Code Defect', 'major'], ['Security Vulnerability', 'major'], ['Performance', 'minor'], ['Maintainability and Readability', 'minor']]);
const LINK = new Map([['Diff Level', 'within-hunk'], ['File Level', 'same-file'], ['Repo Level', 'cross-file-static']]);
const USAGE = `Usage: node scripts/eval/review-eval/external-slices.mjs <stats | pin-prs | build> [--out <file>]
  stats     offline counts of both pinned datasets (no row, path, url or text)
  pin-prs   pin head, base and hunks of each in-slice Qodo PR through gh api (max ${GH_CALL_CAP} calls, no retry)
  build     write Gold C rows to --out (default scripts/eval/review-eval/gold/gold-c.json)`;

const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const cmp = (a, b) => (a > b) - (a < b);
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

/** Count of each key(x). */
function tally(list, keyFn) {
  const out = {};
  for (const x of list) { const k = keyFn(x); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

// ---- loading -------------------------------------------------------------------------------------------------------

function readManifest(dir, pin) {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) throw new PullRefusal(`${pin.id}: manifest.json is missing. Run external-pull.mjs first.`);
  let m;
  try { m = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new PullRefusal(`${pin.id}: manifest.json is not valid JSON.`); }
  if (!isObj(m) || m.id !== pin.id || m.sha !== pin.sha || m.file !== pin.file) throw new PullRefusal(`${pin.id}: manifest does not match the pin (id, sha, file).`);
  return m;
}

function parseJsonl(text, id) {
  return text.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => l.trim() !== '').map(([l, n]) => {
    try { return JSON.parse(l); } catch { throw new PullRefusal(`${id}: line ${n} is not valid JSON.`); }
  });
}

function parseJson(text, id) {
  let data;
  try { data = JSON.parse(text); } catch { throw new PullRefusal(`${id}: the file is not valid JSON.`); }
  if (Array.isArray(data)) return data;
  const arrays = isObj(data) ? Object.values(data).filter(Array.isArray) : [];
  if (arrays.length !== 1) throw new PullRefusal(`${id}: expected a JSON array of rows, or an object holding exactly one array.`);
  return arrays[0];
}

/** The rows of one pinned dataset plus the file sha256. Refuses a missing file, a manifest that is not the pin, or a hash mismatch. */
export function loadPinned(pin, root, expectedSha256 = null) {
  assertPinned(pin);
  const dir = path.join(root, datasetDirName(pin.id, pin.sha));
  const manifest = readManifest(dir, pin);
  const filePath = path.join(dir, ...pin.file.split('/'));
  if (!existsSync(filePath)) throw new PullRefusal(`${pin.id}: ${pin.file} is missing. Run external-pull.mjs first.`);
  const buf = readFileSync(filePath);
  const hash = sha256(buf);
  if (manifest.sha256 !== hash) throw new PullRefusal(`${pin.id}: ${pin.file} does not match the sha256 in manifest.json. Pull it again.`);
  if (expectedSha256 && hash !== expectedSha256) throw new PullRefusal(`${pin.id}: ${pin.file} sha256 is not the pinned FILE_SHA256 value.`);
  const text = buf.toString('utf8');
  const rows = pin.format === 'jsonl' ? parseJsonl(text, pin.id) : parseJson(text, pin.id);
  if (!rows.every(isObj)) throw new PullRefusal(`${pin.id}: every row must be an object.`);
  return { rows, sha256: hash };
}

// ---- findings ------------------------------------------------------------------------------------------------------

export const extOf = (p) => path.posix.extname(typeof p === 'string' ? p : '').toLowerCase();
const inSlice = (p) => SLICE_EXTS.includes(extOf(p));

/** { repo: 'owner/name' (lower case), pr } from a GitHub PR url, or null. */
export function parsePrUrl(url) {
  const m = PR_URL_RE.exec(typeof url === 'string' ? url : '');
  return m ? { repo: `${m[1]}/${m[2]}`.toLowerCase(), pr: Number(m[3]) } : null;
}
const prKey = (t) => `${t.repo}#${t.pr}`;

function qodoFindings(rows) {
  return rows.flatMap((r, row) => (Array.isArray(r.issues) ? r.issues : []).map((raw, issue) => {
    const i = isObj(raw) ? raw : {};
    return { row, issue, path: i.file_path, line: i.start_line, url: r.pr_url_to_review, rule: nonEmpty(i.rule_name) };
  }));
}

const aacrFindings = (rows) => rows.map((r, row) => ({
  row, issue: 0, path: r.path, line: r.from_line, url: r.pr_url, label: r.label, commit: r.pr_source_commit,
  category: r.category, context: r.context, isAi: r.is_ai_comment === true, side: r.side,
}));

// ---- stats ---------------------------------------------------------------------------------------------------------

function qodoStats(rows) {
  const all = qodoFindings(rows);
  const s = all.filter((f) => inSlice(f.path));
  const prs = new Set(s.map((f) => { const t = parsePrUrl(f.url); return t ? prKey(t) : String(f.url); }));
  return { rows: rows.length, findings: all.length, inSlice: s.length, byExt: tally(s, (f) => extOf(f.path)), ruleNamed: s.filter((f) => f.rule).length, ruleEmpty: s.filter((f) => !f.rule).length, distinctPrs: prs.size };
}

function aacrStats(rows) {
  const l1 = aacrFindings(rows).filter((f) => f.label === 1);
  const s = l1.filter((f) => inSlice(f.path));
  const known = (map) => (v) => (map.has(v) ? v : 'other');
  return {
    rows: rows.length, findings: rows.length, label1Total: l1.length, inSlice: s.length, byExt: tally(s, (f) => extOf(f.path)),
    human: s.filter((f) => !f.isAi).length, ai: s.filter((f) => f.isAi).length,
    byCategory: tally(s, (f) => known(SEVERITY)(f.category)), byContext: tally(s, (f) => known(LINK)(f.context)),
    badCommit: s.filter((f) => !SHA_RE.test(String(f.commit).toLowerCase())).length,
  };
}

// ---- pin-prs -------------------------------------------------------------------------------------------------------

/** New-side line ranges of each '@@ -a,b +c,d @@' hunk: [c, c + max(d, 1) - 1]. d defaults to 1. No patch gives []. */
export function parseHunks(patch) {
  const out = [];
  for (const m of String(patch ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    out.push([start, start + Math.max(len, 1) - 1]);
  }
  return out;
}

/** A stop that ends the pass at once: nothing is written, exit 1, and the message holds counts only. */
class Stop extends Error {}
const rateErr = (e) => /rate limit/i.test(String(e?.message ?? '')) || [403, 429].includes(e?.status);
const rateBody = (res) => /rate limit/i.test(String(res?.message ?? ''));

/** ghFn behind a call counter. It stops before the cap is passed, never retries, and stops on a rate limit. */
function metered(ghFn) {
  const m = { calls: 0 };
  m.get = async (apiPath) => {
    if (m.calls >= GH_CALL_CAP) throw new Stop(`call cap of ${GH_CALL_CAP} reached`);
    m.calls += 1;
    let res;
    try { res = await ghFn(apiPath); } catch (e) { throw rateErr(e) ? new Stop('rate limit') : e; }
    if (rateBody(res)) throw new Stop('rate limit');
    return res;
  };
  return m;
}

/** path -> new-side hunk ranges, or null when the compare gave no patch for that file (its hunks are unknown). */
const filesOf = (list) => Object.fromEntries(list.filter((x) => typeof x?.filename === 'string').map((x) => [x.filename, typeof x.patch === 'string' ? parseHunks(x.patch) : null]));

/**
 * { pin: {head, base, complete, files} } or { reason: 'no-head' } for a PR that is gone or has no usable sha. Any other error
 * is thrown. `complete` is true only when the compare listed as many files as the PR reports (a compare is cut off at 300).
 */
async function pinOne(m, ref) {
  const api = `repos/${ref.repo}`;
  try {
    const pr = await m.get(`${api}/pulls/${ref.pr}`);
    const [head, base] = [String(pr?.head?.sha), String(pr?.base?.sha)];
    if (!SHA_RE.test(head) || !SHA_RE.test(base)) return { reason: 'no-head' };
    const cmpRes = await m.get(`${api}/compare/${base}...${head}`);
    const list = Array.isArray(cmpRes?.files) ? cmpRes.files : [];
    const complete = Number.isSafeInteger(pr?.changed_files) && list.length === pr.changed_files;
    return { pin: { head, base, complete, files: filesOf(list) } };
  } catch (e) {
    if (e instanceof Stop || ![404, 410].includes(e?.status)) throw e;
    return { reason: 'no-head' };
  }
}

/** [key, {repo, pr}] of each distinct Qodo PR with an in-slice finding, sorted by key. */
function qodoPrs(rows) {
  const found = new Map();
  for (const f of qodoFindings(rows)) {
    const t = inSlice(f.path) ? parsePrUrl(f.url) : null;
    if (t && repoOk(t.repo)) found.set(prKey(t), t);
  }
  return [...found.entries()].sort(([a], [b]) => cmp(a, b));
}

function readPrsFile(root) {
  const file = path.join(root, PRS_FILE);
  if (!existsSync(file)) return null;
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new PullRefusal(`${PRS_FILE} is not valid JSON.`); }
  // Version 1 (no `complete` flag) is read only by pin-prs, to compare the recorded pins. build needs version 2.
  if (!isObj(data) || ![1, PRS_VERSION].includes(data.version) || !isObj(data.prs) || !isObj(data.qodo)) throw new PullRefusal(`${PRS_FILE} has an unknown shape.`);
  if (data.qodo.id !== PINS.qodo.id || data.qodo.sha !== PINS.qodo.sha) throw new PullRefusal(`${PRS_FILE} is for another Qodo pin.`);
  return data;
}

/** Pins each PR into acc.prs or acc.excluded. A head or a base that differs from the recorded pin is a PullRefusal. */
async function pinAll(m, refs, existing, acc) {
  for (const [key, ref] of refs) {
    const r = await pinOne(m, ref);
    if (r.reason) { acc.excluded.push({ key, reason: r.reason }); continue; }
    const old = existing?.prs[key];
    if (old && (old.head !== r.pin.head || old.base !== r.pin.base)) throw new PullRefusal('a pinned PR head or base moved. A moved pin is an unpinned source: refusing, nothing written.');
    acc.prs[key] = r.pin;
  }
}

async function cmdPinPrs(d) {
  const { rows } = loadPinned(PINS.qodo, d.root, d.fileSha256?.qodo);
  const existing = readPrsFile(d.root);
  const m = metered(d.ghFn);
  const prs = {};
  const excluded = [];
  try {
    await pinAll(m, qodoPrs(rows), existing, { prs, excluded });
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    d.stderr(`external-slices stopped: ${e.message}. Nothing written. PRs pinned so far ${Object.keys(prs).length}, calls used ${m.calls}.`);
    return 1;
  }
  const out = { version: PRS_VERSION, qodo: { id: PINS.qodo.id, sha: PINS.qodo.sha }, pinnedAt: new Date(d.now()).toISOString(), prs, excluded };
  writeJson(path.join(d.root, PRS_FILE), out);
  d.stdout(JSON.stringify({ pinned: Object.keys(prs).length, excluded: tally(excluded, (e) => e.reason), calls: m.calls }, null, 2));
  return 0;
}

// ---- build ---------------------------------------------------------------------------------------------------------

const PROBE = { id: 'probe', source: 'C', suite: 'capability', split: 'holdout', severity: 'major', linkType: 'same-file', labels: [{ by: 'x', verdict: 'real' }], provenance: { a: 1 } };
const probe = (over) => validateRow({ ...PROBE, file: 'a.ts', target: { repo: 'a/b', pr: 1, round: 1, sha40: 'a'.repeat(40) }, ...over });
/** The repo and file rules of gold.mjs, asked through validateRow itself. */
const repoOk = (repo) => !probe({ target: { repo, pr: 1, round: 1, sha40: 'a'.repeat(40) } }).some((p) => p.startsWith('target.repo'));
const fileOk = (file) => !probe({ file }).some((p) => p.startsWith('file'));
const lineOf = (n) => (Number.isSafeInteger(n) && n >= 1 ? { line: n } : {});
const rowId = (prefix, sha, row, issue) => `${prefix}${sha256(`${sha}:${row}:${issue}`).slice(0, 16)}`;

/**
 * The linkType of a Qodo finding, or null when it cannot be proven: a file missing from a compare that was cut off may still
 * be in the PR, and a line in a file with no patch may or may not sit in a hunk. A null row is excluded, never guessed.
 */
function qodoLink(file, line, pin) {
  const files = isObj(pin.files) ? pin.files : {};
  if (!Object.hasOwn(files, file)) return pin.complete === true ? 'cross-file-static' : null;
  if (!Number.isSafeInteger(line) || line < 1) return 'same-file';
  const hunks = files[file];
  if (!Array.isArray(hunks)) return null;
  return hunks.some(([s, e]) => line >= s && line <= e) ? 'within-hunk' : 'same-file';
}

function makeRow(f, t, parts) {
  return {
    id: parts.id, source: 'C', suite: 'capability', split: 'holdout', target: { repo: t.repo, pr: t.pr, round: 1, sha40: parts.sha40 },
    file: f.path, ...lineOf(f.line), severity: parts.severity, linkType: parts.linkType, labels: [{ by: parts.by, verdict: 'real' }], provenance: parts.provenance,
  };
}

function qodoRow(f, t, ctx) {
  const pin = ctx.prs[prKey(t)];
  if (!isObj(pin)) return { reason: 'pr-not-pinned' };
  const linkType = qodoLink(f.path, f.line, pin);
  if (!linkType) return { reason: 'link-unproven' };
  const provenance = { dataset: PINS.qodo.id, sha: PINS.qodo.sha, file: PINS.qodo.file, sha256: ctx.sha256, row: f.row, issue: f.issue, ruleFlag: f.rule, severityMapVersion: SEVERITY_MAP_VERSION, prHead: pin.head, prBase: pin.base, prPinnedAt: ctx.pinnedAt };
  const parts = { id: rowId('c-qodo-', PINS.qodo.sha, f.row, f.issue), sha40: pin.head, severity: f.rule ? 'minor' : 'major', linkType, by: 'qodo', provenance };
  return { row: makeRow(f, t, parts) };
}

function aacrRow(f, t, ctx) {
  const sha40 = String(f.commit).toLowerCase();
  if (!SHA_RE.test(sha40)) return { reason: 'bad-commit' };
  if (!SEVERITY.has(f.category)) return { reason: 'unknown-category' };
  if (!LINK.has(f.context)) return { reason: 'unknown-context' };
  // Only a right-side line is a line of the head commit (sha40). A left-side or unknown side is an old-file line: excluded.
  if (f.side !== 'right') return { reason: 'not-head-side' };
  const provenance = { dataset: PINS.aacr.id, sha: PINS.aacr.sha, file: PINS.aacr.file, sha256: ctx.sha256, row: f.row, srcCategory: f.category, srcContext: f.context, isAi: f.isAi, side: f.side, severityMapVersion: SEVERITY_MAP_VERSION };
  const parts = { id: rowId('c-aacr-', PINS.aacr.sha, f.row, 0), sha40, severity: SEVERITY.get(f.category), linkType: LINK.get(f.context), by: 'aacr', provenance };
  return { row: makeRow(f, t, parts) };
}

/** Throws on a repeated id. */
export function assertUniqueIds(rows) {
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate row id ${r.id}`);
    seen.add(r.id);
  }
}

function convert(f, make, ctx) {
  if (!fileOk(f.path)) return { reason: 'bad-file' };
  const t = parsePrUrl(f.url);
  return t && repoOk(t.repo) ? make(f, t, ctx) : { reason: 'bad-repo' };
}

function buildRows({ qodo, aacr, prs, pinnedAt }) {
  const rows = [];
  const excluded = [];
  const add = (list, make, ctx) => {
    for (const f of list) {
      const r = convert(f, make, ctx);
      if (r.row) rows.push(r.row); else excluded.push({ reason: r.reason });
    }
  };
  add(qodoFindings(qodo.rows).filter((f) => inSlice(f.path)), qodoRow, { prs, pinnedAt, sha256: qodo.sha256 });
  add(aacrFindings(aacr.rows).filter((f) => f.label === 1 && inSlice(f.path)), aacrRow, { sha256: aacr.sha256 });
  assertUniqueIds(rows);
  return { rows: rows.sort((a, b) => cmp(a.id, b.id)), excluded };
}

function summarize({ rows, excluded }) {
  const q = rows.filter((r) => r.labels[0].by === 'qodo');
  const a = rows.filter((r) => r.labels[0].by === 'aacr');
  return {
    rows: { qodo: q.length, aacr: a.length }, severity: { qodo: tally(q, (r) => r.severity), aacr: tally(a, (r) => r.severity) },
    humanAi: { human: a.filter((r) => !r.provenance.isAi).length, ai: a.filter((r) => r.provenance.isAi).length },
    linkType: tally(rows, (r) => r.linkType), excluded: tally(excluded, (e) => e.reason),
  };
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function cmdBuild(d, flags) {
  const [qodo, aacr] = [loadPinned(PINS.qodo, d.root, d.fileSha256?.qodo), loadPinned(PINS.aacr, d.root, d.fileSha256?.aacr)];
  const pins = readPrsFile(d.root);
  if (!pins) throw new PullRefusal(`${PRS_FILE} is missing. Run pin-prs first.`);
  if (pins.version !== PRS_VERSION) throw new PullRefusal(`${PRS_FILE} is version ${pins.version}; build needs version ${PRS_VERSION}. Run pin-prs again.`);
  const built = buildRows({ qodo, aacr, prs: pins.prs, pinnedAt: pins.pinnedAt });
  const problems = built.rows.flatMap((r) => validateRow(r).map((p) => `${r.id} ${p}`));
  if (problems.length) {
    d.stderr(`external-slices: ${problems.length} row problem(s), nothing written:\n${problems.slice(0, 5).join('\n')}`);
    return 1;
  }
  writeJson(flags.out ?? path.join(GOLD_DIR, 'gold-c.json'), built.rows);
  d.stdout(JSON.stringify(summarize(built), null, 2));
  return 0;
}

function cmdStats(d) {
  const [qodo, aacr] = [loadPinned(PINS.qodo, d.root, d.fileSha256?.qodo), loadPinned(PINS.aacr, d.root, d.fileSha256?.aacr)];
  d.stdout(JSON.stringify({ qodo: qodoStats(qodo.rows), aacr: aacrStats(aacr.rows) }, null, 2));
  return 0;
}

// ---- CLI -----------------------------------------------------------------------------------------------------------

/** The default ghFn. It never prints stderr: that text can hold a login. The error holds a status or "rate limit" only. */
export function defaultGh(apiPath) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', apiPath], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) {
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('gh api failed: bad JSON')); }
        return;
      }
      const status = Number(/HTTP (\d{3})/.exec(String(stderr))?.[1]) || null;
      const limited = /rate limit/i.test(`${stdout}${stderr}`) || [403, 429].includes(status);
      reject(Object.assign(new Error(`gh api failed: ${limited ? 'rate limit' : (status ?? 'unknown')}`), { status }));
    });
  });
}

/** { out? } for build, {} for the other commands. null for an unknown flag, a flag with no value, or --help: the caller prints usage. */
function parseFlags(args, allowOut) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const ok = allowOut && args[i] === '--out' && i + 1 < args.length && !args[i + 1].startsWith('--');
    if (!ok) return null;
    out.out = args[i + 1];
    i += 1;
  }
  return out;
}

export async function main(argv, deps = {}) {
  const d = {
    stdout: deps.stdout ?? ((s) => console.log(s)), stderr: deps.stderr ?? ((s) => console.error(s)),
    ghFn: deps.ghFn ?? defaultGh, root: deps.root ?? DEFAULT_ROOT, now: deps.now ?? Date.now,
    fileSha256: deps.fileSha256 === undefined ? FILE_SHA256 : deps.fileSha256,
  };
  const [cmd, ...rest] = argv;
  if (argv.includes('--help')) { d.stdout(USAGE); return 2; }
  const flags = parseFlags(rest, cmd === 'build');
  const commands = { stats: () => cmdStats(d), 'pin-prs': () => cmdPinPrs(d), build: () => cmdBuild(d, flags) };
  const run = flags && Object.hasOwn(commands, cmd) ? commands[cmd] : null;
  if (!run) { d.stderr(USAGE); return 2; }
  try {
    return await run();
  } catch (e) {
    if (e instanceof PullRefusal) { d.stderr(`external-slices refused: ${e.message}`); return 2; }
    d.stderr(`external-slices failed: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
