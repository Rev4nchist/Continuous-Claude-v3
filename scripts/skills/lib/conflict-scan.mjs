// Conflict scan for vendored skills. Finds text that tells the model to do something a CCv3 "never"
// rule forbids, and checks that an overlay entry covers every hit.
//
// A seed is {topic, pattern, ccv3_rule}. A hit is one line of vendored text that matches a seed.
// An overlay entry covers a hit when its topic equals the seed topic, its `files` glob matches the
// hit's file and its `pattern` regex matches the hit's line (first 2000 characters). Entries never name a line number:
// upstream renames and reflows files every week, so a line reference would go stale.
//
// Overlay file: <vendor source>/overlay.json, a JSON array of
//   {"topic": "...", "pattern": "<regex>", "files": "<glob>" | ["<exact path>", ...],
//    "ccv3_rule": "...", "resolution": "...", "max_hits": 5}
// An entry is a reviewed exception, never a blanket pass: no catch-all pattern, no `**` glob, hits in
// more than one file only when `files` names each file, at most max_hits hits (default 5).
// The hub skill owns the overlay. The scan only reads it.

import fs from 'node:fs';
import path from 'node:path';

// Seeds from docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md section 3(a).
export const SEEDS = [
  { topic: 'retry-on-429', pattern: String.raw`retry|backoff|Retry-After|\b429\b`,
    ccv3_rule: 'Fabric capacity error: stop all load on the first one; never retry through it.' },
  // A resize can be advice, not a command: "wait or scale up", a sizing guide, "upgrade the SKU" (review H3, 2026-10-04).
  { topic: 'capacity-pause-resume-resize', pattern: String.raw`\b(?:suspend|resume|pause|resize)\w*\b.{0,50}capacit|capacit.{0,50}\b(?:suspend|resume|pause|resize)|\bscale\s+up\b|\bSizing Guide\b|\b(?:upgrade|larger|bigger)\b.{0,30}\b(?:capacity|SKU)\b`,
    ccv3_rule: 'Never pause, resume or resize a Fabric capacity.' },
  { topic: 'bulk-put-dataAccessRoles', pattern: String.raw`\bPUT\b.{0,120}dataAccessRoles|dataAccessRoles.{0,120}\bPUT\b`,
    ccv3_rule: 'Never bulk PUT dataAccessRoles: it replaces every role and deletes access.' },
  { topic: 'python3', pattern: String.raw`\bpython3\b`,
    ccv3_rule: 'On this machine use python, never python3.' },
  { topic: 'system-package-install', pattern: String.raw`\bapt-get\b|\b(?:apt|brew)\s+install\b`,
    ccv3_rule: 'No apt-get or brew installs: Windows machine, package-install-guard.' },
  { topic: 'npm-global-install', pattern: String.raw`\bnpm\s+(?:install|i)\s+(?:-g|--global)\b|\bnpm\s+(?:-g|--global)\s+(?:install|i)\b`,
    ccv3_rule: 'No global npm installs.' },
  { topic: 'unpinned-pip-install', pattern: String.raw`\bpip3?\s+install\b(?!.*(?:==|~=|\s-r\s))`,
    ccv3_rule: 'Pin every pip install to an exact version.' },
  { topic: 'odbc-driver-18', pattern: String.raw`ODBC Driver 18`,
    ccv3_rule: 'T-SQL on this machine goes through mssql-python, not ODBC Driver 18.' },
  { topic: 'FabricOpenAI', pattern: String.raw`FabricOpenAI\(`,
    ccv3_rule: 'Use the Responses API path in the playbook, not FabricOpenAI(.' },
  // Phase 5b (2026-10-04): semantic-model-authoring runs DAX as a service principal under RLS by impersonation.
  { topic: 'sp-dax-rls', pattern: String.raw`impersonatedUserName|service principal.{0,60}\bRLS\b`,
    ccv3_rule: 'Never run DAX as a service principal on a model with RLS or SSO (G-40, L-13).' },
  // An instruction to delete items, not a DELETE endpoint in a reference list.
  { topic: 'delete-item-without-yes', pattern: String.raw`\bdelete (?:every|all|the existing|each|any)\b.{0,40}\b(?:duplicate|model|item|lakehouse|workspace|notebook)s?\b`,
    ccv3_rule: 'Deleting a Fabric item needs the owner\'s yes.' },
];

