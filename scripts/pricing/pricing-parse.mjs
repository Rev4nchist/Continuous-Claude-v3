// Pure parser for the Anthropic pricing page (pricing.md). No I/O, so a test can import it.
// Output: one entry per model id of the page table, plus the modifier values.
// A page that does not parse throws. The caller must never get an empty or partial table.
import { createHash } from 'node:crypto';

const RATE_KEYS = ['input', 'write5m', 'write1h', 'cacheHit', 'output'];

const lines = md => md.replace(/\r\n/g, '\n').split('\n');
const squeeze = text => text.replace(/\s+/g, ' ').trim();

/** The lines under `heading` (an exact line), up to the next heading of the same or a higher level. */
const sectionOf = (md, heading) => {
  const all = lines(md);
  const at = all.findIndex(line => line.trim() === heading);
  if (at < 0) throw new Error(`pricing page: section "${heading.replace(/^#+ /, '')}" not found`);
  const level = /^#+/.exec(heading)[0].length;
  const end = all.findIndex((line, i) => i > at && /^#{1,6} /.test(line) && /^#+/.exec(line)[0].length <= level);
  return all.slice(at + 1, end < 0 ? undefined : end);
};

const cells = row =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());

/** The first table of a section: its contiguous lines that start with a pipe. */
const tableRows = section => {
  const start = section.findIndex(line => line.trim().startsWith('|'));
  if (start < 0) return [];
  const rest = section.slice(start);
  const end = rest.findIndex(line => !line.trim().startsWith('|'));
  return (end < 0 ? rest : rest.slice(0, end)).map(cells);
};
const isRuler = row => row.every(cell => /^:?-+:?$/.test(cell));

/** Dollars per MTok from a cell such as "$12.50 / MTok", "$1 / MTok<sup>1</sup>" or "$8 USD / MTok". */
const dollars = (cell, what) => {
  const clean = cell.replace(/<sup>.*?<\/sup>/g, '');
  const m = /^\$([\d,]+(?:\.\d+)?)(?:\s*USD)?\s*\/\s*MTok$/.exec(clean.trim());
  if (m === null) throw new Error(`pricing page: cannot read ${what} from "${cell}"`);
  return Number(m[1].replace(/,/g, ''));
};

