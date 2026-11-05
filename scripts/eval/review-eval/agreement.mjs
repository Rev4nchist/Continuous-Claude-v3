// Agreement between two raters: raw agreement and Cohen's kappa. Pure.
// Used for the judge against Dave's labels (score.mjs) and for the two raters of the linkType labels (linktype-labels.json).

/**
 * Cohen's kappa over pairs [[a, b], ...] of class names. kappa = (po - pe) / (1 - pe), po = raw agreement, pe = chance agreement
 * from the two raters' class shares. null when it is undefined: no pairs, or pe = 1 (both raters used one class only).
 */
export function cohenKappa(pairs) {
  const n = pairs.length;
  if (n === 0) return null;
  const countA = new Map();
  const countB = new Map();
  let agree = 0;
  for (const [a, b] of pairs) {
    countA.set(a, (countA.get(a) ?? 0) + 1);
    countB.set(b, (countB.get(b) ?? 0) + 1);
    if (a === b) agree += 1;
  }
  // Integer form: kappa = (n*agree - S) / (n*n - S), S = the sum of the two raters' counts per class multiplied. One division, so a table
  // whose kappa is exactly 0.6 gives 0.6 (the share form gives 0.5999999999999998 and fails a `>= 0.6` gate).
  let marginProducts = 0;
  for (const [cls, ca] of countA) marginProducts += ca * (countB.get(cls) ?? 0);
  return marginProducts === n * n ? null : (n * agree - marginProducts) / (n * n - marginProducts);
}

/**
 * Two label maps { key: class }. Only keys both raters labelled count.
 * -> { n, agree, raw, kappa, disputed: [key] } (raw and kappa are null when n = 0).
 */
export function agreementOf(a, b) {
  const keys = Object.keys(a).filter((k) => k in b);
  const agreeing = keys.filter((k) => a[k] === b[k]);
  return {
    n: keys.length, agree: agreeing.length, raw: keys.length > 0 ? agreeing.length / keys.length : null,
    kappa: cohenKappa(keys.map((k) => [a[k], b[k]])), disputed: keys.filter((k) => a[k] !== b[k]),
  };
}
