#!/usr/bin/env node
// gen-svg.mjs — render the SAME lane/node/edge spec as gen-excalidraw.mjs to a
// self-contained SVG (light "canvas" look matching Excalidraw), for inline embed
// in dark-themed HTML briefings. Single source of truth = the spec JSON.
// Usage: node gen-svg.mjs <spec.json> <out.svg>

import fs from 'node:fs'

const [, , specPath, outPath] = process.argv
if (!specPath || !outPath) { console.error('usage: node gen-svg.mjs <spec.json> <out.svg>'); process.exit(1) }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))

// palette (mirror of gen-excalidraw.mjs)
const INTENT = {
  sound:{s:'#2f9e44',b:'#ebfbee'}, honing:{s:'#f08c00',b:'#fff9db'}, gap:{s:'#e03131',b:'#fff0f0'},
  substrate:{s:'#1971c2',b:'#e7f5ff'}, external:{s:'#868e96',b:'#f1f3f5'}, target:{s:'#7048e8',b:'#f3f0ff'},
  done:{s:'#0ca678',b:'#e6fcf5'}, wave1:{s:'#f08c00',b:'#fff9db'}, structural:{s:'#1971c2',b:'#e7f5ff'},
  strategic:{s:'#7048e8',b:'#f3f0ff'}, deletion:{s:'#e8590c',b:'#fff4e6'}, neutral:{s:'#495057',b:'#f8f9fa'},
}
const intentOf = (i) => INTENT[i] || INTENT.neutral
const EDGE = {
  flow:{c:'#495057',d:false}, evolves:{c:'#7048e8',d:false}, reads:{c:'#1971c2',d:false},
  writes:{c:'#0ca678',d:false}, dep:{c:'#868e96',d:false}, fallback:{c:'#e8590c',d:true}, dashed:{c:'#868e96',d:true},
}
const edgeOf = (k) => EDGE[k] || EDGE.flow

// geometry (mirror of gen-excalidraw.mjs)
const NODE_W=248, NODE_H=86, V_GAP=30, H_GAP=56, LANE_GAP=84, LANE_GAP_ROW=64
const MARGIN_X=80, TITLE_H=96, LANE_HDR_H=44
const orientation = spec.orientation || (/dataflow|trace/i.test(spec.filename||'') ? 'rows' : 'columns')

const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
const out = []
const boxes = new Map()
let maxR = MARGIN_X, maxB = TITLE_H

// layout
const lanes = spec.lanes || [{id:'_',label:''}]
const byLane = new Map(lanes.map(l=>[l.id,[]]))
for (const n of spec.nodes||[]) { if(!byLane.has(n.lane)) byLane.set(n.lane,[]); byLane.get(n.lane).push(n) }

const laneRects = []
if (orientation === 'columns') {
  lanes.forEach((lane,li) => {
    const x = MARGIN_X + li*(NODE_W+LANE_GAP)
    const list = byLane.get(lane.id)||[]
    let y = TITLE_H + LANE_HDR_H
    for (const n of list) { boxes.set(n.id,{x,y,w:NODE_W,h:NODE_H,n}); y += NODE_H+V_GAP }
    laneRects.push({x:x-18,y:TITLE_H+30,w:NODE_W+36,h:(y-(TITLE_H+LANE_HDR_H))+18,lane,labelX:x,labelY:TITLE_H})
    maxB=Math.max(maxB,y); maxR=Math.max(maxR,x+NODE_W)
  })
} else {
  lanes.forEach((lane,li) => {
    const y = TITLE_H + LANE_HDR_H + li*(NODE_H+LANE_GAP_ROW)
    const list = byLane.get(lane.id)||[]
    let x = MARGIN_X
    for (const n of list) { boxes.set(n.id,{x,y,w:NODE_W,h:NODE_H,n}); x += NODE_W+H_GAP }
    laneRects.push({x:MARGIN_X-14,y:y-6,w:(x-MARGIN_X)+12,h:NODE_H+12,lane,labelX:MARGIN_X,labelY:y-24})
    maxB=Math.max(maxB,y+NODE_H); maxR=Math.max(maxR,x)
  })
}

const PAD = 36
const W = maxR + PAD, H = maxB + (Array.isArray(spec.notes)&&spec.notes.length ? 110 : 50)

