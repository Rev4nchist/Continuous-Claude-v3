import { expect, test } from '@playwright/test';

/**
 * Theme check for the dark terminal style (docs/architecture/agentic-os/2026-10-27-sdlc-os-prd.md,
 * design system section). Runs in both Playwright projects: desktop and phone (390x844).
 * Read-only: it loads `/` and reads computed styles.
 */

/** Parse "rgb(r, g, b)" or "rgba(r, g, b, a)" into [r, g, b]. */
function rgb(value: string): number[] {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`not an rgb colour: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

test.describe('dark terminal theme', () => {
  test('the page background is the deep dark token (bg0 #0b0d11)', async ({ page }) => {
    await page.goto('/');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(rgb(background)).toEqual([11, 13, 17]);
  });

  test('body text is light on that background', async ({ page }) => {
    await page.goto('/');
    const colour = await page.evaluate(() => getComputedStyle(document.body).color);
    const [r, g, b] = rgb(colour);
    expect((r + g + b) / 3).toBeGreaterThan(180);
  });

  test('the body font is a monospace stack', async ({ page }) => {
    await page.goto('/');
    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toMatch(/mono/i);
  });

  test('the page does not scroll sideways', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Agentic OS' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
