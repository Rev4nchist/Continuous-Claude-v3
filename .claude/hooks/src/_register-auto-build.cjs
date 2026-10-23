const fs = require('fs');
const p = '~/.claude/settings.json';
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
      command: 'node ~/.claude/hooks/dist/auto-build.mjs',
      timeout: 10000
    });
    console.log('Added auto-build to existing Write|Edit PostToolUse group');
  } else {
    hooks.push({
      matcher: 'Write|Edit',
      hooks: [{
        type: 'command',
        command: 'node ~/.claude/hooks/dist/auto-build.mjs',
        timeout: 10000
      }]
    });
    console.log('Created new Write|Edit PostToolUse group for auto-build');
  }
}

fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('Settings saved');
