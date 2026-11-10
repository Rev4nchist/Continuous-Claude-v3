// Parser for docs/review-engine/map.md. Pure: text in, data model out. No I/O.
// It keeps raw cells and every row. The checks (map-check.mjs) judge them.
// Parse-level findings go to model.errors as { rule, lane, line, message }.
import { kindOf } from './owns.mjs';

const WAVES_HEADER = '| Wave | Lane | Phase | Depends on | Needs Dave | Change | Held until |';
const SECTION = /^### (\S+)$/;
const ANY_HEADING = /^#{2,3} /;
const SUBTITLE = /^\*\*(.+)\*\* \((.+)\)$/;
const EXTERNAL = /^counts as wave 0, external/;
const FIELD = /^- ([A-Z][A-Za-z ]+?)(?: \([^)]*\))?: (.*)$/;
const BLOCK = /^(Scope|Done when|Why)\b([^:]*):\s*(.*)$/;
const FILE_NAME = /[\w./-]+\.(?:mjs|json|ps1|md|ts|js)/g;
const LANE_ID = /^[a-z0-9][a-z0-9-]*$/;

const splitCells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const noTicks = (text) => text.replace(/`/g, '');
const backtickIds = (text) => [...text.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1]);

// Held until

const DECISION = /^DP\d+(\.\d+)*$/;
const CONDITIONAL = /^([a-z0-9][a-z0-9-]*) if (DP\d+(?:\.\d+)*) = (\S+)$/;
const KEYWORDS = ['first-flip', 'dave-yes', 'item-trigger'];

function heldToken(text) {
  const cond = CONDITIONAL.exec(text);
  if (DECISION.test(text)) return { kind: 'decision', id: text };
  if (cond) return { kind: 'conditional', lane: cond[1], decision: cond[2], answer: cond[3] };
  if (KEYWORDS.includes(text)) return { kind: text };
  if (LANE_ID.test(text)) return { kind: 'lane', lane: text };
  return { kind: 'unknown', text };
}

export function parseHeld(cell) {
  return cell.split('; ').map((t) => t.trim()).filter(Boolean).map(heldToken);
}

// Waves table

// A Depends on cell or field: 'none' is empty, else a comma list. The one place that splits it.
export function parseDeps(raw) {
  return raw.trim() === 'none' ? [] : raw.split(',').map((d) => d.trim()).filter(Boolean);
}

function parseRow(text, line, errors) {
  const cells = splitCells(text);
  const c = Array.from({ length: 7 }, (_, i) => cells[i] ?? '');
  const id = noTicks(c[1]);
  if (cells.length !== 7) {
    errors.push({ rule: 'row-cells', lane: id || null, line, message: `Waves line ${line}: ${cells.length} cells, want 7` });
  }
  return {
    id, wave: /^\d+$/.test(c[0]) ? Number(c[0]) : null, waveRaw: c[0], phase: c[2],
    deps: parseDeps(c[3]),
    needsDave: c[4] === 'yes', needsDaveRaw: c[4], change: c[5],
    held: parseHeld(c[6]), heldRaw: c[6], line, cellCount: cells.length, section: null,
  };
}

function parseWaves(lines, errors) {
  const head = lines.findIndex((l) => l.startsWith('| Wave | Lane |'));
  if (head < 0) {
    errors.push({ rule: 'waves-missing', lane: null, line: null, message: `map: no Waves table (header '${WAVES_HEADER}' not found)` });
    return [];
  }
  const rows = [];
  for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    rows.push(parseRow(lines[i], i + 1, errors));
  }
  return rows;
}

// Dropped lanes: the first table only. A blank line ends it.

function parseDropped(lines) {
  const heading = lines.findIndex((l) => l.startsWith('## Dropped or merged lanes'));
  if (heading < 0) return [];
  let i = heading + 1;
  while (i < lines.length && !lines[i].startsWith('|') && !lines[i].startsWith('## ')) i++;
  const dropped = [];
  if (!lines[i]?.startsWith('|')) return dropped;
  for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = splitCells(lines[i]);
    dropped.push({ id: noTicks(cells[0] ?? ''), what: cells[1] ?? '', where: cells[2] ?? '', line: i + 1 });
  }
  return dropped;
}

// Owns

const OWNS_TOKEN = /`([^`]+)`((?:\s*\([^)]*\))*)/g;
const PATH_TOKEN = /^[\w.~*/-]+$/;

function ownsEntry(path, parens) {
  const marks = [...parens.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim());
  const scope = marks.filter((p) => p !== 'new' && p !== 'gitignored').join('; ');
  return {
    path, kind: kindOf(path), scope: scope || null,
    isNew: marks.includes('new'), outsideGit: /^(\.claudedocs\/|~)/.test(path),
  };
}

// Strip joining words at the edges, so "`a` and `b`" leaves no prose.
function cleanProse(text) {
  return text.replace(/\s+/g, ' ').trim()
    .replace(/^(?:[,;.&\s]|and\b)+/, '').replace(/(?:[,;.&\s]|\band)+$/, '');
}

// A backticked token the parser rejects is prose, unless it looks like a path: it has a '/' or ends in a file extension.
const looksLikePath = (token) => token.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(token);

export function parseOwns(value) {
  if (value === undefined || value.trim() === 'none') return { owns: [], prose: '', rejected: [] };
  const owns = [];
  const rejected = [];
  let prose = value;
  for (const m of value.matchAll(OWNS_TOKEN)) {
    if (PATH_TOKEN.test(m[1])) {
      owns.push(ownsEntry(m[1], m[2]));
      prose = prose.replace(m[0], ' ');
    } else if (looksLikePath(m[1])) {
      rejected.push(m[1]);
    }
  }
  return { owns, prose: cleanProse(prose), rejected };
}

// Sections

const newSection = (id, line) => ({
  id, line, title: null, subtitle: null, external: false, fields: {}, blocks: {}, owns: [], ownsProse: '', ownsRejected: [],
});

function endBlock(st) {
  if (st.block) st.sec.blocks[st.block] = st.buf.join('\n').trim();
  st.block = null;
}

// A field is read only before the first block line. The first one wins.
function readSectionLine(st, line) {
  const sec = st.sec;
  const sub = !st.inBlocks && !sec.subtitle && SUBTITLE.exec(line);
  const blk = BLOCK.exec(line);
  if (sub) {
    Object.assign(sec, { title: sub[1], subtitle: sub[2], external: EXTERNAL.test(sub[2]) });
  } else if (blk) {
    endBlock(st);
    st.inBlocks = true;
    st.block = blk[1] in sec.blocks ? null : blk[1];
    st.buf = [blk[3]];
  } else if (st.block) {
    st.buf.push(line);
  } else if (!st.inBlocks) {
    const f = FIELD.exec(line);
    if (f && !(f[1] in sec.fields)) sec.fields[f[1]] = f[2];
  }
}

function finishSection(sec) {
  const { owns, prose, rejected } = parseOwns(sec.fields.Owns);
  sec.owns = owns;
  sec.ownsProse = prose;
  sec.ownsRejected = rejected;
}

function parseSections(lines) {
  const sections = [];
  const st = { sec: null, block: null, buf: [], inBlocks: false };
  lines.forEach((line, i) => {
    if (ANY_HEADING.test(line)) {
      endBlock(st);
      const m = SECTION.exec(line);
      st.sec = m ? newSection(m[1], i + 1) : null;
      st.inBlocks = false;
      if (st.sec) sections.push(st.sec);
    } else if (st.sec) {
      readSectionLine(st, line);
    }
  });
  endBlock(st);
  sections.forEach(finishSection);
  return sections;
}

// Owner chains and owner phrases

// A clause is "<files>: <lanes>". One the parser cannot read goes to unparsed, so a check can show it. Nothing is guessed.
function chainClauses(text, line) {
  const chains = [];
  const unparsed = [];
  for (const raw of text.split(/\.\s+/)) {
    const clause = raw.trim();
    const m = /^([^:`]+):\s+(.*)$/.exec(clause);
    const files = m ? [...m[1].matchAll(FILE_NAME)].map((f) => f[0]) : [];
    if (files.length) chains.push({ files, lanes: backtickIds(m[2]), line });
    else if (clause) unparsed.push({ line, text: clause });
  }
  return { chains, unparsed };
}

function parseOwnerChains(lines) {
  const start = lines.findIndex((l) => l.startsWith('- **Owner chains.**'));
  const found = { chains: [], unparsed: [] };
  for (let i = start + 1; start >= 0 && i < lines.length && /^ {2}- /.test(lines[i]); i++) {
    const { chains, unparsed } = chainClauses(lines[i].slice(4), i + 1);
    found.chains.push(...chains);
    found.unparsed.push(...unparsed);
  }
  return found;
}

function parseOwnerPhrases(lines) {
  const start = lines.findIndex((l) => l.startsWith('## Shared contracts'));
  if (start < 0) return [];
  const phrases = [];
  for (let i = start; i < lines.length && (i === start || !lines[i].startsWith('## ')); i++) {
    for (const m of lines[i].matchAll(/Owner `([a-z0-9][a-z0-9-]*)` \(([^)]*)\)/g)) {
      const files = [...m[2].matchAll(FILE_NAME)].map((f) => f[0]).filter((f) => !f.startsWith('~'));
      if (files.length) phrases.push({ lane: m[1], files, line: i + 1 });
    }
  }
  return phrases;
}

export function parseMap(text, source = null) {
  const lines = text.split(/\r?\n/);
  const errors = [];
  const lanes = parseWaves(lines, errors);
  const sections = parseSections(lines);
  const byId = new Map();
  for (const s of sections) if (!byId.has(s.id)) byId.set(s.id, s);
  for (const lane of lanes) lane.section = byId.get(lane.id) ?? null;
  const externals = sections.filter((s) => s.external).map((s) => ({ id: s.id, wave: 0, section: s }));
  const chains = parseOwnerChains(lines);
  return {
    source, errors, lanes, sections, externals,
    dropped: parseDropped(lines), ownerChains: chains.chains, chainUnparsed: chains.unparsed,
    ownerPhrases: parseOwnerPhrases(lines),
  };
}
