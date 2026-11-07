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
const SETTINGS_PATH = join(HERE, '..', '..', '..', 'settings.json.template');

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

      /**
       * Rule 0, added 2026-08-10: a hook that never reads `tool_name` cannot be
       * narrower than its matcher, so rule 1 does not apply to it.
       *
       * Rule 1 infers "inert" from "does not name the tool". That inference
       * holds only for hooks that dispatch ON the tool. `lane-context` branches
       * purely on `hook_event_name` and ignores which tool fired, so there is no
       * tool name to mention and nothing to be inert -- verified live: a message
       * delivered through the `Bash` arm of its matcher, and
       * `scripts/coordination/dm-delivery-probe.mjs` covers it.
       *
       * This does not weaken the guard against the four defects it was built
       * for. Every one of them gated on `data.tool_name !== 'Bash'`, so all four
       * reference `tool_name` and still face rule 1. The exemption is only
       * reachable by a hook that reads the field nowhere at all.
       */
      if (!/\btool_name\b/.test(source)) continue;

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

/**
 * F07 (2026-11-03): both shell guards gated only Bash and PowerShell, so a shell-running MCP tool
 * (desktop-commander start_process) ran with no guard. SHELL_TOOLS is the runtime gate. Every name
 * in it must also pass a PreToolUse matcher that runs each guard.
 */
describe('shell guards cover every shell-running tool (F07)', () => {
  const SHELL_GUARDS = ['destructive-command-guard', 'package-install-guard'];

  /** Claude Code matcher rule: only letters, digits, _ and | is an exact name or list; else a regex. */
  function matcherMatches(matcher: string, tool: string): boolean {
    if (matcher === '' || matcher === '*') return true;
    if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(tool);
    return new RegExp(matcher).test(tool);
  }

  function guardsMatching(tool: string): Set<string> {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const found = new Set<string>();
    for (const block of settings.hooks?.PreToolUse ?? []) {
      if (!matcherMatches(block.matcher ?? '', tool)) continue;
      for (const hook of block.hooks ?? []) {
        const m = [hook.command ?? '', ...(hook.args ?? [])].join(' ').match(/([a-zA-Z0-9-]+)\.mjs/);
        if (m) found.add(m[1]);
      }
    }
    return found;
  }

  it('lists at least one MCP shell tool (guard is not vacuous)', async () => {
    const { SHELL_TOOLS } = await import('../shared/shell-tools.js');
    expect([...SHELL_TOOLS.keys()].filter((t) => t.startsWith('mcp__')).length).toBeGreaterThan(0);
  });

  it('every SHELL_TOOLS name reaches both guards through a PreToolUse matcher', async () => {
    const { SHELL_TOOLS } = await import('../shared/shell-tools.js');
    const missing: string[] = [];
    for (const tool of SHELL_TOOLS.keys()) {
      const guards = guardsMatching(tool);
      for (const g of SHELL_GUARDS) if (!guards.has(g)) missing.push(`${g} has no PreToolUse matcher for ${tool}`);
    }
    expect(missing).toEqual([]);
  });

  it('both guards gate at runtime on SHELL_TOOLS, not a private tool set', () => {
    for (const g of SHELL_GUARDS) {
      const source = readFileSync(join(SRC_DIR, `${g}.ts`), 'utf-8');
      expect(source, g).toMatch(/import\s*\{[^}]*\breadShellCommand\b[^}]*\}\s*from\s*'\.\/shared\/shell-tools\.js'/);
      expect(source, g).not.toMatch(/COMMAND_TOOLS\s*=\s*new Set/);
    }
  });

  // dc-config-guard (2026-11-03): set_config_value can widen what the shell tools above may do.
  it('every CONFIG_TOOLS name reaches dc-config-guard through a PreToolUse matcher', async () => {
    const { CONFIG_TOOLS } = await import('../dc-config-guard.js');
    expect(CONFIG_TOOLS.size).toBeGreaterThan(0);
    const missing = [...CONFIG_TOOLS].filter((tool) => !guardsMatching(tool).has('dc-config-guard'));
    expect(missing).toEqual([]);
  });
});

/**
 * Pathway flow v2 (2026-11-06). decision-gate gates at runtime on COMMAND_TOOLS and WRITE_TOOLS; decision-ledger on AskUserQuestion.
 * Every name must pass a matcher that runs the hook. A name in the set but not in a matcher is inert (the hook never sees it).
 */
describe('decision hooks cover every tool they gate', () => {
  const SETTINGS = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  const matches = (event: string, tool: string): Set<string> => {
    const found = new Set<string>();
    for (const block of SETTINGS.hooks?.[event] ?? []) {
      const m: string = block.matcher ?? '';
      const hit = m === '' || m === '*' || (/^[A-Za-z0-9_|]+$/.test(m) ? m.split('|').includes(tool) : new RegExp(`^(?:${m})$`).test(tool));
      if (!hit) continue;
      for (const hook of block.hooks ?? []) {
        const name = [hook.command ?? '', ...(hook.args ?? [])].join(' ').match(/([a-zA-Z0-9-]+)\.mjs/);
        if (name) found.add(name[1]);
      }
    }
    return found;
  };

  it('every COMMAND_TOOLS and WRITE_TOOLS name reaches decision-gate through a PreToolUse matcher', async () => {
    const { COMMAND_TOOLS, WRITE_TOOLS } = await import('../decision-gate.js');
    const tools = [...COMMAND_TOOLS, ...WRITE_TOOLS];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => !matches('PreToolUse', t).has('decision-gate'))).toEqual([]);
  });

  it('decision-gate runs on the Desktop Commander process and write tools, not only on Bash', async () => {
    const { COMMAND_TOOLS, WRITE_TOOLS } = await import('../decision-gate.js');
    const dc = [...COMMAND_TOOLS, ...WRITE_TOOLS].filter((t) => t.startsWith('mcp__'));
    expect(dc.length).toBe(6);
  });

  it('a Desktop Commander move_file onto the decision store reaches decision-gate and is denied', async () => {
    const { decide } = await import('../decision-gate.js');
    const tool = 'mcp__plugin_desktop-commander_desktop-commander__move_file';
    expect(matches('PreToolUse', tool).has('decision-gate')).toBe(true);
    const deps = {
      git: () => ({ status: 1, stdout: '' }),
      readFile: () => JSON.stringify({ decisions: { enforce: true } }),
      env: {},
      home: 'C:/Users/dave',
    };
    const input = { tool_name: tool, tool_input: { source: 'C:/tmp/forged.json', destination: 'C:/Users/dave/.claude/state/ccv3-mods/decisions.json' }, cwd: 'C:/repo' };
    expect(decide(input, deps).action).toBe('deny');
  });

  it('decision-ledger is registered on PostToolUse for AskUserQuestion and its runtime gate names that tool', () => {
    expect(matches('PostToolUse', 'AskUserQuestion').has('decision-ledger')).toBe(true);
    const source = readFileSync(join(SRC_DIR, 'decision-ledger.ts'), 'utf-8');
    expect(source).toMatch(/tool_name \|\| input\.tool\) !== TOOL/);
    expect(source).toMatch(/const TOOL = 'AskUserQuestion'/);
  });
});
