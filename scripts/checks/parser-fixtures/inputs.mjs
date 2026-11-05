// Hostile-input generators for the parser fixtures (plan 2026-11-04-review-engine-p2-plan.md, "Hostile-input taxonomy").
//
// A case is { id, cls, domain, value, ...meta }.
//   cls     one of CLASSES: text, path, argv, prose.
//   domain  undefined for a generic case that any function of that class can take.
//           A name (diff, scrub, steps ...) for a case built for one kind of function. It carries an `expect` or `secrets` field.
//   value   what the function under test receives.
// A registry entry selects cases with `inputs`: "text" takes the generic text cases, "text:diff" takes the diff cases.
//
// The taxonomy: empty and whitespace-only input, CRLF and lone CR, tabs, very long input, unicode and emoji, NUL,
// paths with spaces, quotes and apostrophes, Windows and POSIX and ~ paths, a flag where a value is expected, repeated flags,
// mixed case, punctuation variants (en dash, em dash, unspaced dash, smart quotes), and action words mixed with wait words.
// Every generator is pure and deterministic: the same call gives the same cases.

export const CLASSES = ['text', 'path', 'argv', 'prose'];

const make = (cls, domain, id, value, meta = {}) => ({ cls, domain, id: `${cls}${domain ? `:${domain}` : ''}/${id}`, value, ...meta });

const LONG = 100_000;

// ---------- generic text ----------

const TEXT_ROWS = {
  empty: '',
  spaces: '   ',
  'whitespace-mix': ' \t \r\n \n \r ',
  crlf: 'one\r\ntwo\r\nthree\r\n',
  'lone-cr': 'one\rtwo\rthree',
  tabs: '\t\tone\t\ttwo\t',
  nul: 'one\0two\0',
  'nul-only': '\0\0\0',
  unicode: 'caf\u00e9 \u00fcber \u4e2d\u6587 \u0645\u0631\u062d\u0628\u0627',
  emoji: 'ok \u{1F680}\u{1F600} \u{1F468}\u200D\u{1F469}',
  'lone-surrogate': 'one\uD800two',
  quotes: `"'\`'"''""\`\``,
  'smart-quotes': '\u201Cone\u201D \u2018two\u2019',
  dashes: '- \u2013 \u2014 -- --- ---- - -',
  bidi: 'one\u202Etwo\u2066three\u2069',
  bom: '\uFEFFone',
  'flag-like': '--help --version -h --',
  'mixed-case': 'NoNe NEXT Steps nExT sTePs',
  punctuation: '.,;:!?()[]{}<>|/\\',
  'long-line': 'a'.repeat(LONG),
  'long-words': 'word '.repeat(LONG / 5),
  'long-lines': 'line\n'.repeat(LONG / 5),
  'long-quotes': "'".repeat(LONG / 5),
  'long-slashes': '/'.repeat(LONG / 5),
  'long-backslashes': '\\'.repeat(LONG / 5),
};

/** Generic hostile strings. Any function that takes a string can take these. */
export function textCases() {
  return Object.entries(TEXT_ROWS).map(([id, value]) => make('text', undefined, id, value));
}

// ---------- generic paths ----------

const PATH_ROWS = {
  'drive-only': 'C:',
  'drive-root': 'C:\\',
  'unc-bare': '\\\\',
  'long-prefix': '\\\\?\\C:\\zorro\\ledger.csv',
  slash: '/',
  'double-slash': '//',
  tilde: '~',
  'tilde-slash': '~/',
  'home-var': '$HOME/',
  'userprofile-var': '%USERPROFILE%\\',
  'home-bare': '/home',
  'home-slash': '/home/',
  'dotdot': '/home//..//x',
  'program-files': 'C:\\Program Files (x86)\\Vendor App\\run.exe',
  relative: './zorro/ledger.csv',
  parent: '../../zorro/ledger.csv',
  'space-name': 'a b/c d',
  apostrophe: "it's/here",
  'long-windows': `C:\\${'dir\\'.repeat(5000)}file.txt`,
  'long-posix': `/home/${'dir/'.repeat(10_000)}file.txt`,
  'long-no-sep': `/home/${'a'.repeat(LONG)}`,
  'long-spaces': `C:\\Users\\${'a '.repeat(10_000)}`,
};

/** Generic hostile path strings. */
export function pathCases() {
  return Object.entries(PATH_ROWS).map(([id, value]) => make('path', undefined, id, value));
}

// ---------- generic argv ----------

const ARGV_ROWS = {
  none: [],
  'empty-arg': [''],
  help: ['--help'],
  'short-help': ['-h'],
  'double-dash': ['--'],
  'flag-alone': ['--pr'],
  'flag-value': ['--pr', '5'],
  'zero-value': ['--pr', '0'],
  'negative-value': ['--pr', '-1'],
  'decimal-value': ['--pr', '5.5'],
  'padded-value': ['--pr', ' 5'],
  'repeated-flag': ['--pr', '5', '--pr', '6'],
  'repeated-switch': ['--pr', '5', '--json', '--json'],
  'flag-for-value': ['--pr', '--fresh'],
  'repo-flag-for-value': ['--repo', '--fresh'],
  'value-missing-repo': ['--repo'],
  'repo-with-space': ['--repo', 'owner name/repo'],
  'mixed-case': ['--PR', '5'],
  'equals-form': ['--pr=5'],
  'quoted-arg': ['--pr', '5', "'quoted'"],
  'tilde-arg': ['--pr', '5', '~/x'],
  'nul-arg': ['--pr', '5', '\0'],
  'unicode-arg': ['--pr', '\u0663'],
  'emoji-arg': ['--pr', '5', '\u{1F680}'],
  'long-arg': ['--pr', '5', 'x'.repeat(LONG)],
  'huge-number': ['--pr', '9'.repeat(30)],
};

