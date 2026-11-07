/**
 * Pathway flow v2: no answer text tells Dave to type or paste a command. Every decision is a tap.
 * The banned shapes: "/pathway <" (a typed /pathway with arguments), "/slot pay" (the old paid-slot command)
 * and "run /pathway" (any case): the model calls pr_checkpoint {pr}, and Dave answers a question.
 * This test reads the BUILT hook files (dist) and the rule text, because they are what the model sees.
 * Failure mode: a later edit puts a typed command back into a deny reason, a context line or the shipped rule.
 * It fails when the built files are stale (run npm run build in .claude/hooks first): the check reads dist on purpose.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, '..', '..');
const REPO = join(HOOKS, '..', '..');
const BANNED = [/\/pathway </, /\/slot pay/, /run \/pathway/i];

const FILES = [
  join(HOOKS, 'dist', 'decision-gate.mjs'),
  join(HOOKS, 'dist', 'decision-ledger.mjs'),
  join(HOOKS, 'dist', 'pr-opened-review-loop.mjs'),
  join(HOOKS, 'dist', 'pre-pr-gate.mjs'),
  join(REPO, 'scripts', 'github', 'land-decision.mjs'),
  join(REPO, 'scripts', 'github', 'land-pr.ps1'),
  join(REPO, '.claude', 'rules-ondemand', 'pr-review-loop.md'),
];

describe('no typed command in the pathway flow texts', () => {
  it.each(FILES)('%s has no "/pathway <", no "/slot pay" and no "run /pathway"', (file) => {
    expect(existsSync(file), `${file} must exist (build the hooks first)`).toBe(true);
    const text = readFileSync(file, 'utf8');
    for (const re of BANNED) {
      const hit = re.exec(text);
      const line = hit ? text.slice(0, hit.index).split('\n').length : 0;
      expect(hit, `${file} line ${line} matches ${re}`).toBeNull();
    }
  });
});
