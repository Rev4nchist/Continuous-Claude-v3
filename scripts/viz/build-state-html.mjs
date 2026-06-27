#!/usr/bin/env node
// build-state-html.mjs — assemble the state-of-rework briefing HTML from the
// workflow's narrative.json + the 4 inline SVG diagrams, in CCv3 house style.
// Usage: node build-state-html.mjs <dir>   (dir = state-of-rework/)

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dir = args[0]
const siteIdx = args.indexOf('--site')
const SITE = siteIdx >= 0 ? args[siteIdx + 1] : 'cc'
const outArg = args[1] && !args[1].startsWith('--') ? args[1] : null
if (!dir) { console.error('usage: node build-state-html.mjs <dir> [outFile] [--site cc|decks]'); process.exit(1) }
const OUT = outArg || path.join(dir, 'state-of-rework.html')
const DECKS = SITE === 'decks'
const N = JSON.parse(fs.readFileSync(path.join(dir, '_maps', 'narrative.json'), 'utf8'))
const svg = (f) => fs.readFileSync(path.join(dir, f + '.svg'), 'utf8')

const DIAGRAMS = [
  { id: 'master-3state', title: 'Three Horizons — Current → Adjusting → Target', wide: false },
  { id: 'subsystems', title: 'Subsystems — Pillars & WS-2 Substrate (real dependency graph)', wide: false },
  { id: 'dataflow-traces', title: 'Data-Flow Traces — 4 grounded end-to-end paths', wide: true },
  { id: 'backlog-map', title: 'Backlog Map — Wave 0 → 1 → Tier 2 → Tier 3 → Deletions', wide: true },
]

const STAT_INTENT = { positive: 'g', warning: 'y', negative: 'r', neutral: 'b' }

const statCards = N.stat_cards.map((c) => `
      <div class="stat">
        <div class="stat-val ${STAT_INTENT[c.intent] || 'b'}">${c.value}</div>
        <div class="stat-lbl">${c.label}</div>
      </div>`).join('')

const diagramCards = DIAGRAMS.map((d) => `
    <figure class="diagram" id="dg-${d.id}">
      <figcaption>
        <span class="dg-title">${d.title}</span>
        <span class="dg-links">
          ${DECKS ? `<a href="./viewer/?f=${d.id}" target="_blank">▶ interactive</a>` : ''}
          <a href="./${d.id}.excalidraw" download>⬇ .excalidraw</a>
          <a href="./${d.id}.svg" target="_blank">↗ .svg</a>
        </span>
      </figcaption>
      <div class="canvas${d.wide ? ' wide' : ''}">${svg(d.id)}</div>
    </figure>`).join('')

