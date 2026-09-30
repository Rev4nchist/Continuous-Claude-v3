#!/usr/bin/env node
/**
 * check-agent-body.mjs — ratchet on agent bodies that contradict their own frontmatter.
 *
 * For each `.claude/agents/*.md` it counts three things:
 *   toolConflicts  agents whose body tells them to run a shell command (a fenced bash/sh/powershell
 *                  block, or a line "Run `cmd`") or to write a file, while `tools:` lacks the tool.
 *                  An agent with no `tools:` field inherits every tool and is skipped.
 *   rpCli          agents that mention `rp-cli` (not installed on this machine).
 *   deadScripts    agents that point at a `scripts/....py` path, or at `runtime.harness`, that does
 *                  not exist under the repo or the opc dir ($CLAUDE_OPC_DIR, else <repo>/opc).
 *
 * Baseline: scripts/agents/agent-body-baseline.json (beside this script). `--update-baseline`
 * writes it. A default run exits 1 when any count is HIGHER than baseline, exit 0 otherwise.
 * Lower the baseline after a cleanup; raising it is a reviewed edit.
 *
 * Usage: node scripts/agents/check-agent-body.mjs [repoRoot] [--update-baseline] [--json]
 * repoRoot only changes which `.claude/agents` dir is read. Paths still also resolve against the
 * real repo, so a fixture dir that holds only agents does not report every script as dead.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const realRepo = resolve(here, '..', '..');
const BASELINE_PATH = join(here, 'agent-body-baseline.json');

const SHELL_TOOLS = ['Bash', 'PowerShell'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', ...SHELL_TOOLS];
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat']);

/** Split a file into { frontmatter, body }. CRLF is normalised first. */
export function splitFrontmatter(text) {
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith('---')) return { frontmatter: '', body: t };
  const end = t.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: t };
  const after = t.indexOf('\n', end + 1);
  return { frontmatter: t.slice(3, end), body: after === -1 ? '' : t.slice(after + 1) };
}

