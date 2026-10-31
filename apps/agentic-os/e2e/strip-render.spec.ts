import { expect, test } from '@playwright/test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ActiveSessionsStrip } from '../src/components/fleet/ActiveSessionsStrip';
import type { ReadyItem } from '../src/server/queries/mission-control';
import type { ActiveSessions } from '../src/server/queries/sessions';

/**
 * The Unmatched sessions panel with a synthetic session, rendered in Node (no database, no
 * browser). It replaces the database-bound case that skipped when no live session was unmatched.
 * Ways it can fail, one test each:
 *   U1 the panel shows a second ask, a recommendation, or more than one ask line per session
 *   U2 the ask line can wrap (the class that sets `white-space: nowrap` is gone)
 *   U3 a session with no ask gets an empty ask line
 */

const SESSION = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  shortId: 'aaaaaaaa',
  projectKey: null,
  rawProject: 'C:/e2e/unmatched',
  liveSecondsAgo: 30,
};

const active = { sessions: [SESSION], recentlyEnded: [], windowMinutes: 60, truncated: false } as unknown as ActiveSessions;

/** What the server sends for a session with two open asks: one row, the first ask, openAsks 2. No recommend key. */
const READY: ReadyItem = {
  sessionId: SESSION.id,
  shortId: SESSION.shortId,
  name: 'unmapped/-/aaaa',
  kind: 'question',
  text: 'E2E first open ask',
  openAsks: 2,
  live: true,
  ageSeconds: 10,
};

/**
 * Playwright compiles every .tsx file with its own JSX runtime (for component tests), so a component called here
 * returns `{ __pw_type, type, props, key }` objects. This turns them back into React elements, host tags only.
 */
function toReact(node: unknown): ReactNode {
  if (Array.isArray(node)) return node.map(toReact);
  if (typeof node !== 'object' || node === null || !('__pw_type' in node)) return node as ReactNode;
  const { type, props, key } = node as unknown as { type: string; props: { children?: unknown } & Record<string, unknown>; key: string | null };
  const { children, ...rest } = props;
  return createElement(type, key === null ? rest : { ...rest, key }, ...([] as unknown[]).concat(children ?? []).map(toReact));
}

const render = (asks: ReadyItem[]): string =>
  renderToStaticMarkup(toReact(ActiveSessionsStrip({ active, asks })) as never);

const askLines = (html: string): string[] => html.match(/<p data-testid="unmatched-ask"[^>]*>/g) ?? [];

test.describe('Unmatched sessions panel', () => {
  test('U1 a session with two open asks shows one ask line: the first ask, no second ask, no recommendation', () => {
    const html = render([READY]);
    expect(askLines(html)).toHaveLength(1);
    expect(html).toContain('E2E first open ask');
    expect(html).not.toContain('E2E second open ask');
    expect(html.toLowerCase()).not.toContain('recommend');
  });

  test('U2 the ask line is a single no-wrap line (truncate sets white-space: nowrap) with the full text as title', () => {
    const html = render([READY]);
    const [line] = askLines(html);
    expect(line).toMatch(/class="[^"]*\btruncate\b/);
    expect(line).toContain('title="E2E first open ask"');
  });

  test('U3 a session with no ask has no ask line', () => {
    const html = render([]);
    expect(askLines(html)).toHaveLength(0);
    expect(html).toContain('aaaaaaaa');
  });
});