/** Generic hostile argument vectors. The function takes the array, as process.argv.slice(2) gives it. */
export function argvCases() {
  return Object.entries(ARGV_ROWS).map(([id, value]) => make('argv', undefined, id, value));
}

// ---------- generic prose ----------

const PROSE_ROWS = {
  'heading-only': '## Next steps',
  'heading-only-crlf': '## Next steps\r\n',
  'quadratic-spaces': `${' '.repeat(20_000)}x`,
  'waiting-long': `## Next steps\n1. Waiting on ${'a '.repeat(2000)}`,
  'dashes-long': `## Next steps\n1. None${' - '.repeat(2000)}`,
  'lead-long': `## Next steps\n1. ${'None for now. '.repeat(2000)}`,
  'one-long-line': `## Next steps\n1. ${'x'.repeat(50_000)}`,
  'many-items': `## Next steps\n${'1. Run the probe\n'.repeat(2000)}`,
  'many-headings': '## Next steps\n'.repeat(5000),
  'unterminated-fence': '```\n## Next steps\n1. Approve the draft\n',
  'restate-long': `Restating the ask: ${'build the thing and '.repeat(3000)}stop at the end`,
  'stop-long': `I will ${'stop at '.repeat(3000)}`,
  'goal-label-empty': 'Goal:\nStop at:\n',
};

/** Generic hostile model answers. */
export function proseCases() {
  return Object.entries(PROSE_ROWS).map(([id, value]) => make('prose', undefined, id, value));
}

// ---------- domain: error values for the message sanitiser ----------

/** Values a catch block can hold. Not all are Error objects. */
export function errorValueCases() {
  const rows = {
    'error-plain': new Error('boom'),
    'error-empty': new Error(''),
    'error-path': new Error('ENOENT: no such file or directory, open \'/home/zorro/secret plans/ledger.csv\''),
    'string-value': 'plain text failure',
    'number-value': 42,
    'null-value': null,
    'undefined-value': undefined,
    'object-value': { code: 'E_X' },
    'array-value': ['a', 'b'],
    'error-long': new Error('x'.repeat(LONG)),
  };
  const secrets = { 'error-path': ['zorro', 'plans', 'ledger'] };
  return Object.entries(rows).map(([id, value]) => make('text', 'error', id, value, { secrets: secrets[id] }));
}

// ---------- domain: paths inside a sentence ----------

// root: [prefix, separator, secrets that name the user]
const ROOTS = {
  posix: ['/home/zorro/', '/', ['zorro']],
  mac: ['/Users/zorro/', '/', ['zorro']],
  tmp: ['/tmp/zorro/', '/', ['zorro']],
  data: ['/data/zorro/', '/', ['zorro']],
  win: ['C:\\Users\\zorro\\', '\\', ['zorro']],
  winfwd: ['C:/Users/zorro/', '/', ['zorro']],
  unc: ['\\\\srv\\share\\Users\\zorro\\', '\\', ['zorro']],
  tilde: ['~/', '/', []],
  home: ['$HOME/', '/', []],
  userprofile: ['%USERPROFILE%\\', '\\', []],
};

// seg: [text, words of it that must not survive]
const SEGS = {
  plain: ['Reports', ['Reports']],
  space: ['Quux Holdings', ['Quux', 'Holdings']],
  apostrophe: ["D'Angelo", ['Angelo']],
  dquote: ['Kes"trel', ['trel']],
  tab: ['Wide\tBlue', ['Wide', 'Blue']],
  aposspace: ["Clients' Archive", ['Clients', 'Archive']],
  unicode: ['Zo\u00eb \u00dcnal', ['\u00dcnal']],
  parens: ['Docs (old)', ['Docs', 'old']],
};

const WRAPS = {
  bare: (p) => p,
  dq: (p) => `"${p}"`,
  sq: (p) => `'${p}'`,
  bt: (p) => `\`${p}\``,
  paren: (p) => `(${p})`,
  dqopen: (p) => `"${p}`,
  sqopen: (p) => `'${p}`,
};

// tail: [text after the path, token of it that must survive in free text or null]
const TAILS = {
  none: ['', null],
  word: [' soon?', 'soon?'],
  url: [' https://example.test/t/1', 'https://example.test/t/1'],
  mdlink: [' [proof](https://example.test/t/1)', '[proof](https://example.test/t/1)'],
  mark: ['.', '.'],
};

const FILE = 'ledger.csv';

