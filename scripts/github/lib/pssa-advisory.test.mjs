// Tests for lib/pssa-advisory.mjs. Run: node --test scripts/github/lib/pssa-advisory.test.mjs
// pwsh never starts: the run call is injected. The JSON shape is the real output of the script in the module, checked on
// scripts/git-safe.ps1 with PSScriptAnalyzer 1.25.0 and -Settings: RuleName, Severity (a string), ScriptPath (backslashes, absolute), Line.
//
// Failure modes, and the source change that makes each test fail:
//   P1  no existing .ps1 in the diff               -> pwsh starts on every change, or a deleted script is analyzed
//   P2  the module is missing                      -> a throw or a FAIL instead of a skip NOTE
//   P3  a normal run                               -> the settings file is not passed as an absolute string (the noisy rules come back),
//                                                     a file path is put into the script text (quoting bug), or the counts / top 3 are wrong
//   P4  pwsh missing, crash, time-out, bad output  -> a FAIL step or a throw
//   P5  zero findings, one finding                 -> "0 findings" is not said, or a single finding (an object, not an array) is dropped
//   P6  the module lookup                          -> env ignored, or version folders sorted as text, or the doubled version folder is missed
//   P7  a file name with a quote in it             -> the name reaches the script text instead of the environment
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MARKER, findPssa, pssaAdvisory, psFiles } from './pssa-advisory.mjs';

// The script prints MARKER on its own line, then the JSON; the reader parses only what follows the marker.
const marked = (json) => [MARKER, json, ''].join('\n');
const TAG = 'advisory only (one-week trial, never fails pre-pr)';

function repoWith(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'pssa-adv-'));
  for (const f of files) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), 'Write-Output 1\n'); }
  writeFileSync(path.join(root, 'PSScriptAnalyzerSettings.psd1'), '@{}\n');
  return root;
}
const finding = (root, file, rule, severity, line) => ({ RuleName: rule, Severity: severity, ScriptPath: path.join(root, file), Line: line });

test('P1: no .ps1 in the diff, or only deleted ones, gives null and never runs pwsh', () => {
  const root = repoWith(['docs/a.md', 'scripts/keep.ps1']);
  let ran = 0;
  const run = () => { ran += 1; return {}; };
  assert.equal(pssaAdvisory({ root, paths: ['docs/a.md', 'scripts/x.psm1', 'scripts/gone.ps1'], module: 'M', run }), null);
  assert.equal(ran, 0);
  assert.deepEqual(psFiles(['scripts/keep.ps1', 'scripts/gone.ps1', 'docs/a.md', 'scripts\\keep.ps1'], root), ['scripts/keep.ps1']);
});

test('P2: a missing module is a NOTE that says it was skipped, and pwsh is not run', () => {
  const root = repoWith(['scripts/a.ps1']);
  let ran = 0;
  const r = pssaAdvisory({ root, paths: ['scripts/a.ps1'], module: null, run: () => { ran += 1; return {}; } });
  assert.equal(r.step, 'pssa');
  assert.equal(r.status, 'NOTE');
  assert.match(r.detail, /skipped.*not found/i);
  assert.match(r.detail, /advisory only/);
  assert.equal(ran, 0);
});

