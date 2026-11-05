// validateReview(review): returns a list of problem strings. It never throws. See references/review-json.md.
import { isObj } from './html-util.mjs';

export const SEVERITIES = ['high', 'medium', 'low'];
export const VERDICTS = ['ADOPT', 'WATCH', 'SKIP'];
export const SURFACES = ['rule', 'hook', 'skill', 'agent', 'stage', 'other'];

function check(problems) {
  const add = (path, msg) => problems.push(`${path}: ${msg}`);
  return {
    add,
    str(o, k, path, required = false) {
      const v = o[k];
      if (v === undefined || v === null) { if (required) add(`${path}.${k}`, 'required string is missing'); return; }
      if (typeof v !== 'string') add(`${path}.${k}`, 'must be a string');
    },
    num(o, k, path, { nullable = true, min = null, max = null } = {}) {
      const v = o[k];
      if (v === undefined || (v === null && nullable)) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) { add(`${path}.${k}`, 'must be a finite number'); return; }
      if ((min !== null && v < min) || (max !== null && v > max)) add(`${path}.${k}`, `must be ${min} to ${max}`);
    },
    bool(o, k, path) {
      const v = o[k];
      if (v !== undefined && v !== null && typeof v !== 'boolean') add(`${path}.${k}`, 'must be true, false or null');
    },
    oneOf(o, k, path, list) {
      const v = o[k];
      if (v !== undefined && v !== null && !list.includes(v)) add(`${path}.${k}`, `must be one of ${list.join(', ')}`);
    },
    list(o, k, path, each) {
      const v = o[k];
      if (v === undefined || v === null) return;
      if (!Array.isArray(v)) { add(`${path}.${k}`, 'must be an array'); return; }
      v.forEach((item, i) => {
        if (!isObj(item)) { add(`${path}.${k}[${i}]`, 'must be an object'); return; }
        each(item, `${path}.${k}[${i}]`);
      });
    },
  };
}

function checkSession(c, s, p) {
  c.str(s, 'label', p, true);
  ['goal', 'outcome', 'window', 'chain_id', 'cost_source'].forEach((k) => c.str(s, k, p));
  ['active_ms', 'wall_ms', 'cost_usd'].forEach((k) => c.num(s, k, p, { min: 0 }));
  c.bool(s, 'partial', p);
  if (s.scores !== undefined) {
    if (!isObj(s.scores)) c.add(`${p}.scores`, 'must be an object');
    else for (const k of Object.keys(s.scores)) c.num(s.scores, k, `${p}.scores`, { min: 0, max: 1 });
  } else c.add(`${p}.scores`, 'required object is missing');
  c.list(s, 'notes', p, (n, q) => { c.str(n, 'scorer', q); c.str(n, 'uuid', q, true); c.str(n, 'text', q, true); });
  c.list(s, 'corrections', p, (n, q) => { c.str(n, 'uuid', q, true); c.str(n, 'class', q, true); });
  c.list(s, 'hook_blocks', p, (n, q) => { c.str(n, 'guard', q, true); c.str(n, 'response', q); });
  if (s.evidence !== undefined && s.evidence !== null) {
    if (!isObj(s.evidence)) c.add(`${p}.evidence`, 'must be an object');
    else { c.str(s.evidence, 'check', `${p}.evidence`); ['is_error', 'before_claim', 'after_last_edit'].forEach((k) => c.bool(s.evidence, k, `${p}.evidence`)); }
  }
}

function checkImprovement(c, m, p) {
  ['title', 'summary', 'target_file'].forEach((k) => c.str(m, k, p));
  c.str(m, 'class', p, true);
  c.str(m, 'target_hint', p, true);
  c.oneOf(m, 'severity', p, SEVERITIES);
  c.oneOf(m, 'verdict', p, VERDICTS);
  c.oneOf(m, 'target_surface', p, SURFACES);
  ['chains', 'expected_saving_min', 'expected_saving_usd'].forEach((k) => c.num(m, k, p, { min: 0 }));
  c.list(m, 'evidence', p, (n, q) => { c.str(n, 'label', q, true); c.str(n, 'uuid', q, true); });
}

