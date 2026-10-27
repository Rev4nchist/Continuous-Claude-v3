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
// name_shadows (vendor.lock.json, per source): a LISTED name collision passes G06 or G07, any other still
// fails. See readShadows. A stale or malformed list is a hard X02.
//
// Spec: docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md section 3(a).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkill, checkSkillAll, insideDir } from './skill-rules.mjs';
import { scanSource } from './conflict-scan.mjs';

export const CONFLICT_RULE = 'X01';
// X02: <source>/vendor.lock.json pins the sha256 of every vendored file. Every file in the source,
// except the three CCv3 owns, must be a plain file listed in the lock with the same bytes. A missing
// lock is hard too: otherwise one commit could edit a vendored file and delete the lock.
export const LOCK_RULE = 'X02';
export const CCV3_OWNED = new Set(['PROVENANCE.md', 'vendor.lock.json', 'overlay.json']);
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

  const vendored = []; let expected = 0; const overlay = {}; const shadows = new Map();
  for (const { source, dir } of sources) {
    const { skills, dirs } = listSourceSkills(dir);
    expected += dirs;
    if (!skills.length) add('G30', source, `vendor source "${source}" has no skills/*/SKILL.md: the gate is vacuous for it`);
    else if (skills.length < dirs) add('G30', source, `audited ${skills.length} of ${dirs} skill dirs in vendor source "${source}"`);
    const sctx = { ...ctx, vendorRoot: dir };
    const lockRead = readLock(dir);
    const sh = readShadows(lockRead.lock);
    shadows.set(source, sh.map);
    for (const p of sh.problems) add(LOCK_RULE, source, p);
    for (const d of skills) {
      const s = safeLoad(d.dir);
      if (!s) continue;
      const label = `${source}/${s.dirName}`;
      vendored.push({ s, label, source });
      for (const x of checkSkillAll(s, sctx)) {
        if (x.rule === 'G06' && bundledExcused(sh.map, s, x.msg)) continue;
        add(x.rule, label, x.msg, x.line, x.warn);
      }
    }
    addStaleShadowFindings(source, sh.map, vendored.filter((v) => v.source === source), repoSkills, add);
    overlay[source] = addConflictFindings(dir, source, add);
    addLockFindings(dir, source, add, lockRead);
  }
  if (!sources.length) add('G30', '(gate)', `no vendor source under ${vendorDir(skillsRoot)}: the vendor profile audited 0 skills`);

  // G07: a vendored name that resolves to a CCv3 skill, or to another vendored skill, with other content.
  const byName = new Map();
  for (const { s, label, source } of vendored) byName.set(s.name, [...(byName.get(s.name) || []), { label, hash: s.hash, source }]);
  for (const s of repoSkills.filter((x) => x.modelVisible)) byName.set(s.name, [...(byName.get(s.name) || []), { label: s.dirName, hash: s.hash }]);
  for (const [name, list] of byName) {
    if (list.length < 2 || new Set(list.map((x) => x.hash)).size < 2) continue;
    if (ccv3Excused(shadows, name, list)) continue;
    for (const x of list.filter((y) => y.source)) {
      add('G07', x.label, `name "${name}" resolves to ${list.length} skills with different content (${list.map((y) => y.label).join(', ')})`);
    }
  }
  return buildVendorReport({ sources, vendored, expected, findings, overlay });
}

// <source>/vendor.lock.json, read once per source. Returns {lock} or {error} (the X02 message).
function readLock(dir) {
  try { return { lock: JSON.parse(fs.readFileSync(path.join(dir, 'vendor.lock.json'), 'utf8')) }; } catch (e) {
    if (e.code === 'ENOENT') return { error: 'no vendor.lock.json: the vendored bytes are not pinned' };
    return { error: `vendor.lock.json is not valid JSON: ${e.message}` };
  }
}

// name_shadows: the lock lists the names a vendored skill is ALLOWED to share, so a listed collision passes
// and any unlisted one still fails hard.
//   [{"name": "tdd", "shadows": ["ccv3:tdd"], "reason": "..."}]
//   name     the frontmatter name of a vendored skill in this source (the G07 key)
//   ccv3:<dir>      excuses G07 against the model-visible CCv3 skill in .claude/skills/<dir>
//   bundled:<name>  excuses G06 for this vendored skill; <name> must equal `name`
// An entry with any problem is dropped whole, so a typo never excuses anything.
// Returns {map: Map(name -> {ccv3: Set, bundled: Set}), problems: [X02 message]}. No field means no shadows.
function readShadows(lock) {
  const map = new Map(); const problems = [];
  const raw = lock?.name_shadows;
  if (raw === undefined) return { map, problems };
  if (!Array.isArray(raw)) return { map, problems: ['vendor.lock.json name_shadows must be an array of {name, shadows, reason}'] };
  raw.forEach((e, i) => {
    const at = `vendor.lock.json name_shadows entry ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push(`${at} is not an object`); return; }
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const bad = [];
    if (!name) bad.push('has no "name"');
    if (typeof e.reason !== 'string' || !e.reason.trim()) bad.push('has no "reason"');
    const list = Array.isArray(e.shadows) ? e.shadows : [];
    if (!list.length) bad.push('has no "shadows" list');
    const ccv3 = new Set(); const bundled = new Set();
    for (const t of list) {
      const m = typeof t === 'string' ? t.match(/^(ccv3|bundled):(.+)$/) : null;
      if (!m || !m[2].trim()) bad.push(`lists ${JSON.stringify(t)}: use "ccv3:<skill dir>" or "bundled:<name>"`);
      else if (m[1] === 'ccv3') ccv3.add(m[2]);
      else if (m[2] !== name) bad.push(`lists "${t}": a bundled shadow must name the entry's own "name"`);
      else bundled.add(m[2]);
    }
    if (bad.length) { for (const b of bad) problems.push(`${at} (${name || 'no name'}) ${b}`); return; }
    const have = map.get(name) || { ccv3: new Set(), bundled: new Set() };
    ccv3.forEach((x) => have.ccv3.add(x)); bundled.forEach((x) => have.bundled.add(x));
    map.set(name, have);
  });
  return { map, problems };
}

