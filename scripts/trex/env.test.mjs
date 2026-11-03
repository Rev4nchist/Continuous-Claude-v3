import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { gradeCheck } from './checks.mjs';
import { toStepResult } from './drivers/common.mjs';
import {
  archiveArgs, composeArgv, ensureImage, envDigests, imageExists, imageTagsFor, isMerged, loopbackOffenders, lockHash, main,
  parseDigests, planBuilds, prepareHost, projectName, removeByLabel, resolveDeps, startEnv, stopEnv, withEnv,
} from './env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_DIR = path.resolve(here, '..', '..', 'docker', 'trex');
const readDocker = (name) => readFileSync(path.join(DOCKER_DIR, name), 'utf8');

const HEAD = 'h'.repeat(40);
const FLOWS = 'f'.repeat(40);
const IMAGE_SHA = 'i'.repeat(40);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'fatal') => ({ status: 128, stdout: '', stderr });

/** A fake git. `blobs` maps "<sha>:<path>" to content; `trees` maps a sha to its file list. */
function makeGit({ blobs = {}, trees = {}, ancestor = 0 } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse') return revParse(rest.at(-1), blobs);
    if (cmd === 'show') return rest[0] in blobs ? ok(blobs[rest[0]]) : fail(`missing ${rest[0]}`);
    if (cmd === 'ls-tree') return lsTree(args, trees);
    // `ancestor` is one exit status, or a function of the sha being checked.
    if (cmd === 'merge-base') return { status: typeof ancestor === 'function' ? ancestor(rest[1]) : ancestor, stdout: '', stderr: '' };
    return fail('unexpected git call');
  };
  git.calls = calls;
  return git;
}

function revParse(spec, blobs) {
  if (spec.endsWith('^{commit}')) return spec.startsWith('bad') ? fail('bad object') : ok(`${spec.split('^')[0]}\n`);
  return spec in blobs ? ok(`oid-${Buffer.from(blobs[spec]).toString('hex').slice(0, 24)}\n`) : fail('not a blob');
}

function lsTree(args, trees) {
  const sha = args[args.indexOf('--') - 1];
  const specs = args.slice(args.indexOf('--') + 1);
  const files = (trees[sha] ?? []).filter((f) => specs.some((s) => f === s || f.startsWith(`${s}/`)));
  return ok(files.map((f) => `${f}\0`).join(''));
}

const LOCKS = {
  [`${HEAD}:package-lock.json`]: 'root-lock',
  [`${HEAD}:apps/agentic-os/package-lock.json`]: 'app-lock',
  [`${IMAGE_SHA}:docker/trex/Dockerfile`]: 'FROM node:22',
};

// ---------- lockHash ----------

test('lockHash: returns 12 hex characters', () => {
  assert.match(lockHash(makeGit({ blobs: LOCKS }), HEAD, IMAGE_SHA), /^[0-9a-f]{12}$/);
});

test('lockHash: changes when the root lockfile, the app lockfile or the Dockerfile changes', () => {
  const base = lockHash(makeGit({ blobs: LOCKS }), HEAD, IMAGE_SHA);
  const variants = [`${HEAD}:package-lock.json`, `${HEAD}:apps/agentic-os/package-lock.json`, `${IMAGE_SHA}:docker/trex/Dockerfile`];
  const hashes = variants.map((key) => lockHash(makeGit({ blobs: { ...LOCKS, [key]: 'changed' } }), HEAD, IMAGE_SHA));
  for (const h of hashes) assert.notEqual(h, base);
  assert.equal(new Set(hashes).size, 3);
});

test('lockHash: a missing app lockfile at an old SHA hashes as absent and does not crash', () => {
  const old = { ...LOCKS };
  delete old[`${HEAD}:apps/agentic-os/package-lock.json`];
  const withoutApp = lockHash(makeGit({ blobs: old }), HEAD, IMAGE_SHA);
  assert.match(withoutApp, /^[0-9a-f]{12}$/);
  assert.notEqual(withoutApp, lockHash(makeGit({ blobs: LOCKS }), HEAD, IMAGE_SHA));
});

test('lockHash: an unknown head commit throws', () => {
  assert.throws(() => lockHash(makeGit({ blobs: LOCKS }), 'bad-head', IMAGE_SHA), /bad-head/);
});

test('lockHash: reads the Dockerfile at imageSha, never at head', () => {
  const git = makeGit({ blobs: { ...LOCKS, [`${HEAD}:docker/trex/Dockerfile`]: 'PR EDIT' } });
  lockHash(git, HEAD, IMAGE_SHA);
  const specs = git.calls.map((c) => c.at(-1));
  assert.ok(specs.includes(`${IMAGE_SHA}:docker/trex/Dockerfile`));
  assert.ok(!specs.includes(`${HEAD}:docker/trex/Dockerfile`));
});

