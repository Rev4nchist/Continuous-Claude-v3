// Escape, cap and number helpers for render-html.mjs. Every review string goes through t() or tShort().
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const CAP = 400;
export const CAP_SHORT = 80;

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENT[c]);

/** Plain string from any value: strings and finite numbers only; control characters become spaces. */
export function str(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
}

/** Cut to n code points with an ellipsis. Cutting happens before escaping, so an entity is never split. */
export function cap(v, n = CAP) {
  const s = str(v);
  if (s.length <= n) return s;
  const pts = Array.from(s);
  return pts.length <= n ? s : pts.slice(0, n - 1).join('') + '…';
}

export const t = (v, n = CAP) => esc(cap(v, n));
export const tShort = (v) => esc(cap(v, CAP_SHORT));

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const arr = (v) => (Array.isArray(v) ? v : []);
export const obj = (v) => (isObj(v) ? v : {});
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const score = (v) => (num(v) !== null && v >= 0 && v <= 1 ? v : null);

/** Score 0..1 to heatmap band 1..5. 0.2 and below is band 1; above 0.8 is band 5. */
export function band(s) {
  if (s <= 0.2) return 1;
  if (s <= 0.4) return 2;
  if (s <= 0.6) return 3;
  if (s <= 0.8) return 4;
  return 5;
}

export function mean(values) {
  const v = values.filter((x) => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function fmtDur(ms) {
  const n = num(ms);
  if (n === null || n < 0) return null;
  const min = Math.round(n / 60000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}
export const fmtUsd = (v) => (num(v) === null ? null : `$${v.toFixed(2)}`);
export const fmtScore = (v) => (v === null ? 'N/A' : v.toFixed(1));

/** An href only when the value starts with https:// and holds no space, quote or angle bracket. */
export function safeUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > 300 || !/^https:\/\/[^\s"'<>\\]+$/.test(s)) return null;
  return s;
}
