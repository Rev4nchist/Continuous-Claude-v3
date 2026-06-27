#!/usr/bin/env node
// gen-excalidraw.mjs — turn a logical lane/node/edge spec into a valid Excalidraw v2 file.
// Usage: node gen-excalidraw.mjs <spec.json> <out.excalidraw>
// Spec shape (see state-of-rework synthesis schema):
//   { filename, title, subtitle?, orientation?: "columns"|"rows",
//     lanes:[{id,label,accent?}],
//     nodes:[{id,lane,label,sublabel?,intent?,group?}],
//     edges:[{from,to,label?,kind?}],
//     notes?:[string] }
// Layout: columns mode stacks nodes vertically within each lane (lanes = columns);
//         rows mode flows nodes left-to-right within each lane (lanes = swimlanes).
//         dataflow-style specs auto-default to rows.

import fs from 'node:fs'

const [, , specPath, outPath] = process.argv
if (!specPath || !outPath) {
  console.error('usage: node gen-excalidraw.mjs <spec.json> <out.excalidraw>')
  process.exit(1)
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))

// ---- palette ---------------------------------------------------------------
const INTENT = {
  sound:      { s: '#2f9e44', b: '#ebfbee' },
  honing:     { s: '#f08c00', b: '#fff9db' },
  gap:        { s: '#e03131', b: '#fff0f0' },
  substrate:  { s: '#1971c2', b: '#e7f5ff' },
  external:   { s: '#868e96', b: '#f1f3f5' },
  target:     { s: '#7048e8', b: '#f3f0ff' },
  done:       { s: '#0ca678', b: '#e6fcf5' },
  wave1:      { s: '#f08c00', b: '#fff9db' },
  structural: { s: '#1971c2', b: '#e7f5ff' },
  strategic:  { s: '#7048e8', b: '#f3f0ff' },
  deletion:   { s: '#e8590c', b: '#fff4e6' },
  neutral:    { s: '#495057', b: '#f8f9fa' },
}
const intentOf = (i) => INTENT[i] || INTENT.neutral

const EDGE = {
  flow:    { c: '#495057', dashed: false, head: 'arrow' },
  evolves: { c: '#7048e8', dashed: false, head: 'triangle' },
  reads:   { c: '#1971c2', dashed: false, head: 'arrow' },
  writes:  { c: '#0ca678', dashed: false, head: 'arrow' },
  dep:     { c: '#868e96', dashed: false, head: 'arrow' },
  fallback:{ c: '#e8590c', dashed: true,  head: 'arrow' },
  dashed:  { c: '#868e96', dashed: true,  head: 'arrow' },
}
const edgeOf = (k) => EDGE[k] || EDGE.flow

// ---- geometry --------------------------------------------------------------
const NODE_W = 248
const NODE_H = 86
const V_GAP = 30          // between stacked nodes (columns mode)
const H_GAP = 56          // between flowed nodes (rows mode)
const LANE_GAP = 84       // between columns
const LANE_GAP_ROW = 64   // between swimlanes
const MARGIN_X = 80
const TITLE_H = 96
const LANE_HDR_H = 44

const orientation =
  spec.orientation ||
  (/dataflow|trace/i.test(spec.filename || '') ? 'rows' : 'columns')

// ---- element factory -------------------------------------------------------
let z = 1
const rid = (p) => `${p}_${z++}_${Math.random().toString(36).slice(2, 8)}`
const nonce = () => Math.floor(Math.random() * 2 ** 31)
const now = () => Date.now()
const els = []

function rect(id, x, y, w, h, intent, opts = {}) {
  const c = intentOf(intent)
  els.push({
    id, type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: opts.strokeColor || c.s,
    backgroundColor: opts.backgroundColor || c.b,
    fillStyle: 'solid', strokeWidth: opts.strokeWidth || 2,
    strokeStyle: opts.strokeStyle || 'solid', roughness: 0, opacity: opts.opacity ?? 100,
    groupIds: [], frameId: null, roundness: { type: 3 }, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false,
    boundElements: opts.boundText ? [{ type: 'text', id: opts.boundText }] : [],
    updated: now(), link: null, locked: false,
  })
}

function boundText(id, containerId, text, x, y, w, h, fontSize = 15, color = '#1a1b1e', align = 'center') {
  const lines = String(text).split('\n')
  els.push({
    id, type: 'text', x, y, width: w, height: h, angle: 0,
    strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null,
    updated: now(), link: null, locked: false,
    fontSize, fontFamily: 2, text, textAlign: align, verticalAlign: 'middle',
    containerId: containerId || null, originalText: text,
    lineHeight: 1.25, baseline: Math.round(fontSize * 0.9 * lines.length),
  })
}

function freeText(text, x, y, fontSize = 16, color = '#343a40', align = 'left', bold = false) {
  const lines = String(text).split('\n')
  const w = Math.max(...lines.map((l) => l.length)) * fontSize * 0.58 + 8
  const h = lines.length * fontSize * 1.25
  els.push({
    id: rid('ft'), type: 'text', x, y, width: w, height: h, angle: 0,
    strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null,
    updated: now(), link: null, locked: false,
    fontSize, fontFamily: bold ? 2 : 2, text, textAlign: align, verticalAlign: 'top',
    containerId: null, originalText: text, lineHeight: 1.25,
    baseline: Math.round(fontSize * 0.9 * lines.length),
  })
  return { w, h }
}

