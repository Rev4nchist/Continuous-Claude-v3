// Tests for app-ask.mjs: the offer writer of the tap gate for a COVERED app repo (card coord-decision-gate-app-repos, section 3 T-A, seat condition G2).
// Run: node --test scripts/github/app-ask.test.mjs
// The CLI tests run the real script in real temp git repos. Every run sets a scratch decision store, a scratch registry, a scratch git
// config and a scratch home, so no test reads or writes the real store. The one gh fact (merge) comes from the --facts seam, which needs
// APP_ASK_TEST=1 and a store other than the default; the seam-off test is in-process with an injected gh runner, never the CLI.
//
// How the unit can fail, and the test that catches it (the source change that breaks it):
//   push writes another step, key, head, tree or label than the contract       -> AA1, AA2   (change STORE_STEP.push, the key, or which tree the label binds)
//   push refuses when nothing is staged and nothing is ahead (fix round 1, F3)  -> AA2b       (the old nothing-to-push refusal)
//   open-pr binds a tree, or the HEAD sha for another branch                    -> AA3        (use HEAD for --branch B)
//   merge writes another step, key or label, or prints a next step without -R and --match-head-commit -> AA4
//   merge offers a draft or a closed PR                                         -> AA5        (drop the draft or state check)
//   a CCv3 checkout gets an app offer                                           -> AA6        (drop the CCv3 refusal)
//   a push with no named remote and no @{push} picks a remote itself            -> AA7        (auto-pick the sole remote)
//   the remote choice or its URL is wrong                                       -> AA8, AA8b  (ignore --remote; ignore @{push})
//   the local: key is wrong or a nested folder matches a parent entry           -> AA9        (prefix match; last entry wins; no entry still writes)
//   open-pr or merge write a local: key that gh -R cannot use                   -> AA9b       (drop the local: refusal)
//   an invisible character or a newline reaches the question (G2)               -> AA10, AA11 (drop oneLine from one repo-derived value)
//   the key loses the raw branch, or two repos share a key                      -> AA10, AA12 (oneLine on the key; constant repo in the key)
//   the --facts seam works on the real store, or without the switch             -> AA13       (drop either guard of seamsOn)
//   bad usage writes an offer                                                   -> AA14       (write before parse)
// Fix round 1, fixer C (ONE key rule with the gate, lib/repo-identity.mjs):
//   --branch and --src name another branch than HEAD: wrong key or tree          -> AA17, AA18 (key on the current branch; refs/heads/<dest>)
//   a URL remote is refused                                                     -> AA19       (the old not-a-remote refusal)
//   open-pr or merge keyed on the push URL                                      -> AA20       (fetchKey reads --push)
//   an SSH host alias ignores the github field                                  -> AA21       (keyRepo without github)
//   a bare push keys on the current branch under push.default=upstream          -> AA22       (no @{push} branch)
//   two pushurls of two repos give one key                                      -> AA23       (first pushurl only)
//   a remote named team/fork                                                    -> AA24       (split('/')[0], or the URL test first)
//   the seam works on the real store in another case, or outside the temp folder -> AA13      (path.resolve compare only)
//   an SSH alias of an entry with no github field is a dead end with no way out -> AA25       (fix round 2, fixer G: drop the refusal text)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'app-ask.mjs');
const load = () => import(pathToFileURL(SCRIPT).href);
const loadStore = () => import(pathToFileURL(path.join(HERE, 'lib', 'decisions.mjs')).href);
import { normPath } from './lib/repo-identity.mjs';
const fwd = (p) => p.replace(/\\/g, '/');
const FORGE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A scratch world: home, store, registry and git config, all in one temp folder. */
function world() {
  const root = fwd(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'appask-'))));
  const w = { root, store: `${root}/store.json`, registry: `${root}/registry.json`, gitconfig: `${root}/gitconfig`, home: `${root}/home` };
  mkdirSync(w.home);
  writeFileSync(w.gitconfig, '');
  return w;
}
const envOf = (w, extra = {}) => {
  const env = {
    ...process.env, HOME: w.home, USERPROFILE: w.home, CCV3_DECISIONS_FILE: w.store, LANE_REGISTRY_PATH: w.registry, APP_ASK_TEST: '1',
    GIT_CONFIG_GLOBAL: w.gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra,
  };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
};
const git = (w, dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, env: envOf(w), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A repo with one commit on `branch`, and the remotes { name: url }. */
function repo(w, name, { branch = 'feat/x', remotes = {} } = {}) {
  const dir = `${w.root}/${name}`;
  mkdirSync(dir, { recursive: true });
  git(w, dir, 'init', '-q', '-b', 'main');
  writeFileSync(`${dir}/a.txt`, 'a\n');
  git(w, dir, 'add', 'a.txt');
  git(w, dir, 'commit', '-q', '-m', 'a');
  for (const [n, url] of Object.entries(remotes)) git(w, dir, 'remote', 'add', n, url);
  git(w, dir, 'checkout', '-q', '-b', branch);
  return dir;
}
const commitFile = (w, dir, file) => { writeFileSync(`${dir}/${file}`, `${file}\n`); git(w, dir, 'add', file); git(w, dir, 'commit', '-q', '-m', file); };
const stage = (w, dir, file) => { writeFileSync(`${dir}/${file}`, `${file}\n`); git(w, dir, 'add', file); };
const writeRegistry = (w, projects) => writeFileSync(w.registry, JSON.stringify({ version: '1.0', projects }));
const run = (w, dir, args, extra = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir ?? w.root, env: envOf(w, extra), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const offers = (w) => (existsSync(w.store) ? Object.values(JSON.parse(readFileSync(w.store, 'utf8')).offers) : []);
const noOffer = (w) => assert.equal(offers(w).length, 0, 'a refusal must write no offer');
const ACME = 'https://github.com/Acme/App.git';
const OTHER = 'git@github.com:Other/Lib.git';
const factsFile = (w, facts) => { const f = `${w.root}/facts-${Math.random().toString(36).slice(2)}.json`; writeFileSync(f, JSON.stringify(facts)); return f; };
const PRHEAD = 'AbC1234def5678abc9012def3456abc7890def12';
const OPEN_FACTS = { headRefOid: PRHEAD, state: 'OPEN', isDraft: false, title: 'fix: cut the cache miss' };

test('AA1: push with a staged file writes step ship, the lowercased repo and the raw branch as key, HEAD as head, the index tree, and the two labels', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  stage(w, dir, 'b.txt');
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--json']);
  assert.equal(r.code, 0, r.err);
  const [offer] = offers(w);
  assert.equal(offer.step, 'ship');
  assert.equal(offer.key, 'acme/app@feat/x');
  assert.equal(offer.head, git(w, dir, 'rev-parse', 'HEAD'));
  assert.equal(offer.tree, git(w, dir, 'write-tree'));
  assert.notEqual(offer.tree, git(w, dir, 'rev-parse', 'HEAD^{tree}'), 'the staged tree differs from the HEAD tree');
  assert.deepEqual(offer.labels, ['Commit and push (Recommended)', 'Not now']);
  const spec = JSON.parse(r.out);
  assert.deepEqual(spec, offer.spec, 'the printed spec is the stored spec');
  assert.equal(spec.header, 'App push');
  assert.ok(spec.question.split('\n').length <= 3);
  assert.ok(spec.question.includes('acme/app') && spec.question.includes(offer.head.slice(0, 7)) && spec.question.includes(offer.tree.slice(0, 7)), spec.question);
  assert.equal(spec.options.length, 2);
});

test('AA2: push with nothing staged and a commit not on the remote writes Push only (Recommended) bound to the HEAD tree', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  commitFile(w, dir, 'b.txt');
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'origin']);
  assert.equal(r.code, 0, r.err);
  const [offer] = offers(w);
  assert.deepEqual(offer.labels, ['Push only (Recommended)', 'Not now']);
  assert.equal(offer.tree, git(w, dir, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(offer.head, git(w, dir, 'rev-parse', 'HEAD'));
  assert.equal(offer.step, 'ship');
  assert.ok(r.out.startsWith('App push: '), r.out);
});