/** "Claude Opus 4.1 ([retired, ...](url))" to { id, name, retired, tier }. */
const modelOf = cell => {
  const clean = cell.replace(/<sup>.*?<\/sup>/g, '').trim();
  const name = /^Claude ([^(]+?)\s*(?:\(|$)/.exec(clean)?.[1];
  if (name === undefined) throw new Error(`pricing page: cannot read a model name from "${cell}"`);
  const tier = /\(for prompts (up to|over) ([\d,]+) tokens\)/.exec(clean);
  return {
    id: `claude-${name.toLowerCase().replace(/[ .]/g, '-')}`,
    name,
    retired: /\(\[?retired/i.test(clean),
    tier: tier === null ? null : { over: tier[1] === 'over', tokens: Number(tier[2].replace(/,/g, '')) },
  };
};

const versionOf = name => {
  const m = /(\d+)(?:\.(\d+))?\s*$/.exec(name);
  return m === null ? [0, 0] : [Number(m[1]), Number(m[2] ?? 0)];
};
const atLeast = (version, min) => version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);

const parseModels = md => {
  const rows = tableRows(sectionOf(md, '## Model pricing')).filter(row => !isRuler(row));
  const body = rows.slice(1); // the first row is the header
  if (body.length === 0) throw new Error('pricing page: section "Model pricing" has no model rows');
  const models = {};
  for (const row of body) {
    if (row.length !== 6) throw new Error(`pricing page: a model row has ${row.length} cells, expected 6: "${row[0]}"`);
    const { id, name, retired, tier } = modelOf(row[0]);
    const rates = Object.fromEntries(RATE_KEYS.map((key, i) => [key, dollars(row[i + 1], `${key} of ${name}`)]));
    if (tier?.over === true) {
      if (models[id] === undefined) throw new Error(`pricing page: over-${tier.tokens} row of ${id} comes before its base row`);
      models[id].over100k = rates;
      models[id].promptTierTokens = tier.tokens;
      continue;
    }
    if (models[id] !== undefined) throw new Error(`pricing page: two rows for ${id}`);
    models[id] = { name, ...rates, retired };
  }
  return models;
};

const parseFast = (md, models) => {
  for (const row of tableRows(sectionOf(md, '### Fast mode pricing')).filter(r => !isRuler(r)).slice(1)) {
    const fastInput = dollars(row[1], 'fast input');
    const fastOutput = dollars(row[2], 'fast output');
    for (const part of row[0].split(' / ')) {
      const { id } = modelOf(part);
      if (models[id] === undefined) throw new Error(`pricing page: fast mode names ${id}, which the model table lacks`);
      models[id].fastInput = fastInput;
      models[id].fastOutput = fastOutput;
    }
  }
};

const parseModifiers = md => {
  const geoLine = sectionOf(md, '### Data residency pricing').find(line => /incurs a [\d.]+x multiplier/.test(line));
  const geo = /incurs a ([\d.]+)x multiplier/.exec(geoLine ?? '');
  const from = /For Claude (\d+)\.(\d+) and later/.exec(geoLine ?? '');
  if (geo === null || from === null) throw new Error('pricing page: cannot read the US-only inference multiplier');
  const search = /\$([\d,]+) USD per ([\d,]+) searches/.exec(md);
  if (search === null) throw new Error('pricing page: cannot read the web search price');
  const tier = /prompt is over ([\d,]+) tokens/.exec(sectionOf(md, '### Long context pricing').join(' '));
  if (tier === null) throw new Error('pricing page: cannot read the Haiku prompt tier');
  const num = text => Number(text.replace(/,/g, ''));
  return {
    modifiers: {
      webSearchPerRequest: num(search[1]) / num(search[2]),
      usGeoMultiplier: Number(geo[1]),
      usGeoFrom: `${from[1]}.${from[2]}`,
      haikuPromptTierTokens: num(tier[1]),
    },
    geoFrom: [Number(from[1]), Number(from[2])],
  };
};

/** Hash of the page text that carries a rule: the tables, the footnotes and the modifier paragraphs. */
const hashRules = md => {
  const keep = [
    ...sectionOf(md, '## Model pricing').filter(line => /^\s*(\||\*<sup>)/.test(line)),
    ...sectionOf(md, '### Data residency pricing').filter(line => /incurs a [\d.]+x multiplier/.test(line)).slice(0, 1),
    ...sectionOf(md, '### Fast mode pricing').filter(line => line.trim().startsWith('|')),
    ...sectionOf(md, '### Long context pricing').filter(line => line.trim() !== ''),
    ...lines(md).filter(line => /USD per [\d,]+ searches/.test(line)).slice(0, 1),
  ];
  return createHash('sha256').update(keep.map(squeeze).join('\n')).digest('hex');
};

export const parsePricing = md => {
  const models = parseModels(md);
  parseFast(md, models);
  const { modifiers, geoFrom } = parseModifiers(md);
  for (const row of Object.values(models)) row.geo = atLeast(versionOf(row.name), geoFrom);
  return { models, modifiers, sectionHash: hashRules(md) };
};

export const buildPrices = (md, { source, fetchedAt }) => {
  const { models, modifiers, sectionHash } = parsePricing(md);
  return { source, fetchedAt, unit: 'USD per million tokens', sectionHash, modifiers, models };
};

const flat = (value, prefix = '') =>
  value !== null && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, inner]) => flat(inner, prefix === '' ? key : `${prefix}.${key}`))
    : [[prefix, value]];

/** Every difference between two price tables as a line of text. `fetchedAt` and `source` are not compared. */
export const diffPrices = (stored, fresh) => {
  const a = new Map(flat({ ...stored, fetchedAt: undefined, source: undefined }).filter(([, v]) => v !== undefined));
  const b = new Map(flat({ ...fresh, fetchedAt: undefined, source: undefined }).filter(([, v]) => v !== undefined));
  const out = [];
  for (const [key, was] of a) {
    if (!b.has(key)) out.push(`removed ${key} (was ${JSON.stringify(was)})`);
    else if (b.get(key) !== was) out.push(`changed ${key}: ${JSON.stringify(was)} -> ${JSON.stringify(b.get(key))}`);
  }
  for (const [key, now] of b) if (!a.has(key)) out.push(`added ${key} = ${JSON.stringify(now)}`);
  return out;
};

/** The TypeScript twin of prices.json. The mod imports this file: the engine's tsconfig does not resolve JSON. */
export const toGeneratedTs = prices =>
  [
    '// Generated by scripts/pricing/refresh-prices.mjs from prices.json. Do not edit by hand.',
    '// prices.json is the source. Run `node scripts/pricing/refresh-prices.mjs` to rebuild both files.',
    '',
    `export const PRICES = ${JSON.stringify(prices, null, 2)} as const`,
    '',
  ].join('\n');