// ---------- small helpers ----------

test('archiveArgs: autocrlf=false is set', () => {
  assert.ok(archiveArgs('abc', ['x']).join(' ').includes('-c core.autocrlf=false'));
});

test('projectName: pr and sha give trex-<pr>-<sha8>, no pr gives trex-sim-<sha8>', () => {
  assert.equal(projectName({ pr: 12, sha: 'ABCDEF0123456789' }), 'trex-12-abcdef01');
  assert.equal(projectName({ sha: 'ABCDEF0123456789' }), 'trex-sim-abcdef01');
  assert.match(projectName({ pr: 7, sha: 'DEADBEEFCAFE' }), /^[a-z0-9_-]+$/);
});

test('loopbackOffenders: flags 0.0.0.0, an empty host_ip and a missing host_ip', () => {
  const cfg = { services: { db: { ports: [
    { host_ip: '0.0.0.0', published: '5432', target: 5432 },
    { host_ip: '', published: '5433', target: 5432 },
    { published: '5434', target: 5432 },
  ] } } };
  assert.equal(loopbackOffenders(cfg).length, 3);
  assert.match(loopbackOffenders(cfg)[0], /db: 5432 -> 5432 on 0\.0\.0\.0/);
});

test('loopbackOffenders: loopback addresses and port-less services pass; JSON text is accepted', () => {
  const cfg = { services: { a: { ports: [{ host_ip: '127.0.0.1', target: 5432 }, { host_ip: '::1', target: 5432 }] }, b: {} } };
  assert.deepEqual(loopbackOffenders(JSON.stringify(cfg)), []);
});

test('composeArgv: every compose argv carries -p <project> and the config file', () => {
  const argv = composeArgv('trex-sim-abc', '/cfg/compose.yml', 'down', '-v');
  assert.deepEqual(argv, ['compose', '-p', 'trex-sim-abc', '-f', '/cfg/compose.yml', 'down', '-v']);
  assert.throws(() => composeArgv('', '/cfg/compose.yml', 'down'), /project/);
});

// ---------- docker config files ----------

test('docker files: base images are pinned by digest and recorded for report.envDigest', () => {
  const digests = parseDigests(`${readDocker('Dockerfile')}\n${readDocker('compose.yml')}`);
  assert.match(digests['node:22'], /^sha256:[0-9a-f]{64}$/);
  assert.match(digests['pgvector/pgvector:pg16'], /^sha256:[0-9a-f]{64}$/);
});

test('envDigests: reads the digests through git show at imageSha', () => {
  const blobs = {
    [`${IMAGE_SHA}:docker/trex/Dockerfile`]: readDocker('Dockerfile'),
    [`${IMAGE_SHA}:docker/trex/compose.yml`]: readDocker('compose.yml'),
  };
  const got = envDigests(makeGit({ blobs }), IMAGE_SHA);
  assert.deepEqual(Object.keys(got).sort(), ['node:22', 'pgvector/pgvector:pg16']);
});

test('Dockerfile: npm rebuild runs without a network and no secret mount remains', () => {
  const text = readDocker('Dockerfile');
  assert.match(text, /RUN --network=none npm rebuild/);
  assert.doesNotMatch(text, /--mount=type=secret/);
  assert.match(text, /npm ci --ignore-scripts/);
  assert.match(text, /playwright install --with-deps chromium/);
});