// A G06 finding for this vendored skill is excused when the source lists bundled:<that name>. The finding's
// quoted name is the frontmatter name or the folder name (rules G06 checks both).
function bundledExcused(map, s, msg) {
  const quoted = msg.match(/^"([^"]+)"/)?.[1];
  return quoted !== undefined && !!map.get(s.name)?.bundled.has(quoted);
}

// A G07 group passes only with exactly one vendored member whose source lists every CCv3 member as ccv3:<dir>.
// Two vendored sources never excuse each other, and one source's entry never covers another source.
function ccv3Excused(shadows, name, list) {
  const vendoredMembers = list.filter((x) => x.source);
  if (vendoredMembers.length !== 1) return false;
  const listed = shadows.get(vendoredMembers[0].source)?.get(name);
  return !!listed && list.filter((x) => !x.source).every((x) => listed.ccv3.has(x.label));
}

// Stale entry: the name is not a vendored skill of this source, or a ccv3 target is not a model-visible CCv3 skill.
function addStaleShadowFindings(source, map, own, repoSkills, add) {
  for (const [name, sh] of map) {
    if (!own.some((v) => v.s.name === name)) add(LOCK_RULE, source, `vendor.lock.json name_shadows lists "${name}", but no skill in ${source} has that name: stale entry`);
    for (const dir of sh.ccv3) {
      const r = repoSkills.find((x) => x.dirName === dir);
      if (!r) add(LOCK_RULE, source, `vendor.lock.json name_shadows "${name}" lists ccv3:${dir}, but no CCv3 skill has that folder: stale entry`);
      else if (!r.modelVisible) add(LOCK_RULE, source, `vendor.lock.json name_shadows "${name}" lists ccv3:${dir}, which is not model-visible: stale entry`);
    }
  }
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

// Every entry in the source except the CCv3-owned root files, as forward-slash paths relative to the
// source. The whole folder counts: a new root CLAUDE.md would be loaded by Claude Code. A link (symlink
// or junction) is listed but never followed: a link to a FIFO or a device could hang the audit.
function lockedFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (CCV3_OWNED.has(rel)) continue;
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
      else out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

// A regular file, checked without following a link.
function isRegularFile(p) { try { return fs.lstatSync(p).isFile(); } catch { return null; } }

function addLockFindings(dir, source, add, { lock, error }) {
  if (error) return add(LOCK_RULE, source, error);
  const files = Array.isArray(lock?.files) ? lock.files : [];
  if (!files.length) return add(LOCK_RULE, source, 'vendor.lock.json lists no files');
  const listed = new Set();
  for (const f of files) {
    const rel = String(f?.path || '').replace(/\\/g, '/');
    const abs = path.join(dir, rel);
    if (!rel || !insideDir(dir, abs)) { add(LOCK_RULE, source, `vendor.lock.json path "${rel}" is outside the source`); continue; }
    listed.add(rel);
    const regular = isRegularFile(abs);
    if (regular === null) { add(LOCK_RULE, source, `${rel} is in vendor.lock.json but missing`); continue; }
    if (!regular) { add(LOCK_RULE, source, `${rel} is not a regular file (a link, folder or device): vendored files must be plain copies`); continue; }
    let buf;
    try { buf = fs.readFileSync(abs); } catch { add(LOCK_RULE, source, `${rel} is in vendor.lock.json but missing`); continue; }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== f.sha256) add(LOCK_RULE, source, `${rel} differs from vendor.lock.json (sha256 ${sha.slice(0, 12)}, lock ${String(f.sha256).slice(0, 12)}): a vendored file was edited`);
  }
  for (const rel of lockedFiles(dir)) {
    if (listed.has(rel)) continue;
    const kind = isRegularFile(path.join(dir, rel)) ? 'an unpinned vendored file' : 'a link or special file, not a plain copy';
    add(LOCK_RULE, source, `${rel} is not in vendor.lock.json: ${kind}`);
  }
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
