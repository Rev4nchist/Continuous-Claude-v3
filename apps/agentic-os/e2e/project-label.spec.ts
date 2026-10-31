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
  ['\\\\?\\UNC\\server\\share\\Users\\dkhay', '~'],
  ['/var/home/dkhay', '~'],
  ['c:/users/dkhay/continuous-claude', 'continuous-claude'],
  ['c:/users/dkhay/continuous-claude/.claude/worktrees/sdlc-os-p1a', 'sdlc-os-p1a'],
  ['C:\\Users\\dkhay\\repos\\api\\', 'api'],
  ['/home/dkhay/work/api', 'api'],
  ['plain-name', 'plain-name'],
  ['c:/users/dkhay/My Project', 'My Project'],
  ['/home/dkhay/projects/home/site', 'site'],
  // Known limit, on the safe side: a short path whose second-last folder is `home` or `users`.
  ['/srv/home/site', '~'],
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

  // An invisible character inside a checked part must not defeat the home, UNC or drive checks.
  // Source stays ASCII: the zero-width space (U+200B) is built at run time.
  const ZW = String.fromCharCode(0x200b);
  const BS = String.fromCharCode(92);
  const INVISIBLE_CASES: [string, string, string][] = [
    ['zero-width inside Users', `C:/Us${ZW}ers/dkhay`, '~'],
    ['zero-width inside home', `/ho${ZW}me/dkhay`, '~'],
    [
      'zero-width inside UNC',
      [BS + BS + '?', 'U' + ZW + 'NC', 'server', 'share', 'Users', 'dkhay'].join(BS),
      '~',
    ],
    ['zero-width-only last folder under home', `/home/dkhay/${ZW}`, '~'],
    ['zero-width-only last folder of a repo', `C:/work/api/${ZW}/`, 'api'],
    ['zero-width inside a drive root', `C${ZW}:`, 'unknown'],
  ];
  for (const [name, input, expected] of INVISIBLE_CASES) {
    test(`invisible characters: ${name}`, () => {
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