// Fix round 1 (F3): the remote may still need the ref (main fast-forwarded to a pushed commit, a new branch at a pushed commit), and the
// gate denies that push with no tap. So nothing ahead still writes the Push only offer. Change that breaks it: the old nothing-to-push refusal.
test('AA2b: push with nothing staged and nothing ahead of the remote still writes Push only, bound to the HEAD tree', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  git(w, dir, 'update-ref', 'refs/remotes/origin/feat/x', 'HEAD');
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--json']);
  assert.equal(r.code, 0, r.err);
  const [offer] = offers(w);
  assert.deepEqual(offer.labels, ['Push only (Recommended)', 'Not now']);
  assert.equal(offer.tree, git(w, dir, 'rev-parse', 'HEAD^{tree}'));
  assert.match(JSON.parse(r.out).question, /State: .*0 commits not on the remote/);
});

test('AA3: open-pr writes step open-pr, a branch key, the branch tip as head, no tree, and Open draft PR (Recommended); --branch uses that tip, not HEAD', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  const tip = git(w, dir, 'rev-parse', 'HEAD');
  git(w, dir, 'checkout', '-q', '-b', 'other/y');
  commitFile(w, dir, 'c.txt');
  const r = run(w, dir, ['open-pr', '--dir', dir, '--remote', 'origin', '--branch', 'feat/x', '--base', 'main', '--json']);
  assert.equal(r.code, 0, r.err);
  const [offer] = offers(w);
  assert.equal(offer.step, 'open-pr');
  // Fix round 5 re-pin (F8): --base main is in the key (repo-identity.mjs openPrKey), so a tap for one base never licenses another.
  assert.equal(offer.key, 'acme/app@feat/x:main');
  assert.equal(offer.head, tip);
  assert.notEqual(offer.head, git(w, dir, 'rev-parse', 'HEAD'));
  assert.equal(offer.tree, null);
  assert.deepEqual(offer.labels, ['Open draft PR (Recommended)', 'Not now']);
  const spec = JSON.parse(r.out);
  assert.equal(spec.header, 'App PR');
  assert.ok(spec.question.includes('acme/app') && spec.question.includes(tip.slice(0, 7)) && spec.question.split('\n').length <= 3, spec.question);
});

