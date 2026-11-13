#!/usr/bin/env node
// coord-drill-2 metric script. Computes the 10 coordination metrics of the
// comms-efficiency review plan from Claude Code session transcripts (JSONL).
// No model call, no database, no network.
//
// OUTPUT RULE (seat condition): aggregates only. This file never prints or writes
// a message text, a tool input text, a file content, an environment value, an
// address or a url. Session ids appear as their first 8 characters. Texts are
// reduced to sha1 hashes in memory and only counts leave the process.
//
// Window matching of sent texts uses the first 6 bytes of sha1 of each
// 20-character window of the normalized text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const WIN = 20;
const TWO_H = 2 * 3600 * 1000;
const VAR_MARK = '\u0001';
// A shell variable or subexpression: its value is unknown, so windows that hold one are skipped.
const VAR_RE = /\$(?:\{[^}]*\}|\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)/g;
// The review engine state folder is never opened. Checked on the path text before any fs call.
const PROTECTED_FRAGMENT = '/.claude/state/review-engine';

const num = (v) => (Number.isFinite(v) ? v : 0);
const asArray = (v) => (Array.isArray(v) ? v : []);
const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// ---- hashing and text windows ---------------------------------------------
export const sha1Hex = (s) => crypto.createHash('sha1').update(s).digest('hex');
const winKey = (s, i) => crypto.createHash('sha1').update(s.substr(i, WIN), 'latin1').digest().readUIntBE(0, 6);

// Probe keys of a SENT text. Windows that hold a shell variable are skipped, so a
// text that starts with $t or $MSG still matches on a later window.
export function sendProbes(raw, max = 60) {
  const n = String(raw).slice(0, 6000).replace(VAR_RE, VAR_MARK).toLowerCase().replace(/[^a-z0-9\u0001]/g, '');
  const pos = [];
  for (let i = 0; i + WIN <= n.length; i += 3) if (!n.substr(i, WIN).includes(VAR_MARK)) pos.push(i);
  const step = Math.max(1, Math.ceil(pos.length / max));
  const keys = [];
  for (let k = 0; k < pos.length; k += step) keys.push(winKey(n, pos[k]));
  return keys;
}

// Every window key of an ARRIVED text (stride 1), sorted for binary search.
export function arrivalWindows(text) {
  const n = String(text).slice(0, 16384).toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = new Float64Array(Math.max(0, n.length - WIN + 1));
  for (let i = 0; i < out.length; i++) out[i] = winKey(n, i);
  return out.sort();
}

function hasKey(arr, k) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] === k) return true;
    if (arr[m] < k) lo = m + 1;
    else hi = m - 1;
  }
  return false;
}

// ---- small math -----------------------------------------------------------
// Nearest-rank percentile of an unsorted array.
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

// Total length covered by a set of [start, end] intervals (wall-clock union).
export function unionLength(intervals) {
  const s = intervals.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of s) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  return cur ? total + cur[1] - cur[0] : total;
}

let chicagoFmt = null;
export function chicagoDay(ms) {
  chicagoFmt ||= new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  return chicagoFmt.format(new Date(ms));
}

const dist = (arr) => ({ n: arr.length, p50: round(percentile(arr, 0.5), 1), p90: round(percentile(arr, 0.9), 1), max: arr.length ? round(Math.max(...arr), 1) : null });

// ---- tool call classifier (metric 8) --------------------------------------
const LANE_VERB = String.raw`(?:lane\.mjs['"]?|\$[A-Za-z_][A-Za-z0-9_]*)\s+(?:--\S+\s+\S+\s+)*`;
const LANE_NOTE_RE = new RegExp(`${LANE_VERB}note\\b`, 'i');
const LANE_SAY_RE = new RegExp(`${LANE_VERB}say\\b`, 'i');
const LANE_WRITE_RE = new RegExp(`${LANE_VERB}(?:note|say|add|claim|release|done|state|park|band|rank|remind|seed)\\b`, 'i');
const WRITE_CMD_RE = /\bgit\s+(?:commit|push|add)\b|\bgh\s+pr\s+(?:create|merge)\b|\b(?:Set-Content|Add-Content|Out-File)\b/i;
const REVIEW_RE = /\bgit\s+(?:diff|show|log|status)\b|\bgh\s+(?:pr|api)\b|\bpre-pr\b|\b(?:vitest|pytest)\b|node\s+--test|npm\s+(?:run\s+)?test|probe/i;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'SendMessage']);

const CLASS_TESTS = {
  'LANE NOTE': (n, x) => LANE_NOTE_RE.test(x),
  DM: (n, x) => LANE_SAY_RE.test(x),
  SENDMESSAGE: (n) => n === 'SendMessage',
  'MILESTONE LOG': (n, x) => /milestone/i.test(x),
  RUNBOOK: (n, x) => /runbook/i.test(x),
  JOURNAL: (n, x) => /journal/i.test(x),
  'SIGNAL BOARD': (n, x) => /^Artifact(?:Data)?$/.test(n) || /signal-board|render-board/i.test(x),
  TRACKER: (n, x) => /tracker/i.test(x),
  HANDOFF: (n, x) => /notion.*(?:create|update)/i.test(n) || /handoffs?\b/i.test(x),
  'BOARD READ': (n, x) => /board\s+--json|program\.mjs|lane\.mjs['"]?\s+board/i.test(x),
  'REVIEW WORK': (n, x) => ['Read', 'Grep', 'Glob'].includes(n) || REVIEW_RE.test(x),
};
export const ORDER_FORWARD = ['LANE NOTE', 'DM', 'SENDMESSAGE', 'MILESTONE LOG', 'RUNBOOK', 'JOURNAL', 'SIGNAL BOARD', 'TRACKER', 'HANDOFF', 'BOARD READ', 'REVIEW WORK', 'OTHER'];
// The review verifier's second order: REVIEW WORK wins ties.
export const ORDER_REVIEW_FIRST = ['REVIEW WORK', ...ORDER_FORWARD.filter((c) => c !== 'REVIEW WORK')];

export function callText(name, input) {
  if (name === 'Bash' || name === 'PowerShell') return String(input.command || '').slice(0, 4000);
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(name)) return String(input.file_path || input.notebook_path || '');
  if (name === 'Grep' || name === 'Glob') return [input.path, input.pattern, input.glob].filter(Boolean).join(' ');
  return '';
}

export function classifyCall(name, text, order = ORDER_FORWARD) {
  for (const c of order) if (c === 'OTHER' || CLASS_TESTS[c](name, text)) return c;
  return 'OTHER';
}
const isBookkeeping = (c) => c !== 'REVIEW WORK' && c !== 'OTHER';

function isWriteCall(name, input) {
  if (WRITE_TOOLS.has(name) || /notion.*(?:create|update)/i.test(name)) return true;
  if (name === 'Artifact') return isPublishCall(input);
  if (name !== 'Bash' && name !== 'PowerShell') return false;
  const cmd = String(input.command || '').slice(0, 4000);
  return LANE_WRITE_RE.test(cmd) || WRITE_CMD_RE.test(cmd);
}

// Artifact publishes carry action 'publish' OR no action key with a file, label, url or asset.
function isPublishCall(input) {
  const action = typeof input.action === 'string' ? input.action.toLowerCase() : null;
  if (action) return action === 'publish';
  return Boolean(input.file_path || input.label || input.url || input.asset);
}

// ---- entry helpers --------------------------------------------------------
function resultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  return asArray(c).map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
}

function isHumanPrompt(e) {
  if (e.isMeta || (e.origin && e.origin.kind !== 'human') || e.scheduledTaskId || e.toolUseResult || e.sourceToolUseID || e.isCompactSummary) return false;
  const c = e.message && e.message.content;
  if (typeof c === 'string') return c.trim().length > 0 && !c.startsWith('<');
  if (!Array.isArray(c) || c.some((b) => b && b.type === 'tool_result')) return false;
  return c.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !b.text.startsWith('<'));
}

