// hooks-to-execform.mjs — convert Claude Code settings.json hooks from SHELL form
// ("command":"node x.mjs") to EXEC form ("command":"node","args":["x.mjs"]) so hooks
// spawn the executable DIRECTLY instead of via git-bash — killing the msys2 fork storm.
//
// Usage (node):
//   node hooks-to-execform.mjs                 # dry-run, ALL events, USER settings
//   node hooks-to-execform.mjs --settings <path>      # target a specific settings.json
//   node hooks-to-execform.mjs --event SessionStart   # dry-run, one event
//   node hooks-to-execform.mjs --event SessionStart --apply   # write (backs up first)
//   node hooks-to-execform.mjs --restore <backup-path>        # revert
//
// Safe by construction: backs up before writing; only touches type:command hooks that
// are still shell-form (no existing args); preserves type/timeout/other fields; expands
// a leading ~/ to the home dir (exec form has no shell to expand it). Quote-aware
// tokenization — respects double-quoted segments (e.g. a "${CLAUDE_PROJECT_DIR}/..."
// path) and strips the surrounding quotes so the exec-form arg is a clean path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const settingsIdx = argv.indexOf('--settings');
const SETTINGS = settingsIdx !== -1 ? argv[settingsIdx + 1] : path.join(os.homedir(), '.claude', 'settings.json');
const apply = argv.includes('--apply');
const eventIdx = argv.indexOf('--event');
const onlyEvent = eventIdx !== -1 ? argv[eventIdx + 1] : null;
const restoreIdx = argv.indexOf('--restore');
const home = os.homedir().replace(/\\/g, '/');

if (restoreIdx !== -1) {
  const bak = argv[restoreIdx + 1];
  fs.copyFileSync(bak, SETTINGS);
  console.log(`restored ${SETTINGS} from ${bak}`);
  process.exit(0);
}

function expandTilde(tok) {
  if (tok === '~') return home;
  if (tok.startsWith('~/')) return home + tok.slice(1);
  return tok;
}

// Quote-aware tokenizer: splits on unquoted whitespace, keeps double-quoted
// segments intact, then strips the surrounding quotes. Handles both bare paths
// (node C:/x.mjs arg) and quoted paths (node "${CLAUDE_PROJECT_DIR}/x.mjs").
function tokenize(cmd) {
  const toks = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) toks.push(m[1] !== undefined ? m[1] : m[2]);
  return toks;
}

const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
let converted = 0;
const changes = [];
for (const ev of Object.keys(s.hooks || {})) {
  if (onlyEvent && ev !== onlyEvent) continue;
  for (const m of (s.hooks[ev] || [])) {
    for (const h of (m.hooks || [])) {
      if (h.type !== 'command' || Array.isArray(h.args) || typeof h.command !== 'string') continue;
      const toks = tokenize(h.command).map(expandTilde);
      const before = h.command;
      h.command = toks[0];
      h.args = toks.slice(1);
      converted += 1;
      if (changes.length < 40) changes.push({ ev, before, after: `${h.command} + ${JSON.stringify(h.args)}` });
    }
  }
}

console.log(`${apply ? 'APPLY' : 'DRY-RUN'} — event=${onlyEvent || 'ALL'} — ${converted} hook(s) converted`);
changes.forEach((c) => console.log(`  [${c.ev}] ${c.after}`));

if (apply && converted > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${SETTINGS}.bak.execform-${stamp}`;
  fs.copyFileSync(SETTINGS, bak);
  fs.writeFileSync(SETTINGS, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  console.log(`\nBACKUP: ${bak}`);
  console.log(`WROTE:  ${SETTINGS}`);
  console.log(`REVERT: node hooks-to-execform.mjs --restore "${bak}"`);
}
