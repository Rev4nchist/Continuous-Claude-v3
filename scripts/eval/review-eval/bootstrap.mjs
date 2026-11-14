// The cluster bootstrap and the Wilson interval for the paired scorecard. Pure: a seed and the data give the same bounds.

/** A seeded random number generator (mulberry32). Returns a function that gives floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap over clusters. clusters: an array of item arrays. Each of the B rounds draws clusters with replacement,
 * joins their items and calls stat(items). A null result is skipped. point = stat on all items. The RNG starts fresh in every call.
 * Returns { point, lo, hi, B, used }; lo and hi are null when no round gave a value.
 */
export function clusterBootstrap({ clusters, stat, B = 2000, seed = 1, alpha = 0.05 }) {
  const none = { point: null, lo: null, hi: null, B, used: 0 };
  if (!Array.isArray(clusters) || clusters.length === 0) return none;
  const point = stat(clusters.flat());
  const next = mulberry32(seed);
  const values = [];
  for (let b = 0; b < B; b += 1) {
    const items = [];
    for (let i = 0; i < clusters.length; i += 1) items.push(...clusters[Math.floor(next() * clusters.length)]);
    const v = stat(items);
    if (v !== null && v !== undefined && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return { ...none, point };
  values.sort((x, y) => x - y);
  const at = (q) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))];
  return { point, lo: at(alpha / 2), hi: values[Math.min(values.length - 1, Math.max(0, Math.ceil((1 - alpha / 2) * values.length) - 1))], B, used: values.length };
}

/** The Wilson score interval for found of total. Nulls when total is 0. The bounds stay in [0, 1]. */
export function wilson(found, total, z = 1.96) {
  if (!(total > 0)) return { lo: null, hi: null };
  const p = found / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}
