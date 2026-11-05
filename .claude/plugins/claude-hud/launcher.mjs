#!/usr/bin/env node
// claude-hud launcher — resolves latest installed version at runtime
// so statusLine survives plugin updates without re-running setup.
// Includes Harry Potter spell name mapping for tool verbs.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

// ============================================================
// Spell Map: tool names -> Harry Potter incantations
// ============================================================
const SPELL_MAP = {
  // Reading / Searching
  'Read':       'Accio',
  'Grep':       'Revelio',
  'Glob':       'Homenum Revelio',
  'WebSearch':  'Specialis Revelio',
  'WebFetch':   'Accio Pagina',

  // Writing / Editing
  'Edit':       'Diffindo',
  'Write':      'Scribblifors',
  'NotebookEdit': 'Aparecium',

  // Execution
  'Bash':       'Incendio',
  'TaskCreate': 'Protego Totalum',
  'TaskUpdate': 'Finite Incantatem',

  // Agents
  'Agent':      'Expecto Patronum',
  'Skill':      'Lumos Maxima',

  // Navigation / Planning
  'EnterPlanMode': 'Pensieve',
  'ExitPlanMode':  'Obliviate',

  // MCP tools (abbreviated)
  'mcp__serena':   'Legilimens',
  'mcp__github':   'Portus',
  'mcp__playwright': 'Locomotor',
};

// One pass over whole tool names, longest first, so 'NotebookEdit' is not read as
// 'Notebook' + 'Edit' and words inside other names stay as they are. An mcp__ key is a
// prefix: it also matches 'mcp__github__search_code'.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SPELL_RE = new RegExp(
  '(?<![\\w])(' +
    Object.keys(SPELL_MAP)
      .sort((a, b) => b.length - a.length)
      .map(k => escapeRe(k) + (k.startsWith('mcp__') ? '(?=__|(?![\\w]))' : '(?![\\w])'))
      .join('|') +
    ')',
  'g',
);

function applySpells(output) {
  return output.replace(SPELL_RE, tool => SPELL_MAP[tool] ?? tool);
}

// ============================================================
// Original launcher logic
// ============================================================
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const pluginDir = join(claudeDir, 'plugins', 'cache', 'claude-hud', 'claude-hud');

// Find latest version by sorting dotted numeric dirs. The cache dir is absent until
// Claude Code reinstalls the plugin (e.g. after ~/.claude/plugins was wiped).
let entries = [];
try {
  entries = readdirSync(pluginDir, { withFileTypes: true });
} catch {
  // fall through to "No installed version found"
}
const versions = entries
  .filter(d => d.isDirectory() && /^\d+(\.\d+)+$/.test(d.name))
  .map(d => d.name)
  .sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

if (versions.length === 0) {
  console.log('[claude-hud] No installed version found');
  process.exit(0);
}

const latest = versions[versions.length - 1];
const entrypoint = join(pluginDir, latest, 'dist', 'index.js');

// ============================================================
// Session identity: label "<name> #<sid8>" in the statusline
// ============================================================
// Read only. The identity file is written by the heartbeat and session-register hooks;
// this launcher takes the name from stdin.session_name and rewrites it as the label.
const NAME_CLIP = 16;
const SAFE_ID = /^[0-9a-fA-F-]{8,64}$/;

// Returns the stdin JSON text with session_name set to the label. Raw text on any error.
function labelStdin(raw) {
  try {
    const data = JSON.parse(raw);
    const uuid = data && data.session_id;
    if (typeof uuid !== 'string' || !SAFE_ID.test(uuid)) return raw;
    const name = typeof data.session_name === 'string'
      ? data.session_name.replace(/\s+/g, ' ').trim().slice(0, NAME_CLIP)
      : '';
    const sid8 = '#' + uuid.slice(0, 8);
    data.session_name = name ? name + ' ' + sid8 : sid8;
    return JSON.stringify(data);
  } catch {
    return raw;
  }
}

let stdinText = '';
try { stdinText = readFileSync(0, 'utf8'); } catch { /* no stdin: pass empty */ }
const hudInput = labelStdin(stdinText);

// Capture stdout from HUD, apply spell mapping, then output
try {
  const output = execFileSync(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    stdio: ['pipe', 'pipe', 'inherit'],
    input: hudInput,
    timeout: 5000,
    encoding: 'utf8',
  });
  if (output) {
    process.stdout.write(applySpells(output));
  }
} catch (err) {
  // If the process wrote to stdout before failing, capture and transform it
  if (err.stdout) {
    process.stdout.write(applySpells(err.stdout));
  }
  // Silent — statusLine should never crash visibly
}
