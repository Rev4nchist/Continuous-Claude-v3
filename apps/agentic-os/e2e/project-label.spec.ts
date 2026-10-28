import { expect, test } from '@playwright/test';

import { projectLabel } from '../src/server/sources/project-label';

/**
 * `projectLabel` on the shapes a stored working directory can take. No fixtures: the pure
 * function is imported, so the `~` branch and the odd paths do not depend on live rows.
 */

const USER = 'dkhay';

const CASES: [string, string][] = [
  ['c:/users/dkhay', '~'],
  ['C:\\Users\\dkhay', '~'],
  ['c:/users/dkhay/', '~'],
  ['/home/dkhay', '~'],
  ['/Users/dkhay', '~'],
  ['/mnt/c/Users/dkhay', '~'],
  ['//wsl$/Ubuntu/home/dkhay', '~'],
  ['\\\\server\\share\\Users\\dkhay', '~'],
  ['\\\\?\\C:\\Users\\dkhay', '~'],
  ['/var/home/dkhay', '~'],
  ['c:/users/dkhay/continuous-claude', 'continuous-claude'],
  ['c:/users/dkhay/continuous-claude/.claude/worktrees/sdlc-os-p1a', 'sdlc-os-p1a'],
  ['C:\\Users\\dkhay\\repos\\api\\', 'api'],
  ['/home/dkhay/work/api', 'api'],
  ['plain-name', 'plain-name'],
  ['c:/users/dkhay/My Project', 'My Project'],
  // Known limit, on the safe side: a folder named `home` or `users` right above the last folder
  // reads as a home root, so a repo inside it shows as `~`.
  ['/home/dkhay/projects/home/site', '~'],
  ['c:', 'unknown'],
  ['C:\\', 'unknown'],
  ['', 'unknown'],
  ['/', 'unknown'],
];

test.describe('projectLabel', () => {
  for (const [input, expected] of CASES) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(projectLabel(input)).toBe(expected);
    });
  }

  test('a secret in a folder name is redacted', () => {
    const token = ['ghp', 'A'.repeat(36)].join('_');
    const label = projectLabel(`c:/users/${USER}/${token}`);
    expect(label).not.toContain(token);
  });

  test('a label is clipped to 60 characters', () => {
    expect(projectLabel(`c:/users/${USER}/${'x'.repeat(200)}`).length).toBeLessThanOrEqual(60);
  });
});