test('P3: one pwsh run for all files; settings and files go in the environment; the line has counts by severity and the top 3 file:line items, worst first', () => {
  const root = repoWith(['scripts/a.ps1', 'scripts/b.ps1', 'README.md']);
  const out = JSON.stringify([
    finding(root, 'scripts/a.ps1', 'PSAvoidUsingEmptyCatchBlock', 'Warning', 79),
    finding(root, 'scripts/b.ps1', 'PSReviewUnusedParameter', 'Information', 5),
    finding(root, 'scripts/b.ps1', 'PSUseDeclaredVarsMoreThanAssignments', 'Warning', 92),
    finding(root, 'scripts/a.ps1', 'PSAvoidAssignmentToAutomaticVariable', 'Error', 3),
    finding(root, 'scripts/a.ps1', 'PSAvoidUsingInvokeExpression', 'Warning', 10),
  ]);
  const calls = [];
  const r = pssaAdvisory({ root, paths: ['scripts/a.ps1', 'scripts/b.ps1', 'README.md'], module: 'C:\\mods\\PSScriptAnalyzer.psd1', run: (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: 0, stdout: marked(out), stderr: '' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'pwsh');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(calls[0].opts.cwd, root);
  const settings = calls[0].opts.env.CCV3_PSSA_SETTINGS;
  assert.ok(path.isAbsolute(settings), settings);
  assert.equal(path.basename(settings), 'PSScriptAnalyzerSettings.psd1');
  assert.equal(calls[0].opts.env.CCV3_PSSA_MODULE, 'C:\\mods\\PSScriptAnalyzer.psd1');
  assert.deepEqual(calls[0].opts.env.CCV3_PSSA_FILES.split('\n'), [path.join(root, 'scripts', 'a.ps1'), path.join(root, 'scripts', 'b.ps1')]);
  assert.match(calls[0].args[3], /-Settings \$env:CCV3_PSSA_SETTINGS/, 'a string, not a PathInfo');
  assert.match(calls[0].args[3], /ErrorActionPreference = 'Stop'/);
  for (const pref of ['WarningPreference', 'InformationPreference', 'ProgressPreference']) assert.match(calls[0].args[3], new RegExp(`\\$${pref} = 'SilentlyContinue'`));
  assert.match(calls[0].args[3], /WildcardPattern\]::Escape\(\$f\)/, 'a name with [ ] is not a wildcard');
  assert.ok(calls[0].args[3].includes(MARKER));
  assert.equal(r.status, 'NOTE');
  assert.match(r.detail, /^5 finding\(s\): 1 Error, 3 Warning, 1 Information; /);
  const top = /top: (.*?) in 2 \.ps1/.exec(r.detail)[1].split('; ');
  assert.deepEqual(top.map((s) => s.split(' ')[0]), ['scripts/a.ps1:3', 'scripts/a.ps1:10', 'scripts/a.ps1:79']);
  assert.match(top[0], /PSAvoidAssignmentToAutomaticVariable \(Error\)/);
  assert.ok(r.detail.endsWith(TAG), r.detail);
});

test('P4: pwsh missing, a crash, a time-out, a non-zero exit or junk output is a NOTE, never a FAIL', () => {
  const root = repoWith(['scripts/a.ps1']);
  const runs = [
    () => { throw new Error('boom'); },
    () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn pwsh ENOENT') }),
    () => ({ status: null, stdout: '', stderr: '', timedOut: true }),
    () => ({ status: 1, stdout: '', stderr: 'Import-Module: The specified module was not loaded' }),
    () => ({ status: 0, stdout: marked('not json'), stderr: '' }),
    () => ({ status: 0, stdout: marked('{"not":"an array"}'), stderr: '' }),
  ];
  for (const run of runs) {
    const r = pssaAdvisory({ root, paths: ['scripts/a.ps1'], module: 'M', run });
    assert.equal(r.status, 'NOTE', JSON.stringify(r));
    assert.match(r.detail, /^skipped: /);
    assert.match(r.detail, /advisory only/);
  }
  const r = pssaAdvisory({ root, paths: ['scripts/a.ps1'], module: 'M', run: runs[3] });
  assert.match(r.detail, /Import-Module/);
});

test('P5: zero findings says so, and a single finding is counted', () => {
  const root = repoWith(['scripts/a.ps1']);
  const none = pssaAdvisory({ root, paths: ['scripts/a.ps1'], module: 'M', run: () => ({ status: 0, stdout: marked('[]'), stderr: '' }) });
  assert.match(none.detail, /^no findings in 1 \.ps1 file\(s\)/);
  // ConvertTo-Json unwraps one object unless -InputObject @() is used; the reader accepts both.
  const one = pssaAdvisory({ root, paths: ['scripts/a.ps1'], module: 'M', run: () => ({ status: 0, stdout: marked(JSON.stringify(finding(root, 'scripts/a.ps1', 'PSX', 'Warning', 4))), stderr: '' }) });
  assert.match(one.detail, /^1 finding\(s\): 1 Warning; top: scripts\/a\.ps1:4 PSX \(Warning\)/);
});

test('P6: findPssa prefers CCV3_PSSA, else the newest version under the doubled version folder', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pssa-home-'));
  const base = path.join(home, 'tools', 'review-scanners', 'PSScriptAnalyzer');
  for (const v of ['1.9.0', '1.25.0', '1.10.1']) {
    mkdirSync(path.join(base, v, 'PSScriptAnalyzer', v), { recursive: true });
    writeFileSync(path.join(base, v, 'PSScriptAnalyzer', v, 'PSScriptAnalyzer.psd1'), '');
  }
  assert.equal(findPssa({ env: {}, home }), path.join(base, '1.25.0', 'PSScriptAnalyzer', '1.25.0', 'PSScriptAnalyzer.psd1'));
  const own = path.join(home, 'mine.psd1');
  writeFileSync(own, '');
  assert.equal(findPssa({ env: { CCV3_PSSA: own }, home }), own);
  assert.equal(findPssa({ env: {}, home: mkdtempSync(path.join(tmpdir(), 'pssa-empty-')) }), null);
});

test('P7: a file name with quotes or a dollar sign reaches pwsh only through the environment, never the script text', () => {
  const root = repoWith(["scripts/it's $(x).ps1"]);
  const calls = [];
  pssaAdvisory({ root, paths: ["scripts/it's $(x).ps1"], module: 'M', run: (bin, args, opts) => { calls.push({ args, opts }); return { status: 0, stdout: marked('[]'), stderr: '' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.join(' ').includes("it's"), false);
  assert.ok(calls[0].opts.env.CCV3_PSSA_FILES.includes("it's $(x).ps1"));
});

test('P8: log noise on stdout before the marker is ignored; no marker at all is a skip NOTE', () => {
  const root = repoWith(['scripts/a.ps1']);
  const noise = 'WARNING: Rule X was skipped\nVERBOSE: Importing module\n[{"RuleName":"Decoy","Severity":"Error","ScriptPath":"x","Line":1}]\n';
  const json = JSON.stringify([finding(root, 'scripts/a.ps1', 'PSReal', 'Warning', 2)]);
  const ok = pssaAdvisory({ root, paths: ['scripts/a.ps1'], module: 'M', run: () => ({ status: 0, stdout: `${noise}${marked(json)}`, stderr: '' }) });
  assert.match(ok.detail, /^1 finding\(s\): 1 Warning; top: scripts\/a\.ps1:2 PSReal \(Warning\)/);
  const none = pssaAdvisory({ root, paths: ['scripts/a.ps1'], module: 'M', run: () => ({ status: 0, stdout: json, stderr: '' }) });
  assert.match(none.detail, /^skipped: PSScriptAnalyzer output could not be read/);
});
