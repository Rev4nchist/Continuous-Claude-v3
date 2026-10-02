#!/usr/bin/env node
// Skills gate: one deterministic check for every SKILL.md (rules G01-G32).
// Spec: .claude/cache/skills-eval/phase0/phase0-results.json docs.gateRules.
//
// Hard rules fail on any finding. Ratchet rules compare against audit-skills.baseline.json and
// fail only when a count rises or a new skill appears in the rule's offender list.
//
// Usage: node scripts/skills/audit-skills.mjs [--include-active] [--skill <dir>] [--json]
//          [--check-name <name>]   (G05/G06 verdict for one name; exit 1 on a finding)
//          [--update-baseline] [--rules G08,G14] [--verbose] [--quiet]
//          [--root <skills dir>] [--repo-root <dir>] [--baseline <file>]
// Exit 1 on any hard failure or ratchet regression. Last line is the summary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RULES, loadSkill, checkSkillAll, descriptionPhrases, DESCRIPTION_RULES, checkNameOnly,
} from './lib/skill-rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(here, '..', '..');
const DEFAULT_BASELINE = path.join(here, 'audit-skills.baseline.json');
const LISTING_SLACK = 1.02;

// ------------------------------------------------------------- discovery

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// A junction or symlink whose target is gone: lstat sees the link, stat fails.
function isBrokenLink(p) {
  try { if (!fs.lstatSync(p).isSymbolicLink()) return false; } catch { return false; }
  try { fs.statSync(p); return false; } catch { return true; }
}

// stat() follows junctions and symlinks; Dirent.isDirectory() does not.
export function listSkillDirs(root) {
  const skills = []; const noSkillMd = [];
  if (!isDir(root)) return { skills, noSkillMd, expected: 0 };
  for (const name of fs.readdirSync(root).sort()) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const dir = path.join(root, name);
    if (!isDir(dir)) {
      if (isBrokenLink(dir)) noSkillMd.push({ name, broken: true });
      continue;
    }
    if (isFile(path.join(dir, 'SKILL.md'))) skills.push({ dir, name });
    else noSkillMd.push({ name });
  }
  return { skills, noSkillMd, expected: skills.length };
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// Does a path exist? In --staged mode a path under the real working tree exists only when the
// index holds it (or a directory above it), so a file staged for deletion but still on disk
// does not satisfy a reference.
function existsFn(o) {
  if (!o.indexFiles || !o.fallbackRoot) return (p) => fs.existsSync(p);
  const dirs = new Set();
  for (const f of o.indexFiles) for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  const rootN = o.fallbackRoot.replace(/\\/g, '/').replace(/\/$/, '');
  return (p) => {
    const n = String(p).replace(/\\/g, '/');
    if (n.startsWith(rootN + '/')) { const rel = n.slice(rootN.length + 1); return o.indexFiles.has(rel) || dirs.has(rel); }
    return fs.existsSync(p);
  };
}

function repoFacts(o) {
  const tpl = readJson(o.settingsTemplate) || {};
  const mcpJson = readJson(o.mcpJson) || {};
  const mcpServers = new Set([...Object.keys(tpl.mcpServers || {}), ...Object.keys(mcpJson.mcpServers || mcpJson)]);
  let agentNames = new Set();
  try { agentNames = new Set(fs.readdirSync(o.agentsDir).filter((n) => /\.md$/.test(n)).map((n) => n.replace(/\.md$/, ''))); } catch { /* no agents dir */ }
  return { maxDescChars: Number(tpl.skillListingMaxDescChars) || 1536, mcpServers, agentNames, home: o.home, repoRoot: o.repoRoot, fallbackRoot: o.fallbackRoot, exists: existsFn(o) };
}

