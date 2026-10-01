// Tests for the skills gate. Each test builds a temp repo with fixture skills, runs the real
// auditSkills() (or the real CLI) and asserts one failure mode. Run: node --test scripts/skills/audit-skills.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditSkills, resolveOptions, writeBaseline } from './audit-skills.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'audit-skills.mjs');
const DESC_CLI = path.join(here, 'audit-descriptions.mjs');

function write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

// A skill that passes every rule. `over` replaces frontmatter lines or the body.
function skillText(name, { fm = {}, body = '# Title\n\nDo the thing.\n', raw } = {}) {
  if (raw !== undefined) return raw;
  const f = { name, description: 'Does the thing. Use when the user asks for the thing.', ...fm };
  const lines = Object.entries(f).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// skills: { dirName: SKILL.md text | { md, files: {rel: text} } }
function fixture(skills = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-skills-test-'));
  write(path.join(root, '.claude', 'settings.json.template'), JSON.stringify({ skillListingMaxDescChars: 1536, mcpServers: { git: {} } }));
  write(path.join(root, '.claude', 'agents', 'scout.md'), 'agent');
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  for (const [name, spec] of Object.entries(skills)) {
    const md = typeof spec === 'string' ? spec : spec.md;
    write(path.join(root, '.claude', 'skills', name, 'SKILL.md'), md);
    for (const [rel, text] of Object.entries(spec.files || {})) write(path.join(root, '.claude', 'skills', name, rel), text);
  }
  return root;
}

const opts = (root, extra = {}) => ({ repoRoot: root, home: path.join(root, 'home'), baselinePath: path.join(root, 'baseline.json'), runScaffold: false, ...extra });
const run = (root, extra) => auditSkills(opts(root, extra));
const hit = (rep, id, skill) => rep.rules[id].findings.some((x) => x.skill === skill);
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
const cli = (root, args) => spawnSync('node', [CLI, '--repo-root', root, '--baseline', path.join(root, 'baseline.json'), ...args], { encoding: 'utf8' });

// ---------------------------------------------------------------- baseline of a clean skill

test('a clean skill trips no hard rule and no per-skill ratchet rule', () => {
  const root = fixture({ good: skillText('good') });
  const rep = run(root);
  assert.equal(rep.hardFailures, 0, JSON.stringify(rep.rules, (k, v) => (k === 'findings' ? v : v)));
  for (const r of Object.values(rep.rules)) if (r.id !== 'G31') assert.equal(r.count, 0, `${r.id} fired on a clean skill`);
});

// ------------------------------------------------------------------ frontmatter rules

test('G01 fails when line 1 is not ---', () => {
  const root = fixture({ bad: '# no frontmatter\nbody\n' });
  assert.ok(hit(run(root), 'G01', 'bad'));
});

test('G01 fails when the closing --- is missing', () => {
  const root = fixture({ bad: '---\nname: bad\ndescription: Does X. Use when Y.\nbody without a close\n' });
  assert.ok(hit(run(root), 'G01', 'bad'));
});

test('G02 fails on ": " inside a plain scalar', () => {
  const root = fixture({ bad: skillText('bad', { fm: { description: 'Does X. Use when the user says: do X' } }) });
  assert.ok(hit(run(root), 'G02', 'bad'));
});

test('G02 fails on a non-key line at top level', () => {
  const root = fixture({ bad: '---\nname: bad\nimplement-task\ndescription: Does X. Use when Y.\n---\nbody\n' });
  assert.ok(hit(run(root), 'G02', 'bad'));
});

test('G03 fails on a key Claude Code does not know', () => {
  const root = fixture({ bad: skillText('bad', { fm: { version: '1.0' } }) });
  assert.ok(hit(run(root), 'G03', 'bad'));
});

test('G04 flags metadata keys that shadow frontmatter keys, in both spellings', () => {
  const root = fixture({
    a: skillText('a', { raw: '---\nname: a\ndescription: Does X. Use when Y.\nmetadata:\n  user_invocable: true\n---\nbody\n' }),
    b: skillText('b', { raw: '---\nname: b\ndescription: Does X. Use when Y.\nmetadata:\n  model: sonnet\n---\nbody\n' }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G04', 'a') && hit(rep, 'G04', 'b'));
});

test('G05 fails when name differs from the directory', () => {
  const root = fixture({ dir: skillText('other-name') });
  assert.ok(hit(run(root), 'G05', 'dir'));
});

test('G05 fails on an underscore name and on a reserved word', () => {
  const root = fixture({ my_skill: skillText('my_skill'), 'claude-helper': skillText('claude-helper') });
  const rep = run(root);
  assert.ok(hit(rep, 'G05', 'my_skill') && hit(rep, 'G05', 'claude-helper'));
});

test('G06 flags a bundled skill name', () => {
  const root = fixture({ debug: skillText('debug') });
  assert.ok(hit(run(root), 'G06', 'debug'));
});

test('G07 fails when two skills resolve to one name with different content', () => {
  const root = fixture({ one: skillText('shared', { body: 'A\n' }), two: skillText('shared', { body: 'B\n' }) });
  const rep = run(root);
  assert.ok(hit(rep, 'G07', 'one') && hit(rep, 'G07', 'two'));
});

test('G08 fails on an empty description and on one over the 1024 cap', () => {
  const root = fixture({
    empty: skillText('empty', { fm: { description: '""' } }),
    huge: skillText('huge', { fm: { description: `Does X. Use when ${'y'.repeat(1100)}` } }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G08', 'empty') && hit(rep, 'G08', 'huge'));
});

test('G08 reads the per-skill cap from settings.json.template', () => {
  const root = fixture({ capped: skillText('capped', { fm: { description: `Does X. Use when ${'y'.repeat(150)}` } }) });
  write(path.join(root, '.claude', 'settings.json.template'), JSON.stringify({ skillListingMaxDescChars: 100 }));
  assert.ok(hit(run(root), 'G08', 'capped'));
});

test('G09 flags a description over 400 chars', () => {
  const root = fixture({ long: skillText('long', { fm: { description: `Does X. Use when ${'y'.repeat(420)}` } }) });
  assert.ok(hit(run(root), 'G09', 'long'));
});

test('G10 fails on a block scalar description', () => {
  const root = fixture({ bad: skillText('bad', { raw: '---\nname: bad\ndescription: >\n  Does X.\n  Use when Y.\n---\nbody\n' }) });
  assert.ok(hit(run(root), 'G10', 'bad'));
});

test('G10 fails on a plain description that spans lines', () => {
  const root = fixture({ bad: skillText('bad', { raw: '---\nname: bad\ndescription: Does X. Use when the\n  user wants Y.\n---\nbody\n' }) });
  assert.ok(hit(run(root), 'G10', 'bad'));
});

test('G11 fails on an XML-like tag in the description', () => {
  const root = fixture({ bad: skillText('bad', { fm: { description: 'Does X. Use when the user says "/x <name>"' } }) });
  assert.ok(hit(run(root), 'G11', 'bad'));
});

test('G12 fails on a first-person description', () => {
  const root = fixture({ bad: skillText('bad', { fm: { description: 'I do X for you. Use when Y.' } }) });
  assert.ok(hit(run(root), 'G12', 'bad'));
});

test('G12 ignores "you" inside a quoted trigger phrase', () => {
  const root = fixture({ ok: skillText('ok', { fm: { description: 'Does X. Use when the user says "what can you do".' } }) });
  assert.ok(!hit(run(root), 'G12', 'ok'));
});

test('G13 fails when the description starts with "Use when"', () => {
  const root = fixture({ bad: skillText('bad', { fm: { description: 'Use when the user asks for X.' } }) });
  assert.ok(hit(run(root), 'G13', 'bad'));
});

test('G14 fails when a model-visible description has no trigger phrase', () => {
  const root = fixture({ bad: skillText('bad', { fm: { description: 'Does X for the team.' } }) });
  assert.ok(hit(run(root), 'G14', 'bad'));
});

test('G14 skips a skill that only the user can invoke', () => {
  const root = fixture({ ok: skillText('ok', { fm: { description: 'Does X for the team.', 'disable-model-invocation': 'true' } }) });
  assert.ok(!hit(run(root), 'G14', 'ok'));
});

test('G15 flags one quoted trigger phrase shared by two skills', () => {
  const root = fixture({
    a: skillText('a', { fm: { description: 'Does A. Use when the user says "make a plan".' } }),
    b: skillText('b', { fm: { description: 'Does B. Use when the user says "Make a plan".' } }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G15', 'a') && hit(rep, 'G15', 'b'));
});

test('G16 fails on a non-boolean and on an unreachable skill', () => {
  const root = fixture({
    nb: skillText('nb', { fm: { 'disable-model-invocation': 'maybe' } }),
    un: skillText('un', { fm: { 'disable-model-invocation': 'true', 'user-invocable': 'false' } }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G16', 'nb') && hit(rep, 'G16', 'un'));
});

test('G17 fails on agent without context: fork, and on agent: Explore', () => {
  const root = fixture({
    nofork: skillText('nofork', { fm: { agent: 'scout' } }),
    explore: skillText('explore', { fm: { context: 'fork', agent: 'Explore' } }),
    ghost: skillText('ghost', { fm: { context: 'fork', agent: 'no-such-agent' } }),
    fine: skillText('fine', { fm: { context: 'fork', agent: 'scout' } }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G17', 'nofork') && hit(rep, 'G17', 'explore') && hit(rep, 'G17', 'ghost'));
  assert.ok(!hit(rep, 'G17', 'fine'));
});

test('G18 fails on Haiku, a bad effort and Sonnet below high', () => {
  const root = fixture({
    h: skillText('h', { fm: { model: 'claude-haiku-4' } }),
    e: skillText('e', { fm: { effort: 'ultra' } }),
    s: skillText('s', { fm: { model: 'claude-sonnet-5', effort: 'medium' } }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G18', 'h') && hit(rep, 'G18', 'e') && hit(rep, 'G18', 's'));
});

test('G19 fails on a bare Bash grant but not on a scoped one', () => {
  const root = fixture({
    bare: skillText('bare', { fm: { 'allowed-tools': '[Read, Bash, Write]' } }),
    scoped: skillText('scoped', { fm: { 'allowed-tools': '[Read, Bash(git status:*)]' } }),
  });
  const rep = run(root);
  assert.equal(rep.rules.G19.findings.filter((x) => x.skill === 'bare').length, 2);
  assert.ok(!hit(rep, 'G19', 'scoped'));
});

test('G19 reads a YAML list of tools', () => {
  const root = fixture({ bad: skillText('bad', { raw: '---\nname: bad\ndescription: Does X. Use when Y.\nallowed-tools:\n  - Bash\n  - Read\n---\nbody\n' }) });
  assert.ok(hit(run(root), 'G19', 'bad'));
});

// ---------------------------------------------------------------------- body rules

test('G20 fails when the body is over 500 lines', () => {
  const root = fixture({ long: skillText('long', { body: lines(501) }), ok: skillText('ok', { body: lines(500) }) });
  const rep = run(root);
  assert.ok(hit(rep, 'G20', 'long'));
  assert.ok(!hit(rep, 'G20', 'ok'));
});

test('G21 flags an unescaped $1 and accepts \\$1', () => {
  const root = fixture({
    bad: skillText('bad', { body: "run awk '{print $1}'\n" }),
    ok: skillText('ok', { body: "run awk '{print \\$1}'\n" }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G21', 'bad'));
  assert.ok(!hit(rep, 'G21', 'ok'));
});

test('G22 fails on a dead markdown link and passes a live one', () => {
  const root = fixture({
    dead: { md: skillText('dead', { body: 'See [guide](references/missing.md).\n' }) },
    live: { md: skillText('live', { body: 'See [guide](references/guide.md).\n' }), files: { 'references/guide.md': '# Guide\n' } },
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G22', 'dead'));
  assert.ok(!hit(rep, 'G22', 'live'));
});

test('G22 fails on a dead backticked skill-local path', () => {
  const root = fixture({ dead: skillText('dead', { body: 'Run `scripts/missing.py`.\n' }) });
  assert.ok(hit(run(root), 'G22', 'dead'));
});

test('G23 fails when a reference links a second reference that SKILL.md does not link', () => {
  const root = fixture({
    nested: { md: skillText('nested', { body: 'See [a](references/a.md).\n' }), files: { 'references/a.md': 'See [b](b.md).\n', 'references/b.md': 'deep\n' } },
    flat: { md: skillText('flat', { body: 'See [a](references/a.md) and [b](references/b.md).\n' }), files: { 'references/a.md': 'See [b](b.md).\n', 'references/b.md': 'deep\n' } },
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G23', 'nested'));
  assert.ok(!hit(rep, 'G23', 'flat'));
});

test('G24 fails on a 101-line reference with no contents, and passes one with a Contents heading', () => {
  const root = fixture({
    toc: { md: skillText('toc', { body: 'See [r](references/r.md).\n' }), files: { 'references/r.md': lines(101) } },
    ok: { md: skillText('ok', { body: 'See [r](references/r.md).\n' }), files: { 'references/r.md': `# R\n\n## Contents\n- one\n\n${lines(101)}` } },
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G24', 'toc'));
  assert.ok(!hit(rep, 'G24', 'ok'));
});

test('G25 flags a Windows path in prose but not inside a powershell fence', () => {
  const root = fixture({
    prose: skillText('prose', { body: 'Open C:\\Users\\x\\file.txt now.\n' }),
    fenced: skillText('fenced', { body: '```powershell\nGet-Item C:\\Users\\x\\file.txt\n```\n' }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G25', 'prose'));
  assert.ok(!hit(rep, 'G25', 'fenced'));
});

test('G26 flags dated text but not inside an Old patterns section', () => {
  const root = fixture({
    dated: skillText('dated', { body: 'Before August 2025 use the old API. Fixed on 2026-01-02.\n' }),
    old: skillText('old', { body: '## Old patterns\n\nBefore August 2025 use the old API (2026-01-02).\n\n## Next\n\nok\n' }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G26', 'dated'));
  assert.ok(!hit(rep, 'G26', 'old'));
});

test('G26 resumes after the Old patterns section ends', () => {
  const root = fixture({ after: skillText('after', { body: '## Old patterns\n\nx\n\n## Current\n\nAs of March the rule changed.\n' }) });
  assert.ok(hit(run(root), 'G26', 'after'));
});

test('G27 flags a retired name but not a line that says never', () => {
  const root = fixture({
    bad: skillText('bad', { body: 'Use the haiku model for speed.\n' }),
    ok: skillText('ok', { body: 'Never use haiku here.\n' }),
    old: skillText('old', { body: '## Old patterns\n\nUsed Serena for symbols.\n' }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G27', 'bad'));
  assert.ok(!hit(rep, 'G27', 'ok'));
  assert.ok(!hit(rep, 'G27', 'old'));
});

test('G28 flags an mcp__ server missing from the configured servers', () => {
  const root = fixture({
    bad: skillText('bad', { body: 'Call `mcp__ghost__lookup`.\n' }),
    ok: skillText('ok', { body: 'Call `mcp__git__status`.\n' }),
  });
  const rep = run(root);
  assert.ok(hit(rep, 'G28', 'bad'));
  assert.ok(!hit(rep, 'G28', 'ok'));
});

test('G29 flags a directory without SKILL.md but not one that starts with _', () => {
  const root = fixture({ good: skillText('good') });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'orphan'));
  fs.mkdirSync(path.join(root, '.claude', 'skills', '_parked'));
  const rep = run(root);
  assert.ok(hit(rep, 'G29', 'orphan'));
  assert.ok(!hit(rep, 'G29', '_parked'));
});

// ----------------------------------------------------------------- gate integrity

test('G30 fails on an empty skills dir (a vacuous gate)', () => {
  const root = fixture({});
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  const rep = run(root);
  assert.ok(rep.rules.G30.count >= 1);
  assert.ok(rep.failed);
});

test('G30 and the audit follow a junction or symlink to a skill dir', () => {
  const root = fixture({ real: skillText('real') });
  const outside = path.join(root, 'elsewhere', 'linked');
  write(path.join(outside, 'SKILL.md'), skillText('linked', { fm: { description: 'Does X for the team.' } }));
  fs.symlinkSync(outside, path.join(root, '.claude', 'skills', 'linked'), 'junction');
  const rep = run(root);
  assert.equal(rep.skillCount, 2);
  assert.ok(hit(rep, 'G14', 'linked'), 'the linked skill was audited');
});

test('--include-active audits a skill that exists only in the active folder', () => {
  const root = fixture({ repoSkill: skillText('repoSkill') });
  write(path.join(root, 'home', '.claude', 'skills', 'active-only', 'SKILL.md'), skillText('active-only', { fm: { description: 'Does X for the team.' } }));
  assert.ok(!run(root).skills.includes('active-only'));
  const rep = run(root, { includeActive: true });
  assert.ok(rep.skills.includes('active-only'));
  assert.ok(hit(rep, 'G14', 'active-only'));
});

// ---------------------------------------------------------------------- ratchet

test('ratchet: a rule at its baseline passes', () => {
  const root = fixture({ a: skillText('a', { fm: { description: 'Use when the user asks for A.' } }) });
  const o = resolveOptions(opts(root));
  writeBaseline(run(root), o);
  const rep = run(root);
  assert.equal(rep.rules.G13.status, 'ok');
  assert.equal(rep.regressions.length, 0);
});

test('ratchet: a rising count fails', () => {
  const root = fixture({ a: skillText('a', { fm: { 'allowed-tools': 'Bash' } }) });
  writeBaseline(run(root), resolveOptions(opts(root)));
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), skillText('a', { fm: { 'allowed-tools': '[Bash, Write]' } }));
  const rep = run(root);
  assert.equal(rep.rules.G19.status, 'REGRESSION');
  assert.ok(rep.failed);
});

test('ratchet: a new offender fails even when the count does not rise', () => {
  const root = fixture({ a: skillText('a', { fm: { 'allowed-tools': 'Bash' } }), b: skillText('b') });
  writeBaseline(run(root), resolveOptions(opts(root)));
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), skillText('a'));
  write(path.join(root, '.claude', 'skills', 'b', 'SKILL.md'), skillText('b', { fm: { 'allowed-tools': 'Bash' } }));
  const rep = run(root);
  assert.equal(rep.rules.G19.count, 1);
  assert.deepEqual(rep.rules.G19.newSkills, ['b']);
  assert.equal(rep.rules.G19.status, 'REGRESSION');
});

test('ratchet: a falling count passes', () => {
  const root = fixture({ a: skillText('a', { fm: { 'allowed-tools': '[Bash, Write]' } }) });
  writeBaseline(run(root), resolveOptions(opts(root)));
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), skillText('a', { fm: { 'allowed-tools': 'Bash' } }));
  assert.equal(run(root).rules.G19.status, 'ok');
});

test('G31 fails when the listing grows more than 2% over the baseline', () => {
  const root = fixture({ a: skillText('a'), b: skillText('b') });
  writeBaseline(run(root), resolveOptions(opts(root)));
  assert.equal(run(root).rules.G31.status, 'ok');
  write(path.join(root, '.claude', 'skills', 'c', 'SKILL.md'), skillText('c'));
  assert.equal(run(root).rules.G31.status, 'REGRESSION');
});

test('a hard rule is never absorbed by the baseline', () => {
  const root = fixture({ bad: skillText('bad', { fm: { description: 'Does X for the team.' } }) });
  writeBaseline(run(root), resolveOptions(opts(root)));
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'baseline.json'), 'utf8'));
  assert.equal(saved.scopes.repo.rules.G14, undefined);
  assert.ok(run(root).hardFailures >= 1);
});

// -------------------------------------------------------------------------- CLI

test('CLI: --update-baseline writes the file, then the re-run shows 0 regressions and exits 0', () => {
  const root = fixture({ a: skillText('a', { fm: { 'allowed-tools': 'Bash' } }) });
  const first = cli(root, []);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /audit-skills: 1 skills, 0 hard failures, \d+ ratchet regressions, baseline baseline\.json/);
  const upd = cli(root, ['--update-baseline']);
  assert.equal(upd.status, 0, upd.stdout);
  assert.ok(fs.existsSync(path.join(root, 'baseline.json')));
  const again = cli(root, []);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /audit-skills: 1 skills, 0 hard failures, 0 ratchet regressions/);
});

test('CLI: the summary line prints the audited count and a hard failure exits 1', () => {
  const root = fixture({ a: skillText('a', { fm: { description: 'Does X for the team.' } }) });
  const r = cli(root, ['--update-baseline']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /audit-skills: 1 skills, 1 hard failures, 0 ratchet regressions/);
});

test('CLI: --skill audits one skill and fails on a ratchet offender that is not in the baseline', () => {
  const root = fixture({ a: skillText('a'), b: skillText('b', { fm: { 'allowed-tools': 'Bash' } }) });
  cli(root, ['--update-baseline']);
  write(path.join(root, '.claude', 'skills', 'b', 'SKILL.md'), skillText('b', { fm: { 'allowed-tools': 'Bash' } }));
  const ok = cli(root, ['--skill', path.join(root, '.claude', 'skills', 'b')]);
  assert.equal(ok.status, 0, ok.stdout);
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), skillText('a', { fm: { 'allowed-tools': 'Bash' } }));
  const bad = cli(root, ['--skill', path.join(root, '.claude', 'skills', 'a')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /audit-skills: 1 skills/);
});

test('CLI: --json prints parseable output with per-rule counts', () => {
  const root = fixture({ a: skillText('a') });
  const r = cli(root, ['--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.skillCount, 1);
  assert.equal(j.rules.G01.count, 0);
});

test('audit-descriptions.mjs runs the description subset through the same implementation', () => {
  const clean = fixture({ a: skillText('a') });
  cli(clean, ['--update-baseline']);
  const ok = spawnSync('node', [DESC_CLI, '--repo-root', clean, '--baseline', path.join(clean, 'baseline.json')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /audit-skills: 1 skills, 0 hard failures/);
  // The baseline exists (including G31), so a failure here can only come from the G14 rule itself.
  const bad = fixture({ a: skillText('a', { fm: { description: 'Does X for the team.' } }) });
  cli(bad, ['--update-baseline']);
  const r = spawnSync('node', [DESC_CLI, '--repo-root', bad, '--baseline', path.join(bad, 'baseline.json')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL G14 a /);
  assert.doesNotMatch(r.stdout, /REGRESSION/);
});

// ------------------------------------------------------------ review round 2

test('ratchet: a swap between skills fails even when the total and the offender set are unchanged', () => {
  // Baseline: a=3 findings, b=1. After: a=1, b=3. Same total (4), same offenders (a, b).
  const root = fixture({ a: skillText('a', { fm: { 'allowed-tools': '[Bash, Write, Edit]' } }), b: skillText('b', { fm: { 'allowed-tools': 'Bash' } }) });
  writeBaseline(run(root), resolveOptions(opts(root)));
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), skillText('a', { fm: { 'allowed-tools': 'Bash' } }));
  write(path.join(root, '.claude', 'skills', 'b', 'SKILL.md'), skillText('b', { fm: { 'allowed-tools': '[Bash, Write, Edit]' } }));
  const rep = run(root);
  assert.equal(rep.rules.G19.count, 4);
  assert.deepEqual(rep.rules.G19.newSkills, ['b']);
  assert.equal(rep.rules.G19.status, 'REGRESSION');
});

test('G28 reports every consecutive bare "server:tool" line, not every other one', () => {
  const root = fixture({ bare: skillText('bare', { body: 'Call git:status first.\nThen call git:diff next.\n' }) });
  const bare = run(root).rules.G28.findings.filter((x) => x.skill === 'bare' && /bare/.test(x.msg));
  assert.equal(bare.length, 2);
});

test('G02 fails on a plain scalar that ends with a colon', () => {
  const root = fixture({ bad: skillText('bad', { fm: { description: 'Does X. Use when the user says:' } }) });
  assert.ok(hit(run(root), 'G02', 'bad'));
});

test('G02 fails on a plain scalar that starts with a reserved YAML indicator', () => {
  const starts = { at: '@mention handler. Use when Y.', tick: '`code` runner. Use when Y.', star: '*Bold* helper. Use when Y.' };
  const root = fixture(Object.fromEntries(Object.entries(starts).map(([k, d]) => [k, skillText(k, { fm: { description: d } })])));
  const rep = run(root);
  for (const k of Object.keys(starts)) assert.ok(hit(rep, 'G02', k), `${k} should fail G02`);
});

test('G12 does not flag I/O or a roman numeral label, but still flags "I do"', () => {
  const root = fixture({
    io: skillText('io', { fm: { description: 'Handles I/O and Phase I work. Use when Y.' } }),
    me: skillText('me', { fm: { description: 'I do X. Use when Y.' } }),
  });
  const rep = run(root);
  assert.ok(!hit(rep, 'G12', 'io'));
  assert.ok(hit(rep, 'G12', 'me'));
});

test('G29 flags a broken junction or symlink under the skills root', () => {
  const root = fixture({ good: skillText('good') });
  const target = path.join(root, 'gone');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(root, '.claude', 'skills', 'dangling'), 'junction');
  fs.rmSync(target, { recursive: true });
  const rep = run(root);
  assert.ok(rep.rules.G29.findings.some((x) => x.skill === 'dangling' && /broken/.test(x.msg)));
});

test('G22 reports a reference found only under ~/.claude as a visible warning, not a silent pass', () => {
  const root = fixture({ s: skillText('s', { body: 'See [rule](rules/only-home.md).\n' }) });
  write(path.join(root, 'home', '.claude', 'rules', 'only-home.md'), '# rule\n');
  const rep = run(root);
  assert.equal(rep.rules.G22.count, 0);
  assert.ok(rep.warnings.some((w) => /^G22 s:\d+: .*only-home\.md.*only under ~\/\.claude/.test(w)), JSON.stringify(rep.warnings));
});

test('G32 reports a scaffold that did not run instead of passing', () => {
  const root = fixture({ a: skillText('a') });
  write(path.join(root, '.claude', 'skills', 'skill-forge', 'scripts', 'init_skill.py'), 'import sys\nsys.exit(3)\n');
  const rep = run(root, { runScaffold: true });
  assert.ok(rep.rules.G32.findings.some((x) => /scaffold did not run/.test(x.msg)), JSON.stringify(rep.rules.G32.findings));
});

// ---------------------------------------------------- --staged and the pre-commit guard

function vcs(root, ...args) { return spawnSync('git', args, { cwd: root, encoding: 'utf8' }); }

// A repo whose index holds clean skills and a baseline. Returns the repo root.
function stagedFixture(skills) {
  const root = fixture(skills);
  const baseline = path.join(root, 'scripts', 'skills', 'audit-skills.baseline.json');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  spawnSync('node', [CLI, '--repo-root', root, '--baseline', baseline, '--update-baseline', '--quiet'], { encoding: 'utf8' });
  assert.equal(vcs(root, 'init', '-q').status, 0);
  assert.equal(vcs(root, 'add', '-A').status, 0);
  return root;
}
const stagedCli = (root) => spawnSync('node', [CLI, '--staged', '--quiet'], { cwd: root, encoding: 'utf8' });
const BROKEN = skillText('a', { fm: { description: 'Does X for the team.' } }); // no "Use when": G14

test('--staged ignores an unstaged break in a tracked skill', () => {
  const root = stagedFixture({ a: skillText('a'), b: skillText('b') });
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN); // working tree only
  const r = stagedCli(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /audit-skills: 2 skills, 0 hard failures, 0 ratchet regressions/);
});

test('--staged fails on a staged break', () => {
  const root = stagedFixture({ a: skillText('a'), b: skillText('b') });
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN);
  vcs(root, 'add', '.claude/skills/a/SKILL.md');
  const r = stagedCli(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL G14 a /);
});

test('--staged does not excuse a staged break that the working tree has already fixed', () => {
  const root = stagedFixture({ a: skillText('a') });
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN);
  vcs(root, 'add', '.claude/skills/a/SKILL.md');
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), skillText('a')); // fixed, unstaged
  assert.equal(stagedCli(root).status, 1);
});

const GUARD = path.join(here, '..', 'precommit-build-guard.sh');
const bashOk = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

// A fixture repo that holds the real gate scripts, so the real guard can run in it.
function guardFixture() {
  const root = stagedFixture({ a: skillText('a'), b: skillText('b') });
  for (const f of ['audit-skills.mjs', 'audit-descriptions.mjs', 'lib/skill-rules.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, 'scripts', 'skills', f)), { recursive: true });
    fs.copyFileSync(path.join(here, f), path.join(root, 'scripts', 'skills', f));
  }
  fs.copyFileSync(GUARD, path.join(root, 'scripts', 'precommit-build-guard.sh'));
  vcs(root, 'rm', '-r', '-q', '-f', '.claude/agents'); // the guard has its own agents check; keep this fixture to skills
  vcs(root, 'add', '-A');
  // Commit the clean base so that "staged" means only what each test stages next.
  assert.equal(vcs(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base', '--no-verify').status, 0);
  return root;
}
const runGuard = (root) => spawnSync('bash', ['scripts/precommit-build-guard.sh'], { cwd: root, encoding: 'utf8' });

test('pre-commit guard: an unstaged broken skill does NOT block a commit', { skip: !bashOk && 'bash not available' }, (t) => {
  const root = guardFixture();
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN); // unstaged
  write(path.join(root, '.claude', 'skills', 'b', 'SKILL.md'), skillText('b', { body: '# Title\n\nA harmless staged edit.\n' }));
  vcs(root, 'add', '.claude/skills/b/SKILL.md'); // this staged path triggers the audit
  const r = runGuard(root);
  t.diagnostic(`guard exit=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('pre-commit guard: a staged broken skill DOES block a commit', { skip: !bashOk && 'bash not available' }, (t) => {
  const root = guardFixture();
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN);
  vcs(root, 'add', '.claude/skills/a/SKILL.md');
  const r = runGuard(root);
  t.diagnostic(`guard exit=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BLOCKED by audit-skills/);
  assert.match(r.stderr, /FAIL G14 a /);
});

test('pre-commit guard: a staged change under scripts/skills triggers the audit', { skip: !bashOk && 'bash not available' }, () => {
  const root = guardFixture();
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN);
  vcs(root, 'add', '.claude/skills/a/SKILL.md');
  vcs(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base', '--no-verify');
  // Nothing staged now. Stage only a scripts/skills edit; the index still holds the broken skill.
  fs.appendFileSync(path.join(root, 'scripts', 'skills', 'lib', 'skill-rules.mjs'), '\n// touch\n');
  vcs(root, 'add', 'scripts/skills/lib/skill-rules.mjs');
  assert.equal(runGuard(root).status, 1);
});
