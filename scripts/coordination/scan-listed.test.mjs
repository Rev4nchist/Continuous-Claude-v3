/**
 * scan-listed.test.mjs -- card listed-id-scan-tool. One scan of listed ids for builders and the seat.
 *
 * Synthetic ids only. Every list is built in a temp folder (a made-up dataset, config and gold folder) and the tool is pointed at it with --root.
 * SCAN_LISTED_CLI points the tests at another copy of the script (a mutation run). Rows S1..S24 are the failure list of the plan.
 * The real list is never read here: it is git-ignored, so CI has none. A local probe with the real list prints counts only.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATASET_REL, EVAL_CONFIG_REL, GOLD_DIR_REL, countListed, readIdList } from './board-mask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.SCAN_LISTED_CLI ? path.resolve(process.env.SCAN_LISTED_CLI) : path.join(HERE, 'scan-listed.mjs');
const REPO = path.resolve(HERE, '..', '..');

// Made-up ids. HOLD3 and HOLD4 are holdout PR numbers (3 and 4 digits). RES3 and RES2 are reserve PRs (in the rubric set only). GOLD4 is a gold PR of 4
// digits (in both lists), GOLD3 one of 3 digits (rubric set only, the gate floor is 4). COMMENT is a comment id of 10 digits. SHA is a gold sha.
const HOLD3 = '321';
const HOLD4 = '4711';
const RES3 = '555';
const RES2 = '77';
const GOLD4 = '9876';
const GOLD3 = '654';
const COMMENT = '1234567890';
const KEY = `${HOLD4}:${COMMENT}`;
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const LONG_IDS = [COMMENT, KEY, SHA];

let tmp = null;
let n = 0;
// The temp folder is made on first use: a describe block builds its list root while the file is collected, before any hook runs.
const folder = () => { tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), 'scan-listed-')); const d = path.join(tmp, `case${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** A board root with a synthetic list. Options drop a part so a row can test a missing or a broken list. */
function listRoot({ dataset, config, gold = true } = {}) {
  const root = folder();
  fs.mkdirSync(path.join(root, path.dirname(EVAL_CONFIG_REL)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, DATASET_REL)), { recursive: true });
  const ds = dataset ?? { prs: [{ pr: Number(HOLD3) }, { pr: Number(HOLD4) }], findings: [{ pr: Number(HOLD4), comment_id: Number(COMMENT) }] };
  fs.writeFileSync(path.join(root, DATASET_REL), typeof ds === 'string' ? ds : JSON.stringify(ds));
  fs.writeFileSync(path.join(root, EVAL_CONFIG_REL), JSON.stringify(config ?? { reserve: [{ pr: Number(RES3) }, { pr: Number(RES2) }], holdoutExclude: [] }));
  if (gold) {
    fs.mkdirSync(path.join(root, GOLD_DIR_REL), { recursive: true });
    fs.writeFileSync(path.join(root, GOLD_DIR_REL, 'rows.json'), JSON.stringify([{ target: { pr: Number(GOLD4), sha40: SHA } }, { target: { pr: Number(GOLD3) } }]));
  }
  return root;
}

const put = (text) => { const f = path.join(folder(), 'text.md'); fs.writeFileSync(f, text); return f; };
const run = (args, input) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: folder(), input });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
/** Scans `text` with the tool (--json) against `root`. Returns the parsed result and the raw streams. */
function scan(root, text, flags = []) {
  const r = run(['--root', root, '--json', ...flags, put(text)]);
  let json = null;
  try { json = JSON.parse(r.out); } catch { /* a row that expects JSON fails on the missing fields */ }
  return { ...r, json, gate: json?.gate, strict: json?.strict, hits: json?.files?.[0]?.hits ?? [] };
}
const rules = (res) => res.hits.map((h) => h.rule);