export function resolveOptions(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || DEFAULT_REPO);
  const home = opts.home || os.homedir();
  return {
    repoRoot, home,
    skillsRoot: path.resolve(opts.skillsRoot || path.join(repoRoot, '.claude', 'skills')),
    activeRoot: path.resolve(opts.activeRoot || path.join(home, '.claude', 'skills')),
    codexRoot: path.resolve(opts.codexRoot || path.join(home, '.codex', 'skills')),
    settingsTemplate: opts.settingsTemplate || path.join(repoRoot, '.claude', 'settings.json.template'),
    mcpJson: opts.mcpJson || path.join(repoRoot, '.mcp.json'),
    agentsDir: opts.agentsDir || path.join(repoRoot, '.claude', 'agents'),
    initSkill: opts.initSkill || path.join(repoRoot, '.claude', 'skills', 'skill-forge', 'scripts', 'init_skill.py'),
    baselinePath: opts.baselinePath || DEFAULT_BASELINE,
    includeActive: Boolean(opts.includeActive),
    skillDir: opts.skillDir ? path.resolve(opts.skillDir) : null,
    rules: opts.rules ? new Set(opts.rules) : null,
    runScaffold: opts.runScaffold,
    fallbackRoot: opts.fallbackRoot ? path.resolve(opts.fallbackRoot) : null,
    indexFiles: opts.indexFiles || null,
  };
}

// ------------------------------------------------------------ cross rules

function crossSkillFindings(skills, o, add) {
  // G07: same resolved name, different content.
  const byName = new Map();
  for (const s of skills.filter((x) => x.modelVisible)) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push({ skill: s.dirName, hash: s.hash, src: s.source });
  }
  if (o.includeActive) {
    for (const { dir, name } of listSkillDirs(o.codexRoot).skills) {
      const s = safeLoad(dir);
      if (!s || !s.modelVisible) continue;
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push({ skill: `codex:${name}`, hash: s.hash, src: 'codex' });
    }
  }
  for (const [name, list] of byName) {
    if (list.length > 1 && new Set(list.map((x) => x.hash)).size > 1) {
      for (const x of list) add('G07', x.skill, `name "${name}" resolves to ${list.length} skills with different content (${list.map((y) => y.skill).join(', ')})`);
    }
  }
  // G15: the same quoted trigger phrase in two or more model-visible descriptions.
  const phrases = new Map();
  for (const s of skills.filter((x) => x.modelVisible)) {
    for (const p of new Set(descriptionPhrases(s.desc))) {
      if (!phrases.has(p)) phrases.set(p, new Set());
      phrases.get(p).add(s.dirName);
    }
  }
  for (const [p, set] of phrases) {
    if (set.size < 2) continue;
    for (const sk of set) add('G15', sk, `trigger phrase "${p}" also appears in: ${[...set].filter((x) => x !== sk).join(', ')}`);
  }
}

function safeLoad(dir) {
  try { return loadSkill(dir); } catch { return null; }
}

export function listingChars(skills, maxDescChars) {
  return skills.filter((s) => s.modelVisible)
    .reduce((n, s) => n + s.name.length + Math.min((s.desc + s.when).length, maxDescChars) + 4, 0);
}