test('AA4: merge writes step land, the repo#PR key, the PR head sha as head and the exact label; the next step carries -R and --match-head-commit', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  const facts = factsFile(w, OPEN_FACTS);
  const r = run(w, dir, ['merge', '--dir', dir, '--remote', 'origin', '--pr', '7', '--facts', facts]);
  assert.equal(r.code, 0, r.err);
  const [offer] = offers(w);
  assert.equal(offer.step, 'land');
  assert.equal(offer.key, 'acme/app#7');
  assert.equal(offer.head, PRHEAD.toLowerCase());
  assert.equal(offer.tree, null);
  assert.deepEqual(offer.labels, ['Merge now (no READY check)', 'Not now']);
  assert.equal(offer.spec.header, 'App merge');
  const next = r.out.split('\n').find((l) => l.startsWith('next: '));
  assert.ok(next, r.out);
  assert.ok(next.includes('-R acme/app') && next.includes(`--match-head-commit ${PRHEAD.toLowerCase()}`) && next.includes(' 7 '), next);
  const j = run(w, dir, ['merge', '--dir', dir, '--remote', 'origin', '--pr', '7', '--facts', facts, '--json']);
  assert.equal(j.code, 0, j.err);
  assert.deepEqual(JSON.parse(j.out), offers(w)[0].spec, '--json stdout is the spec only');
  assert.ok(j.err.includes('--match-head-commit'), 'the next step goes to stderr with --json');
});

test('AA5: merge of a draft PR, a closed PR or a merged PR is refused, exit 1, no offer', () => {
  for (const facts of [{ ...OPEN_FACTS, isDraft: true }, { ...OPEN_FACTS, state: 'CLOSED' }, { ...OPEN_FACTS, state: 'MERGED' }, { ...OPEN_FACTS, headRefOid: 'nothex' }]) {
    const w = world();
    const dir = repo(w, 'app', { remotes: { origin: ACME } });
    const r = run(w, dir, ['merge', '--dir', dir, '--remote', 'origin', '--pr', '7', '--facts', factsFile(w, facts)]);
    assert.equal(r.code, 1, JSON.stringify(facts));
    noOffer(w);
  }
});

test('AA6: a CCv3 checkout is refused with a text that names ship-ask.mjs, for every sub-command and every remote name', () => {
  for (const url of ['https://github.com/Rev4nchist/Continuous-Claude-v3.git', 'git@github.com:rev4nchist/continuous-claude-v3', 'ssh://git@github.com/REV4NCHIST/Continuous-Claude-V3/']) {
    const w = world();
    const dir = repo(w, 'ccv3', { remotes: { mine: ACME, weird: url } });
    stage(w, dir, 'b.txt');
    for (const args of [['push', '--remote', 'mine'], ['open-pr', '--remote', 'mine'], ['merge', '--remote', 'mine', '--pr', '3', '--facts', factsFile(w, OPEN_FACTS)]]) {
      const r = run(w, dir, [...args, '--dir', dir]);
      assert.equal(r.code, 1, `${args[0]} ${url}: ${r.err}`);
      assert.ok(r.err.includes('ship-ask.mjs'), r.err);
    }
    noOffer(w);
  }
});

// The push rule and the create rule of the gate differ, and app-ask follows each (repo-identity.mjs pushKey and ghRemote): a push with
// no remote named and no @{push} names no remote, even with one remote; a create with no -R uses the only remote, as gh does.
test('AA7: push with no --remote and no @{push} is exit 1 "name the remote", even with one remote; open-pr takes the only remote', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  stage(w, dir, 'b.txt');
  const r = run(w, dir, ['push', '--dir', dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /name the remote/i);
  // an upstream whose tracking ref is missing: git cannot resolve @{push}, so the remote is still not named
  git(w, dir, 'config', 'branch.feat/x.remote', 'origin');
  git(w, dir, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');
  assert.equal(run(w, dir, ['push', '--dir', dir]).code, 1);
  noOffer(w);
  const o = run(w, dir, ['open-pr', '--dir', dir, '--json']);
  assert.equal(o.code, 0, o.err);
  assert.equal(offers(w)[0].key, 'acme/app@feat/x');
  // two remotes and no @{push}: no remote is named for open-pr either
  const w2 = world();
  const two = repo(w2, 'app', { remotes: { origin: ACME, up: OTHER } });
  const t = run(w2, two, ['open-pr', '--dir', two]);
  assert.equal(t.code, 1);
  assert.match(t.err, /name the remote/i);
  noOffer(w2);
});

test('AA8: with two remotes --remote decides the key repo; a remote that does not exist is exit 1', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME, up: OTHER } });
  stage(w, dir, 'b.txt');
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--json']).code, 0);
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'up', '--json']).code, 0);
  assert.deepEqual(offers(w).map((o) => o.key).sort(), ['acme/app@feat/x', 'other/lib@feat/x']);
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'nope']);
  assert.equal(r.code, 1);
  assert.equal(offers(w).length, 2);
});

