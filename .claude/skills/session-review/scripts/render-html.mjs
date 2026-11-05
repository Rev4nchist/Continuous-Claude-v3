// Renders review.json to one content-only HTML page for a private claude.ai Artifact.
// Usage: node render-html.mjs --in <review.json> --out <file.html>
// Pure node, no dependencies. Every string from the review is capped, then HTML-escaped.
// The page needs no JavaScript and no host except the two font hosts. Schema: references/review-json.md.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { STYLE, FONT_HREF } from './lib/html-style.mjs';
import { validateReview, SEVERITIES, VERDICTS } from './lib/review-validate.mjs';
import { t, tShort, cap, arr, obj, num, score, band, mean, fmtDur, fmtUsd, fmtScore, safeUrl } from './lib/html-util.mjs';

export { validateReview };

const CANON = ['goal', 'done-proven', 'corrections', 'efficiency', 'hook-response', 'verbosity', 'tests', 'procedure'];
const MAX_COLS = 12;
const SURFACE_LABEL = { rule: 'Rule', hook: 'Hook', skill: 'Skill', agent: 'Agent', stage: 'Factory stage', other: 'Other' };
const SEV_PILL = { high: 'crit', medium: 'warn', low: 'info' };
const VERDICT_PILL = { ADOPT: 'good', WATCH: 'warn', SKIP: 'idle' };
const LEGEND = ['1 (0.0 to 0.2)', '2 (to 0.4)', '3 (to 0.6)', '4 (to 0.8)', '5 (above 0.8)'];

const chip = (v, n) => (cap(v, n) ? `<span class="chip">${t(v, n)}</span>` : '');
const pill = (cls, text) => `<span class="pill ${cls}">${t(text, 40)}</span>`;
const uuidTag = (u) => (cap(u, 64) ? `<span class="tag" title="${t(u, 64)}">${t(cap(u, 64).slice(0, 8))}</span>` : '');
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
const section = (id, title, lead, body) => `<section id="${id}" class="sec">\n<h2>${title}</h2>${lead ? `\n<p class="lead">${lead}</p>` : ''}\n${body}\n</section>`;
const scrollBox = (label, inner) => `<div class="scroll" role="region" tabindex="0" aria-label="${t(label, 60)}">${inner}</div>`;

function link(url, text) {
  const u = safeUrl(url);
  return u ? `<a href="${t(u, 300)}" rel="noopener noreferrer" target="_blank">${t(text)}</a>` : t(text);
}

// ---- data shaping
function sessionsOf(r) { return arr(r.sessions).filter((s) => s && typeof s === 'object' && !Array.isArray(s)); }

function columnsOf(r, sessions) {
  const seen = new Set();
  const cols = [];
  const add = (k) => { const s = cap(k, 40); if (s && !seen.has(s)) { seen.add(s); cols.push(s); } };
  arr(r.scorers).forEach(add);
  const keys = new Set(sessions.flatMap((s) => Object.keys(obj(s.scores))));
  CANON.filter((k) => keys.has(k)).forEach(add);
  [...keys].forEach(add);
  return cols.slice(0, MAX_COLS);
}

const scoreOf = (s, col) => score(obj(s.scores)[col]);
const sessionMean = (s) => mean(Object.values(obj(s.scores)).map(score));