function scrubCase([rootId, [prefix, sep, who]], [segId, [seg, words]], wrapId, tailId) {
  const [tail, keepTail] = TAILS[tailId];
  const path = `${prefix}${seg}${sep}${FILE}`;
  const value = `see ${WRAPS[wrapId](path)}${tail}`;
  const secrets = [...who, ...words, 'ledger'];
  const keep = ['see', ...(keepTail ? [keepTail] : [])];
  return make('path', 'scrub', `root=${rootId} seg=${segId} wrap=${wrapId} tail=${tailId}`, value, { secrets, keep });
}

/**
 * Cells the scrubbers cannot handle today. Each one is a real gap found by the grid, listed so the gate passes on main.
 * parser-fixtures.test.mjs checks that every cell here still fails, so the entry must go when the gap is fixed.
 */
export const KNOWN_LIMITS = [
  {
    root: 'data',
    segs: ['apostrophe', 'dquote', 'unicode'],
    reason: 'A root outside the named list (home, Users, tmp, var ...) is read by POSIX_DEEP_PATH, which takes ASCII word characters only. A quote or a non-ASCII letter in a segment ends the match and the rest of the path stays in the text.',
  },
];

const isLimit = (rootId, segId) => KNOWN_LIMITS.some((l) => l.root === rootId && l.segs.includes(segId));

/** One sentence per root, segment, wrap and tail. `secrets` must not survive a scrub. `keep` must survive a free-text scrub. */
export function scrubCases({ includeLimits = false } = {}) {
  const out = [];
  for (const root of Object.entries(ROOTS)) {
    for (const seg of Object.entries(SEGS)) {
      if (!includeLimits && isLimit(root[0], seg[0])) continue;
      for (const wrap of Object.keys(WRAPS)) {
        for (const tail of Object.keys(TAILS)) out.push(scrubCase(root, seg, wrap, tail));
      }
    }
  }
  return out;
}

// ---------- domain: secrets split by invisible characters ----------

const TOKEN_BODY = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ';
const CRED_VALUE = 'Xk29QmVb7Lr4';
const INVISIBLES = { zwsp: '\u200B', rlo: '\u202E', nul: '\0', shy: '\u00AD', bom: '\uFEFF', isolate: '\u2066' };

const insertAt = (text, at, ch) => text.slice(0, at) + ch + text.slice(at);

function secretCase(kind, where, chId, ch, fill) {
  const body = kind === 'token' ? TOKEN_BODY : CRED_VALUE;
  const lead = kind === 'token' ? 'ghp_' : 'password=';
  let secret = `${lead}${body}`;
  if (where === 'name') secret = insertAt(secret, 2, ch);
  if (where === 'value') secret = insertAt(secret, lead.length + Math.floor(body.length / 2), ch);
  const value = `${'x'.repeat(fill)} ${secret} trailing words`;
  return make('text', 'secret', `kind=${kind} at=${where} ch=${chId} fill=${fill}`, value, { secrets: [body.slice(0, 10)] });
}

/** A secret with one invisible character inside it, placed after filler of several lengths (so some cut at the 160 character clip). */
export function secretCases() {
  const out = [];
  for (const kind of ['token', 'credential']) {
    for (const [chId, ch] of Object.entries(INVISIBLES)) {
      for (const where of ['name', 'value']) {
        for (const fill of [0, 100, 135, 150]) out.push(secretCase(kind, where, chId, ch, fill));
      }
    }
    out.push(secretCase(kind, 'none', 'none', '', 0), secretCase(kind, 'none', 'none', '', 150));
  }
  return out;
}

// ---------- domain: invisible characters ----------

const INVISIBLE_SAMPLES = ['\u0000', '\u0001', '\u0008', '\u001F', '\u007F', '\u0085', '\u009F', '\u00AD', '\u061C', '\u200B', '\u200D', '\u200F', '\u202A', '\u202E', '\u2060', '\u2066', '\u2069', '\uFEFF'];

/** Text where a visible word has one invisible or control character in it. `visible` is what must stay. */
export function controlCases() {
  const rows = INVISIBLE_SAMPLES.map((ch) => make('text', 'control', `char=U+${ch.codePointAt(0).toString(16).padStart(4, '0')}`, `one${ch}two\tthree\nfour`, { visible: 'onetwo\tthree\nfour' }));
  rows.push(make('text', 'control', 'all', `one${INVISIBLE_SAMPLES.join('')}two`, { visible: 'onetwo' }));
  return rows;
}

// ---------- domain: Next steps blocks ----------

const ACTIONS = [
  ['Approve', 'the draft'], ['Merge', 'the branch'], ['Run', 'the probe'], ['Paste', 'the log'],
  ['Review', 'the diff'], ['Reply', 'with your pick'], ['Confirm', 'the date'],
];
const WAITS = ['Waiting on CI', "I'm waiting on the build", 'Waiting for the deploy', 'I\u2019m waiting for the sync', 'waiting on review'];
const LEADS = [
  'None', 'none', 'NONE', 'None for now', 'None today', 'None yet', 'None right now', 'Nothing to do', 'Nothing for you to do',
  'Nothing for Dave to do', 'Nothing required', 'Nothing yet', 'Nothing for now', 'No action needed', 'No input required', 'No reply needed',
];
const HEADINGS = ['## Next steps', '### Next steps', '# next steps', '**Next steps**', '**Next steps:**', '## NEXT STEPS:'];
const BULLETS = ['1. ', '1) ', '- ', '* ', '  - '];
const EOLS = ['\n', '\r\n'];

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const sentence = ([verb, rest]) => `${verb} ${rest}`;

