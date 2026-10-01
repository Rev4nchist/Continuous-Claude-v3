// Shared rule library for the skills gate (scripts/skills/audit-skills.mjs).
// One implementation of every per-skill rule G01-G29. Zero dependencies.
// Cross-skill rules (G07, G15, G30, G31, G32) live in audit-skills.mjs.
//
// Spec: .claude/cache/skills-eval/phase0/phase0-results.json docs.gateRules (G01-G32).

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- constants

// A description must say WHEN to use the skill. One regex for every gate.
export const TRIGGER_RE = /\b(use when|use this (skill )?when|triggers? on|when the user (says|asks|types|mentions|wants)|when asked|invoke when|load when|user says|user asks)\b/i;

export const KNOWN_KEYS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation',
  'user-invocable', 'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent',
  'background', 'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility',
]);

// G06: skill names Claude Code reserves or ships itself. A local skill with one of these names
// shadows (or is shadowed by) the bundled one. Dave decides renames; the gate only ratchets.
export const RESERVED_NAMES = new Set([
  'synced', 'debug', 'code-review', 'review', 'help', 'doctor', 'loop', 'run', 'verify', 'batch',
  'simplify', 'init', 'compact', 'clear', 'config', 'context', 'cost', 'memory', 'hooks', 'agents',
  'mcp', 'model', 'permissions', 'resume', 'status', 'security-review', 'claude-api',
  'update-config', 'schedule', 'fewer-permission-prompts',
]);
// G06 allowlist: name -> reason. Empty on purpose.
export const RESERVED_ALLOW = {};

// G03 allowlist: skill -> keys, with the reason. Claude Code ignores unknown keys, so these are safe.
export const KEY_ALLOW = {
  impeccable: ['version'], // impeccable/scripts/context.mjs reads its version from the SKILL.md frontmatter
};

export const BOOL_TRUE = /^(true|yes|on|1)$/i;
export const BOOL_FALSE = /^(false|no|off|0)$/i;
export const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export const BUILTIN_AGENTS = new Set(['Plan', 'general-purpose']);