test('compose.yml: isolated internal network, run label on every service and the network, no ports or volumes', () => {
  const doc = parse(readDocker('compose.yml'));
  for (const [name, svc] of Object.entries(doc.services)) {
    assert.equal(svc.labels['trex.run'], '${TREX_RUN_ID}', `${name} label`);
    assert.equal(svc.ports, undefined, `${name} ports`);
    assert.equal(svc.volumes, undefined, `${name} volumes`);
  }
  assert.equal(doc.networks.trexnet.internal, true);
  assert.equal(doc.networks.trexnet.labels['trex.run'], '${TREX_RUN_ID}');
  assert.equal(doc.networks.trexnet.driver_opts['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated');
  assert.equal(doc.services.app.init, true);
  assert.equal(doc.services.app.mem_limit, '6g');
});

test('compose.none.yml: app only, network_mode none, run label', () => {
  const doc = parse(readDocker('compose.none.yml'));
  assert.deepEqual(Object.keys(doc.services), ['app']);
  assert.equal(doc.services.app.network_mode, 'none');
  assert.equal(doc.services.app.labels['trex.run'], '${TREX_RUN_ID}');
});

// ---------- fake docker and pipe for the runtime tests ----------

function harness({ gitOpts = {}, dockerReply = () => null } = {}) {
  const events = [];
  const docker = async (args, opts = {}) => {
    events.push({ kind: 'docker', args, opts });
    return dockerReply(args, opts) ?? defaultReply(args);
  };
  const pipe = async (a, b, opts = {}) => {
    events.push({ kind: 'pipe', a, b, opts });
    return { codeA: 0, codeB: 0, timedOut: false, stdoutB: '', stderrA: '', stderrB: '' };
  };
  const git = makeGit(gitOpts);
  const deps = { git, docker, pipe, cwd: 'C:\\repo', sleep: async () => {}, mkdir: () => {}, exit: () => {}, exists: () => true, readdir: () => ['x'] };
  return { events, deps, git, dockerArgs: () => events.filter((e) => e.kind === 'docker').map((e) => e.args) };
}

function defaultReply(args) {
  const base = { code: 0, timedOut: false, stdout: '', stderr: '' };
  if (args[0] === 'inspect') return { ...base, stdout: 'healthy\n' };
  if (args.includes('config')) return { ...base, stdout: JSON.stringify({ services: { app: {} } }) };
  return base;
}

const TREE = {
  [FLOWS]: ['.trex/flows/a.yaml', 'apps/agentic-os/e2e/trex-x.spec.ts'],
  [IMAGE_SHA]: ['docker/trex/Dockerfile', 'docker/trex/compose.yml', 'docker/trex/compose.none.yml'],
};
const BLOBS = {
  [`${HEAD}:docker/init-schema.sql`]: 'INIT SQL;',
  [`${HEAD}:apps/agentic-os/scripts/provision-roles.sql`]: 'ROLES SQL;',
  [`${IMAGE_SHA}:docker/trex/roles-min.sql`]: 'MIN ROLES;',
  [`${IMAGE_SHA}:docker/trex/Dockerfile`]: readDocker('Dockerfile'),
  [`${IMAGE_SHA}:docker/trex/compose.yml`]: readDocker('compose.yml'),
};
const START = { pr: 5, head: HEAD, flowsSha: FLOWS, imageSha: IMAGE_SHA, image: 'trex:abc', evidenceDir: 'C:\\ev', runId: 'run1' };
const DB_FLOW = { id: 'db-flow', needs: ['db'], start: { db: 'fixtures/seed.sql' } };
const PLAIN_FLOW = { id: 'plain-flow', needs: [], start: {} };

const isCompose = (args) => args[0] === 'compose';
const isCp = (e) => e.kind === 'pipe' && e.b.args[0] === 'cp';
const stdinOf = (e) => e.opts.stdin ?? '';

// ---------- startEnv ----------

test('startEnv: every compose argv carries -p <project> and reads config from imageSha, not the repo', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  const composeCalls = h.dockerArgs().filter(isCompose);
  assert.ok(composeCalls.length >= 4);
  for (const args of composeCalls) {
    assert.equal(args[1], '-p');
    assert.equal(args[2], 'trex-5-hhhhhhhh');
    const file = args[args.indexOf('-f') + 1];
    assert.ok(file.startsWith(path.join('C:\\ev', 'cfg')), `compose file ${file} must come from the extracted config`);
  }
  const extract = h.events.find((e) => e.kind === 'pipe' && e.a.args.includes('archive') && e.a.args.includes(IMAGE_SHA));
  assert.ok(extract, 'docker/trex is extracted from imageSha');
});

test('startEnv: the order is down, config, create, head copy, overlay copy, start', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  const tags = h.events.map((e) => (e.kind === 'docker' ? `d:${e.args.find((a) => ['down', 'create', 'start', 'config'].includes(a)) ?? e.args[0]}` : `p:${e.b.args[0]}`));
  const seq = ['d:down', 'd:create', 'p:cp', 'p:cp', 'd:start'];
  let at = -1;
  for (const want of seq) {
    at = tags.indexOf(want, at + 1);
    assert.ok(at >= 0, `${want} in order: ${tags.join(' ')}`);
  }
  assert.ok(tags.indexOf('d:config') < tags.indexOf('d:create'), 'loopback check runs before create');
});

test('startEnv: the head tree comes from head and the overlay comes from flowsSha, never the other way', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  const [headCp, overlayCp] = h.events.filter(isCp);
  assert.ok(headCp.a.args.includes(HEAD) && !headCp.a.args.includes(FLOWS));
  assert.ok(overlayCp.a.args.includes(FLOWS) && !overlayCp.a.args.includes(HEAD));
  assert.deepEqual(overlayCp.a.args.slice(0, 4), ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);
  assert.deepEqual(headCp.a.args.slice(0, 4), ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);
  assert.ok(overlayCp.a.args.includes('.trex/flows/a.yaml'));
  assert.ok(!overlayCp.a.args.includes('docker/trex'), 'the overlay is not the image config');
});

