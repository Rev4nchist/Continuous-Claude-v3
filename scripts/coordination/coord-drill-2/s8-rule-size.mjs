/**
 * Row 8 (static, no database): no hook-injected rule text over 10,000 characters.
 *
 * Why: Claude Code cuts a hook `additionalContext` string above 10,000 characters to a 2 KB preview
 * and the model never sees the rest (see scripts/rules/ondemand-index-check.mjs:32-38). rule-router
 * sends an inject rule as `additionalContext` (.claude/hooks/src/rule-router.ts:334).
 *
 * What counts as the injected text: exactly what rule-router.ts builds, so the number is the real one.
 *   rule text   rule-router.ts:197-201  per file: `----- ~/.claude/rules-ondemand/<file> -----\n` + the
 *                                       file trimmed; the files of one rule are joined with `\n\n`
 *   footer      rule-router.ts:209-214  falseFireFooter(ids), holds the false-fires script path
 *   wrapper     rule-router.ts:222-232  `[rule-router] On-demand rule for this call (<id>):\n\n` for inject,
 *                                       the longer `Read the rule below ...` line for deny-first
 * Count unit: JS string length (UTF-16 units). For text with no emoji this equals characters.
 *
 * Which rules decide the verdict:
 *   - inject rules: yes (additionalContext is cut).
 *   - deny-first rules with `subagent: "block"`: no, listed as info. The deny reason is not cut (probe of
 *     2026-11-11 cited at ondemand-index-check.mjs:36), and a subagent is blocked, never given inject text
 *     (rule-router.ts:312-318).
 *   - deny-first rules WITHOUT `subagent: "block"`: yes. A subagent that finds the block marker taken gets
 *     them as inject text (rule-router.ts:315-318). Same stance as ondemand-index-check.mjs:58.
 * KNOWN_OVER_CAP in ondemand-index-check.mjs is NOT an exemption here: this row exists to show that the
 * gap is open. Limit: one rule at a time. Two rules that fire on one call add up; not measured here.
 *
 * The repo copy of .claude/rules-ondemand is read. The hook reads ~/.claude/rules-ondemand; forward sync
 * keeps the two equal.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HarnessError, PATHS, result } from './lib.mjs';

export const meta = {
  id: '8',
  title: 'No hook-injected rule text over 10,000 characters',
  rule: 'A rule that rule-router injects must fit under the 10,000 character hook cap, or the model sees a 2 KB preview.',
};

export const HOOK_CONTEXT_CAP = 10000;

/** The one size test. The rule rows and the positive control both go through it. */
export function isOverCap(text) {
  return text.length > HOOK_CONTEXT_CAP;
}

/**
 * The wrapper literals this row uses to build the injected text. wrapperCheck() proves that each one
 * is still in rule-router.ts, so a change to the hook wording makes the row ERROR, not a stale number.
 */
const W = {
  injectHead: '[rule-router] On-demand rule for this call (',
  denyHead: '[rule-router] Read the rule below before this call runs (',
  denyMid: '). It blocks once per ',
  denyMid2: 'session per rule. If the call still fits the rule, re-issue it unchanged; otherwise change course ',
  denyTail: '(for a confirm-first action, ask Dave first).',
  fileHead: '----- ~/.claude/rules-ondemand/',
  footerHead: '----- If a rule above is NOT about this call -----',
  footerLead: 'Record the false fire, then carry on: ',
  footerArgs: '--what "<first words of the call>" --note "<why it does not apply>" --source agent',
};
/** Source text of rule-router.ts that the build of the injected text depends on (as written in the file). */
const STRUCTURE_NEEDLES = [
  "'\\n\\n')", // the files of one rule are joined with a blank line
  "-----\\n${readFileSync(join(dir, f), 'utf8').trim()}", // header line, then the trimmed file
  "process.env.CCV3_REPO || join(homedir(), 'continuous-claude')",
  "'scripts', 'rules', 'rule-router-false-fires.mjs'",
  "node ${script} add --rule <${ids.join('|')}>",
  "fresh.some((r) => r.mode === 'deny-first')",
  "r.subagent === 'block'", // a subagent is never downgraded for a block-only rule
  "{ ...r, mode: 'inject' }", // a subagent gets a deny-first rule as inject text
];
const ROUTER_SRC = ['.claude', 'hooks', 'src', 'rule-router.ts'];

/** Control: read rule-router.ts and return every wrapper literal or structure line that is not in it. */
export function wrapperCheck(repo = PATHS.REPO) {
  const file = path.join(repo, ...ROUTER_SRC);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, missing: [`cannot read ${file}: ${e.message}`] }; }
  const missing = [...Object.entries(W).map(([k, v]) => [`wrapper ${k}`, v]), ...STRUCTURE_NEEDLES.map((v) => ['structure', v])]
    .filter(([, lit]) => !src.includes(lit)).map(([k, lit]) => `${k}: ${JSON.stringify(lit)}`);
  return { file, missing };
}

/** rule-router.ts:209-214, same path rule (CCV3_REPO or ~/continuous-claude). */
function falseFireFooter(ids) {
  const script = path.join(process.env.CCV3_REPO || path.join(os.homedir(), 'continuous-claude'), 'scripts', 'rules', 'rule-router-false-fires.mjs')
    .replace(/\\/g, '/');
  return `\n\n${W.footerHead}\n${W.footerLead}`
    + `\`node ${script} add --rule <${ids.join('|')}> ${W.footerArgs}\``;
}

