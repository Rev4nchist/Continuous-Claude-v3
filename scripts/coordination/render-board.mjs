#!/usr/bin/env node
/**
 * render-board -- generate the lane board from the database.
 *
 * The previous board was hand-written HTML. It was accurate the day it was
 * written and began rotting the same afternoon: two of its own chip counts
 * disagreed with the filters computing them, and its lane states were a
 * transcription of a moment. A board that reports coordination has to be
 * generated from the thing it reports on, or it becomes a second source of
 * truth that quietly disagrees with the first.
 *
 * So every number here is a query, and the queries are printed on the page --
 * the affordance the hand-written board introduced and the one worth keeping.
 * Any figure can be falsified in about ten seconds.
 *
 * Usage: node scripts/coordination/render-board.mjs [out.html]
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = process.argv[2] || join(REPO, 'lane-board.html');
const STALE_MINUTES = 5;

function loadPg() {
  for (const a of [join(REPO, '.claude', 'hooks', 'package.json'), join(REPO, 'apps', 'agentic-os', 'package.json')]) {
    try { return createRequire(pathToFileURL(a)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve pg');
}
const { Client } = loadPg();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (s) => (s ? String(s).slice(0, 8) : '');

/** Local time, stated as local. The DB runs UTC and this machine runs UTC-5;
 *  a previous render stamped the masthead with the UTC clock and dated the
 *  board a day into the future. */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const c = new Client({
  connectionString: process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude',
  connectionTimeoutMillis: 5000,
});
await c.connect();

const lanes = (await c.query(`SELECT * FROM agentic_os.lane ORDER BY track, priority, id`)).rows;

const sessions = (await c.query(
  `SELECT s.id, s.working_on, s.last_heartbeat,
          COALESCE(json_agg(json_build_object('id',l.id,'title',l.title,'scope',l.scope,'note',l.note)
            ORDER BY l.priority) FILTER (WHERE l.id IS NOT NULL), '[]') AS lanes
   FROM sessions s
   LEFT JOIN agentic_os.lane l ON l.owner_session_id = s.id AND l.state <> 'done'
   WHERE s.last_heartbeat > now() - interval '${STALE_MINUTES} minutes'
   GROUP BY s.id, s.working_on, s.last_heartbeat
   ORDER BY s.last_heartbeat DESC`,
)).rows;

const events = (await c.query(
  `SELECT * FROM agentic_os.lane_event ORDER BY id DESC LIMIT 30`,
)).rows;

const claimHealth = (await c.query(
  `SELECT count(*) FILTER (WHERE s.id IS NULL)::int                                   AS orphaned,
          count(*) FILTER (WHERE s.last_heartbeat <  now() - interval '5 min')::int   AS stale,
          count(*) FILTER (WHERE s.last_heartbeat >= now() - interval '5 min')::int   AS live
   FROM file_claims fc LEFT JOIN sessions s ON s.id = fc.session_id`,
)).rows[0];

const eventKinds = (await c.query(
  `SELECT kind, count(*)::int AS n FROM agentic_os.coordination_event
   WHERE occurred_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`,
)).rows;

await c.end();

// ------------------------------------------------------------------ derive

const open = lanes.filter((l) => l.state !== 'done');
const byState = (s) => open.filter((l) => l.state === s).length;
const held = open.filter((l) => l.owner_session_id).length;
const tracks = [...new Set(lanes.map((l) => l.track))];

const STRIPE = {
  active: 's-ok', ready: 's-info', blocked: 's-crit',
  review: 's-warn', backlog: 's-idle', done: 's-done',
};
const PILL = {
  active: 'p-ok', ready: 'p-info', blocked: 'p-crit',
  review: 'p-warn', backlog: 'p-idle', done: 'p-idle',
};

// ------------------------------------------------------------------ markup

