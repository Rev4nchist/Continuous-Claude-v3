#!/usr/bin/env node
// Skill description audit / ratchet.
// A skill description is a TRIGGER, not a summary (Theo, e1snsuY4lTI @12:31). It is always in
// context, so it must be short and say WHEN to load the skill. This script reports, per skill:
// description length, trigger phrasing present, user-invoked-only flag, and whether our own
// skill-router (skill-rules.json) also covers it. Exit 1 on any violation (ratchet).
//
// Usage: node scripts/skills/audit-descriptions.mjs [--root <skills dir>] [--max 400] [--json out.json] [--quiet]
// Default root: <repo>/.claude/skills (the synced source). Third-party plugin skills are not here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(opt('--root', path.join(repo, '.claude', 'skills')));
const MAX = Number(opt('--max', 400));
const JSON_OUT = opt('--json', null);
const QUIET = args.includes('--quiet');

const TRIGGER_RE = /\b(use when|use this (skill )?when|triggers? on|when the user (says|asks|types|mentions|wants)|when asked|invoke when|load when|user says|user asks)\b/i;

function frontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  let cur = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      cur = kv[1];
      let v = kv[2].trim();
      if (v === '>' || v === '|' || v === '>-' || v === '|-') v = '';
      fm[cur] = v.replace(/^["']|["']$/g, '');
    } else if (cur && /^\s+\S/.test(raw)) {
      // continuation of a folded/indented value or nested key (metadata: user-invocable: false)
      const nested = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (nested && (cur === 'metadata')) fm[`metadata.${nested[1]}`] = nested[2].trim();
      else fm[cur] = (fm[cur] + ' ' + raw.trim()).trim();
    }
  }
  return fm;
}

let rules = {};
for (const p of [path.join(ROOT, 'skill-rules.json'), path.join(repo, '.claude', 'skill-rules.json')]) {
  if (fs.existsSync(p)) { try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); Object.assign(rules, j.skills || j); } catch {} }
}

const rows = [];
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const f = path.join(ROOT, d.name, 'SKILL.md');
  if (!fs.existsSync(f)) continue;
  const fm = frontmatter(fs.readFileSync(f, 'utf8')) || {};
  const desc = fm.description || '';
  const userOnly = fm['disable-model-invocation'] === 'true' || fm['metadata.user-invocable'] === 'false';
  rows.push({
    name: d.name, len: desc.length, trigger: TRIGGER_RE.test(desc), userOnly,
    inRouter: Boolean(rules[d.name]), desc: desc.slice(0, 120),
    violations: [
      ...(desc.length === 0 ? ['no-description'] : []),
      ...(desc.length > MAX ? [`too-long>${MAX}`] : []),
      ...(!TRIGGER_RE.test(desc) && !userOnly ? ['no-trigger-phrase'] : []),
    ],
  });
}
rows.sort((a, b) => b.len - a.len);
const bad = rows.filter((r) => r.violations.length);
const summary = {
  root: ROOT, skills: rows.length, max: MAX,
  overMax: rows.filter((r) => r.len > MAX).length,
  noTrigger: rows.filter((r) => !r.trigger && !r.userOnly).length,
  userOnly: rows.filter((r) => r.userOnly).length,
  inRouter: rows.filter((r) => r.inRouter).length,
  neitherChannel: rows.filter((r) => !r.trigger && !r.inRouter && !r.userOnly).length,
  violations: bad.length,
};
if (!QUIET) {
  console.log(`skills=${summary.skills} over${MAX}=${summary.overMax} noTrigger=${summary.noTrigger} userOnly=${summary.userOnly} inRouter=${summary.inRouter} neitherChannel=${summary.neitherChannel} violations=${summary.violations}`);
  for (const r of bad) console.log(`  ${r.name.padEnd(32)} len=${String(r.len).padStart(4)} ${r.violations.join(',')}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, rows }, null, 1));
process.exit(bad.length ? 1 : 0);
