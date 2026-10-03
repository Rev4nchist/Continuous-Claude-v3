// Vendor profile of the skills gate: audits vendored (external) skills.
//
// Layout: <skills root>/_vendor/<source>/skills/<name>/SKILL.md, plus a shared <source>/common/
// folder that skills link as ../../common/x.md. The default scan skips every _ folder (audit-skills.mjs
// listSkillDirs), so without this profile a vendored file gets no coverage at all.
//
// Vendored text is never edited and its descriptions never reach the skill listing, so the rules
// split in two classes:
//   hard      any finding fails the gate. The text is unusable or unsafe.
//   advisory  reported with counts, never fails. Style rules written for CCv3-authored skills.
// A conflict scan (conflict-scan.mjs) adds hard finding X01 for a CCv3 "never" hit that no overlay
// entry covers. CCv3-authored skills keep every rule in the default scan.
//
// Spec: docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md section 3(a).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkill, checkSkillAll, insideDir } from './skill-rules.mjs';
import { scanSource } from './conflict-scan.mjs';

export const CONFLICT_RULE = 'X01';
// X02: <source>/vendor.lock.json pins the sha256 of every vendored file. With a lock, an edited, a
// missing or an unlisted file under a locked folder is hard. Without a lock it is advisory only.
export const LOCK_RULE = 'X02';
export const LOCKED_DIRS = ['skills', 'common', 'mcp-setup'];
// G30 (vacuous profile), X01 (uncovered conflict) and X02 (lock) are profile rules, not per-skill rules.
export const VENDOR_HARD = new Set(['G01', 'G02', 'G03', 'G06', 'G07', 'G08', 'G11', 'G22', 'G25', 'G27', 'G28', 'G30', CONFLICT_RULE, LOCK_RULE]);
// Documented for readers. Any per-skill rule not in VENDOR_HARD is advisory, including the rules
// the proposal does not name (G04 G05 G16 G17 G18 G19): they police how a skill loads, and a
// vendored skill is only ever read by the hub, never loaded by Claude Code.
export const VENDOR_ADVISORY = ['G09', 'G10', 'G12', 'G13', 'G14', 'G20', 'G21', 'G23', 'G24', 'G26'];

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

export function vendorDir(skillsRoot) { return path.join(skillsRoot, '_vendor'); }

// Sources under _vendor/ that hold anything: [{source, dir}]. Dot folders are ignored.
export function listVendorSources(skillsRoot) {
  const base = vendorDir(skillsRoot);
  if (!isDir(base)) return [];
  return fs.readdirSync(base).filter((n) => !n.startsWith('.') && isDir(path.join(base, n)))
    .sort().map((source) => ({ source, dir: path.join(base, source) }));
}

function listSourceSkills(dir) {
  const root = path.join(dir, 'skills');
  const skills = []; let dirs = 0;
  if (!isDir(root)) return { skills, dirs };
  for (const n of fs.readdirSync(root).sort()) {
    if (n.startsWith('.') || !isDir(path.join(root, n))) continue;
    dirs++;
    if (isFile(path.join(root, n, 'SKILL.md'))) skills.push({ dir: path.join(root, n), name: n });
  }
  return { skills, dirs };
}

function safeLoad(dir) { try { return loadSkill(dir); } catch { return null; } }