const laneRow = (l, i) => {
  const owner = l.owner_session_id;
  const leaseMin = l.lease_expires_at
    ? Math.round((new Date(l.lease_expires_at) - Date.now()) / 60000) : null;
  const detailId = `d${i}`;
  return `
  <button class="lane${owner ? ' is-held' : ''}" aria-expanded="false" aria-controls="${detailId}" data-state="${esc(l.state)}" data-track="${esc(l.track)}" data-held="${owner ? '1' : '0'}">
    <span class="stripe ${STRIPE[l.state] || 's-idle'}"></span>
    <span class="nm">${esc(l.id)}<small>${esc(l.title)}</small></span>
    <span class="state-c"><span class="pill ${PILL[l.state] || 'p-idle'}">${esc(l.state)}</span></span>
    <span class="own">${owner
      ? `<span class="who">${esc(short(owner))}</span>${leaseMin !== null
        ? `<span class="lease${leaseMin <= 0 ? ' lapsed' : ''}">${leaseMin > 0 ? `${leaseMin}m left` : 'lease lapsed'}</span>` : ''}`
      : '<span class="free">unclaimed</span>'}</span>
    <span class="scope">${esc(l.scope || '')}</span>
    <span class="age">${esc(ago(l.updated_at))}</span>
  </button>
  <div class="detail" id="${detailId}">
    <dl>
      <dt>track</dt><dd>${esc(l.track)}</dd>
      ${l.branch ? `<dt>branch</dt><dd>${esc(l.branch)}</dd>` : ''}
      ${l.scope ? `<dt>scope</dt><dd>${esc(l.scope)}</dd>` : ''}
      ${owner ? `<dt>holder</dt><dd>${esc(owner)} · fence ${esc(l.fence)}</dd>` : ''}
      ${l.note ? `<dt>status</dt><dd>${esc(l.note)}</dd>` : ''}
      ${l.done_when ? `<dt>done when</dt><dd>${esc(l.done_when)}</dd>` : ''}
    </dl>
    ${l.rationale ? `<p class="why">${esc(l.rationale)}</p>` : ''}
    <p class="cmd">node scripts/coordination/lane.mjs ${owner ? `note ${esc(l.id)} "…"` : `claim ${esc(l.id)}`}</p>
  </div>`;
};