function tableHtml(t) {
  const sevColor = { S0: 'r', S1: 'o', S2: 'y', S3: 'b', Total: 'mut' }
  const head = t.columns.map((c) => `<th>${c}</th>`).join('')
  const body = t.rows.map((r) => {
    const cells = r.map((cell, i) => {
      if (i === 0 && sevColor[cell]) return `<td><span class="badge ${sevColor[cell]}">${cell}</span></td>`
      if (i === 0) return `<td class="c0">${cell}</td>`
      return `<td>${cell}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')
  return `
    <div class="card" id="tbl-${t.id}">
      <div class="card-eyebrow">Ledger</div>
      <h3>${t.caption}</h3>
      <div class="table-wrap"><table>
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`
}

const TABLE_BY = Object.fromEntries(N.tables.map((t) => [t.id, t]))
// which tables sit under which section
const SECTION_TABLES = {
  adjustments: ['backlog-tiers', 'severity-ledger'],
  'elegance-gaps': ['duplication-dead-weight'],
}

const sections = N.sections.map((s) => {
  const tables = (SECTION_TABLES[s.id] || []).map((tid) => TABLE_BY[tid] ? tableHtml(TABLE_BY[tid]) : '').join('\n')
  return `
    <section class="sec card" id="sec-${s.id}">
      <div class="card-eyebrow">${s.id.replace(/-/g, ' ')}</div>
      <h2>${s.heading}</h2>
      <div class="prose">${s.body_html}</div>
      ${tables}
    </section>`
}).join('\n')

const navItems = [
  { id: 'hero', label: 'Headline Verdict' },
  { id: 'stats', label: 'At a Glance' },
  { id: 'diagrams', label: 'Architecture Diagrams' },
  ...N.sections.map((s) => ({ id: 'sec-' + s.id, label: s.heading.split('—')[0].trim() })),
]
const nav = navItems.map((i) => `<a href="#${i.id}" class="nav-i">${i.label}</a>`).join('\n        ')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${N.title}</title>
<style>
:root{
  --bg:#0b1020; --bg-alt:#0a0e1a; --panel:#111827; --panel-2:#0e1525; --elev:#1c2236;
  --card:#131829; --code:#0e1322;
  --bd:#1f2937; --bd-light:#2a3447; --bd-strong:#3a4360;
  --tx:#e5e7eb; --dim:#9ca3af; --dim2:#94a3b8; --mut:#6b7280; --mut2:#64748b;
  --accent:#fbbf24; --accent-soft:rgba(251,191,36,.16);
  --green:#34d399; --blue:#60a5fa; --purple:#a78bfa; --red:#f87171; --orange:#fb923c; --teal:#2dd4bf; --cyan:#06b6d4; --pink:#ec4899;
  --shadow:0 8px 24px rgba(0,0,0,.5);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:var(--tx);
  background:radial-gradient(circle at 25% 12%,rgba(99,102,241,.06),transparent 55%),radial-gradient(circle at 78% 85%,rgba(251,191,36,.05),transparent 50%),var(--bg);}
code,.mono{font-family:'JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace}
code{background:var(--code);border:1px solid var(--bd);border-radius:4px;padding:1px 5px;font-size:.86em;color:#fcd34d}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

header.app{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:14px;padding:13px 22px;
  background:var(--panel-2);border-bottom:1px solid var(--bd)}
header.app h1{font-size:17px;font-weight:700;margin:0;letter-spacing:-.01em}
header.app .sub{font-size:12.5px;color:var(--dim)}
header.app .spacer{flex:1}
header.app a.back,header.app a.ghost{font-size:12.5px;border:1px solid var(--bd-light);border-radius:6px;padding:5px 11px;color:var(--dim2)}
header.app a.back:hover,header.app a.ghost:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
header.app .verified{font-size:11.5px;color:var(--mut)}

.layout{display:grid;grid-template-columns:288px 1fr;align-items:start}
aside.nav{position:sticky;top:49px;height:calc(100vh - 49px);overflow-y:auto;
  background:linear-gradient(180deg,#0c1124,#0a0e1a);border-right:1px solid var(--bd-light);padding:22px 14px}
aside.nav .grp{font-size:10px;text-transform:uppercase;letter-spacing:.18em;color:var(--mut2);margin:6px 10px 8px}
aside.nav .nav-i{display:block;padding:7px 12px;border-radius:7px;color:var(--dim2);font-size:13px;border-left:2px solid transparent;margin-bottom:2px}
aside.nav .nav-i:hover{background:#0f1830;color:var(--tx);text-decoration:none}
aside.nav .nav-i.active{background:var(--accent-soft);border-left-color:var(--accent);color:var(--accent)}

main{padding:34px 52px 90px;max-width:1180px}

.hero{margin-bottom:30px}
.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:var(--accent);font-weight:600}
.hero h1{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:10px 0 6px;line-height:1.12}
.verdict{font-size:18px;color:var(--tx);background:linear-gradient(90deg,rgba(251,191,36,.10),transparent);border-left:3px solid var(--accent);
  padding:12px 18px;border-radius:0 8px 8px 0;margin:14px 0 22px;font-weight:500}
.www{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:980px){.www{grid-template-columns:1fr}}
.www .b{background:var(--card);border:1px solid var(--bd-light);border-radius:12px;padding:16px 18px}
.www .b .k{font-size:11px;text-transform:uppercase;letter-spacing:.14em;font-weight:700;margin-bottom:7px}
.www .b.what .k{color:var(--green)} .www .b.why .k{color:var(--orange)} .www .b.where .k{color:var(--purple)}
.www .b p{margin:0;font-size:12.7px;color:var(--dim2);line-height:1.5}
.www .b code{font-size:11px}

.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:14px;margin:8px 0 34px}
.stat{background:var(--elev);border:1px solid var(--bd-light);border-radius:10px;padding:16px 18px}
.stat-val{font-size:25px;font-weight:700;letter-spacing:-.02em}
.stat-val.g{color:var(--green)} .stat-val.y{color:var(--accent)} .stat-val.b{color:var(--blue)} .stat-val.r{color:var(--red)} .stat-val.o{color:var(--orange)}
.stat-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin-top:5px}

h2.block{font-size:13px;text-transform:uppercase;letter-spacing:.16em;color:var(--accent);margin:34px 0 14px;border-top:1px solid var(--bd);padding-top:22px}

.diagram{margin:0 0 22px;background:var(--card);border:1px solid var(--bd-light);border-radius:12px;overflow:hidden}
.diagram figcaption{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--bd);background:var(--panel-2)}
.diagram .dg-title{font-size:13.5px;font-weight:700;color:var(--tx)}
.diagram .dg-links{margin-left:auto;display:flex;gap:12px}
.diagram .dg-links a{font-size:11.5px;color:var(--dim2)}
.canvas{padding:14px;background:#0a0e1a;overflow:auto;max-height:680px}
.canvas svg{display:block;max-width:100%;height:auto;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.45)}
.canvas.wide svg{max-width:none}
.canvas.wide{scrollbar-color:var(--bd-strong) transparent}

.card{background:var(--card);border:1px solid var(--bd-light);border-radius:12px;padding:24px 26px;margin:0 0 20px;scroll-margin-top:64px}
.card-eyebrow{font-size:10.5px;text-transform:uppercase;letter-spacing:.16em;color:var(--mut2);font-weight:700;margin-bottom:6px}
.sec h2{font-size:23px;font-weight:650;letter-spacing:-.01em;margin:0 0 14px}
.prose{font-size:13.4px;line-height:1.62;color:var(--dim2)}
.prose p{margin:0 0 12px} .prose ul{margin:6px 0 14px;padding-left:20px} .prose li{margin:0 0 8px}
.prose strong{color:var(--tx);font-weight:650}
.prose em{color:var(--accent);font-style:normal;font-weight:600}
.prose code{font-size:11.5px}
.prose h3{font-size:15px;color:var(--tx);margin:18px 0 8px}

.table-wrap{overflow-x:auto;margin-top:14px;border:1px solid var(--bd);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:12.4px;min-width:560px}
thead th{text-align:left;background:var(--panel-2);color:var(--dim);font-weight:650;padding:10px 13px;border-bottom:1px solid var(--bd-light);
  text-transform:uppercase;font-size:10.5px;letter-spacing:.06em;white-space:nowrap}
tbody td{padding:10px 13px;border-bottom:1px solid var(--bd);color:var(--dim2);vertical-align:top}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#0f1830}
td.c0{color:var(--tx);font-weight:600}
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700}
.badge.r{background:rgba(248,113,113,.16);color:var(--red)}
.badge.o{background:rgba(251,146,60,.16);color:var(--orange)}
.badge.y{background:var(--accent-soft);color:var(--accent)}
.badge.b{background:rgba(96,165,250,.16);color:var(--blue)}
.badge.mut{background:#1c2236;color:var(--dim)}

footer{border-top:1px solid var(--bd);padding:22px 52px 30px;color:var(--mut);font-size:12px;margin-left:288px}
footer a{color:var(--dim2);margin-right:18px}
@media(max-width:900px){.layout{grid-template-columns:1fr}aside.nav{display:none}main{padding:24px 20px 70px}footer{margin-left:0}}
</style>
</head>
<body>
<header class="app">
  <a class="back" href="${DECKS ? '../' : '../hub.html'}">← ${DECKS ? 'AI Enablement Decks' : 'Hub'}</a>
  <h1>State of the CCv3 Rework</h1>
  <span class="sub">Fable-5 Deep Review · SHA 86b8f60</span>
  <span class="spacer"></span>
  <a class="ghost" href="https://github.com/Rev4nchist/Continuous-Claude-v3" target="_blank">GitHub</a>
  <span class="verified">verified 2026-06-27</span>
</header>

<div class="layout">
  <aside class="nav">
    <div class="grp">On this page</div>
    ${nav}
    <div class="grp" style="margin-top:16px">Ledgers</div>
    <a href="#tbl-severity-ledger" class="nav-i">Severity Ledger</a>
    <a href="#tbl-backlog-tiers" class="nav-i">Backlog Tiers</a>
    <a href="#tbl-duplication-dead-weight" class="nav-i">Duplication & Dead Weight</a>
  </aside>

  <main>
    <div class="hero" id="hero">
      <div class="eyebrow">CCv3 · Fable-5 Deep Review · ${N.title.split('—').pop().trim()}</div>
      <h1>${N.title.split('—')[0].trim()}</h1>
      <div class="verdict">${N.tier1.headline_verdict}</div>
      <div class="www">
        <div class="b what"><div class="k">What it is</div><p>${N.tier1.what}</p></div>
        <div class="b why"><div class="k">Why we're honing it</div><p>${N.tier1.why}</p></div>
        <div class="b where"><div class="k">Where it lands</div><p>${N.tier1.where}</p></div>
      </div>
    </div>

    <h2 class="block" id="stats">At a Glance</h2>
    <div class="stats">${statCards}</div>

    <h2 class="block" id="diagrams">Architecture Diagrams</h2>
    <p style="color:var(--dim);font-size:12.5px;margin:-4px 0 16px">Rendered inline below; each links to its editable <code>.excalidraw</code> source (opens in excalidraw.com / VS Code) and a standalone <code>.svg</code>.</p>
    ${diagramCards}

    <h2 class="block">The Three Horizons — In Depth</h2>
    ${sections}
  </main>
</div>

<footer>
  ${DECKS ? `
  <a href="../">← AI Enablement Decks</a>
  <a href="./viewer/?f=master-3state" target="_blank">interactive diagrams</a>
  <a href="./master-3state.excalidraw" download>diagram sources (.excalidraw)</a>
  <a href="https://github.com/Rev4nchist/Continuous-Claude-v3" target="_blank">CCv3 repo</a>
  <div style="margin-top:10px">CCv3 State of Rework · generated from the Fable-5 deep review (190 confirmed findings) · last verified 2026-06-27 · diagrams editable in <a href="https://excalidraw.com" target="_blank" style="margin:0">excalidraw.com</a></div>
  ` : `
  <a href="../hub.html">← Architecture Hub</a>
  <a href="./_maps/narrative.json">narrative.json</a>
  <a href="../../../reviews/2026-06-10/findings.json">findings.json</a>
  <a href="../../../reviews/2026-06-10/wf3/synthesis.json">synthesis.json</a>
  <a href="../../../reviews/2026-06-10/ccv3-fable5-deep-review-2026-06-10.md">full report</a>
  <div style="margin-top:10px">CCv3 State of Rework · generated from the Fable-5 deep review (190 confirmed findings) · last verified 2026-06-27</div>
  `}
</footer>

<script>
// active nav on scroll
const obs=new IntersectionObserver((es)=>{es.forEach(e=>{if(e.isIntersecting){
  document.querySelectorAll('.nav-i').forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+e.target.id));
}})},{rootMargin:'-20% 0px -70% 0px'});
document.querySelectorAll('[id]').forEach(el=>{if(el.id&&document.querySelector('.nav-i[href="#'+el.id+'"]'))obs.observe(el)});
</script>
</body>
</html>`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html)
console.log(`wrote ${OUT} — ${(html.length / 1024).toFixed(1)}KB, site=${SITE}, ${N.sections.length} sections, ${N.tables.length} tables, ${DIAGRAMS.length} inline diagrams`)