// ---- summary band
function stat(label, big, sub) {
  return `<div class="stat"><span class="label">${label}</span><span class="big">${big}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
}

function skippedSub(skipped) {
  const parts = Object.entries(obj(skipped)).filter(([, v]) => num(v) !== null).map(([k, v]) => `${t(k, 24)} ${v}`);
  return parts.join(', ');
}

function statsOf(r, sessions) {
  const run = obj(r.run);
  const sampled = num(run.sessions_sampled) ?? sessions.length;
  const elig = num(run.sessions_eligible);
  const over = num(run.overflow_count);
  const out = [stat('Sessions reviewed', `${sampled}`, [elig !== null ? `of ${elig} eligible` : '', over ? `${over} over the cap` : ''].filter(Boolean).join(', '))];
  const skipN = Object.values(obj(run.skipped)).filter((v) => num(v) !== null).reduce((a, b) => a + b, 0);
  if (run.skipped) out.push(stat('Skipped', `${skipN}`, skippedSub(run.skipped)));
  if (num(run.chains) !== null) out.push(stat('Chains', `${run.chains}`, 'resume chains among the sessions'));
  const active = fmtDur(run.active_ms);
  const wall = fmtDur(run.wall_ms);
  if (active || wall) out.push(stat('Active time', active || 'n/a', `wall ${wall || 'n/a (live)'}`));
  const usd = fmtUsd(run.cost_usd);
  out.push(stat('Cost', usd || 'unavailable', usd ? t(run.cost_source || 'source not stated', 40) : 'no cost data for this run'));
  return out.join('\n');
}

function findingOf(r) {
  const tf = obj(r.top_finding);
  if (cap(tf.text)) return { text: cap(tf.text), target: cap(tf.target, 120) };
  const first = arr(r.improvements).find((m) => m && typeof m === 'object');
  if (!first) return null;
  const mins = num(first.expected_saving_min);
  const text = [cap(first.title), mins !== null ? `Expected saving about ${mins} min (estimate).` : ''].filter(Boolean).join('. ');
  return text ? { text, target: cap(first.target_file || first.target_hint, 120) } : null;
}

function summary(r, sessions) {
  const run = obj(r.run);
  const date = cap(run.date || run.run_ts, 24);
  const f = findingOf(r);
  const finding = f ? `<div class="finding"><span class="eyebrow">Most important finding</span><p>${t(f.text)}</p>${f.target ? `<div class="row"><span class="muted">Target</span> ${chip(f.target, 120)}</div>` : ''}</div>` : '';
  const ex = r.example === true ? `<p class="example">EXAMPLE data. ${t(run.note || 'Made-up content for the page design.', 200)}</p>` : '';
  return `<div id="summary" class="band">
<div><p class="eyebrow">Claude Code session review</p>
<h1>Session review${date ? ` <span class="muted">${t(date, 24)}</span>` : ''}</h1></div>
${ex}
<div class="stats">
${statsOf(r, sessions)}
</div>
${finding}
</div>`;
}

// ---- heatmap
function cell(v, col) {
  if (v === null) return `<div class="hm hm-na" role="cell" aria-label="${t(col, 40)} not available">N/A</div>`;
  return `<div class="hm hm-${band(v)}" role="cell" aria-label="${t(col, 40)} ${fmtScore(v)}">${fmtScore(v)}</div>`;
}

function heatmap(r, sessions) {
  const cols = columnsOf(r, sessions);
  if (!sessions.length || !cols.length) return '';
  const unstable = new Set(arr(r.unstable).map((x) => cap(x, 40)));
  const n = `n${cols.length}`;
  const head = `<div class="hm-row ${n} hm-head" role="row"><div role="columnheader">Session</div>${cols.map((c) => `<div role="columnheader">${t(c, 40)}${unstable.has(c) ? '<span class="flag">unstable</span>' : ''}</div>`).join('')}</div>`;
  const rows = sessions.map((s) => `<div class="hm-row ${n}" role="row"><div class="hm-label" role="rowheader">${t(s.label, 60)}${s.partial === true ? ' <span class="muted">(live)</span>' : ''}</div>${cols.map((c) => cell(scoreOf(s, c), c)).join('')}</div>`);
  const means = `<div class="hm-row ${n} hm-mean-row" role="row"><div class="hm-label" role="rowheader"><b>Mean</b></div>${cols.map((c) => cell(mean(sessions.map((s) => scoreOf(s, c))), c)).join('')}</div>`;
  const legend = `<p class="legend" aria-label="Legend">${LEGEND.map((l, i) => `<span><i class="hm-${i + 1}"></i>${l}</span>`).join('')}<span><i class="hm-na"></i>N/A: no data</span></p>`;
  const grid = `<div class="hmbox" role="table" aria-label="Score heatmap">${head}\n${rows.join('\n')}\n${means}</div>`;
  return section('heatmap', 'Score heatmap', 'Each row is one session. Each column is one scorer. Higher is better. N/A means the scorer had no data. A mean skips N/A.', `${scrollBox('Score heatmap', grid)}\n${legend}`);
}

// ---- improvements
function evidenceTags(list) {
  return arr(list).filter((e) => e && typeof e === 'object').map((e) => `<span class="row"><span class="muted">${tShort(e.label)}</span>${uuidTag(e.uuid)}</span>`).join(' ');
}

function savingText(m) {
  const mins = num(m.expected_saving_min);
  const usd = fmtUsd(m.expected_saving_usd);
  if (mins === null && !usd) return '';
  return `Expected saving: ${mins !== null ? `about ${mins} min` : 'minutes not stated'}${usd ? `, ${usd}` : ''} (estimate)`;
}

function improvement(m, i) {
  const sev = SEVERITIES.includes(m.severity) ? m.severity : null;
  const ver = VERDICTS.includes(m.verdict) ? m.verdict : null;
  const surface = SURFACE_LABEL[m.target_surface] || '';
  const chains = num(m.chains);
  const facts = [chains !== null ? `${chains} chains` : '', savingText(m)].filter(Boolean).join('. ');
  const rank = num(m.rank) ?? i + 1;
  return `<li class="card imp"><span class="rank" aria-label="Rank ${rank}">${rank}</span>
<div class="imp-body">
<div class="row">${sev ? pill(SEV_PILL[sev], `${sev} severity`) : ''}${ver ? pill(VERDICT_PILL[ver], ver) : ''}${surface ? pill('info', surface) : ''}</div>
<h3>${t(m.title || `${cap(m.class, 40)} / ${cap(m.target_hint, 40)}`, 200)}</h3>
${cap(m.summary) ? `<p>${t(m.summary)}</p>` : ''}
<div class="row">${chip(m.class, 40)}${chip(m.target_hint, 60)}${cap(m.target_file, 160) ? `<code>${t(m.target_file, 160)}</code>` : ''}</div>
${arr(m.evidence).length ? `<div class="row"><span class="facts">Evidence</span> ${evidenceTags(m.evidence)}</div>` : ''}
${facts ? `<p class="facts">${t(facts, 300)}</p>` : ''}
</div></li>`;
}

function improvements(r) {
  const list = arr(r.improvements).filter((m) => m && typeof m === 'object' && !Array.isArray(m));
  if (!list.length) return '';
  return section('improvements', 'Ranked improvements', 'Ranked by distinct chains times median active time. Savings are estimates. Each item needs two or more chains.', `<ol class="list">\n${list.map(improvement).join('\n')}\n</ol>`);
}

// ---- Software Factory
function stationState(s) {
  if (s.ran !== true) return { cls: 'idle', text: 'Did not run' };
  if (s.passed !== true) return { cls: 'crit', text: 'Failed' };
  if (s.had_evidence !== true) return { cls: 'warn', text: 'No evidence' };
  return { cls: 'good', text: 'Passed' };
}

function station(s) {
  const st = stationState(s);
  const rail = cap(s.id, 4).toUpperCase() === 'R';
  return `<li class="station${rail ? ' rail' : ''}"><span class="num">${rail ? 'Rail' : `Station ${t(s.id, 4)}`}</span><h3>${t(s.name, 40)}</h3>${pill(st.cls, st.text)}<span class="sig">${t(s.signal, 120) || 'No signal in the digest.'}</span></li>`;
}

function signalList(title, list) {
  const items = arr(list).filter((x) => x && typeof x === 'object' && cap(x.text));
  if (!items.length) return '';
  return `<div class="card"><h3>${title}</h3><ul class="plain">${items.map((x) => `<li>${link(x.url, x.text)}</li>`).join('')}</ul></div>`;
}

function factory(r) {
  const f = obj(r.factory);
  const stations = arr(f.stations).filter((s) => s && typeof s === 'object' && cap(s.name));
  const signals = [signalList('Lane signals', f.lane_signals), signalList('PR signals', f.pr_signals)].filter(Boolean);
  const example = cap(f.example_line) ? `<p class="facts">${t(f.example_line)}</p>` : '';
  if (!stations.length && !signals.length && !example) return '';
  const strip = stations.length ? scrollBox('Factory stations', `<ol class="strip">${stations.map(station).join('')}</ol>`) : '';
  const lead = 'Stations run from prompt to merged PR. A station that did not run is not a failure.';
  return section('factory', 'Software Factory', lead, [strip, signals.length ? `<div class="two">${signals.join('')}</div>` : '', example].filter(Boolean).join('\n'));
}

function harness(r) {
  const rows = arr(r.harness).filter((h) => h && typeof h === 'object' && cap(h.class));
  if (!rows.length) return '';
  const tr = rows.map((h) => `<tr><td>${chip(h.class, 40)}</td><td>${num(h.count) ?? 'n/a'}</td><td>${t(h.target, 160)}</td><td>${t(h.note, 200)}</td></tr>`).join('');
  const table = `<table><thead><tr><th>Class</th><th>Count</th><th>Edit target</th><th>Note</th></tr></thead><tbody>${tr}</tbody></table>`;
  return section('harness', 'Harness', 'Failures by class and where to edit. The corpus-wide rates are in /failure-audit.', scrollBox('Harness failures', table));
}

// ---- sessions
function kvRow(label, html) { return html ? `<dt>${label}</dt><dd>${html}</dd>` : ''; }

function evidenceHtml(e) {
  const ev = obj(e);
  if (!cap(ev.check)) return '';
  return `<code>${t(ev.check, 160)}</code> <span class="facts">error: ${yesNo(ev.is_error)}. Before claim: ${yesNo(ev.before_claim)}. After last edit: ${yesNo(ev.after_last_edit)}.</span>`;
}

function timeHtml(s) {
  const parts = [`active ${fmtDur(s.active_ms) || 'n/a'}`, `wall ${fmtDur(s.wall_ms) || 'n/a (live)'}`, fmtUsd(s.cost_usd) ? `${fmtUsd(s.cost_usd)} (${t(s.cost_source || 'source not stated', 30)})` : 'cost unavailable'];
  return parts.join(', ');
}

function scoreChips(s) {
  const entries = Object.entries(obj(s.scores));
  return entries.map(([k, v]) => `<span class="chip">${t(k, 30)} ${fmtScore(score(v))}</span>`).join('');
}

function notesHtml(list) {
  const items = arr(list).filter((n) => n && typeof n === 'object' && cap(n.text));
  if (!items.length) return '';
  return `<ul class="notes">${items.map((n) => `<li>${chip(n.scorer, 30)}${uuidTag(n.uuid)}<span>${t(n.text, 240)}</span></li>`).join('')}</ul>`;
}

function correctionsHtml(s) {
  const c = arr(s.corrections).filter((x) => x && typeof x === 'object').map((x) => `<span class="row">${chip(x.class, 40)}${uuidTag(x.uuid)}</span>`);
  const b = arr(s.hook_blocks).filter((x) => x && typeof x === 'object').map((x) => `<span class="row">${chip(x.guard, 60)}${x.response ? pill(x.response === 'workaround' ? 'warn' : 'good', x.response) : ''}</span>`);
  return { c: c.join(' '), b: b.join(' ') };
}

function sessionCard(s, i) {
  const m = sessionMean(s);
  const tone = m === null ? 'idle' : m >= 0.8 ? 'good' : m >= 0.5 ? 'warn' : 'crit';
  const cb = correctionsHtml(s);
  const body = [
    kvRow('Goal', t(s.goal)), kvRow('Outcome', t(s.outcome)), kvRow('Window', t(s.window, 80)),
    kvRow('Scores', scoreChips(s)), kvRow('Done evidence', evidenceHtml(s.evidence)),
    kvRow('Corrections', cb.c), kvRow('Hook blocks', cb.b), kvRow('Time and cost', timeHtml(s)), kvRow('Notes', notesHtml(s.notes)),
  ].join('');
  return `<details class="card sess"${i === 0 ? ' open' : ''}>
<summary><b class="mono">${t(s.label, 60)}</b>${pill(tone, `mean ${fmtScore(m)}`)}${s.partial === true ? pill('info', 'live') : ''}<span class="muted">${t(s.goal, 90)}</span></summary>
<div class="sess-body">
<dl class="kv">${body}</dl>
</div>
</details>`;
}

function sessionsSection(sessions) {
  if (!sessions.length) return '';
  return section('sessions', 'Sessions', 'One card per session. Open a card for notes with the uuid of each cited record.', `<div class="list">\n${sessions.map(sessionCard).join('\n')}\n</div>`);
}

function watch(r) {
  const items = arr(r.watch).filter((w) => w && typeof w === 'object' && (cap(w.label) || cap(w.note)));
  if (!items.length) return '';
  const li = items.map((w) => `<li class="card"><div class="row"><b class="mono">${t(w.label, 60)}</b>${uuidTag(w.uuid)}${chip(w.class, 40)}${chip(w.target_hint, 60)}</div>${cap(w.note) ? `<p>${t(w.note, 240)}</p>` : ''}</li>`);
  return section('watch', 'Watch list', 'Findings from one chain only, or with no known target. They do not rank.', `<ul class="list">${li.join('\n')}</ul>`);
}

// ---- trend
function trendPoints(trend) {
  return arr(trend.points).filter((p) => p && typeof p === 'object' && score(p.mean) !== null).map((p) => ({ x: cap(p.run_ts, 24), v: p.mean }));
}

function sparkline(pts) {
  const W = 340, H = 100, L = 38, R = 40, T = 16, B = 22;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 0.02) { lo -= 0.05; hi += 0.05; }
  const X = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i / (pts.length - 1)) * (W - L - R));
  const Y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const xy = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`);
  const last = pts.length - 1;
  const dots = pts.slice(0, -1).map((p, i) => `<circle class="sp-dot" cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="3"></circle>`).join('');
  const label = `Mean score over ${pts.length} runs, from ${pts[0].v.toFixed(2)} to ${pts[last].v.toFixed(2)}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t(label, 120)}">
<polyline class="sp-line" points="${xy.join(' ')}"></polyline>${dots}
<circle class="sp-end" cx="${X(last).toFixed(1)}" cy="${Y(pts[last].v).toFixed(1)}" r="5"></circle>
<text class="sp-txt" x="${L - 6}" y="${T + 3}" text-anchor="end">${hi.toFixed(2)}</text>
<text class="sp-txt" x="${L - 6}" y="${H - B + 3}" text-anchor="end">${lo.toFixed(2)}</text>
<text class="sp-txt sp-txt-end" x="${(X(last) + 9).toFixed(1)}" y="${(Y(pts[last].v) + 3).toFixed(1)}">${pts[last].v.toFixed(2)}</text>
<text class="sp-txt" x="${X(0).toFixed(1)}" y="${H - 4}" text-anchor="start">${t(pts[0].x, 24)}</text>
<text class="sp-txt" x="${X(last).toFixed(1)}" y="${H - 4}" text-anchor="end">${t(pts[last].x, 24)}</text>
</svg>`;
}