const html = `<title>Agentic OS — Lane Board</title>
<style>
  :root {
    /* Carried from the 07-27 board so this reads as the same page, not a new one.
       Teal-biased neutrals: a grey chosen against the accent, not inherited. */
    --ground:#F4F7F7; --panel:#FFFFFF; --panel-2:#EDF2F2;
    --line:#D6E1E1; --line-soft:#E6EDED;
    --ink:#0F1A1D; --muted:#5C6E71; --faint:#849698;
    --ok:#0B7C72; --warn:#A8630A; --crit:#B23A32; --info:#2A6296; --agent:#6B57B0;
    --ok-bg:#E2F1EF; --warn-bg:#F8EEDD; --crit-bg:#F8E6E4; --info-bg:#E4EDF6;
    --mono: ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;
    --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;
    --display:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
    --r:8px; --shadow:0 1px 2px rgba(15,26,29,.05),0 8px 24px rgba(15,26,29,.05);
    --live:#0B7C72; --live-halo:rgba(11,124,114,.18);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#0E1417; --panel:#161F23; --panel-2:#1C282D;
      --line:#2A383E; --line-soft:#223037;
      --ink:#E6EFEF; --muted:#93A6AA; --faint:#6D8188;
      --ok:#3FB8A6; --warn:#D99A3C; --crit:#E4736A; --info:#6BA3DA; --agent:#A48EE8;
      --ok-bg:#12302E; --warn-bg:#33280F; --crit-bg:#331C1A; --info-bg:#14283A;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25);
      --live:#3FB8A6; --live-halo:rgba(63,184,166,.22);
    }
  }
  :root[data-theme="dark"] {
    --ground:#0E1417; --panel:#161F23; --panel-2:#1C282D;
    --line:#2A383E; --line-soft:#223037;
    --ink:#E6EFEF; --muted:#93A6AA; --faint:#6D8188;
    --ok:#3FB8A6; --warn:#D99A3C; --crit:#E4736A; --info:#6BA3DA; --agent:#A48EE8;
    --ok-bg:#12302E; --warn-bg:#33280F; --crit-bg:#331C1A; --info-bg:#14283A;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25);
    --live:#3FB8A6; --live-halo:rgba(63,184,166,.22);
  }
  :root[data-theme="light"] {
    --ground:#F4F7F7; --panel:#FFFFFF; --panel-2:#EDF2F2;
    --line:#D6E1E1; --line-soft:#E6EDED;
    --ink:#0F1A1D; --muted:#5C6E71; --faint:#849698;
    --ok:#0B7C72; --warn:#A8630A; --crit:#B23A32; --info:#2A6296; --agent:#6B57B0;
    --ok-bg:#E2F1EF; --warn-bg:#F8EEDD; --crit-bg:#F8E6E4; --info-bg:#E4EDF6;
    --shadow:0 1px 2px rgba(15,26,29,.05),0 8px 24px rgba(15,26,29,.05);
    --live:#0B7C72; --live-halo:rgba(11,124,114,.18);
  }

  * { box-sizing:border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font:14px/1.55 var(--sans); -webkit-font-smoothing:antialiased; }
  .wrap { width:min(1240px,100%); margin:0 auto; padding:0 20px 72px; }
  h1,h2 { margin:0; text-wrap:balance; }
  .mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  :focus-visible { outline:2px solid var(--ok); outline-offset:2px; border-radius:3px; }

  header.top { position:sticky; top:0; z-index:30; background:color-mix(in srgb,var(--ground) 88%,transparent);
    backdrop-filter:blur(10px); border-bottom:1px solid var(--line); margin-bottom:24px; }
  .top-in { width:min(1240px,100%); margin:0 auto; padding:12px 20px; display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:10px; }
  .mark { width:30px; height:30px; border-radius:7px; display:grid; place-items:center; background:var(--ink); color:var(--ground); font:700 10px/1 var(--mono); }
  .brand b { font:650 15px/1.2 var(--display); letter-spacing:-.02em; }
  .brand span span { display:block; font:400 11px/1.3 var(--mono); color:var(--faint); }
  .counters { display:flex; gap:8px; margin-left:auto; flex-wrap:wrap; }
  .ctr { display:flex; align-items:baseline; gap:7px; padding:6px 11px; border:1px solid var(--line); border-radius:999px; background:var(--panel); }
  .ctr b { font:650 15px/1 var(--mono); font-variant-numeric:tabular-nums; }
  .ctr span { font:500 10px/1 var(--mono); letter-spacing:.07em; text-transform:uppercase; color:var(--muted); }
  .ctr.is-ok { border-color:var(--ok); background:var(--ok-bg); } .ctr.is-ok b { color:var(--ok); }
  .ctr.is-crit { border-color:var(--crit); background:var(--crit-bg); } .ctr.is-crit b { color:var(--crit); }
  .themebtn { border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:999px; padding:7px 12px; cursor:pointer; font:500 11px/1 var(--mono); }
  .themebtn:hover { color:var(--ink); border-color:var(--muted); }

  section { margin-top:30px; }
  .sec-head { display:flex; align-items:baseline; gap:14px; margin-bottom:12px; flex-wrap:wrap; }
  .sec-head h2 { font:620 17px/1.2 var(--display); letter-spacing:-.015em; }
  .sec-head p { margin:0; color:var(--muted); font-size:12.5px; max-width:62ch; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); }

  /* NOW -- the summary before the detail. Liveness is the thing a generated
     board can show that a hand-written one never could, so it leads. */
  .now { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; }
  .sess { padding:15px 16px; position:relative; }
  .sess::before { content:''; position:absolute; left:0; top:12px; bottom:12px; width:3px; border-radius:0 3px 3px 0; background:var(--live); }
  .sess .sid { font:600 13px/1 var(--mono); display:flex; align-items:center; gap:8px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--live); box-shadow:0 0 0 4px var(--live-halo); }
  @media (prefers-reduced-motion: no-preference) { .dot { animation:pulse 2.6s ease-in-out infinite; } }
  @keyframes pulse { 0%,100% { box-shadow:0 0 0 3px var(--live-halo); } 50% { box-shadow:0 0 0 6px var(--live-halo); } }
  .sess .doing { margin:7px 0 10px; color:var(--muted); font-size:12px; }
  .sess ul { margin:0; padding-left:0; list-style:none; display:flex; flex-direction:column; gap:7px; }
  .sess li { border-top:1px solid var(--line-soft); padding-top:7px; }
  .sess li b { font:600 12px/1.4 var(--mono); }
  .sess li span { display:block; color:var(--muted); font-size:11.5px; }
  .sess .none { color:var(--faint); font:400 12px/1.5 var(--mono); }

  .filters { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:12px; }
  .chip { border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:999px; padding:6px 12px; cursor:pointer; font:500 11px/1 var(--mono); }
  .chip:hover { border-color:var(--muted); color:var(--ink); }
  .chip[aria-pressed="true"] { background:var(--ink); color:var(--ground); border-color:var(--ink); }

  .grp-h { display:flex; align-items:center; gap:10px; padding:14px 2px 7px; }
  .grp-h .nm { font:600 12px/1 var(--mono); letter-spacing:.04em; }
  .grp-h .ct { font:500 10px/1 var(--mono); color:var(--faint); }
  .grp-h .rule { flex:1; height:1px; background:var(--line); }

  .lane { display:grid; grid-template-columns:3px minmax(190px,1.5fr) 96px 150px 1fr 60px; align-items:center;
    border:1px solid var(--line); border-radius:var(--r); background:var(--panel); margin-bottom:6px;
    cursor:pointer; text-align:left; width:100%; padding:0; font:inherit; color:inherit;
    transition:border-color .12s ease, transform .12s ease; }
  .lane:hover { border-color:var(--muted); transform:translateX(1px); }
  .lane.is-held { border-color:color-mix(in srgb,var(--live) 45%,var(--line)); }
  .lane > * { padding:10px 13px; min-width:0; }
  .stripe { padding:0 !important; align-self:stretch; border-radius:var(--r) 0 0 var(--r); }
  .s-ok { background:var(--ok); } .s-warn { background:var(--warn); } .s-crit { background:var(--crit); }
  .s-info { background:var(--info); } .s-idle { background:var(--line); } .s-done { background:var(--line-soft); }
  .lane .nm { font:600 13px/1.3 var(--mono); letter-spacing:-.01em; }
  .lane .nm small { display:block; font:400 11px/1.4 var(--sans); color:var(--muted); margin-top:2px; }
  .lane .scope, .lane .own { font:400 11px/1.4 var(--mono); color:var(--muted); overflow:hidden; text-overflow:ellipsis; }
  .lane .who { color:var(--live); font-weight:600; }
  .lane .lease { display:block; color:var(--faint); font-size:10.5px; }
  .lane .lease.lapsed { color:var(--warn); }
  .lane .free { color:var(--faint); }
  .lane .age { font:500 11px/1.4 var(--mono); color:var(--faint); text-align:right; }
  .pill { display:inline-flex; border-radius:999px; padding:3px 8px; font:600 10px/1.4 var(--mono); letter-spacing:.04em;
    text-transform:uppercase; border:1px solid transparent; white-space:nowrap; }
  .p-ok { color:var(--ok); background:var(--ok-bg); border-color:color-mix(in srgb,var(--ok) 30%,transparent); }
  .p-warn { color:var(--warn); background:var(--warn-bg); border-color:color-mix(in srgb,var(--warn) 30%,transparent); }
  .p-crit { color:var(--crit); background:var(--crit-bg); border-color:color-mix(in srgb,var(--crit) 30%,transparent); }
  .p-info { color:var(--info); background:var(--info-bg); border-color:color-mix(in srgb,var(--info) 30%,transparent); }
  .p-idle { color:var(--faint); background:var(--panel-2); border-color:var(--line); }

  .detail { display:none; margin:-4px 0 10px; padding:14px 16px 14px 30px; border:1px solid var(--line); border-top:none;
    border-radius:0 0 var(--r) var(--r); background:var(--panel-2); font-size:12.5px; }
  .detail.open { display:block; }
  .detail dl { display:grid; grid-template-columns:92px 1fr; gap:6px 14px; margin:0 0 10px; }
  .detail dt { font:600 10px/1.5 var(--mono); letter-spacing:.07em; text-transform:uppercase; color:var(--faint); }
  .detail dd { margin:0; font-family:var(--mono); font-size:11.5px; word-break:break-word; }
  .detail .why { margin:0 0 10px; color:var(--muted); border-left:2px solid var(--line); padding-left:11px; max-width:88ch; }
  .detail .cmd { margin:0; font:400 11.5px/1.5 var(--mono); color:var(--ink); background:var(--panel); border:1px solid var(--line-soft);
    border-radius:4px; padding:6px 9px; display:inline-block; }

  .feed { padding:6px 0; }
  .feed div { display:grid; grid-template-columns:52px 78px 1fr; gap:12px; padding:8px 16px; border-bottom:1px solid var(--line-soft); font-size:12.5px; }
  .feed div:last-child { border-bottom:none; }
  .feed .t, .feed .s { font:400 11px/1.5 var(--mono); color:var(--faint); }
  .feed .s { color:var(--muted); }
  .feed b { font:600 11px/1.5 var(--mono); color:var(--ink); }

  .recon { display:block; border-top:1px dashed var(--line); padding:9px 14px; font:400 11px/1.5 var(--mono);
    color:var(--faint); background:var(--panel-2); border-radius:0 0 var(--r) var(--r); overflow-x:auto; white-space:pre; }
  .recon b { color:var(--muted); font-weight:600; }

  .tw { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { padding:9px 13px; text-align:left; border-bottom:1px solid var(--line-soft); }
  th { font:600 10px/1.4 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--faint); background:var(--panel-2); }
  tbody tr:last-child td { border-bottom:none; }
  td.mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }

  footer { margin-top:40px; padding-top:18px; border-top:1px solid var(--line); color:var(--faint);
    font:400 11.5px/1.6 var(--mono); display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }

  @media (max-width:1080px) { .lane { grid-template-columns:3px minmax(160px,1.4fr) 92px 130px 56px; } .lane .scope { display:none; } }
  @media (max-width:720px) { .lane { grid-template-columns:3px 1fr 56px; } .lane .state-c, .lane .own { display:none; } .counters { width:100%; } }
  @media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms !important; transition-duration:.01ms !important; } }
</style>

<header class="top">
  <div class="top-in">
    <div class="brand">
      <span class="mark">AOS</span>
      <span><b>Lane Board</b><span>generated from agentic_os.lane &middot; ${localStamp()} local</span></span>
    </div>
    <div class="counters">
      <span class="ctr"><b>${open.length}</b><span>open lanes</span></span>
      <span class="ctr is-ok"><b>${held}</b><span>held now</span></span>
      <span class="ctr"><b>${byState('ready')}</b><span>claimable</span></span>
      <span class="ctr${byState('blocked') ? ' is-crit' : ''}"><b>${byState('blocked')}</b><span>blocked</span></span>
      <span class="ctr is-ok"><b>${sessions.length}</b><span>live sessions</span></span>
    </div>
    <button class="themebtn" id="tt" type="button">theme</button>
  </div>
</header>

<div class="wrap">

  <section>
    <div class="sec-head">
      <h2>Right now</h2>
      <p>Sessions that have beaten within ${STALE_MINUTES} minutes, and what each one holds. This is the question a second session actually needs answered before it starts typing.</p>
    </div>
    <div class="now">
      ${sessions.length ? sessions.map((s) => `
      <div class="card sess">
        <div class="sid"><span class="dot"></span>${esc(short(s.id))}<span style="color:var(--faint);font-weight:400">&middot; ${esc(ago(s.last_heartbeat))}</span></div>
        <p class="doing">${esc(String(s.working_on || '').replace(/\s+/g, ' ').slice(0, 130)) || '&mdash;'}</p>
        ${s.lanes.length ? `<ul>${s.lanes.map((l) => `
          <li><b>${esc(l.id)}</b>${l.note ? `<span>${esc(l.note)}</span>` : ''}${l.scope ? `<span>scope: ${esc(l.scope)}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="none">holds no lane</p>'}
      </div>`).join('') : '<div class="card sess"><p class="none">no live sessions</p></div>'}
    </div>
    <div class="card" style="margin-top:10px"><span class="recon"><b>sessions</b>  SELECT id, working_on, last_heartbeat FROM sessions
            WHERE last_heartbeat &gt; now() - interval '${STALE_MINUTES} minutes';
