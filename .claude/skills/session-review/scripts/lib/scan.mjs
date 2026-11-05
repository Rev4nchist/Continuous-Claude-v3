// Streaming scan of ONE transcript file into a compact "facts" object. No raw transcript text
// leaves this module: every kept string is redacted, then truncated. Reads with readline only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isHuman, textOf } from './human.mjs';
import { messageKey, mergeMax } from './usage.mjs';
import { redact, redactTruncate, oneLine } from './redact.mjs';

// Record types that carry no review signal. Skipped by prefix, before JSON.parse.
const SKIP_PREFIX = /^\{"type":"(?:file-history-|api-request|bridge-session|session-owner|atis-latch|frame-link|artifact-)/;
const REVIEW_RE = /^\s*(?:<command-message>session-review<\/command-message>\s*)?(?:<command-name>)?\/session-review\b|^Base directory for this skill:.*session-review/;
const CLAIM_RE = /\b(done|fixed|complete[d]?|passes|passing|merged|landed|ready)\b/i;
// A check is a command that RUNS a checker. Text that only names one (a commit message, a PR comment,
// a lane note, a regex .test() call) is not a check. Quoted spans keep their text but lose their
// separators, so a ';' inside a quote cannot start a new command.
const CHECK_START = /^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|tsc|typecheck|e2e)\b|npx\s+(?:--\S+\s+)*(?:vitest|jest|pytest|tsc|eslint|pyright)\b|(?:vitest|jest|pytest|tsc|eslint|pyright)\b|python3?\s+-m\s+pytest\b|node\s+--test\b|node\s+["']?[^\s"']*(?:verify\.mjs|-probe\.mjs|audit-skills\.mjs|context-budget-guard\.mjs)\b)/i;
const E2E_WRITE = /(?:>>?|Out-File|Set-Content|Tee-Object|--out(?:put)?)\s*(?:-\w+\s+)*["']?[^\s"']*\.claude[\/]+cache[\/]+e2e/i;
export function isCheckCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  const masked = cmd.replace(/'[^']*'|"[^"]*"/g, (q) => q.replace(/[;&|\r\n]/g, '_'));
  if (E2E_WRITE.test(masked)) return true;
  return masked.split(/;|&&|\|\||\||\r?\n/).some((seg) => CHECK_START.test(seg.trim()));
}
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const IDLE_MS = 30 * 60000;

export const newFacts = (file, role = 'main') => ({
  file, role, sid: path.basename(file, '.jsonl'), agentId: role === 'main' ? null : path.basename(file, '.jsonl').replace(/^agent-/, ''),
  parseErrors: 0, dupUuids: 0, firstTs: null, lastTs: null, prevTs: null, idleGaps: 0,
  entrypoint: null, cwds: new Set(), branches: new Set(), modes: new Set(), prs: new Set(), titles: [], aways: [],
  humanTurns: 0, prompts: [], firstTyped: null, reviewRun: false, lastAsstText: null,
  calls: {}, errors: { exit_code: 0, hook_block: 0, schema: 0, precondition: 0, other: 0 }, denials: { hook: 0, config: 0, user: 0, interrupted: 0 },
  blocks: [], openBlocks: [], pending: new Map(), hookMs: {}, hookRuns: {}, hookNonBlocking: [], hookNonBlockingCount: 0,
  active: 0, turns: 0, compactions: [], usage: new Map(), anon: 0, models: new Set(), cost: null,
  seq: 0, checks: [], editSeqs: [], editFiles: new Map(), rework: new Map(), failMap: new Map(), lastCheckFailed: false, claim: null, finalText: null, taskNotes: { completed: 0, failed: 0 }, attr: {},
});

const cmdOf = (input) => {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.description ?? input.path ?? '';
  return typeof v === 'string' ? v : '';
};
const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
};
const scriptName = (command, fallback) => {
  const all = [...String(command || '').matchAll(/([\w.-]+)\.(?:mjs|cjs|js|ts|sh|py)\b/g)];
  return all.length ? all[all.length - 1][1] : fallback;
};