describe('S1 to S5: the number rules', () => {
  const root = listRoot();
  it('S1 a listed short number after "PR " is a gate hit and a strict hit, rule pr-ref', () => {
    const r = scan(root, `see PR ${HOLD4} now`);
    assert.equal(r.gate, 1);
    assert.equal(r.strict, 1);
    assert.deepEqual(rules(r), ['pr-ref']);
    assert.equal(r.code, 1);
  });
  it('S1b the same for a 3 digit number', () => {
    const r = scan(root, `PR ${HOLD3}`);
    assert.equal(r.gate, 1);
    assert.deepEqual(rules(r), ['pr-ref']);
  });
  it('S2 every context form after # PR pr pull/ pulls/ issues/ pr- hits', () => {
    for (const text of [`pr ${HOLD4}`, `PR#${HOLD4}`, `PR # ${HOLD4}`, `#${HOLD4}`, `pull/${HOLD4}`, `pulls/${HOLD4}`, `issues/${HOLD4}`, `pr-${HOLD4}`, `Pr ${HOLD4}`]) {
      const r = scan(root, text);
      assert.equal(r.gate, 1, `gate for form ${text.replace(/\d/g, '#')}`);
      assert.deepEqual(rules(r), ['pr-ref']);
    }
  });
  it('S2b a colon, a bracket or an equals sign keeps a listed number out of the gate count but not out of the strict count', () => {
    for (const text of [`pr: ${HOLD4}`, `pr (${HOLD4}`, `pr=${HOLD4}`, `rows ${HOLD4}`]) {
      const r = scan(root, text);
      assert.equal(r.gate, 0, `gate for ${text.replace(/\d/g, '#')}`);
      assert.equal(r.strict, 1);
      assert.deepEqual(rules(r), ['bare']);
    }
  });
  it('S3 a bare 3 digit number of the rubric set only: gate 0, strict 1, rule bare; --gate-only exits 0', () => {
    const r = scan(root, `line ${RES3} of the file`);
    assert.equal(r.gate, 0);
    assert.equal(r.strict, 1);
    assert.deepEqual(rules(r), ['bare']);
    assert.equal(r.code, 1);
    const g = scan(root, `line ${RES3} of the file`, ['--gate-only']);
    assert.equal(g.gate, 0);
    assert.equal(g.strict, null);
    assert.equal(g.json.files[0].strict, null);
    assert.deepEqual(g.hits, []);
    assert.equal(g.code, 0);
  });
  it('S3b a bare 3 digit holdout PR number in prose (the 11-26 case): gate 0, strict 1', () => {
    const r = scan(root, `we ran ${HOLD3} tests`);
    assert.equal(r.gate, 0);
    assert.equal(r.strict, 1);
  });
  it('S3c a gold PR of 3 digits (rubric set only) after "PR " is not a gate hit (the gate floor is 4 digits) but a strict hit', () => {
    const r = scan(root, `PR ${GOLD3}`);
    assert.equal(r.gate, 0);
    assert.equal(r.strict, 1);
  });
  it('S3d a gold PR of 4 digits after "PR " hits the gate', () => {
    const r = scan(root, `PR ${GOLD4}`);
    assert.equal(r.gate, 1);
  });
  it('S4 a one or two digit listed number is a score, a version or a count: no hit, also after "PR "', () => {
    const r = scan(root, `PR ${RES2} and ${RES2} items`);
    assert.equal(r.gate, 0);
    assert.equal(r.strict, 0);
    assert.equal(r.code, 0);
  });
  it('S5 a number in no list never hits, also after "PR "', () => {
    const r = scan(root, 'PR 999 and 12345 and #888 and pull/7777');
    assert.equal(r.gate, 0);
    assert.equal(r.strict, 0);
    assert.equal(r.code, 0);
  });
  it('S5b a leading zero does not hide a number from the strict count (the rubric guard strips it)', () => {
    const r = scan(root, `row 0${RES3} here`);
    assert.equal(r.strict, 1);
    assert.deepEqual(rules(r), ['bare']);
  });
});

describe('S6 to S9: long ids, shas, keys, glued digits', () => {
  const root = listRoot();
  it('S6 a comment id of 7 digits or more hits anywhere, rule id', () => {
    const r = scan(root, `value ${COMMENT} stored`);
    assert.equal(r.gate, 1);
    assert.equal(r.strict, 1);
    assert.deepEqual(rules(r), ['id']);
  });
  it('S7 a sha hits when exact, as a prefix of 7 or more, or inside a longer hex run; 6 characters do not', () => {
    for (const text of [`head ${SHA}`, `head ${SHA.slice(0, 7)}`, `head ${SHA.slice(0, 12)}.`, `blob ${'0123456789abcdef'.repeat(3)}${SHA}`]) {
      const r = scan(root, text);
      assert.equal(r.gate, 1, `gate for a sha form of length ${text.length}`);
      assert.deepEqual(rules(r), ['sha']);
      assert.equal(r.hits[0].col, 6, 'the place of a sha hit is the start of its hex run');
    }
    const six = scan(root, `head ${SHA.slice(0, 6)}`);
    assert.equal(six.gate, 0);
    assert.equal(six.strict, 0);
  });
  it('S8 a finding key hits as a whole token (and its comment id counts too)', () => {
    const r = scan(root, `key=${KEY} done`);
    assert.equal(r.gate, 2);
    assert.ok(rules(r).includes('key'));
    assert.ok(rules(r).includes('id'));
  });
  it('S9 a listed number glued to another digit is a longer number: no hit', () => {
    const r = scan(root, `PR 1${HOLD4} and x${COMMENT}1 and 1${RES3}0`);
    assert.equal(r.gate, 0);
    assert.equal(r.strict, 0);
  });
});

