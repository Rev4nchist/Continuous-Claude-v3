#!/usr/bin/env node
/**
 * shared-deps.mjs: the shared store link for nested worktrees.
 *
 * Why: node_modules is installed only in the primary checkout, in <primary>/.claude/hooks/node_modules. Node finds a
 * package by walking up parent folders. From <primary>/.claude/worktrees/<name> the walk reaches
 * <primary>/.claude/worktrees/node_modules, so one link there serves every nested worktree. The link sits outside every
 * worktree folder, so no `git worktree remove` can reach it.
 *
 *   link   = <primary>/.claude/worktrees/node_modules
 *   target = <primary>/.claude/hooks/node_modules
 *
 * Usage: node scripts/worktree/shared-deps.mjs --check | --apply | --unlink | --help
 *   --check   print one line "STORE <state>: <detail>". Exit 0 only when the state is ok, else 1. Runs anywhere.
 *   --apply   make the link. Runs only in the primary checkout. Exit 1 on a refusal. Needs Dave's yes before use.
 *   --unlink  remove the link and nothing else. Runs only in the primary checkout. Exit 1 on a refusal.
 *   no flag or an unknown flag: one usage line, exit 2.
 *
 * State of the link, judged in this order (checkStore):
 *   link path empty, target whole      absent         (target whole = a real folder that holds .package-lock.json)
 *   link path empty, target not whole  no-target
 *   something there, not a link        not-a-link     (a real file or folder: never touched)
 *   link does not resolve              dangling
 *   link resolves, target path missing wrong-target   (the link points to another folder)
 *   link resolves, not to the target   wrong-target
 *   link resolves to the target, target not whole   no-target
 *   otherwise                          ok
 *
 * Safety: the link is made with fs.symlinkSync(target, link, 'junction') only: no mklink, no cmd, no shell text.
 * apply never replaces anything at the link path. unlink checks lstat().isSymbolicLink() first and removes the link
 * alone with a non-recursive rmdirSync (unlinkSync for a POSIX symlink). No code path here deletes recursively.
 * No code path runs npm, npx or pnpm. Importing this file does nothing: no I/O until a function is called.
 * It imports only node builtins and scripts/lib/resolve-deps.mjs, so it runs with no node_modules installed.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { primaryRoot, primaryRootStrict } from '../lib/resolve-deps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN_CHECKOUT = path.resolve(HERE, '..', '..');
const LOCK = '.package-lock.json';

export const storeLinkPath = (primary) => path.join(primary, '.claude', 'worktrees', 'node_modules');
export const storeTargetPath = (primary) => path.join(primary, '.claude', 'hooks', 'node_modules');

const lstatOrNull = (p) => { try { return lstatSync(p); } catch { return null; } };
const realOrNull = (p) => { try { return realpathSync.native(p); } catch { return null; } };

/** Two real paths name the same folder. Case-insensitive on Windows. */
const sameReal = (a, b) => {
  const n = (p) => p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** The target is a real folder (not a link) that holds .package-lock.json, or says why not. */
function targetProblem(target) {
  const st = lstatOrNull(target);
  if (!st) return `${target} does not exist`;
  if (st.isSymbolicLink()) return `${target} is itself a link`;
  if (!st.isDirectory()) return `${target} is not a folder`;
  if (!existsSync(path.join(target, LOCK))) return `${target} has no ${LOCK}: no complete install`;
  return null;
}

/** { state, link, target, detail }. Read only. */
export function checkStore({ primary }) {
  const link = storeLinkPath(primary);
  const target = storeTargetPath(primary);
  const out = (state, detail) => ({ state, link, target, detail });
  const st = lstatOrNull(link);
  if (!st) {
    // A target that is itself a link still counts as whole here: apply is the one that refuses it.
    const whole = existsSync(path.join(target, LOCK));
    return whole ? out('absent', `nothing at ${link}`) : out('no-target', `nothing at ${link}, and ${target} is missing or has no ${LOCK}`);
  }
  if (!st.isSymbolicLink()) return out('not-a-link', `${link} is a real ${st.isDirectory() ? 'folder' : 'file'}, not a link`);
  const resolved = realOrNull(link);
  if (!resolved) return out('dangling', `${link} is a link to a path that does not exist`);
  const want = realOrNull(target);
  if (!want) return out('wrong-target', `${link} points to ${resolved}, and ${target} is missing`);
  if (!sameReal(resolved, want))return out('wrong-target', `${link} points to ${resolved}, not ${want}`);
  if (!existsSync(path.join(target, LOCK))) return out('no-target', `${target} has no ${LOCK}: no complete install`);
  return out('ok', `${link} -> ${want}`);
}

/**
 * The checkout the script runs from must be the primary. Real paths, so a short or linked temp path still matches.
 * Strict: git must answer (a failed call is a refusal, never a pass) and <root>/.git must be a folder, not the file a
 * linked worktree has.
 */
function rootIsPrimary(primary, root) {
  const fromGit = primaryRootStrict(root);
  const gitDir = lstatOrNull(path.join(root, '.git'));
  if (!fromGit || !gitDir || !gitDir.isDirectory()) return false;
  const a = realOrNull(root);
  const b = realOrNull(primary);
  const c = realOrNull(fromGit);
  return Boolean(a && b && c && sameReal(a, b) && sameReal(a, c));
}

const refuse = (detail) => ({ ok: false, action: 'refused', detail });
const NOT_PRIMARY = (root, primary) => `${root} is not the primary checkout ${primary}, or git could not confirm it: run this in the primary`;

/**
 * Makes the link. Refuses unless root is the primary, the link path is empty and the target is a whole real folder.
 * `symlink` is injectable so a test can make the link call fail.
 */
export function applyStore({ primary, root, symlink = symlinkSync }) {
  if (!rootIsPrimary(primary, root)) return refuse(NOT_PRIMARY(root, primary));
  const link = storeLinkPath(path.resolve(primary));
  const target = storeTargetPath(path.resolve(primary));
  const state = checkStore({ primary });
  if (state.state !== 'absent') return refuse(`the store is ${state.state}, not absent: ${state.detail}`);
  const problem = targetProblem(target);
  if (problem) return refuse(problem);
  try {
    mkdirSync(path.dirname(link), { recursive: true });
    symlink(target, link, 'junction');
  } catch (err) {
    return refuse(`could not create ${link}: ${err.code ?? err.message}`);
  }
  return { ok: true, action: 'linked', detail: `${link} -> ${target}` };
}

/** Removes the link alone. Refuses unless root is the primary and the link path holds a link. */
export function unlinkStore({ primary, root }) {
  if (!rootIsPrimary(primary, root)) return refuse(NOT_PRIMARY(root, primary));
  const link = storeLinkPath(primary);
  const st = lstatOrNull(link);
  if (!st) return { ok: true, action: 'none', detail: `nothing at ${link}` };
  if (!st.isSymbolicLink()) return refuse(`${link} is a real ${st.isDirectory() ? 'folder' : 'file'}, not a link: left alone`);
  try {
    try { rmdirSync(link); } catch (err) { if (err.code !== 'ENOTDIR') throw err; unlinkSync(link); }
  } catch (err) {
    return refuse(`could not remove ${link}: ${err.code ?? err.message}`);
  }
  return { ok: true, action: 'unlinked', detail: `removed ${link}` };
}

const USAGE = 'usage: node scripts/worktree/shared-deps.mjs --check | --apply | --unlink | --help';
const HELP = `${USAGE}
--check   print "STORE <state>: <detail>"; exit 0 only when the state is ok
--apply   link <primary>/.claude/worktrees/node_modules to <primary>/.claude/hooks/node_modules (primary only; needs Dave's yes)
--unlink  remove that link and nothing else (primary only)
`;

function main(argv) {
  const flag = argv.length === 1 ? argv[0] : null;
  if (flag === '--help' || flag === '-h') { process.stdout.write(HELP); return 0; }
  if (!['--check', '--apply', '--unlink'].includes(flag)) { process.stderr.write(`${USAGE}\n`); return 2; }
  const primary = primaryRoot(OWN_CHECKOUT);
  if (flag === '--check') {
    const r = checkStore({ primary });
    process.stdout.write(`STORE ${r.state}: ${r.detail}\n`);
    return r.state === 'ok' ? 0 : 1;
  }
  const r = (flag === '--apply' ? applyStore : unlinkStore)({ primary, root: OWN_CHECKOUT });
  (r.ok ? process.stdout : process.stderr).write(`STORE ${r.action}: ${r.detail}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
