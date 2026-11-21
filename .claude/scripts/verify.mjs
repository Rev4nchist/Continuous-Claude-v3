#!/usr/bin/env node
// verify.mjs: run a project's registry `e2e` check and save the output plus a JSON sidecar.
// Usage: node ~/.claude/scripts/verify.mjs [--project <name>] [--registry <path>] [--artifact <path>] [--dry-run]
// Exit: the command's code; 2 = not filled in or usage; 3 = deliberately none; 4 = reserved for project scripts.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const USAGE = 'usage: verify.mjs [--project <name>] [--registry <path>] [--artifact <path>] [--dry-run]';
const FLAGS = { '--project': 'project', '--registry': 'registry', '--artifact': 'artifact' };
const die = (msg, code) => { process.stderr.write(`${msg}\n`); process.exit(code); };
const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
const isUnder = (dir, root) => dir === root || dir.startsWith(`${root}/`);
const slash = (p) => p.replace(/\\/g, '/');
const now = () => new Date().toISOString();

function parseArgs(argv) {
  const opts = { registry: path.join(os.homedir(), '.claude', 'project-registry.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (FLAGS[a] && i + 1 < argv.length) opts[FLAGS[a]] = argv[++i];
    else die(USAGE, 2);
  }
  return opts;
}

function loadRegistry(file) {
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return die(`verify: cannot read registry ${file}: ${e.message}`, 2);
  }
  if (!reg || !Array.isArray(reg.projects)) return die(`verify: registry ${file} has no "projects" array`, 2);
  return reg.projects.filter((p) => p && typeof p.name === 'string' && typeof p.path === 'string');
}

function gitLines(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null;
}

function resolveRoots(cwd) {
  const out = gitLines(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!out || out.length < 3) return { lookup: cwd, toplevel: cwd, linked: false, mainRoot: null };
  const [gitDir, common, toplevel] = out;
  if (norm(gitDir) === norm(common)) return { lookup: cwd, toplevel, linked: false, mainRoot: null };
  const mainRoot = path.dirname(common);
  return { lookup: path.join(mainRoot, path.relative(toplevel, cwd)), toplevel, linked: true, mainRoot };
}

function findEntry(projects, lookup, name) {
  if (name) return projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const dir = norm(lookup);
  const hits = projects.filter((p) => isUnder(dir, norm(p.path)));
  return hits.sort((a, b) => norm(b.path).length - norm(a.path).length)[0];
}

function mapRunCwd(roots, entryPath) {
  if (!roots.linked || !isUnder(norm(entryPath), norm(roots.mainRoot))) return entryPath;
  return path.join(roots.toplevel, path.relative(roots.mainRoot, entryPath));
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

function artifactPath(root, entry, opts, st) {
  const configured = entry.e2e.artifact && entry.e2e.artifact.replaceAll('<stamp>', st);
  const rel = opts.artifact ?? configured ?? `.claude/cache/e2e/${st}-verify-${slug(entry.name)}.log`;
  const full = path.resolve(root, rel);
  if (!norm(full).startsWith(`${norm(root)}/`)) die(`verify: artifact ${rel} must stay inside the project repo ${slash(root)}`, 2);
  return slash(full);
}

function writeSidecar(file, d) {
  const { project, command, exit, started, finished, artifact, head } = d;
  fs.writeFileSync(file, `${JSON.stringify({ project, command, exit, started, finished, artifact, head }, null, 2)}\n`);
}

function openArtifact(artifact, base, command) {
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, `# verify ${base.project} | ${command} | started ${base.started} | head ${base.head}\n`);
}

// `settled` below: 'error' can be followed by 'close' with another code; the first one wins.
function runCommand(plan) {
  const { command, runCwd, artifact, base } = plan;
  const sidecar = `${artifact}.json`;
  const save = (exit, finished) => writeSidecar(sidecar, { ...base, exit, finished, artifact });
  openArtifact(artifact, base, command);
  save(null, null);
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: runCwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (out) => (chunk) => { out.write(chunk); fs.appendFileSync(artifact, chunk); };
    const stop = () => { child.kill(); save(null, now()); process.exit(1); };
    child.stdout.on('data', tee(process.stdout));
    child.stderr.on('data', tee(process.stderr));
    ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, stop));
    let settled = false;
    const finish = (code) => { if (settled) return; settled = true; save(code, now()); resolve({ code, sidecar }); };
    child.on('error', (e) => { process.stderr.write(`verify: ${e.message}\n`); finish(1); });
    child.on('close', (code) => finish(code ?? 1));
  });
}

function requireE2e(entry) {
  const e2e = entry.e2e;
  if (!e2e) die(`verify: ${entry.name} has no e2e field. Run the check in its testing rules (AGENTS.md "Testing", or docs/testing-standard.md), or add {command, artifact} or {none: "<reason>"} to the registry entry.`, 2);
  if (typeof e2e.none === 'string') die(`verify: ${entry.name} has no e2e surface: ${e2e.none}`, 3);
  if (typeof e2e.command !== 'string' || !e2e.command) die(`verify: ${entry.name} e2e has no command. Add {command, artifact} or {none: "<reason>"}.`, 2);
  if (e2e.artifact != null && typeof e2e.artifact !== 'string') die(`verify: ${entry.name} e2e.artifact must be a string path.`, 2);
  return e2e;
}

function pickEntry(projects, roots, opts) {
  const entry = findEntry(projects, roots.lookup, opts.project);
  if (entry) return entry;
  const msg = opts.project ? `verify: no project named ${opts.project} in ${opts.registry}`
    : `verify: no registry entry for ${process.cwd()}; add one (project-registry skill) or pass --project`;
  return die(msg, 2);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const roots = resolveRoots(process.cwd());
  const entry = pickEntry(loadRegistry(opts.registry), roots, opts);
  const { command } = requireE2e(entry);
  const runCwd = mapRunCwd(roots, entry.path);
  const artifactRoot = (gitLines(runCwd, ['rev-parse', '--show-toplevel']) || [runCwd])[0];
  const artifact = artifactPath(artifactRoot, entry, opts, stamp());
  if (opts.dryRun) {
    const plan = { project: entry.name, command, cwd: slash(runCwd), artifact, registry: slash(path.resolve(opts.registry)) };
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  const head = (gitLines(runCwd, ['rev-parse', '--short', 'HEAD']) || [null])[0];
  const base = { project: entry.name, command, started: now(), head };
  const { code, sidecar } = await runCommand({ command, runCwd, artifact, base });
  process.stdout.write(`verify: exit ${code}, sidecar ${sidecar}\n`);
  process.exitCode = code;
}

main();
