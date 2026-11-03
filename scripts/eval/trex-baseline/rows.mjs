// Reads the TREX bench rows (read-only) and resolves them with git. Returns row objects for adapter.mjs.
// The oracle (fix subject, fix hunk, old-side lines) is for scoring only. The engine never sees it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NEGATIVE_IDS, POSITIVE_IDS, normPath, parseOldRanges, splitRange } from './adapter.mjs';

const SHA40 = /^[0-9a-f]{40}$/;

/** git(args) => stdout string; throws on a non-zero exit. */
function resolve(git, ref) {
  const out = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  if (!SHA40.test(out)) throw new Error(`cannot resolve ${ref}`);
  return out;
}

export function buildRows({ benchDir, git }) {
  const proofs = JSON.parse(readFileSync(path.join(benchDir, 'proofs-trex.json'), 'utf8')).rows;
  const negs = JSON.parse(readFileSync(path.join(benchDir, 'negatives.json'), 'utf8')).negatives;
  const rows = [];
  for (const id of POSITIVE_IDS) {
    const p = proofs.find((r) => r.major === id);
    if (!p) throw new Error(`bench row ${id} is missing`);
    const { base, head } = splitRange(p.bench.authorRange);
    const pre40 = resolve(git, p.pre);
    const fix40 = resolve(git, p.fix);
    const head40 = resolve(git, head);
    const defectFiles = p.bench.defectFiles.map(normPath);
    // Old-side lines of the fix hunks apply to the reviewed tree only when the reviewed head is the pre SHA itself.
    const oldRanges = head40 === pre40 ? parseOldRanges(git(['diff', '-U0', '--no-color', '--no-ext-diff', pre40, fix40, '--', ...defectFiles])) : {};
    rows.push({
      id, kind: 'positive', base40: resolve(git, base), head40, pre40, fix40, defectFiles, oldRanges,
      fixSubject: git(['log', '-1', '--format=%s', fix40]).trim(), fixBody: git(['log', '-1', '--format=%b', fix40]).trim(),
      fixHunk: git(['diff', '-U3', '--no-color', '--no-ext-diff', pre40, fix40, '--', ...defectFiles]),
    });
  }
  for (const id of NEGATIVE_IDS) {
    const n = negs.find((r) => r.id === id);
    if (!n) throw new Error(`negative ${id} is missing`);
    const head40 = resolve(git, n.head);
    rows.push({ id, kind: 'negative', base40: resolve(git, `${head40}^1`), head40, defectFiles: [] });
  }
  return rows;
}