test('startEnv: a flows sha with no grading files is skipped no_config and runs no docker call', async () => {
  const h = harness({ gitOpts: { trees: { [FLOWS]: ['src/app.ts'] }, blobs: BLOBS } });
  const r = await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  assert.deepEqual(r.skipped, { reason: 'no_config' });
  assert.equal(h.events.length, 0);
});

test('startEnv: flows without db use compose.none.yml and run no psql', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  assert.ok(h.dockerArgs().filter(isCompose).every((a) => a[a.indexOf('-f') + 1].endsWith('compose.none.yml')));
  assert.ok(!h.dockerArgs().some((a) => a.includes('psql')));
});

test('startEnv: a db flow loads init-schema, migrates, provisions roles, then the seed', async () => {
  const h = harness({
    gitOpts: { trees: TREE, blobs: BLOBS },
    dockerReply: (args) => (args.includes('cat') ? { code: 0, stdout: 'SEED SQL;', stderr: '', timedOut: false } : null),
  });
  const env = await startEnv({ ...START, flows: [DB_FLOW] }, h.deps);
  const calls = h.events.filter((e) => e.kind === 'docker');
  const psql = calls.filter((e) => e.args.includes('psql'));
  assert.equal(psql.length, 3);
  assert.equal(stdinOf(psql[0]), 'INIT SQL;');
  assert.ok(stdinOf(psql[1]).includes('ROLES SQL;') && stdinOf(psql[1]).includes('\\set finish COMMIT'));
  assert.equal(stdinOf(psql[2]), 'SEED SQL;');
  const migrate = calls.findIndex((e) => e.args.includes('drizzle-kit'));
  assert.ok(calls.indexOf(psql[0]) < migrate && migrate < calls.indexOf(psql[1]), 'schema, then migrate, then roles');
  assert.ok(calls.some((e) => e.args.includes(`${env.project}-postgres-1`) && e.args.includes('psql')));
  assert.equal(env.dbPort, null);
});

test('startEnv: new role passwords never appear in a docker argv', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  await startEnv({ ...START, flows: [DB_FLOW] }, h.deps);
  const roles = h.events.find((e) => e.kind === 'docker' && stdinOf(e).includes('ROLES SQL;'));
  const pw = /\\set app_pw '([0-9a-f]+)'/.exec(stdinOf(roles))[1];
  assert.ok(pw.length >= 24);
  const argvText = JSON.stringify(h.events.map((e) => e.args ?? [e.a.args, e.b.args]));
  assert.ok(!argvText.includes(pw));
});

test('startEnv: with no provision-roles.sql at head it falls back to roles-min.sql from imageSha', async () => {
  const blobs = { ...BLOBS };
  delete blobs[`${HEAD}:apps/agentic-os/scripts/provision-roles.sql`];
  const h = harness({ gitOpts: { trees: TREE, blobs } });
  await startEnv({ ...START, flows: [DB_FLOW] }, h.deps);
  assert.ok(h.events.some((e) => stdinOf(e).includes('MIN ROLES;')));
});

test('startEnv: a loopback offender in the rendered config stops the start before create', async () => {
  const bad = JSON.stringify({ services: { postgres: { ports: [{ host_ip: '0.0.0.0', published: '5432', target: 5432 }] } } });
  const h = harness({
    gitOpts: { trees: TREE, blobs: BLOBS },
    dockerReply: (args) => (args.includes('config') ? { code: 0, stdout: bad, stderr: '', timedOut: false } : null),
  });
  await assert.rejects(startEnv({ ...START, flows: [DB_FLOW] }, h.deps), /0\.0\.0\.0/);
  assert.ok(!h.dockerArgs().some((a) => a.includes('create')));
});

test('startEnv: a failure after create tears the project down again', async () => {
  const h = harness({
    gitOpts: { trees: TREE, blobs: BLOBS },
    dockerReply: (args) => (args.includes('start') && isCompose(args) ? { code: 1, stdout: '', stderr: 'boom', timedOut: false } : null),
  });
  await assert.rejects(startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps), (err) => err.stage === 'start');
  const downs = h.dockerArgs().filter((a) => isCompose(a) && a.includes('down'));
  assert.equal(downs.length, 2, 'one down before create, one after the failure');
});