const ctxOf = (u) => num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
const LANE_BANNER_RE = /lane update\(s\) since you last looked/;
// The SessionStart lane board is a different surface: its cuts are counted in their own field.
const BOARD_RE = /^## Lane board /m;
const STUB_TAG = '<persisted-output>';
// A stub is a string that STARTS with the tag. A note that quotes the tag is not a stub.
const isStub = (s) => s.trimStart().startsWith(STUB_TAG);

function ruleFileName(head) {
  for (const m of head.matchAll(/([A-Za-z0-9_-]+\.md)\b/g)) if (/^[a-z0-9][a-z0-9-]*\.md$/.test(m[1])) return m[1];
  return null;
}

// Lane DM sends inside one shell command: every `say` that follows lane.mjs or a $variable.
const SAY_RE = new RegExp(`${LANE_VERB}say\\s+`, 'g');
const MASK = '\u0002';

// The escape characters inside "...": PowerShell has the backtick only (a backslash is plain text).
// Any other shell keeps both, as before.
const escapesOf = (shell) => (shell === 'PowerShell' ? '`' : '\\`');

// The first ; | & or line break that is outside quotes ends one shell command.
function cutCommand(s, shell) {
  const esc = escapesOf(shell);
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && esc.includes(c)) i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') return s.slice(0, i);
  }
  return s;
}

// Same length as the input; every quoted span (quotes included) becomes MASK characters.
function maskQuoted(s, shell) {
  const esc = escapesOf(shell);
  let q = null;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += MASK;
      if (q === '"' && esc.includes(c) && i + 1 < s.length) { out += MASK; i++; } else if (c === q) q = null;
    } else if (c === '"' || c === "'") { q = c; out += MASK; } else out += c;
  }
  return out;
}