// Audit every vendored skill. `ctx` is the gate's repo facts (see repoFacts in audit-skills.mjs).
// `repoSkills` are the loaded CCv3 skills, for the G07 name-collision check.
// `required`: the profile was asked for by name, so "nothing to audit" is itself a failure.
export function auditVendor(skillsRoot, ctx, { repoSkills = [], required = false } = {}) {
  const sources = listVendorSources(skillsRoot);
  const findings = [];
  const add = (rule, skill, msg, line, warn) => findings.push({
    rule, skill, msg, ...(line ? { line } : {}),
    class: VENDOR_HARD.has(rule) && !warn ? 'hard' : 'advisory',
  });
  if (!sources.length && !required) return null;

  const vendored = []; let expected = 0; const overlay = {};
  for (const { source, dir } of sources) {
    const { skills, dirs } = listSourceSkills(dir);
    expected += dirs;
    if (!skills.length) add('G30', source, `vendor source "${source}" has no skills/*/SKILL.md: the gate is vacuous for it`);
    else if (skills.length < dirs) add('G30', source, `audited ${skills.length} of ${dirs} skill dirs in vendor source "${source}"`);
    const sctx = { ...ctx, vendorRoot: dir };
    for (const d of skills) {
      const s = safeLoad(d.dir);
      if (!s) continue;
      const label = `${source}/${s.dirName}`;
      vendored.push({ s, label });
      for (const x of checkSkillAll(s, sctx)) add(x.rule, label, x.msg, x.line, x.warn);
    }
    overlay[source] = addConflictFindings(dir, source, add);
    addLockFindings(dir, source, add);
  }
  if (!sources.length) add('G30', '(gate)', `no vendor source under ${vendorDir(skillsRoot)}: the vendor profile audited 0 skills`);

  // G07: a vendored name that resolves to a CCv3 skill, or to another vendored skill, with other content.
  const byName = new Map();
  for (const { s, label } of vendored) byName.set(s.name, [...(byName.get(s.name) || []), { label, hash: s.hash }]);
  for (const s of repoSkills.filter((x) => x.modelVisible)) byName.set(s.name, [...(byName.get(s.name) || []), { label: s.dirName, hash: s.hash }]);
  for (const [name, list] of byName) {
    if (list.length < 2 || new Set(list.map((x) => x.hash)).size < 2) continue;
    for (const x of list.filter((y) => vendored.some((v) => v.label === y.label))) {
      add('G07', x.label, `name "${name}" resolves to ${list.length} skills with different content (${list.map((y) => y.label).join(', ')})`);
    }
  }
  return buildVendorReport({ sources, vendored, expected, findings, overlay });
}

function addConflictFindings(dir, source, add) {
  const scan = scanSource(dir);
  for (const e of scan.overlayErrors) add('X01', source, e);
  for (const v of scan.entryViolations) add('X01', source, v);
  for (const h of scan.uncovered) {
    add('X01', source, `uncovered conflict [${h.topic}] ${h.file}:${h.line}: ${h.text} (CCv3 rule: ${h.ccv3_rule})`);
  }
  return scan.entryStats;
}

// Files under the locked folders, as forward-slash paths relative to the source.
function lockedFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  for (const top of LOCKED_DIRS) walk(path.join(dir, top));
  return out.sort();
}

function addLockFindings(dir, source, add) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'vendor.lock.json'), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return add(LOCK_RULE, source, 'no vendor.lock.json: the vendored bytes are not pinned', undefined, true);
    return add(LOCK_RULE, source, `vendor.lock.json is not valid JSON: ${e.message}`);
  }
  const files = Array.isArray(lock?.files) ? lock.files : [];
  if (!files.length) return add(LOCK_RULE, source, 'vendor.lock.json lists no files');
  const listed = new Set();
  for (const f of files) {
    const rel = String(f?.path || '').replace(/\\/g, '/');
    const abs = path.join(dir, rel);
    if (!rel || !insideDir(dir, abs)) { add(LOCK_RULE, source, `vendor.lock.json path "${rel}" is outside the source`); continue; }
    listed.add(rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { add(LOCK_RULE, source, `${rel} is in vendor.lock.json but missing`); continue; }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== f.sha256) add(LOCK_RULE, source, `${rel} differs from vendor.lock.json (sha256 ${sha.slice(0, 12)}, lock ${String(f.sha256).slice(0, 12)}): a vendored file was edited`);
  }
  for (const rel of lockedFiles(dir)) if (!listed.has(rel)) add(LOCK_RULE, source, `${rel} is not in vendor.lock.json: an unpinned vendored file`);
}