test('startEnv: the run id, image and database password reach compose through its env only', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  const create = h.events.find((e) => e.kind === 'docker' && e.args.includes('create'));
  assert.equal(create.opts.env.TREX_RUN_ID, 'run1');
  assert.equal(create.opts.env.TREX_IMAGE, 'trex:abc');
  assert.equal(create.opts.env.ANTHROPIC_API_KEY, undefined);
});

// ---------- Env.exec, stopEnv, withEnv ----------

test('Env.exec: wraps the argv in timeout -s KILL inside the container and sets the work dir', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  const env = await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  await env.exec(['node', 'x.js'], { cwd: 'apps/agentic-os', timeoutSec: 30 });
  const last = h.dockerArgs().at(-1);
  assert.deepEqual(last, ['exec', '-w', '/app/apps/agentic-os', env.app, 'timeout', '-s', 'KILL', '30', 'node', 'x.js']);
});

test('Env.cpOut: copies the evidence folder out of the app container', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  const env = await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  await env.cpOut('/trex-out', 'C:\\ev\\out');
  const cp = h.events.filter((e) => e.kind === 'pipe').at(-1);
  assert.deepEqual(cp.a.args, ['cp', `${env.app}:/trex-out`, '-']);
  assert.deepEqual(cp.b.args.slice(0, 2), ['-xf', '-']);
});

test('stopEnv: runs compose down -v --remove-orphans for its own project only', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  const env = await startEnv({ ...START, flows: [PLAIN_FLOW] }, h.deps);
  await stopEnv(env, h.deps);
  const down = h.dockerArgs().filter(isCompose).at(-1);
  assert.deepEqual(down.slice(1, 3), ['-p', env.project]);
  assert.deepEqual(down.slice(-3), ['down', '-v', '--remove-orphans']);
});

test('withEnv: tears down when the callback throws', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  await assert.rejects(withEnv({ ...START, flows: [PLAIN_FLOW] }, { ...h.deps, onSigint: () => () => {} }, async () => { throw new Error('flow broke'); }), /flow broke/);
  const last = h.dockerArgs().filter(isCompose).at(-1);
  assert.deepEqual(last.slice(-3), ['down', '-v', '--remove-orphans']);
});

test('withEnv: a SIGINT handler tears the project down', async () => {
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  let handler;
  const onSigint = (fn) => { handler = fn; return () => { handler = null; }; };
  await withEnv({ ...START, flows: [PLAIN_FLOW] }, { ...h.deps, onSigint }, async () => {
    const before = h.dockerArgs().length;
    await handler();
    assert.ok(h.dockerArgs().length > before);
    assert.deepEqual(h.dockerArgs().at(-1).slice(-3), ['down', '-v', '--remove-orphans']);
  });
  assert.equal(handler, null, 'the handler is removed at the end');
});

test('removeByLabel: removes containers and networks that carry the run label, and nothing else', async () => {
  const h = harness({ dockerReply: (args) => (args[0] === 'ps' ? { code: 0, stdout: 'c1\nc2\n', stderr: '', timedOut: false } : null) });
  await removeByLabel('run9', h.deps);
  const calls = h.dockerArgs();
  assert.deepEqual(calls[0], ['ps', '-aq', '--filter', 'label=trex.run=run9']);
  assert.deepEqual(calls.find((a) => a[0] === 'rm'), ['rm', '-f', 'c1', 'c2']);
});

test('removeByLabel: refuses an empty run id', async () => {
  const h = harness();
  await assert.rejects(removeByLabel('', h.deps), /runId/);
});

// ---------- pid sidecar wiring ----------

test('resolveDeps: onSpawn reaches the pid of every docker child and every pipe child', async () => {
  const seen = [];
  const d = resolveDeps({ bin: process.execPath, onSpawn: (pid) => seen.push(pid) });
  await d.docker(['-e', '0']);
  assert.equal(seen.length, 1);
  const node = { cmd: 'node', args: ['-e', '0'] };
  await d.pipe(node, node, {});
  assert.equal(seen.length, 3);
});

// ---------- host profile ----------

test('isMerged: checks ancestry against fork/main by default, not local main', () => {
  const git = makeGit({ ancestor: 0 });
  assert.equal(isMerged(git, HEAD), true);
  assert.deepEqual(git.calls[0], ['merge-base', '--is-ancestor', HEAD, 'fork/main']);
});

test('isMerged: an unknown ref is an error, not a silent skip', () => {
  assert.throws(() => isMerged(makeGit({ ancestor: 128 }), HEAD), /cannot check/);
});