function trend(r) {
  const tr = obj(r.trend);
  const pts = trendPoints(tr);
  if (!pts.length) return '';
  const last = pts.at(-1).v;
  const prev = pts.length > 1 ? pts.at(-2).v : null;
  const delta = prev === null ? 'first run in the ledger' : `previous ${prev.toFixed(2)}, change ${last - prev >= 0 ? '+' : ''}${(last - prev).toFixed(2)}`;
  const reg = arr(tr.regressions).filter((x) => x && typeof x === 'object' && cap(x.scorer));
  const regHtml = reg.length ? `<ul class="plain">${reg.map((x) => `<li>${t(x.scorer, 40)} fell from ${num(x.previous) !== null ? x.previous.toFixed(2) : 'n/a'} to ${num(x.current) !== null ? x.current.toFixed(2) : 'n/a'}${cap(x.changed) ? ` after a ${t(x.changed, 40)} change` : ''}.</li>`).join('')}</ul>` : '';
  const body = `${sparkline(pts)}\n<p class="facts">Latest ${last.toFixed(2)}; ${delta}.</p>${regHtml ? `\n<p><b>Regression flags</b></p>${regHtml}` : ''}`;
  return section('trend', 'Trend', t(tr.label || 'Mean score per run, from the ledger.', 160), `<div class="card">${body}</div>`);
}