function block(n, items) {
  const eol = EOLS[n % EOLS.length];
  const heading = HEADINGS[n % HEADINGS.length];
  const bullet = BULLETS[n % BULLETS.length];
  const lead = n % 3 === 0 ? `Done.${eol}${eol}` : '';
  return `${lead}${heading}${eol}${items.map((it) => bullet + it).join(eol)}${eol}`;
}

/** Items that ask Dave to act, with and without wait words around the action. `verb` must stay in an ask. */
function actionRows() {
  const rows = [];
  for (const action of ACTIONS) {
    const [verb] = action;
    const text = sentence(action);
    rows.push([`${verb}:bare`, text, verb]);
    for (const wait of WAITS) {
      rows.push([`${verb}:wait-then`, `${wait}, then ${lower(text)}`, verb]);
      rows.push([`${verb}:wait-stop`, `${wait}. ${text}`, verb]);
      rows.push([`${verb}:wait-hyphen`, `${wait} - ${lower(text)}`, verb]);
      rows.push([`${verb}:wait-em`, `${wait} \u2014 ${lower(text)}`, verb]);
      rows.push([`${verb}:wait-en`, `${wait}\u2013${lower(text)}`, verb]);
      rows.push([`${verb}:act-while`, `${text} while ${lower(wait)}`, verb]);
      rows.push([`${verb}:act-semi`, `${text}; ${lower(wait)}`, verb]);
    }
    const lead = LEADS[ACTIONS.indexOf(action) % LEADS.length];
    rows.push([`${verb}:lead-stop`, `${lead}. ${text}`, verb]);
    rows.push([`${verb}:lead-hyphen`, `${lead} - ${text}`, verb]);
    rows.push([`${verb}:lead-colon`, `${lead}: ${text}`, verb]);
    rows.push([`${verb}:lead-but`, `${lead}, but ${lower(text)}`, verb]);
  }
  return rows;
}

/** Items that ask Dave although they name waiting: the waiting object is Dave. */
const DAVE_WAITS = ["Waiting on Dave's approval", 'Waiting on your yes', "I'm waiting for you to merge", 'Waiting for Dave'];

/** Items that ask nothing of Dave. */
function noAskRows() {
  const rows = [];
  for (const lead of LEADS) {
    rows.push([`${lead}:alone`, lead]);
    rows.push([`${lead}:period`, `${lead}.`]);
  }
  const lead = LEADS[3];
  for (const wait of ['waiting on CI', "I'm waiting on the build", 'waiting for the sync']) {
    rows.push([`lead-stop:${wait}`, `${lead}. ${wait}`]);
    rows.push([`lead-hyphen:${wait}`, `${lead} - ${wait}`]);
    rows.push([`lead-em:${wait}`, `${lead} \u2014 ${wait}`]);
    rows.push([`lead-en:${wait}`, `${lead}\u2013${wait}`]);
    rows.push([`lead-colon:${wait}`, `${lead}: ${wait}`]);
  }
  for (const wait of WAITS) rows.push([`bare:${wait}`, wait], [`bare-period:${wait}`, `${wait}.`]);
  return rows;
}

function stepsCases() {
  const out = [];
  const add = (id, n, items, expect, extra = {}) => out.push(make('prose', 'steps', id, block(n, items), { expect, ...extra }));
  actionRows().forEach(([id, item, verb], n) => add(`ask ${id} #${n}`, n, [item], { kind: 'asks', count: 1, verb }));
  DAVE_WAITS.forEach((item, n) => add(`ask dave-wait #${n}`, n, [item], { kind: 'asks', count: 1 }));
  noAskRows().forEach(([id, item], n) => add(`none ${id} #${n}`, n, [item], { kind: 'none' }));
  ['None for now?', 'Waiting on CI?', 'Which option do you pick?'].forEach((item, n) => add(`ask question #${n}`, n, [item], { kind: 'asks', count: 1 }));
  ACTIONS.forEach((action, n) => add(`mixed none-then-act #${n}`, n, [LEADS[n], sentence(action)], { kind: 'asks', count: 1, verb: action[0] }));
  ACTIONS.forEach((action, n) => add(`mixed act-then-none #${n}`, n, [sentence(action), LEADS[n]], { kind: 'asks', count: 1, verb: action[0] }));
  return out;
}

