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

test('G29 flags a directory without SKILL.md but not an allow-listed _ folder', () => {
  const root = fixture({ good: skillText('good') });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'orphan'));
  fs.mkdirSync(path.join(root, '.claude', 'skills', '_archive'));
  const rep = run(root);
  assert.ok(hit(rep, 'G29', 'orphan'));
  assert.ok(!hit(rep, 'G29', '_archive'));
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
function stagedFixture(skills, extra = {}) {
  const root = fixture(skills);
  for (const [rel, text] of Object.entries(extra)) write(path.join(root, rel), text);
  const baseline = path.join(root, 'scripts', 'skills', 'audit-skills.baseline.json');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  spawnSync('node', [CLI, '--repo-root', root, '--baseline', baseline, '--update-baseline', '--quiet'], { encoding: 'utf8' });
  assert.equal(vcs(root, 'init', '-q').status, 0);
  assert.equal(vcs(root, 'add', '-A').status, 0);
  return root;
}
const stagedCli = (root) => spawnSync('node', [CLI, '--staged', '--quiet'], { cwd: root, encoding: 'utf8' });
const BROKEN = skillText('a', { fm: { description: 'Does X for the team.' } }); // no "Use when": G14

// A skill may link a tracked repo file outside .claude/skills (kusto-cli links
// ../../rules-ondemand/kusto-cli-safety.md). --staged exports only the skills, so the link must be
// checked against the index, not the export folder.
test('--staged resolves a ../ link to a tracked file outside the exported skills', () => {
  const s = skillText('s', { body: 'Read [the rule](../../rules-ondemand/r.md) first.\n' });
  const root = stagedFixture({ s }, { '.claude/rules-ondemand/r.md': '# rule\n' });
  const r = stagedCli(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  vcs(root, 'rm', '-q', '--cached', '.claude/rules-ondemand/r.md'); // staged for deletion, still on disk
  const gone = stagedCli(root);
  assert.equal(gone.status, 1, gone.stdout + gone.stderr);
  assert.match(gone.stdout, /FAIL G22 s:\d+ unresolved reference \.\.\/\.\.\/rules-ondemand\/r\.md/);
});

// On Windows a reference may spell the repo root in another case; it must still map onto the index,
// so a target staged for deletion (but still on disk) fails.
test('--staged checks a case-variant absolute link against the index', { skip: process.platform !== 'win32' && 'Windows paths only' }, () => {
  const root = stagedFixture({ s: skillText('s') }, { '.claude/rules-ondemand/r.md': '# rule\n' });
  const target = path.join(root, '.claude', 'rules-ondemand', 'r.md').replace(/\\/g, '/');
  const variant = target.charAt(0) === target.charAt(0).toUpperCase() ? target.charAt(0).toLowerCase() + target.slice(1) : target.charAt(0).toUpperCase() + target.slice(1);
  write(path.join(root, '.claude', 'skills', 's', 'SKILL.md'), skillText('s', { body: `Read [the rule](${variant}) first.\n` }));
  vcs(root, 'add', '.claude/skills/s/SKILL.md');
  assert.equal(stagedCli(root).status, 0);
  vcs(root, 'rm', '-q', '--cached', '.claude/rules-ondemand/r.md'); // staged for deletion, still on disk
  const gone = stagedCli(root);
  assert.equal(gone.status, 1, gone.stdout + gone.stderr);
  assert.match(gone.stdout, /FAIL G22 s:\d+ unresolved reference/);
});

// A link through a repo junction/symlink whose target lies outside the repo is judged by the index
// (git tracks linkdir/r.md as a path), not by the target that stays on disk after a staged delete.
test('--staged judges a link through a repo junction by the index, not the outside target', { skip: process.platform !== 'win32' && 'uses a directory junction' }, () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-target-'));
  fs.writeFileSync(path.join(ext, 'r.md'), '# rule\n');
  const s = skillText('s', { body: 'Read [the rule](../../../linkdir/r.md) first.\n' });
  const root = fixture({ s });
  assert.equal(spawnSync('cmd', ['/c', 'mklink', '/J', path.join(root, 'linkdir'), ext], { encoding: 'utf8' }).status, 0);
  const baseline = path.join(root, 'scripts', 'skills', 'audit-skills.baseline.json');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  spawnSync('node', [CLI, '--repo-root', root, '--baseline', baseline, '--update-baseline', '--quiet'], { encoding: 'utf8' });
  vcs(root, 'init', '-q'); vcs(root, 'add', '-A');
  assert.ok(vcs(root, 'ls-files', 'linkdir/r.md').stdout.includes('linkdir/r.md'));
  assert.equal(stagedCli(root).status, 0);
  vcs(root, 'rm', '-q', '--cached', 'linkdir/r.md'); // staged for deletion; the target stays on disk outside the repo
  const gone = stagedCli(root);
  assert.equal(gone.status, 1, gone.stdout + gone.stderr);
  assert.match(gone.stdout, /FAIL G22 s:\d+ unresolved reference/);
});

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
// On Windows, `bash` on PATH can be WSL, which has no node: the guard then skips its ratchets
// (fail-open by design) and these tests fail for the wrong reason. Git runs hooks with Git Bash, so use it.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  if (!execPath) return null;
  for (const rel of ['../../../bin/bash.exe', '../../bin/bash.exe']) {
    const p = path.resolve(execPath, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const BASH = findBash();
const bashOk = !!BASH && spawnSync(BASH, ['-c', 'command -v node'], { encoding: 'utf8' }).status === 0;

// A fixture repo that holds the real gate scripts, so the real guard can run in it.
function guardFixture() {
  const root = stagedFixture({ a: skillText('a'), b: skillText('b') });
  const libs = fs.readdirSync(path.join(here, 'lib')).filter((n) => n.endsWith('.mjs')).map((n) => `lib/${n}`);
  for (const f of ['audit-skills.mjs', 'audit-descriptions.mjs', ...libs]) {
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
const runGuard = (root) => spawnSync(BASH, ['scripts/precommit-build-guard.sh'], { cwd: root, encoding: 'utf8' });

test('pre-commit guard: an unstaged broken skill does NOT block a commit', { skip: !bashOk && 'Git Bash with node not available' }, (t) => {
  const root = guardFixture();
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN); // unstaged
  write(path.join(root, '.claude', 'skills', 'b', 'SKILL.md'), skillText('b', { body: '# Title\n\nA harmless staged edit.\n' }));
  vcs(root, 'add', '.claude/skills/b/SKILL.md'); // this staged path triggers the audit
  const r = runGuard(root);
  t.diagnostic(`guard exit=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('pre-commit guard: a staged broken skill DOES block a commit', { skip: !bashOk && 'Git Bash with node not available' }, (t) => {
  const root = guardFixture();
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN);
  vcs(root, 'add', '.claude/skills/a/SKILL.md');
  const r = runGuard(root);
  t.diagnostic(`guard exit=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BLOCKED by audit-skills/);
  assert.match(r.stderr, /FAIL G14 a /);
});

test('pre-commit guard: a staged change under scripts/skills triggers the audit', { skip: !bashOk && 'Git Bash with node not available' }, () => {
  const root = guardFixture();
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN);
  vcs(root, 'add', '.claude/skills/a/SKILL.md');
  vcs(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base', '--no-verify');
  // Nothing staged now. Stage only a scripts/skills edit; the index still holds the broken skill.
  fs.appendFileSync(path.join(root, 'scripts', 'skills', 'lib', 'skill-rules.mjs'), '\n// touch\n');
  vcs(root, 'add', 'scripts/skills/lib/skill-rules.mjs');
  assert.equal(runGuard(root).status, 1);
});

// ------------------------------------------------------------ review round 3

test('--staged fails a reference whose target is staged for deletion but still on disk', () => {
  const root = stagedFixture({ s: skillText('s', { body: 'See [guide](docs/guide.md).\n' }) });
  write(path.join(root, 'docs', 'guide.md'), '# guide\n');
  vcs(root, 'add', 'docs/guide.md');
  assert.equal(stagedCli(root).status, 0, 'a tracked target satisfies the reference');
  vcs(root, 'rm', '--cached', '-q', 'docs/guide.md'); // staged deletion; the file stays on disk
  assert.ok(fs.existsSync(path.join(root, 'docs', 'guide.md')));
  const r = stagedCli(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL G22 s:\d+ unresolved reference docs\/guide\.md/);
});

// Commit a broken skill, then stage ONLY one audit input and check that the guard still runs the audit.
function guardTriggeredBy(relPath, text) {
  const root = guardFixture();
  write(path.join(root, '.claude', 'skills', 'a', 'SKILL.md'), BROKEN);
  vcs(root, 'add', '.claude/skills/a/SKILL.md');
  vcs(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'broken base', '--no-verify');
  write(path.join(root, relPath), text);
  vcs(root, 'add', relPath);
  return runGuard(root);
}

test('pre-commit guard: staging only .mcp.json triggers the audit', { skip: !bashOk && 'Git Bash with node not available' }, () => {
  assert.equal(guardTriggeredBy('.mcp.json', '{"mcpServers":{}}\n').status, 1);
});

test('pre-commit guard: staging only a .claude/agents file triggers the audit', { skip: !bashOk && 'Git Bash with node not available' }, () => {
  assert.equal(guardTriggeredBy('.claude/agents/new-agent.md', 'agent\n').status, 1);
});

// ------------------------------------------------------------- trigger-probe

test('trigger-probe: the run turns every hook off, so the hit rate is native routing', async () => {
  const { noHooksSettingsPath } = await import('./trigger-probe.mjs');
  assert.deepEqual(JSON.parse(fs.readFileSync(noHooksSettingsPath(), 'utf8')), { disableAllHooks: true });
});

test('trigger-probe: hooksRan counts hook_started events and ignores other lines', async () => {
  const { hooksRan } = await import('./trigger-probe.mjs');
  const stream = ['{"type":"system","subtype":"hook_started"}', '{"type":"system","subtype":"hook_response"}', '{"type":"system","subtype":"hook_started"}', 'not json'].join('\n');
  assert.equal(hooksRan(stream), 2);
  assert.equal(hooksRan('{"type":"system","subtype":"init"}'), 0);
});

// ------------------------------------------------ Phase 2: G32 is hard, --check-name

// A stand-in init_skill.py that writes one SKILL.md. `md` is the file text.
function fakeScaffold(root, md) {
  const script = `import sys, pathlib\nd = pathlib.Path(sys.argv[sys.argv.index('--path') + 1]) / sys.argv[1]\nd.mkdir(parents=True)\n(d / 'SKILL.md').write_text(${JSON.stringify(md)}, encoding='utf-8')\n`;
  write(path.join(root, '.claude', 'skills', 'skill-forge', 'scripts', 'init_skill.py'), script);
}
const GOOD_SCAFFOLD = '---\nname: scaffold-probe\ndescription: Does X. Use when Y.\n---\n# Scaffold Probe\n\nBody.\n';

test('G32 passes when the scaffold is clean', () => {
  const root = fixture({ a: skillText('a') });
  fakeScaffold(root, GOOD_SCAFFOLD);
  const rep = run(root, { runScaffold: true });
  assert.equal(rep.rules.G32.count, 0, JSON.stringify(rep.rules.G32.findings));
  assert.equal(rep.hardFailures, 0);
});

test('G32 is a hard rule: a baseline entry cannot absorb a scaffold finding', () => {
  const root = fixture({ a: skillText('a') });
  fakeScaffold(root, GOOD_SCAFFOLD.replace('# Scaffold Probe', '# Scaffold Probe\n\nSee [guide](references/missing.md).'));
  const first = run(root, { runScaffold: true });
  writeBaseline(first, resolveOptions(opts(root)));
  const again = run(root, { runScaffold: true });
  assert.equal(again.rules.G32.status, 'FAIL', JSON.stringify(again.rules.G32));
  assert.ok(again.hardFailures > 0);
});

test('G32 no longer excuses a scaffold description that fails the description rules', () => {
  const root = fixture({ a: skillText('a') });
  fakeScaffold(root, GOOD_SCAFFOLD.replace('description: Does X. Use when Y.', 'description: Handles things.'));
  const rep = run(root, { runScaffold: true });
  assert.ok(rep.rules.G32.findings.some((x) => /G14/.test(x.msg)), JSON.stringify(rep.rules.G32.findings));
});

test('--update-baseline drops a stale entry for a rule that is now hard', () => {
  const root = fixture({ a: skillText('a') });
  const o = resolveOptions(opts(root));
  write(o.baselinePath, JSON.stringify({ version: 1, scopes: { repo: { rules: { G32: { count: 3, skills: { G22: 3 } }, G05: { count: 0, skills: {} } } } } }));
  writeBaseline(run(root), o);
  const b = JSON.parse(fs.readFileSync(o.baselinePath, 'utf8'));
  assert.equal(b.scopes.repo.rules.G32, undefined, 'a hard rule must not keep a baseline entry');
  assert.ok(b.scopes.repo.rules.G05, 'ratchet rules stay');
});

test('CLI: --check-name accepts a good name and exits 0', () => {
  const r = spawnSync('node', [CLI, '--check-name', 'my-good-skill', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

for (const [name, rule] of [['Bad_Name', 'G05'], ['has_underscore', 'G05'], ['claude-helper', 'G05'], ['a'.repeat(65), 'G05'], ['review', 'G06'], ['-lead', 'G05']]) {
  test(`CLI: --check-name rejects "${name.slice(0, 20)}" with ${rule}`, () => {
    const r = spawnSync('node', [CLI, '--check-name', name, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.findings.some((x) => x.rule === rule), r.stdout);
  });
}

// ------------------------------------------------------------ vendor profile (skill intake)
// Vendored skills live in .claude/skills/_vendor/<source>/skills/<name>/SKILL.md with a shared
// <source>/common/ folder. The default scan skips every _ folder, so the vendor profile audits them.

const SRC = 'skills-for-fabric';
const vroot = (root) => path.join(root, '.claude', 'skills', '_vendor', SRC);
function addVendored(root, skills = {}, { common = {}, overlay } = {}) {
  for (const [name, spec] of Object.entries(skills)) {
    const md = typeof spec === 'string' ? spec : spec.md;
    write(path.join(vroot(root), 'skills', name, 'SKILL.md'), md);
    for (const [rel, text] of Object.entries(spec.files || {})) write(path.join(vroot(root), 'skills', name, rel), text);
  }
  for (const [rel, text] of Object.entries(common)) write(path.join(vroot(root), 'common', rel), text);
  if (overlay) write(path.join(vroot(root), 'overlay.json'), JSON.stringify(overlay));
  return root;
}
const vrun = (root, extra) => run(root, { profile: 'vendor', ...extra });
const vhit = (rep, id, skill) => rep.findings.some((x) => x.rule === id && (!skill || x.skill === `${SRC}/${skill}`));
const OVERLAY_429 = { topic: 'retry-on-429', pattern: '429', files: 'common/**', ccv3_rule: 'stop on capacity error', resolution: 'the hub says stop' };

test('vendor profile audits _vendor/<source>/skills/* and counts each skill', () => {
  const root = addVendored(fixture({ own: skillText('own') }), { one: skillText('one'), two: skillText('two') });
  const rep = vrun(root);
  assert.equal(rep.skillCount, 2);
  assert.equal(rep.failed, false, JSON.stringify(rep.findings));
  assert.match(rep.summary, /audit-skills vendor: 2 skills, 0 hard failures, 0 advisory findings/);
});

test('vendor profile: a hard rule break fails (G03 unknown key, G11 xml tag, G25 windows path, G27 retired name)', () => {
  const root = addVendored(fixture(), {
    g03: skillText('g03', { fm: { version: '1.0' } }),
    g11: skillText('g11', { fm: { description: 'Does <b>X</b>. Use when Y.' } }),
    g25: skillText('g25', { body: 'Open C:\\Users\\me\\x.txt now.\n' }),
    g27: skillText('g27', { body: 'Use braintrust for traces.\n' }),
  });
  const rep = vrun(root);
  assert.equal(rep.failed, true);
  for (const id of ['G03', 'G11', 'G25', 'G27']) assert.ok(vhit(rep, id, id.toLowerCase()), `${id} not reported hard: ${JSON.stringify(rep.findings)}`);
  assert.ok(rep.findings.filter((x) => ['G03', 'G11', 'G25', 'G27'].includes(x.rule)).every((x) => x.class === 'hard'));
});

test('vendor profile: a G01 and a G08 break fail, a G22 dead link fails', () => {
  const root = addVendored(fixture(), {
    g01: '# no frontmatter\n',
    g08: skillText('g08', { fm: { description: '""' } }),
    g22: skillText('g22', { body: 'See [x](references/none.md).\n' }),
  });
  const rep = vrun(root);
  for (const id of ['G01', 'G08', 'G22']) assert.ok(vhit(rep, id, id.toLowerCase()), id);
  assert.equal(rep.failed, true);
});

test('vendor profile: advisory rules are reported and never fail (G14 G09 G12 G21 G26)', () => {
  const root = addVendored(fixture(), {
    adv: skillText('adv', {
      fm: { description: `Manages your thing ${'y'.repeat(420)}` },
      body: 'Run costs $1 as of March 2026 and was set 2026-03-04.\n',
    }),
  });
  const rep = vrun(root);
  assert.equal(rep.failed, false, JSON.stringify(rep.findings.filter((x) => x.class === 'hard')));
  assert.equal(rep.hardFailures, 0);
  for (const id of ['G09', 'G12', 'G14', 'G21', 'G26']) assert.ok(vhit(rep, id, 'adv'), `${id} missing`);
  assert.ok(rep.advisoryCount >= 5);
  assert.ok(rep.findings.every((x) => x.class === 'advisory'));
});

test('vendor profile: ../../common/x.md resolves against the vendor root, a missing one is G22', () => {
  const root = addVendored(fixture(), {
    ok: skillText('ok', { body: 'Read [core](../../common/CORE.md) first.\n' }),
    bad: skillText('bad', { body: 'Read [core](../../common/GONE.md) first.\n' }),
  }, { common: { 'CORE.md': '# core\n' } });
  const rep = vrun(root);
  assert.ok(!vhit(rep, 'G22', 'ok'), JSON.stringify(rep.findings));
  assert.ok(vhit(rep, 'G22', 'bad'));
});

test('vendor profile: a link written from the source root (common/x.md) resolves; the default scan has no such root', () => {
  const root = addVendored(fixture(), { rootrel: skillText('rootrel', { body: 'Read [core](common/CORE.md) first.\n' }) }, { common: { 'CORE.md': '# core\n' } });
  assert.ok(!vhit(vrun(root), 'G22', 'rootrel'), JSON.stringify(vrun(root).findings));
});

test('vendor profile: a vendored name that collides with a CCv3 skill of different content is G07', () => {
  const root = addVendored(fixture({ shared: skillText('shared', { body: 'ours\n' }) }), { shared: skillText('shared', { body: 'theirs\n' }) });
  assert.ok(vhit(vrun(root), 'G07', 'shared'));
});

test('vendor profile: a vendored name that is a bundled name is G06', () => {
  const root = addVendored(fixture(), { debug: skillText('debug') });
  assert.ok(vhit(vrun(root), 'G06', 'debug'));
});

test('vendor profile is not vacuous: no _vendor folder, or a source without skills, fails G30', () => {
  const none = vrun(fixture({ own: skillText('own') }));
  assert.equal(none.failed, true);
  assert.ok(none.findings.some((x) => x.rule === 'G30'), JSON.stringify(none.findings));
  const empty = fixture();
  write(path.join(vroot(empty), 'common', 'x.md'), '# x\n');
  assert.ok(vrun(empty).findings.some((x) => x.rule === 'G30'));
});

test('vendor profile: a skill folder without SKILL.md fails G30 (fewer audited than exist)', () => {
  const root = addVendored(fixture(), { good: skillText('good') });
  write(path.join(vroot(root), 'skills', 'orphan', 'notes.md'), 'x\n');
  const rep = vrun(root);
  assert.ok(rep.findings.some((x) => x.rule === 'G30' && /1 of 2/.test(x.msg)), JSON.stringify(rep.findings));
});

test('the default run also runs the vendor profile when _vendor exists', () => {
  const root = addVendored(fixture({ own: skillText('own') }), { bad: skillText('bad', { fm: { version: '1' } }) });
  const rep = run(root);
  assert.ok(rep.vendor, 'default run has no vendor report');
  assert.equal(rep.vendor.skillCount, 1);
  assert.equal(rep.vendor.failed, true);
  assert.equal(rep.failed, true);
  assert.equal(rep.hardFailures, 0, 'vendor findings must not mix into the repo hard count');
});

test('the default run has no vendor report and is unchanged when _vendor is absent', () => {
  const rep = run(fixture({ own: skillText('own') }));
  assert.equal(rep.vendor, undefined);
  assert.equal(rep.hardFailures, 0);
});

test('the default run leaves _archive and dot folders out; only _vendor is audited', () => {
  const root = fixture({ own: skillText('own') });
  write(path.join(root, '.claude', 'skills', '_archive', 'old', 'SKILL.md'), '# broken\n');
  const rep = run(root);
  assert.equal(rep.hardFailures, 0);
  assert.equal(rep.vendor, undefined);
  assert.equal(rep.skillCount, 1);
});

test('CLI: --profile vendor prints per-skill hard and advisory counts and exits 1 on a hard break', () => {
  const root = addVendored(fixture(), { good: skillText('good', { fm: { description: 'Manages X.' } }), bad: skillText('bad', { fm: { version: '1' } }) });
  const r = cli(root, ['--profile', 'vendor']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${SRC}/good\\s+0\\s+1`));
  assert.match(r.stdout, new RegExp(`${SRC}/bad\\s+1\\s+0`));
  assert.match(r.stdout, /FAIL G03 skills-for-fabric\/bad/);
  assert.match(r.stdout.trim().split('\n').pop(), /^audit-skills vendor: 2 skills, 1 hard failures, 1 advisory findings/);
});

test('CLI: --profile vendor on advisory-only findings exits 0', () => {
  const root = addVendored(fixture(), { good: skillText('good', { fm: { description: 'Manages X.' } }) });
  const r = cli(root, ['--profile', 'vendor']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('CLI: --root points the vendor profile at a skills folder holding _vendor', () => {
  const home = fixture();
  const other = fixture();
  addVendored(other, { good: skillText('good') });
  const r = spawnSync('node', [CLI, '--profile', 'vendor', '--repo-root', home, '--root', path.join(other, '.claude', 'skills')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /audit-skills vendor: 1 skills/);
});

// -------------------------------------------------- G26 and G12 fixes found on the upstream run

test('G26 does not flag an api-version pin or a /versions/ path segment, but still flags a real date', () => {
  const root = fixture({
    pin: skillText('pin', { body: 'Call `?api-version=2023-01-01-preview` and POST /livyApi/versions/2023-12-01/sessions.\nSet api-version=2025-03-01 too.\n' }),
    dated: skillText('dated', { body: 'This changed on 2026-03-04 in the portal.\n' }),
  });
  const rep = run(root);
  assert.ok(!hit(rep, 'G26', 'pin'), JSON.stringify(rep.rules.G26.findings));
  assert.ok(hit(rep, 'G26', 'dated'));
});

test('G26 flags a date that sits on the same line as an api-version pin', () => {
  const root = fixture({ both: skillText('both', { body: 'Use api-version=2025-03-01 as of 2026-03-04.\n' }) });
  assert.ok(hit(run(root), 'G26', 'both'));
});

test('G12 does not read "Pay-As-You-Go" as second person, but still flags a real "you"', () => {
  const root = fixture({
    payg: skillText('payg', { fm: { description: 'Compares Reserved, Pay-As-You-Go and Autoscale billing. Use when sizing capacity.' } }),
    you: skillText('you', { fm: { description: 'Helps you size capacity. Use when sizing.' } }),
  });
  const rep = run(root);
  assert.ok(!hit(rep, 'G12', 'payg'), JSON.stringify(rep.rules.G12.findings));
  assert.ok(hit(rep, 'G12', 'you'));
});

// ------------------------------------------------------------------------- conflict scan

const CORE_429 = '# core\n\nOn 429 or 503 retry with exponential backoff.\n';
const scanOnly = (root, extra) => vrun(root, extra).findings.filter((x) => x.rule === 'X01');

test('conflict scan: an uncovered retry-on-429 hit fails the vendor profile with file and line', () => {
  const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'COMMON-CORE.md': CORE_429 } });
  const rep = vrun(root);
  assert.equal(rep.failed, true);
  const x = scanOnly(root);
  assert.ok(x.length >= 1 && x.every((f) => f.class === 'hard'));
  assert.match(x[0].msg, /retry-on-429/);
  assert.match(x[0].msg, /common\/COMMON-CORE\.md:3/);
});

test('conflict scan: an overlay entry for the topic, file and regex covers the hit', () => {
  const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'COMMON-CORE.md': CORE_429 }, overlay: [OVERLAY_429] });
  const rep = vrun(root);
  assert.equal(scanOnly(root).length, 0, JSON.stringify(rep.findings));
  assert.equal(rep.failed, false);
});

test('conflict scan: coverage is keyed by topic and regex, so inserting lines above the hit keeps it covered', () => {
  const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'COMMON-CORE.md': CORE_429 }, overlay: [OVERLAY_429] });
  assert.equal(vrun(root).failed, false);
  write(path.join(vroot(root), 'common', 'COMMON-CORE.md'), `# core\n\nNew intro line.\nAnother.\n\nOn 429 or 503 retry with exponential backoff.\n`);
  assert.equal(vrun(root).failed, false);
});

test('conflict scan: an overlay entry for another topic, another file glob or another regex does not cover the hit', () => {
  const cases = [
    { ...OVERLAY_429, topic: 'python3' },
    { ...OVERLAY_429, files: 'skills/**' },
    { ...OVERLAY_429, pattern: 'Retry-After' },
  ];
  for (const entry of cases) {
    const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'COMMON-CORE.md': CORE_429 }, overlay: [entry] });
    assert.equal(vrun(root).failed, true, `entry ${JSON.stringify(entry)} must not cover`);
  }
});

test('conflict scan: a malformed overlay (bad regex, unknown topic, missing field) fails the profile', () => {
  const cases = [
    [{ ...OVERLAY_429, pattern: '(' }, /valid regex/],
    [{ ...OVERLAY_429, topic: 'made-up' }, /unknown topic/],
    [{ topic: 'retry-on-429', pattern: '429', files: 'x' }, /missing/],
  ];
  for (const [entry, re] of cases) {
    const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'COMMON-CORE.md': CORE_429 }, overlay: [entry] });
    const rep = vrun(root);
    assert.equal(rep.failed, true);
    assert.ok(rep.findings.some((x) => x.rule === 'X01' && re.test(x.msg)), JSON.stringify(rep.findings));
  }
});

test('conflict scan: each seed topic fires on its own text', () => {
  const seeds = {
    'retry-on-429': 'Honor Retry-After on a 429.',
    'capacity-pause-resume-resize': 'Resume the capacity before the run.',
    'bulk-put-dataAccessRoles': 'PUT /workspaces/{id}/items/{id}/dataAccessRoles replaces all roles.',
    python3: 'Run python3 script.py.',
    'system-package-install': 'sudo apt-get install jq',
    'npm-global-install': 'npm install -g @azure/cli',
    'unpinned-pip-install': 'pip install requests',
    'odbc-driver-18': 'Driver={ODBC Driver 18 for SQL Server}',
    FabricOpenAI: 'client = FabricOpenAI(model="x")',
  };
  const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'seeds.md': Object.values(seeds).join('\n') + '\n' } });
  const topics = new Set(scanOnly(root).map((x) => x.msg.match(/\[([^\]]+)\]/)[1]));
  for (const t of Object.keys(seeds)) assert.ok(topics.has(t), `seed ${t} did not fire; got ${[...topics]}`);
});