test('AA8b: without --remote the remote of @{push} decides, read the way the gate reads it', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME, up: OTHER } });
  stage(w, dir, 'b.txt');
  git(w, dir, 'update-ref', 'refs/remotes/up/feat/x', git(w, dir, 'rev-parse', 'main'));
  git(w, dir, 'config', 'branch.feat/x.remote', 'up');
  git(w, dir, 'config', 'branch.feat/x.merge', 'refs/heads/feat/x');
  assert.equal(git(w, dir, 'rev-parse', '--abbrev-ref', '@{push}'), 'up/feat/x', 'the fixture: @{push} resolves');
  const r = run(w, dir, ['push', '--dir', dir, '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(offers(w)[0].key, 'other/lib@feat/x');
});

test('AA9: with no GitHub remote the key repo is local:<registry entry key>, found by root equality, first entry first; a nested folder or an unregistered one is exit 1', () => {
  const w = world();
  const dir = repo(w, 'localapp', { remotes: { origin: `${w.root}/bare.git` } });
  stage(w, dir, 'b.txt');
  writeRegistry(w, [{ name: 'Local App', key: 'localapp', path: dir, status: 'active' }, { key: 'dupe', path: dir }, { key: 'relative', path: 'localapp' }]);
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--json']);
  assert.equal(r.code, 0, r.err);
  const target = normPath(`${w.root}/bare.git`);
  assert.equal(offers(w)[0].key, `local:localapp:${target}@feat/x`);
  // the entry has no key: the slug of its name, as the gate reader does
  writeRegistry(w, [{ name: 'My Local App!', path: dir }]);
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'origin']).code, 0);
  assert.ok(offers(w).some((o) => o.key === `local:my-local-app:${target}@feat/x`));
  // the registry path in another spelling of the same folder (backslashes, a trailing slash) is the same root (normPath of tap-scope.ts)
  writeRegistry(w, [{ key: 'spelled', path: `${dir.replace(/\//g, '\\')}\\` }]);
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'origin']).code, 0);
  assert.ok(offers(w).some((o) => o.key === `local:spelled:${target}@feat/x`));
  // a registry root that is only a PARENT of the folder does not match
  const w2 = world();
  const nested = repo(w2, 'parent/child', { remotes: { origin: `${w2.root}/bare.git` } });
  stage(w2, nested, 'b.txt');
  writeRegistry(w2, [{ key: 'parent', path: `${w2.root}/parent` }]);
  const n = run(w2, nested, ['push', '--dir', nested, '--remote', 'origin']);
  assert.equal(n.code, 1);
  assert.match(n.err, /registry/i);
  noOffer(w2);
  // registry missing: exit 1
  const w3 = world();
  const d3 = repo(w3, 'x', { remotes: { origin: `${w3.root}/bare.git` } });
  stage(w3, d3, 'b.txt');
  assert.equal(run(w3, d3, ['push', '--dir', d3, '--remote', 'origin']).code, 1);
  noOffer(w3);
});

test('AA9b: open-pr and merge with no GitHub remote are exit 1: gh cannot take a local: key with -R', () => {
  const w = world();
  const dir = repo(w, 'localapp', { remotes: { origin: `${w.root}/bare.git` } });
  writeRegistry(w, [{ key: 'localapp', path: dir }]);
  for (const args of [['open-pr'], ['merge', '--pr', '4', '--facts', factsFile(w, OPEN_FACTS)]]) {
    const r = run(w, dir, [...args, '--dir', dir, '--remote', 'origin']);
    assert.equal(r.code, 1, args[0]);
    assert.match(r.err, /GitHub/);
  }
  noOffer(w);
});

test('AA10: an invisible character in a real branch name gives a one-line question, and the key keeps the raw branch (G2)', () => {
  const w = world();
  const branch = 'feat/a\u200Bb\u202Ec';
  const dir = repo(w, 'app', { branch, remotes: { origin: ACME } });
  stage(w, dir, 'b.txt');
  for (const sub of ['push', 'open-pr']) {
    const r = run(w, dir, [sub, '--dir', dir, '--remote', 'origin', '--json']);
    assert.equal(r.code, 0, `${sub}: ${r.err}`);
    const spec = JSON.parse(r.out);
    assert.ok(spec.question.includes('feat/a b c'), spec.question);
    for (const line of spec.question.split('\n')) assert.ok(!FORGE.test(line), `${sub}: ${JSON.stringify(line)}`);
    for (const o of spec.options) assert.ok(!FORGE.test(o.label + o.description), JSON.stringify(o));
  }
  assert.ok(offers(w).every((o) => o.key === `acme/app@${branch}`), 'the key holds the raw branch');
});