function structureCases() {
  const fenced = (eol) => ['```', '## Next steps', '1. Approve the draft', '```', ''].join(eol);
  return [
    make('prose', 'steps', 'fenced-only', fenced('\n'), { expect: { kind: 'no-block' } }),
    make('prose', 'steps', 'fenced-only-crlf', fenced('\r\n'), { expect: { kind: 'no-block' } }),
    make('prose', 'steps', 'no-heading', 'Approve the draft\nRun the probe\n', { expect: { kind: 'no-block' } }),
    make('prose', 'steps', 'stops-at-next-heading', '## Next steps\n1. None\n## Other\n1. Approve the draft\n', { expect: { kind: 'none' } }),
    make('prose', 'steps', 'heading-no-items', '## Next steps\n\n', { expect: { kind: 'no-block' } }),
    make('prose', 'steps', 'bare-line-question', '## Next steps\nWhich branch do you want?\n', { expect: { kind: 'asks', count: 1 } }),
  ];
}

function stepSecretCases() {
  return ['ghp_', 'sk-'].map((lead, n) => make('prose', 'steps', `secret-in-item #${n}`, `## Next steps\n1. Paste ${lead}${TOKEN_BODY} into the form\n`, { expect: { kind: 'asks', count: 1, verb: 'Paste' }, secrets: [TOKEN_BODY.slice(0, 10)] }));
}

/** Model answers with a Next steps block. `expect.kind` is asks, none, or no-block. */
export function stepsBlockCases() {
  return [...stepsCases(), ...structureCases(), ...stepSecretCases()];
}

// ---------- domain: restate lines ----------

const GOALS = ['build the parser fixtures', 'fix the sync script'];
const STOPS = ['an open PR', 'the first green run'];
const RESTATE_LABELS = ['Restating the ask', 'Restate', 'Restated ask', 'Restating both asks'];
const SEPARATORS = [': ', ' - ', ' \u2013 ', ' \u2014 ', ':'];
const STOP_WORDS = ['stop at', 'stop before', 'stop after', "I'll stop at", 'I will stop before', 'stopping at'];

function restateRow(n, goal, stop) {
  const label = RESTATE_LABELS[n % RESTATE_LABELS.length];
  const sep = SEPARATORS[n % SEPARATORS.length];
  const word = STOP_WORDS[n % STOP_WORDS.length];
  const wrap = [(s) => s, (s) => `- ${s}`, (s) => `**${s}**`, (s) => `1. ${s}`][n % 4];
  const text = wrap(`${label}${sep}${goal} and ${word} ${stop}.`);
  return make('prose', 'restate', `labelled #${n}`, `${text}\nMore text.\n`, { expect: { goal, stop, labelled: true } });
}

function sentenceRow(n, goal, stop) {
  const word = ['stop at', 'stop before', 'stop after'][n % 3];
  return make('prose', 'restate', `sentence #${n}`, `Before work.\nI will ${goal} and ${word} ${stop}.\n`, { expect: { goal, stop, labelled: false } });
}

function labelRows() {
  return [
    make('prose', 'restate', 'goal-label', 'Goal: build the parser fixtures\n', { expect: { goal: 'build the parser fixtures', stop: null } }),
    make('prose', 'restate', 'objective-label', 'Objective - fix the sync script.\n', { expect: { goal: 'fix the sync script', stop: null } }),
    make('prose', 'restate', 'stop-label', 'Stop at: an open PR\n', { expect: { goal: null, stop: 'an open PR' } }),
    make('prose', 'restate', 'label-crlf', 'Goal: build the parser fixtures\r\nStop at: an open PR\r\n', { expect: { goal: 'build the parser fixtures', stop: 'an open PR' } }),
    make('prose', 'restate', 'no-separator', 'Restate the ask before you start the work.\n', { expect: { goal: null, stop: null } }),
    make('prose', 'restate', 'fenced', '```\nGoal: build the parser fixtures\n```\n', { expect: { goal: null, stop: null } }),
  ];
}

/** Restate lines and labelled goal or stop lines. `expect.goal` and `expect.stop` are words that must appear, or null for "absent". */
export function restateCases() {
  const out = [];
  let n = 0;
  for (const goal of GOALS) {
    for (const stop of STOPS) {
      out.push(restateRow(n, goal, stop), sentenceRow(n, goal, stop));
      n += 1;
    }
  }
  for (let i = n; i < n + 12; i += 1) out.push(restateRow(i, GOALS[i % 2], STOPS[(i + 1) % 2]));
  return [...out, ...labelRows()];
}

// ---------- domain: unified diffs ----------

const DIFF_FILES = {
  plain: { name: 'src/a.mjs', quoted: null },
  spaces: { name: 'src/my dir/file name.mjs', quoted: null, tab: true },
  unicode: { name: 'src/caf\u00e9.mjs', quoted: '"src/caf\\303\\251.mjs"' },
  apostrophe: { name: "src/it's.mjs", quoted: null },
  dquote: { name: 'src/we"ird.mjs', quoted: '"src/we\\"ird.mjs"' },
  tabname: { name: 'src/ta\tb.mjs', quoted: '"src/ta\\tb.mjs"' },
};