// G32 (hard): audit a fresh init_skill.py scaffold against every rule. The scaffold carries a valid
// "Does X. Use when Y." description, so no rule is excused. Returns null when there is no
// init_skill.py (nothing to check). When it exists but does not run, that is itself a finding.
function scaffoldFindings(o, ctx) {
  if (!isFile(o.initSkill)) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scaffold-'));
  const notRun = (why) => [{ rule: '(scaffold)', msg: `scaffold did not run: ${why}`, notRun: true }];
  try {
    const r = spawnSync('python', [o.initSkill, 'scaffold-probe', '--path', tmp], { encoding: 'utf8', timeout: 30000 });
    if (r.error) return notRun(r.error.code === 'ENOENT' ? 'python is not on PATH' : r.error.message);
    const dir = path.join(tmp, 'scaffold-probe');
    if (r.status !== 0) return notRun(`init_skill.py exited ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 120)}`);
    if (!isFile(path.join(dir, 'SKILL.md'))) return notRun('init_skill.py wrote no SKILL.md');
    const s = loadSkill(dir);
    return checkSkillAll(s, ctx).filter((x) => !x.warn);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ----------------------------------------------------------------- audit

export function auditSkills(rawOpts = {}) {
  const o = resolveOptions(rawOpts);
  const ctx = repoFacts(o);
  const findings = []; const warnings = [];
  const add = (rule, skill, msg, line, source) => findings.push({ rule, skill, msg, ...(line ? { line } : {}), ...(source ? { source } : {}) });

  let dirs; let expected; let noSkillMd = [];
  if (o.skillDir) {
    dirs = [{ dir: o.skillDir, name: path.basename(o.skillDir) }];
    expected = isFile(path.join(o.skillDir, 'SKILL.md')) ? 1 : 0;
  } else {
    const repo = listSkillDirs(o.skillsRoot);
    dirs = repo.skills.map((d) => ({ ...d, source: 'repo' }));
    expected = repo.expected; noSkillMd = repo.noSkillMd.map((e) => ({ ...e, src: 'repo' }));
    if (o.includeActive) {
      const have = new Set(dirs.map((d) => d.name));
      const active = listSkillDirs(o.activeRoot);
      const only = active.skills.filter((d) => !have.has(d.name)).map((d) => ({ ...d, source: 'active' }));
      dirs.push(...only); expected += only.length;
      noSkillMd.push(...active.noSkillMd.map((e) => ({ ...e, src: 'active' })));
    }
  }

  const skills = [];
  for (const d of dirs) {
    const s = safeLoad(d.dir);
    if (!s) continue;
    s.source = d.source || 'repo';
    skills.push(s);
    for (const x of checkSkillAll(s, ctx)) {
      if (x.warn) warnings.push(`${x.rule} ${s.dirName}${x.line ? `:${x.line}` : ''}: ${x.msg}`);
      else add(x.rule, s.dirName, x.msg, x.line, s.source);
    }
    if (/grok/i.test(s.src) && !/\b(never|parked|retired|deprecated)\b/i.test(s.src)) warnings.push(`G27 ${s.dirName}: mentions grok (parked)`);
    if (s.parts.bodyLines.join('\n').length > 20000) warnings.push(`G20 ${s.dirName}: body over 20,000 chars (compaction re-attach limit)`);
  }

  if (!o.skillDir) {
    crossSkillFindings(skills, o, (r, sk, m) => add(r, sk, m));
    for (const { name, src, broken } of noSkillMd) {
      add('G29', name, broken ? `${src}:${name} is a broken junction or symlink` : `directory ${src}:${name} has no SKILL.md (prefix _ or . to park it)`);
    }
  } else {
    // Single-skill mode: still check collisions against the repo set.
    const repo = listSkillDirs(o.skillsRoot).skills.map((d) => safeLoad(d.dir)).filter(Boolean);
    const mine = skills[0];
    if (mine) {
      const others = repo.filter((x) => x.dirName !== mine.dirName);
      const all = [...others.map((x) => Object.assign(x, { source: 'repo' })), mine];
      crossSkillFindings(all, { ...o, includeActive: false }, (r, sk, m) => { if (sk === mine.dirName) add(r, sk, m); });
    }
  }

  // G30: a gate that audits nothing, or fewer skills than exist, proves nothing.
  if (skills.length === 0) add('G30', '(gate)', 'audited 0 skills: the gate is vacuous');
  else if (skills.length < expected) add('G30', '(gate)', `audited ${skills.length} of ${expected} skill dirs`);

  const baseline = readJson(o.baselinePath) || {};
  const scopeKey = o.includeActive ? 'repo+active' : 'repo';
  const scope = (baseline.scopes && baseline.scopes[scopeKey]) || { rules: {} };

  const listing = { chars: listingChars(skills, ctx.maxDescChars), visible: skills.filter((s) => s.modelVisible).length, maxDescChars: ctx.maxDescChars };
  if (!o.skillDir && (!o.rules || o.rules.has('G32')) && o.runScaffold !== false) {
    const sc = scaffoldFindings(o, ctx);
    if (sc) for (const x of sc) add('G32', x.rule, x.notRun ? x.msg : `fresh init_skill.py scaffold fails ${x.rule}: ${x.msg}`);
  }
  return buildReport({ o, skills, findings, warnings, scope, scopeKey, listing, expected });
}

function buildReport({ o, skills, findings, warnings, scope, scopeKey, listing, expected }) {
  const active = RULES.filter((r) => !o.rules || o.rules.has(r.id));
  const rules = {};
  let hardFailures = 0; const regressions = [];
  for (const r of active) {
    const fs_ = findings.filter((x) => x.rule === r.id);
    const names = [...new Set(fs_.map((x) => x.skill))].sort();
    const base = scope.rules[r.id];
    const entry = { id: r.id, name: r.name, mode: r.mode, count: fs_.length, skills: names, findings: fs_, baseline: base ? base.count : null, status: 'ok', newSkills: [] };
    if (r.mode === 'hard') {
      if (fs_.length) { entry.status = 'FAIL'; hardFailures += fs_.length; }
    } else if (r.id === 'G31') {
      const b = scope.listing;
      entry.count = listing.chars; entry.baseline = b ? b.chars : null; entry.skills = []; entry.findings = [];
      if (!o.skillDir && b && listing.chars > b.chars * LISTING_SLACK) {
        entry.status = 'REGRESSION'; regressions.push(r.id);
        entry.findings = [{ rule: 'G31', skill: '(listing)', msg: `listing is ${listing.chars} chars, baseline ${b.chars} (+2% allowed)` }];
      } else if (!o.skillDir && !b) { entry.status = 'REGRESSION'; regressions.push(r.id); entry.findings = [{ rule: 'G31', skill: '(listing)', msg: 'no listing baseline; run --update-baseline' }]; }
    } else {
      // Per-skill counts: a swap (skill A down 2, skill B up 2) keeps the total but is a regression.
      const baseCounts = base && !Array.isArray(base.skills) ? base.skills : {};
      entry.newSkills = names.filter((n) => fs_.filter((x) => x.skill === n).length > (baseCounts[n] || 0));
      const rose = !o.skillDir && fs_.length > (base ? base.count : 0);
      if (rose || entry.newSkills.length) { entry.status = 'REGRESSION'; regressions.push(r.id); }
    }
    rules[r.id] = entry;
  }
  const baselineName = path.basename(o.baselinePath);
  const summary = `audit-skills: ${skills.length} skills, ${hardFailures} hard failures, ${regressions.length} ratchet regressions, baseline ${baselineName}`;
  return { scope: scopeKey, skillCount: skills.length, expected, rules, hardFailures, regressions, warnings, listing, summary, skills: skills.map((s) => s.dirName), failed: hardFailures > 0 || regressions.length > 0 };
}

// -------------------------------------------------------------- baseline

export function writeBaseline(report, o) {
  const cur = readJson(o.baselinePath) || { version: 1, scopes: {} };
  cur.version = 1;
  cur._doc = 'Per-rule ratchet baseline for audit-skills.mjs. rules.<id>.skills maps skill -> finding count; a rule regresses when any skill count rises or a new skill appears. Rewrite with --update-baseline.';
  cur._notes = {
    G32: 'Hard: a fresh init_skill.py scaffold must pass every rule. A scaffold that does not run is reported as "(scaffold)" and fails the gate.',
    G06: 'Ratchet: Dave decides the renames of skills that share a bundled name.',
  };
  cur.scopes = cur.scopes || {};
  const scope = cur.scopes[report.scope] || { rules: {} };
  for (const r of Object.values(report.rules)) {
    if (r.mode !== 'ratchet') { delete scope.rules[r.id]; continue; } // a hard rule keeps no baseline
    if (r.id === 'G31') continue;
    const perSkill = {};
    for (const n of r.skills) perSkill[n] = r.findings.filter((x) => x.skill === n).length;
    scope.rules[r.id] = { count: r.count, skills: perSkill };
  }
  if (report.rules.G31) scope.listing = { chars: report.listing.chars, visibleSkills: report.listing.visible, maxDescChars: report.listing.maxDescChars };
  const ordered = {};
  for (const k of Object.keys(scope.rules).sort()) ordered[k] = scope.rules[k];
  scope.rules = ordered;
  cur.scopes[report.scope] = scope;
  fs.writeFileSync(o.baselinePath, JSON.stringify(cur, null, 1) + '\n');
}

// ---------------------------------------------------------------- output

export function formatReport(report, { verbose = false, quiet = false } = {}) {
  const lines = [];
  if (!quiet) {
    lines.push('rule  name                              mode     count  baseline  status');
    for (const r of Object.values(report.rules)) {
      lines.push(`${r.id}   ${r.name.padEnd(33)} ${r.mode.padEnd(8)} ${String(r.count).padStart(5)}  ${(r.baseline === null ? '-' : String(r.baseline)).padStart(8)}  ${r.status}`);
    }
    lines.push(`listing: ${report.listing.chars} chars over ${report.listing.visible} model-visible skills (cap per skill ${report.listing.maxDescChars})`);
    lines.push(`audited ${report.skillCount} skills (expected ${report.expected}); scope ${report.scope}; warnings ${report.warnings.length}`);
  }
  for (const r of Object.values(report.rules)) {
    if (r.status === 'FAIL') for (const x of r.findings) lines.push(`FAIL ${r.id} ${x.skill}${x.line ? `:${x.line}` : ''} ${x.msg}`);
    if (r.status === 'REGRESSION') {
      if (r.newSkills.length) lines.push(`REGRESSION ${r.id}: more findings than baseline in ${r.newSkills.join(', ')}`);
      else lines.push(`REGRESSION ${r.id}: count ${r.count} is above baseline ${r.baseline ?? 0}`);
      for (const x of r.findings.filter((y) => !r.newSkills.length || r.newSkills.includes(y.skill))) lines.push(`  ${x.skill}${x.line ? `:${x.line}` : ''} ${x.msg}`);
    } else if (verbose && r.mode === 'ratchet') {
      for (const x of r.findings) lines.push(`  baseline ${r.id} ${x.skill}${x.line ? `:${x.line}` : ''} ${x.msg}`);
    }
  }
  // Warnings are visible unless --quiet (G22 sync-gap warnings always show); the noisy G20 size
  // notes show only with --verbose.
  const show = (w) => verbose || (!w.startsWith('G20') && (!quiet || w.startsWith('G22')));
  for (const w of report.warnings) if (show(w)) lines.push(`WARN ${w}`);
  lines.push(report.summary);
  return lines.join('\n');
}

// ------------------------------------------------------------------- CLI

// --staged: audit what is in the git index, not the working tree (pre-commit). Exports the files
// the gate reads to a temp dir. Files outside that set (for example a script a skill points at)
// resolve against the index too (see indexFiles), never the working tree.
// KEEP IN STEP with the trigger regex in scripts/precommit-build-guard.sh:
//   ^\.claude/skills/|^scripts/skills/|^\.claude/settings\.json\.template$|^\.claude/agents/|^\.mcp\.json$
// Every path the gate reads must be both exported here and a trigger there.
const STAGED_PATHS = ['.claude/skills', 'scripts/skills', '.claude/settings.json.template', '.claude/agents', '.mcp.json'];

export function exportStaged(cwd) {
  const git = (args, input) => spawnSync('git', args, { cwd, input, maxBuffer: 256 * 1024 * 1024 });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error('not inside a git work tree');
  const root = top.stdout.toString().trim();
  const ls = spawnSync('git', ['ls-files', '-z', '--', ...STAGED_PATHS], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  if (ls.status !== 0) throw new Error('git ls-files failed');
  const files = ls.stdout.toString().split('\0').filter((p) => p && !p.startsWith('.claude/skills/_') && !p.startsWith('.claude/skills/.'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-skills-staged-'));
  const co = spawnSync('git', ['checkout-index', '-z', '--stdin', `--prefix=${tmp.replace(/\\/g, '/')}/`], { cwd: root, input: files.join('\0') + '\0', maxBuffer: 256 * 1024 * 1024 });
  if (co.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`git checkout-index failed: ${co.stderr.toString().trim()}`); }
  // Every file in the index, for ref resolution outside the exported set.
  const all = spawnSync('git', ['ls-files', '--cached', '-z'], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  if (all.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('git ls-files --cached failed'); }
  const indexFiles = new Set(all.stdout.toString().split('\0').filter(Boolean));
  return { root, tmp, indexFiles };
}

// --check-name <name>: the G05/G06 verdict for a bare name, used by init_skill.py before it writes anything.
function checkNameCli(name, asJson) {
  const findings = name === undefined ? [{ rule: 'G05', msg: '--check-name needs a name' }] : checkNameOnly(name);
  const ok = findings.length === 0;
  const text = ok ? `name "${name}" ok` : findings.map((x) => `${x.rule} ${x.msg}`).join('\n');
  console.log(asJson ? JSON.stringify({ name, ok, findings }) : text);
  return ok ? 0 : 1;
}

export function main(argv) {
  const has = (k) => argv.includes(k);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (has('--check-name')) return checkNameCli(val('--check-name'), has('--json'));
  const opts = {
    includeActive: has('--include-active'),
    skillDir: val('--skill'),
    rules: val('--rules') ? val('--rules').split(',').map((x) => x.trim()) : null,
    skillsRoot: val('--root'),
    repoRoot: val('--repo-root'),
    baselinePath: val('--baseline'),
  };
  if (has('--update-baseline') && opts.skillDir) { console.error('--update-baseline cannot run with --skill'); return 2; }
  if (has('--staged')) {
    if (has('--update-baseline')) { console.error('--update-baseline cannot run with --staged'); return 2; }
    let staged;
    try { staged = exportStaged(process.cwd()); } catch (e) { console.error(`audit-skills --staged: cannot read the index: ${e.message}`); return 2; }
    try {
      opts.repoRoot = staged.tmp;
      opts.fallbackRoot = staged.root;
      opts.indexFiles = staged.indexFiles;
      opts.baselinePath = opts.baselinePath || path.join(staged.tmp, 'scripts', 'skills', 'audit-skills.baseline.json');
      const report = auditSkills(opts);
      console.log(has('--json') ? JSON.stringify(report, null, 1) : formatReport(report, { verbose: has('--verbose'), quiet: has('--quiet') }));
      return report.failed ? 1 : 0;
    } finally { fs.rmSync(staged.tmp, { recursive: true, force: true }); }
  }
  let report = auditSkills(opts);
  const o = resolveOptions(opts);
  if (has('--update-baseline')) {
    writeBaseline(report, o);
    report = auditSkills(opts);
  }
  if (has('--json')) console.log(JSON.stringify({ ...report, rules: Object.fromEntries(Object.entries(report.rules).map(([k, v]) => [k, { ...v, findings: v.findings }])) }, null, 1));
  else console.log(formatReport(report, { verbose: has('--verbose'), quiet: has('--quiet') }));
  return report.failed ? 1 : 0;
}

export { DESCRIPTION_RULES };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
