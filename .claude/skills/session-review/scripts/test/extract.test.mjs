// Tests for the session-review extractor. Run: node --test .claude/skills/session-review/scripts/test/
// Each test names the source change that would make it fail (see the table in the skill spec).
// Fixtures are hand-shrunk copies of real record shapes. A secret is never stored in a fixture:
// the placeholder __SECRET__ is replaced with a token built at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, makeCtx } from '../extract.mjs';
import { isHuman } from '../lib/human.mjs';
import { redact, redactTruncate } from '../lib/redact.mjs';
import { isCheckCommand } from '../lib/scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const EXTRACT = path.join(HERE, '..', 'extract.mjs');
const EXCERPT = path.join(HERE, '..', 'excerpt.mjs');
const PREFIX = 'C--Users-dkhay-continuous-claude';
const FAKE_TOKEN = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');

const SID = {
  chainA: 'a1000000-0000-4000-8000-000000000001',
  chainB: 'a2000000-0000-4000-8000-000000000002',
  costTwo: 'b1000000-0000-4000-8000-000000000001',
  noCost: 'b2000000-0000-4000-8000-000000000002',
  hook: 'c1000000-0000-4000-8000-000000000001',
  malformed: 'd1000000-0000-4000-8000-000000000001',
  dstBefore: 'e1000000-0000-4000-8000-000000000001',
  dstAfter: 'e2000000-0000-4000-8000-000000000002',
  active: 'f1000000-0000-4000-8000-000000000001',
  headless: '91000000-0000-4000-8000-000000000001',
  noHuman: '92000000-0000-4000-8000-000000000002',
  reviewTyped: '93000000-0000-4000-8000-000000000003',
  reviewSkill: '94000000-0000-4000-8000-000000000004',
  normal: '95000000-0000-4000-8000-000000000005',
  usage: '96000000-0000-4000-8000-000000000006',
  stale: '97000000-0000-4000-8000-000000000007',
  fresh: '98000000-0000-4000-8000-000000000008',
  rework: '99000000-0000-4000-8000-000000000009',
};