describe('S10 to S12: places, output, switches', () => {
  const root = listRoot();
  it('S10 line and column are right in a CRLF text', () => {
    const r = scan(root, `first line\r\nsecond line\r\nthird PR ${HOLD4} here\r\n`);
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].line, 3);
    assert.equal(r.hits[0].col, 10);
  });
  it('S10b a hit on each of two lines gives two places; one id twice gives gate 1 and strict 2', () => {
    const r = scan(root, `PR ${HOLD4}\nand again PR ${HOLD4}\n`);
    assert.equal(r.gate, 1);
    assert.equal(r.strict, 2);
    assert.deepEqual(r.hits.map((h) => h.line), [1, 2]);
  });
  it('S11 no output holds a long id, in stdout, stderr or --json; the gate count equals the machine count', () => {
    const text = [`PR ${HOLD4} and ${HOLD3}`, `value ${COMMENT}`, `key ${KEY}`, `sha ${SHA}`, `line ${RES3}`].join('\n');
    const f = put(text);
    const plain = run(['--root', root, f]);
    const json = run(['--root', root, '--json', f]);
    for (const s of [plain.out, plain.err, json.out, json.err]) for (const id of LONG_IDS) assert.ok(!s.includes(id), 'an id reached the output');
    assert.equal(plain.code, 1);
    assert.equal(JSON.parse(json.out).gate, countListed(text, readIdList(root)));
  });
  it('S12 --gate-only ignores a strict-only hit, still reports a gate hit, and prints no strict count', () => {
    const r = run(['--root', root, '--gate-only', put(`line ${RES3}\n`)]);
    assert.equal(r.code, 0);
    assert.ok(!/strict/.test(r.out));
    assert.ok(!/HIT /.test(r.out), 'a strict-only place is listed under --gate-only');
    const g = run(['--root', root, '--gate-only', put(`PR ${HOLD4}\n`)]);
    assert.equal(g.code, 1);
    assert.match(g.out, /gate 1/);
  });
});

describe('S13 to S15: failures and inputs', () => {
  it('S13 exit 2 with a fixed message that holds no file text: no file, an unknown flag, an unreadable file', () => {
    const root = listRoot();
    assert.equal(run(['--root', root]).code, 2);
    assert.equal(run(['--root', root, '--nope', put('x')]).code, 2);
    const r = run(['--root', root, path.join(tmp, 'missing-sentinel-file.md')]);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
  });
  it('S13b exit 2 and a fixed message when the list is absent, empty or broken; the file text never reaches the output', () => {
    const SENTINEL = 'sentinel-text-in-the-file';
    const f = put(`${SENTINEL} PR ${HOLD4}`);
    const absent = folder();
    const empty = listRoot({ dataset: { prs: [], findings: [] } });
    const broken = listRoot({ dataset: '{ not json' });
    for (const root of [absent, empty, broken]) {
      const r = run(['--root', root, f]);
      assert.equal(r.code, 2);
      assert.equal(r.out, '');
      assert.ok(!r.err.includes(SENTINEL) && !r.err.includes(HOLD4), 'file text or an id in the error');
      assert.ok(r.err.length > 0);
    }
  });
  it('S14 standard input with -, an empty file and a file with no id exit 0 with counts 0', () => {
    const root = listRoot();
    const viaStdin = run(['--root', root, '--json', '-'], `PR ${HOLD4}\n`);
    assert.equal(viaStdin.code, 1);
    assert.equal(JSON.parse(viaStdin.out).files[0].file, '<stdin>');
    assert.equal(JSON.parse(viaStdin.out).gate, 1);
    for (const text of ['', 'plain words only\n']) {
      const r = scan(root, text);
      assert.equal(r.code, 0);
      assert.equal(r.gate, 0);
      assert.equal(r.strict, 0);
    }
  });
  it('S15 a very long line stays fast', () => {
    const root = listRoot();
    const text = `${'word '.repeat(60000)} PR ${HOLD4} ${'x1 '.repeat(20000)}`;
    const t0 = Date.now();
    const r = scan(root, text);
    assert.equal(r.gate, 1);
    assert.ok(Date.now() - t0 < 15000, 'the scan of a long line took too long');
  });
});

