// Tests of the system map generator (card ccv3-system-map-generator).
// Every row is one way the map can lie: a stale graph, a clean pass on empty input, a hand-kept count, a second copy, a listed id.
// Fixtures are temp trees with made-up names; the real-repo rows (G5, G7b, G10, G13) read the committed files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync as fsRename, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const GEN = join(HERE, 'build-system-map.mjs');
const WRAPPER = join(REPO, 'scripts', 'sync-architecture-stats.mjs');
const VIZ = ['docs', 'architecture', 'system-visualization'];

// One import for the whole file; a missing module fails each row on its own call, not the file at load.
const gen = await import(new URL('./build-system-map.mjs', import.meta.url).href).catch((error) => ({ loadError: error }));
const need = (name) => {
  assert.equal(typeof gen[name], 'function', `build-system-map.mjs must export ${name}() (${gen.loadError ? gen.loadError.code : 'missing'})`);
  return gen[name];
};

const roots = [];
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const SRC = (extra = {}) => ({
  meta: { name: 'Fixture map', tagline: 'a fixture', description: 'A fixture without any count.', platform: 'test', sources: [] },
  glossary: [{ term: 'Hook', definition: 'A rule that fires at an event.' }],
  categories: [{ id: 'hook', label: 'Hook', color: '#888', description: 'hooks' }],
  nodes: ['hooks', 'skills', 'agents', 'rules', 'review-engine'].map((id, i) => ({
    id, label: id, shortLabel: id, category: 'hook', plain: `The ${id} part.`, mechanics: [`It does ${id} work.`], summary: `${id} summary`,
    description: `${id} description`, position: { x: 80 + i * 120, y: 80 }, stats: {}, files: [],
  })),
  flows: [],
  ...extra,
});

const hookEntry = (file) => ({ type: 'command', command: 'node', timeout: 5, args: [`{{CLAUDE_HOME}}/hooks/dist/${file}`] });