function classifyError(text) {
  if (/Exit code \d+/.test(text)) return 'exit_code';
  if (/InputValidationError|Invalid tool parameters|did not match the (?:expected )?schema/i.test(text)) return 'schema';
  if (/has not been read yet|modified since (?:it was )?read|File does not exist|String to replace not found|Found \d+ matches|must (?:first )?read/i.test(text)) return 'precondition';
  return 'other';
}

function trackMeta(S, o) {
  if (o.cwd) S.cwds.add(o.cwd);
  if (o.gitBranch) S.branches.add(o.gitBranch);
  if (o.permissionMode) S.modes.add(o.permissionMode);
  if (!S.entrypoint && o.entrypoint) S.entrypoint = o.entrypoint;
}

function trackTime(S, o) {
  if (!o.timestamp) return;
  const t = Date.parse(o.timestamp);
  if (Number.isNaN(t)) return;
  if (S.firstTs === null) S.firstTs = t;
  if (S.prevTs !== null && t - S.prevTs > IDLE_MS) S.idleGaps++;
  S.prevTs = t;
  S.lastTs = S.lastTs === null ? t : Math.max(S.lastTs, t);
}

function onHuman(S, o) {
  S.humanTurns++;
  const raw = textOf(o);
  const prev = S.lastAsstText ? redactTruncate(S.lastAsstText, 1e9).slice(-300) : '';
  const p = { uuid: o.uuid, text: redactTruncate(raw, 400), prev_assistant: prev, promptSource: o.promptSource || null };
  S.prompts.push(p);
  if (S.prompts.length > 40) S.prompts.shift();
  if (!S.firstTyped && o.promptSource === 'typed') S.firstTyped = p.text;
  if (!S.firstTyped && !o.promptSource && S.humanTurns === 1) S.firstTyped = p.text;
}

function onNotification(S, o) {
  const t = typeof o.message.content === 'string' ? o.message.content : resultText(o.message.content);
  const m = /<status>\s*([a-z_-]+)\s*<\/status>/i.exec(t);
  if (!m) return;
  if (m[1].toLowerCase() === 'completed') S.taskNotes.completed++;
  else if (/fail|error|kill|stop/i.test(m[1])) S.taskNotes.failed++;
}

function noteReviewRun(S, o) {
  const c = o.message.content;
  const t = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text : '');
  if (typeof t === 'string' && REVIEW_RE.test(t.slice(0, 300))) S.reviewRun = true;
}

function onToolResult(S, o, b) {
  const info = S.pending.get(b.tool_use_id);
  S.pending.delete(b.tool_use_id);
  const isErr = b.is_error === true;
  if (info && info.check) { info.check.is_error = isErr; S.lastCheckFailed = isErr; }
  if (!isErr) return;
  if (info && info.cmd && SHELL_TOOLS.has(info.name)) {
    const key = oneLine(redact(info.cmd)).slice(0, 80); // redact first, then cut
    S.failMap.set(key, (S.failMap.get(key) || 0) + 1);
  }
  const text = resultText(b.content);
  const pd = o.permissionDecision;
  const prefix = typeof b.content === 'string' ? /^PreToolUse:([A-Za-z0-9_.-]+) hook error/.exec(b.content) : null;
  if (prefix && pd && pd.decision === 'reject' && pd.source === 'hook') {
    S.errors.hook_block++;
    pushBlock(S, o, prefix[1], text, info);
    return;
  }
  S.errors[classifyError(text)]++;
}

function pushBlock(S, o, tool, text, info) {
  const cmdLine = /^Command:\s*(.*)$/m.exec(text);
  const fam = /BLOCKED[^:\n]*:\s*([^\n]+)/.exec(text);
  const block = {
    uuid: o.uuid, ts: o.timestamp || null, tool, guard: 'unknown', family: fam ? redactTruncate(fam[1], 160) : '', decision: o.permissionDecision.decision,
    cmd: redactTruncate(cmdLine ? cmdLine[1] : (info ? info.cmd : ''), 120), next_calls: [], agent_id: S.agentId,
  };
  S.blocks.push(block);
  S.openBlocks.push(block);
}