/** Build a temp HOME with fixtures installed. ageMin sets the file age; later entries are newer. */
function setup(names, { folder = PREFIX, ageMin = 120, env = {}, guard = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
  const dir = path.join(home, '.claude', 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'continuous-claude'), { recursive: true });
  names.forEach((n, i) => {
    const src = fs.readFileSync(path.join(FIX, `${n}.jsonl`), 'utf8').replaceAll('__SECRET__', FAKE_TOKEN);
    const dst = path.join(dir, `${n}.jsonl`);
    fs.writeFileSync(dst, src);
    const t = new Date(Date.now() - (ageMin - i) * 60000);
    fs.utimesSync(dst, t, t);
  });
  if (guard) {
    fs.mkdirSync(path.join(home, '.claude', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'logs', 'guard-decisions.jsonl'), guard.map((g) => JSON.stringify(g)).join('\n') + '\n');
  }
  const ctx = makeCtx({ home, repo: path.join(home, 'continuous-claude'), env });
  return { home, ctx, dir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const opts = (o = {}) => ({ days: 45, maxSessions: 12, includeHeadless: false, includeSubagents: false, projectPrefix: PREFIX, ...o });
const byId = (res, sid) => res.digests.find((d) => d.sid === sid);

// ---- 1. resume chain: shared uuids are counted once and linked
test('1 resume chain: replayed records are dropped once and the files share a chain_id', async () => {
  const t = setup([SID.chainA, SID.chainB]);
  try {
    const res = await run(opts(), t.ctx);
    const a = byId(res, SID.chainA), b = byId(res, SID.chainB);
    assert.equal(a.humans.human_turns, 1);
    assert.equal(b.humans.human_turns, 1, 'replayed prompt must not count in the later file');
    assert.equal(b.quality.dup_uuids_dropped, 4);
    assert.equal(a.chain_id, SID.chainA);
    assert.equal(b.chain_id, SID.chainA);
    assert.equal(res.inventory.chains.length, 1);
    assert.deepEqual([...res.inventory.chains[0].members].sort(), [SID.chainA, SID.chainB]);
    assert.equal(a.cost.total_usd, 0.5);
    assert.equal(b.cost.total_usd, 0.7, 'cost is per file, never summed over a chain');
  } finally { t.cleanup(); }
});

// ---- 2. usage counts once per message.id
test('2 usage: one message written as several lines counts once with the max per field', async () => {
  const t = setup([SID.usage]);
  try {
    const d = byId(await run(opts(), t.ctx), SID.usage);
    assert.equal(d.cost.tokens.output, 57); // max(5,50,20) + 7
    assert.equal(d.cost.tokens.input, 101); // 100 + 1, not 300 + 1
    assert.equal(d.cost.tokens.cache_read, 1002);
    assert.equal(d.cost.tokens.cache_create, 13);
  } finally { t.cleanup(); }
});

// ---- 3. last cost-state wins
test('3 cost-state: the last record wins', async () => {
  const t = setup([SID.costTwo]);
  try {
    const d = byId(await run(opts(), t.ctx), SID.costTwo);
    assert.equal(d.cost.source, 'cost-state');
    assert.equal(d.cost.total_usd, 0.9);
    assert.equal(d.time.wall_ms, 5000);
    assert.equal(d.cost.hasUnknownModelCost, false);
    assert.equal(d.cost.by_model['claude-sonnet-5-5'], 0.9);
    assert.equal(d.context.lines_added, 5);
  } finally { t.cleanup(); }
});

// ---- 4. no cost-state: no USD, no wall time
test('4 missing cost-state gives null USD, null wall_ms and source unavailable', async () => {
  const t = setup([SID.noCost], { ageMin: 300 });
  try {
    const d = byId(await run(opts(), t.ctx), SID.noCost);
    assert.equal(d.cost.source, 'unavailable');
    assert.equal(d.cost.total_usd, null);
    assert.equal(d.cost.by_model, null);
    assert.equal(d.time.wall_ms, null);
    assert.equal(d.context.lines_added, null);
    assert.equal(d.partial, false);
  } finally { t.cleanup(); }
});

test('4b a live file without cost-state is reviewed and marked partial', async () => {
  const t = setup([SID.noCost], { ageMin: 1 });
  try {
    const res = await run(opts(), t.ctx);
    const d = byId(res, SID.noCost);
    assert.ok(d, 'live session must not be skipped');
    assert.equal(d.partial, true);
  } finally { t.cleanup(); }
});

// ---- 5. isHuman
test('5 isHuman rejects sidechain, sdk-cli, meta, compact-summary, injected and tool_result turns', () => {
  const mk = (o) => ({ type: 'user', message: { role: 'user', content: 'hello there' }, ...o });
  assert.equal(isHuman(mk({ origin: { kind: 'human' } })), true);
  assert.equal(isHuman(mk({ isSidechain: true, origin: { kind: 'human' } })), false);
  assert.equal(isHuman(mk({ entrypoint: 'sdk-cli', origin: { kind: 'human' } })), false);
  assert.equal(isHuman(mk({ isMeta: true, origin: { kind: 'human' } })), false);
  assert.equal(isHuman(mk({ isCompactSummary: true })), false);
  assert.equal(isHuman(mk({ origin: { kind: 'task-notification' } })), false);
  assert.equal(isHuman(mk({ message: { role: 'user', content: '<system-reminder>x</system-reminder>' } })), false);
  assert.equal(isHuman(mk({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } })), false);
  assert.equal(isHuman({ type: 'assistant', message: { role: 'assistant', content: 'x' } }), false);
});

// ---- 6. hook block detection and guard join
const T0 = Date.parse('2026-11-03T12:00:06.000Z');
const guardRow = (dtMs, extra = {}) => ({ ts: new Date(T0 + dtMs).toISOString(), hook: 'destructive-command-guard', tool: 'Bash', decision: 'deny', reason: 'recursive rm', session_id: SID.hook, agent: false, ...extra });

test('6 hook block is found and joined to its guard within 5 s', async () => {
  const t = setup([SID.hook], { guard: [guardRow(-1500), guardRow(-400, { tool: 'PowerShell', hook: 'other-guard' }), { ...guardRow(0), session_id: undefined, hook: 'no-session-guard' }] });
  try {
    const d = byId(await run(opts(), t.ctx), SID.hook);
    const blocks = d.hooks.blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].guard, 'destructive-command-guard');
    assert.equal(blocks[0].tool, 'Bash');
    assert.equal(blocks[0].decision, 'reject');
    assert.equal(blocks[0].family, 'destructive command in an unattended/bypass context');
    assert.equal(blocks[0].next_calls.length, 3);
    assert.equal(blocks[0].next_calls[0].name, 'PowerShell');
    assert.match(blocks[0].next_calls[1].cmd, /SKIP_DESTRUCTIVE_GUARD/);
    assert.equal(blocks[0].next_calls[2].name, 'Bash');
  } finally { t.cleanup(); }
});

