#!/usr/bin/env node
/**
 * build-system-map.mjs (card ccv3-system-map-generator)
 *
 * ONE graph file for the system map. Reads the repo sources, merges them with the authored text, and writes:
 *   docs/architecture/system-visualization/architecture.json   the graph (generated; never edit by hand)
 *   docs/architecture/system-visualization/index.html          the page, with the same graph in its embedded block
 * Authored text (nodes, flows, categories, glossary) lives in architecture.src.json. It holds no count that a source can give.
 *
 * Sources, all relative to the repo root (--root, so a test can use a fixture tree):
 *   hooks   .claude/settings.json.template: entries with command "node" and an args array. Other entries are counted as unparsed.
 *   skills  .claude/skills/<name>/SKILL.md      agents  .claude/agents/*.md      rules  .claude/rules-src and .claude/rules-ondemand (*.md)
 *   waves   the first Waves table of docs/review-engine/map.md
 *   mcp     never counted: the machine config holds secrets and is not read; the repo .mcp.json count is shown beside "not checked"
 *
 * A source that is missing or empty reads "not checked" and exits 2. It is never a clean pass.
 * The output holds no time and no commit id and every list is sorted, so two runs are byte-equal.
 *
 * Usage: node scripts/architecture/build-system-map.mjs [--root <dir>] [--check | --apply] [--skip-listed] [--verbose]
 *   (no mode) dry run   --check exit 1 when the committed files differ   --apply write the files
 * Exit: 0 ok, 1 a problem (stale file, listed id, bad file), 2 not checked (a source or the listed id list is missing or empty).
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VIZ = ['docs', 'architecture', 'system-visualization'];
const EMBED = /(<script type="application\/json" id="embedded-data">)([\s\S]*?)(<\/script>)/;
/** The one command that rebuilds both generated files; the failure text of a stale check names it. */
const REBUILD = 'node scripts/architecture/build-system-map.mjs --apply';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Text with LF line ends: a Windows checkout may turn the committed files into CRLF, and a compare must not see that as a change. */
const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const readJson = (f) => JSON.parse(read(f));

/** The frontmatter keys name and description of a markdown file. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const ok = (value) => ({ status: 'ok', value });
const notChecked = (reason) => ({ status: 'not checked', reason });

/** Node options known to take no separate value. Any other leading option (`--title x`, `--require x.cjs`) may consume the next argument, so the entry fails closed. */
const FLAG_ONLY_OPTIONS = new Set(['--no-warnings', '--enable-source-maps', '--no-deprecation', '--trace-warnings', '--trace-deprecation', '--no-experimental-fetch', '--experimental-vm-modules', '--preserve-symlinks']);

/** The hook file of a node registration: the first argument that is not an option. Null when it cannot be read with certainty (counted as unparsed). */
function hookFile(h) {
  if (h.command !== 'node' || !Array.isArray(h.args)) return null;
  for (const a of h.args.map(String)) {
    if (!a.startsWith('-')) return a.split(/[\\/]/).pop() || null;
    if (FLAG_ONLY_OPTIONS.has(a) || /^--[a-z0-9-]+=/.test(a)) continue; // a --x=y form carries its own value
    return null;
  }
  return null;
}

function readHooks(root) {
  const f = join(root, '.claude', 'settings.json.template');
  if (!existsSync(f)) return notChecked('.claude/settings.json.template is missing');
  let t;
  try { t = readJson(f); } catch { return notChecked('.claude/settings.json.template is not valid JSON'); }
  const items = [];
  let unparsed = 0;
  for (const event of Object.keys(t.hooks ?? {}).sort()) {
    for (const group of t.hooks[event] ?? []) {
      for (const h of group.hooks ?? []) {
        const file = hookFile(h);
        if (file) items.push({ event, matcher: group.matcher ?? '', file }); else unparsed += 1;
      }
    }
  }
  if (items.length + unparsed === 0) return notChecked('the template holds no hook registration');
  items.sort((a, b) => cmp(a.event, b.event) || cmp(a.matcher, b.matcher) || cmp(a.file, b.file));
  return ok({ items, unparsed });
}

