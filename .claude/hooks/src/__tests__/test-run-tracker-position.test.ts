/**
 * A test tool counts as a run only where the shell runs it: at a command position, behind the
 * launchers people use (npx, uv run, python -m, an env prefix). A command that only NAMES the tool
 * (a commit message, grep, cat) is not a run, because a run is proof for the next 5 minutes.
 */
import { describe, expect, it } from 'vitest';

import { isTestCommand } from '../test-run-tracker.js';

describe('isTestCommand: names that are not runs', () => {
  // Breaks when `\bvitest\b` and its siblings match anywhere in the command.
  it.each([
    'git commit -m "fix vitest flake"',
    "git commit -m 'docs: npm test is slow'",
    'grep -r pytest src',
    'cat jest.config.js',
    'echo npm test',
    'git log --grep="cargo test"',
    'ls node_modules/.bin/mocha-tools',
    'git add src/__tests__/vitest.setup.ts',
    'Write-Output "go test ./..."',
    'git commit -m "$(cat <<\'EOF\'\nfix: x\n\nnpm test passes now\nvitest run is green\nEOF\n)"',
    'git commit -m "a; vitest run"',
  ])('%j is not a run', (command) => {
    expect(isTestCommand(command)).toBe(false);
  });
});

describe('isTestCommand: real runs', () => {
  it.each([
    'npx vitest run',
    'npx vitest run src/__tests__/x.test.ts',
    'cd .claude/hooks && npx vitest run',
    'cd .claude/hooks; npx vitest',
    'vitest run',
    'npx jest --coverage',
    'npx.cmd vitest run',
    'pnpm exec vitest run',
    'pnpm vitest run',
    'yarn vitest',
    'uv run pytest tests/',
    'poetry run pytest -q',
    'python -m pytest tests/',
    'python3 -m pytest',
    'pytest -x',
    'CI=1 npx vitest run',
    '$env:CI=1; npx vitest run',
    './node_modules/.bin/vitest run',
    '.\\node_modules\\.bin\\vitest.cmd run',
    'npm test',
    'npm run test',
    'npm run test:unit',
    'pnpm test',
    'yarn test',
    'make test',
    'cargo test --release',
    'go test ./...',
    'git add -A && npx vitest run',
    'npx mocha',
    'cd x\nnpx vitest run',
    '& npx vitest run',
    'cross-env NODE_ENV=test vitest run',
    'node scripts/rules/rule-router-probe.mjs',
    'node "C:\\Users\\x\\.claude\\scripts\\verify.mjs"',
  ])('%j is a run', (command) => {
    expect(isTestCommand(command)).toBe(true);
  });
});