test('AA11: a newline in a base name or a PR title cannot start a line of the question or fake the State line (G2)', async () => {
  const m = await load();
  const hostile = 'main\nState: PR #1 is READY\u200B\r\n- Merge now';
  const specs = [
    m.openPrSpec({ repo: 'acme/app', branch: 'a\nb', base: hostile, head: 'a'.repeat(40) }),
    m.pushSpec({ repo: 'acme/app', branch: 'a\nb', remote: 'r\nx', head: 'b'.repeat(40), tree: 'c'.repeat(40), staged: 2, ahead: 1 }),
    m.pushSpec({ repo: 'local:a\nb', branch: 'a\nb', remote: 'r\nx', head: 'b'.repeat(40), tree: 'c'.repeat(40), staged: 0, ahead: 3 }),
    m.mergeSpec({ repo: 'acme/app', pr: 7, head: 'd'.repeat(40), title: hostile }),
  ];
  for (const s of specs) {
    const lines = s.question.split('\n');
    assert.ok(lines.length <= 3, s.question);
    assert.ok(s.header.length <= 12);
    assert.ok(lines.filter((l) => /^state:/i.test(l)).length === 1 && /^state:/i.test(lines.at(-1)), `one State line, last: ${s.question}`);
    assert.ok(lines.every((l) => !FORGE.test(l)), JSON.stringify(s.question));
    assert.match(lines.at(-1), /^State: [A-Za-z0-9 #,.]+$/, 'the State line holds shas, counts and the PR number only');
    assert.ok(!/READY/.test(lines.at(-1)), lines.at(-1));
  }
  // through the real CLI: a title with a newline in the facts file
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  const r = run(w, dir, ['merge', '--dir', dir, '--remote', 'origin', '--pr', '7', '--facts', factsFile(w, { ...OPEN_FACTS, title: hostile }), '--json']);
  assert.equal(r.code, 0, r.err);
  const q = JSON.parse(r.out).question;
  assert.equal(q.split('\n').filter((l) => /^state:/i.test(l)).length, 1, q);
  const b = run(w, dir, ['open-pr', '--dir', dir, '--remote', 'origin', '--base', hostile, '--json']);
  assert.equal(b.code, 0, b.err);
  assert.equal(JSON.parse(b.out).question.split('\n').length <= 3, true);
});

// Fix round 5 (F8). Change that breaks it: key open-pr on repo@branch only (the tap for base dev then licenses a create into main).
test('AA-F8: the open-pr key holds the base: dev and main give two keys; no --base gives the key of before', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  const keyOf = (args) => {
    const r = run(w, dir, ['open-pr', '--dir', dir, '--remote', 'origin', ...args, '--json']);
    assert.equal(r.code, 0, r.err);
    return offers(w).filter((o) => o.open !== false).map((o) => o.key);
  };
  assert.ok(keyOf(['--base', 'dev']).includes('acme/app@feat/x:dev'));
  assert.ok(keyOf(['--base', 'main']).includes('acme/app@feat/x:main'));
  assert.ok(keyOf([]).includes('acme/app@feat/x'));
  assert.equal(new Set(offers(w).map((o) => o.key)).size, 3, 'three keys: one per base, and none');
});

test('AA12: two repos with the same branch, tree and head give different keys, and both offers stay open', () => {
  const w = world();
  const a = repo(w, 'a', { remotes: { origin: ACME } });
  const b = repo(w, 'b', { remotes: { origin: OTHER } });
  stage(w, a, 'x.txt');
  stage(w, b, 'x.txt');
  assert.equal(run(w, a, ['push', '--dir', a, '--remote', 'origin', '--json']).code, 0);
  assert.equal(run(w, b, ['push', '--dir', b, '--remote', 'origin', '--json']).code, 0);
  const rows = offers(w);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((o) => o.key)).size, 2);
  assert.ok(rows.every((o) => o.open === true));
  assert.deepEqual(rows.map((o) => o.key).sort(), ['acme/app@feat/x', 'other/lib@feat/x']);
});