// Hunk bodies: lines with their op. Text that looks like a header ("-- x" removed shows as "--- x") is on purpose.
const HUNK_BODIES = {
  mixed: [[' ', 'keep one'], ['-', 'old line'], ['+', 'new line'], ['+', 'extra line'], [' ', 'keep two']],
  'header-lookalike': [[' ', 'keep'], ['-', '-- x'], ['+', '++ y'], ['-', '-'], ['+', '+'], [' ', 'keep']],
  'diff-lookalike': [['-', 'diff --git a/q b/q'], ['+', '@@ -1 +1 @@'], [' ', 'end']],
  'add-only': [['+', 'one'], ['+', 'two'], ['+', 'three']],
  'remove-only': [['-', 'one'], ['-', 'two']],
  'no-newline': [['-', 'old'], ['\\', ' No newline at end of file'], ['+', 'new'], ['\\', ' No newline at end of file']],
  'empty-context': [[' ', ''], ['+', 'added'], [' ', '']],
};

const count = (body, ops) => body.filter(([op]) => ops.includes(op)).length;

function hunkText(body, start) {
  const oldN = count(body, [' ', '-']);
  const newN = count(body, [' ', '+']);
  const oldPart = oldN === 1 ? `${start}` : `${start},${oldN}`;
  const newPart = newN === 1 ? `${start}` : `${start},${newN}`;
  return { head: `@@ -${oldPart} +${newPart} @@ context`, lines: body.map(([op, text]) => `${op}${text}`), oldN, newN };
}

function fileDiff(file, bodies) {
  const { name, quoted, tab } = file;
  const shown = quoted ?? name;
  const head = quoted ? `diff --git "a/${quoted.slice(1, -1)}" "b/${quoted.slice(1, -1)}"` : `diff --git a/${name} b/${name}`;
  const hunks = bodies.map((b, i) => hunkText(b, 1 + i * 20));
  const mark = tab ? '\t' : '';
  const side = (p) => (quoted ? `"${p}${quoted.slice(1)}` : `${p}${shown}${mark}`);
  const lines = [head, 'index 1111111..2222222 100644', `--- ${side('a/')}`, `+++ ${side('b/')}`];
  for (const h of hunks) lines.push(h.head, ...h.lines);
  return { lines, hunks: hunks.map((h) => ({ oldLines: h.oldN, newLines: h.newN })) };
}

function diffCase(id, eol, files, extra = []) {
  const parts = files.map(([file, bodies]) => ({ file, ...fileDiff(file, bodies) }));
  const text = [...parts.flatMap((p) => p.lines), ...extra].join(eol) + eol;
  const expect = { files: parts.map((p) => ({ name: p.file.name, hunks: p.hunks })) };
  return make('text', 'diff', id, text, { expect });
}

/** Well-formed diffs. `expect.files` lists the key and the hunk counts of every file. */
export function diffCases() {
  const out = [];
  for (const [fileId, file] of Object.entries(DIFF_FILES)) {
    for (const [bodyId, body] of Object.entries(HUNK_BODIES)) {
      for (const [eolId, eol] of [['lf', '\n'], ['crlf', '\r\n']]) out.push(diffCase(`file=${fileId} body=${bodyId} eol=${eolId}`, eol, [[file, [body]]]));
    }
  }
  out.push(diffCase('two-hunks', '\n', [[DIFF_FILES.plain, [HUNK_BODIES.mixed, HUNK_BODIES['header-lookalike']]]]));
  out.push(diffCase('three-files', '\n', [[DIFF_FILES.plain, [HUNK_BODIES.mixed]], [DIFF_FILES.spaces, [HUNK_BODIES['header-lookalike']]], [DIFF_FILES.unicode, [HUNK_BODIES['add-only']]]]));
  out.push(diffCase('lookalike-last-then-next-file', '\r\n', [[DIFF_FILES.plain, [HUNK_BODIES['header-lookalike']]], [DIFF_FILES.dquote, [HUNK_BODIES['diff-lookalike']]]]));
  return out;
}

