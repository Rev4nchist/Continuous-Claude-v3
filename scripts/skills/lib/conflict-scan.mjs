// Conflict scan for vendored skills. Finds text that tells the model to do something a CCv3 "never"
// rule forbids, and checks that an overlay entry covers every hit.
//
// A seed is {topic, pattern, ccv3_rule}. A hit is one line of vendored text that matches a seed.
// An overlay entry covers a hit when its topic equals the seed topic, its `files` glob matches the
// hit's file and its `pattern` regex matches the hit's line. Entries never name a line number:
// upstream renames and reflows files every week, so a line reference would go stale.
//
// Overlay file: <vendor source>/overlay.json, a JSON array of
//   {"topic": "...", "pattern": "<regex>", "files": "<glob>", "ccv3_rule": "...", "resolution": "..."}
// The hub skill owns the overlay. The scan only reads it.

import fs from 'node:fs';
import path from 'node:path';

// Seeds from docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md section 3(a).
export const SEEDS = [
  { topic: 'retry-on-429', pattern: String.raw`retry|backoff|Retry-After|\b429\b`,
    ccv3_rule: 'Fabric capacity error: stop all load on the first one; never retry through it.' },
  { topic: 'capacity-pause-resume-resize', pattern: String.raw`\b(?:suspend|resume|pause|resize)\w*\b.{0,50}capacit|capacit.{0,50}\b(?:suspend|resume|pause|resize)`,
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
];

// Only instruction-bearing folders and text files are scanned. overlay.json, CHANGELOG.md,
// PROVENANCE.md and LICENSE sit outside these folders on purpose.
export const SCAN_DIRS = ['skills', 'common', 'mcp-setup'];
const TEXT_EXT = /\.(md|txt|sh|ps1|py|json|yml|yaml|cs|csproj|sql|kql|toml)$/i;

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

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && TEXT_EXT.test(e.name)) out.push(p);
  }
  return out;
}

// Read and validate <source>/overlay.json (or `file`). Returns {entries, errors}. A missing file
// is an empty overlay, not an error: the hits then fail as uncovered.
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
    for (const k of ['topic', 'pattern', 'files', 'ccv3_rule', 'resolution']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) return bad(`missing "${k}"`);
    }
    if (!SEEDS.some((s) => s.topic === e.topic)) return bad(`unknown topic "${e.topic}"`);
    let re;
    try { re = new RegExp(e.pattern, 'i'); } catch (x) { return bad(`pattern is not a valid regex: ${x.message}`); }
    entries.push({ ...e, _re: re, _files: globToRegExp(e.files) });
  });
  return { entries, errors, exists: true };
}

// Scan one vendor source. Returns {hits, uncovered, unusedEntries, overlayErrors, files}.
export function scanSource(sourceDir, { overlayFile, seeds = SEEDS } = {}) {
  const overlay = loadOverlay(overlayFile || path.join(sourceDir, 'overlay.json'));
  const compiled = seeds.map((s) => ({ ...s, re: new RegExp(s.pattern, 'i') }));
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(sourceDir, d)));
  const hits = []; const used = new Set();
  for (const file of files) {
    const rel = path.relative(sourceDir, file).split(path.sep).join('/');
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    text.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      for (const s of compiled) {
        if (!s.re.test(line)) continue;
        const idx = overlay.entries.findIndex((e) => e.topic === s.topic && e._files.test(rel) && e._re.test(line));
        if (idx >= 0) used.add(idx);
        hits.push({ file: rel, line: i + 1, topic: s.topic, ccv3_rule: s.ccv3_rule, text: line.trim().slice(0, 140), covered: idx >= 0 });
      }
    });
  }
  return {
    hits, uncovered: hits.filter((h) => !h.covered), files: files.length, overlayErrors: overlay.errors, overlayExists: overlay.exists,
    unusedEntries: overlay.entries.filter((_, i) => !used.has(i)).map((e) => `${e.topic} ${e.files} /${e.pattern}/`),
  };
}

export function formatHits(result, { all = true } = {}) {
  const lines = [];
  for (const h of result.hits) if (all || !h.covered) lines.push(`${h.covered ? 'covered  ' : 'UNCOVERED'} [${h.topic}] ${h.file}:${h.line}: ${h.text}`);
  return lines;
}