// Only instruction-bearing folders and text files are scanned. overlay.json, CHANGELOG.md,
// PROVENANCE.md and LICENSE sit outside these folders on purpose.
export const SCAN_DIRS = ['skills', 'common', 'mcp-setup'];
const TEXT_EXT = /\.(md|txt|sh|ps1|py|json|yml|yaml|cs|csproj|sql|kql|toml)$/i;

// An overlay entry is a reviewed exception, not a blanket pass. These limits keep it that way:
export const MAX_LINE = 2000; // an overlay regex sees at most this many characters of a line
export const DEFAULT_MAX_HITS = 5; // hits one entry may cover unless it sets max_hits
const MAX_PATTERN = 200;
// Unrelated text. A pattern that matches any of these (or the empty string) covers everything.
const CANARIES = ['a', 'x', '1', '-', 'lorem ipsum dolor sit amet'];
// A group that holds an unbounded quantifier and is itself repeated: (a+)+ (.*)* (\w+\s?)*
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\})/;

export function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function within(root, p) { return p === root || p.startsWith(root + path.sep); }

// Walk the scan folders. A link (symlink or junction) is followed only while its real target stays
// inside a scan folder, and every real folder is walked once: a loop cannot recurse and a link out of
// the tree cannot pull in files from outside it.
function walkScanDirs(sourceDir) {
  const allowed = []; const visited = new Set(); const out = [];
  for (const d of SCAN_DIRS) { try { allowed.push(fs.realpathSync(path.join(sourceDir, d))); } catch { /* absent */ } }
  const ok = (real) => allowed.some((a) => within(a, real));
  const walk = (dir) => {
    let real; try { real = fs.realpathSync(dir); } catch { return; }
    if (!ok(real) || visited.has(real)) return;
    visited.add(real);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && TEXT_EXT.test(e.name)) {
        try { if (ok(fs.realpathSync(p))) out.push(p); } catch { /* vanished */ }
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(sourceDir, d));
  return out;
}

// Why an overlay regex is not acceptable, or null.
export function patternProblem(pattern) {
  if (pattern.length > MAX_PATTERN) return `pattern is longer than ${MAX_PATTERN} characters`;
  if (NESTED_QUANTIFIER.test(pattern)) return 'pattern has a nested unbounded quantifier (for example (a+)+): it can hang the scan';
  let re;
  try { re = new RegExp(pattern, 'i'); } catch (x) { return `pattern is not a valid regex: ${x.message}`; }
  if (re.test('')) return 'pattern matches the empty string: it is a catch-all';
  if (CANARIES.some((c) => re.test(c))) return 'pattern is a catch-all: it matches unrelated text';
  return null;
}

// A glob made only of * and / matches every file.
const blanketGlob = (g) => /^[*/\\]+$/.test(g);

// Read and validate <source>/overlay.json (or `file`). Returns {entries, errors}. A missing file
// is an empty overlay, not an error: the hits then fail as uncovered.
// `files` is a glob string or an array of globs. An entry that covers hits in more than one file must
// give an array that names each of those files exactly (see scanSource).
export function loadOverlay(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { entries: [], errors: [], exists: false }; }
  let data;
  try { data = JSON.parse(raw); } catch (e) { return { entries: [], errors: [`overlay is not valid JSON: ${e.message}`], exists: true }; }
  if (!Array.isArray(data)) return { entries: [], errors: ['overlay must be a JSON array'], exists: true };
  const entries = []; const errors = [];
  data.forEach((e, i) => {
    const bad = (m) => errors.push(`overlay entry ${i + 1}: ${m}`);
    if (!e || typeof e !== 'object') return bad('not an object');
    for (const k of ['topic', 'pattern', 'ccv3_rule', 'resolution']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) return bad(`missing "${k}"`);
    }
    const globs = Array.isArray(e.files) ? e.files : [e.files];
    if (!globs.length || globs.some((g) => typeof g !== 'string' || !g.trim())) return bad('missing "files" (a glob string or an array of glob strings)');
    if (globs.some(blanketGlob)) return bad('"files" is only * or **, which matches every file: name the folder or the files');
    if (!SEEDS.some((s) => s.topic === e.topic)) return bad(`unknown topic "${e.topic}"`);
    const problem = patternProblem(e.pattern);
    if (problem) return bad(problem);
    if (e.max_hits !== undefined && !(Number.isInteger(e.max_hits) && e.max_hits >= 1 && e.max_hits <= 200)) return bad('"max_hits" must be an integer from 1 to 200');
    entries.push({ ...e, _re: new RegExp(e.pattern, 'i'), _files: globs.map(globToRegExp), _globs: globs });
  });
  return { entries, errors, exists: true };
}

