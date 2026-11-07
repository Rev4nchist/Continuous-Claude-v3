/**
 * Pathway flow v2 (N6): the pr-review-loop rule must reach the model at the tools of the ship flow.
 * Two gates: the manifest entry (what the router matches) and the PreToolUse matcher in settings.json.template (what the router sees).
 * Failure modes: the pr_checkpoint tool loads no rule (the manifest has no tools matcher, or the template matcher lacks the tool);
 * ship-ask.mjs, gh pr merge or land-pr.ps1 load nothing; an unrelated command loads the rule by mistake.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchRules, type Manifest } from '../rule-router.js';

const CLAUDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(CLAUDE, 'rules-ondemand', 'manifest.json'), 'utf8')) as Manifest;
const settings = JSON.parse(readFileSync(join(CLAUDE, 'settings.json.template'), 'utf8'));
const fires = (tool: string, input: Record<string, unknown> = {}): boolean =>
  matchRules({ session_id: 's', tool_name: tool, tool_input: input }, manifest).some((r) => r.id === 'pr-review-loop');

describe('pr-review-loop routing for the ship flow', () => {
  it('fires at the pr_checkpoint tool', () => {
    expect(fires('mcp__ccv3-mods__pr_checkpoint', { pr: 1 })).toBe(true);
    expect(fires('mcp__ccv3-mods__pr_status', { pr: 1 })).toBe(false);
  });

  it.each([
    ['Bash', 'node scripts/github/ship-ask.mjs land --pr 12 --json'],
    ['PowerShell', 'node scripts/github/ship-ask.mjs commit-and-push --msg m.txt --json'],
    ['Bash', 'node scripts/github/land-decision.mjs check 12 --head abc1234'],
    ['Bash', 'gh pr merge 12 --merge'],
    ['PowerShell', 'pwsh -File scripts/github/land-pr.ps1 -Pr 12'],
  ])('fires at %s: %s', (tool, command) => {
    expect(fires(tool, { command })).toBe(true);
  });

  it('does not fire at an echo of the text or an unrelated command', () => {
    expect(fires('Bash', { command: 'echo "node scripts/github/ship-ask.mjs land --pr 12"' })).toBe(false);
    expect(fires('Bash', { command: 'git status' })).toBe(false);
  });

  it('the PreToolUse matcher of rule-router lets pr_checkpoint in (the other gate)', () => {
    const blocks: { matcher?: string; hooks?: { args?: string[] }[] }[] = settings.hooks.PreToolUse;
    const router = blocks.filter((b) => (b.hooks ?? []).some((h) => (h.args ?? []).join(' ').includes('rule-router.mjs')));
    expect(router.length).toBeGreaterThan(0);
    const reaches = router.some((b) => new RegExp(`^(?:${b.matcher ?? ''})$`).test('mcp__ccv3-mods__pr_checkpoint'));
    expect(reaches).toBe(true);
  });
});
