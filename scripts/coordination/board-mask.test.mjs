/**
 * board-mask.test -- tests for the listed-id mask of the lane board page (card coord-board-mask-listed-ids).
 *
 * Every id in this file is MADE UP (PR 4242, comment 9000000123, shas that are plain hex runs). No real id is read, printed or stored here.
 * The list comes in as an argument: no environment switch and no flag points the mask at another list.
 *
 * How the mask can fail, one test each:
 *   - a listed id in one of its forms (#N, PR N, pull/N, a long comment id, a <pr>:<id> key, a full sha, a sha prefix either way) stays on the page
 *   - an id that the hook would not count (a bare short number, a date, a millisecond time stamp) is changed, or a page with no listed id changes at all
 *   - the token is itself counted as an id, or a second mask changes the first one's output
 *   - the token breaks the page: the JSON of the kb-data block, an HTML attribute, or the path of a link
 *   - an id past the first 1 MiB of a big page is not masked or not checked, or the checked byte count is not the page size
 *   - an absent, unreadable, malformed or empty list gives a page on board continuous-claude, or a malformed one gives a page on another board
 *   - an ABSENT list stops the page of another board (a board root has no dataset by design)
 *   - a hit left after the mask passes on any board
 *   - the failure line or the readIdList error holds file content or an id
 *   - the two file names or the sha rule drift from the hook (tie tests read the hook text)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countIdsIn, holdoutIdsOf } from '../github/lib/holdout-ids.mjs';
import * as boardMask from './board-mask.mjs';
import { DATASET_REL, EVAL_CONFIG_REL, TOKEN, countListed, finishPage, maskListed, readIdList } from './board-mask.mjs';

// New export of card coord-board-mask-ids. Read off the namespace so the RED run on main fails per test, not at import.
const maskLaneRows = (...a) => {
  if (typeof boardMask.maskLaneRows !== 'function') throw new Error('maskLaneRows is not exported');
  return boardMask.maskLaneRows(...a);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const DS = { prs: [{ pr: 4242 }], findings: [{ pr: 4242, comment_id: 9000000123, round: SHA }] };
const IDS = holdoutIdsOf(DS, {});
const DEFAULT_BOARD = 'continuous-claude';

describe('the made-up list is what the tests think it is', () => {
  it('holds the PR number, the comment id, the key and the sha', () => {
    for (const id of ['4242', '9000000123', '4242:9000000123', SHA]) assert.ok(IDS.includes(id), `missing ${id}`);
  });
});

describe('maskListed: each form of a listed id', () => {
  const cases = [
    ['#N', 'landed in #4242 today', `landed in #${TOKEN} today`],
    ['PR N', 'see PR 4242 now', `see PR ${TOKEN} now`],
    ['PR #N', 'see PR #4242 now', `see PR #${TOKEN} now`],
    ['pull/N', 'https://github.com/o/r/pull/4242/files', `https://github.com/o/r/pull/${TOKEN}/files`],
    ['a long comment id as a bare run', 'comment 9000000123 said', `comment ${TOKEN} said`],
    ['a <pr>:<id> key', 'finding 4242:9000000123 open', `finding ${TOKEN} open`],
    ['a full sha', `head ${SHA} pushed`, `head ${TOKEN} pushed`],
    ['a text sha that is a prefix of a stored sha (7 hex)', 'head abcdef1 pushed', `head ${TOKEN} pushed`],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => {
      const r = maskListed(text, IDS);
      assert.equal(r.text, want);
      assert.ok(r.masked >= 1, 'the count is a number above 0');
      assert.equal(countListed(r.text, IDS), 0, 'a hit is left after the mask');
    });
  }

  it('a stored short sha that is a prefix of a longer text sha (the reverse direction)', () => {
    const ids = holdoutIdsOf({ findings: [{ pr: 77, round: 'fedcba9' }] }, {});
    const r = maskListed('head fedcba9876543210fedc pushed', ids);
    assert.equal(r.text, `head ${TOKEN} pushed`);
    assert.equal(countListed(r.text, ids), 0);
  });
});

describe('maskListed: what stays', () => {
  it('a bare short number, a date, a millisecond time and a version are not ids', () => {
    const text = 'issue 4242 on 2026-11-15 at 1794791592000, version 1.2.3, row 42424';
    const r = maskListed(text, IDS);
    assert.equal(r.text, text);
    assert.equal(r.masked, 0);
  });

  it('a page with no listed id is returned byte for byte', () => {
    const text = '<html>\r\n<p>no id here</p>\n\tend</html>';
    assert.equal(maskListed(text, IDS).text, text);
  });

  it('an empty text and an empty list change nothing', () => {
    assert.equal(maskListed('', IDS).text, '');
    assert.equal(maskListed('PR 4242', []).text, 'PR 4242');
  });

  it('the token holds no listed id, and a second mask changes nothing', () => {
    const once = maskListed(`PR 4242, ${SHA}, 4242:9000000123`, IDS);
    assert.equal(countListed(TOKEN, IDS), 0);
    assert.equal(maskListed(once.text, IDS).text, once.text);
    assert.equal(maskListed(once.text, IDS).masked, 0);
  });
});

describe('maskListed: the page still works', () => {
  it('the JSON of a kb-data block parses after the mask, with the token in the string', () => {
    const json = JSON.stringify({ lanes: [{ id: 'x', note: 'see PR 4242 and 9000000123', sha: SHA }] });
    const page = `<script type="application/json" id="kb-data">${json}</script>`;
    const r = maskListed(page, IDS);
    const m = /<script type="application\/json" id="kb-data">([\s\S]*?)<\/script>/.exec(r.text);
    const data = JSON.parse(m[1]);
    assert.equal(data.lanes[0].note, `see PR ${TOKEN} and ${TOKEN}`);
    assert.equal(data.lanes[0].sha, TOKEN);
  });

  it('an HTML attribute stays one attribute, and a link path has no space and no bracket', () => {
    const page = `<a href="https://github.com/o/r/pull/4242" title="PR #4242 ${SHA}">x</a>`;
    const r = maskListed(page, IDS);
    const href = /href="([^"]*)"/.exec(r.text)[1];
    const title = /title="([^"]*)"/.exec(r.text)[1];
    assert.equal(href, `https://github.com/o/r/pull/${TOKEN}`);
    assert.ok(!/[\s\[\]]/.test(href), 'the link path has a space or a bracket');
    assert.equal(title, `PR #${TOKEN} ${TOKEN}`);
    assert.equal((r.text.match(/"/g) ?? []).length, 4, 'the quotes changed');
  });
});

describe('finishPage: the whole page is checked', () => {
  it('masks an id at 1.5 MiB of a 2 MiB page and says how many bytes it checked', () => {
    const pad = 'x'.repeat(1.5 * 1024 * 1024);
    const html = `${pad} PR 4242 ${'y'.repeat(0.5 * 1024 * 1024)}`;
    const r = finishPage({ html, board: DEFAULT_BOARD, defaultBoard: DEFAULT_BOARD, readList: () => IDS });
    assert.equal(r.ok, true);
    assert.equal(r.masked, 1);
    assert.equal(r.left, 0);
    assert.equal(r.bytes, Buffer.byteLength(r.html));
    assert.ok(!r.html.includes('4242'));
    assert.match(r.line, /^masked 1, left 0, bytes checked \d+$/);
  });

  it('a page with no listed id gives masked 0, left 0 and the same page', () => {
    const html = '<html>plain</html>';
    const r = finishPage({ html, board: DEFAULT_BOARD, defaultBoard: DEFAULT_BOARD, readList: () => IDS });
    assert.equal(r.ok, true);
    assert.equal(r.html, html);
    assert.equal(r.line, `masked 0, left 0, bytes checked ${Buffer.byteLength(html)}`);
  });
});

describe('finishPage: fail closed by board', () => {
  const fail = (kind) => () => { const e = new Error('fixed text'); e.kind = kind; throw e; };
  const run = (over) => finishPage({ html: 'PR 4242', board: DEFAULT_BOARD, defaultBoard: DEFAULT_BOARD, readList: () => IDS, ...over });
  const NO_PAGE = 'render-board: the listed-id list could not be read; no page written';

  for (const kind of ['absent', 'bad', 'empty']) {
    it(`board continuous-claude: a list that is ${kind} is exit 3 and no page`, () => {
      const r = run({ readList: fail(kind) });
      assert.equal(r.ok, false);
      assert.equal(r.exit, 3);
      assert.equal(r.html, null);
      assert.equal(r.line, NO_PAGE);
    });
  }

  it('board continuous-claude: a list with no ids is exit 3 and no page', () => {
    const r = run({ readList: () => [] });
    assert.equal(r.ok, false);
    assert.equal(r.exit, 3);
    assert.equal(r.html, null);
  });

  it('every board: a hit left after the mask is exit 3 and no page', () => {
    const noop = (text) => ({ text, masked: 0 });
    for (const board of [DEFAULT_BOARD, 'minions']) {
      const r = run({ board, mask: noop });
      assert.equal(r.ok, false, board);
      assert.equal(r.exit, 3, board);
      assert.equal(r.html, null, board);
      assert.equal(r.line, 'render-board: a listed id is left after the mask; no page written', board);
    }
  });

  it('another board: an ABSENT list renders the page unmasked and prints one fixed note', () => {
    const r = run({ html: 'PR 4242 stays', board: 'minions', readList: fail('absent') });
    assert.equal(r.ok, true);
    assert.equal(r.exit, 0);
    assert.equal(r.html, 'PR 4242 stays');
    assert.equal(r.line, 'render-board: note: this board has no listed-id list; the page is not masked');
  });

  it('another board: a list that is present but malformed or empty is exit 3 and no page', () => {
    for (const kind of ['bad', 'empty']) {
      const r = run({ board: 'minions', readList: fail(kind) });
      assert.equal(r.ok, false, kind);
      assert.equal(r.exit, 3, kind);
      assert.equal(r.html, null, kind);
    }
  });

  it('another board: a readable list masks the page', () => {
    const r = run({ board: 'minions' });
    assert.equal(r.ok, true);
    assert.equal(r.html, `PR ${TOKEN}`);
  });

  it('a reader that throws with no kind counts as a bad list', () => {
    const r = run({ readList: () => { throw new Error('boom'); } });
    assert.equal(r.exit, 3);
  });

  it('the failure lines hold no digit run or sha of an id', () => {
    const lines = [run({ readList: fail('bad') }).line, run({ mask: (t) => ({ text: t, masked: 0 }) }).line,
      run({ board: 'minions', readList: fail('absent') }).line];
    for (const line of lines) assert.ok(!/4242|9000000123|abcdef/.test(line), line);
  });
});

describe('readIdList: the list from a root, with the file reader passed in', () => {
  const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; return e; };
  const files = (map) => (p) => {
    for (const [k, v] of Object.entries(map)) if (p.replace(/\\/g, '/').endsWith(k)) return v;
    throw enoent();
  };
  const good = { [DATASET_REL]: JSON.stringify(DS), [EVAL_CONFIG_REL]: JSON.stringify({}) };
  const kindOf = (map) => { try { readIdList('/some/root', files(map)); } catch (e) { return [e.kind, e.message]; } return null; };

  it('reads the dataset and the config of the root and returns the ids', () => {
    const ids = readIdList('/some/root', files(good));
    assert.ok(ids.includes('4242') && ids.includes(SHA));
  });

  it('a missing dataset file is kind absent, with a fixed text', () => {
    assert.deepEqual(kindOf({ [EVAL_CONFIG_REL]: '{}' }), ['absent', 'the listed id list is absent']);
  });

  it('a missing config file, bad JSON and an empty list are not absent, and hold no file content', () => {
    assert.deepEqual(kindOf({ [DATASET_REL]: JSON.stringify(DS) }), ['bad', 'the listed id list could not be read']);
    assert.deepEqual(kindOf({ [DATASET_REL]: '{ not json 4242', [EVAL_CONFIG_REL]: '{}' }), ['bad', 'the listed id list could not be read']);
    assert.deepEqual(kindOf({ [DATASET_REL]: JSON.stringify({ prs: [], findings: [] }), [EVAL_CONFIG_REL]: '{}' }), ['empty', 'the listed id list is empty']);
  });
});

// ---- gold ids (card coord-content-scan-followups, item gold ids): the gold files add their ids to the list. Every id is made up. ----
describe('readIdList: the gold folder adds its ids (a missing folder adds none; a broken one throws)', () => {
  const GOLD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
  const OTHER_SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
  const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; return e; };
  const baseFiles = { [DATASET_REL]: JSON.stringify(DS), [EVAL_CONFIG_REL]: JSON.stringify({}) };
  const reader = (map) => (p) => { for (const [k, v] of Object.entries(map)) if (p.replace(/\\/g, '/').endsWith(k)) return v; throw enoent(); };
  const goldMap = async (extra) => { const { GOLD_DIR_REL } = await import('./board-mask.mjs'); return Object.fromEntries(Object.entries(extra).map(([n, v]) => [`${GOLD_DIR_REL}/${n}`, typeof v === 'string' ? v : JSON.stringify(v)])); };
  const list = (names) => () => names;
  const kind = (fn) => { try { fn(); } catch (e) { return [e.kind, e.message]; } return null; };

  it('GM1: every json file of the gold folder but the non-row file adds its shas and its 4-digit PR numbers', async () => {
    const gold = await goldMap({ 'gold-a.json': [{ target: { pr: 8888, sha40: GOLD_SHA, round: 1 }, provenance: { fixSha: OTHER_SHA, head: SHA } }, { target: { pr: 77 } }], 'clean-controls.json': [{ target: { pr: 9999, sha40: GOLD_SHA } }], 'escape-baseline.json': [{ note: 'abcdef0123456789abcdef0123456789abcdef99' }] });
    const ids = readIdList('/some/root', reader({ ...baseFiles, ...gold }), list(['gold-a.json', 'clean-controls.json', 'escape-baseline.json', 'adjudicated-cr.state']));
    for (const id of ['4242', SHA, GOLD_SHA, OTHER_SHA, '8888', '9999']) assert.ok(ids.includes(id), id);
    assert.ok(!ids.includes('77'), 'a 2-digit gold PR number is not listed');
    assert.ok(!ids.includes('abcdef0123456789abcdef0123456789abcdef99'), 'the non-row file is not read');
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.filter((x) => x === SHA).length, 1, 'an id in both lists stands once');
  });

  it('GM2: a missing gold folder adds no id and leaves the holdout list as it was', async () => {
    const noFolder = () => { throw enoent(); };
    assert.deepEqual(readIdList('/some/root', reader(baseFiles), noFolder).sort(), readIdList('/some/root', reader(baseFiles)).sort());
    assert.ok(readIdList('/some/root', reader(baseFiles), noFolder).includes('4242'));
  });

  it('GM3: a gold folder that cannot be read, a broken file and a wrong shape are kind bad with a fixed text and no file content', async () => {
    const secret = 'zebra-quartz-secret';
    const text = 'the listed id list could not be read';
    const denied = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
    assert.deepEqual(kind(() => readIdList('/some/root', reader(baseFiles), denied)), ['bad', text]);
    for (const value of [`{ not json ${secret}`, [{ target: { pr: 8888 } }], { rows: secret }]) {
      const gold = await goldMap({ 'gold-a.json': value });
      assert.deepEqual(kind(() => readIdList('/some/root', reader({ ...baseFiles, ...gold }), list(['gold-a.json']))), ['bad', text]);
    }
    const missingFile = reader(baseFiles); // the folder lists a file that cannot be read
    assert.deepEqual(kind(() => readIdList('/some/root', missingFile, list(['gold-a.json']))), ['bad', text]);
  });

  it('GM4: a gold sha in a page is counted and masked like a holdout id', async () => {
    const gold = await goldMap({ 'gold-a.json': [{ target: { sha40: GOLD_SHA } }] });
    const ids = readIdList('/some/root', reader({ ...baseFiles, ...gold }), list(['gold-a.json']));
    const page = `<p>fix ${GOLD_SHA.slice(0, 10)} and ${SHA}</p>`;
    assert.equal(countListed(page, ids), 2);
    const m = maskListed(page, ids);
    assert.equal(countListed(m.text, ids), 0);
    assert.ok(!m.text.includes(GOLD_SHA.slice(0, 10)));
  });

  it('GM5: a root with no dataset is still absent, whatever the gold folder holds', async () => {
    const gold = await goldMap({ 'gold-a.json': [{ target: { sha40: GOLD_SHA } }] });
    assert.deepEqual(kind(() => readIdList('/some/root', reader({ [EVAL_CONFIG_REL]: '{}', ...gold }), list(['gold-a.json']))), ['absent', 'the listed id list is absent']);
  });

  it('GM6: tie: the gold folder name and the non-row file are the ones the hook reads (shared/gold-ids.ts)', async () => {
    const hookIds = readFileSync(join(REPO, '.claude/hooks/src/shared/gold-ids.ts'), 'utf8');
    const { GOLD_DIR_REL, GOLD_NON_ROW_FILES } = await import('./board-mask.mjs');
    assert.ok(hookIds.includes(`'${GOLD_DIR_REL}'`), 'the gold folder name drifted from shared/gold-ids.ts');
    for (const name of GOLD_NON_ROW_FILES) assert.ok(hookIds.includes(`'${name}'`), 'a non-row file name drifted from shared/gold-ids.ts');
  });
});

describe('tie tests: the hook text and this module stay in step', () => {
  const hookIds = readFileSync(join(REPO, '.claude/hooks/src/shared/holdout-ids.ts'), 'utf8');
  const holdoutLib = readFileSync(join(REPO, 'scripts/github/lib/holdout-ids.mjs'), 'utf8');

  it('the two file names are the ones the hook reads', () => {
    assert.ok(hookIds.includes(`'${DATASET_REL}'`), 'the dataset name drifted from shared/holdout-ids.ts');
    assert.ok(hookIds.includes(`'${EVAL_CONFIG_REL}'`), 'the config name drifted from shared/holdout-ids.ts');
  });

  it('the sha rule is the one of scripts/github/lib/holdout-ids.mjs countIdsIn (7 to 40 hex, a prefix in either direction, a letter in the stored sha)', () => {
    assert.ok(holdoutLib.includes('[0-9a-f]{7,40}'), 'the hex run changed in holdout-ids.mjs');
    assert.ok(holdoutLib.includes('want.startsWith(r) || r.startsWith(want)'), 'the prefix rule changed in holdout-ids.mjs');
    assert.ok(holdoutLib.includes('/^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id)'), 'the stored-sha rule changed in holdout-ids.mjs');
  });
});

// ---- card coord-board-mask-ids (design .claudedocs/coordination/2026-11-17-coord-board-mask-ids-design.md, revision 2) ----
// Every id below is MADE UP. The mask must be exactly as wide as countIdsIn: no listed form left, no ordinary text changed.

const HEX64_FREE = '0123456789abcdef'.repeat(4); // 64 hex, holds no made-up sha
const STR_ID = 'zz-mask_probe.id+x&y'; // a made-up non-digit, non-hex id with regex and HTML characters
const STR_IDS = [...IDS, STR_ID];
const DIGIT_SHA = '1234567abcdef0123456789abcdef0123456789a'; // a made-up stored sha that starts with digits
const STRKEY_IDS = holdoutIdsOf({ prs: [{ pr: 4242 }], findings: [{ pr: 4242, comment_id: 'beadfacebeadfacebeadface', round: SHA }] }, {});

describe('coord-board-mask-ids: a hex run over 40 characters (D2)', () => {
  const runs = [
    ['the sha at the start', SHA + 'ff00ff00ff'],
    ['the sha in the middle', 'ff00ff00ff' + SHA + 'ff00ff00ff'],
    ['the sha at the end', 'ff00ff00ff' + SHA],
  ];
  for (const [name, run] of runs) {
    it(`${name}: counted before the mask, the whole run masked, 0 after`, () => {
      const text = `hash ${run} end`;
      assert.ok(run.length > 40, 'setup: the run is over 40');
      assert.ok(countListed(text, IDS) > 0, 'the count misses a listed sha inside a long run');
      const r = maskListed(text, IDS);
      assert.equal(r.text, `hash ${TOKEN} end`);
      assert.equal(countListed(r.text, IDS), 0);
    });
  }
  it('a 64-hex run with no listed sha stays as it is', () => {
    const text = `content hash ${HEX64_FREE}`;
    assert.equal(maskListed(text, IDS).text, text);
    assert.equal(countListed(text, IDS), 0);
  });
});

describe('coord-board-mask-ids: an all-digit run that is a prefix of a stored sha (critic 5)', () => {
  it('is counted by the matcher, so the mask takes it', () => {
    const ids = holdoutIdsOf({ findings: [{ pr: 88, round: DIGIT_SHA }] }, {});
    const text = 'ref 1234567 here';
    assert.ok(countIdsIn(text, ids) > 0, 'setup: the matcher counts it');
    assert.equal(maskListed(text, ids).text, `ref ${TOKEN} here`);
  });
});

describe('coord-board-mask-ids: a listed id that is not digits, a key or a sha (D1)', () => {
  it('is masked, in any letter case, and 0 is left', () => {
    for (const form of [STR_ID, STR_ID.toUpperCase()]) {
      const r = maskListed(`see ${form} here`, STR_IDS);
      assert.equal(r.text, `see ${TOKEN} here`, form);
      assert.equal(countListed(r.text, STR_IDS), 0);
    }
  });
  it('inside a longer word (a hex letter or digit next to it) it is neither masked nor counted: parity with the matcher', () => {
    for (const text of [`a${STR_ID}`, `${STR_ID}7`, `B${STR_ID}`]) {
      assert.equal(countIdsIn(text, STR_IDS), 0, 'setup: the matcher does not count it');
      assert.equal(maskListed(text, STR_IDS).text, text);
    }
  });
  it('a <pr>:<string id> key is masked whole', () => {
    const r = maskListed('finding 4242:beadfacebeadfacebeadface open', STRKEY_IDS);
    assert.equal(r.text, `finding ${TOKEN} open`);
    assert.equal(countListed(r.text, STRKEY_IDS), 0);
  });
});

describe('coord-board-mask-ids: the invariant of mask and count (seat item 3)', () => {
  const sample = [
    'landed in #4242 today', 'PR 4242', 'comment 9000000123', 'finding 4242:9000000123', `head ${SHA}`, 'head abcdef1',
    `hash ${SHA}00ff00ff00`, `hash 00ff00ff00${SHA}00ff`, `see ${STR_ID} and ${STR_ID.toUpperCase()}`, 'ref 1234567 x',
    'a bare 4242 and 2026-11-17 and 1700000000000', `content ${HEX64_FREE}`, `a${STR_ID}`, 'plain words only',
    `see ${STR_ID.replace('k', 'K')} now`, // critic 2-6: the Kelvin sign lowercases to k in the matcher
  ];
  const ids = [...STR_IDS, ...holdoutIdsOf({ findings: [{ pr: 88, round: DIGIT_SHA }] }, {})];
  it('the masked text of every sample has a count of 0', () => {
    for (const x of sample) assert.equal(countIdsIn(maskListed(x, ids).text, ids), 0, x.slice(0, 20));
  });
  it('a sample with a count of 0 is not changed', () => {
    for (const x of sample) if (countIdsIn(x, ids) === 0) assert.equal(maskListed(x, ids).text, x, x.slice(0, 20));
  });
  it('countListed is the matcher (no second rule to drift)', () => {
    for (const x of sample) assert.equal(countListed(x, ids), countIdsIn(x, ids), x.slice(0, 20));
  });
});

describe('coord-board-mask-ids: maskLaneRows masks every displayed lane text at the source', () => {
  it('lane title, scope, note, track; session working_on and its lanes; event body. Ids, uuids and times stay', () => {
    const uuid = 'f0f0f0f0-0000-4000-8000-000000000001'; // no hex run of it is a prefix of the made-up sha
    const lanes = [{ id: 'lane-a', title: 'fix #4242', scope: `sha ${SHA}`, note: `see ${STR_ID}`, track: 'PR 4242', owner_session_id: uuid, waits_on: ['lane-b'] }];
    const sessions = [{ id: uuid, working_on: 'on #4242', lanes: [{ id: 'lane-a', title: 'PR 4242', scope: 'x 9000000123', note: 'ok' }] }];
    const events = [{ id: 1, lane_id: 'lane-a', session_id: uuid, body: `pushed ${SHA}`, occurred_at: '2026-11-17T00:00:00Z' }];
    const n = maskLaneRows({ lanes, sessions, events }, STR_IDS);
    assert.ok(n >= 7, `masked count ${n}`);
    const all = JSON.stringify({ lanes, sessions, events });
    assert.equal(countIdsIn(all, STR_IDS), 0, 'a listed id is left in the rows');
    assert.equal(lanes[0].owner_session_id, uuid);
    assert.equal(events[0].session_id, uuid);
    assert.deepEqual(lanes[0].waits_on, ['lane-b']);
    assert.equal(lanes[0].id, 'lane-a');
  });
  it('critic 2-1: a run of spaces or an invisible mark that the browser collapses is masked at the source', () => {
    const lanes = [
      { id: 'l1', note: 'see PR       4242 now' }, // 7 spaces: the matcher's 8-character look-back misses it; the browser shows "PR 4242"
      { id: 'l2', note: 'see PR ͏4242 now' }, // a combining grapheme joiner (default ignorable) before the number
      { id: 'l3', branch: 'fix/PR 4242', done_when: 'PR 4242 lands', rationale: 'see #4242' }, // the other lane text fields
    ];
    maskLaneRows({ lanes, sessions: [], events: [] }, IDS);
    for (const l of lanes) for (const k of ['note', 'branch', 'done_when', 'rationale']) if (l[k]) assert.ok(!l[k].includes('4242'), `${l.id}.${k} keeps the id`);
  });
  it('rows with no listed id are not changed, and null fields stay null', () => {
    const lanes = [{ id: 'l', title: 'plain', scope: null, note: undefined, track: 'coord' }];
    const before = JSON.stringify(lanes);
    assert.equal(maskLaneRows({ lanes, sessions: [], events: [] }, IDS), 0);
    assert.equal(JSON.stringify(lanes), before);
  });
});

describe('coord-board-mask-ids: finishPage counts the display text too (D3, critic P0)', () => {
  const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
  const run = (html) => finishPage({ html, board: DEFAULT_BOARD, defaultBoard: DEFAULT_BOARD, readList: () => IDS });
  it('an id behind a numeric entity (#) is refused: exit 3, no page', () => {
    const r = run(page('landed in &#35;4242 today'));
    assert.equal(r.exit, 3);
    assert.equal(r.html, null);
  });
  it('an id split by a JSON escape in an application/json block is refused', () => {
    const json = JSON.stringify([{ note: 'PR\n4242' }]);
    const r = run(page(`<script type="application/json" id="kb-data">${json}</script>`));
    assert.equal(r.exit, 3);
  });
  it('an id in fullwidth digits or split by a zero-width space is refused', () => {
    assert.equal(run(page('see #４２４２ now')).exit, 3);
    assert.equal(run(page('see PR 42​42 now')).exit, 3);
  });
  it('a normal page with entities, apostrophes, an empty JSON block and a bad code point publishes', () => {
    const html = page(`a &middot; b &#8942; it&#39;s &amp; done &#99999999; <script type="application/json" id="kb-data"></script><script type="application/json" id="kb-sched">[]</script>`);
    const r = run(html);
    assert.equal(r.exit, 0, r.line);
    assert.equal(r.html, html);
  });
  it('critic 2-1: a run of spaces between PR and a listed number is refused (the browser collapses it)', () => {
    assert.equal(run(page('see PR       4242 now')).exit, 3);
  });
  it('critic 2-7: two JSON strings are counted one by one, so "...PR" then "4242..." in the next field is no hit', () => {
    const json = JSON.stringify([{ title: 'a title that ends with PR' }, { note: '4242 is a bare number here' }]);
    assert.equal(run(page(`<script type="application/json" id="kb-data">${json}</script>`)).exit, 0);
  });
  it('a JSON block that does not parse is refused (the browser could not read it either)', () => {
    assert.equal(run(page('<script type="application/json" id="kb-data">[{"a":</script>')).exit, 3);
  });
});