test('6b a guard row outside 5 s leaves guard unknown and the family text in place', async () => {
  const t = setup([SID.hook], { guard: [guardRow(-9000)] });
  try {
    const blk = byId(await run(opts(), t.ctx), SID.hook).hooks.blocks[0];
    assert.equal(blk.guard, 'unknown');
    assert.match(blk.family, /destructive command/);
  } finally { t.cleanup(); }
});

test('6c the Command line of a block is redacted', async () => {
  const t = setup([SID.hook]);
  try {
    const blk = byId(await run(opts(), t.ctx), SID.hook).hooks.blocks[0];
    assert.ok(!blk.cmd.includes('sk-ant'), blk.cmd);
    assert.ok(!JSON.stringify(blk).includes(FAKE_TOKEN));
    assert.match(blk.cmd, /REDACTED/);
  } finally { t.cleanup(); }
});

// ---- 7. denials split by source; a hook reject counts once
test('7 denials: hook counts once, and there is no permission-rule bucket', async () => {
  const t = setup([SID.hook]);
  try {
    const d = byId(await run(opts(), t.ctx), SID.hook);
    assert.deepEqual(d.tools.denials, { hook: 1, config: 1, user: 1, interrupted: 1 });
    assert.equal(d.tools.errors_by_class.hook_block, 1);
    assert.equal(d.tools.errors_by_class.exit_code, 1);
    assert.equal(Object.hasOwn(d.tools.denials, 'permission-rule'), false);
  } finally { t.cleanup(); }
});

test('7b hook timing, non-blocking errors and task notifications are read', async () => {
  const t = setup([SID.hook]);
  try {
    const d = byId(await run(opts(), t.ctx), SID.hook);
    assert.equal(d.hooks.hook_ms_by_name['destructive-command-guard'], 200);
    assert.equal(d.hooks.hook_non_blocking_errors.length, 1);
    assert.deepEqual(d.factory.task_notifications, { completed: 1, failed: 1 });
  } finally { t.cleanup(); }
});

// ---- 8. malformed lines
test('8 one malformed line does not abort the file', async () => {
  const t = setup([SID.malformed]);
  try {
    const res = await run(opts(), t.ctx);
    const d = byId(res, SID.malformed);
    assert.equal(d.quality.parse_errors, 2);
    assert.equal(d.humans.human_turns, 1);
    assert.equal(res.inventory.files_with_parse_errors, 1);
    assert.equal(d.cost.total_usd, 0.05, 'records after the bad lines are still read');
  } finally { t.cleanup(); }
});