/** A fixture repo root. `hooks` is a list of [event, matcher, file]; `raw` entries are not node entries with args. */
function makeRoot({ hooks = [['PreToolUse', 'Bash', 'alpha.mjs'], ['PostToolUse', 'Edit', 'beta.mjs']], raw = 0, skills = ['s-one', 's-two'], agents = ['a-one'],
  rulesSrc = ['r1.md', 'r2.md'], rulesOnDemand = ['o1.md'], waves = [['0', 'lane-a', 'P1'], ['1', 'lane-b', 'P2'], ['1', 'lane-c', 'P2']], src = SRC(), mcp = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sysmap-'));
  roots.push(root);
  const put = (rel, text) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
  const groups = {};
  for (const [event, matcher, file] of hooks) (groups[event] ??= []).push({ matcher, hooks: [hookEntry(file)] });
  for (let i = 0; i < raw; i += 1) (groups.Stop ??= []).push({ matcher: '', hooks: [{ type: 'command', command: `bash -c "echo ${i}"` }] });
  put('.claude/settings.json.template', JSON.stringify({ hooks: groups }, null, 2));
  for (const s of skills) put(`.claude/skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: Does ${s}. Use when testing.\n---\n\n# ${s}\n`);
  for (const a of agents) put(`.claude/agents/${a}.md`, `---\nname: ${a}\ndescription: Agent ${a}.\nmodel: sonnet\n---\n`);
  for (const r of rulesSrc) put(`.claude/rules-src/${r}`, '# rule\n');
  for (const r of rulesOnDemand) put(`.claude/rules-ondemand/${r}`, '# rule\n');
  put('.claude/rules-ondemand/manifest.json', '{}');
  if (waves) {
    put('docs/review-engine/map.md', ['# Map', '', '| Wave | Lane | Phase | Depends on | Needs Dave | Change | Held until |', '|---|---|---|---|---|---|---|',
      ...waves.map(([w, l, p]) => `| ${w} | \`${l}\` | ${p} | none |  | new |  |`), ''].join('\n'));
  }
  if (mcp) put('.mcp.json', JSON.stringify({ mcpServers: {} }));
  put('.claude/machine-config/mcp.json', JSON.stringify({ mcpServers: { x: { env: { TOKEN: 'SENTINEL_SECRET_VALUE' } } } }));
  put(`${VIZ.join('/')}/architecture.src.json`, JSON.stringify(src, null, 2));
  put(`${VIZ.join('/')}/index.html`, '<!doctype html><html><body><script type="application/json" id="embedded-data">{}</script></body></html>\n');
  return root;
}

const run = (root, ...flags) => spawnSync(process.execPath, [GEN, '--root', root, ...flags], { encoding: 'utf8' });
const apply = (root) => { const r = run(root, '--apply', '--skip-listed'); assert.equal(r.status, 0, `apply failed: ${r.stdout}${r.stderr}`); };
const graphOf = (root) => JSON.parse(readFileSync(join(root, ...VIZ, 'architecture.json'), 'utf8'));
const walkText = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
  .map((d) => readFileSync(join(d.parentPath ?? d.path, d.name), 'utf8'));

test('G1 a removed hook registration makes the committed graph stale and names the hook', () => {
  const root = makeRoot();
  apply(root);
  assert.equal(run(root, '--check', '--skip-listed').status, 0, 'a fresh graph must pass');
  const f = join(root, '.claude/settings.json.template');
  const t = JSON.parse(readFileSync(f, 'utf8'));
  t.hooks.PostToolUse = [];
  writeFileSync(f, JSON.stringify(t));
  const r = run(root, '--check', '--skip-listed');
  assert.equal(r.status, 1, 'a graph with a hook the template no longer holds must fail');
  assert.match(r.stdout + r.stderr, /beta\.mjs/);
});

test('G2 an added skill and a removed agent both make the graph stale', () => {
  const root = makeRoot({ agents: ['a-one', 'a-two'] });
  apply(root);
  mkdirSync(join(root, '.claude/skills/s-new'), { recursive: true });
  writeFileSync(join(root, '.claude/skills/s-new/SKILL.md'), '---\nname: s-new\ndescription: New.\n---\n');
  const added = run(root, '--check', '--skip-listed');
  assert.equal(added.status, 1);
  assert.match(added.stdout + added.stderr, /s-new/);
  apply(root);
  rmSync(join(root, '.claude/agents/a-one.md'));
  const removed = run(root, '--check', '--skip-listed');
  assert.equal(removed.status, 1);
  assert.match(removed.stdout + removed.stderr, /a-one/);
});

test('G3 an empty or missing source reads "not checked" and exits 2, never 0', () => {
  const cases = {
    'a template with no hook': makeRoot({ hooks: [] }),
    'no skill folder entry': makeRoot({ skills: [] }),
    'no Waves table': makeRoot({ waves: null }),
    'no agent file': makeRoot({ agents: [] }),
  };
  for (const [name, root] of Object.entries(cases)) {
    const r = run(root, '--check', '--skip-listed');
    assert.equal(r.status, 2, `${name}: exit ${r.status}`);
    assert.match(r.stdout + r.stderr, /not checked/i, name);
  }
});

test('G4 the counts equal a second way of counting on the same tree', () => {
  const root = makeRoot({ skills: ['a', 'b', 'c'], agents: ['x', 'y'], rulesSrc: ['1.md', '2.md', '3.md', '4.md'], rulesOnDemand: ['o.md', 'p.md'] });
  apply(root);
  const stats = graphOf(root).meta.stats;
  assert.equal(stats.skills, readdirSync(join(root, '.claude/skills')).length);
  assert.equal(stats.agents, readdirSync(join(root, '.claude/agents')).filter((n) => n.endsWith('.md')).length);
  assert.equal(stats.rulesSrc, readdirSync(join(root, '.claude/rules-src')).length);
  assert.equal(stats.rulesOnDemand, readdirSync(join(root, '.claude/rules-ondemand')).filter((n) => n.endsWith('.md')).length);
  assert.equal(stats.hookRegistrations, 2);
  assert.equal(stats.reviewLanes, 3);
  const hooksNode = graphOf(root).nodes.find((n) => n.id === 'hooks');
  assert.equal(hooksNode.stats.registrations, 2, 'the node stats come from the registry, not from the authored text');
});

test('G5 the three files of the system map hold no Braintrust text', () => {
  // Scope: the map itself. The other pages of the folder (hub, hooks, agents, the Braintrust page, state-of-rework) are separate history.
  const dir = join(REPO, ...VIZ);
  assert.ok(existsSync(join(dir, 'architecture.src.json')), 'the authored source file must exist');
  for (const name of ['architecture.src.json', 'architecture.json', 'index.html']) {
    const hits = (readFileSync(join(dir, name), 'utf8').match(/braintrust/gi) || []).length;
    assert.equal(hits, 0, `${hits} Braintrust hits left in ${name}`);
  }
});

test('G6 a listed id in the authored text fails the check; without an id list the result is "not checked"', async () => {
  const ID = 'a1b2c3d4e5f6'; // made up: a sha shaped id
  const root = makeRoot({ src: SRC({ meta: { name: 'Fixture map', tagline: `see ${ID}`, description: 'x', platform: 'test', sources: [] } }) });
  apply(root);
  const hit = await need('checkOutputs')(root, { listedIds: [ID] });
  assert.equal(hit.exitCode, 1);
  assert.ok(hit.problems.some((p) => /listed/i.test(p)), 'the problem names the listed id count');
  assert.ok(!JSON.stringify(hit).includes(ID), 'the result never prints an id');
  const cleanRoot = makeRoot();
  apply(cleanRoot);
  const clean = await need('checkOutputs')(cleanRoot, { listedIds: [ID] });
  assert.equal(clean.exitCode, 0, 'a fresh graph without the id passes');
  const none = await need('checkOutputs')(root, { listedIds: null });
  assert.equal(none.exitCode, 2, 'no id list: not checked, not a pass');
});

test('G7 the embedded block of index.html equals architecture.json, on a fixture and on the repo', () => {
  const root = makeRoot();
  apply(root);
  const html = join(root, ...VIZ, 'index.html');
  const block = (text) => JSON.parse(/<script type="application\/json" id="embedded-data">([\s\S]*?)<\/script>/.exec(text)[1].replace(/<\\\//g, '</'));
  assert.deepEqual(block(readFileSync(html, 'utf8')), graphOf(root));
  writeFileSync(html, readFileSync(html, 'utf8').replace(/"skills": 2/, '"skills": 9'));
  assert.equal(run(root, '--check', '--skip-listed').status, 1, 'a block that differs from the file fails the check');
  const real = readFileSync(join(REPO, ...VIZ, 'index.html'), 'utf8');
  assert.deepEqual(block(real), JSON.parse(readFileSync(join(REPO, ...VIZ, 'architecture.json'), 'utf8')), 'the real page and file must agree');
});

test('G8 two runs and a different creation order give byte-equal output with no timestamp', () => {
  const a = makeRoot({ skills: ['s-one', 's-two', 's-three'], agents: ['a2', 'a1'] });
  const b = makeRoot({ skills: ['s-three', 's-two', 's-one'], agents: ['a1', 'a2'], hooks: [['PostToolUse', 'Edit', 'beta.mjs'], ['PreToolUse', 'Bash', 'alpha.mjs']] });
  apply(a); apply(b);
  const read = (r) => readFileSync(join(r, ...VIZ, 'architecture.json'), 'utf8');
  assert.equal(read(a), read(b), 'the order of the sources must not change the output');
  const before = read(a);
  apply(a);
  assert.equal(read(a), before, 'a second run changes nothing');
  assert.doesNotMatch(before, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no ISO time in the committed graph');
});

test('G9 a hook entry that is not a node entry with args is counted, not dropped', () => {
  const root = makeRoot({ raw: 2 });
  apply(root);
  const g = graphOf(root);
  assert.equal(g.registry.hooks.unparsed, 2);
  assert.equal(g.registry.hooks.items.length, 2);
  assert.equal(g.nodes.find((n) => n.id === 'hooks').stats.unparsed, 2);
});

test('G10 the authored text holds no hand-set count of hooks, skills or agents', () => {
  const f = join(REPO, ...VIZ, 'architecture.src.json');
  assert.ok(existsSync(f), 'the authored source file must exist');
  const strings = [];
  JSON.parse(readFileSync(f, 'utf8'), (_k, v) => { if (typeof v === 'string') strings.push(v); return v; });
  const bad = strings.filter((s) => /\b\d+\+?\s+(?:tiny\s+|small\s+)?(?:TypeScript\s+)?(?:hooks?|skills?|agents?|rules?)\b/i.test(s));
  assert.deepEqual(bad, [], 'a count in prose goes stale: show it from the registry');
});

test('G11 the MCP count is "not checked", and a machine config is never read', () => {
  const root = makeRoot();
  apply(root);
  const g = graphOf(root);
  assert.equal(g.registry.mcp.status, 'not checked');
  assert.equal(g.meta.stats.mcpServers, undefined, 'no count of MCP servers in the stats');
  for (const t of walkText(join(root, ...VIZ))) assert.ok(!t.includes('SENTINEL_SECRET_VALUE'), 'a machine config value reached the output');
});

test('G12 the stats script is a wrapper: --apply writes the generator output, a second run says no changes', () => {
  const root = makeRoot();
  const first = spawnSync(process.execPath, [WRAPPER, '--root', root, '--apply'], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const generated = graphOf(root);
  const direct = makeRoot();
  apply(direct);
  assert.deepEqual(generated, graphOf(direct));
  const again = spawnSync(process.execPath, [WRAPPER, '--root', root, '--apply'], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /no changes/i);
});

test('G14 a stale graph names the command that rebuilds it and the two files to stage', () => {
  const root = makeRoot();
  apply(root);
  mkdirSync(join(root, '.claude/skills/s-extra'), { recursive: true });
  writeFileSync(join(root, '.claude/skills/s-extra/SKILL.md'), '---\nname: s-extra\ndescription: Extra.\n---\n');
  const r = run(root, '--check', '--skip-listed');
  assert.equal(r.status, 1);
  const text = r.stdout + r.stderr;
  assert.match(text, /node scripts\/architecture\/build-system-map\.mjs --apply/, 'the failure text must name the rebuild command');
  assert.match(text, /docs\/architecture\/system-visualization\/architecture\.json/, 'and the first file to stage');
  assert.match(text, /docs\/architecture\/system-visualization\/index\.html/, 'and the second file to stage');
  const empty = run(makeRoot({ skills: [] }), '--check', '--skip-listed');
  assert.doesNotMatch(empty.stdout, /--apply/, 'a "not checked" result is not fixed by a rebuild, so it names no rebuild');
});

test('G13 the committed graph and page of this repo are fresh against the real sources', () => {
  const r = spawnSync(process.execPath, [GEN, '--root', REPO, '--check', '--skip-listed'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /registered hook/i, 'the check prints the counts it compared');
});

// Rows G15 to G21: the CodeRabbit CLI findings of pre-pr run 1 that the seat ordered fixed (items 1, 2, 6, 9, 10, 5, 7).
test('G15 a missing authored map reads "not checked" (exit 2) in check mode, a malformed one stays a bad file (exit 1)', () => {
  const root = makeRoot();
  apply(root);
  const f = join(root, ...VIZ, 'architecture.src.json');
  const good = readFileSync(f, 'utf8');
  rmSync(f);
  const missing = run(root, '--check', '--skip-listed');
  assert.equal(missing.status, 2, `${missing.stdout}${missing.stderr}`);
  assert.match(missing.stdout, /not checked/i);
  writeFileSync(f, '{ not json');
  assert.equal(run(root, '--check', '--skip-listed').status, 1, 'a malformed authored map is a bad file, not a pass');
  writeFileSync(f, good);
});

test('G16 the embedded block holds no < at all: every one is written as \\u003c and decodes back', () => {
  const tag = 'x <!-- <script> y </script> z';
  const root = makeRoot({ src: SRC({ meta: { name: 'Fixture map', tagline: tag, description: 'x', platform: 'test', sources: [] } }) });
  apply(root);
  const html = readFileSync(join(root, ...VIZ, 'index.html'), 'utf8');
  const block = /<script type="application\/json" id="embedded-data">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(!block.includes('<'), 'a < inside the block can start a comment or a tag in the HTML parser');
  assert.equal(JSON.parse(block).meta.tagline, tag, 'the decoded text is unchanged');
});

test('G17 a directory named like a rule or an agent file is not counted', () => {
  const root = makeRoot({ rulesSrc: ['r1.md'], agents: ['a-one'] });
  mkdirSync(join(root, '.claude/rules-src/dir.md'));
  mkdirSync(join(root, '.claude/agents/dir.md'));
  apply(root);
  const stats = graphOf(root).meta.stats;
  assert.equal(stats.rulesSrc, 1);
  assert.equal(stats.agents, 1);
  const only = makeRoot({ rulesSrc: [] });
  mkdirSync(join(only, '.claude/rules-src'), { recursive: true });
  mkdirSync(join(only, '.claude/rules-src/dir.md'));
  assert.equal(run(only, '--check', '--skip-listed').status, 2, 'a folder with no rule file is "not checked"');
});

test('G18 a committed registry of the wrong shape still ends with the rebuild line', () => {
  const root = makeRoot();
  apply(root);
  const f = join(root, ...VIZ, 'architecture.json');
  const g = JSON.parse(readFileSync(f, 'utf8'));
  g.registry.skills = {};
  writeFileSync(f, JSON.stringify(g));
  const r = run(root, '--check', '--skip-listed');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /build-system-map\.mjs --apply/, 'no crash: the rebuild line is printed');
});

test('G19 apply scans the authored map too: a listed id in it stops the write', async () => {
  const ID = 'a1b2c3d4e5f6'; // made up
  const root = makeRoot({ src: SRC({ meta: { name: 'Fixture map', tagline: 'x', description: 'x', platform: 'test', sources: [], generatedBy: `see ${ID}` } }) });
  const code = await need('main')(['--root', root, '--apply'], () => {}, { listedIds: [ID] });
  assert.equal(code, 1);
  assert.ok(!existsSync(join(root, ...VIZ, 'architecture.json')), 'nothing was written');
});

test('G20 a stale diagnostic never prints a listed id', async () => {
  const ID = 'a1b2c3d4e5f6'; // made up: a skill named like an id
  const root = makeRoot();
  apply(root);
  mkdirSync(join(root, `.claude/skills/${ID}`), { recursive: true });
  writeFileSync(join(root, `.claude/skills/${ID}/SKILL.md`), `---\nname: ${ID}\ndescription: x\n---\n`);
  const r = await need('checkOutputs')(root, { listedIds: [ID] });
  assert.equal(r.exitCode, 1);
  assert.ok(!JSON.stringify(r).includes(ID), 'problems and lines hold counts only');
  assert.ok(r.lines.some((l) => /build-system-map\.mjs --apply/.test(l)), 'the rebuild line stays');
});

test('G21 a failed write leaves both files as they were (temp file, then rename)', () => {
  const root = makeRoot();
  mkdirSync(join(root, ...VIZ, 'index.html.tmp'));
  const before = readFileSync(join(root, ...VIZ, 'index.html'), 'utf8');
  const r = run(root, '--apply', '--skip-listed');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.ok(!existsSync(join(root, ...VIZ, 'architecture.json')), 'the json was not written before the html failed');
  assert.equal(readFileSync(join(root, ...VIZ, 'index.html'), 'utf8'), before, 'the template is intact for a retry');
  rmSync(join(root, ...VIZ, 'index.html.tmp'), { recursive: true });
  apply(root);
  assert.equal(readdirSync(join(root, ...VIZ)).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file is left');
});

test('G22 a Node option before the hook file is not read as the hook name', () => {
  const root = makeRoot({ hooks: [['PreToolUse', 'Bash', 'alpha.mjs']] });
  const f = join(root, '.claude', 'settings.json.template');
  const t = JSON.parse(readFileSync(f, 'utf8'));
  const dist = (n) => `{{CLAUDE_HOME}}/hooks/dist/${n}`;
  t.hooks.PreToolUse.push({ matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: ['--no-warnings', dist('gamma.mjs')] }] });
  t.hooks.PreToolUse.push({ matcher: 'Write', hooks: [{ type: 'command', command: 'node', args: ['--require', dist('pre.cjs'), dist('delta.mjs')] }] });
  writeFileSync(f, JSON.stringify(t, null, 2));
  apply(root);
  const hooks = graphOf(root).registry.hooks;
  const names = hooks.items.map((h) => h.file);
  assert.ok(names.includes('gamma.mjs'), `a boolean option is skipped: ${names}`);
  assert.ok(!names.some((n) => n.startsWith('-')), `no hook is named like an option: ${names}`);
  assert.ok(!names.includes('pre.cjs'), 'the value of an option that takes one is not the hook');
  assert.equal(hooks.unparsed, 1, 'an option that takes a value cannot be read with certainty: counted as unparsed, never guessed');
});

test('G23 a rename that fails after the first one puts the first file back (no mixed outputs)', () => {
  const writeAll = need('writeAll');
  const dir = mkdtempSync(join(tmpdir(), 'sysmap-wa-'));
  roots.push(dir);
  const a = join(dir, 'a.json'), b = join(dir, 'b.html');
  writeFileSync(a, 'old a'); writeFileSync(b, 'old b');
  let calls = 0;
  const failSecond = (from, to) => { calls += 1; if (calls === 2) throw new Error('forced rename failure'); return fsRename(from, to); };
  assert.throws(() => writeAll([[a, 'new a'], [b, 'new b']], { renameSync: failSecond }), /forced rename failure/);
  assert.equal(readFileSync(a, 'utf8'), 'old a', 'the first file is back as it was');
  assert.equal(readFileSync(b, 'utf8'), 'old b', 'the second file never changed');
  assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'b.html'], 'no temp or backup file is left');
});

test('G24 no page of the system-visualization folder outside archive/ holds Braintrust text; the retired pages are moved, and every hub link resolves', () => {
  // SYSMAP_VIZ_REPO lets a drill run this row against an older checkout (the RED proof).
  const repo = process.env.SYSMAP_VIZ_REPO ?? REPO;
  const dir = join(repo, ...VIZ);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? d.path, d.name)).filter((f) => !/^archive[\\/]/.test(relative(dir, f)));
  assert.ok(files.length >= 7, `the folder has its pages (${files.length} files)`);
  const bad = files.filter((f) => /braintrust/i.test(readFileSync(f, 'utf8'))).map((f) => relative(dir, f));
  assert.deepEqual(bad, [], `Braintrust text left in: ${bad.join(', ')}`);
  assert.ok(existsSync(join(dir, 'archive', 'braintrust-scoring-visualization.html')), 'the Braintrust page is archived, not deleted');
  assert.ok(existsSync(join(dir, 'archive', 'state-of-rework', 'state-of-rework.html')), 'the state-of-rework tree is archived, not deleted');
  const hub = readFileSync(join(dir, 'hub.html'), 'utf8');
  const links = [...hub.matchAll(/href="(\.{1,2}\/[^"#?]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 5, 'the hub links its views');
  const dead = links.filter((l) => !existsSync(resolve(dir, l)));
  assert.deepEqual(dead, [], `hub links that do not resolve: ${dead.join(', ')}`);
});

test('G25 an unknown Node option before the hook file makes the entry unparsed; known flag-only options and --x=y forms still parse', () => {
  const root = makeRoot({ hooks: [['PreToolUse', 'Bash', 'alpha.mjs']] });
  const f = join(root, '.claude', 'settings.json.template');
  const t = JSON.parse(readFileSync(f, 'utf8'));
  const dist = (n) => `{{CLAUDE_HOME}}/hooks/dist/${n}`;
  const add = (matcher, args) => t.hooks.PreToolUse.push({ matcher, hooks: [{ type: 'command', command: 'node', args }] });
  add('A', ['--title', 'worker', dist('titled.mjs')]); // Node takes "worker" as the title: unknown option, cannot be read
  add('B', ['--enable-source-maps', dist('maps.mjs')]);
  add('C', ['--max-old-space-size=256', dist('heap.mjs')]);
  add('D', ['--no-warnings', '--enable-source-maps', dist('both.mjs')]);
  writeFileSync(f, JSON.stringify(t, null, 2));
  apply(root);
  const hooks = graphOf(root).registry.hooks;
  const names = hooks.items.map((h) => h.file);
  assert.ok(!names.includes('worker') && !names.includes('titled.mjs'), `an unknown option is never guessed: ${names}`);
  assert.equal(hooks.unparsed, 1, 'the unknown option entry is counted as unparsed');
  for (const n of ['maps.mjs', 'heap.mjs', 'both.mjs']) assert.ok(names.includes(n), `${n} still parses: ${names}`);
});

test('G26 writeAll refuses to start when a backup file of an older crash exists, names it, and leaves everything as it was', () => {
  const writeAll = need('writeAll');
  const dir = mkdtempSync(join(tmpdir(), 'sysmap-bak-'));
  roots.push(dir);
  const a = join(dir, 'a.json'), b = join(dir, 'b.html');
  writeFileSync(a, 'old a'); writeFileSync(b, 'old b'); writeFileSync(`${a}.bak`, 'precious older copy');
  assert.throws(() => writeAll([[a, 'new a'], [b, 'new b']]), (e) => e.message.includes('a.json.bak'), 'the error names the backup');
  assert.equal(readFileSync(`${a}.bak`, 'utf8'), 'precious older copy', 'the older backup is not touched');
  assert.equal(readFileSync(a, 'utf8'), 'old a');
  assert.equal(readFileSync(b, 'utf8'), 'old b');
  assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'a.json.bak', 'b.html'], 'no temp file is left');
});

test('G27 when the restore of the first file also fails, its backup is kept and named in the error', () => {
  const writeAll = need('writeAll');
  const dir = mkdtempSync(join(tmpdir(), 'sysmap-keep-'));
  roots.push(dir);
  const a = join(dir, 'a.json'), b = join(dir, 'b.html');
  writeFileSync(a, 'old a'); writeFileSync(b, 'old b');
  let calls = 0;
  const failSecondAndRestore = (from, to) => { calls += 1; if (calls >= 2) throw new Error(`forced failure ${calls}`); return fsRename(from, to); };
  assert.throws(() => writeAll([[a, 'new a'], [b, 'new b']], { renameSync: failSecondAndRestore }), (e) => e.message.includes('a.json.bak'), 'the error names the kept backup');
  assert.equal(readFileSync(`${a}.bak`, 'utf8'), 'old a', 'the only good copy of the first file is kept');
  assert.ok(!existsSync(`${b}.bak`), 'a backup whose file never changed is removed');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file is left');
});
