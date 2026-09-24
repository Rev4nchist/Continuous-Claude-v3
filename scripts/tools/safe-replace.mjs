#!/usr/bin/env node
// Exact-string replace that fails loudly. Scripted edits in this repo silently no-op'd when an
// LF anchor met a CRLF file (27 CRLF / 19 LF files in rules-src alone, 2026-09-23 eval, P30).
// This helper matches line endings loosely, keeps the file's own ending on write, exits non-zero
// when the anchor matches a different number of times than expected, and never rewrites a file
// whose content would not change.
//
//   node scripts/tools/safe-replace.mjs <file> --old <text> --new <text> [--count N]
//   node scripts/tools/safe-replace.mjs <file> --old-file a.txt --new-file b.txt
//
// Exit codes: 0 replaced, 1 anchor count mismatch (file untouched), 2 usage or read error.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Replace every occurrence of `oldText` in `text`. Line endings in both are compared as LF. */
export function replaceExact(text, oldText, newText, { count = 1 } = {}) {
  if (!oldText) throw new Error('old text is empty');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lf = (s) => s.replace(/\r\n/g, '\n');
  const body = lf(text);
  const anchor = lf(oldText);
  const found = body.split(anchor).length - 1;
  if (found !== count) return { ok: false, found, text };
  const out = body.split(anchor).join(lf(newText));
  return { ok: true, found, text: eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out };
}

function parseArgs(argv) {
  const a = { file: argv[0], count: 1 };
  for (let i = 1; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (v === undefined) throw new Error(`missing value for ${k}`);
    if (k === '--old') a.old = v;
    else if (k === '--new') a.new = v;
    else if (k === '--old-file') a.old = readFileSync(v, 'utf8');
    else if (k === '--new-file') a.new = readFileSync(v, 'utf8');
    else if (k === '--count') a.count = Number(v);
    else throw new Error(`unknown flag ${k}`);
  }
  if (!a.file || a.old === undefined || a.new === undefined) throw new Error('usage: <file> --old|--old-file ... --new|--new-file ... [--count N]');
  if (!Number.isInteger(a.count) || a.count < 1) throw new Error('--count must be a positive integer');
  return a;
}

function main() {
  let args, text;
  try {
    args = parseArgs(process.argv.slice(2));
    text = readFileSync(args.file, 'utf8');
  } catch (e) {
    console.error(`safe-replace: ${e.message}`);
    process.exit(2);
  }
  const r = replaceExact(text, args.old, args.new, { count: args.count });
  if (!r.ok) {
    console.error(`safe-replace: ${args.file}: anchor matched ${r.found} time(s), expected ${args.count}; file not changed`);
    process.exit(1);
  }
  if (r.text !== text) writeFileSync(args.file, r.text);
  console.log(`safe-replace: ${args.file}: replaced ${r.found}`);
}

const isDirectRun = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isDirectRun) main();