function node(n, x, y) {
  const boxId = rid('n')
  const txtId = rid('t')
  rect(boxId, x, y, NODE_W, NODE_H, n.intent, { boundText: txtId })
  const label = (n.label || n.id).toUpperCase()
  const txt = n.sublabel ? `${label}\n${n.sublabel}` : label
  const fsz = n.sublabel ? 13 : 15
  const nLines = txt.split('\n').length
  const th = Math.ceil(nLines * fsz * 1.25)          // real content height
  const ty = y + Math.round((NODE_H - th) / 2)       // vertically centered in the box
  boundText(txtId, boxId, txt, x + 8, ty, NODE_W - 16, th, fsz)
  return boxId
}

function laneBg(x, y, w, h, accent) {
  els.push({
    id: rid('lane'), type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: accent || '#ced4da', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'dotted', roughness: 0,
    opacity: 60, groupIds: [], frameId: null, roundness: { type: 3 }, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false, boundElements: [],
    updated: now(), link: null, locked: false,
  })
}

function arrow(fromBox, toBox, fromXY, toXY, kind, label) {
  const e = edgeOf(kind)
  const id = rid('e')
  const [x1, y1] = fromXY
  const [x2, y2] = toXY
  els.push({
    id, type: 'arrow', x: x1, y: y1,
    width: x2 - x1, height: y2 - y1, angle: 0,
    strokeColor: e.c, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: e.dashed ? 'dashed' : 'solid', roughness: 0,
    opacity: 100, groupIds: [], frameId: null, roundness: { type: 2 }, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false, boundElements: [],
    updated: now(), link: null, locked: false,
    points: [[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint: null,
    startBinding: { elementId: fromBox, focus: 0, gap: 6 },
    endBinding: { elementId: toBox, focus: 0, gap: 6 },
    startArrowhead: null, endArrowhead: e.head,
  })
  // mark the boxes as bound
  for (const bx of [fromBox, toBox]) {
    const r = els.find((el) => el.id === bx)
    if (r && Array.isArray(r.boundElements)) r.boundElements.push({ type: 'arrow', id })
  }
  if (label) {
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2 - 10
    freeText(label, mx - label.length * 3, my, 11, e.c, 'center')
  }
}

// ---- title -----------------------------------------------------------------
freeText(spec.title || spec.filename || 'CCv3', MARGIN_X, 24, 30, '#0b1324', 'left', true)
if (spec.subtitle) freeText(spec.subtitle, MARGIN_X, 64, 16, '#495057', 'left')

// ---- place nodes -----------------------------------------------------------
const lanes = spec.lanes || [{ id: '_', label: '' }]
const byLane = new Map(lanes.map((l) => [l.id, []]))
for (const n of spec.nodes || []) {
  if (!byLane.has(n.lane)) byLane.set(n.lane, [])
  byLane.get(n.lane).push(n)
}
const boxOf = new Map() // node.id -> excalidraw box id

let maxBottom = TITLE_H
let maxRight = MARGIN_X

if (orientation === 'columns') {
  lanes.forEach((lane, li) => {
    const x = MARGIN_X + li * (NODE_W + LANE_GAP)
    const list = byLane.get(lane.id) || []
    freeText(lane.label, x, TITLE_H, 18, lane.accent || '#0b1324', 'left', true)
    let y = TITLE_H + LANE_HDR_H
    for (const n of list) {
      const id = node(n, x, y)
      boxOf.set(n.id, id)
      y += NODE_H + V_GAP
    }
    laneBg(x - 18, TITLE_H + 30, NODE_W + 36, (y - (TITLE_H + LANE_HDR_H)) + 18, lane.accent)
    maxBottom = Math.max(maxBottom, y)
    maxRight = Math.max(maxRight, x + NODE_W)
  })
} else {
  // rows / swimlanes
  lanes.forEach((lane, li) => {
    const y = TITLE_H + LANE_HDR_H + li * (NODE_H + LANE_GAP_ROW)
    const list = byLane.get(lane.id) || []
    freeText(lane.label, MARGIN_X, y - 24, 15, lane.accent || '#0b1324', 'left', true)
    let x = MARGIN_X
    for (const n of list) {
      const id = node(n, x, y)
      boxOf.set(n.id, id)
      x += NODE_W + H_GAP
    }
    laneBg(MARGIN_X - 14, y - 6, (x - MARGIN_X) + 12, NODE_H + 12, lane.accent)
    maxBottom = Math.max(maxBottom, y + NODE_H)
    maxRight = Math.max(maxRight, x)
  })
}

// ---- edges -----------------------------------------------------------------
function center(boxId) {
  const r = els.find((el) => el.id === boxId)
  return r ? [r.x + r.width / 2, r.y + r.height / 2] : null
}
for (const e of spec.edges || []) {
  const fb = boxOf.get(e.from)
  const tb = boxOf.get(e.to)
  if (!fb || !tb) continue
  const fc = center(fb)
  const tc = center(tb)
  if (!fc || !tc) continue
  arrow(fb, tb, fc, tc, e.kind, e.label)
}

// ---- notes -----------------------------------------------------------------
if (Array.isArray(spec.notes) && spec.notes.length) {
  const ny = maxBottom + 40
  freeText('NOTES', MARGIN_X, ny, 14, '#868e96', 'left', true)
  freeText(spec.notes.map((s) => `• ${s}`).join('\n'), MARGIN_X, ny + 22, 13, '#495057', 'left')
}

// ---- write -----------------------------------------------------------------
const doc = {
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: els,
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
}
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2))
console.log(`wrote ${outPath} — ${els.length} elements (${(spec.nodes || []).length} nodes, ${(spec.edges || []).length} edges, ${orientation})`)