function checkFactory(c, f, p) {
  c.list(f, 'stations', p, (n, q) => { c.str(n, 'name', q, true); ['id', 'signal'].forEach((k) => c.str(n, k, q)); ['ran', 'had_evidence', 'passed'].forEach((k) => c.bool(n, k, q)); });
  for (const k of ['lane_signals', 'pr_signals']) c.list(f, k, p, (n, q) => { c.str(n, 'text', q, true); c.str(n, 'url', q); });
  c.str(f, 'example_line', p);
}

export function validateReview(review) {
  const problems = [];
  try {
    if (!isObj(review)) return ['review: must be an object'];
    const c = check(problems);
    if (!isObj(review.run)) c.add('run', 'required object is missing');
    else {
      ['run_ts', 'date', 'zone', 'note', 'cost_source', 'review_cost'].forEach((k) => c.str(review.run, k, 'run'));
      ['sessions_sampled', 'sessions_eligible', 'overflow_count', 'chains', 'wall_ms', 'active_ms', 'cost_usd'].forEach((k) => c.num(review.run, k, 'run', { min: 0 }));
      if (review.run.skipped !== undefined && !isObj(review.run.skipped)) c.add('run.skipped', 'must be an object of counts');
      else for (const k of Object.keys(review.run.skipped || {})) c.num(review.run.skipped, k, 'run.skipped', { nullable: false, min: 0 });
    }
    if (review.top_finding !== undefined && !isObj(review.top_finding)) c.add('top_finding', 'must be an object');
    else if (review.top_finding) { c.str(review.top_finding, 'text', 'top_finding', true); c.str(review.top_finding, 'target', 'top_finding'); }
    if (review.scorers !== undefined && !(Array.isArray(review.scorers) && review.scorers.every((x) => typeof x === 'string'))) c.add('scorers', 'must be an array of strings');
    if (review.unstable !== undefined && !(Array.isArray(review.unstable) && review.unstable.every((x) => typeof x === 'string'))) c.add('unstable', 'must be an array of scorer names');
    if (!Array.isArray(review.sessions)) c.add('sessions', 'required array is missing');
    else review.sessions.forEach((s, i) => (isObj(s) ? checkSession(c, s, `sessions[${i}]`) : c.add(`sessions[${i}]`, 'must be an object')));
    c.list(review, 'improvements', '', (m, q) => checkImprovement(c, m, q));
    c.list(review, 'watch', '', (n, q) => { c.str(n, 'label', q, true); c.str(n, 'uuid', q, true); ['class', 'target_hint', 'note'].forEach((k) => c.str(n, k, q)); });
    c.list(review, 'harness', '', (n, q) => { c.str(n, 'class', q, true); ['target', 'note'].forEach((k) => c.str(n, k, q)); c.num(n, 'count', q, { min: 0 }); });
    if (review.factory !== undefined && !isObj(review.factory)) c.add('factory', 'must be an object');
    else if (review.factory) checkFactory(c, review.factory, 'factory');
    if (review.trend !== undefined && !isObj(review.trend)) c.add('trend', 'must be an object');
    else if (review.trend) {
      c.str(review.trend, 'label', 'trend');
      c.list(review.trend, 'points', 'trend', (n, q) => { c.str(n, 'run_ts', q); c.num(n, 'mean', q, { nullable: false, min: 0, max: 1 }); });
      c.list(review.trend, 'regressions', 'trend', (n, q) => { c.str(n, 'scorer', q, true); ['previous', 'current'].forEach((k) => c.num(n, k, q, { min: 0, max: 1 })); c.str(n, 'changed', q); });
    }
  } catch (e) {
    problems.push(`review: validator error ${String(e && e.message).slice(0, 80)}`);
  }
  return problems.map((p) => p.replace(/^\./, '')); // top-level lists pass an empty path prefix
}