test('AA13: the --facts seam needs APP_ASK_TEST=1 and a store other than the default; otherwise gh is asked and the facts file is not read', async () => {
  const m = await load();
  const { decisionsPath } = await loadStore();
  const w = world();
  const file = factsFile(w, { ...OPEN_FACTS, headRefOid: 'f'.repeat(40) });
  const fromGh = { headRefOid: '1'.repeat(40), state: 'OPEN', isDraft: false, title: 't' };
  const calls = [];
  const gh = (pr, repo) => { calls.push([pr, repo]); return fromGh; };
  const warnings = [];
  const ask = (env) => m.mergeFactsOf({ facts: file, pr: 7, repo: 'acme/app' }, { env, runGh: gh, warn: (t) => warnings.push(t) });
  const scratch = { APP_ASK_TEST: '1', CCV3_DECISIONS_FILE: w.store };
  assert.equal(ask(scratch).headRefOid, 'f'.repeat(40), 'both keys: the seam works');
  assert.deepEqual(calls, []);
  assert.equal(m.seamsOn(scratch), true);
  const real = decisionsPath({});
  const realHome = path.join(os.userInfo().homedir, '.claude', 'state', 'ccv3-mods', 'decisions.json');
  // Fix round 1 (seamsOn): the real store in another case (NTFS opens the same file), the real store by the account home while
  // USERPROFILE points elsewhere, and a store outside the temp folder. Change that breaks it: compare path.resolve text only again.
  const variants = [
    { APP_ASK_TEST: '1', CCV3_DECISIONS_FILE: real.toUpperCase() },
    { APP_ASK_TEST: '1', CCV3_DECISIONS_FILE: realHome, USERPROFILE: w.home, HOME: w.home },
    { APP_ASK_TEST: '1', CCV3_DECISIONS_FILE: path.join(os.userInfo().homedir, 'not-temp', 'store.json') },
  ];
  for (const env of [{ APP_ASK_TEST: '1', CCV3_DECISIONS_FILE: real }, { APP_ASK_TEST: '1' }, { CCV3_DECISIONS_FILE: w.store }, { APP_ASK_TEST: '0', CCV3_DECISIONS_FILE: w.store }, ...variants]) {
    assert.equal(m.seamsOn(env), false, JSON.stringify(env));
    assert.equal(ask(env).headRefOid, '1'.repeat(40), `the seam is ignored: ${JSON.stringify(env)}`);
  }
  assert.deepEqual(calls[0], [7, 'acme/app']);
  assert.equal(calls.length, 7);
  assert.equal(warnings.length, 7, 'one warning per ignored seam');
  // The env default store under the temp folder, its tail in another case: only the real-path case fold refuses it on Windows (NTFS opens
  // the same file). On Linux another case is another file, so the seam is on. Change that breaks it: canonPath without the case fold.
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = w.home;
  process.env.HOME = w.home;
  try {
    const envDefault = decisionsPath({});
    const variant = path.join(os.tmpdir(), path.relative(os.tmpdir(), envDefault).toUpperCase());
    assert.equal(m.seamsOn({ APP_ASK_TEST: '1', CCV3_DECISIONS_FILE: envDefault }), false, envDefault);
    assert.equal(m.seamsOn({ APP_ASK_TEST: '1', CCV3_DECISIONS_FILE: variant }), process.platform !== 'win32', variant);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('AA14: bad usage is exit 2 and writes no offer', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  stage(w, dir, 'b.txt');
  for (const args of [[], ['nope'], ['merge', '--dir', dir], ['merge', '--pr', 'x'], ['push', '--pr', '3'], ['push', '--bogus', '1'], ['push', '--remote'], ['open-pr', '--facts', 'f.json'], ['merge', '--pr', '3', '--base', 'x']]) {
    assert.equal(run(w, dir, args).code, 2, JSON.stringify(args));
  }
  noOffer(w);
});

test('AA15: a folder that is not a git checkout, and a detached HEAD without --branch, are exit 1', () => {
  const w = world();
  assert.equal(run(w, w.home, ['push', '--dir', w.home, '--remote', 'origin']).code, 1);
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  git(w, dir, 'checkout', '-q', '--detach');
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'origin']).code, 1);
  assert.equal(run(w, dir, ['open-pr', '--dir', dir, '--remote', 'origin']).code, 1);
  noOffer(w);
});

test('AA16: a worktree of a registered root with no GitHub remote gets the key of the entry of its main root', () => {
  const w = world();
  const dir = repo(w, 'localapp', { branch: 'main2', remotes: { origin: `${w.root}/bare.git` } });
  writeRegistry(w, [{ key: 'localapp', path: dir }]);
  const wt = `${w.root}/wt`;
  git(w, dir, 'worktree', 'add', '-q', '-b', 'side', wt);
  stage(w, wt, 'b.txt');
  const r = run(w, wt, ['push', '--remote', 'origin']);
  assert.equal(r.code, 0, r.err);
  assert.equal(offers(w)[0].key, `local:localapp:${normPath(`${w.root}/bare.git`)}@side`);
  assert.equal(offers(w)[0].cwd, wt, 'the default --dir is the cwd');
});

// ---------- fix round 1, fixer C: ONE key rule with the gate (repo-identity.mjs pushKey, ghKey) ----------

// Change that breaks it: key on the current branch, or bind the HEAD tree, when --branch and --src name another branch (F3).
test('AA17: push --branch feat --src feat while on main keys on feat and binds the tree of feat', () => {
  const w = world();
  const dir = repo(w, 'app', { branch: 'feat', remotes: { origin: ACME } });
  commitFile(w, dir, 'b.txt');
  git(w, dir, 'checkout', '-q', 'main');
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--branch', 'feat', '--src', 'feat', '--json']);
  assert.equal(r.code, 0, r.err);
  const [offer] = offers(w);
  assert.equal(offer.key, 'acme/app@feat');
  assert.equal(offer.tree, git(w, dir, 'rev-parse', 'feat^{tree}'));
  assert.notEqual(offer.tree, git(w, dir, 'rev-parse', 'HEAD^{tree}'));
});

// Change that breaks it: look the destination up as refs/heads/<branch> (HEAD:release then has no ref and is refused).
test('AA18: push --branch release --src HEAD (a refspec HEAD:release) keys on release and binds the HEAD tree; no local release branch is needed', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--branch', 'release', '--src', 'HEAD', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(offers(w)[0].key, 'acme/app@release');
  assert.equal(offers(w)[0].tree, git(w, dir, 'rev-parse', 'HEAD^{tree}'));
});