/**
 * rule-router.ts:197-201 and 217-233: the text one rule produces when it fires alone.
 * asInject: build the inject text for a deny-first rule (what a subagent gets, rule-router.ts:315-318).
 */
export function injectedText(entry, fileText, asInject = false) {
  const body = entry.files
    .map((f) => `${W.fileHead}${f} -----\n${fileText[f].trim()}`)
    .join('\n\n') + falseFireFooter([entry.id]);
  if (entry.mode === 'deny-first' && !asInject) {
    return `${W.denyHead}${entry.id}${W.denyMid}${W.denyMid2}${W.denyTail}\n\n${body}`;
  }
  return `${W.injectHead}${entry.id}):\n\n${body}`;
}

const isBlockOnly = (r) => r.mode === 'deny-first' && r.subagent === 'block';
const modeLabel = (r) => (isBlockOnly(r) ? 'deny-first, subagent block' : r.mode);
const n = (x) => x.toLocaleString('en-US');

/** Read the manifest and every rule file. Missing files are collected, not thrown, so the control can name them. */
function loadRules(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const rules = Array.isArray(manifest.rules) ? manifest.rules : [];
  const fileText = {};
  const missing = [];
  for (const r of rules) {
    for (const f of r.files ?? []) {
      if (f in fileText) continue;
      try { fileText[f] = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { missing.push(f); }
    }
  }
  return { rules, fileText, missing };
}

function table(rules, fileText) {
  return rules.map((r) => {
    // A counted rule reaches the model as inject text (a deny-first rule without subagent block goes to
    // a subagent as inject text), so measure it with the inject wrapper. A block-only rule is info: its deny text.
    const text = injectedText(r, fileText, !isBlockOnly(r));
    return { rule: r.id, mode: modeLabel(r), file: r.files.join(', '), chars: text.length, over: isOverCap(text), counts: !isBlockOnly(r) };
  });
}

const CONTROL_NAME = 'size test sees 10,001 over and 10,000 not over; manifest has rules; every rule file exists; every wrapper literal is in rule-router.ts';

function control(rules, missing, wrapper) {
  const ok = isOverCap('x'.repeat(HOOK_CONTEXT_CAP + 1)) && !isOverCap('x'.repeat(HOOK_CONTEXT_CAP));
  const problems = [];
  if (!ok) problems.push('the size test does not tell 10,001 characters (over) from 10,000 (not over)');
  if (rules.length < 1) problems.push('the manifest has no rules');
  if (missing.length) problems.push(`rule files missing: ${missing.join(', ')}`);
  if (wrapper.missing.length) problems.push(`rule-router.ts no longer holds what this row builds (${wrapper.missing.length}): ${wrapper.missing.join(' | ')}`);
  return problems.length
    ? { name: CONTROL_NAME, ok: false, detail: problems.join('; ') }
    : { name: CONTROL_NAME, ok: true,
      detail: `10,001 over, 10,000 not over; ${rules.length} rules, all files present; ${Object.keys(W).length + STRUCTURE_NEEDLES.length} wrapper and structure literals found in rule-router.ts` };
}

export async function run() {
  const dir = path.join(PATHS.REPO, '.claude', 'rules-ondemand');
  let loaded;
  try {
    loaded = loadRules(dir);
  } catch (e) {
    throw new HarnessError(`cannot read the rule manifest in ${dir}: ${e.message}`);
  }
  const { rules, fileText, missing } = loaded;
  const wrapper = wrapperCheck();
  const ctl = control(rules, missing, wrapper);
  if (!ctl.ok) return result({ ...meta, verdict: 'ERROR', reason: ctl.detail, control: ctl, evidence: { missing, wrapperMissing: wrapper.missing } });
  const rows = table(rules, fileText);
  // A gate that counts no rule passes on nothing. Need 1 counted rule or more.
  const counted = rows.filter((r) => r.counts).length;
  if (counted < 1) {
    const vacuous = { name: 'at least 1 counted rule (not block-only) is measured', ok: false, detail: `0 of ${rows.length} rules are counted` };
    return result({ ...meta, verdict: 'ERROR', reason: `${vacuous.detail}, so a PASS would count nothing`, control: vacuous, evidence: rows.map(({ rule, mode, chars }) => ({ rule, mode, chars })) });
  }
  const over = rows.filter((r) => r.over && r.counts);
  const info = rows.filter((r) => r.over && !r.counts);
  const infoText = info.length ? ` Info, not counted: ${info.map((r) => `${r.rule} ${n(r.chars)} chars (${r.mode})`).join('; ')}.` : '';
  const reason = over.length
    ? `${over.length} rule(s) over ${n(HOOK_CONTEXT_CAP)} characters: ${over.map((r) => `${r.rule} ${n(r.chars)} chars (${r.mode})`).join('; ')}.${infoText}`
    : `no rule that reaches the model as hook text is over ${n(HOOK_CONTEXT_CAP)} characters.${infoText}`;
  const evidence = rows.map(({ rule, mode, file, chars }) => ({ rule, mode, file, chars }));
  return result({ ...meta, verdict: over.length ? 'FAIL' : 'PASS', reason, control: ctl, evidence });
}