test('prepareHost: an unmerged sha is skipped host_unmerged and nothing is extracted', async () => {
  const h = harness({ gitOpts: { ancestor: 1, trees: TREE } });
  const r = await prepareHost({ head: HEAD, flowsSha: FLOWS, evidenceDir: 'C:\\ev' }, h.deps);
  assert.deepEqual(r.skipped, { reason: 'host_unmerged' });
  assert.equal(h.events.length, 0);
});

test('prepareHost: a merged sha is archived with autocrlf off and runs with a stripped env', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
  try {
    const h = harness({ gitOpts: { ancestor: 0, trees: TREE } });
    const r = await prepareHost({ head: HEAD, flowsSha: FLOWS, evidenceDir: 'C:\\ev' }, h.deps);
    assert.equal(r.skipped, undefined);
    assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(r.env.PATH || r.env.Path);
    const archives = h.events.filter((e) => e.kind === 'pipe').map((e) => e.a.args);
    assert.ok(archives[0].includes(HEAD) && archives[0].includes('core.autocrlf=false'));
    assert.ok(archives[1].includes(FLOWS), 'the grading overlay comes from flowsSha');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// ---------- ensureImage and --plan ----------

const IMG_BLOBS = { ...LOCKS, [`${HEAD}:package.json`]: '{}', [`${HEAD}:apps/agentic-os/package.json`]: '{}' };
const IMG_TREES = { [HEAD]: ['package.json', 'package-lock.json', 'apps/agentic-os/package.json'], [IMAGE_SHA]: ['docker/trex/Dockerfile', 'docker/trex/compose.yml'] };

test('ensureImage: an existing image is reused and nothing is built', async () => {
  const h = harness({ gitOpts: { blobs: IMG_BLOBS, trees: IMG_TREES } });
  const r = await ensureImage({ head: HEAD, imageSha: IMAGE_SHA, evidenceDir: 'C:\\ev' }, h.deps);
  assert.equal(r.built, false);
  assert.match(r.tag, /^trex:[0-9a-f]{12}$/);
  assert.ok(!h.dockerArgs().some((a) => a[0] === 'build'));
});

test('ensureImage: a missing image builds from head lockfiles plus imageSha config, with no secret, logged to build.log', async () => {
  const h = harness({
    gitOpts: { blobs: IMG_BLOBS, trees: IMG_TREES },
    dockerReply: (args) => (args[0] === 'image' ? { code: 1, stdout: '', stderr: 'no such image', timedOut: false } : null),
  });
  const r = await ensureImage({ head: HEAD, imageSha: IMAGE_SHA, evidenceDir: 'C:\\ev' }, h.deps);
  assert.equal(r.built, true);
  const build = h.events.find((e) => e.kind === 'docker' && e.args[0] === 'build');
  assert.ok(!build.args.some((a) => a.includes('secret')));
  assert.equal(build.args[build.args.indexOf('-t') + 1], r.tag);
  assert.ok(build.opts.logPath.endsWith('build.log'));
  const archives = h.events.filter((e) => e.kind === 'pipe').map((e) => e.a.args);
  const headArchive = archives.find((a) => a.includes(HEAD));
  assert.ok(headArchive.includes('package-lock.json') && !headArchive.includes('apps/agentic-os/package-lock.json'), 'only lockfiles that exist at head');
  assert.ok(archives.some((a) => a.includes(IMAGE_SHA) && a.includes('docker/trex/Dockerfile')));
});

test('ensureImage: a failed build throws a build-stage error', async () => {
  const h = harness({
    gitOpts: { blobs: IMG_BLOBS, trees: IMG_TREES },
    dockerReply: (args) => (['image', 'build'].includes(args[0]) ? { code: 1, stdout: '', stderr: 'x', timedOut: false } : null),
  });
  await assert.rejects(ensureImage({ head: HEAD, imageSha: IMAGE_SHA, evidenceDir: 'C:\\ev' }, h.deps), (err) => err.stage === 'build');
});

test('planBuilds: counts distinct tags that are not built yet and multiplies by the estimate', async () => {
  const other = 'o'.repeat(40);
  const blobs = { ...IMG_BLOBS, [`${other}:package-lock.json`]: 'other-lock', [`${other}:apps/agentic-os/package-lock.json`]: 'app-lock' };
  const git = makeGit({ blobs });
  const have = new Set();
  const plan = await planBuilds({ git, heads: [HEAD, HEAD, other], imageSha: IMAGE_SHA, hasImage: async (tag) => have.has(tag), estSec: 100 });
  assert.equal(plan.total, 2);
  assert.equal(plan.toBuild, 2);
  assert.equal(plan.estSeconds, 200);
  have.add(plan.images[0].tag);
  const again = await planBuilds({ git, heads: [HEAD, other], imageSha: IMAGE_SHA, hasImage: async (tag) => have.has(tag), estSec: 100 });
  assert.equal(again.toBuild, 1);
  assert.equal(again.estSeconds, 100);
});

test('main --plan: prints the count and seconds, runs no build and no container', async () => {
  const h = harness({
    gitOpts: { blobs: IMG_BLOBS },
    dockerReply: (args) => (args[0] === 'image' ? { code: 1, stdout: '', stderr: 'none', timedOut: false } : null),
  });
  const lines = [];
  const code = await main(['--plan', '--heads', HEAD, '--image-sha', IMAGE_SHA, '--est-sec', '300'], { ...h.deps, out: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /1 of 1 images? to build, estimated 300 s/);
  for (const args of h.dockerArgs()) assert.deepEqual(args.slice(0, 2), ['image', 'inspect']);
  assert.equal(h.events.filter((e) => e.kind === 'pipe').length, 0);
});

test('main: without --plan it refuses to run', async () => {
  const h = harness();
  const lines = [];
  const code = await main([], { ...h.deps, out: (l) => lines.push(l) });
  assert.equal(code, 2);
});

// ---------- Env.exec kill codes (H2) ----------

/** Starts an env whose fake docker advances the clock by `seconds` on every exec and answers `reply`. */
async function execAfter(seconds, reply, opts = {}) {
  let now = 0;
  const dockerReply = (args) => {
    if (!args.includes('timeout')) return null;
    now += seconds * 1000;
    return reply;
  };
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS }, dockerReply });
  const env = await startEnv({ ...START, flows: [PLAIN_FLOW] }, { ...h.deps, clock: () => now });
  return { env, res: await env.exec(['x'], { timeoutSec: 30, ...opts }) };
}