// ---- 9. streaming: a 30 MB file under a 48 MB heap
test('9 a 30 MB transcript streams under --max-old-space-size=48', { timeout: 120000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-big-'));
  try {
    const dir = path.join(home, '.claude', 'projects', PREFIX);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(home, 'continuous-claude'), { recursive: true });
    const sid = 'ee000000-0000-4000-8000-000000000001';
    const fd = fs.openSync(path.join(dir, `${sid}.jsonl`), 'w');
    const pad = 'lorem ipsum '.repeat(170) + ' →'; // about 2 KB per record; one non-Latin1 char makes a whole-file string two-byte
    const mk = (i, type, content, extra = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, type, message: type === 'user' ? { role: 'user', content } : { model: 'claude-sonnet-5-5', id: `msg_${i}`, type: 'message', role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } }, uuid: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`, timestamp: new Date(Date.parse('2026-11-03T00:00:00Z') + i * 1000).toISOString(), entrypoint: 'cli', cwd: 'C:\\x', sessionId: sid, gitBranch: 'main', ...extra });
    let written = 0, i = 1;
    fs.writeSync(fd, mk(i++, 'user', 'start', { origin: { kind: 'human' }, promptSource: 'typed' }) + '\n');
    while (written < 30 * 1024 * 1024) {
      const line = mk(i++, 'assistant', [{ type: 'text', text: pad }]) + '\n';
      written += fs.writeSync(fd, line);
    }
    fs.writeSync(fd, JSON.stringify({ type: 'cost-state', sessionId: sid, totalCostUSD: 1, totalDuration: 1, modelUsage: {}, hasUnknownModelCost: false }) + '\n');
    fs.closeSync(fd);
    const t = new Date(Date.now() - 3 * 3600000);
    fs.utimesSync(path.join(dir, `${sid}.jsonl`), t, t);
    const out = path.join(home, 'out');
    const r = spawnSync(process.execPath, ['--max-old-space-size=48', EXTRACT, '--max-sessions', '3', '--out', out], { env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CODE_SESSION_ID: '' }, encoding: 'utf8' });
    assert.equal(r.status, 0, `exit ${r.status}\n${(r.stderr || '').slice(0, 800)}`);
    const inv = JSON.parse(fs.readFileSync(path.join(out, 'inventory.json'), 'utf8'));
    assert.equal(inv.sessions_sampled, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- 10. zone name across the CDT to CST change
test('10 local time prints CDT before 2026-11-01 and CST after it', async () => {
  const t = setup([SID.dstBefore, SID.dstAfter]);
  try {
    const res = await run(opts(), t.ctx);
    const b = byId(res, SID.dstBefore), a = byId(res, SID.dstAfter);
    assert.match(b.time.start_local, /^2026-10-31 10:00 CDT$/);
    assert.match(a.time.start_local, /^2026-11-02 09:00 CST$/);
    assert.match(a.time.end_local, /09:05 CST$/);
  } finally { t.cleanup(); }
});

// ---- 11. redaction
test('11 redaction: one case per pattern', () => {
  const cases = {
    'scheme user:pass': 'see https://bob:hunter2pw@example.com/x done',
    postgres: 'DB postgres://localhost:5432/continuous_claude here',
    redis: 'cache redis://10.0.0.1:6379/0 ok',
    mongodb: 'm mongodb+srv://cluster0.example.net/db ok',
    'sk-ant': `tok ${FAKE_TOKEN} end`,
    'sk-': `tok ${['sk', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-')} end`,
    ghp: `tok ${['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWX1234'].join('_')} end`,
    gho: `tok ${['gho', 'ABCDEFGHIJKLMNOPQRSTUVWX1234'].join('_')} end`,
    ghs: `tok ${['ghs', 'ABCDEFGHIJKLMNOPQRSTUVWX1234'].join('_')} end`,
    github_pat: `tok ${['github', 'pat', 'ABCDEFGHIJKLMNOPQRSTUV12345'].join('_')} end`,
    xox: `tok ${['xoxb', '1234567890', 'abcdefghij'].join('-')} end`,
    ntn: `tok ${['ntn', 'ABCDEFGHIJKLMNOPQRSTUV123456'].join('_')} end`,
    AKIA: `tok ${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')} end`,
    bearer: 'Authorization: Bearer abcdefghijklmnop1234567890',
    jwt: `jwt ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcDEF123_-xyz'].join('.')} end`,
    email: 'mail dave.example@example.org now',
    'KEY=value': `run MY_API_KEY=${['plain', 'value', '123'].join('')} now`,
    'TOKEN: value': `run SESSION_TOKEN: ${['abcdef', '12345'].join('')} now`,
    'password=': `db_password=${['hunter', '22'].join('')} now`,
    'named env': 'CONTINUOUS_CLAUDE_DB_URL=somethingnotaurl',
    'messaging token': `CLAUDE_CODE_MESSAGING_TOKEN=${['abc123', 'def456'].join('')}`,
  };
  const needles = {
    'scheme user:pass': 'hunter2pw', postgres: 'postgres://', redis: 'redis://', mongodb: 'mongodb+srv://',
    'sk-ant': 'ABCDEFGHIJKLMNOPQRSTUV', 'sk-': 'ABCDEFGHIJKLMNOPQRSTUVWX', ghp: 'ABCDEFGHIJKLMNOPQRSTUVWX1234', gho: 'ABCDEFGHIJKLMNOPQRSTUVWX1234',
    ghs: 'ABCDEFGHIJKLMNOPQRSTUVWX1234', github_pat: 'ABCDEFGHIJKLMNOPQRSTUV12345', xox: 'abcdefghij', ntn: 'ABCDEFGHIJKLMNOPQRSTUV123456',
    AKIA: 'ABCDEFGHIJKLMNOP', bearer: 'abcdefghijklmnop1234567890', jwt: 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', email: 'dave.example@',
    'KEY=value': ['plain', 'value', '123'].join(''), 'TOKEN: value': ['abcdef', '12345'].join(''), 'password=': ['hunter', '22'].join(''), 'named env': 'somethingnotaurl', 'messaging token': ['abc123', 'def456'].join(''),
  };
  for (const [name, input] of Object.entries(cases)) {
    const out = redact(input);
    assert.ok(!out.includes(needles[name]), `pattern "${name}" survived: ${out}`);
    assert.match(out, /REDACTED/, `pattern "${name}" left no marker: ${out}`);
  }
});

test('11b redaction: env values are removed even without a recognisable shape', () => {
  process.env.OPC_POSTGRES_URL = 'opaque-secret-value-9981';
  try {
    assert.ok(!redact('x opaque-secret-value-9981 y').includes('opaque-secret-value-9981'));
  } finally { delete process.env.OPC_POSTGRES_URL; }
});

test('11c redaction: ordinary words are not eaten', () => {
  assert.equal(redact('passes: 3 and keyword: x and monkey'), 'passes: 3 and keyword: x and monkey');
});

test('11d a secret at the 400-character cut does not leak a fragment', () => {
  const text = 'x'.repeat(395) + FAKE_TOKEN + ' tail';
  const out = redactTruncate(text, 400);
  assert.ok(out.length <= 400);
  assert.ok(!/sk-/.test(out), `fragment leaked: ${out.slice(380)}`);
});

// ---- 12. worktree folders
test('12 worktree folders under the project prefix are sampled', async () => {
  const t = setup([SID.normal], { folder: `${PREFIX}--claude-worktrees-session-review` });
  try {
    const res = await run(opts(), t.ctx);
    const d = byId(res, SID.normal);
    assert.ok(d, 'session in a worktree folder must be sampled');
    assert.equal(d.folder, `${PREFIX}--claude-worktrees-session-review`);
  } finally { t.cleanup(); }
});

// ---- 13. active time
test('13 active_ms is the sum of turn_duration, not last minus first', async () => {
  const t = setup([SID.active]);
  try {
    const d = byId(await run(opts(), t.ctx), SID.active);
    assert.equal(d.time.active_ms, 3000);
    assert.equal(d.time.wall_ms, 99999);
    assert.ok(d.time.idle_gaps_over_30m >= 1);
  } finally { t.cleanup(); }
});

// ---- 14. eligibility
test('14 self, review runs, headless and no-human sessions are skipped with a reason', async () => {
  const names = [SID.headless, SID.noHuman, SID.reviewTyped, SID.reviewSkill, SID.normal, SID.costTwo];
  const t = setup(names, { env: { CLAUDE_CODE_SESSION_ID: SID.costTwo } });
  try {
    const res = await run(opts(), t.ctx);
    const reasons = Object.fromEntries(res.inventory.sessions_skipped.map((s) => [s.sid, s.reason]));
    assert.equal(reasons[SID.costTwo], 'self');
    assert.equal(reasons[SID.headless], 'headless');
    assert.equal(reasons[SID.noHuman], 'no_human');
    assert.equal(reasons[SID.reviewTyped], 'review_run');
    assert.equal(reasons[SID.reviewSkill], 'review_run');
    assert.deepEqual(res.digests.map((d) => d.sid), [SID.normal]);
    assert.equal(res.inventory.sessions_sampled, 1);
  } finally { t.cleanup(); }
});

test('14b --include-headless keeps a headless session; --session skips the filters', async () => {
  const t = setup([SID.headless, SID.reviewTyped]);
  try {
    const inc = await run(opts({ includeHeadless: true }), t.ctx);
    assert.ok(byId(inc, SID.headless));
    const one = await run(opts({ session: SID.reviewTyped.slice(0, 8) }), t.ctx);
    assert.equal(one.inventory.sessions_sampled, 1);
    assert.equal(one.digests[0].sid, SID.reviewTyped);
  } finally { t.cleanup(); }
});

test('14c --max-sessions is a hard cap and overflow is reported', async () => {
  const t = setup([SID.normal, SID.costTwo, SID.active, SID.dstBefore]);
  try {
    const res = await run(opts({ maxSessions: 2 }), t.ctx);
    assert.equal(res.digests.length, 2);
    assert.equal(res.inventory.overflow_count, 2);
    assert.deepEqual(res.digests.map((d) => d.sid), [SID.active, SID.costTwo], 'the most recent sessions by end time are kept');
  } finally { t.cleanup(); }
});

// ---- 15. evidence: a check before the last edit is stale
test('15 a passing check before the last edit is stale; one after it is fresh', async () => {
  const t = setup([SID.stale, SID.fresh]);
  try {
    const res = await run(opts(), t.ctx);
    const s = byId(res, SID.stale).evidence, f = byId(res, SID.fresh).evidence;
    assert.equal(s.checks.at(-1).before_claim, true);
    assert.equal(s.checks.at(-1).after_last_edit, false);
    assert.equal(s.checks.at(-1).is_error, false);
    assert.equal(s.proof, 'stale');
    assert.equal(f.checks.at(-1).after_last_edit, true);
    assert.equal(f.proof, 'proven');
    assert.match(f.claim_text, /Done\. Fixed/);
  } finally { t.cleanup(); }
});

// ---- excerpt.mjs
test('16 excerpt prints at most 40 redacted lines of 200 characters and refuses a bad session id', () => {
  const t = setup([SID.hook]);
  try {
    const env = { ...process.env, USERPROFILE: t.home, HOME: t.home };
    const ok = spawnSync(process.execPath, [EXCERPT, '--session', SID.hook.slice(0, 8), '--uuid', '00000000-0000-4000-8000-000000000032', '--context', '2'], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const lines = ok.stdout.split('\n').filter(Boolean);
    assert.ok(lines.length > 0 && lines.length <= 40, `${lines.length} lines`);
    assert.ok(lines.every((l) => l.length <= 200));
    assert.ok(!ok.stdout.includes(FAKE_TOKEN));
    const bad = spawnSync(process.execPath, [EXCERPT, '--session', '..\\..\\x', '--uuid', 'u', '--context', '2'], { env, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    const big = spawnSync(process.execPath, [EXCERPT, '--session', SID.hook.slice(0, 8), '--uuid', '00000000-0000-4000-8000-000000000032', '--context', '11'], { env, encoding: 'utf8' });
    assert.notEqual(big.status, 0, 'context above 10 is refused');
  } finally { t.cleanup(); }
});

// ---- 17. factory signals from meta and workflow files
test('17 subagent meta files and workflow records are read into factory', async () => {
  const t = setup([SID.normal]);
  try {
    const sess = path.join(t.dir, SID.normal);
    fs.mkdirSync(path.join(sess, 'subagents', 'workflows', 'wf_1'), { recursive: true });
    fs.mkdirSync(path.join(sess, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(sess, 'subagents', 'workflows', 'wf_1', 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'kraken', isBuiltIn: false, spawnDepth: 1, pickedEffortModel: 'claude-opus-5-5', finished: true }));
    fs.writeFileSync(path.join(sess, 'workflows', 'wf_1.json'), JSON.stringify({ runId: 'wf_1', workflowName: 'demo', status: 'completed', agentCount: 5, totalTokens: 1234, durationMs: 99 }));
    const f = byId(await run(opts(), t.ctx), SID.normal).factory;
    assert.deepEqual(f.agents, [{ agentType: 'kraken', model: null, effort: null, launchedWithDefaults: null, pickedEffortModel: 'claude-opus-5-5', finished: true, spawnDepth: 1 }]);
    assert.deepEqual(f.workflows, [{ workflowName: 'demo', status: 'completed', agentCount: 5, totalTokens: 1234, durationMs: 99 }]);
  } finally { t.cleanup(); }
});

// ---- 17b. model and effort per subagent
test('17b agent model comes from meta, else from the first assistant record, else null; effort and defaults come from meta', async () => {
  const t = setup([SID.normal]);
  try {
    const sub = path.join(t.dir, SID.normal, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const put = (name, meta, jsonl) => {
      fs.writeFileSync(path.join(sub, `${name}.meta.json`), JSON.stringify({ agentType: name, ...meta }));
      if (jsonl !== undefined) fs.writeFileSync(path.join(sub, `${name}.jsonl`), jsonl);
    };
    const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } });
    const asst = (model) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [] } });
    // A: meta wins, even when the transcript names another model.
    put('agent-a', { model: 'claude-opus-5-5', effort: 'high', launchedWithDefaults: false }, `${user}\n${asst('claude-sonnet-5-5')}\n`);
    // B: no meta model; first assistant line after a user line gives it.
    put('agent-b', { effort: 'medium', launchedWithDefaults: true }, `${user}\n${asst('claude-sonnet-5-5')}\n${asst('claude-opus-5-5')}\n`);
    // C: neither meta model nor transcript.
    put('agent-c', {});
    // D: assistant line past the 1 MiB read cap: stays null, no crash.
    put('agent-d', {}, `${user}\n${'x'.repeat(1200000)}\n${asst('claude-opus-5-5')}\n`);
    // E: a long first record (real subagent prompts exceed 64 KB) does not hide the assistant line.
    put('agent-e', {}, `${user}\n${JSON.stringify({ type: 'user', message: { content: 'y'.repeat(200000) } })}\n${asst('claude-opus-5-5')}\n`);
    const f = byId(await run(opts(), t.ctx), SID.normal).factory;
    const by = Object.fromEntries(f.agents.map((a) => [a.agentType, a]));
    assert.equal(by['agent-a'].model, 'claude-opus-5-5');
    assert.equal(by['agent-a'].effort, 'high');
    assert.equal(by['agent-a'].launchedWithDefaults, false);
    assert.equal(by['agent-b'].model, 'claude-sonnet-5-5');
    assert.equal(by['agent-b'].effort, 'medium');
    assert.equal(by['agent-b'].launchedWithDefaults, true);
    assert.equal(by['agent-c'].model, null);
    assert.equal(by['agent-c'].effort, null);
    assert.equal(by['agent-d'].model, null);
    assert.equal(by['agent-e'].model, 'claude-opus-5-5');
  } finally { t.cleanup(); }
});

