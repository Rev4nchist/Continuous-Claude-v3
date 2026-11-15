/**
 * settings.json.template validation (Phase 2 / SG-02, review#7)
 *
 * A broken template is invisible on the build machine but bricks every fresh
 * install (a hook command pointing at a missing .mjs throws MODULE_NOT_FOUND on
 * each matching tool call). This guard asserts:
 *  - the template is valid JSON
 *  - every {{CLAUDE_HOME}}/hooks/dist/<name>.mjs it registers exists in repo dist
 *  - the 5 deregistered (stale) hooks are no longer registered
 *  - the universal hooks promoted in Phase 2 are present
 *  - no stray {{PLACEHOLDER}} other than {{CLAUDE_HOME}} survives
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import * as path from 'path';
// @ts-expect-error TS7016: render-settings.mjs has no declaration file; the test calls it as plain JS.
import { renderSettings } from '../../../../scripts/settings/render-settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));      // .claude/hooks/src/__tests__
const claudeDir = path.resolve(here, '../../../');               // .claude
const distDir = path.resolve(here, '../../dist');                // .claude/hooks/dist
const tplPath = path.join(claudeDir, 'settings.json.template');
const DB_ENV_KEYS = ['DATABASE_URL', 'CONTINUOUS_CLAUDE_DB_URL', 'OPC_POSTGRES_URL'] as const;

function renderedTemplateEnv(): Record<string, unknown> {
  const rendered = renderSettings({
    templateText: readFileSync(tplPath, 'utf8'),
    vars: {
      CLAUDE_HOME: '/tmp/claude-home',
      OPC_DIR: '/tmp/opc',
      REPO_ROOT: '/tmp/repo',
      USER_HOME: '/tmp/user',
    },
    overlay: {},
  }) as { env?: Record<string, unknown> };
  return rendered.env ?? {};
}

/**
 * Extract the hook's dist name from EITHER form.
 *
 * String form  : { command: "node {{CLAUDE_HOME}}/hooks/dist/foo.mjs" }
 * Exec form    : { command: "node", args: ["{{CLAUDE_HOME}}/hooks/dist/foo.mjs"] }
 *
 * Reading only `command` was correct until the 2026-07-21 exec-form migration
 * (done to mitigate the MSYS fork storm), after which EVERY entry in the
 * template moved its path into `args` -- 73 entries, 0 matchable via `command`.
 * templateHookNames() therefore returned [], which did not fail loudly: the two
 * NEGATIVE assertions ("every dist exists", "no stale hooks registered") both
 * pass trivially on an empty list, so the guards protecting fresh installs went
 * silently vacuous while only the two positive assertions went red. A test that
 * passes because it sees nothing is worse than no test. Read both forms.
 */
function hookDistName(h: { command?: string; args?: string[] }): string | null {
  const haystack = [h.command ?? '', ...(h.args ?? [])].join(' ');
  const m = haystack.match(/dist\/([\w-]+)\.mjs/);
  return m ? m[1] : null;
}

function templateHookNames(): string[] {
  const s = JSON.parse(readFileSync(tplPath, 'utf8'));
  const names: string[] = [];
  for (const evt of Object.keys(s.hooks || {})) {
    for (const b of s.hooks[evt]) {
      for (const h of b.hooks || []) {
        const n = hookDistName(h);
        if (n) names.push(n);
      }
    }
  }
  return names;
}

/** Map each registered hook name -> the set of "event::matcher" it's registered under. */
function templateHookRegistrations(): Map<string, Set<string>> {
  const s = JSON.parse(readFileSync(tplPath, 'utf8'));
  const reg = new Map<string, Set<string>>();
  for (const evt of Object.keys(s.hooks || {})) {
    for (const b of s.hooks[evt]) {
      const matcher = b.matcher ?? '';
      for (const h of b.hooks || []) {
        const n = hookDistName(h);
        if (!n) continue;
        if (!reg.has(n)) reg.set(n, new Set());
        reg.get(n)!.add(`${evt}::${matcher}`);
      }
    }
  }
  return reg;
}