const KILLED = { code: 137, timedOut: false, stdout: '', stderr: '' };

test('Env.exec: exit 137 after the full budget grades not_attempted/timeout, not a failed check', async () => {
  // Breaks when exec returns the raw 137: the in-container `timeout -s KILL` fires before the CLI timer.
  const { res } = await execAfter(30, KILLED);
  assert.equal(res.timedOut, true);
  assert.deepEqual(gradeCheck({ text: 'ok', exit: 0 }, toStepResult(res)), { state: 'not_attempted', reason: 'timeout' });
});

test('Env.exec: exit 124 after the full budget is a time-out too', async () => {
  // Breaks when only 137 is mapped.
  const { res } = await execAfter(31, { ...KILLED, code: 124 });
  assert.equal(res.timedOut, true);
});

test('Env.exec: exit 137 before the budget is an OOM kill, counted on the env and reasoned oom_killed', async () => {
  // Breaks when an early 137 is graded as an ordinary failed check or loses its reason.
  const { env, res } = await execAfter(5, KILLED);
  assert.equal(res.timedOut, false);
  assert.equal(res.reason, 'oom_killed');
  assert.equal(res.code, 137);
  assert.equal(env.oomHits, 1);
});

test('Env.exec: an ordinary non-zero exit passes through untouched', async () => {
  // Breaks when the kill mapping catches every non-zero code.
  const { env, res } = await execAfter(40, { ...KILLED, code: 1 });
  assert.deepEqual([res.code, res.timedOut, res.reason, env.oomHits], [1, false, undefined, 0]);
});

// ---------- tar in cpOut (H1) ----------

test('Env.cpOut: extracts with the resolved tar and reports ok:false when nothing landed', async () => {
  // Breaks when cpOut spawns bare tar again, or trusts exit codes when tar extracted nothing.
  const h = harness({ gitOpts: { trees: TREE, blobs: BLOBS } });
  const env = await startEnv({ ...START, flows: [PLAIN_FLOW] }, { ...h.deps, env: { TAR_BIN: 'Z:\\tar.exe' } });
  assert.deepEqual(await env.cpOut('/trex-out', 'C:\\ev\\out'), { ok: true });
  assert.equal(h.events.filter((e) => e.kind === 'pipe').at(-1).b.cmd, 'Z:\\tar.exe');
  const empty = await startEnv({ ...START, flows: [PLAIN_FLOW] }, { ...h.deps, readdir: () => [] });
  assert.deepEqual(await empty.cpOut('/trex-out', 'C:\\ev\\out'), { ok: false });
});

// ---------- host flows must be merged (M-host-flows) ----------

test('prepareHost: an unmerged flowsSha is skipped host_unmerged and nothing is extracted', async () => {
  // Breaks when only head is checked: a PR could then run host commands from flows it wrote.
  const h = harness({ gitOpts: { ancestor: (sha) => (sha === FLOWS ? 1 : 0), trees: TREE } });
  const r = await prepareHost({ head: HEAD, flowsSha: FLOWS, imageSha: IMAGE_SHA, evidenceDir: 'C:\\ev' }, h.deps);
  assert.deepEqual(r.skipped, { reason: 'host_unmerged' });
  assert.equal(h.events.length, 0);
});

