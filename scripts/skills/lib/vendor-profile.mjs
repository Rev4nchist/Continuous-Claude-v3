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

import fs from 'node:fs';
import path from 'node:path';
import { loadSkill, checkSkillAll } from './skill-rules.mjs';
import { scanSource } from './conflict-scan.mjs';

export const CONFLICT_RULE = 'X01';
// G30 (vacuous profile) and X01 (uncovered conflict) are profile rules, not per-skill rules.
export const VENDOR_HARD = new Set(['G01', 'G02', 'G03', 'G06', 'G07', 'G08', 'G11', 'G22', 'G25', 'G27', 'G28', 'G30', CONFLICT_RULE]);
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

  const vendored = []; let expected = 0;
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
    addConflictFindings(dir, source, add);
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
  return buildVendorReport({ sources, vendored, expected, findings });
}

function addConflictFindings(dir, source, add) {
  const scan = scanSource(dir);
  for (const e of scan.overlayErrors) add('X01', source, e);
  for (const h of scan.uncovered) {
    add('X01', source, `uncovered conflict [${h.topic}] ${h.file}:${h.line}: ${h.text} (CCv3 rule: ${h.ccv3_rule})`);
  }
}

function buildVendorReport({ sources, vendored, expected, findings }) {
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
    findings, hardFailures: hard.length, advisoryCount: advisory.length, perSkill, advisoryByRule,
    summary: `audit-skills vendor: ${skillCount} skills, ${hard.length} hard failures, ${advisory.length} advisory findings`,
    failed: hard.length > 0,
  };
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
  }
  for (const f of rep.findings.filter((x) => x.class === 'hard')) lines.push(`FAIL ${f.rule} ${f.skill}${f.line ? `:${f.line}` : ''} ${f.msg}`);
  if (verbose) for (const f of rep.findings.filter((x) => x.class === 'advisory')) lines.push(`  advisory ${f.rule} ${f.skill}${f.line ? `:${f.line}` : ''} ${f.msg}`);
  lines.push(rep.summary);
  return lines.join('\n');
}