describe('S16 to S24: context, parity, usage', () => {
  const root = listRoot();
  it('S16 the masked context holds no digit, no hex run of 7 or more, and the hit itself is replaced', () => {
    const r = scan(root, `build 12345 at deadbeefcafe42 then PR ${HOLD4} landed ${SHA.slice(0, 9)} ok`);
    assert.ok(r.hits.length >= 1);
    for (const h of r.hits) {
      assert.ok(!/\d/.test(h.ctx), 'a digit in the context');
      assert.ok(!/[0-9a-f]{7,}/i.test(h.ctx), 'a hex run in the context');
      assert.ok(h.ctx.includes('[ID]'), 'the hit span is not replaced');
    }
  });
  it('S17 the bare rule is the rule of the rubric guard: same hit or no hit on the same token', async () => {
    const lint = await import(pathToFileURL(path.join(REPO, 'scripts/eval/review-eval/rubrics/lint-ids.mjs')).href);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, EVAL_CONFIG_REL), 'utf8'));
    const dataset = JSON.parse(fs.readFileSync(path.join(root, DATASET_REL), 'utf8'));
    const goldRows = JSON.parse(fs.readFileSync(path.join(root, GOLD_DIR_REL, 'rows.json'), 'utf8'));
    const set = lint.forbiddenSet({ cfg, dataset, goldRows });
    // Tokens of the rubric set that the gate list lacks, and tokens in no list: only the bare rule can hit them.
    for (const token of [RES3, `0${RES3}`, GOLD3, RES2, `0${RES2}`, '999', '5555', `${RES3}0`]) {
      const dir = folder();
      fs.writeFileSync(path.join(dir, 'r.md'), `value ${token} here\n`);
      const guard = lint.scanRubrics(dir, set).hits.length > 0;
      const mine = scan(root, `value ${token} here\n`).strict > 0;
      assert.equal(mine, guard, `parity for a token of ${token.length} characters`);
    }
  });
  it('S18 the usage text names the two counts, one line each, and says which one the machine enforces', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    const lines = r.out.split('\n');
    const gate = lines.filter((l) => /^\s*gate\b/.test(l));
    const strict = lines.filter((l) => /^\s*strict\b/.test(l));
    assert.equal(gate.length, 1);
    assert.equal(strict.length, 1);
    assert.match(gate[0], /machine/i);
  });
  it('S19 a fullwidth digit run folds to the number (NFKC), as the rubric guard reads it', () => {
    const wide = [...RES3].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    const r = scan(root, `value ${wide} here`);
    assert.equal(r.strict, 1);
  });
  it('S20 a hit that is both a gate hit and a bare number counts once in strict', () => {
    const r = scan(root, `PR ${HOLD3}`);
    assert.equal(r.gate, 1);
    assert.equal(r.strict, 1);
  });
  it('S21 on a mixed text the gate count equals the count of the machine matcher', () => {
    const text = [`PR ${HOLD4}`, `pr: ${HOLD4}`, `row ${COMMENT}`, `sha ${SHA.slice(0, 8)}`, `n=${RES3}`, `#${GOLD4}`, 'plain 4 5 6'].join('\n');
    const r = scan(root, text);
    assert.equal(r.gate, countListed(text, readIdList(root)));
  });
  it('S22 the plain output has one counts line per file, one HIT line per place, and a total line', () => {
    const f = put(`PR ${HOLD4}\nline ${RES3}\n`);
    const r = run(['--root', root, f]);
    const lines = r.out.trim().split('\n');
    assert.match(lines[0], /^.+: gate 1 strict 2$/);
    assert.equal(lines.filter((l) => /^HIT /.test(l)).length, 2);
    assert.match(lines[lines.length - 1], /^total gate 1 strict 2$/);
    assert.match(lines.find((l) => /^HIT /.test(l)), /line=1 col=\d+ rule=pr-ref ctx=/);
  });
  it('S23 several files: counts per file and one total; one clean file does not hide a hit in the next', () => {
    const a = put('nothing here\n');
    const b = put(`PR ${HOLD4}\n`);
    const r = run(['--root', root, '--json', a, b]);
    const j = JSON.parse(r.out);
    assert.equal(j.files.length, 2);
    assert.deepEqual(j.files.map((f) => f.gate), [0, 1]);
    assert.equal(j.gate, 1);
    assert.equal(r.code, 1);
  });
  it('S25 a file name is masked in the output: a digit run in a name could itself be an id', () => {
    const dir = folder();
    const f = path.join(dir, `x${HOLD4}y-${COMMENT}.md`);
    fs.writeFileSync(f, `PR ${HOLD4}\n`);
    for (const flags of [[], ['--json']]) {
      const r = run(['--root', root, ...flags, f]);
      assert.ok(!r.out.includes(HOLD4) && !r.out.includes(COMMENT), 'a name reached the output unmasked');
      assert.equal(r.code, 1);
    }
  });
  it('S10c a lone CR counts as a line break, as CRLF and LF do', () => {
    const r = scan(root, `one\rtwo\rPR ${HOLD4}`);
    assert.equal(r.hits[0].line, 3);
  });
  it('S24 the script copies no id and reads no list of its own: it works on a root with another list', () => {
    const other = listRoot({ dataset: { prs: [{ pr: 6001 }], findings: [{ pr: 6001, comment_id: 2222222222 }] }, config: { reserve: [], holdoutExclude: [] } });
    const r = scan(other, `PR 6001 and ${HOLD4}`);
    assert.equal(r.gate, 1);
  });
});