// Change that breaks it: refuse a remote that is not a configured remote name (the old "not a remote of this checkout").
test('AA19: push to a URL remote keys on the URL; a name that is no remote and no URL is still refused', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'https://github.com/Acme/Other.git', '--branch', 'feat/x', '--src', 'HEAD', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(offers(w)[0].key, 'acme/other@feat/x');
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'nope']).code, 1);
});

// Change that breaks it: key open-pr or merge on the push URL (F6).
test('AA20: open-pr and merge key on the FETCH URL of the remote; push keys on its push URL', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  git(w, dir, 'remote', 'set-url', '--push', 'origin', 'https://github.com/me/fork.git');
  assert.equal(run(w, dir, ['open-pr', '--dir', dir, '--remote', 'origin', '--json']).code, 0);
  assert.equal(run(w, dir, ['merge', '--dir', dir, '--remote', 'origin', '--pr', '7', '--facts', factsFile(w, OPEN_FACTS), '--json']).code, 0);
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--json']).code, 0);
  assert.deepEqual(offers(w).map((o) => o.key).sort(), ['acme/app#7', 'acme/app@feat/x', 'me/fork@feat/x']);
});

// Change that breaks it: ignore the github field of the registry entry (F5: open-pr then refuses an SSH host alias remote).
test('AA21: an SSH host alias remote keys on the github field of the registry entry', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: 'git@github-work:Acme/App.git' } });
  writeRegistry(w, [{ key: 'app', path: dir, github: 'Acme/App' }]);
  const r = run(w, dir, ['open-pr', '--dir', dir, '--remote', 'origin', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(offers(w)[0].key, 'acme/app@feat/x');
});

// Change that breaks it: key a bare push on the current branch (push.default=upstream updates up/main).
test('AA22: push with no --branch keys on the branch of @{push} (feat/x tracks up/main)', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME, up: OTHER } });
  git(w, dir, 'update-ref', 'refs/remotes/up/main', git(w, dir, 'rev-parse', 'main'));
  git(w, dir, 'config', 'branch.feat/x.remote', 'up');
  git(w, dir, 'config', 'branch.feat/x.merge', 'refs/heads/main');
  git(w, dir, 'config', 'push.default', 'upstream');
  commitFile(w, dir, 'c.txt');
  assert.equal(git(w, dir, 'rev-parse', '--symbolic-full-name', '@{push}'), 'refs/remotes/up/main', 'the fixture: @{push} is up/main');
  assert.notEqual(git(w, dir, 'rev-parse', 'HEAD^{tree}'), git(w, dir, 'rev-parse', 'main^{tree}'), 'the fixture: HEAD and main have other trees');
  const r = run(w, dir, ['push', '--dir', dir, '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(offers(w)[0].key, 'other/lib@main');
  // The push sends HEAD, so the tap binds HEAD's tree (the gate reads HEAD^{tree}), not the tree of main. Change that breaks it: source = the key branch.
  assert.equal(offers(w)[0].tree, git(w, dir, 'rev-parse', 'HEAD^{tree}'));
});

// Change that breaks it: read only the first pushurl (git push updates every pushurl).
test('AA23: a remote whose push URLs name two repos is refused, exit 1, no offer', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  git(w, dir, 'remote', 'set-url', '--add', '--push', 'origin', ACME);
  git(w, dir, 'remote', 'set-url', '--add', '--push', 'origin', OTHER);
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'origin']);
  assert.equal(r.code, 1);
  assert.match(r.err, /one push URL/);
  noOffer(w);
});

// Fix round 2, fixer G (item 7, principal A3 residue). Change that breaks it: the open-pr or merge refusal for an SSH alias remote of an
// entry with no github field drops the way out (the registry entry needs a github field), or names a CCv3 tool.
test('AA25: an SSH host alias remote of an entry with no github field: open-pr and merge refuse, and say the entry needs a github field', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: 'git@github-work:Acme/App.git' } });
  writeRegistry(w, [{ key: 'app', path: dir }]);
  for (const args of [['open-pr', '--dir', dir, '--json'], ['merge', '--dir', dir, '--pr', '7', '--facts', factsFile(w, OPEN_FACTS), '--json']]) {
    const r = run(w, dir, args);
    assert.equal(r.code, 1, `${args[0]}: ${r.err}`);
    assert.match(r.err, /the registry entry app needs a github field naming owner\/repo/, args[0]);
    assert.match(r.err, /tell Dave/i, args[0]);
    assert.doesNotMatch(r.err, /ship-ask|land-pr|\bfork\b/, args[0]);
  }
  noOffer(w);
  // A push needs no github field: the local: key is fine for it.
  assert.equal(run(w, dir, ['push', '--dir', dir, '--remote', 'origin', '--json']).code, 0);
});

// Change that breaks it: read a remote name with a slash as a URL or a path (F5).
test('AA24: a remote named team/fork is resolved by git', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { 'team/fork': OTHER } });
  const r = run(w, dir, ['push', '--dir', dir, '--remote', 'team/fork', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(offers(w)[0].key, 'other/lib@feat/x');
});

