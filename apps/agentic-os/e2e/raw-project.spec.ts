import { homedir, tmpdir } from 'node:os';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Follow-up to P1b: `active.sessions[].rawProject` is `public.sessions.project`, which holds an
 * absolute working directory (for example `c:/users/<name>/<repo>`). It reached the API and, for an
 * unmapped project, the page. The label must be the last path segment, and a home folder must not
 * show the user name.
 *
 * The app role cannot insert sessions, so these specs read the live rows. Every live Claude Code
 * session stores a path here, so the precondition below fails loudly instead of passing empty.
 */

type ActiveSession = { id: string; rawProject: string };

async function loadSessions(request: APIRequestContext): Promise<ActiveSession[]> {
  const response = await request.get('/api/mission-control');
  expect(response.status()).toBe(200);
  const snapshot = (await response.json()) as { active: { sessions: ActiveSession[] } };
  return snapshot.active.sessions;
}

function leakFragments(): string[] {
  const fragments = [homedir(), tmpdir()];
  const user = process.env.USERNAME ?? process.env.USER;
  if (user) fragments.push(user);
  return fragments.filter((f) => f.length > 3);
}

test.describe('rawProject holds no absolute path', () => {
  test('API: every rawProject is a plain label', async ({ request }) => {
    const sessions = await loadSessions(request);
    expect(
      sessions.length,
      'needs at least one live session (this one counts); start a Claude Code session and re-run',
    ).toBeGreaterThan(0);

    for (const session of sessions) {
      const label = session.rawProject;
      expect(label, `rawProject of ${session.id} must not be empty`).not.toBe('');
      expect(label, `rawProject "${label}" holds a path separator`).not.toMatch(/[\\/]/);
      expect(label, `rawProject "${label}" holds a drive letter`).not.toMatch(/^[A-Za-z]:/);
      for (const fragment of leakFragments()) {
        expect(
          label.toLowerCase(),
          `rawProject "${label}" leaks "${fragment}"`,
        ).not.toContain(fragment.toLowerCase());
      }
    }
  });

  test('API: the response text holds no home folder or user name', async ({ request }) => {
    const response = await request.get('/api/mission-control');
    const text = JSON.stringify(await response.json()).toLowerCase();
    // Scope: the whole snapshot, so a new field cannot reopen the leak. The user name check
    // is on the "users/<name>" and "home/<name>" shapes, not on the bare name, which can be a word.
    const user = (process.env.USERNAME ?? process.env.USER ?? '').toLowerCase();
    expect(user.length, 'no OS user name to check').toBeGreaterThan(0);
    expect(text).not.toContain(`/users/${user}`);
    expect(text).not.toContain(`\\\\users\\\\${user}`);
    expect(text).not.toContain(`/home/${user}`);
  });

  test('page: the strip shows no absolute path', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    const text = (await page.locator('body').innerText()).toLowerCase();
    const user = (process.env.USERNAME ?? process.env.USER ?? '').toLowerCase();
    expect(text).not.toContain(`/users/${user}`);
    expect(text).not.toContain(`\\users\\${user}`);
    expect(text).not.toMatch(/\b[a-z]:[\\/]users[\\/]/);
  });

  test('a home folder shows as "~", a repo folder as its own name', async ({ request }) => {
    const sessions = await loadSessions(request);
    const labels = new Set(sessions.map((s) => s.rawProject));
    // The live rows are repo folders and the home folder, in this repo's sessions.
    for (const label of labels) {
      expect(label, `"${label}" must be "~" or a plain folder name`).toMatch(/^(~|[\w.@+-]+)$/);
    }
  });
});