function onDenial(S, o) {
  const pd = o.permissionDecision;
  if (o.toolDenialKind === 'interrupted') S.denials.interrupted++;
  else if (pd && pd.decision === 'reject') {
    if (pd.source === 'hook') S.denials.hook++;
    else if (pd.source === 'user') S.denials.user++;
    else S.denials.config++;
  }
}

function onUser(S, o) {
  const c = o.message && o.message.content;
  if (!o.message) return;
  if (o.origin && o.origin.kind === 'task-notification') onNotification(S, o);
  noteReviewRun(S, o);
  if (isHuman(o)) onHuman(S, o);
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
    onDenial(S, o);
    for (const b of c) if (b && b.type === 'tool_result') onToolResult(S, o, b);
  }
}

function onToolUse(S, o, b) {
  S.calls[b.name] = (S.calls[b.name] || 0) + 1;
  const cmd = cmdOf(b.input);
  const seq = S.seq++;
  for (const blk of S.openBlocks) if (blk.next_calls.length < 3) blk.next_calls.push({ name: b.name, cmd: redactTruncate(cmd, 120) });
  S.openBlocks = S.openBlocks.filter((blk) => blk.next_calls.length < 3);
  const info = { name: b.name, cmd, check: null };
  if (EDIT_TOOLS.has(b.name)) {
    S.editSeqs.push(seq);
    const f = cmdOf(b.input).split(/[\\/]/).slice(-2).join('/');
    S.editFiles.set(f, (S.editFiles.get(f) || 0) + 1);
    if (S.lastCheckFailed) S.rework.set(f, (S.rework.get(f) || 0) + 1);
  }
  if (SHELL_TOOLS.has(b.name) && isCheckCommand(cmd)) {
    info.check = { uuid: o.uuid, cmd: redactTruncate(cmd, 120), seq, is_error: null };
    S.checks.push(info.check);
    if (S.checks.length > 10) S.checks.shift();
  }
  if (b.id) S.pending.set(b.id, info);
}

function onAssistantText(S, o, t) {
  S.lastAsstText = t;
  if (o.isSidechain) return;
  const seq = S.seq++;
  S.finalText = { seq, text: t, uuid: o.uuid };
  if (CLAIM_RE.test(t)) S.claim = { seq, text: t, uuid: o.uuid };
}

function onAssistant(S, o) {
  const m = o.message;
  if (!m) return;
  if (o.attributionSkill) S.attr[o.attributionSkill] = (S.attr[o.attributionSkill] || 0) + 1;
  if (m.model && m.model !== '<synthetic>') S.models.add(m.model);
  if (m.usage && m.model !== '<synthetic>') {
    const u = m.usage;
    const cur = { input: u.input_tokens || 0, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_create: u.cache_creation_input_tokens || 0 };
    const { key } = messageKey(o, S.anon++);
    const prev = S.usage.get(key);
    if (prev) mergeMax(prev, cur); else S.usage.set(key, cur);
  }
  if (!Array.isArray(m.content)) return;
  for (const b of m.content) {
    if (!b) continue;
    if (b.type === 'tool_use') onToolUse(S, o, b);
    else if (b.type === 'text' && b.text) onAssistantText(S, o, b.text);
  }
}

function onAttachment(S, o) {
  const a = o.attachment;
  if (!a) return;
  if (a.type === 'hook_success') {
    const name = scriptName(a.command, a.hookName || 'unknown');
    S.hookMs[name] = (S.hookMs[name] || 0) + (a.durationMs || 0);
    S.hookRuns[name] = (S.hookRuns[name] || 0) + 1;
  } else if (a.type === 'hook_non_blocking_error') {
    S.hookNonBlockingCount++;
    if (S.hookNonBlocking.length < 10) S.hookNonBlocking.push({ hook: a.hookName || 'unknown', text: redactTruncate(oneLine(String(a.stderr || a.content || '')), 160) });
  }
}