function readMarkdownDir(dir, what) {
  if (!existsSync(dir)) return notChecked(`${what} folder is missing`);
  // A directory named x.md is not a rule or an agent: only files count.
  const list = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name).sort(cmp);
  return list.length ? ok(list) : notChecked(`${what} folder holds no .md file`);
}

function readSkills(root) {
  const dir = join(root, '.claude', 'skills');
  if (!existsSync(dir)) return notChecked('.claude/skills is missing');
  const list = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, d.name, 'SKILL.md');
    if (d.isDirectory() && existsSync(f)) { const fm = frontmatter(read(f)); list.push({ name: fm.name || d.name, description: fm.description || '' }); }
  }
  list.sort((a, b) => cmp(a.name, b.name));
  return list.length ? ok(list) : notChecked('.claude/skills holds no SKILL.md');
}

function readAgents(root) {
  const dir = join(root, '.claude', 'agents');
  const names = readMarkdownDir(dir, '.claude/agents');
  if (names.status !== 'ok') return names;
  return ok(names.value.map((n) => { const fm = frontmatter(read(join(dir, n))); return { name: fm.name || n.replace(/\.md$/, ''), description: fm.description || '' }; })
    .sort((a, b) => cmp(a.name, b.name)));
}

function readRules(root) {
  const src = readMarkdownDir(join(root, '.claude', 'rules-src'), '.claude/rules-src');
  const onDemand = readMarkdownDir(join(root, '.claude', 'rules-ondemand'), '.claude/rules-ondemand');
  if (src.status !== 'ok') return src;
  if (onDemand.status !== 'ok') return onDemand;
  return ok({ src: src.value, onDemand: onDemand.value });
}