<b>held</b>      SELECT id, owner_session_id, lease_expires_at FROM agentic_os.lane
            WHERE owner_session_id IS NOT NULL AND state &lt;&gt; 'done';</span></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Lanes</h2>
      <p>A lane is a durable work thread with a declared scope. Two sessions are safe to run at once exactly when their scopes are disjoint. Click a lane for its standing case and the command to claim it.</p>
    </div>
    <div class="filters" role="group" aria-label="Filter lanes">
      <button class="chip" data-f="open" aria-pressed="true">open ${open.length}</button>
      <button class="chip" data-f="ready" aria-pressed="false">claimable ${byState('ready')}</button>
      <button class="chip" data-f="held" aria-pressed="false">held ${held}</button>
      <button class="chip" data-f="blocked" aria-pressed="false">blocked ${byState('blocked')}</button>
      <button class="chip" data-f="all" aria-pressed="false">all ${lanes.length}</button>
    </div>
    ${tracks.map((t) => {
      const rows = lanes.filter((l) => l.track === t);
      return `<div class="grp" data-track="${esc(t)}">
        <div class="grp-h"><span class="nm">${esc(t)}</span><span class="ct">${rows.filter((r) => r.state !== 'done').length} open / ${rows.length}</span><span class="rule"></span></div>
        ${rows.map((l, i) => laneRow(l, `${esc(t)}-${i}`)).join('')}
      </div>`;
    }).join('')}
    <div class="card" style="margin-top:6px"><span class="recon"><b>lanes</b>     SELECT id, state, owner_session_id, lease_expires_at, scope
            FROM agentic_os.lane ORDER BY track, priority;
