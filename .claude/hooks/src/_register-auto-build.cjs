const fs = require('fs');
const os = require('os');
const path = require('path');
const home = os.homedir();
const p = path.join(home, '.claude', 'settings.json');
const hookCommand = 'node ' + path.join(home, '.claude', 'hooks', 'dist', 'auto-build.mjs').replace(/\\/g, '/');
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!d.hooks) d.hooks = {};
if (!d.hooks.PostToolUse) d.hooks.PostToolUse = [];
const hooks = d.hooks.PostToolUse;

// Check if already registered
let alreadyRegistered = false;
for (const group of hooks) {
  if (group.hooks) {
    for (const h of group.hooks) {
      if (h.command && h.command.includes('auto-build')) {
        alreadyRegistered = true;
        break;
      }
    }
  }
  if (alreadyRegistered) break;
}

if (!alreadyRegistered) {
  // Find existing Write|Edit matcher group in PostToolUse
  const writeEditIdx = hooks.findIndex(h => h.matcher === 'Write|Edit');
  if (writeEditIdx >= 0) {
    hooks[writeEditIdx].hooks.push({
      type: 'command',
      command: hookCommand,
      timeout: 10000
    });
    console.log('Added auto-build to existing Write|Edit PostToolUse group');
  } else {
    hooks.push({
      matcher: 'Write|Edit',
      hooks: [{
        type: 'command',
        command: hookCommand,
        timeout: 10000
      }]
    });
    console.log('Created new Write|Edit PostToolUse group for auto-build');
  }
}

fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('Settings saved');
