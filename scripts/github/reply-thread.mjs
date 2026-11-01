#!/usr/bin/env node
/**
 * reply-thread.mjs: post a reply to an inline PR review comment (a review thread), from a file.
 *
 * Why: 14 thread replies on PRs #225, #227 and #238 read "System.Collections.Hashtable[<id>]" or
 * "System.Collections.Hashtable.body". The agent typed `gh api ... -f body=$replies[$id]` in PowerShell.
 * An unquoted native argument expands `$replies` to the hashtable's ToString() and keeps `[<id>]` as text.
 * Here the reply text comes from a file and goes to gh as `-F body=@<file>`: no shell variable reaches it.
 *
 * Usage: node scripts/github/reply-thread.mjs <pr> <comment-id> --body-file <file> [--repo owner/name]
 *   <comment-id> is the id of the first (top-level) comment of the thread: `gh api repos/<O>/<R>/pulls/<N>/comments`.
 *   Write the file with the Write tool. Prints ONE line on success: `replied <new-comment-id> <url>`.
 *
 * It refuses an empty body and a body that holds a PowerShell type name anywhere (System.Collections...),
 * the signature of the bug above. It posts nothing then.
 *
 * Exit 0 = posted. 1 = refused or gh failed (nothing posted, or the reply is unconfirmed). 2 = bad usage.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
const USAGE = 'usage: reply-thread.mjs <pr> <comment-id> --body-file <file> [--repo owner/name]';
// "$map[$id]" and "$map.body" in a PowerShell string or native argument print the type name. In an interpolated string
// ("Fixed in abc: $h.body") it sits after other text, so the match is anywhere in the body, not only at the start.
const GARBLED = /System\.(?:Collections|Management\.Automation)\./;

/** { pr, commentId, repo, bodyFile } from argv. Throws on anything unknown, missing or non-numeric. */
export function parseArgs(argv) {
  const nums = [];
  let repo = DEFAULT_REPO;
  let bodyFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--body-file' || a === '--repo') {
      const v = argv[(i += 1)];
      if (v === undefined || v.startsWith('--')) throw new Error(`invalid: ${a} needs a value. ${USAGE}`);
      if (a === '--repo') repo = v;
      else bodyFile = v;
    } else if (/^\d+$/.test(a)) nums.push(Number(a));
    else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}. ${USAGE}`);
    else throw new Error(`invalid argument: ${a}. ${USAGE}`);
  }
  if (nums.length !== 2 || nums.some((n) => !Number.isSafeInteger(n) || n <= 0) || !bodyFile) throw new Error(USAGE);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid --repo: ${repo}. ${USAGE}`);
  return { pr: nums[0], commentId: nums[1], repo, bodyFile };
}

/** The gh arguments. The body is a file field (-F body=@file), never text on the command line. */
export function replyArgs({ repo, pr, commentId, bodyFile }) {
  return ['api', `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`, '-X', 'POST', '-F', `body=@${bodyFile}`];
}

/** Throws when the file is unreadable, empty or garbled. */
export function checkBody(text) {
  if (!text.trim()) throw new Error('refused: the body file is empty');
  if (GARBLED.test(text)) {
    throw new Error('refused: the body holds a PowerShell type name such as System.Collections.Hashtable (a hashtable printed as text). Write the real reply text to the file.');
  }
}

function defaultRunGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}

/** Run with injectable deps { runGh, readFile, stdout, stderr }. Returns the exit code. */
export function main(argv, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr(`reply-thread: ${err.message}\n`);
    return 2;
  }
  try {
    checkBody(readFile(opts.bodyFile));
  } catch (err) {
    stderr(`reply-thread: ${err.message}\n`);
    return 1;
  }
  let reply;
  try {
    reply = JSON.parse(runGh(replyArgs(opts)));
  } catch (err) {
    stderr(`reply-thread: ${String(err.message).split('\n')[0]}\n`);
    return 1;
  }
  if (!reply || typeof reply.id !== 'number') {
    stderr(`reply-thread: gh returned no comment id: ${JSON.stringify(reply)?.slice(0, 200)}\n`);
    return 1;
  }
  stdout(`replied ${reply.id} ${reply.html_url ?? ''}`.trimEnd() + '\n');
  return 0;
}

function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isMain()) process.exit(main(process.argv.slice(2)));
