// Tests for metrics.mjs. Every fixture is SYNTHETIC: built here from invented words.
// No line of a real transcript, lane note or message is used (seat condition C2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ingestEntries,
  ingestFile,
  computeMetrics,
  analyzeDirected,
  sendProbes,
  arrivalWindows,
  unionLength,
  chicagoDay,
  parseLaneSays,
  parseArgs,
  manifestRuleFiles,
  eventSends,
} from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'metrics.mjs');

// ---- fixture builders ----------------------------------------------------
const BASE = Date.parse('2026-11-10T12:00:00Z');
const iso = (sec) => new Date(BASE + sec * 1000).toISOString();
const SEAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const BLD = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTH = 'cccccccc-0000-4000-8000-000000000003';
let seq = 0;
const nextId = (p) => `${p}_${++seq}`;

const use = (name, input, id = nextId('tu')) => ({ type: 'tool_use', id, name, input });
function asst(sid, sec, blocks, req = nextId('req'), usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 }) {
  return { type: 'assistant', sessionId: sid, timestamp: iso(sec), requestId: req, message: { id: req, usage, content: blocks } };
}
function result(sid, sec, id, text, extra = {}, isError = false) {
  return {
    type: 'user', sessionId: sid, timestamp: iso(sec),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
    ...extra,
  };
}
const prompt = (sid, sec, text) => ({ type: 'user', sessionId: sid, timestamp: iso(sec), message: { content: text } });
const hook = (sid, sec, hookEvent, strings) => ({
  type: 'attachment', sessionId: sid, timestamp: iso(sec),
  attachment: { type: 'hook_additional_context', hookEvent, hookName: hookEvent, content: strings },
});
const sys = (sid, sec, subtype, extra = {}) => ({ type: 'system', sessionId: sid, timestamp: iso(sec), subtype, ...extra });
const find = (metrics, id) => metrics.find((m) => m.id === id);