// ---- page
export function renderHtml(review) {
  const r = review && typeof review === 'object' && !Array.isArray(review) ? review : {};
  const sessions = sessionsOf(r);
  const parts = [
    summary(r, sessions), heatmap(r, sessions), improvements(r), factory(r), harness(r), sessionsSection(sessions), watch(r), trend(r),
  ].filter(Boolean);
  const foot = '<p class="foot">Built from review.json. Session text is redacted and cut to a fixed length. The markdown report stays on the local machine.</p>';
  return `<title>Session Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${FONT_HREF}">
<style>
${STYLE}
</style>
<main class="wrap">
${parts.join('\n')}
${foot}
</main>
`;
}

// ---- CLI
function main(argv) {
  let values;
  try { ({ values } = parseArgs({ args: argv, strict: true, options: { in: { type: 'string' }, out: { type: 'string' } } })); } catch (e) { process.stderr.write(`render-html: ${e.message}\n`); return 2; }
  if (!values.in || !values.out) { process.stderr.write('usage: node render-html.mjs --in <review.json> --out <file.html>\n'); return 2; }
  let review;
  try { review = JSON.parse(fs.readFileSync(values.in, 'utf8')); } catch (e) { process.stderr.write(`render-html: cannot read ${values.in}: ${e.message}\n`); return 2; }
  const problems = validateReview(review);
  for (const p of problems) process.stderr.write(`review.json: ${p}\n`);
  const html = renderHtml(review);
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, html);
  process.stdout.write(`render-html: wrote ${path.resolve(values.out)} (${Buffer.byteLength(html)} bytes, ${problems.length} problems)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
