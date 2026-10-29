import { expect, test } from '@playwright/test';

import { promptText } from '../src/server/sources/prompt-text';

/**
 * `promptText` on the prompt line the heartbeat hook stores. That hook keeps the first 100
 * characters, so a secret can be cut in half. Fake secrets are built at run time: Trivy flags a
 * literal one.
 */

const fill = (length: number, char = 'a') => char.repeat(length);

test.describe('promptText', () => {
  test('a whole token is redacted', () => {
    const token = ['sk', 'ant', fill(40)].join('-');
    expect(promptText(`use ${token} now`, 140)).not.toContain(token);
  });

  test('a token cut off at the 100 character writer clip is redacted', () => {
    const prefix = 'x'.repeat(90) + ' ';
    const cut = (['sk', 'ant', fill(40)].join('-') + 'tail').slice(0, 9);
    const stored = (prefix + cut).slice(0, 100);
    const shown = promptText(stored, 140);
    expect(shown).not.toContain(cut);
    expect(shown).toContain('[REDACTED:provider_token]');
  });

  test('a cut GitHub or AWS prefix is redacted', () => {
    const gh = ['ghp', fill(6)].join('_');
    const aws = ['AKIA', 'B'.repeat(6)].join('');
    expect(promptText(`token ${gh}`, 140)).not.toContain(gh);
    expect(promptText(`key ${aws}`, 140)).not.toContain(aws);
  });

  test('plain words that start like a prefix but are not at the end stay', () => {
    expect(promptText('the sk-learn docs say hello', 140)).toBe('the sk-learn docs say hello');
  });

  test('an absolute path is replaced and the words around it stay', () => {
    const shown = promptText('fix c:/users/dkhay/repo/x.ts then stop', 140);
    expect(shown).not.toContain('dkhay');
    expect(shown).toContain('then stop');
  });

  test('the display clip runs last', () => {
    expect(promptText('word '.repeat(100), 20).length).toBeLessThanOrEqual(20);
  });
});
