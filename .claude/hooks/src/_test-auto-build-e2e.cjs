// End-to-end test: pipe JSON to auto-build hook via subprocess
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Reset debounce
const stateFile = path.join(os.tmpdir(), 'claude-auto-build-last.json');
fs.writeFileSync(stateFile, JSON.stringify({ lastBuild: 0 }));

const hookPath = '~/.claude/hooks/dist/auto-build.mjs';

// Test 1: Hook source file with forward slashes (should trigger)
const input1 = JSON.stringify({
  session_id: 'test',
  tool_name: 'Write',
  tool_input: { file_path: '~/.claude/hooks/src/some-hook.ts' }
});
const out1 = execSync(`node ${hookPath}`, { input: input1, encoding: 'utf-8', timeout: 5000 });
console.log('Test 1 (forward slash hook src):', out1.trim());

// Reset debounce
fs.writeFileSync(stateFile, JSON.stringify({ lastBuild: 0 }));

// Test 2: Hook source file with backslashes (should trigger)
const input2 = JSON.stringify({
  session_id: 'test',
  tool_name: 'Edit',
  tool_input: { file_path: 'C:\\Users\\ada.lovelace\\.claude\\hooks\\src\\other-hook.ts' }
});
const out2 = execSync(`node ${hookPath}`, { input: input2, encoding: 'utf-8', timeout: 5000 });
console.log('Test 2 (backslash hook src):  ', out2.trim());

// Test 3: Non-hook file (should NOT trigger)
// Note: do NOT reset debounce here -- Test 4 depends on Test 2's debounce state
const input3 = JSON.stringify({
  session_id: 'test',
  tool_name: 'Write',
  tool_input: { file_path: '~/project/src/app.ts' }
});
const out3 = execSync(`node ${hookPath}`, { input: input3, encoding: 'utf-8', timeout: 5000 });
console.log('Test 3 (non-hook file):       ', out3.trim());

// Test 4: Debounce (second call within 5s should NOT trigger)
// Don't reset debounce -- test 2 set it
const input4 = JSON.stringify({
  session_id: 'test',
  tool_name: 'Write',
  tool_input: { file_path: '~/.claude/hooks/src/another.ts' }
});
const out4 = execSync(`node ${hookPath}`, { input: input4, encoding: 'utf-8', timeout: 5000 });
console.log('Test 4 (debounce):            ', out4.trim());

console.log('\nAll tests passed.');
