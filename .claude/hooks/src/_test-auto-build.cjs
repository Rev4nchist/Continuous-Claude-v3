// Test the path normalization logic from auto-build
const paths = [
  '/home/testuser/.claude/hooks/src/test-hook.ts',
  'C:\\Users\\ada.lovelace\\.claude\\hooks\\src\\test-hook.ts',
  '/home/user/.claude/hooks/src/test-hook.ts',
  '/home/testuser/project/src/app.ts',
  '/home/testuser/.claude/hooks/src/test.js',
  '/home/testuser/.claude/hooks/dist/auto-build.mjs',
];

function isHookSourceFile(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('.claude/hooks/src/') && normalized.endsWith('.ts');
}

for (const p of paths) {
  console.log(`${isHookSourceFile(p) ? 'MATCH' : 'SKIP '} ${p}`);
}