// Rows from CodeRabbit CLI run 1 of the first head (three minor findings, all real): the strict scan folds a line with NFKC and the
// fold can move offsets; the check slice of a gate hit can hold another valid reference; the mask covered only ASCII digits.
describe('S26 to S29: folding, repeated references, masking of other digits', () => {
  const root = listRoot();
  const LIGATURE = 'ﬀ'; // one character that NFKC folds into two
  const wide = (digits) => [...digits].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
  const arabic = (digits) => [...digits].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
  const hasOtherDigit = (s) => /\p{Nd}/u.test(s.replace(/[0-9]/g, ''));

  it('S26 after a character that NFKC expands, one number is one place at its original column', () => {
    const r = scan(root, `${LIGATURE} PR ${HOLD3}`);
    assert.equal(r.gate, 1);
    assert.equal(r.strict, 1);
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].col, 6);
  });
  it('S26b a bare hit after an expanding character is reported at the original column too', () => {
    const r = scan(root, `${LIGATURE} value ${RES3}`);
    assert.equal(r.strict, 1);
    assert.equal(r.hits[0].col, 9);
    assert.deepEqual(rules(r), ['bare']);
  });
  it('S27 a number that repeats right after a reference has no reference of its own; a genuine repeated reference does', () => {
    const gateOnly = scan(root, `PR ${HOLD4} ${HOLD4}`, ['--gate-only']);
    assert.equal(gateOnly.hits.length, 1);
    assert.equal(gateOnly.gate, 1);
    const both = scan(root, `PR ${HOLD4} ${HOLD4}`);
    assert.deepEqual(rules(both), ['pr-ref', 'bare']);
    const twice = scan(root, `PR ${HOLD4} and PR ${HOLD4}`, ['--gate-only']);
    assert.deepEqual(rules(twice), ['pr-ref', 'pr-ref']);
    const glued = scan(root, `PR ${HOLD4} PR ${HOLD4}`, ['--gate-only']);
    assert.deepEqual(rules(glued), ['pr-ref', 'pr-ref']);
  });
  it('S28 a fullwidth or Arabic-Indic digit run near a gate hit is masked in the context', () => {
    const text = `${wide(COMMENT)} PR ${HOLD4} ${arabic(HOLD4)} ${wide(RES3)}`;
    const r = scan(root, text);
    assert.ok(r.hits.length >= 1);
    for (const h of r.hits) {
      assert.ok(!hasOtherDigit(h.ctx), 'a digit of another script reached a context');
      assert.ok(!/\d/.test(h.ctx), 'a digit reached a context');
    }
    const plain = run(['--root', root, put(text)]);
    assert.ok(!hasOtherDigit(plain.out.replace(/^\d+:/gm, '')), 'a digit of another script reached the plain output');
  });
  it('S28b a fullwidth hex run (letters and digits) near a hit is masked as a hex run, not left as letters', () => {
    const wideHex = [...SHA.slice(0, 12)].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(''); // ASCII 0x21..0x7e to U+FF01..U+FF5E
    const r = scan(root, `${wideHex} PR ${HOLD4}`);
    assert.ok(r.hits.length >= 1);
    for (const h of r.hits) assert.ok(!/[Ａ-Ｚａ-ｚ]/.test(h.ctx), 'fullwidth letters of a hex run reached a context');
  });
  it('S29 a file name with fullwidth or Arabic-Indic digits is masked in the label', () => {
    const f = path.join(folder(), `x${wide(HOLD4)}y${arabic(COMMENT)}.md`);
    fs.writeFileSync(f, `PR ${HOLD4}\n`);
    const r = run(['--root', root, '--json', f]);
    const label = JSON.parse(r.out).files[0].file.replace(/^\d+:/, '');
    assert.ok(!hasOtherDigit(label) && !/\d/.test(label), 'a digit reached the file label');
    assert.match(label, /^x#+y#+\.md$/);
  });
});