test('prepareHost: an unmerged imageSha is skipped host_unmerged', async () => {
  // Breaks when imageSha is not checked.
  const h = harness({ gitOpts: { ancestor: (sha) => (sha === IMAGE_SHA ? 1 : 0), trees: TREE } });
  const r = await prepareHost({ head: HEAD, flowsSha: FLOWS, imageSha: IMAGE_SHA, evidenceDir: 'C:\\ev' }, h.deps);
  assert.deepEqual(r.skipped, { reason: 'host_unmerged' });
  assert.equal(h.events.length, 0);
});

test('prepareHost: head, flowsSha and imageSha all merged proceeds', async () => {
  // Breaks when the new check rejects a fully merged set.
  const h = harness({ gitOpts: { ancestor: 0, trees: TREE } });
  const r = await prepareHost({ head: HEAD, flowsSha: FLOWS, imageSha: IMAGE_SHA, evidenceDir: 'C:\\ev' }, h.deps);
  assert.equal(r.skipped, undefined);
  const asked = h.git.calls.filter((c) => c[0] === 'merge-base').map((c) => c[2]);
  assert.deepEqual(asked, [HEAD, FLOWS, IMAGE_SHA]);
});

// ---------- build command (M-build) ----------

const NO_IMAGE = (args) => (args[0] === 'image' ? { code: 1, stdout: '', stderr: 'none', timedOut: false } : null);
const buildHarness = () => harness({ gitOpts: { blobs: IMG_BLOBS, trees: IMG_TREES }, dockerReply: NO_IMAGE });
const BUILD_ARGS = ['--build', '--heads', HEAD, '--image-sha', IMAGE_SHA];

test('imageTagsFor: gives the tag ensureImage would use, one per head', () => {
  // Breaks when the tag formula differs from ensureImage, so bench preflight checks the wrong tag.
  const h = buildHarness();
  assert.deepEqual(imageTagsFor(h.git, [HEAD, HEAD], IMAGE_SHA), Array(2).fill(`trex:${lockHash(h.git, HEAD, IMAGE_SHA)}`));
});

test('imageExists: true only when docker image inspect exits 0', async () => {
  // Breaks when the exit code is ignored.
  const yes = harness();
  assert.equal(await imageExists('trex:abc', yes.deps), true);
  assert.deepEqual(yes.dockerArgs(), [['image', 'inspect', 'trex:abc']]);
  assert.equal(await imageExists('trex:abc', buildHarness().deps), false);
});

test('main --build alone prints the plan, refuses, and builds nothing', async () => {
  // Breaks when --build runs without a plan or --yes.
  const h = buildHarness();
  const lines = [];
  const code = await main(BUILD_ARGS, { ...h.deps, out: (l) => lines.push(l) });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /1 of 1 images? to build/);
  assert.ok(!h.dockerArgs().some((a) => a[0] === 'build'));
});

test('main --plan --build prints the plan first, then builds and prints each tag with seconds', async () => {
  // Breaks when the build runs before the plan is printed, or when no tag line is printed.
  const h = buildHarness();
  const lines = [];
  const code = await main([...BUILD_ARGS, '--plan'], { ...h.deps, out: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.ok(h.dockerArgs().some((a) => a[0] === 'build'));
  const plan = lines.findIndex((l) => l.startsWith('trex plan:'));
  const built = lines.findIndex((l) => /^trex:[0-9a-f]{12} (built|present) \d+ s$/.test(l));
  assert.ok(plan >= 0 && built > plan, lines.join('\n'));
});

test('main --build --yes builds without --plan', async () => {
  // Breaks when --yes is not accepted.
  const h = buildHarness();
  const code = await main([...BUILD_ARGS, '--yes'], { ...h.deps, out: () => {} });
  assert.equal(code, 0);
  assert.ok(h.dockerArgs().some((a) => a[0] === 'build'));
});

// ---------- git child env (L-git-env) ----------

test('resolveDeps: the default git does not pass ANTHROPIC_API_KEY to the git child', () => {
  // Breaks when resolveDeps goes back to the pre-pr makeGit, which passes the whole env.
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret-xyz';
  try {
    const root = path.resolve(here, '..', '..');
    const r = resolveDeps({ cwd: root }).git(['-c', 'alias.showkey=!echo key=$ANTHROPIC_API_KEY', 'showkey']);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('sk-test-secret-xyz'));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
