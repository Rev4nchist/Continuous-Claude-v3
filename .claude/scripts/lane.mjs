#!/usr/bin/env node
/**
 * Lane CLI shim. One stable path for every model-run command:
 *
 *   node <home>/.claude/scripts/lane.mjs <verb> ...
 *
 * It runs <home>/continuous-claude/scripts/coordination/lane.mjs (the primary checkout) in this process.
 * lane.mjs runs at the top level, reads process.argv.slice(2), resolves `pg` from its own location and calls
 * process.exit itself, so exit codes 1, 2 and 3 pass through with no second node start.
 * DO NOT give lane.mjs an `argv[1]` main check: this import would then run nothing (lane-shim.test.mjs pins it).
 *
 * The primary off `main` is a WARNING on stderr, never a refusal: a branch switch in the primary checkout
 * must not become a lane outage for every project.
 *
 * Self-contained on purpose. Once synced it sits in ~/.claude/scripts with no sibling modules.
 * Every printed path uses forward slashes and the real home folder, never a literal `~`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const fwd = (p) => String(p).replace(/\\/g, '/');
const override = process.env.CCV3_USER_HOME && process.env.CCV3_USER_HOME.trim();
const primary = `${fwd(override || homedir()).replace(/\/+$/, '')}/continuous-claude`;
const target = `${primary}/scripts/coordination/lane.mjs`;

if (!existsSync(target)) {
  process.stderr.write(`lane shim: ${target} does not exist. The lane CLI lives in the primary checkout ${primary}; restore it (git -C ${primary} status) or set CCV3_USER_HOME.\n`);
  process.exit(1);
}

/** The branch the primary checkout is on, read from .git/HEAD (no git start). null when it cannot be read. */
function primaryHead() {
  try {
    const head = readFileSync(`${primary}/.git/HEAD`, 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? { branch: ref[1] } : { detached: head.slice(0, 7) };
  } catch {
    return null; // .git is a file or missing: not a plain checkout, nothing to say
  }
}

const head = primaryHead();
if (head && head.branch !== 'main') {
  const where = head.detached ? `a detached HEAD at ${head.detached}` : `branch '${head.branch}'`;
  process.stderr.write(`WARNING: lane shim: ${primary} is on ${where}, not main; running its lane.mjs anyway. Switch it back to main when you can.\n`);
}

await import(pathToFileURL(target).href);