function readWaves(root) {
  const f = join(root, 'docs', 'review-engine', 'map.md');
  if (!existsSync(f)) return notChecked('docs/review-engine/map.md is missing');
  const lines = read(f).split(/\r?\n/);
  const at = lines.findIndex((l) => /^\|\s*Wave\s*\|\s*Lane\s*\|\s*Phase\s*\|/.test(l));
  if (at < 0) return notChecked('the Waves table (Wave | Lane | Phase) is not in the map');
  const rows = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith('|')) break;
    const c = l.split('|').slice(1, -1).map((s) => s.trim());
    if (c.length >= 3) rows.push({ wave: c[0], lane: c[1].replace(/`/g, ''), phase: c[2] });
  }
  rows.sort((a, b) => Number(a.wave) - Number(b.wave) || cmp(a.lane, b.lane));
  return rows.length ? ok(rows) : notChecked('the Waves table has no row');
}

/** The MCP count is never taken: a machine config holds secrets. Only the key count of the repo .mcp.json (no values) is shown. */
function readMcp(root) {
  let declared = null;
  try { declared = Object.keys(readJson(join(root, '.mcp.json')).mcpServers ?? {}).length; } catch { /* no repo file */ }
  return { status: 'not checked', reason: 'the MCP servers of a machine are in a machine config that holds secrets and is not read', repoMcpJsonServers: declared };
}

/** The authored map is a source too: without it there is nothing to merge, which reads "not checked" in every mode. A malformed file is a bad file (the build throws). */
function readAuthored(root) {
  return existsSync(join(root, ...VIZ, 'architecture.src.json')) ? ok(true) : notChecked('architecture.src.json is missing');
}

export function collectSources(root) {
  return { authored: readAuthored(root), hooks: readHooks(root), skills: readSkills(root), agents: readAgents(root), rules: readRules(root), waves: readWaves(root), mcp: readMcp(root) };
}

const REQUIRED = ['authored', 'hooks', 'skills', 'agents', 'rules', 'waves'];
export const missingSources = (s) => REQUIRED.filter((k) => s[k].status !== 'ok').map((k) => `${k}: ${s[k].reason}`);

function setStats(g, id, stats) { const n = g.nodes.find((x) => x.id === id); if (n) n.stats = stats; }

/** The graph: the authored text plus the registry and the counts of the sources. Needs every source ok. */
export function buildGraph(root, s) {
  const g = structuredClone(readJson(join(root, ...VIZ, 'architecture.src.json')));
  const hooks = s.hooks.value, waves = s.waves.value;
  const stats = {
    hookRegistrations: hooks.items.length, hookFiles: new Set(hooks.items.map((i) => i.file)).size, hookEvents: new Set(hooks.items.map((i) => i.event)).size,
    hookUnparsed: hooks.unparsed, skills: s.skills.value.length, agents: s.agents.value.length,
    rulesSrc: s.rules.value.src.length, rulesOnDemand: s.rules.value.onDemand.length, reviewLanes: waves.length,
  };
  g.meta.stats = stats;
  g.meta.generatedBy = 'scripts/architecture/build-system-map.mjs';
  setStats(g, 'hooks', { registrations: stats.hookRegistrations, files: stats.hookFiles, events: stats.hookEvents, unparsed: stats.hookUnparsed });
  setStats(g, 'skills', { total: stats.skills });
  setStats(g, 'agents', { total: stats.agents });
  setStats(g, 'rules', { alwaysLoaded: stats.rulesSrc, onDemand: stats.rulesOnDemand });
  setStats(g, 'review-engine', { lanes: stats.reviewLanes, phases: new Set(waves.map((w) => w.phase)).size, waves: new Set(waves.map((w) => w.wave)).size });
  g.registry = {
    hooks: { items: hooks.items, unparsed: hooks.unparsed }, skills: s.skills.value, agents: s.agents.value,
    rules: s.rules.value, waves, mcp: s.mcp,
  };
  return g;
}

/** Every < in the embedded JSON becomes <: the block then holds no tag, no comment opener and no script end, and JSON.parse decodes it back. */
const escapeForHtml = (json) => json.replace(/</g, '\\u003c');

export function renderOutputs(root, g) {
  const json = JSON.stringify(g, null, 2) + '\n';
  const htmlFile = join(root, ...VIZ, 'index.html');
  const html = existsSync(htmlFile) ? read(htmlFile) : null;
  if (html === null || !EMBED.test(html)) return { json, html: null };
  return { json, html: html.replace(EMBED, (_m, open, _old, close) => `${open}${escapeForHtml(JSON.stringify(g, null, 2))}${close}`) };
}

/** What differs between the registry of a committed graph and of a fresh one: "+ key" is in the sources only, "- key" is in the graph only. */
function registryDiff(fresh, committed) {
  const keys = (r) => ({
    hooks: (r?.hooks?.items ?? []).map((i) => `${i.event}|${i.matcher}|${i.file}`), skills: (r?.skills ?? []).map((i) => i.name), agents: (r?.agents ?? []).map((i) => i.name),
    'rules-src': r?.rules?.src ?? [], 'rules-ondemand': r?.rules?.onDemand ?? [], waves: (r?.waves ?? []).map((w) => w.lane),
  });
  const a = keys(fresh), b = keys(committed), out = [];
  for (const k of Object.keys(a)) {
    for (const x of a[k]) if (!b[k].includes(x)) out.push(`${k}: + ${x}`);
    for (const x of b[k]) if (!a[k].includes(x)) out.push(`${k}: - ${x}`);
  }
  return out;
}

function summary(g) {
  const s = g.meta.stats;
  return `registered hooks ${s.hookRegistrations} (files ${s.hookFiles}, events ${s.hookEvents}, unparsed ${s.hookUnparsed}); skills ${s.skills}; agents ${s.agents}; ` +
    `rules ${s.rulesSrc} always loaded and ${s.rulesOnDemand} on demand; review lanes ${s.reviewLanes}; MCP servers: not checked`;
}

async function loadIds(root, opts) {
  if (opts.listedIds !== undefined) return opts.listedIds;
  try { const m = await import(pathToFileURL(join(HERE, '..', 'coordination', 'board-mask.mjs')).href); return m.readIdList(root); } catch { return null; }
}
async function countListed(text, ids) {
  const m = await import(pathToFileURL(join(HERE, '..', 'coordination', 'board-mask.mjs')).href);
  return m.countListed(text, ids);
}
/** The text with every listed id replaced by the board token: a diagnostic shows counts and names, never an id. */
async function hideListed(text, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return text;
  const m = await import(pathToFileURL(join(HERE, '..', 'coordination', 'board-mask.mjs')).href);
  return m.maskListed(text, ids).text;
}

/**
 * Writes every file to a temp file first, then renames them. A failed write or rename puts every file back as it was.
 * It refuses to start when a `.bak` file of an earlier crash exists. A backup whose restore failed is kept and named in the error.
 * `ops.renameSync` is for tests.
 */
export function writeAll(changed, ops = {}) {
  const rename = ops.renameSync ?? renameSync;
  const gone = (f) => { try { unlinkSync(f); } catch { /* already gone */ } };
  const older = changed.map(([f]) => `${f}.bak`).filter((x) => existsSync(x));
  if (older.length) throw new Error(`a backup file of an earlier crash exists: ${older.join(', ')}. Nothing was written. Check it, then remove or rename it.`);
  const staged = [];
  try {
    for (const [f, t] of changed) { const tmp = `${f}.tmp`; writeFileSync(tmp, t); staged.push([tmp, f]); }
  } catch (e) {
    for (const [tmp] of staged) gone(tmp);
    throw e;
  }
  const done = [], baks = [];
  try {
    for (const [tmp, f] of staged) {
      const bak = `${f}.bak`;
      const had = existsSync(f);
      if (had) { copyFileSync(f, bak); baks.push(bak); }
      rename(tmp, f);
      done.push([f, bak, had]);
    }
  } catch (e) {
    const kept = [];
    for (const [f, bak, had] of done.reverse()) {
      try { if (had) rename(bak, f); else unlinkSync(f); } catch { if (had) kept.push(bak); }
    }
    for (const [tmp] of staged) gone(tmp);
    for (const bak of baks) if (!kept.includes(bak)) gone(bak);
    if (kept.length) throw new Error(`${e.message}; the restore failed, the original is kept at: ${kept.join(', ')}`);
    throw e;
  }
  for (const bak of baks) gone(bak);
}

/** Compares the committed files with a fresh build. exitCode: 0 fresh, 1 a problem, 2 not checked. Prints counts of listed ids, never an id. */
export async function checkOutputs(root, opts = {}) {
  const sources = collectSources(root);
  const missing = missingSources(sources);
  if (missing.length) return { exitCode: 2, problems: [], notChecked: missing, lines: missing.map((m) => `not checked: ${m}`) };
  const g = buildGraph(root, sources);
  const { json, html } = renderOutputs(root, g);
  const problems = [], unchecked = [];
  const jsonFile = join(root, ...VIZ, 'architecture.json'), htmlFile = join(root, ...VIZ, 'index.html');
  const committedJson = existsSync(jsonFile) ? read(jsonFile) : null;
  if (committedJson !== json) {
    let committed = null;
    try { committed = JSON.parse(committedJson ?? 'null'); } catch { /* unreadable */ }
    let diff;
    try { diff = committed ? registryDiff(g.registry, committed.registry) : ['architecture.json is missing or unreadable']; } catch { diff = []; } // a registry of the wrong shape: the generic text below
    problems.push(`architecture.json is stale${diff.length ? `: ${diff.join('; ')}` : ' (text differs from a fresh build)'}`);
  }
  if (html === null) problems.push('index.html has no embedded-data block');
  else if (!existsSync(htmlFile) || read(htmlFile) !== html) problems.push('index.html embedded block is not the generated graph');
  let ids = null;
  if (!opts.skipListed) {
    ids = await loadIds(root, opts);
    if (!Array.isArray(ids) || ids.length === 0) unchecked.push('listed ids: no id list to count against');
    else {
      const texts = { 'architecture.src.json': read(join(root, ...VIZ, 'architecture.src.json')), 'architecture.json': json, 'index.html': html ?? '' };
      for (const [name, text] of Object.entries(texts)) { const n = await countListed(text, ids); if (n > 0) problems.push(`listed ids: ${n} in ${name}`); }
    }
  }
  const exitCode = problems.length ? 1 : unchecked.length ? 2 : 0;
  const stale = problems.some((p) => /stale|not the generated graph/.test(p));
  const lines = [...problems.map((p) => `problem: ${p}`), ...unchecked.map((u) => `not checked: ${u}`), ...(exitCode === 0 ? [`ok: ${summary(g)}`] : [`compared with: ${summary(g)}`]),
    ...(stale ? [`fix: run "${REBUILD}", then stage ${VIZ.join('/')}/architecture.json and ${VIZ.join('/')}/index.html`] : [])];
  const hide = (list) => Promise.all(list.map((t) => hideListed(t, ids)));
  return { exitCode, problems: await hide(problems), notChecked: unchecked, lines: await hide(lines) };
}

/** `opts.listedIds` (tests) replaces the id list read from the board files. */
export async function main(argv, out = (t) => process.stdout.write(`${t}\n`), opts = {}) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(opt('--root') ?? join(HERE, '..', '..'));
  const skipListed = argv.includes('--skip-listed');
  if (argv.includes('--check')) { const r = await checkOutputs(root, { ...opts, skipListed }); r.lines.forEach(out); return r.exitCode; }
  const sources = collectSources(root);
  const missing = missingSources(sources);
  if (missing.length) { missing.forEach((m) => out(`not checked: ${m}`)); out('nothing written'); return 2; }
  const g = buildGraph(root, sources);
  const { json, html } = renderOutputs(root, g);
  if (html === null) { out('problem: index.html has no embedded-data block'); return 1; }
  if (!skipListed) {
    const ids = await loadIds(root, opts);
    if (Array.isArray(ids) && ids.length) {
      // The same files as --check scans: the authored map and both outputs.
      const authored = read(join(root, ...VIZ, 'architecture.src.json'));
      const n = (await countListed(json, ids)) + (await countListed(html, ids)) + (await countListed(authored, ids));
      if (n > 0) { out(`problem: listed ids: ${n} in the authored map or the output; nothing written`); return 1; }
    } else {
      // Accepted limit (seat 11-25): with no id list (a worktree has none) apply writes, says so, and exits 0. The failure text of a stale check
      // tells a builder to run --apply, so exit 2 here would stop the fix. --check still exits 2 without a list.
      out('listed ids: not checked (no id list here)');
    }
  }
  const jsonFile = join(root, ...VIZ, 'architecture.json'), htmlFile = join(root, ...VIZ, 'index.html');
  const changed = [];
  if (!existsSync(jsonFile) || read(jsonFile) !== json) changed.push([jsonFile, json]);
  if (read(htmlFile) !== html) changed.push([htmlFile, html]);
  if (argv.includes('--apply')) writeAll(changed);
  out(changed.length ? `${argv.includes('--apply') ? 'wrote' : 'would write'}: ${changed.map(([f]) => f.split(/[\\/]/).pop()).join(', ')}` : 'no changes');
  out(summary(g));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`build-system-map: ${e.message}\n`); process.exitCode = 1; });
}
