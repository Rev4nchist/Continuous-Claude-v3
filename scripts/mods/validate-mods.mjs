#!/usr/bin/env node
/**
 * validate-mods.mjs - Gate for a Claude Code function-hook plugin (the ccv3-mods mods).
 *
 * Runs three checks and prints one summary line:
 *   1. `claude plugin validate --json <dir>`: fails when the plugin is invalid, or when any
 *      entry of `gatingHooks` (manifest or contents) has hasCatch !== true. A gating hook is
 *      one whose answer can refuse a tool call, prompt, command or setting. Without a `.catch`
 *      a hook that throws is skipped and the refusal silently does not happen.
 *   2. `tsc -p <dir>`: needs the engine-written <dir>/.claude-plugin/types/. A headless
 *      `claude -p --plugin-dir <dir>` run writes it (scripts/mods/e2e-headless.mjs does).
 *   3. `claude plugin test <dir>`: fails on a failing test, or on zero tests (a vacuous gate).
 *
 * Usage: node scripts/mods/validate-mods.mjs [plugin-dir]   (default .claude/plugins/ccv3-mods)
 * Env:   TSC_JS = path to typescript/bin/tsc, when none is found under .claude/hooks.
 * Exit code: 1 when any check fails. ASCII only, node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginDir = resolve(process.argv[2] ?? join(repoRoot, '.claude/plugins/ccv3-mods'));
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 280_000 });
const firstLines = (text, n = 12) => text.trim().split(/\r?\n/).slice(0, n).join('\n');

/** Every gating hook the validate report lists, wherever it sits in the report. */
export const gatingHooksOf = report => [
  ...(report?.manifest?.gatingHooks ?? []),
  ...(report?.contents ?? []).flatMap(entry => entry.gatingHooks ?? []),
];

/** Gating hooks that lack a `.catch`. A missing flag counts as missing. */
export const withoutCatch = hooks => hooks.filter(hook => hook.hasCatch !== true);

const label = hook => `${hook.module ?? '?'} ${hook.hook ?? hook.pattern ?? '?'}`;

const checkValidate = () => {
  const ran = sh('claude', ['plugin', 'validate', '--json', pluginDir]);
  let report;
  try {
    report = JSON.parse(ran.stdout);
  } catch {
    return { ok: false, note: `validate: no JSON from claude (exit ${ran.status})\n${firstLines(`${ran.stdout}${ran.stderr ?? ''}`)}` };
  }
  const hooks = gatingHooksOf(report);
  const bare = withoutCatch(hooks);
  const problems = [];
  if (report.success !== true) problems.push('validate: the plugin is not valid');
  for (const entry of [report.manifest, ...(report.contents ?? [])]) {
    for (const error of entry?.errors ?? []) problems.push(`validate: ${entry.file}: ${typeof error === 'string' ? error : JSON.stringify(error)}`);
  }
  for (const hook of bare) problems.push(`validate: gating hook without .catch: ${label(hook)}`);
  return { ok: problems.length === 0, note: problems.join('\n'), short: `validate ${problems.length === 0 ? 'OK' : 'FAIL'} (${hooks.length} gating hook${hooks.length === 1 ? '' : 's'}, ${bare.length} without .catch)` };
};

const findTsc = () => {
  const common = sh('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir']).stdout?.trim();
  const primary = common ? resolve(repoRoot, common, '..') : repoRoot;
  const rel = '.claude/hooks/node_modules/typescript/bin/tsc';
  return [process.env.TSC_JS, join(repoRoot, rel), join(primary, rel), join(repoRoot, 'node_modules/typescript/bin/tsc')].find(p => p && existsSync(p));
};

const checkTsc = () => {
  if (!existsSync(join(pluginDir, '.claude-plugin/types/tsconfig.json'))) {
    return { ok: false, note: 'tsc: NOT RUN, the engine has not written .claude-plugin/types/. Run node scripts/mods/e2e-headless.mjs once.', short: 'tsc NOT RUN' };
  }
  const tsc = findTsc();
  if (!tsc) return { ok: false, note: 'tsc: NOT RUN, no typescript found. Set TSC_JS or run npm install in .claude/hooks.', short: 'tsc NOT RUN' };
  const ran = sh(process.execPath, [tsc, '-p', pluginDir]);
  const ok = ran.status === 0;
  return { ok, note: ok ? '' : `tsc: exit ${ran.status}\n${firstLines(ran.stdout + (ran.stderr ?? ''), 20)}`, short: `tsc ${ok ? 'OK' : 'FAIL'}` };
};

const checkTest = () => {
  const ran = sh('claude', ['plugin', 'test', pluginDir]);
  const out = `${ran.stdout}${ran.stderr ?? ''}`;
  const count = word => Number((out.match(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'm')) ?? [])[1] ?? NaN);
  const pass = count('pass');
  const fail = count('fail');
  const ok = ran.status === 0 && fail === 0 && pass > 0;
  const why = Number.isNaN(pass) || Number.isNaN(fail) ? 'no pass/fail count in the output' : pass === 0 ? 'zero tests ran (vacuous gate)' : `${fail} failing`;
  return { ok, note: ok ? '' : `test: exit ${ran.status}, ${why}\n${firstLines(out.split(/\r?\n/).filter(l => /^\(fail\)/.test(l) || /Error|Expected|Received/.test(l)).join('\n') || out, 20)}`, short: `test ${pass} pass ${fail} fail` };
};

const main = () => {
  const results = [checkValidate(), checkTsc(), checkTest()];
  for (const result of results.filter(r => !r.ok)) console.log(result.note);
  const failed = results.some(r => !r.ok);
  const shorts = results.map(r => r.short ?? 'FAIL');
  console.log(`mods ${failed ? 'FAIL' : 'OK'}: ${shorts.join(' | ')}`);
  process.exit(failed ? 1 : 0);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