const DIFF_SPECIAL = {
  'rename-only': { text: 'diff --git a/old name.mjs b/new name.mjs\nsimilarity index 100%\nrename from old name.mjs\nrename to new name.mjs\n', files: ['new name.mjs'] },
  'new-file': { text: 'diff --git a/n.mjs b/n.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/n.mjs\n@@ -0,0 +1,2 @@\n+a\n+b\n', files: ['n.mjs'] },
  'deleted-file': { text: 'diff --git a/gone.mjs b/gone.mjs\ndeleted file mode 100644\n--- a/gone.mjs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n', files: ['gone.mjs'] },
  'mode-only': { text: 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n', files: ['run.sh'] },
  binary: { text: 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n', files: ['i.png'] },
};

/** Diffs with no hunks or a missing side. `expect.names` are the keys of the result. */
export function diffSpecialCases() {
  const rows = [];
  for (const [id, { text, files }] of Object.entries(DIFF_SPECIAL)) {
    rows.push(make('text', 'diff', `special ${id}`, text, { expect: { names: files } }));
    rows.push(make('text', 'diff', `special ${id} crlf`, text.replaceAll('\n', '\r\n'), { expect: { names: files } }));
  }
  return rows;
}

// ---------- domain: git name-status -z output ----------

const NAMES = ['a.mjs', 'dir/with space/f.mjs', 'caf\u00e9.mjs', "it's.mjs", 'q"uote.mjs', 'tab\there.mjs', 'new\nline.mjs', 'back\\slash.mjs', '-dash.mjs', '~tilde', 'C:weird', 'emoji\u{1F680}.mjs', 'trailing space .mjs', 'R100'];
const PLAIN_STATUS = ['A', 'M', 'D', 'T'];
const MOVE_STATUS = ['R100', 'R087', 'C075'];

function nameStatusRow(n) {
  const status = n % 3 === 0 ? MOVE_STATUS[n % MOVE_STATUS.length] : PLAIN_STATUS[n % PLAIN_STATUS.length];
  const name = NAMES[n % NAMES.length];
  if (/^[RC]/.test(status)) {
    const old = NAMES[(n + 5) % NAMES.length];
    return { tokens: [status, old, name], want: { filename: name, previous_filename: old } };
  }
  return { tokens: [status, name], want: { filename: name } };
}

/** `git diff --name-status -M -z` output built from rows. `expect.files` is what the parser must return. */
export function nameStatusCases() {
  const out = [];
  for (let size = 1; size <= 6; size += 1) {
    for (let start = 0; start < NAMES.length; start += 3) {
      const rows = Array.from({ length: size }, (_, i) => nameStatusRow(start + i));
      const body = rows.flatMap((r) => r.tokens).join('\0');
      out.push(make('path', 'namestatus', `rows=${size} from=${start} nul-end`, `${body}\0`, { expect: { files: rows.map((r) => r.want) } }));
      out.push(make('path', 'namestatus', `rows=${size} from=${start} no-end`, body, { expect: { files: rows.map((r) => r.want) } }));
    }
  }
  return out;
}

const NAME_STATUS_BROKEN = {
  'rename-missing-new': 'R100\0old.mjs\0',
  'rename-missing-both': 'R100\0',
  'status-only': 'M\0',
  'empty-names': 'M\0\0A\0\0',
  'only-nuls': '\0\0\0\0',
  'newline-form': 'M\tfile.mjs\nA\tother.mjs\n',
  'status-with-space': 'M \0a.mjs\0',
};

/** Output that is cut or malformed. The parser must still return a list of well-formed rows. */
export function nameStatusBrokenCases() {
  return Object.entries(NAME_STATUS_BROKEN).map(([id, value]) => make('path', 'namestatus', `broken ${id}`, value, { expect: { files: null } }));
}

// ---------- domain: YAML config ----------

const INS_LINES = {
  one: ['Check the lock order.'],
  hash: ['Check # is not a comment', '# nor is this line'],
  colon: ['Use key: value pairs', 'then: more'],
  bullets: ['- first point', '- second point'],
  blank: ['first paragraph', '', 'second paragraph'],
  nested: ['top', '    indented', '  less', 'back'],
  quotes: ['Say "hi" and \'bye\'', 'back\\slash'],
  unicode: ['caf\u00e9 \u00fcber \u{1F680}'],
  keylike: ['- path: not/an/item', 'instructions: not a key'],
};

const PATH_FORMS = {
  plain: ['src/lib/a.mjs', 'src/lib/a.mjs'],
  dq: ['"src/**/*.ts"', 'src/**/*.ts'],
  dqspace: ['"src/my dir/**"', 'src/my dir/**'],
  dqhash: ['"a#b/**"', 'a#b/**'],
  sq: ["'docs/it''s/**'", "docs/it's/**"],
  comment: ['scripts/lib/x.mjs # note', 'scripts/lib/x.mjs'],
  dqbrace: ['"{src,lib}/**/*.{ts,tsx}"', '{src,lib}/**/*.{ts,tsx}'],
  dqstar: ['"**/*.mjs"', '**/*.mjs'],
};

const INDENT = ' '.repeat(8);

function insForms(lines) {
  const want = lines.join('\n').trim();
  return {
    block: [`|\n${lines.map((l) => (l === '' ? '' : INDENT + l)).join('\n')}`, want],
    dq: [JSON.stringify(want), want],
    // A single-quoted scalar cannot hold a line break here, so a multi-line text uses the double-quoted form.
    sq: want.includes('\n') ? [JSON.stringify(want), want] : [`'${want.replaceAll("'", "''")}'`, want],
  };
}

function piItem([pathText], insText) {
  return `    - path: ${pathText}\n      instructions: ${insText}`;
}

function piYaml(items) {
  return `language: en\nreviews:\n  profile: chill\n  path_instructions:\n${items.join('\n')}\n\n  auto_review:\n    enabled: true\n`;
}

function fpYaml(rows) {
  const body = rows.map(([files, apply]) => `      - files: ${files}${apply === null ? '' : `\n        applyTo: ${apply}`}`).join('\n');
  return `knowledge_base:\n  code_guidelines:\n    enabled: true\n    filePatterns:\n${body}\n  other: 1\n`;
}

const FP_ROWS = [
  [['docs/GUIDE.md', 'docs/GUIDE.md'], ['"**/*.mjs"', '**/*.mjs']],
  [['"docs/my guide.md"', 'docs/my guide.md'], null],
  [["'docs/it''s.md'", "docs/it's.md"], ['"src/**"', 'src/**']],
  [['docs/x.md # why', 'docs/x.md'], ['"a#b/**"', 'a#b/**']],
];

function yamlCase(id, pi, fp, eol) {
  const text = [pi ? piYaml(pi.items) : '', fp ? fpYaml(fp.rows) : ''].join('');
  const value = eol === '\n' ? text : text.replaceAll('\n', eol);
  const expect = { pi: pi ? pi.want : [], fp: fp ? fp.want : [] };
  return make('text', 'yaml', id, value, { expect });
}

function piParts(pathIds, insId) {
  const items = [];
  const want = [];
  pathIds.forEach((pid, i) => {
    const [pathText, pathWant] = PATH_FORMS[pid];
    const forms = insForms(INS_LINES[insId.lines[i % insId.lines.length]]);
    const [insText, insWant] = forms[insId.form];
    items.push(piItem([pathText], insText));
    want.push({ path: pathWant, instructions: insWant });
  });
  return { items, want };
}

function fpParts(rows) {
  const items = rows.map(([f, a]) => [f[0], a === null ? null : a[0]]);
  const want = rows.map(([f, a]) => ({ files: f[1], applyTo: a === null ? '**' : a[1] }));
  return { rows: items, want };
}

/** Config documents. `expect.pi` is the path_instructions list and `expect.fp` the filePatterns list the parsers must return. */
export function yamlCases() {
  const out = [];
  const lineIds = Object.keys(INS_LINES);
  const pathIds = Object.keys(PATH_FORMS);
  let n = 0;
  for (const form of ['block', 'dq', 'sq']) {
    for (const eol of ['\n', '\r\n']) {
      lineIds.forEach((lineId) => {
        const ids = [pathIds[n % pathIds.length], pathIds[(n + 3) % pathIds.length]];
        const pi = piParts(ids, { lines: [lineId, lineIds[(n + 1) % lineIds.length]], form });
        out.push(yamlCase(`pi form=${form} lines=${lineId} eol=${eol === '\n' ? 'lf' : 'crlf'} #${n}`, pi, null, eol));
        n += 1;
      });
    }
  }
  const fp = fpParts(FP_ROWS);
  for (const eol of ['\n', '\r\n']) out.push(yamlCase(`fp eol=${eol === '\n' ? 'lf' : 'crlf'}`, null, fp, eol));
  const both = piParts([pathIds[0], pathIds[1]], { lines: ['one', 'blank'], form: 'block' });
  out.push(yamlCase('pi and fp together', both, fp, '\n'));
  out.push(yamlCase('neither key', null, null, '\n'));
  return out;
}

const YAML_WEIRD = {
  'no-instructions': 'path_instructions:\n  - path: x\n',
  'empty-instructions': 'path_instructions:\n  - path: x\n    instructions: ""\n',
  'flow-list': 'path_instructions: [a, b]\n',
  'flow-item': 'path_instructions:\n  - {path: x, instructions: y}\n',
  'plain-instructions': 'path_instructions:\n  - path: x\n    instructions: plain text\n',
  'folded-instructions': 'path_instructions:\n  - path: x\n    instructions: >\n      folded\n',
  'path-flow': 'path_instructions:\n  - path: [a]\n    instructions: "y"\n',
  'unknown-line': 'path_instructions:\n  - path: x\n    other: 1\n',
  'tab-indent': 'path_instructions:\n\t- path: x\n\t  instructions: "y"\n',
  'unclosed-quote': 'path_instructions:\n  - path: "x\n    instructions: "y"\n',
  'bad-escape': 'path_instructions:\n  - path: x\n    instructions: "\\q"\n',
  'files-no-apply': 'filePatterns:\n  - files: x\n',
  'apply-first': 'filePatterns:\n  - applyTo: x\n',
  'files-flow': 'filePatterns:\n  - {files: x}\n',
  'files-empty': 'filePatterns:\n  - files: ""\n',
  'unknown-pattern-line': 'filePatterns:\n  - files: x\n    other: 1\n',
  'key-twice': 'path_instructions:\npath_instructions:\n',
  'key-only': 'path_instructions:',
  'comment-only': '# path_instructions:\n',
};

/** Config documents the readers do not support. The reader may return a list or throw an Error that names its key. */
export function yamlWeirdCases() {
  return Object.entries(YAML_WEIRD).map(([id, value]) => make('text', 'yaml', `weird ${id}`, value, { expect: { pi: null, fp: null } }));
}

// ---------- selecting ----------

/** All cases for one selector: "text", "text:diff" and so on. */
export function casesFor(selector) {
  const [cls, domain] = selector.split(':');
  const table = {
    text: { '': textCases, error: errorValueCases, secret: secretCases, control: controlCases, diff: () => [...diffCases(), ...diffSpecialCases()], yaml: () => [...yamlCases(), ...yamlWeirdCases()] },
    path: { '': pathCases, scrub: scrubCases, namestatus: () => [...nameStatusCases(), ...nameStatusBrokenCases()] },
    argv: { '': argvCases },
    prose: { '': proseCases, steps: stepsBlockCases, restate: restateCases },
  };
  const make_ = table[cls]?.[domain ?? ''];
  if (!make_) throw new Error(`parser-fixtures: unknown input selector "${selector}"`);
  return make_();
}
