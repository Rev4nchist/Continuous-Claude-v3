// attention.mjs — THE single source of truth for "what needs attention" across
// the card, the cockpit, and the hub ordering. The review flagged that attention
// was being defined three different ways; this module exists so it is defined
// exactly once. Pure and unit-testable: it takes already-extracted plain values
// (a normalized project object + a health series) and an optional injectable
// `now`, and returns a plain result. No I/O, no Notion, no config coupling.
//
// Normalized project shape (all fields already extracted by the caller):
//   {
//     health:        'Green' | 'Yellow' | 'Red' | '' ,
//     decisionNeeded: boolean,
//     lastEditedISO:  string|null,   // Notion "Last Edited" time
//     reviewDateISO:  string|null,   // Notion "Review Date" (may be null)
//   }
//
// series: [{ date, health }] oldest -> newest (from history.readSeries), used to
// derive the trend. Pass [] when no history is available.
//
// ── Scoring (documented so all three consumers agree) ─────────────────────────
//   Red health .............................. +3
//   Yellow health ........................... +1
//   Decision Needed? ........................ +2
//   Stale (>14 days since Last Edited) ...... +1
//   Review Date overdue ..................... +2   (else)
//   Review Date due within 7 days ........... +1
//   Health worsened vs prev (trend 'down') .. +1
//
//   level:  score >= 3 -> 'high'
//           score >= 1 -> 'medium'
//           else       -> 'none'

const DAY_MS = 86400000;
const STALE_DAYS = 14;
const REVIEW_SOON_DAYS = 7;

// Higher rank = healthier. Used to decide whether health improved or worsened.
const HEALTH_RANK = { green: 2, yellow: 1, red: 0 };

function healthRank(h) {
  const key = String(h ?? '').trim().toLowerCase();
  return key in HEALTH_RANK ? HEALTH_RANK[key] : null;
}

// Whole days between an ISO timestamp and `now` (positive = in the past).
// Returns null for missing/invalid input.
function daysSince(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / DAY_MS);
}

// Whole days from `now` until an ISO date (positive = future, negative = past/overdue).
// Returns null for missing/invalid input.
function daysUntil(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / DAY_MS);
}

// Derive trend from the series: 'up' | 'down' | 'flat' | 'new'.
// 'new' means there is no comparable prior day.
function computeTrend(series) {
  const pts = Array.isArray(series) ? series : [];
  if (pts.length < 2) return { trend: 'new', prevHealth: null };
  const latest = healthRank(pts[pts.length - 1].health);
  const prevHealth = pts[pts.length - 2].health;
  const prev = healthRank(prevHealth);
  if (latest == null || prev == null) return { trend: 'new', prevHealth };
  if (latest < prev) return { trend: 'down', prevHealth };
  if (latest > prev) return { trend: 'up', prevHealth };
  return { trend: 'flat', prevHealth };
}

// computeAttention(project, series, now?) -> attention result. See header for the
// scoring contract. `now` is injectable (Date or ms) for deterministic tests.
export function computeAttention(project, series = [], now = new Date()) {
  const p = project || {};
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const reasons = [];
  let score = 0;

  // Health.
  const healthKey = String(p.health ?? '').trim().toLowerCase();
  if (healthKey === 'red') {
    score += 3;
    reasons.push('🔴 Red health');
  } else if (healthKey === 'yellow') {
    score += 1;
    reasons.push('🟡 Yellow health');
  }

  // Decision needed.
  if (p.decisionNeeded) {
    score += 2;
    reasons.push('⚠ decision needed');
  }

  // Staleness (days since Last Edited).
  const sinceEdit = daysSince(p.lastEditedISO, nowMs);
  const staleDays = sinceEdit == null ? 0 : sinceEdit;
  const stale = sinceEdit != null && sinceEdit > STALE_DAYS;
  if (stale) {
    score += 1;
    reasons.push(`⏳ ${staleDays}d stale`);
  }

  // Review date (overdue OR due soon).
  const reviewDays = daysUntil(p.reviewDateISO, nowMs);
  let reviewDue = false;
  if (reviewDays != null) {
    if (reviewDays < 0) {
      score += 2;
      reviewDue = true;
      reasons.push(`📅 review overdue ${-reviewDays}d`);
    } else if (reviewDays <= REVIEW_SOON_DAYS) {
      score += 1;
      reviewDue = true;
      reasons.push(`📅 review due ${reviewDays}d`);
    }
  }

  // Trend (health worsened vs prev).
  const { trend, prevHealth } = computeTrend(series);
  if (trend === 'down') {
    score += 1;
    reasons.push(`↓ was ${prevHealth}`);
  }

  const level = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'none';

  return {
    score,
    level,
    reasons,
    stale,
    staleDays,
    reviewDue,
    reviewDays,
    trend,
  };
}

// --- hash canonicalization (2026-08-04) ------------------------------------------
// staleDays/reviewDays are DAY COUNTERS: they tick every midnight, so feeding the
// raw attention into the canonical (hash) render made every card flip changed=true
// daily — all 11 cards republished every morning, and on slow-spawn mornings the
// sweep's 18-min budget blew (ETIMEDOUTs, stale cards, cockpitPublished=false).
// This quantizes the counters to their SCORING BANDS for the canonical render only:
// the displayed card keeps exact day counts, while the hash moves only when a band
// flips (fresh->stale, upcoming->due-soon->overdue) — i.e. when the card's meaning
// changes, which is exactly when a republish is worth 11 Notion writes.
export function quantizeAttentionForHash(a) {
  if (!a) return a;
  const reviewBand = a.reviewDays == null
    ? null
    : (a.reviewDays < 0 ? 'overdue' : (a.reviewDays <= REVIEW_SOON_DAYS ? 'due-soon' : 'later'));
  return {
    ...a,
    staleDays: a.stale ? 'stale' : 'fresh',
    reviewDays: reviewBand,
    // reasons embed literal day counts ("⏳ 17d stale") — neutralize the digits so a
    // consumer that renders reasons cannot silently reintroduce the daily churn.
    reasons: (a.reasons || []).map((s) => String(s).replace(/\d+d/g, 'Nd')),
  };
}