// ---- metric 10 ------------------------------------------------------------
test('metric 10: compaction count and mean come from compact_boundary, window respected', () => {
  const e = [
    sys(SEAT, 10, 'compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 400000 } }),
    sys(SEAT, 20, 'compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 600000 } }),
    sys(SEAT, 30, 'compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 200000 } }),
    sys(SEAT, 99999, 'compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 900000 } }),
    asst(SEAT, 40, [], 'rq1', { input_tokens: 5, cache_read_input_tokens: 700000, cache_creation_input_tokens: 5, output_tokens: 1 }),
    asst(SEAT, 41, [], 'rq1', { input_tokens: 5, cache_read_input_tokens: 700000, cache_creation_input_tokens: 5, output_tokens: 1 }),
  ];
  const opts = { until: BASE + 3600 * 1000 };
  const m = find(computeMetrics([ingestEntries(e, opts)], opts), 10);
  assert.equal(m.value.compactions, 3);
  assert.equal(m.value.meanPreTokens, 400000);
  assert.equal(m.value.maxPreTokens, 600000);
  assert.equal(m.value.maxRequestContext, 700010);
  assert.equal(m.meets, false);
});

test('metric 10: no compaction in the input gives meets null, not a pass', () => {
  const f = ingestEntries([asst(SEAT, 1, [])], {});
  const m = find(computeMetrics([f], {}), 10);
  assert.equal(m.meets, null);
  assert.ok(m.caveats.length > 0);
});

// ---- metric 7 -------------------------------------------------------------
test('metric 7: AskUserQuestion pairs by id; waits over 300 s counted; union smaller than sum on overlap', () => {
  const q = (id) => use('AskUserQuestion', { questions: [{ question: 'alpha bravo?', header: 'h', options: [] }] }, id);
  const e = [
    prompt(SEAT, 0, 'alpha prompt one'),
    asst(SEAT, 0, [q('q1')]), result(SEAT, 400, 'q1', 'answered'),
    asst(SEAT, 100, [q('q2')]), result(SEAT, 130, 'q2', 'answered'),
    { ...prompt(SEAT, 900, 'bravo prompt two'), origin: { kind: 'human' } },
    { ...prompt(SEAT, 950, 'notice words'), origin: { kind: 'task-notification' } },
    asst(SEAT, 1000, [q('q3')]), result(SEAT, 1010, 'q3', 'answered'),
    asst(SEAT, 2000, [q('q4')]),
  ];
  const m = find(computeMetrics([ingestEntries(e, {})], {}), 7);
  assert.equal(m.value.paired, 3);
  assert.equal(m.value.unpaired, 1);
  assert.equal(m.value.waitsOver300s, 1);
  assert.equal(m.value.sumWaitSec, 440);
  assert.equal(m.value.unionOpenSec, 410);
  assert.ok(m.value.unionOpenSec < m.value.sumWaitSec);
  assert.equal(m.value.humanPrompts, 2);
  assert.equal(m.value.questionCalls, 4);
});

test('unionLength merges overlapping and keeps disjoint intervals', () => {
  assert.equal(unionLength([[0, 10], [5, 20], [30, 40]]), 30);
  assert.equal(unionLength([]), 0);
});

// ---- metrics 2 and 3: window match, msg_id match, cap, idle/busy ----------
const LONG = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

test('metric 2: a lane DM that starts with a shell variable still matches on a later window', () => {
  const cmd = `$t = 'unused'; node C:/x/lane.mjs say --to bbbbbbbb "$t ${LONG}"`;
  const sid = 'tu_say1';
  const sender = ingestEntries([
    asst(SEAT, 100, [use('PowerShell', { command: cmd }, sid)]),
    result(SEAT, 101, sid, 'x', { toolUseResult: { stdout: 'sent to trex #bbbbbbbb ok' } }),
  ], {});
  const recv = ingestEntries([
    sys(BLD, 50, 'turn_duration'),
    hook(BLD, 105, 'PostToolUse', ['## Direct message from another session\nUNEXPANDED value ' + LONG.toUpperCase()]),
  ], {});
  const an = analyzeDirected([sender, recv], {});
  const rec = an.records.find((r) => r.channel === 'lane');
  assert.equal(rec.status, 'matched');
  assert.equal(rec.latencyMs, 5000);
  assert.equal(rec.state, 'idle');
  // a window that holds the variable must not be probed
  assert.equal(sendProbes('$a alpha $b bravo $c delta $d echoo').length, 0);
  assert.ok(sendProbes('$a ' + LONG).length > 0);
});

test('metric 2: SendMessage joins on msg_id; cap at 2 h splits capped from uncapped; busy receiver is split out', () => {
  const sm = (id, text) => use('SendMessage', { to: 'trex', message: text, summary: 's', type: 'message' }, id);
  const sender = ingestEntries([
    asst(SEAT, 10, [sm('s1', 'alpha one')]),
    result(SEAT, 11, 's1', 'ok', { toolUseResult: { success: true, msg_id: 'm-1' } }),
    asst(SEAT, 20, [sm('s2', 'alpha two')]),
    result(SEAT, 21, 's2', 'ok', { toolUseResult: { success: true, msg_id: 'm-2' } }),
  ], {});
  const peer = (sec, msg) => ({ type: 'user', sessionId: BLD, timestamp: iso(sec), origin: { kind: 'peer', msg_id: msg }, message: { content: 'wrapper' } });
  const recv = ingestEntries([
    sys(BLD, 1, 'turn_duration'),
    peer(11, 'm-1'),
    asst(BLD, 15, []),
    peer(20 + 3 * 3600, 'm-2'),
  ], {});
  const m = find(computeMetrics([sender, recv], {}), 2);
  const sm2 = m.value.sendmessage;
  assert.equal(sm2.all.uncapped.n, 2);
  assert.equal(sm2.all.capped2h.n, 1);
  assert.equal(sm2.idle.uncapped.n, 1);
  assert.equal(sm2.idle.uncapped.p50, 1);
  assert.equal(sm2.busy.uncapped.n, 1);
  assert.equal(m.meets, false);
});

test('metric 3: a send with no arrival, no cut banner and an active receiver is unexplained loss; not-success counted', () => {
  const sender = ingestEntries([
    asst(SEAT, 10, [use('PowerShell', { command: `node lane.mjs say --to bbbbbbbb "${LONG}"` }, 'a1')]),
    result(SEAT, 11, 'a1', 'x', { toolUseResult: { stdout: 'sent to trex #bbbbbbbb' } }),
    asst(SEAT, 12, [use('PowerShell', { command: `node lane.mjs say --to cccccccc "zulu yankee xray whiskey victor uniform"` }, 'a2')]),
    result(SEAT, 13, 'a2', 'x', { toolUseResult: { stdout: 'sent to idle #cccccccc' } }),
    asst(SEAT, 14, [use('SendMessage', { to: 'trex', message: 'alpha nothing' }, 'a3')]),
    result(SEAT, 15, 'a3', 'x', { toolUseResult: { success: false } }),
  ], {});
  const active = ingestEntries([asst(BLD, 600, []), asst(BLD, 1200, [])], {});
  const away = ingestEntries([asst(OTH, 5, [])], {});
  const m = find(computeMetrics([sender, active, away], {}), 3);
  assert.equal(m.value.lane.unexplainedLoss, 1);
  assert.equal(m.value.lane.receiverInactive, 1);
  assert.equal(m.value.sendMessageNotSuccess, 1);
  assert.equal(m.meets, false);
});

// ---- metric 1: cut banner stub -------------------------------------------
test('metric 1: a persisted-output stub holding a lane banner is a cut banner; a DM with no arrival before it is explained', () => {
  const stub = '<persisted-output>\nOutput too large (12.3KB). Full output saved to: somewhere\n\nPreview (first 2KB):\n## 5 lane update(s) since you last looked\n- alpha bravo\n</persisted-output>';
  const whole = '## 1 lane update(s) since you last looked\n- alpha bravo note';
  const sender = ingestEntries([
    asst(SEAT, 10, [use('PowerShell', { command: `node lane.mjs say --to bbbbbbbb "${LONG}"` }, 'c1')]),
    result(SEAT, 11, 'c1', 'x', { toolUseResult: { stdout: 'sent to trex #bbbbbbbb' } }),
  ], {});
  const recv = ingestEntries([
    hook(BLD, 5, 'UserPromptSubmit', [whole]),
    hook(BLD, 60, 'UserPromptSubmit', [stub]),
    asst(BLD, 70, []),
  ], {});
  const list = [sender, recv];
  const m1 = find(computeMetrics(list, {}), 1);
  assert.equal(m1.value.cutBanners, 1);
  assert.equal(m1.value.totalBanners, 2);
  assert.equal(m1.value.dmsBehindCut, 1);
  assert.equal(m1.meets, false);
  const m3 = find(computeMetrics(list, {}), 3);
  assert.equal(m3.value.lane.unexplainedLoss, 0);
  assert.equal(m3.value.lane.cutExplained, 1);
});

// ---- metric 4 -------------------------------------------------------------
test('metric 4: double send counts a lane DM to the same receiver within 120 s, not outside', () => {
  const sm = (id) => use('SendMessage', { to: 'trex', message: 'alpha ping' }, id);
  const say = (id) => use('PowerShell', { command: 'node lane.mjs say --to cccccccc "alpha ping"' }, id);
  const sayRes = (sec, id) => result(SEAT, sec, id, 'x', { toolUseResult: { stdout: 'sent to session trex #cccccccc now' } });
  const f = ingestEntries([
    asst(SEAT, 100, [sm('d1')]), asst(SEAT, 150, [say('l1')]), sayRes(151, 'l1'),
    asst(SEAT, 1000, [sm('d2')]), asst(SEAT, 1300, [say('l2')]), sayRes(1301, 'l2'),
  ], {});
  const opts = { seat: 'aaaaaaaa' };
  const m = find(computeMetrics([f], opts), 4);
  assert.equal(m.n, 2);
  assert.equal(m.value.doubleSent, 1);
  assert.equal(m.value.rate, 0.5);
  assert.equal(m.meets, false);
});

// ---- metric 5 -------------------------------------------------------------
test('metric 5: repeat share uses the FULL string; same first 100 chars but different tails are not repeats', () => {
  const head = 'alpha bravo '.repeat(12); // 144 chars shared by every block
  const a = head + 'tail one';
  const b = head + 'tail two';
  const f = ingestEntries([
    asst(SEAT, 1, [], 'r1'), asst(SEAT, 2, [], 'r1'), asst(SEAT, 3, [], 'r2'),
    hook(SEAT, 4, 'UserPromptSubmit', [a, b]),
    hook(SEAT, 5, 'UserPromptSubmit', [a]),
  ], {});
  const m = find(computeMetrics([f], {}), 5);
  assert.equal(m.value.blocks, 3);
  assert.equal(m.value.repeatBlocks, 1);
  assert.equal(m.value.requests, 2);
  assert.equal(m.value.bytes, Buffer.byteLength(a) * 2 + Buffer.byteLength(b));
});

test('metric 5: rule-router repeats are counted by rule file name', () => {
  const rb = (n) => `[rule-router] On-demand rule for this call. Read the rule: rules-ondemand/${n}.md first.`;
  const f = ingestEntries([
    asst(SEAT, 1, [], 'r1'),
    hook(SEAT, 2, 'PreToolUse', [rb('alpha-rule') + ' one']),
    hook(SEAT, 3, 'PreToolUse', [rb('alpha-rule') + ' two']),
    hook(SEAT, 4, 'PreToolUse', [rb('bravo-rule')]),
  ], {});
  const m = find(computeMetrics([f], {}), 5);
  assert.equal(m.value.ruleRouter.blocks, 3);
  assert.equal(m.value.ruleRouter.repeats, 1);
  // alpha-rule.md is not in the manifest: the report shows other-<n>, never the name taken from transcript text.
  assert.deepEqual(Object.keys(m.value.ruleRouter.byFile), ['other-1', 'other-2']);
  assert.equal(m.value.ruleRouter.byFile['other-1'].repeats, 1);
});

// D12: a rule that is in the manifest is shown by name, so a reader sees which rule repeats.
test('metric 5: a rule file that is in the rules-ondemand manifest is shown by name; others as other-<n>', () => {
  // N12: the real exported reader, not a copy of its parsing.
  const names = manifestRuleFiles();
  const known = [...names][0];
  assert.ok(known && known.endsWith('.md') && !names.has('unlisted-rule.md'));
  const rb = (n) => `[rule-router] On-demand rule for this call. Read the rule: rules-ondemand/${n} first.`;
  const f = ingestEntries([
    asst(SEAT, 1, [], 'r1'),
    hook(SEAT, 2, 'PreToolUse', [rb(known) + ' one']),
    hook(SEAT, 3, 'PreToolUse', [rb(known) + ' two']),
    hook(SEAT, 4, 'PreToolUse', [rb('unlisted-rule.md') + ' one']),
    hook(SEAT, 5, 'PreToolUse', [rb('unlisted-rule.md') + ' two']),
    hook(SEAT, 6, 'PreToolUse', [rb('unlisted-rule.md') + ' three']),
  ], {});
  const by = find(computeMetrics([f], {}), 5).value.ruleRouter.byFile;
  assert.equal(by[known].repeats, 1);
  assert.equal(by['other-1'].repeats, 2);
  assert.ok(!JSON.stringify(by).includes('unlisted'));
});

// ---- metric 6 -------------------------------------------------------------
test('metric 6: a cron-fired check with no write action is idle; one with a lane note is not', () => {
  const fire = (sec) => ({ type: 'user', sessionId: SEAT, timestamp: iso(sec), isMeta: true, scheduledTaskId: 't', wakeupSource: 'schedule_wakeup', message: { content: 'Seat check for lane alpha' } });
  const f = ingestEntries([
    fire(10), asst(SEAT, 11, [use('Bash', { command: 'node lane.mjs board' })], 'k1', { input_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
    sys(SEAT, 12, 'turn_duration'),
    fire(20), asst(SEAT, 21, [use('Bash', { command: 'node lane.mjs note alpha "bravo"' })], 'k2', { input_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }),
    sys(SEAT, 22, 'turn_duration'),
    asst(SEAT, 30, [], 'k3', { input_tokens: 1, cache_read_input_tokens: 8500, cache_creation_input_tokens: 0 }),
  ], {});
  const m = find(computeMetrics([f], {}), 6);
  assert.equal(m.value.checks, 2);
  assert.equal(m.value.idleChecks, 1);
  assert.equal(m.value.idleRequests, 1);
  assert.equal(m.value.idleCacheRead, 1000);
  assert.equal(m.value.idleShareOfCacheRead, 0.1);
});

// ---- metric 8 -------------------------------------------------------------
test('metric 8: bookkeeping share is a range over both class orders; no --seat gives null', () => {
  const f = ingestEntries([
    asst(SEAT, 1, [use('Bash', { command: 'node lane.mjs note alpha "bravo"' })]),
    asst(SEAT, 2, [use('Read', { file_path: 'docs/milestone-alpha.md' })]),
    asst(SEAT, 3, [use('Bash', { command: 'ls' })]),
  ], {});
  const m = find(computeMetrics([f], { seat: 'aaaaaaaa' }), 8);
  assert.equal(m.n, 3);
  assert.equal(m.value.shareForwardOrder, 0.667);
  assert.equal(m.value.shareReviewFirstOrder, 0.333);
  assert.equal(m.meets, null);
  assert.equal(find(computeMetrics([f], {}), 8).meets, null);
});

// ---- metric 9 -------------------------------------------------------------
test('metric 9: publishes are counted per America/Chicago day across midnight UTC; 429 counted', () => {
  const at = (iso8, blocks) => ({ type: 'assistant', sessionId: SEAT, timestamp: iso8, requestId: nextId('rq'), message: { id: 'm', content: blocks } });
  const f = ingestEntries([
    at('2026-11-11T05:30:00Z', [use('Artifact', { action: 'publish', file_path: 'a.html' })]),
    at('2026-11-11T05:59:00Z', [use('Artifact', { file_path: 'b.html', label: 'alpha' })]),
    at('2026-11-11T06:30:00Z', [use('Artifact', { action: 'publish', file_path: 'c.html' }, 'pubC')]),
    at('2026-11-11T06:31:00Z', [use('ArtifactData', { action: 'query' })]),
    { ...result(SEAT, 0, 'pubC', 'publish 429: daily publish limit reached', {}, true), timestamp: '2026-11-11T06:30:05Z' },
  ], {});
  const m = find(computeMetrics([f], {}), 9);
  assert.deepEqual(m.value.perDay, { '2026-11-10': 2, '2026-11-11': 1 });
  assert.equal(m.value.results429, 1);
  assert.equal(m.meets, false);
  assert.equal(chicagoDay(Date.parse('2026-11-11T05:59:59Z')), '2026-11-10');
  assert.equal(chicagoDay(Date.parse('2026-11-11T06:00:00Z')), '2026-11-11');
});

test('metric 9: zero publishes is meets null, not a vacuous pass', () => {
  const f = ingestEntries([asst(SEAT, 1, [])], {});
  assert.equal(find(computeMetrics([f], {}), 9).meets, null);
});

// ---- review fixes (11-review-metrics): every fixture below is invented ------
const T1 = 'quartz meadow lantern orbit velvet';
const T2 = 'harbor timber copper signal willow';
const T3 = 'granite ember falcon river summit';
const saySend = (sec, id, to, text) => [
  asst(SEAT, sec, [use('PowerShell', { command: `node C:/x/lane.mjs say --to ${to} "${text}"` }, id)]),
  result(SEAT, sec + 1, id, 'x', { toolUseResult: { stdout: `sent to trex #${to}` } }),
];
const saySendRaw = (sec, id, command) => [
  asst(SEAT, sec, [use('PowerShell', { command }, id)]),
  result(SEAT, sec + 1, id, 'x', { toolUseResult: { stdout: 'sent to trex #bbbbbbbb' } }),
];
const smSend = (sec, id, text, msgId) => [
  asst(SEAT, sec, [use('SendMessage', { to: 'trex', message: text }, id)]),
  result(SEAT, sec + 1, id, 'ok', { toolUseResult: { success: true, msg_id: msgId } }),
];
const peerIn = (sid, sec, msgId) => ({ type: 'user', sessionId: sid, timestamp: iso(sec), origin: { kind: 'peer', msg_id: msgId }, message: { content: 'wrapper' } });

// MAJOR 2 (:548 `r.used` skip and :563 `ref.used = true`): one arrival matched only one send.
test('metrics 2 and 3: one banner that holds three DMs matches all three sends', () => {
  const sender = ingestEntries([...saySend(10, 'm1', 'bbbbbbbb', T1), ...saySend(20, 'm2', 'bbbbbbbb', T2), ...saySend(30, 'm3', 'bbbbbbbb', T3)], {});
  const banner = `## 3 lane update(s) since you last looked\n- (direct to you) ${T1}\n- (direct to you) ${T2}\n- (direct to you) ${T3}`;
  const recv = ingestEntries([hook(BLD, 40, 'UserPromptSubmit', [banner]), asst(BLD, 50, [])], {});
  const an = analyzeDirected([sender, recv], {});
  assert.deepEqual(an.records.map((r) => r.status), ['matched', 'matched', 'matched']);
  const m2 = find(computeMetrics([sender, recv], {}), 2);
  assert.equal(m2.value.lane.all.uncapped.n, 3);
  const m3 = find(computeMetrics([sender, recv], {}), 3);
  assert.equal(m3.value.lane.unexplainedLoss, 0);
  assert.equal(m3.value.lane.matched, 3);
});

// MAJOR 1 (:633 `if (recs.length) flags.push`): an unmatched DM dropped out of the p90.
test('metric 2: an unmatched DM to an idle receiver is an infinite wait and blocks a pass', () => {
  const sender = ingestEntries([...saySend(10, 'u1', 'bbbbbbbb', T1), ...smSend(20, 'u2', T2, 'm-1')], {});
  const recv = ingestEntries([sys(BLD, 1, 'turn_duration'), peerIn(BLD, 21, 'm-1'), asst(BLD, 600, [])], {});
  const m = find(computeMetrics([sender, recv], {}), 2);
  assert.equal(m.value.sendmessage.all.uncapped.p90, 1); // the fast SendMessage alone would pass
  assert.equal(m.meets, false);
  assert.equal(m.value.lane.unmatchedEvaluable, 1);
  assert.equal(m.value.lane.p90WithUnmatched, 'infinite');
});

// MAJOR 3 (:649-651 and :656): receiver_unknown was left out, so a pass came from the matched sends alone.
test('metrics 2 and 3: a SendMessage with no name map is receiver_unknown and cannot give a pass', () => {
  const sender = ingestEntries([...smSend(10, 'n1', T1, 'm-1'), ...smSend(20, 'n2', T2, 'm-2')], {});
  const recv = ingestEntries([sys(BLD, 1, 'turn_duration'), peerIn(BLD, 11, 'm-1')], {});
  const list = [sender, recv];
  const m3 = find(computeMetrics(list, {}), 3);
  assert.equal(m3.value.sendmessage.matched, 1);
  assert.equal(m3.value.sendmessage.receiverUnknown, 1);
  assert.equal(m3.meets, null);
  assert.equal(find(computeMetrics(list, {}), 2).meets, null);
});

// D1 (:578 `some`): DMs built from one template share a 20-character run, so one shared window matched a lost DM.
test('metrics 2 and 3: 3 sent and 2 in the banner gives 1 lost; a shared template run is not a match', () => {
  const PRE = 'common handoff preamble words ';
  const A = `${PRE}quartz meadow lantern orbit velvet harbor timber`;
  const B = `${PRE}copper signal willow granite ember falcon river`;
  const C = `${PRE}summit marble thunder cobalt juniper saffron delta`;
  const sender = ingestEntries([...saySend(10, 'd1a', 'bbbbbbbb', A), ...saySend(20, 'd1b', 'bbbbbbbb', B), ...saySend(30, 'd1c', 'bbbbbbbb', C)], {});
  const banner = `## 2 lane update(s) since you last looked\n- (direct to you) ${A}\n- (direct to you) ${B}`;
  const recv = ingestEntries([hook(BLD, 40, 'UserPromptSubmit', [banner]), asst(BLD, 50, [])], {});
  const an = analyzeDirected([sender, recv], {});
  assert.deepEqual(an.records.map((r) => r.status), ['matched', 'matched', 'lost']);
  assert.equal(find(computeMetrics([sender, recv], {}), 3).value.lane.unexplainedLoss, 1);
});

// D1 (:195 whole-command fallback): a send whose text is only a variable was probed on the CLI path.
test('metrics 2 and 3: a $MSG-only send is untestable and is not matched by a banner that holds the CLI hint', () => {
  const sender = ingestEntries(saySendRaw(10, 'd1m', 'node C:/x/lane.mjs say --to bbbbbbbb "$MSG"'), {});
  // N4: "(direct to you)" makes this banner a lane arrival, so the "not matched" half can fail.
  const banner = '## 1 lane update(s) since you last looked\n- (direct to you) hint: run node C:/x/lane.mjs say --to bbbbbbbb "reply" to answer';
  const recv = ingestEntries([hook(BLD, 20, 'UserPromptSubmit', [banner]), asst(BLD, 30, [])], {});
  assert.equal(recv.arrivals.length, 1);
  assert.equal(recv.arrivals[0].kind, 'lane');
  const an = analyzeDirected([sender, recv], {});
  assert.deepEqual(an.records.map((r) => r.status), ['untestable']);
  const list = [sender, recv];
  assert.equal(find(computeMetrics(list, {}), 2).value.notMeasured, 1);
  assert.equal(find(computeMetrics(list, {}), 3).value.lane.untestable, 1);
});

// D3 (:302): a SendMessage to a subagent has no session receiver; it made metric 3 null on every fleet run.
test('metric 3: a SendMessage to an agent is counted apart and does not make receiver_unknown', () => {
  const agentSend = [
    asst(SEAT, 30, [use('SendMessage', { to: 'worker', recipient_kind: 'agent', message: T3 }, 'ag1')]),
    result(SEAT, 31, 'ag1', 'ok', { toolUseResult: { success: true } }),
  ];
  const sender = ingestEntries([...smSend(10, 'ag0', T1, 'm-1'), ...agentSend], {});
  const recv = ingestEntries([sys(BLD, 1, 'turn_duration'), peerIn(BLD, 11, 'm-1')], {});
  const m3 = find(computeMetrics([sender, recv], {}), 3);
  assert.equal(m3.value.sendMessageToAgents, 1);
  assert.equal(m3.value.sendmessage.receiverUnknown, 0);
  assert.equal(m3.value.sendmessage.matched, 1);
  assert.equal(m3.meets, true);
});

// D4 (:668, :690): failed and untestable sends were in no count, so one fast send passed "every directed message".
test('metric 2: failed directed sends withhold the pass', () => {
  const fails = [];
  for (let i = 0; i < 5; i++) {
    fails.push(asst(SEAT, 100 + i * 10, [use('SendMessage', { to: 'trex', message: `${T2} ${i}` }, `f${i}`)]), result(SEAT, 101 + i * 10, `f${i}`, 'no', { toolUseResult: { success: false } }));
  }
  const sender = ingestEntries([...smSend(10, 'fa', T1, 'm-1'), ...fails], {});
  const recv = ingestEntries([sys(BLD, 1, 'turn_duration'), peerIn(BLD, 11, 'm-1')], {});
  const m = find(computeMetrics([sender, recv], {}), 2);
  assert.equal(m.value.sendmessage.all.uncapped.p90, 1);
  assert.equal(m.value.notMeasured, 5);
  assert.equal(m.meets, null);
});

// :439 (not proven): with no turn_duration entry the idle split cannot be told, so it says unproven.
test('metric 2: a receiver with no turn_duration entry gives an unproven idle split, not a busy count', () => {
  const sender = ingestEntries(smSend(10, 'p1', T1, 'm-1'), {});
  const recv = ingestEntries([asst(BLD, 5, []), peerIn(BLD, 11, 'm-1')], {});
  const an = analyzeDirected([sender, recv], {});
  assert.equal(an.records[0].state, 'unproven');
  const m = find(computeMetrics([sender, recv], {}), 2);
  assert.equal(m.value.sendmessage.idle, 'unproven');
  assert.equal(m.value.sendmessage.busy, 'unproven');
});

test('metric 6: check segments with no turn_duration entry in the input are unproven, not a count', () => {
  const fire = (sec) => ({ type: 'user', sessionId: SEAT, timestamp: iso(sec), isMeta: true, scheduledTaskId: 't', wakeupSource: 'schedule_wakeup', message: { content: 'Seat check for lane alpha' } });
  const f = ingestEntries([fire(10), asst(SEAT, 11, [], 'k1'), fire(20), asst(SEAT, 21, [], 'k2')], {});
  const m = find(computeMetrics([f], {}), 6);
  assert.equal(m.value.checks, 2);
  assert.equal(m.value.idleChecks, 'unproven');
  assert.equal(m.meets, null);
});

// MAJOR (metric 10, :762): the max was judged on preTokens, not on the largest single request.
test('metric 10: no compaction and one 700k request fails the max target', () => {
  const f = ingestEntries([asst(SEAT, 1, [], 'big', { input_tokens: 5, cache_read_input_tokens: 700000, cache_creation_input_tokens: 5 })], {});
  const m = find(computeMetrics([f], {}), 10);
  assert.equal(m.value.maxRequestContext, 700010);
  assert.equal(m.meets, false);
});

test('metric 10: a small compaction mean with one 700k request still fails', () => {
  const f = ingestEntries([
    sys(SEAT, 5, 'compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 200000 } }),
    asst(SEAT, 6, [], 'big', { input_tokens: 5, cache_read_input_tokens: 700000, cache_creation_input_tokens: 5 }),
  ], {});
  assert.equal(find(computeMetrics([f], {}), 10).meets, false);
});

// MINOR 6 (:694).
test('metric 5: requests with zero hook blocks is meets null, not a pass', () => {
  const f = ingestEntries([asst(SEAT, 1, [], 'r1')], {});
  const m = find(computeMetrics([f], {}), 5);
  assert.equal(m.value.blocks, 0);
  assert.equal(m.meets, null);
});

// MINOR 4 (:173, :687): a lowercase rule-file token from transcript text reached the report as a key.
test('metric 5: the report never shows a rule file name taken from the transcript unless the manifest lists it', () => {
  const f = ingestEntries([
    asst(SEAT, 1, [], 'r1'),
    hook(SEAT, 2, 'PreToolUse', ['[rule-router] On-demand rule for this call. Read the rule: zebrasecret-x.md first.']),
  ], {});
  const m = find(computeMetrics([f], {}), 5);
  const keys = Object.keys(m.value.ruleRouter.byFile);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^other-\d+$/);
  assert.ok(!JSON.stringify(m).includes('zebrasecret'));
});

// MINOR 7 (:404).
test('metric 1: a note that quotes the persisted-output tag is not a cut banner', () => {
  const quoted = '## 2 lane update(s) since you last looked\n- the note says <persisted-output> in plain words';
  const f = ingestEntries([hook(BLD, 5, 'UserPromptSubmit', [quoted])], {});
  const m = find(computeMetrics([f], {}), 1);
  assert.equal(m.value.totalBanners, 1);
  assert.equal(m.value.cutBanners, 0);
  assert.equal(m.meets, true);
});

// MINOR 8 (:170, :406).
test('metric 1: a cut SessionStart board is counted in its own field, not as a cut lane banner', () => {
  const board = '<persisted-output>\nOutput too large (12.3KB). Full output saved to: somewhere\n\nPreview (first 2KB):\n## Lane board alpha\n- row\n</persisted-output>';
  const f = ingestEntries([hook(BLD, 5, 'SessionStart', [board])], {});
  const m = find(computeMetrics([f], {}), 1);
  assert.equal(m.value.cutBanners, 0);
  assert.equal(m.value.totalBanners, 0);
  assert.equal(m.value.cutSessionStartBoards, 1);
});

// MINOR 9 (:406).
test('metric 1: a banner in the 2-hour tail after --until is not in the totals', () => {
  const stub = '<persisted-output>\nOutput too large (12.3KB). Full output saved to: somewhere\n\nPreview (first 2KB):\n## 5 lane update(s) since you last looked\n- alpha\n</persisted-output>';
  const whole = '## 1 lane update(s) since you last looked\n- alpha bravo note';
  const opts = { until: BASE + 3600 * 1000 };
  const f = ingestEntries([hook(BLD, 5, 'UserPromptSubmit', [whole]), hook(BLD, 3700, 'UserPromptSubmit', [stub])], opts);
  const m = find(computeMetrics([f], opts), 1);
  assert.equal(m.value.totalBanners, 1);
  assert.equal(m.value.cutBanners, 0);
});

// MINOR 10 (:499).
test('eventSends: a self-addressed note row is not a DM', () => {
  const rows = [
    { kind: 'note', session_id: SEAT, to_session_id: SEAT, body: T1, occurred_at: iso(10) },
    { kind: 'note', session_id: SEAT, to_session_id: BLD, body: T2, occurred_at: iso(10) },
  ];
  const sends = eventSends(rows, {});
  assert.equal(sends.length, 1);
  assert.equal(sends[0].toHex, 'bbbbbbbb');
});

// MINOR 11 (:726).
test('metric 7: a pass on waits alone is null because taps per landed PR is not computed; a failure stays false', () => {
  const q = (id) => use('AskUserQuestion', { questions: [{ question: 'alpha?', header: 'h', options: [] }] }, id);
  const quick = ingestEntries([asst(SEAT, 0, [q('a1')]), result(SEAT, 5, 'a1', 'ok'), asst(SEAT, 10, [q('a2')]), result(SEAT, 20, 'a2', 'ok')], {});
  const mq = find(computeMetrics([quick], {}), 7);
  assert.equal(mq.value.paired, 2);
  assert.equal(mq.meets, null);
  const slow = [];
  for (let i = 0; i < 15; i++) slow.push(asst(SEAT, i * 1000, [q(`s${i}`)]), result(SEAT, i * 1000 + 400, `s${i}`, 'ok'));
  const ms = find(computeMetrics([ingestEntries(slow, {})], {}), 7);
  assert.equal(ms.value.waitsOver300s, 15);
  assert.equal(ms.meets, false);
});

// MINOR 12 (:705-706).
test('metric 6: in a window under one day the idle cache-read share is judged; the scaled count is information', () => {
  const fire = (sec) => ({ type: 'user', sessionId: SEAT, timestamp: iso(sec), isMeta: true, scheduledTaskId: 't', wakeupSource: 'schedule_wakeup', message: { content: 'Seat check for lane alpha' } });
  const opts = { since: BASE, until: BASE + 3600 * 1000 };
  const f = ingestEntries([
    fire(10), asst(SEAT, 11, [use('Bash', { command: 'node lane.mjs board' })], 'k1', { input_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
    sys(SEAT, 12, 'turn_duration'),
    asst(SEAT, 30, [], 'k2', { input_tokens: 1, cache_read_input_tokens: 19000, cache_creation_input_tokens: 0 }),
  ], opts);
  const m = find(computeMetrics([f], opts), 6);
  assert.equal(m.value.idleChecks, 1);
  assert.equal(m.value.idleChecksPer3Days, 72);
  assert.equal(m.value.idleShareOfCacheRead, 0.05);
  assert.equal(m.meets, true);
});

// MINOR 14 (:475, :456).
test('ingestFile: the session id comes from the entries, not from the file name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd2-metrics-id-'));
  try {
    const named = path.join(dir, 'cccccccc-renamed.jsonl');
    fs.writeFileSync(named, `${JSON.stringify(asst(SEAT, 1, [], 'r1'))}\n`);
    assert.equal((await ingestFile(named, {})).id8, 'aaaaaaaa');
    const bare = path.join(dir, `${SEAT}.jsonl`);
    fs.writeFileSync(bare, `${JSON.stringify({ type: 'assistant', timestamp: iso(1), requestId: 'r2', message: { id: 'r2', content: [] } })}\n`);
    assert.equal((await ingestFile(bare, {})).id8, 'unknown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MINOR 15 (:184, :371-375). lane.mjs usage is: say "message" [--to <name>].
test('parseLaneSays: --to is found after the message', () => {
  const [a] = parseLaneSays(`node C:/x/lane.mjs say "${T1}" --to bbbbbbbb`);
  assert.equal(a.toHex, 'bbbbbbbb');
  const [b] = parseLaneSays(`node C:/x/lane.mjs say "${T1}" --to trex`);
  assert.equal(b.toName, 'trex');
});

// D6: lane.mjs prints "sent to board <key>" for a broadcast (no #sid8). The fixture is that real shape.
test('lane say results: a broadcast say before a directed one does not shift the receiver of the directed send', () => {
  const cmd = `node C:/x/lane.mjs say "broadcast words about ${T1}"; node C:/x/lane.mjs say --to bbbbbbbb "${T2}"`;
  const f = ingestEntries([
    asst(SEAT, 10, [use('PowerShell', { command: cmd }, 'bc1')]),
    result(SEAT, 11, 'bc1', 'x', { toolUseResult: { stdout: 'sent to board k\nsent to trex #bbbbbbbb' } }),
  ], {});
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0].toHex, null);
  assert.equal(f.sends[0].directed, false);
  assert.equal(f.sends[1].toHex, 'bbbbbbbb');
  assert.deepEqual(f.sends[1].probes, sendProbes(T2));
});

// D6: with a variable receiver the broadcast must not take the line of the directed send.
test('lane say results: a directed send with a variable receiver takes the leftover line, a broadcast never does', () => {
  const cmd = `node C:/x/lane.mjs say "broadcast words about ${T1}"; node C:/x/lane.mjs say --to $peer "${T2}"`;
  const f = ingestEntries([
    asst(SEAT, 10, [use('PowerShell', { command: cmd }, 'bc2')]),
    result(SEAT, 11, 'bc2', 'x', { toolUseResult: { stdout: 'sent to board k\nsent to trex #bbbbbbbb' } }),
  ], {});
  assert.equal(f.sends[0].toHex, null);
  assert.equal(f.sends[1].toHex, 'bbbbbbbb');
  const an = analyzeDirected([f], {});
  assert.equal(an.records[0].status, 'undirected');
  assert.notEqual(an.records[1].status, 'undirected');
});

// D10: a --to inside the quoted message is message text, not the receiver.
test('parseLaneSays: a --to inside the quoted message is not the receiver', () => {
  const [a] = parseLaneSays(`node C:/x/lane.mjs say "use --to trex for ${T1}" --to bbbbbbbb`);
  assert.equal(a.toHex, 'bbbbbbbb');
  assert.equal(a.toName, null);
  const [b] = parseLaneSays(`node C:/x/lane.mjs say "use --to trex for ${T1}"`);
  assert.equal(b.toName, null);
  assert.equal(b.directed, false);
  const [c] = parseLaneSays(`node C:/x/lane.mjs say --to "trex" "${T1}"`);
  assert.equal(c.toName, 'trex');
});

// D1: the segment of a send ends at the next shell separator, so a later command is not part of its text.
test('parseLaneSays: the text of a send ends at the next ; | & or line break outside quotes', () => {
  const [a] = parseLaneSays(`node C:/x/lane.mjs say --to bbbbbbbb "${T1}"; echo ${T3} and more words here`);
  assert.deepEqual(a.probes, sendProbes(T1));
  const [b] = parseLaneSays(`node C:/x/lane.mjs say --to bbbbbbbb "${T1}" | Select-String ${T3} more words`);
  assert.deepEqual(b.probes, sendProbes(T1));
  const [c] = parseLaneSays(`node C:/x/lane.mjs say --to bbbbbbbb "${T1}; ${T2}"`);
  assert.deepEqual(c.probes, sendProbes(`${T1}; ${T2}`));
});

// N1: the hook cuts a long DM body and ends it with a marker. A DM delivered in part is a cut, not a loss.
const LONG_BODY = Array.from({ length: 150 }, (_, i) => `wordx${i}k`).join(' ');
const CUT_TAIL = '\u2026[cut, 1100 more bytes. Full text: node C:/x/lane.mjs inbox --id 5]';
test('metric 3: a long DM cut by the hook (marker, partial hit) is cut, not unexplained loss', () => {
  const sender = ingestEntries(saySend(10, 'n1a', 'bbbbbbbb', LONG_BODY), {});
  const banner = `## 1 lane update(s) since you last looked\n- (direct to you) ${LONG_BODY.slice(0, 400)}${CUT_TAIL}`;
  const recv = ingestEntries([hook(BLD, 40, 'UserPromptSubmit', [banner]), asst(BLD, 50, [])], {});
  assert.equal(recv.arrivals[0].bodyCut, true);
  const an = analyzeDirected([sender, recv], {});
  assert.deepEqual(an.records.map((r) => r.status), ['cut']);
  const m3 = find(computeMetrics([sender, recv], {}), 3);
  assert.equal(m3.value.lane.unexplainedLoss, 0);
  assert.equal(m3.value.lane.cutExplained, 1);
});

test('metric 3: the same partial hit with no cut marker on the arrival stays a loss', () => {
  const sender = ingestEntries(saySend(10, 'n1b', 'bbbbbbbb', LONG_BODY), {});
  const banner = `## 1 lane update(s) since you last looked\n- (direct to you) ${LONG_BODY.slice(0, 400)}`;
  const recv = ingestEntries([hook(BLD, 40, 'UserPromptSubmit', [banner]), asst(BLD, 50, [])], {});
  assert.equal(recv.arrivals[0].bodyCut, false);
  assert.deepEqual(analyzeDirected([sender, recv], {}).records.map((r) => r.status), ['lost']);
});

// N2: metric 3 gave a pass on one matched send while every other send was never measured.
test('metric 3: one matched send plus a $MSG-only send (untestable) gives meets null, not a pass', () => {
  const sender = ingestEntries([...saySend(10, 'n2a', 'bbbbbbbb', T1), ...saySendRaw(20, 'n2b', 'node C:/x/lane.mjs say --to bbbbbbbb "$MSG"')], {});
  const banner = `## 1 lane update(s) since you last looked\n- (direct to you) ${T1}`;
  const recv = ingestEntries([hook(BLD, 40, 'UserPromptSubmit', [banner]), asst(BLD, 50, [])], {});
  const m3 = find(computeMetrics([sender, recv], {}), 3);
  assert.equal(m3.value.lane.matched, 1);
  assert.equal(m3.value.lane.untestable, 1);
  assert.equal(m3.meets, null);
});

// N3: a directed send whose receiver never resolved left every count as "undirected".
test('analyzeDirected: a say --to $peer with no "sent to" line is receiver_unknown, a broadcast stays undirected', () => {
  const f = ingestEntries([
    asst(SEAT, 10, [use('PowerShell', { command: `node C:/x/lane.mjs say --to $peer "${T1}"; node C:/x/lane.mjs say "${T2}"` }, 'n3')]),
    result(SEAT, 11, 'n3', 'done'),
  ], {});
  const an = analyzeDirected([f], {});
  assert.deepEqual(an.records.map((r) => r.status), ['receiver_unknown', 'undirected']);
  const m3 = find(computeMetrics([f], {}), 3);
  assert.equal(m3.value.lane.receiverUnknown, 1);
  assert.equal(m3.meets, null);
});

// N8: PowerShell has no backslash escape, so a message that ends in a backslash closes its quote.
test('parseLaneSays: in PowerShell a backslash before the closing quote does not keep the quote open', () => {
  const tail = ` echo ${T3} and more words here`;
  const msg = `${T1} C:\\dir\\`;
  const [ps] = parseLaneSays(`node C:/x/lane.mjs say --to bbbbbbbb "${msg}"; ${tail}`, 'PowerShell');
  assert.deepEqual(ps.probes, parseLaneSays(`node C:/x/lane.mjs say --to bbbbbbbb "${msg}"`, 'PowerShell')[0].probes);
  // Bash keeps the backslash escape: an escaped quote does not end the message.
  const [sh] = parseLaneSays(`node C:/x/lane.mjs say "${T1} \\"quoted; ${T2}\\"" --to bbbbbbbb`, 'Bash');
  assert.deepEqual(sh.probes, sendProbes(`${T1} quoted ${T2}`));
});

// N5: a camelCase export was dropped as "no DM row".
test('eventSends: a camelCase row (toSessionId, sessionId, occurredAt) is a DM', () => {
  const rows = [{ kind: 'note', sessionId: SEAT, toSessionId: BLD, body: T1, occurredAt: iso(10) }];
  const sends = eventSends(rows, {});
  assert.equal(sends.length, 1);
  assert.equal(sends[0].toHex, 'bbbbbbbb');
  assert.equal(sends[0].fromId8, 'aaaaaaaa');
});

// N11: --seat unk matched the id "unknown" of a session with no id.
test('parseArgs: --seat must start with 8 hex characters', () => {
  assert.ok(parseArgs(['--transcripts', 'x', '--seat', 'unk']).errors.length > 0);
  assert.ok(parseArgs(['--transcripts', 'x', '--seat', 'aaaa']).errors.length > 0);
  assert.equal(parseArgs(['--transcripts', 'x', '--seat', 'aaaaaaaa']).errors.length, 0);
  assert.equal(parseArgs(['--transcripts', 'x', '--seat', SEAT]).errors.length, 0);
});

// ---- parsers --------------------------------------------------------------
test('unparseable lines are counted by the file reader and skipped; the good lines still count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd2-metrics-bad-'));
  try {
    const file = path.join(dir, `${SEAT}.jsonl`);
    fs.writeFileSync(file, [JSON.stringify(asst(SEAT, 1, [], 'r1')), '{ not json', '', 'also not json', JSON.stringify(asst(SEAT, 2, [], 'r2'))].join('\n'));
    const f = await ingestFile(file, {});
    assert.equal(f.badLines, 2);
    assert.equal(f.requests, 2);
    assert.equal(f.id8, 'aaaaaaaa');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('arrivalWindows: a text shorter than one window gives no key', () => {
  assert.equal(arrivalWindows('abc').length, 0);
  assert.ok(arrivalWindows('abcdefghijklmnopqrstuvwxyz').length > 0);
});

// ---- the CLI --------------------------------------------------------------
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { windowsHide: true, encoding: 'utf8' });

test('CLI: no --transcripts prints usage and exits 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /usage/i);
});

test('CLI: --help exits 0; a path under the review-engine state folder is refused with exit 2', () => {
  assert.equal(run(['--help']).status, 0);
  const r = run(['--transcripts', 'C:/Users/example/.claude/state/review-engine/x.jsonl']);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /refus/i);
});

test('CLI output safety: a marker in message texts never reaches stdout or the --out file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd2-metrics-'));
  try {
    const M = 'ZEBRASECRET';
    const sendCmd = `node lane.mjs say --to bbbbbbbb "${M} ${LONG}"`;
    const seat = [
      asst(SEAT, 10, [use('PowerShell', { command: sendCmd }, 'z1')]),
      result(SEAT, 11, 'z1', 'x', { toolUseResult: { stdout: `sent to ${M} #bbbbbbbb` } }),
      asst(SEAT, 12, [use('SendMessage', { to: M, message: `${M} ${LONG}` }, 'z2')]),
      result(SEAT, 13, 'z2', 'x', { toolUseResult: { success: true, msg_id: 'mz' } }),
      asst(SEAT, 14, [use('AskUserQuestion', { questions: [{ question: `${M}?`, header: M, options: [] }] }, 'z3')]),
      result(SEAT, 20, 'z3', `${M} answer`),
      // A lowercase rule-file token that holds the marker: ruleFileName accepts it, so only the report keying can hide it.
      hook(SEAT, 21, 'PreToolUse', [`[rule-router] On-demand rule for this call. ${M} Read the rule: ${M}-x.md and zebrasecret-y.md and alpha-rule.md`]),
      prompt(SEAT, 22, `${M} prompt`),
    ].map((e) => JSON.stringify(e));
    seat.push(`{ broken json ${M}`);
    const bld = [
      sys(BLD, 1, 'turn_duration'),
      hook(BLD, 15, 'PostToolUse', [`## Direct message from another session\n${M} ${LONG}`]),
      { type: 'user', sessionId: BLD, timestamp: iso(14), origin: { kind: 'peer', msg_id: 'mz', body: `${M} body` }, message: { content: `${M} wrapper` } },
    ].map((e) => JSON.stringify(e));
    // The report goes to a folder that is not an input folder (D5).
    const inDir = path.join(dir, 'in');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(inDir);
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(inDir, `${SEAT}.jsonl`), seat.join('\n') + '\n');
    fs.writeFileSync(path.join(inDir, `${BLD}.jsonl`), bld.join('\n') + '\n');
    const events = path.join(dir, 'events.json');
    // Row 1 is a real DM to BLD. Row 2 is a self-addressed note: it is not a DM and must not count.
    fs.writeFileSync(events, JSON.stringify([
      { kind: 'note', session_id: SEAT, to_session_id: BLD, body: `${M} ${LONG}`, occurred_at: iso(10) },
      { kind: 'note', session_id: SEAT, to_session_id: SEAT, body: 'quartz meadow lantern orbit velvet', occurred_at: iso(10) },
    ]));
    const out = path.join(outDir, 'out.json');
    const r = run(['--transcripts', inDir, '--seat', 'aaaaaaaa', '--events', events, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const written = fs.readFileSync(out, 'utf8');
    // D7: JSON.stringify doubles the backslashes of a Windows path, so a whole-path check cannot fail.
    // The folder name cd2-metrics-XXXX is unique: it must not appear in any text.
    const leakName = path.basename(dir);
    assert.match(leakName, /^cd2-metrics-/);
    for (const text of [r.stdout, r.stderr, written]) {
      assert.ok(!/zebrasecret/i.test(text), 'marker leaked');
      assert.ok(!text.includes(leakName), 'temp path leaked');
    }
    const parsed = JSON.parse(written);
    assert.equal(parsed.metrics.length, 10);
    assert.ok(parsed.parse.badLines >= 1);
    // The events path takes effect: one lane DM from the events row, matched; the self-addressed row is not counted.
    assert.equal(parsed.eventsUsed, true);
    const m2 = find(parsed.metrics, 2);
    const m3 = find(parsed.metrics, 3);
    assert.equal(m2.value.lane.all.uncapped.n, 1);
    assert.equal(m3.value.lane.evaluable, 1);
    assert.equal(m3.value.lane.matched, 1);
    assert.equal(m3.value.lane.unexplainedLoss, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Safety (:856): --out could name an input transcript and overwrite it after ingestion.
test('CLI: an --out that is an input file or ends in .jsonl is refused and the input stays unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd2-metrics-out-'));
  try {
    const line = `${JSON.stringify(asst(SEAT, 1, [], 'r1'))}\n`;
    const jsonl = path.join(dir, `${SEAT}.jsonl`);
    const txt = path.join(dir, 'seat-copy.txt');
    fs.writeFileSync(jsonl, line);
    fs.writeFileSync(txt, line);
    const r1 = run(['--transcripts', jsonl, '--out', jsonl]);
    assert.equal(r1.status, 2, r1.stderr);
    assert.equal(fs.readFileSync(jsonl, 'utf8'), line);
    const r2 = run(['--transcripts', txt, '--out', txt]);
    assert.equal(r2.status, 2, r2.stderr);
    assert.equal(fs.readFileSync(txt, 'utf8'), line);
    const other = path.join(dir, 'other.jsonl');
    const r3 = run(['--transcripts', txt, '--out', other]);
    assert.equal(r3.status, 2, r3.stderr);
    assert.equal(fs.existsSync(other), false);
    for (const r of [r1, r2, r3]) assert.ok(!(r.stdout + r.stderr).includes(dir), 'temp path leaked');
    // D5: an --out in the folder of an input is refused too.
    const inFolder = run(['--transcripts', txt, '--out', path.join(dir, 'report.json')]);
    assert.equal(inFolder.status, 2, inFolder.stderr);
    assert.equal(fs.existsSync(path.join(dir, 'report.json')), false);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    const ok = run(['--transcripts', txt, '--out', path.join(outDir, 'report.json')]);
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// D5 (:921-931, :966): --out could overwrite any existing file that is not an input and not .jsonl.
test('CLI: an --out onto an existing file is refused and the file stays unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd2-metrics-wx-'));
  try {
    const inDir = path.join(dir, 'in');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(inDir);
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(inDir, `${SEAT}.jsonl`), `${JSON.stringify(asst(SEAT, 1, [], 'r1'))}\n`);
    const existing = path.join(outDir, 'settings-like.json');
    fs.writeFileSync(existing, 'keep me');
    const r = run(['--transcripts', inDir, '--out', existing]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'keep me');
    assert.match(r.stderr, /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Helper for the CLI fault tests: one folder with one valid transcript line.
function withInput(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd2-metrics-flt-'));
  try {
    const inDir = path.join(dir, 'in');
    fs.mkdirSync(inDir);
    fs.writeFileSync(path.join(inDir, `${SEAT}.jsonl`), `${JSON.stringify(asst(SEAT, 1, [], 'r1'))}\n`);
    fn(dir, inDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// D2 (:512): a bad events shape became an empty lane channel, and metrics 1 to 3 could pass.
test('CLI: an events file with a bad shape, or with no parseable time, exits 2', () => {
  withInput((dir, inDir) => {
    const row = { kind: 'note', session_id: SEAT, to_session_id: BLD, body: T1, occurred_at: iso(10) };
    const wrap = path.join(dir, 'wrap.json');
    fs.writeFileSync(wrap, JSON.stringify({ data: [row] }));
    const r1 = run(['--transcripts', inDir, '--events', wrap]);
    assert.equal(r1.status, 2, r1.stderr);
    assert.match(r1.stderr, /rows array/);
    const badTime = path.join(dir, 'badtime.json');
    fs.writeFileSync(badTime, JSON.stringify([{ ...row, occurred_at: 'not a time' }, { ...row, occurred_at: 'also not' }]));
    const r2 = run(['--transcripts', inDir, '--events', badTime]);
    assert.equal(r2.status, 2, r2.stderr);
    assert.match(r2.stderr, /parses/);
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ rows: [row, { ...row, occurred_at: 'not a time' }] }));
    const ok = run(['--transcripts', inDir, '--events', good]);
    assert.equal(ok.status, 0, ok.stderr);
    const rep = JSON.parse(ok.stdout);
    assert.equal(rep.eventsRows, 2);
    assert.equal(rep.eventsSkipped, 1);
  });
});

// D8 (:962-969): a harness fault gave an all-null report and exit 0.
test('CLI: no parsed line, or a --seat that names no session, exits 2', () => {
  withInput((dir, inDir) => {
    const junkDir = path.join(dir, 'junk');
    fs.mkdirSync(junkDir);
    fs.writeFileSync(path.join(junkDir, 'a.jsonl'), 'not json\n{ also not\n');
    const r1 = run(['--transcripts', junkDir]);
    assert.equal(r1.status, 2, r1.stderr);
    assert.equal(r1.stdout, '');
    const r2 = run(['--transcripts', inDir, '--seat', 'ffffffff']);
    assert.equal(r2.status, 2, r2.stderr);
    assert.equal(r2.stdout, '');
    assert.equal(run(['--transcripts', inDir, '--seat', 'aaaaaaaa']).status, 0);
  });
});

// D11 (:874-876): since at or after until gave days of 0 or less, and metric 6 counted by default.
test('CLI: --since at or after --until exits 2', () => {
  withInput((dir, inDir) => {
    const t = '2026-11-10T12:00:00Z';
    assert.equal(run(['--transcripts', inDir, '--since', t, '--until', t]).status, 2);
    assert.equal(run(['--transcripts', inDir, '--since', '2026-11-11T00:00:00Z', '--until', t]).status, 2);
    assert.equal(run(['--transcripts', inDir, '--since', t, '--until', '2026-11-10T13:00:00Z']).status, 0);
  });
});

// N5: an empty events export, with directed lane sends in the transcripts, gave an empty lane channel and exit 0.
test('CLI: an events file with no DM row while the transcripts hold a directed lane send exits 2', () => {
  withInput((dir) => {
    const inDir = path.join(dir, 'in-say');
    fs.mkdirSync(inDir);
    fs.writeFileSync(path.join(inDir, `${SEAT}.jsonl`), `${saySend(10, 'e1', 'bbbbbbbb', T1).map((e) => JSON.stringify(e)).join('\n')}\n`);
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '[]');
    const r = run(['--transcripts', inDir, '--events', empty]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no lane DM row/);
    assert.equal(r.stdout, '');
    const camel = path.join(dir, 'camel.json');
    fs.writeFileSync(camel, JSON.stringify([{ kind: 'note', sessionId: SEAT, toSessionId: BLD, body: T1, occurredAt: iso(10) }]));
    const ok = run(['--transcripts', inDir, '--events', camel]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).eventsRows, 1);
  });
});

// N6: valid JSON with no entry in the window gave an all-null report and exit 0.
test('CLI: input with no entry inside the window exits 2', () => {
  withInput((dir, inDir) => {
    const r1 = run(['--transcripts', inDir, '--since', '2027-01-01T00:00:00Z']);
    assert.equal(r1.status, 2, r1.stderr);
    assert.match(r1.stderr, /inside the window/);
    assert.equal(r1.stdout, '');
    const noTime = path.join(dir, 'notime');
    fs.mkdirSync(noTime);
    fs.writeFileSync(path.join(noTime, 'a.jsonl'), `${JSON.stringify({ type: 'assistant', sessionId: SEAT, message: { content: [] } })}\n`);
    const r2 = run(['--transcripts', noTime]);
    assert.equal(r2.status, 2, r2.stderr);
    assert.equal(r2.stdout, '');
  });
});

// N7: --out could create a new file under the home .claude folder (rules/ loads in every session).
// The test points the home at a temp folder, so no real home file is at risk.
test('CLI: an --out under the home .claude folder is refused; one elsewhere is written', () => {
  withInput((dir, inDir) => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'elsewhere'));
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const go = (out) => spawnSync(process.execPath, [CLI, '--transcripts', inDir, '--out', out], { windowsHide: true, encoding: 'utf8', env });
    for (const out of [path.join(home, '.claude', 'new.json'), path.join(home, '.claude', 'rules', 'new.json')]) {
      const r = go(out);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /home \.claude/);
      assert.equal(fs.existsSync(out), false);
      assert.ok(!(r.stdout + r.stderr).includes(dir), 'temp path leaked');
    }
    const okOut = path.join(dir, 'elsewhere', 'report.json');
    assert.equal(go(okOut).status, 0);
    assert.equal(fs.existsSync(okOut), true);
  });
});

// N11: a session with no id is named unknown; --seat unk must not select it.
test('CLI: --seat unk is refused even when a session has no id', () => {
  withInput((dir) => {
    const noId = path.join(dir, 'noid');
    fs.mkdirSync(noId);
    fs.writeFileSync(path.join(noId, 'a.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: iso(1), requestId: 'r1', message: { id: 'r1', content: [] } })}\n`);
    const r = run(['--transcripts', noId, '--seat', 'unk']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /8 hex/);
  });
});