function buildVendorReport({ sources, vendored, expected, findings, overlay }) {
  const hard = findings.filter((f) => f.class === 'hard');
  const advisory = findings.filter((f) => f.class === 'advisory');
  const perSkill = {};
  for (const { label } of vendored) perSkill[label] = { hard: 0, advisory: 0 };
  for (const f of findings) {
    perSkill[f.skill] = perSkill[f.skill] || { hard: 0, advisory: 0 };
    perSkill[f.skill][f.class]++;
  }
  const advisoryByRule = {};
  for (const f of advisory) advisoryByRule[f.rule] = (advisoryByRule[f.rule] || 0) + 1;
  const skillCount = vendored.length;
  return {
    profile: 'vendor', sources: sources.map((s) => s.source), skillCount, expected,
    findings, hardFailures: hard.length, advisoryCount: advisory.length, perSkill, advisoryByRule, overlay,
    summary: `audit-skills vendor: ${skillCount} skills, ${hard.length} hard failures, ${advisory.length} advisory findings`,
    failed: hard.length > 0,
  };
}

// One FAIL line per hard finding. A conflict hit (X01) is one finding per line of vendored text, and an
// overlay-less source has hundreds, so the text view groups them by topic and file. --json keeps each hit.
function hardLines(hard) {
  const lines = []; const groups = new Map();
  for (const f of hard) {
    const m = f.rule === CONFLICT_RULE && f.msg.match(/^uncovered conflict \[([^\]]+)\] (.+?):(\d+): /);
    if (!m) { lines.push(`FAIL ${f.rule} ${f.skill}${f.line ? `:${f.line}` : ''} ${f.msg}`); continue; }
    const key = `${f.skill}\0${m[1]}\0${m[2]}`;
    if (!groups.has(key)) groups.set(key, { skill: f.skill, topic: m[1], file: m[2], lines: [] });
    groups.get(key).lines.push(m[3]);
  }
  for (const g of groups.values()) {
    const shown = g.lines.slice(0, 8).join(',');
    lines.push(`FAIL ${CONFLICT_RULE} ${g.skill} uncovered [${g.topic}] ${g.file}: ${g.lines.length} hit(s) at line ${shown}${g.lines.length > 8 ? ',...' : ''}`);
  }
  return lines;
}

export function formatVendorReport(rep, { verbose = false, quiet = false } = {}) {
  const lines = [];
  if (!quiet) {
    const names = Object.keys(rep.perSkill).sort();
    const width = Math.max(5, ...names.map((n) => n.length));
    lines.push(`vendor profile: ${rep.sources.join(', ') || '(none)'}; hard = ${[...VENDOR_HARD].filter((r) => r !== 'G30').join(' ')}; the rest advisory`);
    lines.push(`${'skill'.padEnd(width)}  hard  advisory`);
    for (const n of names) lines.push(`${n.padEnd(width)}  ${String(rep.perSkill[n].hard).padStart(4)}  ${String(rep.perSkill[n].advisory).padStart(8)}`);
    const byRule = Object.entries(rep.advisoryByRule).sort().map(([r, c]) => `${r}=${c}`).join(' ');
    lines.push(`advisory by rule: ${byRule || 'none'}`);
    for (const [source, entries] of Object.entries(rep.overlay || {})) {
      for (const e of entries) lines.push(`overlay ${source} [${e.topic}] /${e.pattern}/: ${e.hits} hits in ${e.fileCount} files (cap ${e.max_hits})`);
    }
  }
  lines.push(...hardLines(rep.findings.filter((x) => x.class === 'hard')));
  if (verbose) for (const f of rep.findings.filter((x) => x.class === 'advisory')) lines.push(`  advisory ${f.rule} ${f.skill}${f.line ? `:${f.line}` : ''} ${f.msg}`);
  lines.push(rep.summary);
  return lines.join('\n');
}
