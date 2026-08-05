/**
 * Guard: a hook's RUNTIME tool check must not be narrower than the matcher it
 * is registered under.
 *
 * The 2026-08-05 defect this exists to prevent: `git-commit-roadmap` was
 * registered on `Bash` only, so commits made through the PowerShell tool went
 * unrecorded. The matcher was widened to `Bash|PowerShell` in both
 * settings.json copies -- and nothing changed, because the hook's own `main()`
 * still opened with `if (data.tool_name !== 'Bash') return;`. Two gates, one
 * widened, one forgotten. The symptom did not move, so the inert matcher edit
 * read as "the matcher string must be wrong" and cost a second session.
 *
 * Three sibling hooks (`roadmap-completion`, `ralph-monitor`,
 * `test-run-tracker`) carried the identical defect, all four found together.
 *
 * TWO rules, because the obvious one alone is not enough. "The source must
 * NAME the tool it is registered for" was the first draft, and running it
 * against the pre-fix tree proved it would have MISSED the primary offender:
 * `git-commit-roadmap.ts` already said "PowerShell" in a prose comment about
 * windows-platform.md while its runtime gate still rejected PowerShell. A
 * mention is not a handler. So rule 2 bans the narrow equality gate outright.
 *
 * Both rules are cheap textual proxies rather than control-flow analysis --
 * weak enough not to false-alarm on unusual dispatch styles, and jointly
 * strong enough to catch all four real instances (verified by running them
 * against the pre-fix sources, which produced 4 violations; the fixed tree
 * produces 0).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, '..');
const SETTINGS_PATH = join(HERE, '..', '..', '..', 'settings.json');

/**
 * Tools worth guarding. Kept to the shell tools because those are the ones with
 * a real history of being half-registered; `TaskUpdate`/`Write`/`Edit` hooks
 * have not shown this failure mode.
 */
const GUARDED_TOOLS = ['PowerShell'];

interface Registration {
  hookName: string;
  event: string;
  matcher: string;
}

function collectRegistrations(): Registration[] {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  const out: Registration[] = [];
  for (const event of Object.keys(settings.hooks ?? {})) {
    for (const block of settings.hooks[event] ?? []) {
      const matcher: string = block.matcher ?? '';
      if (!matcher) continue;
      for (const hook of block.hooks ?? []) {
        // The dist path lives in `args`, not `command` (`command` is "node").
        const invocation = [hook.command ?? '', ...(hook.args ?? [])].join(' ');
        const m = invocation.match(/([a-zA-Z0-9-]+)\.mjs/);
        if (!m) continue;
        out.push({ hookName: m[1], event, matcher });
      }
    }
  }
  return out;
}

describe('hook matcher / runtime tool-check consistency', () => {
  const registrations = collectRegistrations();

  it('finds registrations to check (guard is not vacuous)', () => {
    // A guard that silently checks nothing is how the original bug survived a
    // green suite. Assert the corpus is non-empty before trusting any PASS.
    expect(registrations.length).toBeGreaterThan(0);
  });

  it('every hook registered for a guarded tool names that tool in its source', () => {
    const violations: string[] = [];
    let checked = 0;

    for (const reg of registrations) {
      const tools = GUARDED_TOOLS.filter((t) => reg.matcher.split('|').includes(t));
      if (tools.length === 0) continue;

      const srcPath = join(SRC_DIR, `${reg.hookName}.ts`);
      // Some registered hooks are shipped without repo source (vendored or
      // plugin-provided). Skipping is correct; counting is what keeps the skip
      // honest, since a path typo would otherwise skip everything silently.
      if (!existsSync(srcPath)) continue;

      const source = readFileSync(srcPath, 'utf-8');
      checked += 1;

      // Rule 1: the tool must be named somewhere in the source.
      for (const tool of tools) {
        if (!source.includes(tool)) {
          violations.push(
            `${reg.hookName}.ts is registered on matcher "${reg.matcher}" (${reg.event}) ` +
              `but its source never mentions "${tool}" -- the registration is inert.`,
          );
        }
      }

      // Rule 2: no narrow equality gate against a single tool. This is the one
      // that catches a hook which merely TALKS about PowerShell in a comment.
      const narrowGate = source.match(/tool_name\s*(?:!==|===|!=|==)\s*['"]Bash['"]/);
      if (narrowGate) {
        violations.push(
          `${reg.hookName}.ts is registered on matcher "${reg.matcher}" (${reg.event}) ` +
            `but gates at runtime on \`${narrowGate[0]}\` -- narrower than the matcher, ` +
            `so part of the registration is inert. Use a COMMAND_TOOLS set instead.`,
        );
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
