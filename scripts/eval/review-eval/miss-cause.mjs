// The deterministic part of the miss-cause rubric (rubrics/miss-cause.md). Pure functions: no model, no git, no files.
// A result is { cls, reason } for a deterministic class, or { judge: [labels] } when the judge must pick.
// Every result carries impactRowsEmpty. Today no producer writes impact rows, so step 2 has no data (seat ruling, Q2).
// The truth id is added by the caller.
// Known limits: a filesRead path outside the tree (an absolute path) does not match a relative diff path;
// in delta mode diffFiles holds only the delta files, so the result says deltaMode: true.

/** One path form: forward slashes, no leading ./, lower case. Case is always folded: the record does not say which OS made it. */
export function normPath(p) {
  return String(p ?? '').replaceAll('\\', '/').replace(/^(\.\/)+/, '').toLowerCase();
}

// A list entry is a plain string or an object with a path field.
const pathOf = (e) => (typeof e === 'string' ? e : e?.path);
const setOf = (list) => new Set((Array.isArray(list) ? list : []).map(pathOf).filter((p) => typeof p === 'string' && p !== '').map(normPath));

// The judge may always answer insufficient_evidence (the rubric allows it).
const GOOD_PAIR = {
  1: ['in_diff_logic', 'policy_difference', 'insufficient_evidence'],
  2: ['opened_dismissed', 'policy_difference', 'insufficient_evidence'],
};

function missing(name, impactRowsEmpty) {
  return { cls: 'insufficient_evidence', missing: name, reason: `the input ${name} is missing`, impactRowsEmpty };
}

function classify({ truthPath, diffFiles, hunkFiles, filesRead, impactRows }) {
  const impactRowsEmpty = !Array.isArray(impactRows) || impactRows.length === 0;
  if (typeof truthPath !== 'string' || truthPath === '') return missing('truthPath', impactRowsEmpty);
  if (!Array.isArray(filesRead)) return missing('filesRead', impactRowsEmpty);
  // A reviewed diff always has a file, so an empty or missing list is a missing input, not a class.
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) return missing('diffFiles', impactRowsEmpty);
  const t = normPath(truthPath);
  const lists = { diffFiles: setOf(diffFiles), hunkFiles: setOf(hunkFiles), impactRows: setOf(impactRows) };
  const read = setOf(filesRead).has(t);
  const diffHeld = ['diffFiles', 'hunkFiles'].filter((k) => lists[k].has(t));
  const step = diffHeld.length ? 1 : lists.impactRows.has(t) ? 2 : 3;
  if (step === 3) return { cls: 'not_in_impact', reason: 'the truth path is in none of diffFiles, hunkFiles and impactRows', heldBy: [], impactRowsEmpty };
  const heldBy = step === 1 ? diffHeld : ['impactRows'];
  if (read) return { judge: GOOD_PAIR[step], heldBy: [...heldBy, 'filesRead'], impactRowsEmpty };
  return { cls: 'in_impact_not_opened', reason: `the truth path is in ${heldBy.join(' and ')} and not in filesRead`, heldBy, impactRowsEmpty };
}

/**
 * truthPath, diffFiles, hunkFiles, filesRead and impactRows as in the rubric. deltaMode: true when the record is a delta run.
 * Returns { cls, reason, heldBy, impactRowsEmpty }, { judge, heldBy, impactRowsEmpty } or { cls: 'insufficient_evidence', missing, ... }.
 * deltaMode: true is added to any result of a delta run.
 */
export function classifyMiss({ truthPath, diffFiles, hunkFiles = [], filesRead, impactRows, deltaMode = false }) {
  const r = classify({ truthPath, diffFiles, hunkFiles, filesRead, impactRows });
  return deltaMode ? { ...r, deltaMode: true } : r;
}

/** The same, read from a truth row, a trace file object and a record. trace may be missing. */
export function classifyFromFiles({ truth, trace, record }) {
  return classifyMiss({
    truthPath: truth?.file, diffFiles: trace?.diffFiles, hunkFiles: trace?.hunkFiles ?? [], filesRead: trace?.filesRead, impactRows: record?.impactRows, deltaMode: record?.mode === 'delta',
  });
}