function onSystem(S, o) {
  if (o.subtype === 'turn_duration') { S.active += o.durationMs || 0; S.turns++; }
  else if (o.subtype === 'away_summary' && typeof o.content === 'string') S.aways.push(o.content);
  else if (o.subtype === 'compact_boundary' && o.compactMetadata) {
    const c = o.compactMetadata;
    S.compactions.push({ trigger: c.trigger || null, preTokens: c.preTokens ?? null, postTokens: c.postTokens ?? null });
  }
}

function ingest(S, o, shared) {
  if (o.uuid && shared) {
    const owner = shared.owner.get(o.uuid);
    if (owner === undefined) shared.owner.set(o.uuid, S.file);
    else if (owner !== S.file) { S.dupUuids++; shared.link(owner, S.file); return; }
  }
  switch (o.type) {
    case 'cost-state': S.cost = o; return;
    case 'custom-title': if (o.customTitle) S.titles.push(o.customTitle); return;
    case 'permission-mode': if (o.permissionMode || o.mode) S.modes.add(o.permissionMode || o.mode); return;
    case 'pr-link': if (o.prNumber != null) S.prs.add(o.prNumber); return;
    default:
  }
  trackMeta(S, o);
  trackTime(S, o);
  if (o.type === 'user') onUser(S, o);
  else if (o.type === 'assistant') onAssistant(S, o);
  else if (o.type === 'attachment') onAttachment(S, o);
  else if (o.type === 'system') onSystem(S, o);
}

/** Stream one file into a facts object. `shared` = {owner: Map, link(a,b)} for resume-chain dedup. */
export async function scanFile(file, { shared = null, role = 'main' } = {}) {
  const S = newFacts(file, role);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    if (SKIP_PREFIX.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { S.parseErrors++; continue; }
    if (!o || typeof o !== 'object') { S.parseErrors++; continue; }
    ingest(S, o, shared);
  }
  return S;
}

/** Evidence group: which checks ran before the claim and after the last edit. */
export function evidenceOf(S) {
  const point = S.claim || S.finalText;
  const checks = S.checks.map((c) => ({
    uuid: c.uuid, cmd: c.cmd, is_error: c.is_error,
    before_claim: point ? c.seq < point.seq : false,
    after_last_edit: point ? !S.editSeqs.some((e) => e > c.seq && e < point.seq) : false,
  }));
  const passing = checks.filter((c) => c.is_error === false && c.before_claim);
  const hasClaim = Boolean(S.claim);
  let proof = 'none';
  if (!hasClaim && S.editSeqs.length === 0) proof = 'na';
  else if (passing.some((c) => c.after_last_edit)) proof = 'proven';
  else if (passing.length) proof = 'stale';
  else if (checks.length) proof = 'failing';
  return { checks, claim_text: point ? redactTruncate(point.text, 600) : null, claim_uuid: point ? point.uuid : null, has_claim: hasClaim, code_edits: S.editSeqs.length, proof };
}

export const sumUsage = (S) => {
  const t = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
  for (const u of S.usage.values()) for (const k of Object.keys(t)) t[k] += u[k];
  return t;
};

const top = (map, n, min) => [...map.entries()].filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).slice(0, n);

/** Efficiency signals: where edits piled up, which edits followed a failed check, which commands failed repeatedly. */
export function effortOf(S) {
  return {
    edits_by_file: top(S.editFiles, 5, 1).map(([file, n]) => ({ file: redactTruncate(file, 80), n })),
    rework_files: top(S.rework, 5, 3).map(([file, n]) => ({ file: redactTruncate(file, 80), edits_after_failed_check: n })),
    repeated_failures: top(S.failMap, 5, 2).map(([cmd, n]) => ({ cmd: redactTruncate(cmd, 80), n })),
  };
}