// Scan one vendor source. Returns {hits, uncovered, entryStats, entryViolations, unusedEntries,
// overlayErrors, files}.
// entryStats: one record per overlay entry {topic, pattern, files, hits, fileCount, max_hits}.
// entryViolations: an entry that covers hits in more than one file without naming each file in a
// `files` array, or more hits than its cap (max_hits, default 5). Without these limits one entry
// could cover every hit of its topic, including conflicts a later upstream pull adds.
export function scanSource(sourceDir, { overlayFile, seeds = SEEDS } = {}) {
  const overlay = loadOverlay(overlayFile || path.join(sourceDir, 'overlay.json'));
  const compiled = seeds.map((s) => ({ ...s, re: new RegExp(s.pattern, 'i') }));
  const files = walkScanDirs(sourceDir);
  const hits = []; const covered = overlay.entries.map(() => ({ hits: 0, files: new Set() }));
  for (const file of files) {
    const rel = path.relative(sourceDir, file).split(path.sep).join('/');
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    text.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      for (const s of compiled) {
        if (!s.re.test(line)) continue;
        const head = line.slice(0, MAX_LINE);
        const idx = overlay.entries.findIndex((e) => e.topic === s.topic && e._files.some((g) => g.test(rel)) && e._re.test(head));
        if (idx >= 0) { covered[idx].hits++; covered[idx].files.add(rel); }
        hits.push({ file: rel, line: i + 1, topic: s.topic, ccv3_rule: s.ccv3_rule, text: line.trim().slice(0, 140), covered: idx >= 0 });
      }
    });
  }
  const entryStats = overlay.entries.map((e, i) => ({
    topic: e.topic, pattern: e.pattern, files: e._globs, hits: covered[i].hits, fileCount: covered[i].files.size,
    covered_files: [...covered[i].files].sort(), max_hits: e.max_hits ?? DEFAULT_MAX_HITS,
  }));
  const entryViolations = [];
  entryStats.forEach((st, i) => {
    const e = overlay.entries[i]; const label = `overlay entry [${st.topic}] /${st.pattern}/`;
    const listed = Array.isArray(e.files) && st.covered_files.every((f) => e.files.includes(f));
    if (st.fileCount > 1 && !listed) {
      entryViolations.push(`${label} covers hits in more than one file (${st.covered_files.slice(0, 4).join(', ')}${st.fileCount > 4 ? ', ...' : ''}): list each file exactly in a "files" array`);
    }
    if (st.hits > st.max_hits) {
      entryViolations.push(`${label} covers ${st.hits} hits, more than its cap of ${st.max_hits}: review them, then raise "max_hits" to ${st.hits}`);
    }
  });
  return {
    hits, uncovered: hits.filter((h) => !h.covered), files: files.length, overlayErrors: overlay.errors, overlayExists: overlay.exists,
    entryStats, entryViolations,
    unusedEntries: entryStats.filter((st) => st.hits === 0).map((st) => `${st.topic} ${st.files.join(',')} /${st.pattern}/`),
  };
}

export function formatHits(result, { all = true } = {}) {
  const lines = [];
  for (const h of result.hits) if (all || !h.covered) lines.push(`${h.covered ? 'covered  ' : 'UNCOVERED'} [${h.topic}] ${h.file}:${h.line}: ${h.text}`);
  return lines;
}