// shell is the tool name (Bash or PowerShell): it sets which character escapes a quote.
export function parseLaneSays(cmd, shell) {
  const hits = [...String(cmd).matchAll(SAY_RE)];
  return hits.map((m, i) => {
    const start = m.index + m[0].length;
    const seg = cutCommand(String(cmd).slice(start, i + 1 < hits.length ? hits[i + 1].index : undefined), shell);
    // lane.mjs usage is say "message" [--to <name>]: --to may come before or after the message.
    // The search runs on a copy with the quoted spans masked: a --to inside the message is text.
    const to = /(?:^|\s)--to[ =]\s*(\S+)/.exec(maskQuoted(seg, shell));
    const tokStart = to ? to.index + to[0].length - to[1].length : 0;
    const tok = to ? seg.slice(tokStart, tokStart + to[1].length).replace(/^['"]|['"]$/g, '').trim().split(/\s+/)[0] : '';
    const key = tok && !tok.startsWith('$') ? tok.toLowerCase() : null;
    const hex = key && /^[0-9a-f]{8,}$/.test(key) ? key.slice(0, 8) : null;
    const text = to ? `${seg.slice(0, to.index)} ${seg.slice(to.index + to[0].length)}` : seg;
    // No whole-command fallback: a text that is only a shell variable has no probe and stays untestable.
    return { toHex: hex, toName: key && !hex ? key : null, directed: Boolean(to), probes: sendProbes(text) };
  });
}

// ---- ingestion ------------------------------------------------------------
function newFacts(id) {
  return {
    id, id8: null, lines: 0, badLines: 0, noTime: 0, sidechain: 0, firstT: null, lastT: null,
    flips: [], activity: [], requests: 0, cacheReadTotal: 0, maxCtx: 0, compactions: [],
    asks: [], askCalls: 0, askUnpaired: 0, humanPrompts: 0,
    sends: [], arrivals: [], banners: [], stubs: { rule: 0, other: 0 }, nameToId8: new Map(), smCalls: 0, smNotSuccess: 0, smToAgents: 0,
    hook: { blocks: 0, bytes: 0, repeatBlocks: 0, repeatBytes: 0, ruleBlocks: 0, ruleRepeats: 0, ruleFiles: new Map(), seen: new Set(), ruleSeen: new Set() },
    checks: [], calls: 0, bkForward: 0, bkReviewFirst: 0, publishDays: {}, publishes: 0, results429: 0,
    unparsed: new Array(11).fill(0),
    turnDurations: 0, boards: { total: 0, cut: 0 },
  };
}

class Ingestor {
  constructor(opts) {
    this.since = Number.isFinite(opts.since) ? opts.since : -Infinity;
    this.until = Number.isFinite(opts.until) ? opts.until : Infinity;
    this.ext = this.until + TWO_H;
    this.pending = new Map();
    this.reqSeen = new Set();
    this.seg = null;
    this.f = newFacts(opts.id || null);
  }

  feed(e) {
    const f = this.f;
    f.lines++;
    if (!e || typeof e !== 'object') { f.badLines++; return; }
    if (e.isSidechain === true) { f.sidechain++; return; }
    if (!f.id && typeof e.sessionId === 'string') f.id = e.sessionId;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) { f.noTime++; return; }
    if (t < this.since || t > this.ext) return;
    const inWin = t <= this.until;
    if (inWin) {
      f.firstT = f.firstT === null ? t : Math.min(f.firstT, t);
      f.lastT = f.lastT === null ? t : Math.max(f.lastT, t);
    }
    if (e.type === 'assistant') this.onAssistant(e, t, inWin);
    else if (e.type === 'user') this.onUser(e, t, inWin);
    else if (e.type === 'attachment') this.onAttachment(e, t, inWin);
    else if (e.type === 'system') this.onSystem(e, t, inWin);
  }

  touch(t) {
    const a = this.f.activity;
    if (!a.length || t < a[a.length - 1] || t - a[a.length - 1] >= 1000) a.push(t);
  }

  flip(t, state) {
    const fl = this.f.flips;
    const last = fl[fl.length - 1];
    if (!last || last[1] !== state) fl.push([last ? Math.max(t, last[0]) : t, state]);
  }

  onAssistant(e, t, inWin) {
    this.touch(t);
    this.flip(t, 'a');
    if (inWin) this.countRequest(e);
    const c = e.message && e.message.content;
    for (const b of asArray(c)) if (b && b.type === 'tool_use') this.onToolUse(b, t, inWin);
  }

  // One request is many assistant entries with the same requestId: count it once.
  countRequest(e) {
    const f = this.f;
    const m = e.message || {};
    const key = e.requestId || m.id;
    if (key) {
      if (this.reqSeen.has(key)) return;
      this.reqSeen.add(key);
    } else f.unparsed[10]++;
    f.requests++;
    const u = m.usage;
    if (!u || typeof u !== 'object') return;
    const cr = num(u.cache_read_input_tokens);
    f.cacheReadTotal += cr;
    f.maxCtx = Math.max(f.maxCtx, ctxOf(u), ...asArray(u.iterations).map((it) => (it ? ctxOf(it) : 0)));
    if (this.seg) { this.seg.requests++; this.seg.cacheRead += cr; }
  }

  onToolUse(b, t, inWin) {
    const f = this.f;
    const name = String(b.name || '');
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    if (this.seg && isWriteCall(name, input)) this.seg.writes++;
    if (!inWin) return;
    const text = callText(name, input);
    f.calls++;
    if (isBookkeeping(classifyCall(name, text, ORDER_FORWARD))) f.bkForward++;
    if (isBookkeeping(classifyCall(name, text, ORDER_REVIEW_FIRST))) f.bkReviewFirst++;
    if (name === 'SendMessage') this.addSendMessage(b, t, input);
    else if (name === 'Bash' || name === 'PowerShell') this.addLaneSays(b, t, input);
    else if (name === 'AskUserQuestion') { f.askCalls++; this.pending.set(b.id, { k: 'ask', t }); }
    else if (name === 'Artifact' && isPublishCall(input)) {
      const day = chicagoDay(t);
      f.publishDays[day] = (f.publishDays[day] || 0) + 1;
      f.publishes++;
    }
  }

  addSendMessage(b, t, input) {
    const f = this.f;
    // A send to a subagent has no session receiver and no msg_id: it cannot be matched. Count it apart.
    if (input.recipient_kind === 'agent') { f.smToAgents++; return; }
    const msg = typeof input.message === 'string' ? input.message : typeof input.content === 'string' ? input.content : null;
    if (msg === null) f.unparsed[2]++;
    const s = { channel: 'sendmessage', t, toName: String(input.to || '').toLowerCase(), toHex: null, probes: msg === null ? [] : sendProbes(msg), msgId: null, ok: null };
    f.sends.push(s);
    f.smCalls++;
    this.pending.set(b.id, { k: 'sm', s });
  }

  addLaneSays(b, t, input) {
    const sends = parseLaneSays(input.command || '', b.name).map((p) => ({ channel: 'lane', t, toName: p.toName, toHex: p.toHex, directed: p.directed, probes: p.probes, msgId: null, ok: true }));
    if (!sends.length) return;
    this.f.sends.push(...sends);
    this.pending.set(b.id, { k: 'lane', sends });
  }

  onUser(e, t, inWin) {
    const f = this.f;
    this.touch(t);
    this.flip(t, 'a');
    const c = e.message && e.message.content;
    const blocks = asArray(c).filter((b) => b && b.type === 'tool_result');
    if (e.origin && e.origin.kind === 'peer') this.addPeerArrival(t, e.origin, typeof c === 'string' ? c : '');
    if (!blocks.length) {
      this.closeSeg();
      if (inWin && this.isCheckFire(e, c)) this.seg = { t, requests: 0, cacheRead: 0, writes: 0 };
    }
    for (const b of blocks) this.onResult(b, e, t, inWin);
    if (inWin && isHumanPrompt(e)) f.humanPrompts++;
  }

  isCheckFire(e, c) {
    if (!e.scheduledTaskId && e.wakeupSource !== 'schedule_wakeup') return false;
    const head = typeof c === 'string' ? c : asArray(c).map((x) => (x && x.text) || '').join(' ');
    return /check/i.test(head.slice(0, 120));
  }

  onResult(b, e, t, inWin) {
    const f = this.f;
    if (b.is_error === true && inWin) {
      const text = resultText(b);
      const head = text.slice(0, 200);
      if (/^\s*publish 429/i.test(head)) f.results429++;
      if (/^PreToolUse:\S+ hook error: \[rule-router\]/.test(head)) this.addHookBlock(text, true);
    }
    const p = this.pending.get(b.tool_use_id);
    if (!p) return;
    this.pending.delete(b.tool_use_id);
    if (p.k === 'ask') f.asks.push([p.t, t]);
    else if (p.k === 'sm') this.resolveSendMessage(p.s, b, e);
    else this.resolveLane(p, b, e);
  }

  resolveSendMessage(s, b, e) {
    const tur = e.toolUseResult;
    if (b.is_error || !tur || typeof tur !== 'object' || tur.success === false) {
      s.ok = false;
      this.f.smNotSuccess++;
    } else if (tur.success === true) {
      s.ok = true;
      if (typeof tur.msg_id === 'string') s.msgId = tur.msg_id;
    } else this.f.unparsed[3]++;
  }

  // The say result lists "sent to <name> #<sid8>" per receiver: it resolves the receiver.
  resolveLane(p, b, e) {
    const f = this.f;
    const tur = e.toolUseResult;
    const out = tur && typeof tur === 'object' && typeof tur.stdout === 'string' ? tur.stdout : resultText(b);
    const hits = [...out.matchAll(/sent to ([^#\n]*?)\s*#([0-9a-f]{8})\b/g)];
    for (const h of hits) this.mapName(h[1], h[2]);
    if (!hits.length) {
      if (b.is_error || e.toolDenialKind) for (const s of p.sends) s.ok = false;
      return;
    }
    // A directed send claims the result line of its own receiver. A broadcast never shifts a directed send.
    const taken = new Set();
    const nameOf = (h) => h[1].trim().toLowerCase();
    const owns = (s, h) => (s.toHex && h[2].startsWith(s.toHex)) || (s.toName && (nameOf(h) === s.toName || nameOf(h).split(/\s+/).pop() === s.toName));
    for (const s of p.sends) {
      if (!s.toHex && !s.toName) continue;
      const i = hits.findIndex((h, k) => !taken.has(k) && owns(s, h));
      if (i >= 0) { taken.add(i); s.toHex = hits[i][2]; }
    }
    // lane.mjs prints "sent to board <key>" for a broadcast, with no #sid8: a send with no --to
    // never takes a line. Only a directed send with no receiver yet takes a leftover line.
    const open = p.sends.filter((s) => s.directed && !s.toHex);
    hits.filter((h, k) => !taken.has(k)).forEach((h, i) => {
      let s = open[i];
      if (!s) { if (!open[0]) return; s = { ...open[0] }; f.sends.push(s); }
      s.toHex = h[2];
    });
  }

  // The words before the #id are the receiver name; the last word is the short name.
  mapName(words, id8) {
    const w = words.trim().toLowerCase();
    if (!w) return;
    this.f.nameToId8.set(w, id8);
    this.f.nameToId8.set(w.split(/\s+/).pop(), id8);
  }

  addPeerArrival(t, origin, text) {
    const body = typeof origin.body === 'string' ? origin.body : text;
    this.f.arrivals.push({ kind: 'peer', t, msgId: typeof origin.msg_id === 'string' ? origin.msg_id : null, keys: arrivalWindows(body) });
  }

  onAttachment(e, t, inWin) {
    const a = e.attachment;
    if (!a || typeof a !== 'object') return;
    if (a.type === 'hook_additional_context') {
      const list = typeof a.content === 'string' ? [a.content] : asArray(a.content);
      for (const s of list) if (typeof s === 'string') this.onHookString(s, t, inWin);
    } else if (a.type === 'queued_command' && a.origin && a.origin.kind === 'peer') {
      this.addPeerArrival(t, a.origin, typeof a.prompt === 'string' ? a.prompt : '');
    }
  }

  onHookString(s, t, inWin) {
    const f = this.f;
    const stub = isStub(s);
    const head = s.slice(0, 1200);
    if (LANE_BANNER_RE.test(head)) f.banners.push({ t, cut: stub, inWin });
    else if (BOARD_RE.test(head)) {
      if (inWin) { f.boards.total++; if (stub) f.boards.cut++; }
    } else if (stub) f.stubs[/\[rule-router\]/.test(head) ? 'rule' : 'other']++;
    // The hook cuts a long DM body that does not fit and ends it with a marker (lane-context.ts cutMarker).
    // bodyCut tells analyzeOne that a partial match on this arrival is a cut, not a loss.
    if (/^## Direct message/i.test(s) || /direct to you/i.test(s)) f.arrivals.push({ kind: 'lane', t, keys: arrivalWindows(s), bodyCut: /\[cut, \d+ more bytes/.test(s) });
    if (inWin) this.addHookBlock(s, false);
  }

  addHookBlock(s, fromResult) {
    const h = this.f.hook;
    const bytes = Buffer.byteLength(s);
    h.blocks++;
    h.bytes += bytes;
    const key = sha1Hex(s); // FULL string, not a prefix
    if (h.seen.has(key)) { h.repeatBlocks++; h.repeatBytes += bytes; } else h.seen.add(key);
    const head = s.slice(0, 800);
    const isRule = fromResult || /^\s*\[rule-router\]/.test(s) || (isStub(s) && /\[rule-router\]/.test(head));
    if (!isRule) return;
    h.ruleBlocks++;
    const name = ruleFileName(head);
    if (!name) { this.f.unparsed[5]++; return; }
    const r = h.ruleFiles.get(name) || { blocks: 0, repeats: 0 };
    r.blocks++;
    if (h.ruleSeen.has(name)) { r.repeats++; h.ruleRepeats++; } else h.ruleSeen.add(name);
    h.ruleFiles.set(name, r);
  }

  onSystem(e, t, inWin) {
    const f = this.f;
    if (e.subtype === 'compact_boundary') {
      if (!inWin) return;
      const p = e.compactMetadata && e.compactMetadata.preTokens;
      if (Number.isFinite(p)) f.compactions.push(p);
      else f.unparsed[10]++;
    } else if (e.subtype === 'turn_duration') {
      // The only source of the idle state. A session with none has an unproven idle split (see stateAt).
      f.turnDurations++;
      this.flip(t, 'e');
      this.closeSeg();
    }
  }

  closeSeg() {
    if (this.seg) this.f.checks.push(this.seg);
    this.seg = null;
  }

  finish() {
    const f = this.f;
    this.closeSeg();
    for (const p of this.pending.values()) if (p.k === 'ask') f.askUnpaired++;
    f.activity.sort((a, b) => a - b);
    f.banners.sort((a, b) => a.t - b.t);
    f.id = f.id || 'unknown';
    f.id8 = f.id.slice(0, 8);
    return f;
  }
}

export function createIngestor(opts = {}) {
  return new Ingestor(opts);
}

// Test helper and library entry: facts from an array of entry objects.
export function ingestEntries(entries, opts = {}) {
  const ing = new Ingestor(opts);
  for (const e of entries) ing.feed(e);
  return ing.finish();
}

// Streams a JSONL file line by line. A line that does not parse is counted and skipped.
// The parse error text is never kept: it can quote the input.
export async function ingestFile(file, opts = {}) {
  // The id is the sessionId inside the entries. The file name is not proven to be a session id.
  const ing = new Ingestor({ ...opts, id: null });
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { ing.f.lines++; ing.f.badLines++; continue; }
    ing.feed(e);
  }
  return ing.finish();
}

// ---- lane_event rows (ground truth from a scratch board) ------------------
class CliError extends Error {}

// The file is a JSON array of rows, or an object with a rows array. Any other shape is a fault:
// an empty events list would make collectSends drop every transcript lane send.
export function loadEvents(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object' && Array.isArray(j.rows)) return j.rows;
  throw new CliError('The events file is not a JSON array or an object with a rows array.');
}

// A lane DM is a kind 'note' row with a to_session_id. The body is hashed, never kept.
// Returns the sends and the row counts: rows = DM rows seen, unparsed = rows whose time did not parse.
export function eventSendsDetailed(rows, opts = {}) {
  const lo = Number.isFinite(opts.since) ? opts.since : -Infinity;
  const hi = Number.isFinite(opts.until) ? opts.until : Infinity;
  const sends = [];
  let count = 0;
  let unparsed = 0;
  for (const r of asArray(rows)) {
    // snake_case (the table) and camelCase (an API export) are both accepted.
    const to = r && (r.to_session_id || r.toSessionId);
    if (!r || r.kind !== 'note' || !to) continue;
    const from = String(r.session_id || r.sessionId || '');
    if (from.toLowerCase() === String(to).toLowerCase()) continue; // a self note is not a DM
    count++;
    const t = Date.parse(r.occurred_at || r.occurredAt);
    if (!Number.isFinite(t)) { unparsed++; continue; }
    if (t < lo || t > hi) continue;
    const toHex = String(to).slice(0, 8).toLowerCase();
    sends.push({ channel: 'lane', t, toName: null, toHex, probes: sendProbes(String(r.body || '')), msgId: null, ok: true, fromId8: from.slice(0, 8).toLowerCase() });
  }
  return { sends, rows: count, unparsed };
}

export const eventSends = (rows, opts = {}) => eventSendsDetailed(rows, opts).sends;

// ---- directed message analysis (metrics 1 to 4) ---------------------------
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// Idle is known only from system/turn_duration entries (the only source of the idle flip).
// A session with none gives 'unproven': busy would be a guess, not a measurement.
function stateAt(f, t) {
  if (!f.turnDurations) return 'unproven';
  let state = null;
  for (let lo = 0, hi = f.flips.length - 1; lo <= hi;) {
    const m = (lo + hi) >> 1;
    if (f.flips[m][0] <= t) { state = f.flips[m][1]; lo = m + 1; } else hi = m - 1;
  }
  return state === 'e' ? 'idle' : state === 'a' ? 'busy' : 'unknown';
}

const activeWithin2h = (f, t) => {
  const i = lowerBound(f.activity, t + 1);
  return i < f.activity.length && f.activity[i] <= t + TWO_H;
};
const nextBanner = (f, t) => f.banners.find((b) => b.t >= t && b.t - t <= TWO_H) || null;

function collectSends(list, opts) {
  const out = [];
  const byEvents = Array.isArray(opts.eventSends);
  for (const f of list) for (const s of f.sends) if (!(byEvents && s.channel === 'lane')) out.push({ s, f });
  if (byEvents) for (const s of opts.eventSends) out.push({ s, f: list.find((f) => s.fromId8 && f.id.toLowerCase().startsWith(s.fromId8)) || null });
  return out.sort((x, y) => x.s.t - y.s.t);
}

// A lane arrival (one banner, one "## Direct messages" block) holds many DMs, so it can match
// many sends. A peer arrival is one message: it matches one send.
function findArrival(s, sender, hex, ctx) {
  if (s.msgId && ctx.peerByMsg.has(s.msgId)) return ctx.peerByMsg.get(s.msgId);
  if (!s.probes.length) return null;
  const kind = s.channel === 'lane' ? 'lane' : 'peer';
  for (const r of ctx.refs) {
    if (r.used || r.a.kind !== kind || r.f === sender || r.a.t < s.t - 5000) continue;
    if (hex && !r.f.id.toLowerCase().startsWith(hex)) continue;
    const hit = s.probes.filter((k) => hasKey(r.a.keys, k)).length;
    // A lane arrival holds many DMs, and DMs share template text: one shared window is not a match.
    // At least half of the probes must hit. A peer arrival is one message: one hit is enough.
    if (kind === 'lane' ? hit * 2 >= s.probes.length : hit > 0) return r;
  }
  return null;
}

// A lane DM whose body the hook cut: under half of the probes hit, but at least one hits on an
// arrival to the receiver that carries the cut marker. The DM was delivered in part: a cut, not a loss.
// The cut marker on the arrival is what allows a single hit here; without it one hit is not a match.
function findCutArrival(s, sender, hex, ctx) {
  if (s.channel !== 'lane' || !s.probes.length) return null;
  for (const r of ctx.refs) {
    if (r.a.kind !== 'lane' || !r.a.bodyCut || r.f === sender || r.a.t < s.t - 5000) continue;
    if (hex && !r.f.id.toLowerCase().startsWith(hex)) continue;
    if (s.probes.some((k) => hasKey(r.a.keys, k))) return r;
  }
  return null;
}

function analyzeOne({ s, f }, ctx) {
  const rec = { channel: s.channel, status: null, latencyMs: null, state: 'unknown', senderId8: f ? f.id8 : s.fromId8 || null };
  if (s.ok === false) return { ...rec, status: 'failed' };
  const hex = s.toHex || (s.toName && ctx.names.get(s.toName)) || null;
  // A send with --to whose receiver never resolved is not a broadcast: it counts as receiver_unknown.
  if (s.channel === 'lane' && !hex) return { ...rec, status: s.directed ? 'receiver_unknown' : 'undirected' };
  const rf = hex ? ctx.list.find((x) => x.id.toLowerCase().startsWith(hex)) || null : null;
  const ref = findArrival(s, f, hex, ctx);
  if (ref) {
    if (ref.a.kind === 'peer') ref.used = true; // a lane arrival stays open for the other DMs in it
    return { ...rec, status: 'matched', latencyMs: Math.max(0, ref.a.t - s.t), state: stateAt(ref.f, s.t) };
  }
  if (!s.probes.length && !s.msgId) return { ...rec, status: 'untestable' };
  if (!rf) return { ...rec, status: 'receiver_unknown' };
  const state = stateAt(rf, s.t);
  if (findCutArrival(s, f, hex, ctx)) return { ...rec, status: 'cut', state };
  const nb = nextBanner(rf, s.t);
  if (nb && nb.cut) return { ...rec, status: 'cut', state };
  return { ...rec, status: activeWithin2h(rf, s.t) ? 'lost' : 'receiver_inactive', state };
}

export function analyzeDirected(list, opts = {}) {
  const names = new Map();
  for (const f of list) for (const [k, v] of f.nameToId8) names.set(k, v);
  const refs = [];
  for (const f of list) for (const a of f.arrivals) refs.push({ a, f, used: false });
  refs.sort((x, y) => x.a.t - y.a.t);
  const peerByMsg = new Map();
  for (const r of refs) if (r.a.kind === 'peer' && r.a.msgId && !peerByMsg.has(r.a.msgId)) peerByMsg.set(r.a.msgId, r);
  const ctx = { list, names, refs, peerByMsg };
  return { records: collectSends(list, opts).map((x) => analyzeOne(x, ctx)), names };
}

// ---- metric builders ------------------------------------------------------
const DEFS = {
  1: { name: 'Lane DMs cut by the hook cap', target: '0 cut banners, 0 DMs behind a cut', method: 'Count lane banners that hold a persisted-output stub, and unmatched lane DMs whose receiver has a cut banner next within 2 h.' },
  2: { name: 'Directed-message delivery p50 and p90', target: 'p90 under 30 s for every directed message', method: 'Send time from the tool_use or lane_event row; arrival by msg_id (SendMessage) or 20-character sha1 windows; split by channel and receiver idle or busy at send.' },
  3: { name: 'Unexplained message loss', target: 'under 0.5 percent per channel; every not-success retried by the fallback', method: 'Sends with no arrival, no cut banner next and a receiver active within 2 h, per channel; SendMessage results that are not success.' },
  4: { name: 'Double-send rate', target: 'under 10 percent', method: 'Seat SendMessage calls with a lane DM to the same receiver within 120 s, divided by seat SendMessage calls.' },
  5: { name: 'Injected hook bytes per request and exact-repeat share', target: 'under 350 B per request; repeats under 5 percent; rule-router file repeats under 20 percent', method: 'Sum of hook_additional_context strings and rule-router block results over distinct requestIds; repeats by full-string sha1 within a session.' },
  6: { name: 'Idle seat-check cost', target: 'under 15 idle checks and under 7 percent of seat cache read per 3 days', method: 'Cron-fired check prompts with no write action before the next turn end or prompt; their distinct requests and cache-read tokens.' },
  7: { name: 'Operator wait tail', target: 'under 15 waits over 300 s; under 6 h open; taps per landed PR under 2', method: 'AskUserQuestion tool_use paired with its tool_result by tool_use_id; wall-clock union of open questions.' },
  8: { name: 'Seat bookkeeping share', target: 'under 35 percent', method: 'Fixed first-match classifier over seat tool calls, reported for the forward order and the REVIEW-WORK-first order.' },
  9: { name: 'Publish budget use', target: 'under 100 per day and 0 results of 429', method: 'Artifact publish calls per America/Chicago day and tool results that start with publish 429.' },
  10: { name: 'Context at compaction', target: 'mean under 300k; max under 500k', method: 'compact_boundary preTokens (count, mean, max) and the largest single-request context from usage.' },
};

const sumUnparsed = (list, id) => sum(list.map((f) => f.unparsed[id]));
function mk(id, list, value, n, meets, caveats) {
  const d = DEFS[id];
  return { id, name: d.name, value, n, target: d.target, meets, method: d.method, caveats, unparsed: sumUnparsed(list, id) };
}
const allOf = (flags) => (flags.length === 0 ? null : flags.every(Boolean));
const seatFacts = (list, opts) => (opts.seat ? list.filter((f) => f.id.toLowerCase().startsWith(String(opts.seat).toLowerCase())) : []);

export function metric1(list, opts = {}, an = analyzeDirected(list, opts)) {
  // Only banners inside the window count; the 2-hour tail after --until serves the cut lookup of a DM only.
  const banners = list.flatMap((f) => f.banners).filter((b) => b.inWin);
  const cut = banners.filter((b) => b.cut).length;
  const behind = an.records.filter((r) => r.channel === 'lane' && r.status === 'cut').length;
  const caveats = ['The DMs past a cut cannot be read from the stub; the count of DMs behind a cut needs the receiver transcripts and the sends in the same input.'];
  caveats.push('A cut SessionStart lane board is counted in cutSessionStartBoards and is not judged here.');
  if (!banners.length) caveats.push('No lane banner was seen in the input.');
  return mk(1, list, { totalBanners: banners.length, cutBanners: cut, dmsBehindCut: behind, sessionStartBoards: sum(list.map((f) => f.boards.total)), cutSessionStartBoards: sum(list.map((f) => f.boards.cut)), cutRuleRouterStubs: sum(list.map((f) => f.stubs.rule)), otherStubs: sum(list.map((f) => f.stubs.other)) },
    banners.length, banners.length ? cut === 0 && behind === 0 : null, caveats);
}

// A send with no arrival, to a receiver that was or could have been reached, is a wait with no end.
const UNMATCHED = new Set(['lost', 'cut', 'receiver_inactive']);

// Nearest-rank p90 of the matched waits with one infinite wait per unmatched send.
// Returns Infinity when the rank falls on an unmatched send.
function p90WithUnmatched(secs, unmatched) {
  const total = secs.length + unmatched;
  if (!total) return null;
  const rank = Math.min(total, Math.max(1, Math.ceil(0.9 * total)));
  if (rank > secs.length) return Infinity;
  return [...secs].sort((a, b) => a - b)[rank - 1];
}

export function metric2(list, opts = {}, an = analyzeDirected(list, opts)) {
  const value = {};
  const flags = [];
  let receiverUnknown = 0;
  let notMeasured = 0;
  for (const ch of ['lane', 'sendmessage']) {
    const mine = an.records.filter((r) => r.channel === ch);
    const recs = mine.filter((r) => r.status === 'matched');
    const unmatched = mine.filter((r) => UNMATCHED.has(r.status)).length;
    receiverUnknown += mine.filter((r) => r.status === 'receiver_unknown').length;
    // A failed send (success false) or an untestable send (no probe, no msg_id) was never measured.
    notMeasured += mine.filter((r) => r.status === 'failed' || r.status === 'untestable').length;
    const block = (rs) => {
      const sec = rs.map((r) => r.latencyMs / 1000);
      return { uncapped: dist(sec), capped2h: dist(sec.filter((x) => x <= 7200)) };
    };
    value[ch] = { all: block(recs) };
    for (const st of ['idle', 'busy', 'unknown', 'unproven']) value[ch][st] = block(recs.filter((r) => r.state === st));
    // No turn_duration entry in the receiver: the idle and busy split would be a guess.
    if (value[ch].unproven.uncapped.n) { value[ch].idle = 'unproven'; value[ch].busy = 'unproven'; }
    const p90 = p90WithUnmatched(recs.map((r) => r.latencyMs / 1000), unmatched);
    value[ch].unmatchedEvaluable = unmatched;
    value[ch].p90WithUnmatched = p90 === Infinity ? 'infinite' : round(p90, 1);
    if (p90 !== null) flags.push(p90 < 30);
  }
  value.laneUndirected = an.records.filter((r) => r.channel === 'lane' && r.status === 'undirected').length;
  value.receiverUnknown = receiverUnknown;
  value.notMeasured = notMeasured;
  const n = sum(['lane', 'sendmessage'].map((c) => value[c].all.uncapped.n));
  const caveats = ['Needs the receiver transcripts next to the sender transcripts; meets uses, per channel, the p90 of the matched waits plus one infinite wait for each send with no arrival (lost, cut, receiver inactive).',
    'A lane DM read by an explicit inbox command (not a hook) shows as no arrival.',
    'The idle and busy split needs system/turn_duration entries in the receiver transcript; with none it is reported as unproven.'];
  if (!n) caveats.push('No sent text was matched to an arrival in the input.');
  let meets = allOf(flags);
  if (meets === true && receiverUnknown > 0) {
    meets = null;
    caveats.push('A pass is withheld: some sends have a receiver that could not be resolved (receiverUnknown).');
  }
  if (meets === true && notMeasured > 0) {
    meets = null;
    caveats.push('A pass is withheld: some directed sends failed or could not be tested (notMeasured), so the target "every directed message" is not measured.');
  }
  return mk(2, list, value, n, meets, caveats);
}

export function metric3(list, opts = {}, an = analyzeDirected(list, opts)) {
  const value = {};
  const rates = [];
  for (const ch of ['lane', 'sendmessage']) {
    const c = (st) => an.records.filter((r) => r.channel === ch && r.status === st).length;
    const evaluable = c('matched') + c('lost') + c('cut') + c('receiver_inactive');
    value[ch] = { evaluable, matched: c('matched'), cutExplained: c('cut'), receiverInactive: c('receiver_inactive'), receiverUnknown: c('receiver_unknown'),
      untestable: c('untestable'), undirected: c('undirected'), failed: c('failed'), unexplainedLoss: c('lost'), rate: evaluable ? round(c('lost') / evaluable, 4) : null };
    if (evaluable) rates.push(value[ch].rate < 0.005);
  }
  value.sendMessageNotSuccess = sum(list.map((f) => f.smNotSuccess));
  // SendMessage calls to a subagent (recipient_kind agent) have no session receiver: not judged here.
  value.sendMessageToAgents = sum(list.map((f) => f.smToAgents));
  const verdict = allOf(rates);
  const caveats = ['Whether every not-success was retried by the fallback is not computed; a pass on the rate alone is reported as null when a not-success exists.'];
  // With an unresolved receiver the rate has a hole: it may hide a loss. The verdict is null then.
  const unknown = sum(['lane', 'sendmessage'].map((c) => value[c].receiverUnknown));
  if (unknown > 0) caveats.push('Some sends have a receiver that could not be resolved (receiverUnknown): meets is null; read the counts in value.');
  // A failed or untestable send was never measured: a rate over the other sends is not a pass for "every" send.
  const notMeasured = sum(['lane', 'sendmessage'].map((c) => value[c].untestable + value[c].failed));
  if (notMeasured > 0) caveats.push('Some sends failed or could not be tested (untestable, failed): a pass is withheld; read the counts in value.');
  const meets = unknown > 0 ? null : verdict === true && (value.sendMessageNotSuccess > 0 || notMeasured > 0) ? null : verdict;
  return mk(3, list, value, sum(['lane', 'sendmessage'].map((c) => value[c].evaluable)), meets, caveats);
}

export function metric4(list, opts = {}, an = analyzeDirected(list, opts)) {
  const seats = seatFacts(list, opts);
  const caveats = ['Receivers are joined by the name and id pairs in the say results; an unresolved receiver is never a double send.'];
  if (!seats.length) return mk(4, list, null, 0, null, [...caveats, 'No --seat session in the input.']);
  const canon = (k) => an.names.get(k) ?? k;
  let calls = 0;
  let hits = 0;
  for (const f of seats) {
    const lane = f.sends.filter((s) => s.channel === 'lane' && (s.toHex || s.toName)).map((s) => ({ t: s.t, k: s.toHex || canon(s.toName) }));
    for (const s of f.sends.filter((x) => x.channel === 'sendmessage')) {
      calls++;
      const k = canon(s.toName);
      if (lane.some((l) => l.k === k && Math.abs(l.t - s.t) <= 120000)) hits++;
    }
  }
  const rate = calls ? round(hits / calls, 4) : null;
  return mk(4, list, { doubleSent: hits, smCalls: calls, rate }, calls, calls ? rate < 0.1 : null, caveats);
}

// The rule file names of rules-ondemand/manifest.json (read only, read once). A missing or bad
// manifest gives an empty set: every name then shows as other-<n>.
let manifestNames = null;
export function manifestRuleFiles() {
  if (manifestNames) return manifestNames;
  manifestNames = new Set();
  try {
    const file = path.resolve(path.dirname(SELF), '..', '..', '..', '.claude', 'rules-ondemand', 'manifest.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of asArray(j && j.rules)) for (const n of asArray(r && r.files)) if (typeof n === 'string') manifestNames.add(n);
  } catch { /* an unreadable manifest leaves the set empty */ }
  return manifestNames;
}

export function metric5(list, opts = {}) {
  const requests = sum(list.map((f) => f.requests));
  const h = (k) => sum(list.map((f) => f.hook[k]));
  const byFile = new Map();
  for (const f of list) for (const [k, v] of f.hook.ruleFiles) {
    const r = byFile.get(k) || { blocks: 0, repeats: 0 };
    r.blocks += v.blocks; r.repeats += v.repeats; byFile.set(k, r);
  }
  // A rule file name comes from transcript text. The report shows a name only when it is in the
  // rules-ondemand manifest (a fixed list); any other name is shown as other-<n>.
  const known = manifestRuleFiles();
  let other = 0;
  const top = Object.fromEntries([...byFile].sort((a, b) => b[1].repeats - a[1].repeats).slice(0, 10).map(([k, v]) => [known.has(k) ? k : `other-${++other}`, v]));
  const bpr = requests ? h('bytes') / requests : null;
  const shareB = h('bytes') ? h('repeatBytes') / h('bytes') : 0;
  const ruleShare = h('ruleBlocks') ? h('ruleRepeats') / h('ruleBlocks') : 0;
  const value = { requests, blocks: h('blocks'), bytes: h('bytes'), bytesPerRequest: round(bpr, 1), repeatBlocks: h('repeatBlocks'), repeatBytes: h('repeatBytes'),
    repeatShareBytes: round(shareB, 4), ruleRouter: { blocks: h('ruleBlocks'), repeats: h('ruleRepeats'), repeatShare: round(ruleShare, 4), byFile: top } };
  const caveats = ['Counts hook_additional_context strings and rule-router block results only; hook_system_message and stop-hook text are not counted.'];
  // No hook block at all can be a schema miss: that is not a pass.
  if (requests && !h('blocks')) caveats.push('No hook block was seen in the input: meets is null (a schema miss would look like a pass).');
  return mk(5, list, value, requests, requests && h('blocks') ? bpr < 350 && shareB < 0.05 && ruleShare < 0.2 : null, caveats);
}

export function metric6(list, opts = {}) {
  const seats = seatFacts(list, opts);
  const src = opts.seat ? seats : list;
  const caveats = ['A write action is a lane write verb, git commit/push/add, gh pr create/merge, a file write tool, SendMessage, a Notion write or an Artifact publish.'];
  if (!opts.seat) caveats.push('No --seat given: checks of every session in the input are counted.');
  const checks = src.flatMap((f) => f.checks);
  const idle = checks.filter((c) => c.writes === 0);
  const total = sum(src.map((f) => f.cacheReadTotal));
  const days = Number.isFinite(opts.since) && Number.isFinite(opts.until) ? (opts.until - opts.since) / 86400000 : null;
  const idlePer3 = days ? round(idle.length * 3 / days, 1) : idle.length;
  if (!days) caveats.push('No full --since/--until window: the idle count is not scaled to 3 days.');
  const idleCache = sum(idle.map((c) => c.cacheRead));
  const share = total ? idleCache / total : null;
  const value = { checks: checks.length, idleChecks: idle.length, idleRequests: sum(idle.map((c) => c.requests)), idleCacheRead: idleCache, seatCacheReadTotal: total,
    idleShareOfCacheRead: round(share, 4), allChecksShareOfCacheRead: total ? round(sum(checks.map((c) => c.cacheRead)) / total, 4) : null, windowDays: days === null ? null : round(days, 2), idleChecksPer3Days: idlePer3 };
  // A check segment ends at a system/turn_duration entry. A source session with none cannot split idle from busy.
  if (checks.length && src.some((f) => f.checks.length && !f.turnDurations)) {
    for (const k of ['idleChecks', 'idleRequests', 'idleCacheRead', 'idleShareOfCacheRead', 'allChecksShareOfCacheRead', 'idleChecksPer3Days']) value[k] = 'unproven';
    caveats.push('A session with check fires has no system/turn_duration entry: the check segments are unproven, so the idle numbers are not reported.');
    return mk(6, list, value, checks.length, null, caveats);
  }
  // A window under one day scales one idle check to 72 or more per 3 days: judge the cache-read share only.
  const short = days !== null && days < 1;
  if (short) caveats.push('Window under one day: meets judges the idle cache-read share only; idleChecksPer3Days is information.');
  const countOk = short ? true : idlePer3 < 15;
  return mk(6, list, value, checks.length, checks.length && total ? countOk && share < 0.07 : null, caveats);
}

export function metric7(list, opts = {}) {
  const asks = list.flatMap((f) => f.asks);
  const waits = asks.map(([a, b]) => (b - a) / 1000);
  const calls = sum(list.map((f) => f.askCalls));
  const prompts = sum(list.map((f) => f.humanPrompts));
  const union = unionLength(asks) / 1000;
  const value = { questionCalls: calls, paired: asks.length, unpaired: sum(list.map((f) => f.askUnpaired)), humanPrompts: prompts, questionsPerPrompt: prompts ? round(calls / prompts, 2) : null,
    waitsOver300s: waits.filter((w) => w > 300).length, sumWaitSec: round(sum(waits), 1), unionOpenSec: round(union, 1), unionOpenHours: round(union / 3600, 2),
    p50WaitSec: round(percentile(waits, 0.5), 1), p90WaitSec: round(percentile(waits, 0.9), 1), maxWaitSec: waits.length ? round(Math.max(...waits), 1) : null };
  const caveats = ['Taps per landed PR is not computed (needs PR land data): meets is false when the wait count or the open time fails, and null otherwise (never true).',
    'Human prompts exclude meta, peer, scheduled and tag-wrapped user entries; the count is an estimate.'];
  // The third part of the target (taps per landed PR) is not computed, so the parts that are computed
  // can fail the target but cannot pass it: a pass is null.
  const judged = value.waitsOver300s < 15 && union / 3600 < 6;
  return mk(7, list, value, asks.length, asks.length && !judged ? false : null, caveats);
}

export function metric8(list, opts = {}) {
  const seats = seatFacts(list, opts);
  const caveats = ['The class patterns are re-derived from the review notes; the verifier counted bookkeeping as every class except REVIEW WORK and OTHER.'];
  if (!seats.length) return mk(8, list, null, 0, null, [...caveats, 'Needs --seat naming a session in the input.']);
  const calls = sum(seats.map((f) => f.calls));
  const fwd = calls ? sum(seats.map((f) => f.bkForward)) / calls : null;
  const rev = calls ? sum(seats.map((f) => f.bkReviewFirst)) / calls : null;
  if (!calls) return mk(8, list, { calls: 0 }, 0, null, [...caveats, 'No seat tool call in the window.']);
  const lo = Math.min(fwd, rev);
  const hi = Math.max(fwd, rev);
  const meets = hi < 0.35 ? true : lo >= 0.35 ? false : null;
  if (meets === null) caveats.push('The two class orders straddle the 35 percent target.');
  return mk(8, list, { calls, shareForwardOrder: round(fwd), shareReviewFirstOrder: round(rev), range: [round(lo), round(hi)] }, calls, meets, caveats);
}

export function metric9(list, opts = {}) {
  const perDay = {};
  for (const f of list) for (const [d, n] of Object.entries(f.publishDays)) perDay[d] = (perDay[d] || 0) + n;
  const total = sum(Object.values(perDay));
  const r429 = sum(list.map((f) => f.results429));
  const max = total ? Math.max(...Object.values(perDay)) : 0;
  const caveats = ['The per-day count covers the transcripts in the input only; the account limit is shared by every session, so pass all fleet files.'];
  const meets = total === 0 && r429 === 0 ? null : max < 100 && r429 === 0;
  return mk(9, list, { perDay: Object.fromEntries(Object.entries(perDay).sort()), maxPerDay: max, publishes: total, results429: r429 }, total, meets, caveats);
}

export function metric10(list, opts = {}) {
  const pre = list.flatMap((f) => f.compactions);
  const mean = pre.length ? sum(pre) / pre.length : null;
  const max = pre.length ? Math.max(...pre) : null;
  const value = { compactions: pre.length, meanPreTokens: mean === null ? null : Math.round(mean), maxPreTokens: max, maxRequestContext: Math.max(0, ...list.map((f) => f.maxCtx)) };
  const caveats = ['The max single-request context is the largest input + cache read + cache creation of one request or iteration; the max target is judged on it, not on preTokens.'];
  if (!pre.length) caveats.push('No compact_boundary entry in the window: the mean is not judged.');
  const maxCtx = value.maxRequestContext;
  if (!maxCtx) caveats.push('No request with usage in the window: the max is not judged.');
  // Each part is true, false or unknown. One false fails; a pass needs both parts known and true.
  const meanOk = pre.length ? mean < 300000 : null;
  const maxOk = maxCtx ? maxCtx < 500000 : null;
  const meets = meanOk === false || maxOk === false ? false : meanOk === true && maxOk === true ? true : null;
  return mk(10, list, value, pre.length, meets, caveats);
}

export function computeMetrics(list, opts = {}) {
  const an = analyzeDirected(list, opts);
  return [metric1(list, opts, an), metric2(list, opts, an), metric3(list, opts, an), metric4(list, opts, an), metric5(list, opts), metric6(list, opts),
    metric7(list, opts), metric8(list, opts), metric9(list, opts), metric10(list, opts)];
}

// ---- command line ---------------------------------------------------------
const USAGE = `Usage: node metrics.mjs --transcripts <dir or comma list of .jsonl files> [options]
  --transcripts <path,...>  REQUIRED. A folder (its .jsonl files) or a comma list of files. No default.
  --since <ISO>             keep entries at or after this time
  --until <ISO>             keep entries up to this time (arrivals may land up to 2 h later)
  --seat <id prefix>        the seat session (needed by metrics 4 and 8; limits metric 6)
  --events <json file>      lane_event rows exported from a scratch board
  --out <json file>         write the report here; stdout then holds one line per metric
  --help                    this text
Aggregates only: no message text, tool input, file content, env value, address or url is printed.
`;

export function parseArgs(argv) {
  const a = { errors: [] };
  const flags = { '--transcripts': 'transcripts', '--since': 'since', '--until': 'until', '--seat': 'seat', '--events': 'events', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') a.help = true;
    else if (flags[k]) {
      if (i + 1 >= argv.length) a.errors.push(`Option ${k} needs a value.`);
      else a[flags[k]] = argv[++i];
    } else a.errors.push('Unknown option.');
  }
  for (const k of ['since', 'until']) {
    if (a[k] !== undefined && !Number.isFinite(Date.parse(a[k]))) a.errors.push(`--${k} is not an ISO time.`);
  }
  // A short prefix (or the word unknown that a session with no id gets) would match many sessions.
  if (a.seat !== undefined && !/^[0-9a-f]{8}[0-9a-f-]*$/i.test(a.seat)) a.errors.push('--seat must start with 8 hex characters of a session id.');
  // since at or after until gives a window of zero or negative days: metric 6 would count by default.
  if (!a.errors.length && a.since !== undefined && a.until !== undefined && Date.parse(a.since) >= Date.parse(a.until)) a.errors.push('--since must be before --until.');
  return a;
}

export function isProtectedPath(p) {
  return path.resolve(String(p)).replace(/\\/g, '/').toLowerCase().includes(PROTECTED_FRAGMENT);
}

function guard(p) {
  if (isProtectedPath(p)) throw new CliError('Refusing a path under the review-engine state folder.');
}

const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const normPath = (p) => path.resolve(p).toLowerCase();

// The path text and its real path (junctions and links resolved) are both checked.
function guardReal(p) {
  guard(p);
  const r = realOf(p);
  if (r) guard(r);
  return r;
}

function resolveInputs(spec) {
  const files = [];
  for (const item of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    guard(item);
    let st;
    try { st = fs.statSync(item); } catch { throw new CliError('An input path was not found.'); }
    guard(fs.realpathSync.native(item));
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(item).sort()) {
        if (!/\.jsonl$/i.test(n)) continue;
        guardReal(path.join(item, n)); // a link inside the folder can point into the protected folder
        files.push(path.join(item, n));
      }
    } else files.push(item);
  }
  if (!files.length) throw new CliError('No .jsonl file found in the input.');
  return files;
}

// --out may not be an input or events file, may not end in .jsonl, may not exist, may not sit in an
// input folder, and may not sit in or point into the protected folder.
function guardOut(out, inputReals, inputDirs) {
  guard(out);
  const refuse = () => { throw new CliError('Refusing an --out that is an input file or ends in .jsonl.'); };
  if (/\.jsonl$/i.test(out)) refuse();
  const dir = realOf(path.dirname(path.resolve(out)));
  if (!dir) throw new CliError('The --out folder was not found.');
  guard(dir);
  const target = realOf(out) || path.join(dir, path.basename(out));
  guard(target);
  if (/\.jsonl$/i.test(target) || inputReals.has(normPath(target))) refuse();
  if (inputDirs.has(normPath(dir))) throw new CliError('Refusing an --out in an input folder.');
  // The home .claude folder holds rules and settings that every session loads: no new file there.
  const claudeHome = path.join(os.homedir(), '.claude');
  for (const base of [path.resolve(claudeHome), realOf(claudeHome)]) {
    if (!base) continue;
    const b = normPath(base);
    const d = normPath(dir);
    if (d === b || d.startsWith(b + path.sep)) throw new CliError('Refusing an --out under the home .claude folder.');
  }
  let exists = true;
  try { fs.lstatSync(out); } catch { exists = false; }
  if (exists) throw new CliError('Refusing an --out that already exists.');
}

function buildReport(facts, metrics, a, opts) {
  return {
    tool: 'coord-drill-2 metrics', generatedAt: new Date().toISOString(),
    window: { since: a.since || null, until: a.until || null }, seat8: a.seat ? String(a.seat).slice(0, 8) : null, eventsUsed: Array.isArray(opts.eventSends), eventsRows: opts.eventStats ? opts.eventStats.rows : null, eventsSkipped: opts.eventStats ? opts.eventStats.unparsed : null,
    parse: { files: facts.length, lines: sum(facts.map((f) => f.lines)), badLines: sum(facts.map((f) => f.badLines)), noTime: sum(facts.map((f) => f.noTime)), sidechain: sum(facts.map((f) => f.sidechain)) },
    sessions: facts.map((f) => ({ id8: f.id8, lines: f.lines, badLines: f.badLines, requests: f.requests, compactions: f.compactions.length, sends: f.sends.length, arrivals: f.arrivals.length })),
    metrics,
  };
}

export async function main(argv) {
  const a = parseArgs(argv);
  if (a.help) { process.stdout.write(USAGE); return 0; }
  if (a.errors.length || !a.transcripts) {
    process.stderr.write(`${a.errors.length ? `${a.errors.join('\n')}\n` : 'Missing required --transcripts.\n'}${USAGE}`);
    return 2;
  }
  const opts = { seat: a.seat ? a.seat.toLowerCase() : undefined, since: a.since ? Date.parse(a.since) : undefined, until: a.until ? Date.parse(a.until) : undefined };
  try {
    const files = resolveInputs(a.transcripts);
    const inputReals = new Set(files.map((f) => normPath(realOf(f) || f)));
    if (a.events) {
      const evReal = guardReal(a.events);
      inputReals.add(normPath(evReal || a.events));
      let rows;
      try { rows = loadEvents(a.events); } catch (err) { throw err instanceof CliError ? err : new CliError('The events file is not valid JSON.'); }
      const ev = eventSendsDetailed(rows, opts);
      // DM rows exist but none has a time that parses: the lane channel would be empty by mistake.
      if (ev.rows > 0 && ev.unparsed === ev.rows) throw new CliError('No lane DM row in the events file has a time that parses (occurred_at).');
      opts.eventSends = ev.sends;
      opts.eventStats = { rows: ev.rows, unparsed: ev.unparsed };
    }
    const inputDirs = new Set(files.map((f) => normPath(realOf(path.dirname(path.resolve(f))) || path.dirname(path.resolve(f)))));
    if (a.out) guardOut(a.out, inputReals, inputDirs);
    const facts = [];
    for (const f of files) facts.push(await ingestFile(f, opts));
    // A harness fault must not read as a report of nulls: no parsed line, or a --seat that names no session.
    if (sum(facts.map((f) => f.lines - f.badLines)) === 0) throw new CliError('No input line parsed as JSON: the input is not a transcript.');
    // Lines parse but none has a time inside the window (no timestamp, or a window off by a day).
    if (!facts.some((f) => f.firstT !== null)) throw new CliError('No input entry has a time inside the window.');
    // An empty or wrongly keyed events export would drop every transcript lane send.
    if (opts.eventStats && opts.eventStats.rows === 0 && facts.some((f) => f.sends.some((s) => s.channel === 'lane' && s.directed))) {
      throw new CliError('The events file holds no lane DM row, but the transcripts hold a directed lane send.');
    }
    if (opts.seat && !facts.some((f) => f.id.toLowerCase().startsWith(opts.seat))) throw new CliError('The --seat matches no session in the input.');
    const report = buildReport(facts, computeMetrics(facts, opts), a, opts);
    if (!a.out) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return 0; }
    // guardOut already refused an existing --out: the wx flag (and the EEXIST arm) only guard against a race.
    try { fs.writeFileSync(a.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); } catch (err) {
      throw err && err.code === 'EEXIST' ? new CliError('Refusing an --out that already exists.') : err;
    }
    for (const m of report.metrics) process.stdout.write(`M${m.id} ${m.name}: meets=${m.meets} n=${m.n}\n`);
    process.stdout.write(`Report written: ${path.basename(a.out)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof CliError ? err.message : `Unexpected failure (${err && err.code ? err.code : 'error'}).`}\n`);
    return err instanceof CliError ? 2 : 1;
  }
}

// Compare real paths: a junction or a short name must not make the CLI exit 0 with no output.
const isMain = () => {
  if (!process.argv[1]) return false;
  const a = realOf(process.argv[1]) || path.resolve(process.argv[1]);
  const b = realOf(SELF) || path.resolve(SELF);
  return a.toLowerCase() === b.toLowerCase();
};
if (isMain()) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