test('17c agents_total counts every meta file while agents[] stops at the cap', async () => {
  const t = setup([SID.normal]);
  try {
    const sub = path.join(t.dir, SID.normal, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 105; i++) fs.writeFileSync(path.join(sub, `agent-${i}.meta.json`), JSON.stringify({ agentType: 'k', model: 'm' }));
    const f = byId(await run(opts(), t.ctx), SID.normal).factory;
    assert.equal(f.agents.length, 100);
    assert.equal(f.agents_total, 105);
  } finally { t.cleanup(); }
});

// ---- 18. trend ledger
test('18 append-scores writes under the repo root and flags a regression after a model change', () => {
  const t = setup([SID.normal]);
  try {
    const env = { ...process.env, USERPROFILE: t.home, HOME: t.home };
    const send = (rows) => {
      const f = path.join(t.home, 'scores.json');
      fs.writeFileSync(f, JSON.stringify(rows));
      const r = spawnSync(process.execPath, [EXTRACT, '--append-scores', f], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const first = send([{ sid: 's1', chain_id: 's1', scores: { goal: 0.8, tests: null }, session_models: ['claude-sonnet-5-5'], judge_model: 'sonnet' }]);
    assert.equal(first.previous_run, null);
    assert.ok(first.ledger.startsWith(path.join(t.home, 'continuous-claude')));
    assert.equal(first.current_means.tests, undefined, 'N/A stays out of the mean');
    const second = send([{ sid: 's2', scores: { goal: 0.4 }, session_models: ['claude-opus-5-5'] }]);
    assert.equal(second.previous_run.means.goal, 0.8);
    assert.equal(second.regressions.length, 1);
    assert.equal(second.regressions[0].scorer, 'goal');
    assert.ok(second.regressions[0].changed.includes('session_models'));
    const lines = fs.readFileSync(first.ledger, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const bad = path.join(t.home, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify([{ sid: 'x', scores: { goal: 7 } }]));
    assert.notEqual(spawnSync(process.execPath, [EXTRACT, '--append-scores', bad], { env, encoding: 'utf8' }).status, 0);
  } finally { t.cleanup(); }
});

// ---- 19. efficiency signals
test('19 rework after a failed check and repeated failing commands are surfaced', async () => {
  const t = setup([SID.rework]);
  try {
    const tools = byId(await run(opts(), t.ctx), SID.rework).tools;
    assert.deepEqual(tools.edits_by_file, [{ file: 'src/a.ts', n: 3 }]);
    assert.deepEqual(tools.rework_files, [{ file: 'src/a.ts', edits_after_failed_check: 3 }]);
    assert.deepEqual(tools.repeated_failures, [{ cmd: 'lsof -i :3000', n: 3 }]);
  } finally { t.cleanup(); }
});

// ---- 20. subagent streaming
test('20 --include-subagents streams subagent files into the token split and joins guards by agent_id', async () => {
  const guard = [{ ts: '2026-11-03T08:00:01.000Z', hook: 'sub-guard', tool: 'Bash', decision: 'deny', session_id: SID.normal, agent: true, agent_id: 'abc123' }];
  const t = setup([SID.normal], { guard });
  try {
    const subDir = path.join(t.dir, SID.normal, 'subagents');
    fs.mkdirSync(path.join(subDir, 'workflows', 'wf_1'), { recursive: true });
    const rec = (o) => JSON.stringify({ isSidechain: true, sessionId: SID.normal, ...o }) + '\n';
    const asst = (uuid, id, i, o, content) => rec({ type: 'assistant', uuid, timestamp: '2026-11-03T08:00:00.000Z', message: { model: 'claude-sonnet-5-5', id, role: 'assistant', content, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    const blockText = 'PreToolUse:Bash hook error: BLOCKED (fail-closed): recursive rm\n\nCommand: rm -rf x';
    fs.writeFileSync(path.join(subDir, 'agent-abc123.jsonl'),
      asst('00000000-0000-4000-8000-0000000a0001', 'msg_s1', 5, 5, [{ type: 'tool_use', id: 'toolu_S1', name: 'Bash', input: { command: 'rm -rf x' } }])
      + rec({ type: 'user', uuid: '00000000-0000-4000-8000-0000000a0002', timestamp: '2026-11-03T08:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_S1', content: blockText, is_error: true }] }, permissionDecision: { decision: 'reject', source: 'hook' } }));
    fs.writeFileSync(path.join(subDir, 'workflows', 'wf_1', 'agent-w1.jsonl'), asst('00000000-0000-4000-8000-0000000b0001', 'msg_w1', 7, 3, [{ type: 'text', text: 'x' }]));
    const d = byId(await run(opts({ includeSubagents: true }), t.ctx), SID.normal);
    assert.equal(d.cost.split.subagent, 10);
    assert.equal(d.cost.split.workflow, 10);
    assert.equal(d.hooks.blocks.length, 1);
    assert.equal(d.hooks.blocks[0].agent_id, 'abc123');
    assert.equal(d.hooks.blocks[0].guard, 'sub-guard');
    assert.equal(d.tools.denials.hook, 1);
    const plain = byId(await run(opts(), t.ctx), SID.normal);
    assert.equal(plain.cost.split.subagent, null, 'subagent files are not read by default');
    assert.equal(plain.hooks.blocks.length, 0);
  } finally { t.cleanup(); }
});

test('21 a check is a command that runs a checker, not text that names one', () => {
  const no = [
    `gh api repos/o/r/issues/1/comments -f body='the test passed'`,
    `git commit -m 'test the hook'`,
    `node scripts/coordination/lane.mjs note x "tests pass; lint clean"`,
    `echo test`,
    `node -e "console.log(/x/.test(e.url))"`,
    `Add-Content MEMORY.md 'ran vitest'`,
  ];
  for (const c of no) assert.equal(isCheckCommand(c), false, c);
  const yes = [
    'npm test', 'npm run lint', 'npx vitest run', 'cd x && node --test a.mjs',
    'node "C:/Users/dkhay/.claude/scripts/verify.mjs"', 'node scripts/coordination/lane-probe.mjs',
    'node scripts/skills/audit-skills.mjs --skill x', 'tsc --noEmit', 'python -m pytest -q',
    `git status; npm run test`, 'node x.mjs > .claude/cache/e2e/out.txt',
  ];
  for (const c of yes) assert.equal(isCheckCommand(c), true, c);
});

test('11e redaction keeps "tests pass: 29" and still removes PASSWORD and API_KEY values', () => {
  assert.equal(redact('tests pass: 29'), 'tests pass: 29');
  assert.match(redact('PASSWORD=hunter2'), /REDACTED/);
  assert.match(redact('MY_API_KEY: abc123'), /REDACTED/);
  assert.match(redact(['ghu', 'A'.repeat(20)].join('_')), /REDACTED/);
});

test('11f redaction removes a whole credential value: one that contains the word, and one with a comma or semicolon', () => {
  const keep = ['abc', 'REDACTED', 'def'].join('');
  assert.ok(!redact(`API_KEY=${keep}`).includes(keep));
  assert.ok(!redact('API_KEY=abc,def').includes('def'));
  assert.ok(!redact('API_KEY=abc;def').includes('def'));
  assert.equal(redact('API_KEY=[REDACTED]'), 'API_KEY=[REDACTED]');
});

test('16b excerpt honours --project-prefix: a matching prefix finds the session, another prefix does not', () => {
  const t = setup([SID.hook]);
  try {
    const env = { ...process.env, USERPROFILE: t.home, HOME: t.home };
    const args = ['--session', SID.hook.slice(0, 8), '--uuid', '00000000-0000-4000-8000-000000000032', '--context', '1'];
    const same = spawnSync(process.execPath, [EXCERPT, ...args, '--project-prefix', PREFIX], { env, encoding: 'utf8' });
    assert.equal(same.status, 0, same.stderr);
    const other = spawnSync(process.execPath, [EXCERPT, ...args, '--project-prefix', 'C--Users-nobody-elsewhere'], { env, encoding: 'utf8' });
    assert.notEqual(other.status, 0, 'a prefix that matches no folder finds nothing');
  } finally { t.cleanup(); }
});