// Seat review 1, item 2: a typed --remote URL with user:token@ is a secret. Every shown or stored remote value goes through the
// credential strip of the key (repo-identity.mjs stripCredentials, the rule of targetOf). Change that breaks it: show the raw --remote.
const TOKEN = 's3cr3tTK';
const noToken = (w, r, what) => {
  for (const [name, text] of [['stdout', r.out], ['stderr', r.err], ['store', existsSync(w.store) ? readFileSync(w.store, 'utf8') : '']]) {
    assert.ok(!text.includes(TOKEN), `${what}: the token reached ${name}: ${text}`);
  }
};
test('AA26: a token URL never reaches stdout, the stored offer or a refusal text', () => {
  const w = world();
  const dir = repo(w, 'app', { remotes: { origin: ACME } });
  // success: a GitHub URL with a token, question, printed spec and stored offer
  const ok = run(w, dir, ['push', '--dir', dir, '--remote', `https://u:${TOKEN}@github.com/Acme/App.git`, '--branch', 'feat/x', '--src', 'HEAD', '--json']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(offers(w)[0].key, 'acme/app@feat/x');
  assert.match(JSON.parse(ok.out).question, /to https:\/\/github\.com\/Acme\/App\.git/);
  noToken(w, ok, 'push ok');
  // refusals: a non-GitHub token URL with no registry entry (no-key), open-pr with and without an entry, merge
  const bad = `https://u:${TOKEN}@git.example.com/a/b.git`;
  const w2 = world();
  const d2 = repo(w2, 'app', { remotes: { origin: ACME } });
  for (const args of [['push', '--branch', 'feat/x', '--src', 'HEAD'], ['open-pr'], ['merge', '--pr', '4', '--facts', factsFile(w2, OPEN_FACTS)]]) {
    const r = run(w2, d2, [...args, '--dir', d2, '--remote', bad]);
    assert.equal(r.code, 1, `${args[0]}: ${r.err}`);
    assert.match(r.err, /git\.example\.com/, args[0]);
    noToken(w2, r, `${args[0]} no entry`);
  }
  writeRegistry(w2, [{ key: 'app', path: d2 }]);
  for (const args of [['open-pr'], ['merge', '--pr', '4', '--facts', factsFile(w2, OPEN_FACTS)]]) {
    const r = run(w2, d2, [...args, '--dir', d2, '--remote', bad]);
    assert.equal(r.code, 1, `${args[0]}: ${r.err}`);
    noToken(w2, r, `${args[0]} with entry`);
  }
  noOffer(w2);
});

// Seat review 1, item 5: a --src or --remote value that starts with - is an option to git, not a ref or a remote. parseArgs refuses it,
// and every git call that takes a ref or a remote from the command puts --end-of-options before it.
// Change that breaks it: accept a value with one leading dash; drop --end-of-options from a ref or remote call.
test('AA27: parseArgs refuses a --src or --remote value that starts with a dash', async () => {
  const { parseArgs } = await load();
  for (const argv of [['push', '--src', '-oops'], ['push', '--remote', '-c'], ['open-pr', '--remote', '-x'], ['push', '--src', '--output=x']]) {
    assert.ok(parseArgs(argv).error, argv.join(' '));
  }
  assert.equal(parseArgs(['push', '--src', 'feat', '--remote', 'origin']).o.src, 'feat');
});
test('AA28: every git call with a ref or a remote from the command puts --end-of-options before it', async () => {
  const { planWith } = await load();
  const calls = [];
  const fake = (url) => (args) => {
    calls.push(args);
    if (args[0] === 'branch') return { status: 0, stdout: 'main\n' };
    if (args[0] === 'remote' && args.length === 1) return { status: 0, stdout: 'origin\n' };
    if (args.includes('get-url')) return { status: 0, stdout: `${url}\n` };
    if (args[0] === 'rev-list') return { status: 0, stdout: '1\n' };
    if (args[0] === 'diff') return { status: 0, stdout: '' };
    const last = args[args.length - 1];
    if (last.endsWith('^{commit}')) return { status: 0, stdout: `${'a'.repeat(40)}\n` };
    if (last.endsWith('^{tree}')) return { status: 0, stdout: `${'b'.repeat(40)}\n` };
    return { status: 128, stdout: '' };
  };
  const plan = planWith({ sub: 'push', remote: 'origin', branch: 'feat', src: 'feat' }, { git: fake('https://github.com/acme/app.git') });
  assert.equal(plan.key, 'acme/app@feat');
  assert.equal(plan.tree, 'b'.repeat(40));
  // open-pr of an SSH alias with no github field: the refusal path reads get-url once more (:188)
  assert.throws(() => planWith({ sub: 'open-pr', remote: 'origin', branch: 'feat' }, { git: fake('git@github-work:acme/app.git'), entry: { key: 'app', github: null } }), /github field/);
  const userWords = new Set(['origin', 'feat', 'feat^{commit}', 'feat^{tree}']);
  const bare = calls.filter((args) => args.some((a, i) => userWords.has(a) && args[i - 1] !== '--end-of-options'));
  assert.deepEqual(bare, [], 'a ref or remote word with no --end-of-options before it');
  assert.ok(calls.filter((a) => a.includes('get-url')).length >= 3, 'push get-url, open-pr fetch get-url and the alias re-read were all seen');
});
