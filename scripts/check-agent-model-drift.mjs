#!/usr/bin/env node
/**
 * check-agent-model-drift.mjs — durable invariant for the two-tier model policy.
 *
 * Treats each agent's `.md` frontmatter `model:` as CANONICAL and verifies:
 *   1. every agent .md has an EXPLICIT model in {opus, sonnet} — never omitted/inherit/haiku
 *   2. every agent (opus and sonnet) pins `effort: high` (Dave's rule: never medium, low or xhigh)
 *   3. every .json sidecar's `model` matches its `.md` twin
 *      (the .json `model` is read at spawn by opc/scripts/claude_spawn.py and is NOT
 *       auto-synced from the .md, so it can silently drift)
 *
 * Exit 0 = clean, exit 1 = drift found (prints the offenders). Windows-safe, zero deps.
 * Usage: node scripts/check-agent-model-drift.mjs [repoRoot]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALLOWED = new Set(['opus', 'sonnet']);

export function frontmatterModel(mdText) {
  // frontmatter must start at byte 0 with ---
  if (!mdText.startsWith('---')) return { model: undefined, reason: 'no-frontmatter' };
  const end = mdText.indexOf('\n---', 3);
  if (end === -1) return { model: undefined, reason: 'unterminated-frontmatter' };
  const block = mdText.slice(3, end);
  const model = scalar(block, 'model');
  if (model === undefined) return { model: undefined, reason: 'no-model-field' };
  return { model, effort: scalar(block, 'effort') };
}

// One-line YAML scalar without a YAML dependency: drops a trailing `# comment` and one pair of
// matching quotes, so `effort: "high"` and `effort: high  # why` both read as `high`.
function scalar(block, key) {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return undefined;
  const v = m[1].trim();
  const q = v.match(/^(["'])(.*?)\1/);
  if (q) return q[2].trim();
  return v.replace(/\s+#.*$/, '').trim();
}

function main() {
const repoRoot = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(repoRoot, '.claude', 'agents');
if (!existsSync(agentsDir)) {
  console.error(`FAIL: agents dir not found: ${agentsDir}`);
  process.exit(1);
}
const errors = [];
let mdCount = 0, opus = 0, sonnet = 0;
const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));

for (const md of files) {
  const name = md.slice(0, -3);
  mdCount++;
  const { model, effort, reason } = frontmatterModel(readFileSync(join(agentsDir, md), 'utf8'));
  if (model === undefined) { errors.push(`${name}.md: missing explicit model (${reason})`); continue; }
  if (model === 'haiku') { errors.push(`${name}.md: model=haiku is banned`); continue; }
  if (model === 'inherit') { errors.push(`${name}.md: model=inherit resolves to session model (Opus-on-everything) — pin a tier`); continue; }
  if (!ALLOWED.has(model)) { errors.push(`${name}.md: model="${model}" not in {opus, sonnet}`); continue; }
  if (model === 'opus') opus++; else sonnet++;
  // Dave's rules (2026-09-30): Sonnet and Opus agents always run at effort high. Without the pin an
  // agent copies the spawning session's effort (probe: .claude/cache/e2e/2026-09-30-effort-probe.md).
  if (effort !== 'high') errors.push(`${name}.md: model=${model} needs "effort: high" (found ${effort ?? 'none'})`);

  // .json sidecar parity (only the legacy CMA-mirror agents have one — check whichever exist)
  const jsonPath = join(agentsDir, `${name}.json`);
  let jsonText;
  try { jsonText = readFileSync(jsonPath, 'utf8'); } catch { continue; } // no sidecar → nothing to check
  let jsonModel;
  try { jsonModel = JSON.parse(jsonText).model; } catch (e) { errors.push(`${name}.json: unparseable (${e.message})`); continue; }
  if (jsonModel !== model) errors.push(`${name}: .md=${model} but .json=${jsonModel} — sidecar drift (read at spawn by claude_spawn.py)`);
}

console.log(`agents: ${mdCount}  |  opus: ${opus}  sonnet: ${sonnet}`);
// A gate that compared nothing must not pass: 0 agents means a wrong path, not a clean repo.
if (mdCount === 0) errors.push(`0 agents found in ${agentsDir} (vacuous gate)`);
if (errors.length) {
  console.error(`\nMODEL DRIFT — ${errors.length} issue(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('OK — every agent explicit, no haiku/inherit, all .json sidecars in parity.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