test('conflict scan: a pinned pip install and plain prose do not fire', () => {
  const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'ok.md': 'pip install requests==2.32.0\nUse python for scripts.\nAn ordinary sentence.\n' } });
  assert.equal(scanOnly(root).length, 0, JSON.stringify(scanOnly(root)));
});

test('vendor-conflict-scan CLI: prints the hit list, exits 1 on an uncovered hit and 0 once covered', () => {
  const SCAN = path.join(here, 'vendor-conflict-scan.mjs');
  const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'COMMON-CORE.md': CORE_429 } });
  const r1 = spawnSync('node', [SCAN, '--source', vroot(root)], { encoding: 'utf8' });
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /UNCOVERED \[retry-on-429\] common\/COMMON-CORE\.md:3:/);
  write(path.join(vroot(root), 'overlay.json'), JSON.stringify([OVERLAY_429]));
  const r2 = spawnSync('node', [SCAN, '--source', vroot(root)], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /^covered +\[retry-on-429\] common\/COMMON-CORE\.md:3:/);
  const j = spawnSync('node', [SCAN, '--source', vroot(root), '--json'], { encoding: 'utf8' });
  assert.ok(JSON.parse(j.stdout).hits.length >= 1);
});

test('vendor-conflict-scan CLI: a source with no scannable files fails instead of passing vacuously', () => {
  const SCAN = path.join(here, 'vendor-conflict-scan.mjs');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-empty-'));
  const r = spawnSync('node', [SCAN, '--source', empty], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /scanned 0 files/);
});