<b>claim</b>     node scripts/coordination/lane.mjs claim &lt;id&gt;    # atomic: one winner, loser is told who won
<b>gate</b>      node scripts/coordination/lane-race-probe.mjs   # 10 properties, incl. both reclaim negatives</span></div>
  </section>

  <section>
    <div class="sec-head"><h2>Activity</h2><p>The last ${events.length} lane events. This log is also the message bus between sessions &mdash; a <span class="mono">note</span> is one session talking to the others.</p></div>
    <div class="card feed">
      ${events.map((e) => `<div>
        <span class="t">${esc(new Date(e.occurred_at).toTimeString().slice(0, 5))}</span>
        <span class="s">${esc(short(e.session_id))}</span>
        <span><b>${esc(e.kind)}</b>${e.lane_id ? ` <span class="mono" style="color:var(--muted)">[${esc(e.lane_id)}]</span>` : ''}${e.to_session_id ? ' <span class="mono" style="color:var(--info)">direct</span>' : ''}${e.body ? `<br>${esc(String(e.body).slice(0, 400))}` : ''}</span>
      </div>`).join('') || '<div><span class="t"></span><span class="s"></span><span>no events yet</span></div>'}
    </div>
  </section>

  <section>
    <div class="sec-head"><h2>Coordination integrity</h2><p>Is the file lock underneath the lanes telling the truth? Point-in-time &mdash; &ldquo;live&rdquo; only means something while somebody is mid-edit.</p></div>
    <div class="card">
      <div class="tw"><table>
        <thead><tr><th>Signal</th><th class="mono">Value</th><th>Reading</th></tr></thead>
        <tbody>
          <tr><td>file_claims with no session row</td><td class="mono">${claimHealth.orphaned}</td><td><span class="pill ${claimHealth.orphaned === 0 ? 'p-ok' : 'p-crit'}">${claimHealth.orphaned === 0 ? 'clean' : 'orphaned'}</span></td></tr>
          <tr><td>claims held by a stale session</td><td class="mono">${claimHealth.stale}</td><td><span class="pill p-idle">ages out</span></td></tr>
          <tr><td>claims held by a live session</td><td class="mono">${claimHealth.live}</td><td><span class="pill p-idle">point-in-time</span></td></tr>
          ${eventKinds.map((k) => `<tr><td><span class="mono">${esc(k.kind)}</span>, last 24h</td><td class="mono">${k.n}</td><td><span class="pill p-idle">coordination_event</span></td></tr>`).join('')}
        </tbody>
      </table></div>
      <span class="recon"><b>careful</b>   the column is <b>occurred_at</b>, NOT ts. And <b>blocked_on</b> means "waiting on a
          human", NOT a claim conflict -- easy to misread as one.