describe('settings.json.template', () => {
  it('16: UserPromptSubmit holds prompt-submit alone: none of the 5 merged hooks is registered there', () => {
    const reg = templateHookRegistrations();
    const onUps = (name: string) => [...(reg.get(name) ?? [])].filter((k) => k.startsWith('UserPromptSubmit::'));
    for (const name of ['heartbeat', 'memory-awareness', 'user-confirmation-detector', 'bus-session-populator', 'lane-context']) {
      expect(onUps(name), `${name} must not be registered on UserPromptSubmit (prompt-submit runs it)`).toEqual([]);
    }
    expect(onUps('prompt-submit')).toEqual(['UserPromptSubmit::']);
    const t = JSON.parse(readFileSync(tplPath, 'utf8'));
    const ups = (t.hooks.UserPromptSubmit as any[]).flatMap((b) => b.hooks ?? []);
    const entry = ups.find((h) => hookDistName(h) === 'prompt-submit');
    expect(entry?.timeout, 'prompt-submit timeout must stay above its 12 s internal deadline').toBe(15);
  });

  it('16b: lane-context stays on SessionStart and PostToolUse', () => {
    const lane = [...(templateHookRegistrations().get('lane-context') ?? [])];
    expect(lane.some((k) => k.startsWith('SessionStart::'))).toBe(true);
    expect(lane.some((k) => k.startsWith('PostToolUse::'))).toBe(true);
  });

  it('is valid JSON', () => {
    expect(() => JSON.parse(readFileSync(tplPath, 'utf8'))).not.toThrow();
  });

  it('every registered hook dist exists in repo (no fresh-install MODULE_NOT_FOUND)', () => {
    const missing = templateHookNames().filter((n) => !existsSync(path.join(distDir, `${n}.mjs`)));
    expect(missing).toEqual([]);
  });

  it('does not register the 5 deregistered (stale) hooks', () => {
    const names = new Set(templateHookNames());
    for (const stale of ['auto-build', 'navigator-safety', 'pageindex-navigator', 'sync-to-repo', 'git-auto-commit']) {
      expect(names.has(stale)).toBe(false);
    }
  });

  it('registers periodic-extract', () => {
    expect(new Set(templateHookNames()).has('periodic-extract')).toBe(true);
  });

  it('registers the Phase-2 universal hooks (incl. the safety guards)', () => {
    const names = new Set(templateHookNames());
    for (const want of ['destructive-command-guard', 'package-install-guard', 'post-edit-diagnostics', 'agent-recall-injector', 'telemetry-tracker', 'session-start-memory-loaders']) {
      expect(names.has(want)).toBe(true);
    }
  });

  it('carries no database URL in the template env or the rendered env', () => {
    const parsed = JSON.parse(readFileSync(tplPath, 'utf8')) as { env?: Record<string, unknown> };
    const templateKeys = DB_ENV_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(parsed.env ?? {}, key));
    expect(templateKeys).toEqual([]);
    const env = renderedTemplateEnv();
    const renderedKeys = DB_ENV_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(env, key));
    expect(renderedKeys).toEqual([]);
    const urlKeys = Object.entries(env)
      .filter(([, value]) => typeof value === 'string' && value.includes('postgresql://'))
      .map(([key]) => key);
    expect(urlKeys).toEqual([]);
  });

  it('a DB-using hook with the template env and no exported var warns and exits 0', () => {
    // The template supplies no URL, matching verify-setup: Postgres with the
    // variable missing FAILs that check, SQLite SKIPs it, and neither mode
    // inherits a credential from the rendered settings env.
    const home = mkdtempSync(path.join(tmpdir(), 'ccv3-tpl-env-'));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith('VITEST')) continue;
      if ((DB_ENV_KEYS as readonly string[]).includes(key)) continue;
      env[key] = value;
    }
    for (const [key, value] of Object.entries(renderedTemplateEnv())) {
      if (typeof value === 'string') env[key] = value;
    }
    const result = spawnSync('node', [path.join(distDir, 'lane-context.mjs')], {
      input: JSON.stringify({ session_id: 'tpl-env-test', hook_event_name: 'UserPromptSubmit' }),
      encoding: 'utf-8',
      env,
      timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr ?? '').toContain('WARN: CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL and OPC_POSTGRES_URL are unset');
    expect(result.stderr ?? '').not.toContain('postgresql://');
    expect(result.stdout ?? '').toContain('{}');
  });

  it('re-render --out replaces a settings file and drops a stale DATABASE_URL key', () => {
    // The renderer does not read the existing file. --out writes a new document
    // from the template plus the profile overlay, so a retired env key is gone.
    const dir = mkdtempSync(path.join(tmpdir(), 'ccv3-settings-replace-'));
    const out = path.join(dir, 'settings.json');
    writeFileSync(out, JSON.stringify({
      env: {
        DATABASE_URL: 'postgresql://user:PLACEHOLDER@localhost:5432/db',
        CONTINUOUS_CLAUDE_COORDINATION: 'true',
      },
    }));
    const script = path.resolve(here, '../../../../scripts/settings/render-settings.mjs');
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CCV3_MACHINE_PROFILE;
    const result = spawnSync(process.execPath, [
      script,
      '--template', tplPath,
      '--out', out,
      '--var', 'CLAUDE_HOME=/tmp/claude-home',
      '--var', 'OPC_DIR=/tmp/opc',
      '--var', 'REPO_ROOT=/tmp/repo',
      '--var', 'USER_HOME=/tmp/user',
    ], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
    expect(result.stdout ?? '').not.toContain('postgresql://');
    expect(result.stderr ?? '').not.toContain('postgresql://');
    const written = JSON.parse(readFileSync(out, 'utf8')) as { env?: Record<string, unknown> };
    expect(Object.keys(written.env ?? {})).not.toContain('DATABASE_URL');
    expect(JSON.stringify(written)).not.toContain('postgresql://');
  });

  it('stays consistent with the verify-setup DB-mode rule', () => {
    const verify = readFileSync(path.join(claudeDir, '..', 'scripts', 'verify-setup.sh'), 'utf8');
    expect(verify).toContain('check "CONTINUOUS_CLAUDE_DB_URL is set"');
    expect(verify).toContain('[SKIP] CONTINUOUS_CLAUDE_DB_URL (sqlite mode)');
  });

  it('contains only known wizard placeholders ({{CLAUDE_HOME}}, {{OPC_DIR}})', () => {
    const raw = readFileSync(tplPath, 'utf8');
    const known = new Set(['CLAUDE_HOME', 'OPC_DIR']); // substituted by wizard.py
    const placeholders = [...raw.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
    const stray = [...new Set(placeholders.filter((p) => !known.has(p)))];
    expect(stray).toEqual([]);
  });

  it('registers key hooks under the CORRECT event + matcher (not just dist-exists)', () => {
    // Verified against the template 2026-06-29. A hook silently moved to the wrong
    // event/matcher (the QW-04 Agent->Task matcher flip reverted, or a Bash guard
    // losing its Bash matcher) passes the dist-exists check above but breaks at
    // runtime — it would never fire on the tool it must gate. This contract catches
    // that drift. (event::matcher; UserPromptSubmit has no matcher -> empty.)
    const reg = templateHookRegistrations();
    const contract: Array<[string, string]> = [
      ['destructive-command-guard', 'PreToolUse::Bash'],
      ['package-install-guard', 'PreToolUse::Bash'],
      ['agent-model-guard', 'PreToolUse::Task'],
      ['agent-recall-injector', 'PreToolUse::Task'],
      // tldr-context-inject removed from the contract 2026-08-31: deregistered
      // everywhere by the TLDR remediation (63s/Task-call, zero real injections)
      // and archived by the Step-10 prune.
      // The 5 prompt hooks run as ONE process (prompt-submit) since 2026-10-29, so
      // Defender scans one node start per prompt, not five.
      ['prompt-submit', 'UserPromptSubmit::'],
      ['post-edit-diagnostics', 'PostToolUse::Edit|Write'],
      ['agent-error-capture', 'PostToolUse::Task'],
      ['agent-verification', 'PostToolUse::Task'],
      ['telemetry-tracker', 'PostToolUse::Skill|Task'],
      // Grep only since 2026-09-23 (P22): the hook's code handles Grep alone.
      ['epistemic-reminder', 'PostToolUse::Grep'],
      // Card compact-session-breakpoint (CodeRabbit CLI, 11-14): apply-registrations carries hooks FROM the template and refuses
      // a name the template does not register, so the template must name the hook before Dave applies it to the live settings.
      // No matcher: it runs for a manual and an automatic compact.
      ['pre-compact-breakpoint', 'PreCompact::'],
    ];
    for (const [name, expected] of contract) {
      const got = reg.get(name);
      expect(got, `${name} must be registered in the template`).toBeDefined();
      expect(
        [...(got ?? [])],
        `${name} must be under ${expected} (got: ${[...(got ?? [])].join(', ') || 'none'})`,
      ).toContain(expected);
    }
  });
});