function unquote(v) {
  const s = v.trim();
  const q = s.match(/^(["'])(.*?)\1/);
  if (q) return q[2].trim();
  return s.replace(/\s+#.*$/, '').trim();
}

/** Returns an array of tool names, or null when `tools:` is absent (the agent inherits all). */
export function parseTools(text) {
  const { frontmatter } = splitFrontmatter(text);
  const lines = frontmatter.split('\n');
  const i = lines.findIndex((l) => /^tools:/.test(l));
  if (i === -1) return null;
  let rest = lines[i].replace(/^tools:/, '').replace(/\s+#.*$/, '').trim();
  if (rest) {
    // An explicit list, even an empty one (`tools: []`), grants only what it names: never null.
    if (rest.startsWith('[')) rest = rest.replace(/^\[/, '').replace(/\].*$/, '');
    else rest = unquote(rest); // `tools: "Read, Bash"` is one quoted scalar: unquote it before splitting
    return rest.split(',').map(unquote).filter(Boolean);
  }
  const tools = [];
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^\s+-\s*(.*)$/);
    if (m) { const t = unquote(m[1]); if (t) tools.push(t); continue; }
    if (/^\s*(#.*)?$/.test(l)) continue;
    break;
  }
  return tools.length ? tools : null;
}

/** Walk the body and split it into fenced blocks and prose lines. */
export function scanBody(body) {
  const blocks = [];
  const prose = [];
  const lines = body.split('\n');
  let open = null;
  lines.forEach((line, idx) => {
    const f = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)/);
    if (open) {
      const closes = f && f[1][0] === open.ch && f[1].length >= open.len && !f[2];
      if (closes) { blocks.push(open); open = null; } else open.lines.push(line);
      return;
    }
    if (f) { open = { ch: f[1][0], len: f[1].length, lang: f[2].toLowerCase(), lines: [], line: idx + 1, before: prevText(lines, idx) }; return; }
    prose.push({ text: line, line: idx + 1 });
  });
  if (open) blocks.push(open);
  return { blocks, prose };
}

function prevText(lines, idx) {
  for (let i = idx - 1; i >= 0; i--) if (lines[i].trim()) return lines[i];
  return '';
}

const OUTPUT_LEAD = /\b(?:example|sample|expected|typical)\s+output\b|\boutput\s+(?:looks?|example|format|will|should)\b|\bwill\s+(?:print|show|output|look)\b|\bout(?:put)?\s*:\s*\**$/i;

/** True when a shell-language fence only illustrates output or holds only comments. */
export function isIllustrativeBlock(block) {
  const content = block.lines.filter((l) => l.trim());
  if (content.length === 0) return true;
  if (content.every((l) => /^\s*#/.test(l))) return true;
  return OUTPUT_LEAD.test(block.before);
}

const RUN_RE = /^\s*(?:\d+\.\s+|[-*]\s+)?\**(?:Run|Execute)\**\s+`[^`]+`/i;
const NEG_RE = /\b(?:do not|don't|never|cannot|can't|must not|not allowed|read-only)\b/i;
const WRITE_RE = /\b(?:write|create|save)\b[^.\n]{0,60}?(?:\bfiles?\b|\bto\s+[`$.\w/~{<]|\bat\s+[`$.\w/~{<]|`[^`\n]*\.\w{1,5}`)/i;

/** Which tool families the body needs, with the first evidence line for each. */
export function bodyNeeds(body) {
  const { blocks, prose } = scanBody(body);
  const needs = {};
  const shell = blocks.find((b) => SHELL_LANGS.has(b.lang) && !isIllustrativeBlock(b));
  if (shell) needs.shell = `line ${shell.line}: fenced ${shell.lang} block`;
  const runLine = prose.find((p) => RUN_RE.test(p.text) && !NEG_RE.test(p.text));
  if (runLine && !needs.shell) needs.shell = `line ${runLine.line}: ${runLine.text.trim().slice(0, 60)}`;
  const writeLine = prose.find((p) => WRITE_RE.test(p.text) && !NEG_RE.test(p.text));
  if (writeLine) needs.write = `line ${writeLine.line}: ${writeLine.text.trim().slice(0, 60)}`;
  else if (shell) needs.writeViaShell = true;
  return needs;
}

/** Tool conflicts for one agent: list of { need, evidence }. Empty when tools is absent. */
export function toolConflicts(text) {
  const tools = parseTools(text);
  if (tools === null) return [];
  const has = (set) => set.some((t) => tools.includes(t));
  const needs = bodyNeeds(splitFrontmatter(text).body);
  const out = [];
  if (needs.shell && !has(SHELL_TOOLS)) out.push({ need: 'Bash', evidence: needs.shell });
  if (needs.write && !has(WRITE_TOOLS)) out.push({ need: 'Write', evidence: needs.write });
  return out;
}

export function mentionsRpCli(text) {
  return /\brp-cli\b/.test(splitFrontmatter(text).body);
}

const SCRIPT_RE = /[\w.~$\-{}/]*\bscripts\/[\w\-/.]+\.py\b/g;

/** Candidate roots: the given repo, the real repo, and each opc dir. */
export function resolveRoots(repoRoot, env = process.env) {
  const roots = [repoRoot, realRepo];
  if (env.CLAUDE_OPC_DIR) roots.push(env.CLAUDE_OPC_DIR);
  roots.push(join(repoRoot, 'opc'), join(realRepo, 'opc'));
  return [...new Set(roots.map((r) => resolve(r)))];
}

/** Dead references: `scripts/x.py` paths and `runtime.harness` that resolve under no root. */
export function deadScripts(text, roots, exists = existsSync) {
  const body = splitFrontmatter(text).body;
  const dead = new Set();
  for (const raw of body.match(SCRIPT_RE) ?? []) {
    const unvar = raw.replace(/^\$(?:\{\w+\}|\w+)\//, ''); // a leading $CLAUDE_OPC_DIR/ style prefix is fine
    if (/[{}$]/.test(unvar)) continue; // any other placeholder cannot be resolved
    const rel = raw.slice(raw.indexOf('scripts/'));
    const prefixed = unvar.replace(/^~\/\.claude\//, '');
    if (![rel, prefixed].some((p) => roots.some((r) => exists(join(r, p))))) dead.add(rel);
  }
  if (/\bruntime\.harness\b/.test(body)) {
    const ok = roots.some((r) => ['runtime/harness.py', 'src/runtime/harness.py'].some((p) => exists(join(r, p))));
    if (!ok) dead.add('runtime.harness');
  }
  return [...dead].sort();
}

/** Analyse every agent in `agentsDir`. Returns { counts, agents }. */
export function analyse(agentsDir, roots) {
  const agents = {};
  const counts = { toolConflicts: 0, rpCli: 0, deadScripts: 0 };
  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort();
  for (const f of files) {
    const text = readFileSync(join(agentsDir, f), 'utf8');
    const conflicts = toolConflicts(text);
    const rpCli = mentionsRpCli(text);
    const dead = deadScripts(text, roots);
    if (conflicts.length) counts.toolConflicts++;
    if (rpCli) counts.rpCli++;
    if (dead.length) counts.deadScripts++;
    if (conflicts.length || rpCli || dead.length) {
      agents[f.slice(0, -3)] = { toolConflicts: conflicts, rpCli, deadScripts: dead };
    }
  }
  return { agents: files.length, counts, offenders: agents };
}

/** Ratchet verdict: the keys whose count is higher than baseline. */
export function regressions(counts, baselineCounts) {
  return Object.keys(counts).filter((k) => counts[k] > (baselineCounts?.[k] ?? 0));
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = resolve(args.find((a) => !a.startsWith('--')) || realRepo);
  const agentsDir = join(repoRoot, '.claude', 'agents');
  const result = analyse(agentsDir, resolveRoots(repoRoot));
  const { counts } = result;

  if (args.includes('--update-baseline')) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ counts, offenders: result.offenders }, null, 2) + '\n');
    console.log(`baseline written: agents=${result.agents} toolConflicts=${counts.toolConflicts} rpCli=${counts.rpCli} deadScripts=${counts.deadScripts}`);
    return;
  }

  let baseline;
  try { baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); }
  catch { console.error(`no baseline at ${BASELINE_PATH}; run with --update-baseline`); process.exit(1); }
  const b = baseline.counts;
  const worse = regressions(counts, b);
  const verdict = worse.length ? `FAIL (${worse.join(', ')} got worse)` : 'OK';
  console.log(`agents=${result.agents} toolConflicts=${counts.toolConflicts} rpCli=${counts.rpCli} deadScripts=${counts.deadScripts} (baseline ${b.toolConflicts}/${b.rpCli}/${b.deadScripts}) ${verdict}`);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  if (worse.length) {
    for (const [name, o] of Object.entries(result.offenders)) {
      const was = baseline.offenders?.[name];
      if (o.toolConflicts.length && !was?.toolConflicts?.length) for (const c of o.toolConflicts) console.log(`  NEW ${name}: body needs ${c.need} but tools lacks it (${c.evidence})`);
      if (o.rpCli && !was?.rpCli) console.log(`  NEW ${name}: mentions rp-cli`);
      if (o.deadScripts.length && !was?.deadScripts?.length) console.log(`  NEW ${name}: dead script ref ${o.deadScripts.join(', ')}`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