// background
out.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="#ffffff"/>`)

// title + subtitle
out.push(`<text x="${MARGIN_X}" y="52" font-family="system-ui,Segoe UI,sans-serif" font-size="28" font-weight="800" fill="#0b1324">${esc(spec.title||spec.filename||'CCv3')}</text>`)
if (spec.subtitle) out.push(`<text x="${MARGIN_X}" y="78" font-family="system-ui,Segoe UI,sans-serif" font-size="15" fill="#64748b">${esc(spec.subtitle)}</text>`)

// lane backgrounds + labels
for (const lr of laneRects) {
  out.push(`<rect x="${lr.x}" y="${lr.y}" width="${lr.w}" height="${lr.h}" rx="12" fill="none" stroke="${lr.lane.accent||'#cbd5e1'}" stroke-width="1.5" stroke-dasharray="2 6" opacity="0.7"/>`)
  out.push(`<text x="${lr.labelX}" y="${lr.labelY+16}" font-family="system-ui,Segoe UI,sans-serif" font-size="15" font-weight="800" letter-spacing="0.04em" fill="${lr.lane.accent||'#0b1324'}">${esc(lr.lane.label||'')}</text>`)
}

// edges (under nodes)
function borderPoint(b, tx, ty) {
  const cx=b.x+b.w/2, cy=b.y+b.h/2
  let dx=tx-cx, dy=ty-cy
  if (dx===0&&dy===0) return [cx,cy]
  const sx = dx!==0 ? (b.w/2)/Math.abs(dx) : Infinity
  const sy = dy!==0 ? (b.h/2)/Math.abs(dy) : Infinity
  const t = Math.min(sx,sy)
  return [cx+dx*t, cy+dy*t]
}
const edgeSvg = []
for (const e of spec.edges||[]) {
  const a=boxes.get(e.from), b=boxes.get(e.to)
  if(!a||!b) continue
  const ac=[a.x+a.w/2,a.y+a.h/2], bc=[b.x+b.w/2,b.y+b.h/2]
  const [sx,sy]=borderPoint(a,bc[0],bc[1])
  const [ex,ey]=borderPoint(b,ac[0],ac[1])
  const st=edgeOf(e.kind)
  const dash = st.d ? ' stroke-dasharray="6 5"' : ''
  // gentle curve
  const mx=(sx+ex)/2, my=(sy+ey)/2
  edgeSvg.push(`<path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${st.c}" stroke-width="2"${dash} marker-end="url(#ah)"/>`)
  if (e.label) {
    const lw = String(e.label).length*5.6+10
    edgeSvg.push(`<rect x="${(mx-lw/2).toFixed(1)}" y="${(my-9).toFixed(1)}" width="${lw.toFixed(1)}" height="16" rx="4" fill="#ffffff" opacity="0.92"/>`)
    edgeSvg.push(`<text x="${mx.toFixed(1)}" y="${(my+3).toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5" fill="${st.c}">${esc(e.label)}</text>`)
  }
}
out.push(...edgeSvg)

// nodes
for (const [,b] of boxes) {
  const c=intentOf(b.n.intent)
  out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${c.b}" stroke="${c.s}" stroke-width="2"/>`)
  out.push(`<rect x="${b.x}" y="${b.y}" width="5" height="${b.h}" rx="2" fill="${c.s}"/>`)
  const cx=b.x+b.w/2
  const label=String(b.n.label||b.n.id)
  const sub=b.n.sublabel?String(b.n.sublabel):''
  if (sub) {
    out.push(`<text x="${cx}" y="${b.y+36}" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" font-size="15" font-weight="700" fill="#0b1324">${esc(label)}</text>`)
    // wrap sublabel to <=34 chars/line, max 2 lines
    const words=sub.split(' '); const lines=[]; let cur=''
    for(const w of words){ if((cur+' '+w).trim().length>34){lines.push(cur.trim());cur=w}else cur=(cur+' '+w).trim() }
    if(cur)lines.push(cur.trim())
    lines.slice(0,2).forEach((ln,i)=>out.push(`<text x="${cx}" y="${b.y+56+i*15}" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="11" fill="#475569">${esc(ln)}</text>`))
  } else {
    out.push(`<text x="${cx}" y="${b.y+b.h/2+5}" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" font-size="15" font-weight="700" fill="#0b1324">${esc(label)}</text>`)
  }
}

// notes
if (Array.isArray(spec.notes) && spec.notes.length) {
  const ny=maxB+38
  out.push(`<text x="${MARGIN_X}" y="${ny}" font-family="system-ui,sans-serif" font-size="13" font-weight="800" fill="#94a3b8">NOTES</text>`)
  spec.notes.forEach((s,i)=>{
    // wrap each note ~ (W-2*MARGIN)/6.6 chars
    const max=Math.floor((W-2*MARGIN_X)/6.6)
    const words=String(s).split(' '); const lines=[]; let cur='• '
    for(const w of words){ if((cur+' '+w).length>max){lines.push(cur);cur='   '+w}else cur=(cur+' '+w).trim()===''?cur+w:cur+' '+w }
    lines.push(cur)
  })
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(spec.title||spec.filename)}">
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M 0 1 L 9 5 L 0 9 z" fill="context-stroke"/></marker></defs>
${out.join('\n')}
</svg>`
fs.writeFileSync(outPath, svg)
console.log(`wrote ${outPath} — ${W}x${H}, ${boxes.size} nodes, ${(spec.edges||[]).length} edges, ${orientation}`)