export const RETIRED_RE = /braintrust|serena|codegraph|claude-in-chrome|haiku|skill-activation-prompt|subagent_type.{0,5}Explore|agent:\s*Explore/i;
const RETIRED_CONTEXT_RE = /\b(never|retired|deprecated|do not|don't|removed|banned)\b/i;

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const DATE_ISO_RE = /\b20\d\d-\d\d-\d\d\b/;
const DATE_REL_RE = new RegExp(`\\b(?:as of|before|after)\\s+(?:(?:${MONTHS})\\b|20\\d\\d\\b)`, 'i');

const SHELL_FENCE_RE = /^(powershell|pwsh|ps1|cmd|bat|batch|dos)$/i;

// Rule table. mode: 'hard' = any finding fails; 'ratchet' = fails only when the count rises or a
// new skill appears in the rule's offender list (baseline in audit-skills.baseline.json).
export const RULES = [
  ['G01', 'frontmatter-first-line', 'hard'],
  ['G02', 'yaml-parse', 'hard'],
  ['G03', 'known-keys', 'hard'],
  ['G04', 'metadata-shadow', 'ratchet'],
  ['G05', 'name-format', 'ratchet'],
  ['G06', 'reserved-and-bundled-names', 'ratchet'],
  ['G07', 'unique-names', 'hard'],
  ['G08', 'description-present-and-capped', 'hard'],
  ['G09', 'description-length-over-400', 'ratchet'],
  ['G10', 'description-single-line', 'hard'],
  ['G11', 'description-no-xml', 'hard'],
  ['G12', 'description-third-person', 'ratchet'],
  ['G13', 'description-what', 'ratchet'],
  ['G14', 'description-when', 'hard'],
  ['G15', 'trigger-collision', 'ratchet'],
  ['G16', 'booleans', 'hard'],
  ['G17', 'fork-consistency', 'hard'],
  ['G18', 'model-effort', 'hard'],
  ['G19', 'allowed-tools-scope', 'ratchet'],
  ['G20', 'body-length', 'hard'],
  ['G21', 'dollar-escape', 'ratchet'],
  ['G22', 'refs-resolve', 'hard'],
  ['G23', 'refs-one-level', 'ratchet'],
  ['G24', 'ref-toc', 'ratchet'],
  ['G25', 'forward-slash-paths', 'ratchet'],
  ['G26', 'dated-text', 'ratchet'],
  ['G27', 'retired-names', 'ratchet'],
  ['G28', 'mcp-qualified', 'ratchet'],
  ['G29', 'skill-dir-hygiene', 'ratchet'],
  ['G30', 'non-vacuous', 'hard'],
  ['G31', 'listing-size-ratchet', 'ratchet'],
  ['G32', 'skill-forge-template-passes', 'ratchet'],
].map(([id, name, mode]) => ({ id, name, mode }));

// Rules that read only the description. audit-descriptions.mjs runs this subset.
export const DESCRIPTION_RULES = ['G01', 'G02', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14', 'G30', 'G31'];

// ------------------------------------------------------------------ YAML

// A plain (unquoted) YAML scalar cannot contain ": " or " #": the first ends the value with a
// parse error, the second silently cuts it at a comment. Claude Code then drops the description
// and lists the skill under its first body heading, so the skill never triggers.
export function plainScalarError(v) {
  if (!v || /^[>|]/.test(v)) return null;
  if (v[0] === '"') return /^"(?:[^"\\]|\\(?:[0abtnvfre "\/\\N_LP\t]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*"\s*(#.*)?$/.test(v) ? null : 'yaml-bad-double-quoted-scalar';
  if (v[0] === "'") return /^'(?:[^']|'')*'\s*(#.*)?$/.test(v) ? null : 'yaml-unterminated-or-trailing-quoted-scalar';
  if (v[0] === '[' || v[0] === '{') return null; // flow collections are checked by shape, not by colon
  // A plain scalar cannot start with these YAML indicators (@ and ` are reserved).
  if (/^[`@*&!%]/.test(v)) return 'yaml-reserved-indicator-at-start-of-plain-scalar';
  if (/:(\s|$)/.test(v)) return 'yaml-colon-in-plain-scalar';
  if (/\s#/.test(v)) return 'yaml-comment-in-plain-scalar';
  return null;
}

function unquote(v) {
  v = v.trim();
  if (v[0] === '"') {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\(["\\\/])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t') : v.slice(1);
  }
  if (v[0] === "'") {
    const m = v.match(/^'((?:[^']|'')*)'/);
    return m ? m[1].replace(/''/g, "'") : v.slice(1);
  }
  return v.replace(/\s+#.*$/, '');
}

// Split on commas or whitespace that sit outside parentheses.
function splitTools(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((t) => unquote(t)).filter(Boolean);
}

export function splitFile(src) {
  const text = src.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines[0].trimEnd() !== '---') return { ok: false, lines, fmLines: [], bodyLines: lines, bodyStart: 1 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { end = i; break; }
  if (end < 0) return { ok: false, lines, fmLines: [], bodyLines: lines, bodyStart: 1 };
  return { ok: true, lines, fmLines: lines.slice(1, end), bodyLines: lines.slice(end + 1), bodyStart: end + 2 };
}

// Minimal frontmatter reader: top-level keys, nested one-level maps, lists, block scalars.
export function parseFrontmatter(fmLines) {
  const keys = new Map(); const errors = [];
  let cur = null;
  for (const raw of fmLines) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const kv = raw.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*)|\s*)$/);
    if (kv) {
      const key = kv[1]; const v = (kv[2] ?? '').trim();
      if (keys.has(key)) errors.push(`yaml-duplicate-key(${key})`);
      const err = plainScalarError(v);
      if (err) errors.push(`${err}(${key})`);
      const block = /^[>|][+-]?\d?$/.test(v);
      cur = { key, raw: v, block, children: [], value: block ? '' : (v === '' ? '' : unquote(v)) };
      keys.set(key, cur);
    } else if (/^[ \t]+\S/.test(raw) || (cur && /^-\s/.test(raw))) {
      if (cur) cur.children.push(raw);
    } else {
      errors.push('yaml-bad-line');
    }
  }
  for (const e of keys.values()) {
    e.multiline = e.block || (e.raw !== '' && e.children.length > 0 && !/^[\[{]/.test(e.raw));
    if (e.block) e.value = e.children.map((c) => c.trim()).join(' ').trim();
    else if (e.raw !== '' && e.children.length) e.value = (e.value + ' ' + e.children.map((c) => c.trim()).join(' ')).trim();
  }
  return { keys, errors };
}

export function nestedMap(entry) {
  const out = new Map();
  if (!entry || entry.raw !== '') return out;
  const indents = entry.children.filter((c) => /^\s+[A-Za-z0-9_.-]+:/.test(c)).map((c) => c.match(/^\s*/)[0].length);
  if (!indents.length) return out;
  const min = Math.min(...indents);
  for (const c of entry.children) {
    const m = c.match(/^(\s+)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (m && m[1].length === min) out.set(m[2], unquote(m[3]));
  }
  return out;
}

export function toolList(entry) {
  if (!entry) return [];
  if (entry.raw === '') return entry.children.map((c) => c.trim().replace(/^-\s*/, '')).map(unquote).filter(Boolean);
  const v = entry.raw.replace(/^\[/, '').replace(/\]\s*$/, '');
  return splitTools(unquote(v) === v ? v : unquote(v));
}

export function parseBool(v) {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  if (BOOL_TRUE.test(s)) return true;
  if (BOOL_FALSE.test(s)) return false;
  return null; // present but invalid
}

// ---------------------------------------------------------------- skills

// Build the object every rule reads. `dir` is the skill directory (links already followed).
export function loadSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  const src = fs.readFileSync(file, 'utf8');
  const parts = splitFile(src);
  const fm = parts.ok ? parseFrontmatter(parts.fmLines) : { keys: new Map(), errors: [] };
  const get = (k) => fm.keys.get(k);
  const val = (k) => (get(k) ? get(k).value : undefined);
  const dirName = path.basename(dir);
  const name = val('name') ?? dirName;
  const desc = val('description') ?? '';
  const when = val('when_to_use') ?? '';
  const dmi = parseBool(val('disable-model-invocation'));
  return {
    dir, dirName, file, src, parts, fm, get, val, name, desc, when,
    modelVisible: dmi !== true,
    hash: simpleHash(src),
    body: bodyInfo(parts),
  };
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// One pass over the body: fence state and "Old patterns" section state per line.
function bodyInfo(parts) {
  const out = []; let fence = null; let oldLevel = 0;
  parts.bodyLines.forEach((text, i) => {
    const n = parts.bodyStart + i;
    const f = text.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/);
    if (f) {
      out.push({ n, text, fence: fence ? fence.lang : f[2], isFence: true, old: oldLevel > 0 });
      fence = fence ? null : { lang: f[2] };
      return;
    }
    if (!fence) {
      const h = text.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        if (oldLevel && h[1].length <= oldLevel) oldLevel = 0;
        if (/old patterns/i.test(h[2])) oldLevel = h[1].length;
      }
    }
    out.push({ n, text, fence: fence ? fence.lang : null, isFence: false, old: oldLevel > 0 });
  });
  return out;
}

// ----------------------------------------------------------------- rules
// Each check returns [{rule, line?, msg}]. `ctx` carries repo facts (see audit-skills.mjs).

const f = (rule, msg, line, warn) => ({ rule, msg, ...(line ? { line } : {}), ...(warn ? { warn: true } : {}) });

export function stripQuoted(s) {
  return s
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/(^|[\s(\[])'[^']*'(?=[\s).,;:\]]|$)/g, '$1 ');
}

// First or second person. "I" counts only as a pronoun ("I do", "I'm"); I/O and roman numerals
// such as "Phase I" do not.
const ROMAN_LABEL_RE = /\b(?:Phase|Part|Type|Step|Level|Tier|Class|Stage|Appendix|Section|Chapter|Vitamin)\s+I+V?\b/g;
export function firstPerson(text) {
  const t = text.replace(ROMAN_LABEL_RE, ' ');
  return /\bI(?=\s+[a-z])|\bI'(?:m|ve|ll|d)\b/.test(t) || /\b(?:my|you|your)\b/i.test(t);
}

export function descriptionPhrases(desc) {
  const out = [];
  for (const m of desc.matchAll(/"([^"]{2,80})"|(?:^|[\s(])'([^']{2,80})'(?=[\s).,;:]|$)/g)) {
    const p = (m[1] ?? m[2]).trim().toLowerCase().replace(/^\/+/, '').replace(/\s+/g, ' ');
    if (p) out.push(p);
  }
  return out;
}

export function checkFrontmatter(s, ctx) {
  const r = [];
  if (!s.parts.ok) { r.push(f('G01', 'no frontmatter: line 1 must be --- and a closing --- must follow', 1)); return r; }
  for (const e of s.fm.errors) r.push(f('G02', e));
  for (const k of s.fm.keys.keys()) if (!KNOWN_KEYS.has(k) && !(KEY_ALLOW[s.dirName] || []).includes(k)) r.push(f('G03', `unknown frontmatter key "${k}"`));

  const meta = nestedMap(s.get('metadata'));
  for (const k of meta.keys()) {
    const norm = k.replace(/_/g, '-');
    if (norm !== 'metadata' && KNOWN_KEYS.has(norm)) r.push(f('G04', `metadata.${k} shadows frontmatter key ${norm}; Claude Code ignores it`));
  }

  const nameVal = s.val('name');
  for (const [label, n] of [['dir', s.dirName], ['name', nameVal]]) {
    if (n === undefined) continue;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n)) r.push(f('G05', `${label} "${n}" is not lowercase-hyphen`));
    if (n.length > 64) r.push(f('G05', `${label} "${n}" is longer than 64`));
    if (/anthropic|claude/.test(n)) r.push(f('G05', `${label} "${n}" contains a reserved word`));
  }
  if (nameVal !== undefined && nameVal !== s.dirName) r.push(f('G05', `name "${nameVal}" differs from dir "${s.dirName}"`));

  for (const n of new Set([s.dirName, s.name])) {
    if (RESERVED_ALLOW[n]) continue;
    if (RESERVED_NAMES.has(n) || n.startsWith('anthropic-skills')) r.push(f('G06', `"${n}" is a reserved or bundled name`));
  }

  const d = s.desc;
  const dEntry = s.get('description');
  if (!d.trim()) r.push(f('G08', 'description is empty'));
  if (d.length > 1024) r.push(f('G08', `description is ${d.length} chars (max 1024)`));
  const cap = ctx.maxDescChars;
  if ((d + s.when).length > cap) r.push(f('G08', `description + when_to_use is ${(d + s.when).length} chars (cap ${cap})`));
  if (d.length > 400) r.push(f('G09', `description is ${d.length} chars (ratchet 400)`));
  if (dEntry && dEntry.multiline) r.push(f('G10', 'description is a block scalar or spans lines'));
  if (/<[A-Za-z/][^>]*>/.test(d)) r.push(f('G11', 'description contains an XML-like tag'));
  const plain = stripQuoted(d);
  if (firstPerson(plain)) r.push(f('G12', 'description is not third person'));
  if (/^\s*use when\b/i.test(d)) r.push(f('G13', 'description starts with "Use when" and never says what the skill does'));
  if (s.modelVisible && !TRIGGER_RE.test(d)) r.push(f('G14', 'description has no "Use when ..." trigger'));

  r.push(...checkInvocation(s, ctx));
  r.push(...checkTools(s));
  return r;
}

function checkInvocation(s, ctx) {
  const r = [];
  const b = {};
  for (const k of ['disable-model-invocation', 'user-invocable', 'background']) {
    const v = s.val(k);
    if (v === undefined) continue;
    b[k] = parseBool(v);
    if (b[k] === null) r.push(f('G16', `${k}: "${v}" is not a boolean (true/false/yes/no/on/off/1/0)`));
  }
  if (b['disable-model-invocation'] === true && b['user-invocable'] === false) r.push(f('G16', 'disable-model-invocation: true with user-invocable: false makes the skill unreachable'));

  const context = s.val('context'); const agent = s.val('agent');
  if (context !== undefined && context !== 'fork') r.push(f('G17', `context: "${context}" must be fork`));
  if ((agent !== undefined || s.val('background') !== undefined) && context !== 'fork') r.push(f('G17', 'agent or background set without context: fork'));
  if (agent !== undefined) {
    if (agent === 'Explore') r.push(f('G17', 'agent: Explore is retired, use scout'));
    else if (!BUILTIN_AGENTS.has(agent) && !ctx.agentNames.has(agent)) r.push(f('G17', `agent "${agent}" is neither built in nor in .claude/agents`));
  }

  const model = s.val('model'); const effort = s.val('effort');
  if (model !== undefined && /haiku/i.test(model)) r.push(f('G18', `model "${model}" is Haiku (never)`));
  if (effort !== undefined && !EFFORT_VALUES.has(effort.toLowerCase())) r.push(f('G18', `effort "${effort}" is not low|medium|high|xhigh|max`));
  if (model !== undefined && /sonnet/i.test(model) && effort !== undefined && effort.toLowerCase() !== 'high') r.push(f('G18', 'Sonnet must run at effort high'));
  return r;
}

function checkTools(s) {
  const r = [];
  for (const t of toolList(s.get('allowed-tools'))) {
    if (/^(Bash|PowerShell|Write|Edit)$/.test(t)) r.push(f('G19', `bare ${t} grant; use ${t}(pattern)`));
    if (/^mcp__claude-in-chrome__/.test(t)) r.push(f('G19', `${t} is a retired tool`));
  }
  return r;
}

export function checkBody(s, ctx) {
  const r = [];
  const body = s.body;
  const nonEmpty = s.parts.bodyLines.length && s.parts.bodyLines[s.parts.bodyLines.length - 1] === '' ? s.parts.bodyLines.length - 1 : s.parts.bodyLines.length;
  if (nonEmpty > 500) r.push(f('G20', `body is ${nonEmpty} lines (max 500)`));
  const declaresArgs = s.get('arguments') || s.get('argument-hint');

  for (const l of body) {
    if (!declaresArgs && /(^|[^\\])\$[0-9]/.test(l.text)) r.push(f('G21', `unescaped $<digit> (Claude Code argument substitution): ${l.text.trim().slice(0, 60)}`, l.n));
    if (!l.old) {
      if (!SHELL_FENCE_RE.test(l.fence || '') && (/(?<!\w)[A-Za-z]:\\/.test(l.text) || /\w\\\w+\.\w+/.test(l.text))) r.push(f('G25', `Windows path: ${l.text.trim().slice(0, 60)}`, l.n));
      if (DATE_ISO_RE.test(l.text) || DATE_REL_RE.test(l.text)) r.push(f('G26', `dated text: ${l.text.trim().slice(0, 60)}`, l.n));
    }
  }
  r.push(...checkRetired(s));
  r.push(...checkMcp(s, ctx));
  return r;
}

function checkRetired(s) {
  const r = [];
  const all = s.parts.lines;
  const oldLines = new Set(s.body.filter((l) => l.old).map((l) => l.n));
  all.forEach((text, i) => {
    const n = i + 1;
    if (oldLines.has(n) || !RETIRED_RE.test(text) || RETIRED_CONTEXT_RE.test(text)) return;
    r.push(f('G27', `retired name "${text.match(RETIRED_RE)[0]}": ${text.trim().slice(0, 60)}`, n));
  });
  return r;
}

function checkMcp(s, ctx) {
  const r = [];
  const seen = new Set();
  for (const m of s.src.matchAll(/mcp__([A-Za-z0-9_.-]+?)__/g)) {
    const server = m[1];
    if (seen.has(server)) continue;
    seen.add(server);
    if (/^(claude_ai_|plugin_)/.test(server)) continue;
    if (!ctx.mcpServers.has(server)) r.push(f('G28', `mcp__${server}__ names a server absent from settings.json.template and .mcp.json`));
  }
  for (const server of ctx.mcpServers) {
    // No `g` flag: a global RegExp keeps lastIndex between .test() calls and skips the next line.
    const re = new RegExp(`(?<![\\w_/-])${server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[a-z][a-z0-9_-]+`);
    for (const l of s.body) if (!l.isFence && re.test(l.text) && !/https?:\/\//.test(l.text)) r.push(f('G28', `bare "${server}:tool" form; use mcp__${server}__tool`, l.n));
  }
  return r;
}

// ------------------------------------------------------------- references

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const TICK_RE = /`([^`\n]+)`/g;
const PATHISH_RE = /^[\w.@~$-][\w@./\\${}~-]*$/;
const EXT_RE = /\.(md|mjs|js|ts|tsx|py|sh|ps1|json|yaml|yml|html|css|txt|sql|toml|cjs)$/i;

function candidateRefs(text) {
  const out = [];
  // A link inside an inline code span is an example, not a reference.
  for (const m of text.replace(/`[^`\n]*`/g, ' ').matchAll(LINK_RE)) out.push({ raw: m[1], kind: 'link' });
  for (const m of text.matchAll(TICK_RE)) out.push({ raw: m[1], kind: 'tick' });
  return out;
}

const LOCAL_ROOTS = new Set(['references', 'reference', 'assets', 'scripts', 'templates', 'examples', 'resources']);

// A markdown link is always a reference. A backticked path is one only when it starts inside the
// skill's own folders (references/, scripts/, ...) or with ./ ../ ; other backticked paths name
// files in the user's project or runtime output, which no static check can resolve.
function normaliseRef(c, skillDir) {
  let p = c.raw.trim().replace(/^@/, '');
  if (/^(https?:|mailto:|#|data:)/i.test(p)) return null;
  p = p.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir.replace(/\\/g, '/'));
  p = p.split('#')[0].replace(/:\d+(-\d+)?$/, '');
  if (!p || /[<>{}*\[\]$|]/.test(p) || /\s/.test(p)) return null;
  if (c.kind === 'link' && !/[./]/.test(p)) return null; // a bare word such as (url) is a placeholder
  if (c.kind === 'tick' && !(p.includes('/') && EXT_RE.test(p))) return null;
  if (c.kind === 'tick' && !/^\.\.?\//.test(p) && !LOCAL_ROOTS.has(p.split('/')[0]) && !localDirs(skillDir).has(p.split('/')[0])) return null;
  if (c.kind === 'tick' && !PATHISH_RE.test(p)) return null;
  if (/^[A-Za-z]+\.[A-Za-z]+$/.test(p) && c.kind === 'tick') return null; // bare "foo.bar" token, not a path
  return p;
}

function localDirs(skillDir) {
  try { return new Set(fs.readdirSync(skillDir).filter((n) => isDirSafe(path.join(skillDir, n)))); } catch { return new Set(); }
}
function isDirSafe(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function resolveRef(p, skillDir, ctx) {
  if (p.startsWith('~/')) return [path.join(ctx.home, p.slice(2))];
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return [p];
  // Order matters: ~/.claude comes last, so a hit there means the repo does not own the file.
  const roots = [ctx.repoRoot, ctx.fallbackRoot].filter(Boolean);
  return [path.join(skillDir, p), ...roots.flatMap((r) => [path.join(r, p), path.join(r, '.claude', p)]), path.join(ctx.home, '.claude', p)];
}

export const REF_ALLOW = {
  // skill -> substrings of refs the skill creates or that are runtime output (reason in comment)
  'init-project': ['scripts/dev-start.mjs', 'scripts/dev-cleanup.mjs'], // files it writes into the target project
  workroom: ['templates/message.md'], // lives at .workroom/templates/message.md in the user's tree
  reporting: ['sweep.jsonl'], // runtime output
  impeccable: ['scripts/build-sub-pages.js'], // example script in the user's project
  'skill-forge': ['scripts/helper.py'], // example name in the authoring guide
  'scroll-craft': ['references/colors.md'], // lives in the fourth-brand-guidelines skill
};

export function mdFiles(dir, depth = 0) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory() && depth < 4) out.push(...mdFiles(p, depth + 1));
    else if (st.isFile() && /\.md$/i.test(e.name) && !(depth === 0 && e.name === 'SKILL.md')) out.push(p);
  }
  return out;
}

export function checkRefs(s, ctx) {
  const r = [];
  const allow = REF_ALLOW[s.dirName] || [];
  const skillMd = s.src.replace(/\r\n/g, '\n');
  const direct = new Set();
  const inside = (p) => { const rel = path.relative(s.dir, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

  const sources = [{ file: s.file, text: skillMd, isSkill: true }];
  const refs = mdFiles(s.dir);
  for (const rf of refs) sources.push({ file: rf, text: safeRead(rf), isSkill: false });

  for (const src of sources) {
    const base = path.dirname(src.file);
    const lines = src.text.split('\n');
    let fenced = false;
    lines.forEach((line, i) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) { fenced = !fenced; return; }
      if (fenced && !src.isSkill) return;
      for (const c of candidateRefs(line)) {
        const p = normaliseRef(c, s.dir);
        if (!p) continue;
        const cands = resolveRef(p, base, ctx);
        if (!src.isSkill) cands.push(...resolveRef(p, s.dir, ctx).slice(0, 1));
        const hit = cands.find((x) => fs.existsSync(x));
        if (src.isSkill && hit && /\.md$/i.test(hit) && inside(hit)) direct.add(path.resolve(hit));
        // Found only under ~/.claude: it passes, but the repo does not own the file (sync gap).
        if (hit && !p.startsWith('~/') && !path.isAbsolute(p) && hit.startsWith(path.join(ctx.home, '.claude') + path.sep) && !fenced) r.push(f('G22', `reference ${p} resolves only under ~/.claude, not in the repo`, i + 1, true));
        if (!hit && !allow.some((a) => p.includes(a)) && !fenced) r.push(f('G22', `unresolved reference ${p} in ${path.relative(s.dir, src.file) || 'SKILL.md'}`, i + 1));
        if (!src.isSkill && hit && /\.md$/i.test(hit) && inside(hit)) src.links = [...(src.links || []), path.resolve(hit)];
      }
    });
  }
  for (const src of sources) {
    if (src.isSkill) continue;
    for (const t of new Set(src.links || [])) {
      if (t !== path.resolve(src.file) && !direct.has(t)) r.push(f('G23', `${path.relative(s.dir, src.file)} links ${path.relative(s.dir, t)}, which SKILL.md does not link directly`));
    }
    const lines = src.text.split('\n');
    if (lines.length > 100) {
      const head = lines.slice(0, 30);
      const heading = head.some((l) => /^\W*(table of )?contents\b/i.test(l.trim()) || /^#{1,6}\s*(table of contents|contents|toc)\b/i.test(l));
      const anchors = head.filter((l) => /\]\(#/.test(l)).length >= 3;
      if (!heading && !anchors) r.push(f('G24', `${path.relative(s.dir, src.file)} has ${lines.length} lines and no table of contents`));
    }
  }
  return r;
}

function safeRead(p) { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }

export function checkSkillAll(s, ctx) {
  return [...checkFrontmatter(s, ctx), ...checkBody(s, ctx), ...checkRefs(s, ctx)];
}