<b>clocks</b>    the DB runs UTC and this machine runs UTC-5. Every time on this page is LOCAL.</span>
    </div>
  </section>

  <footer>
    <span>generated ${localStamp()} local &middot; ${lanes.length} lanes &middot; ${events.length} events</span>
    <span>node scripts/coordination/render-board.mjs</span>
  </footer>
</div>

<script>
  (function () {
    var root = document.documentElement;
    document.getElementById('tt').addEventListener('click', function () {
      var now = root.getAttribute('data-theme');
      if (!now) {
        now = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      root.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
    });

    document.querySelectorAll('.lane').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = document.getElementById(b.getAttribute('aria-controls'));
        var openNow = d.classList.toggle('open');
        b.setAttribute('aria-expanded', String(openNow));
      });
    });

    var chips = document.querySelectorAll('.chip');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        chips.forEach(function (o) { o.setAttribute('aria-pressed', String(o === chip)); });
        var f = chip.dataset.f;
        document.querySelectorAll('.lane').forEach(function (lane) {
          var st = lane.dataset.state, held = lane.dataset.held === '1';
          var show = f === 'all' ? true
            : f === 'open' ? st !== 'done'
            : f === 'held' ? held
            : st === f;
          lane.style.display = show ? '' : 'none';
          var d = document.getElementById(lane.getAttribute('aria-controls'));
          if (!show) { d.classList.remove('open'); lane.setAttribute('aria-expanded', 'false'); }
          d.dataset.hidden = show ? '' : '1';
        });
        // A track heading with nothing under it is noise, not structure.
        document.querySelectorAll('.grp').forEach(function (g) {
          var any = Array.prototype.some.call(g.querySelectorAll('.lane'), function (l) { return l.style.display !== 'none'; });
          g.style.display = any ? '' : 'none';
        });
      });
    });
    document.querySelector('.chip[data-f="open"]').click();
  })();
</script>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1024).toFixed(1)}kb) -- ${lanes.length} lanes, ${sessions.length} live sessions, ${events.length} events`);
