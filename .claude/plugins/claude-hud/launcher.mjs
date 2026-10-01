#!/usr/bin/env node
// claude-hud launcher — resolves latest installed version at runtime
// so statusLine survives plugin updates without re-running setup.
// Includes Harry Potter spell name mapping for tool verbs.
import { readdirSync } from 'node:fs';
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
  'mcp__nia':      'Accio Doctrina',
  'mcp__playwright': 'Locomotor',
};

function applySpells(output) {
  let result = output;
  for (const [tool, spell] of Object.entries(SPELL_MAP)) {
    result = result.replaceAll(tool, spell);
  }
  return result;
}

// ============================================================
// Original launcher logic
// ============================================================
const pluginDir = join(homedir(), '.claude', 'plugins', 'cache', 'claude-hud', 'claude-hud');

// Find latest version by sorting dotted numeric dirs
const versions = readdirSync(pluginDir, { withFileTypes: true })
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

// Capture stdout from HUD, apply spell mapping, then output
try {
  const output = execFileSync(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    stdio: ['inherit', 'pipe', 'inherit'],
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