// ------------------------------------------- vendor files are covered by --staged and the guard

const VENDORED = (n) => `.claude/skills/_vendor/${SRC}/skills/${n}/SKILL.md`;

test('--staged exports _vendor: a staged hard break in a vendored file fails', () => {
  const root = stagedFixture({ a: skillText('a') }, { [VENDORED('v')]: skillText('v') });
  assert.equal(stagedCli(root).status, 0, stagedCli(root).stdout);
  write(path.join(root, VENDORED('v')), skillText('v', { fm: { version: '1' } }));
  vcs(root, 'add', VENDORED('v'));
  const r = stagedCli(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL G03 skills-for-fabric\/v/);
});

test('--staged: an advisory-only finding in a vendored file does not fail', () => {
  const root = stagedFixture({ a: skillText('a') }, { [VENDORED('v')]: skillText('v') });
  write(path.join(root, VENDORED('v')), skillText('v', { fm: { description: 'Manages X.' } })); // G14 only
  vcs(root, 'add', VENDORED('v'));
  const r = stagedCli(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('--staged: an unstaged break in a vendored file is ignored', () => {
  const root = stagedFixture({ a: skillText('a') }, { [VENDORED('v')]: skillText('v') });
  write(path.join(root, VENDORED('v')), skillText('v', { fm: { version: '1' } })); // working tree only
  assert.equal(stagedCli(root).status, 0);
});

test('--staged: a staged vendored common/ file with an uncovered 429 retry fails the conflict scan', () => {
  const root = stagedFixture({ a: skillText('a') }, { [VENDORED('v')]: skillText('v') });
  write(path.join(root, `.claude/skills/_vendor/${SRC}/common/COMMON-CORE.md`), CORE_429);
  vcs(root, 'add', '-A');
  const r = stagedCli(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL X01 skills-for-fabric.*retry-on-429/);
});

test('pre-commit guard: a staged vendored file with a hard break DOES block the commit', { skip: !bashOk && 'Git Bash with node not available' }, () => {
  const root = guardFixture();
  write(path.join(root, VENDORED('v')), skillText('v', { fm: { version: '1' } }));
  vcs(root, 'add', VENDORED('v'));
  const r = runGuard(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /BLOCKED by audit-skills/);
  assert.match(r.stderr, /FAIL G03 skills-for-fabric\/v/);
});

test('pre-commit guard: a staged vendored file with only an advisory finding does NOT block', { skip: !bashOk && 'Git Bash with node not available' }, () => {
  const root = guardFixture();
  write(path.join(root, VENDORED('v')), skillText('v', { fm: { description: 'Manages X.' } }));
  vcs(root, 'add', VENDORED('v'));
  const r = runGuard(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('pre-commit guard: staging only a vendored common/ file triggers the audit', { skip: !bashOk && 'Git Bash with node not available' }, () => {
  const root = guardFixture();
  write(path.join(root, VENDORED('v')), skillText('v'));
  vcs(root, 'add', '-A');
  vcs(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'vendor base', '--no-verify');
  write(path.join(root, `.claude/skills/_vendor/${SRC}/common/COMMON-CORE.md`), CORE_429);
  vcs(root, 'add', '-A');
  const r = runGuard(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /X01/);
});

// =========================================================== round 2: review findings

const xmsgs = (root, extra) => vrun(root, extra).findings.filter((x) => x.rule === 'X01').map((x) => x.msg);
const withOverlay = (overlay, common = { 'COMMON-CORE.md': CORE_429 }) => addVendored(fixture(), { v: skillText('v') }, { common, overlay });

// 1. an overlay entry must not become a blanket pass

test('overlay: a catch-all pattern (".", ".*", "\\S") is rejected at load and covers nothing', () => {
  for (const pattern of ['.', '.*', '\\S', '[\\s\\S]*']) {
    const root = withOverlay([{ ...OVERLAY_429, pattern }]);
    const rep = vrun(root);
    assert.equal(rep.failed, true, `pattern ${pattern} must not cover the 429 hit`);
    assert.ok(xmsgs(root).some((m) => /catch-all|empty string/.test(m)), `${pattern}: ${JSON.stringify(xmsgs(root))}`);
  }
});

test('overlay: a files glob that is only * or ** is rejected at load', () => {
  for (const files of ['**', '*', '**/*', '*/**']) {
    const root = withOverlay([{ ...OVERLAY_429, files }]);
    assert.equal(vrun(root).failed, true, `files ${files} must not cover`);
    assert.ok(xmsgs(root).some((m) => /files/.test(m) && /every file|only \*/.test(m)), `${files}: ${JSON.stringify(xmsgs(root))}`);
  }
});

test('overlay: an entry that covers hits in more than one file fails unless "files" lists every file', () => {
  const common = { 'A.md': 'On 429 wait.\n', 'B.md': 'On 429 wait too.\n' };
  const broad = withOverlay([{ ...OVERLAY_429, files: 'common/*.md' }], common);
  assert.equal(vrun(broad).failed, true);
  assert.ok(xmsgs(broad).some((m) => /more than one file/.test(m) && /A\.md/.test(m)), JSON.stringify(xmsgs(broad)));
  const explicit = withOverlay([{ ...OVERLAY_429, files: ['common/A.md', 'common/B.md'] }], common);
  assert.equal(vrun(explicit).failed, false, JSON.stringify(xmsgs(explicit)));
  // a file the list does not name is not covered by it
  const partial = withOverlay([{ ...OVERLAY_429, files: ['common/A.md'] }], common);
  assert.equal(vrun(partial).failed, true);
});

test('overlay: an entry may cover at most 5 hits unless it sets max_hits, and a later hit above max_hits fails', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `429 case ${i}\n`).join('');
  const six = withOverlay([OVERLAY_429], { 'COMMON-CORE.md': lines(6) });
  assert.equal(vrun(six).failed, true);
  assert.ok(xmsgs(six).some((m) => /6 hits/.test(m) && /max_hits/.test(m)), JSON.stringify(xmsgs(six)));
  const ok = withOverlay([{ ...OVERLAY_429, max_hits: 6 }], { 'COMMON-CORE.md': lines(6) });
  assert.equal(vrun(ok).failed, false, JSON.stringify(xmsgs(ok)));
  write(path.join(vroot(ok), 'common', 'COMMON-CORE.md'), lines(7)); // an upstream pull adds a hit
  assert.equal(vrun(ok).failed, true);
  const bad = withOverlay([{ ...OVERLAY_429, max_hits: 'many' }], { 'COMMON-CORE.md': lines(1) });
  assert.ok(xmsgs(bad).some((m) => /max_hits/.test(m)));
});

test('the vendor report records hit and file counts for every overlay entry', () => {
  const root = withOverlay([OVERLAY_429], { 'COMMON-CORE.md': '429 a\n429 b\n' });
  const stats = vrun(root).overlay['skills-for-fabric'];
  assert.equal(stats.length, 1);
  assert.deepEqual({ topic: stats[0].topic, hits: stats[0].hits, files: stats[0].fileCount }, { topic: 'retry-on-429', hits: 2, files: 1 });
});

test('vendor-conflict-scan CLI: the overlay violations fail the exit code and print the entry counts', () => {
  const SCAN = path.join(here, 'vendor-conflict-scan.mjs');
  const root = withOverlay([{ ...OVERLAY_429, pattern: '.' }]);
  const r = spawnSync('node', [SCAN, '--source', vroot(root)], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /catch-all/);
});

// 9. overlay regexes are bounded

test('overlay: a nested unbounded quantifier is rejected at load', () => {
  for (const pattern of ['(a+)+$', '(.*)*x', '(\\w+\\s?)*$']) {
    const root = withOverlay([{ ...OVERLAY_429, pattern }]);
    assert.ok(xmsgs(root).some((m) => /nested/.test(m)), `${pattern}: ${JSON.stringify(xmsgs(root))}`);
  }
});

test('overlay: a regex only sees the first 2000 characters of a line', () => {
  const long = `On 429 retry. ${'x'.repeat(2500)} TAILMARK\n`;
  const root = withOverlay([{ ...OVERLAY_429, pattern: 'TAILMARK' }], { 'COMMON-CORE.md': long });
  assert.equal(vrun(root).failed, true, 'a pattern that matches only beyond column 2000 must not cover');
  const head = withOverlay([{ ...OVERLAY_429, pattern: 'On 429' }], { 'COMMON-CORE.md': long });
  assert.equal(vrun(head).failed, false, JSON.stringify(xmsgs(head)));
});

// 10. links inside a vendor tree

function junction(target, link) {
  try { fs.symlinkSync(target, link, 'junction'); return true; } catch { return false; }
}

test('conflict scan: a junction loop does not hang the scan and a link out of the tree is not followed', (t) => {
  const root = addVendored(fixture(), { v: skillText('v') }, { common: { 'ok.md': 'plain\n' } });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-outside-'));
  write(path.join(outside, 'leak.md'), 'On 429 retry forever.\n');
  const loop = junction(vroot(root), path.join(vroot(root), 'common', 'loop'));
  const out = junction(outside, path.join(vroot(root), 'common', 'out'));
  if (!loop || !out) { t.skip('cannot make a junction or symlink here'); return; }
  const msgs = xmsgs(root);
  assert.ok(!msgs.some((m) => /leak\.md/.test(m)), 'a file behind a link that leaves the tree was scanned');
  assert.equal(vrun(root).failed, false, JSON.stringify(msgs));
});

// 2. G22 inside a vendor tree resolves only inside that tree

test('vendor G22: a link that exists only at the repo root is unresolved', () => {
  const root = addVendored(fixture(), { v: skillText('v', { body: 'See [guide](README.md).\n' }) });
  write(path.join(root, 'README.md'), '# CCv3 readme\n');
  assert.ok(vhit(vrun(root), 'G22', 'v'), JSON.stringify(vrun(root).findings));
});

test('vendor G22: a ../ link that leaves the vendor tree is unresolved even when the target exists', () => {
  const root = addVendored(fixture(), {
    v: skillText('v', { body: 'See [outside](../../../../other.md).\n' }),
    w: skillText('w', { body: 'Ref.\n', }),
  });
  write(path.join(root, '.claude', 'skills', 'other.md'), '# a CCv3 file next to _vendor\n');
  write(path.join(vroot(root), 'skills', 'w', 'references', 'r.md'), 'See [escape](../../../../../other.md).\n');
  const rep = vrun(root);
  assert.ok(vhit(rep, 'G22', 'v'), JSON.stringify(rep.findings));
  assert.ok(vhit(rep, 'G22', 'w'), JSON.stringify(rep.findings));
});

test('vendor G22: a link that exists only under ~/.claude is a hard failure, not a warning', () => {
  const root = addVendored(fixture(), { v: skillText('v', { body: 'See [r](rules/r.md).\n' }) });
  write(path.join(root, 'home', '.claude', 'rules', 'r.md'), '# r\n');
  const rep = vrun(root);
  assert.ok(rep.findings.some((x) => x.rule === 'G22' && x.class === 'hard' && x.skill === `${SRC}/v`), JSON.stringify(rep.findings));
});

test('vendor G22: a link inside the skill folder and one to common/ still resolve', () => {
  const root = addVendored(fixture(), { v: { md: skillText('v', { body: '[a](references/a.md) [c](../../common/C.md) [root](common/C.md)\n' }), files: { 'references/a.md': '# a\n' } } },
    { common: { 'C.md': '# c\n' } });
  assert.ok(!vhit(vrun(root), 'G22', 'v'), JSON.stringify(vrun(root).findings));
});

// 8. the summary line must not say "0 hard failures" while the gate fails

test('the summary line carries the vendor result when the vendor profile ran', () => {
  const root = addVendored(fixture({ own: skillText('own') }), { bad: skillText('bad', { fm: { version: '1' } }) });
  const rep = run(root);
  assert.match(rep.summary, /^audit-skills: 1 skills, 0 hard failures, \d+ ratchet regressions, baseline baseline\.json, vendor: 1 skills, 1 hard failures$/);
  const r = cli(root, []);
  assert.equal(r.status, 1);
  assert.match(r.stdout.trim().split('\n').pop(), /, vendor: 1 skills, 1 hard failures$/);
});

test('the summary line has no vendor part when there is no _vendor folder', () => {
  const rep = run(fixture({ own: skillText('own') }));
  assert.doesNotMatch(rep.summary, /vendor/);
});

// 11. an unknown _ folder gets neither profile

test('G29 flags a _ folder that is neither _vendor nor on the allow list', () => {
  const root = fixture({ own: skillText('own') });
  write(path.join(root, '.claude', 'skills', '_fabric', 'skills', 'x', 'SKILL.md'), skillText('x'));
  const rep = run(root);
  assert.ok(rep.rules.G29.findings.some((x) => x.skill === '_fabric' && /_fabric/.test(x.msg)), JSON.stringify(rep.rules.G29.findings));
});

test('G29 does not flag the _ folders the repo already holds, nor a _ file', () => {
  const root = fixture({ own: skillText('own') });
  for (const d of ['_archive', '_archived', '_eval', '_sandbox', '_snapshots']) write(path.join(root, '.claude', 'skills', d, 'x.md'), 'x\n');
  write(path.join(root, '.claude', 'skills', '_eval-progress.json'), '{}\n');
  assert.equal(run(root).rules.G29.count, 0);
});

test('--staged: a new unlisted _ folder is exported and flagged G29', () => {
  const root = stagedFixture({ a: skillText('a') });
  write(path.join(root, '.claude', 'skills', '_fabric', 'skills', 'x', 'SKILL.md'), skillText('x'));
  vcs(root, 'add', '-A');
  const r = stagedCli(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /G29/);
  assert.match(r.stdout, /_fabric/);
});
