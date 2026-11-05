// Software Factory signals: subagent meta files, workflow records, optional subagent streaming.
import fs from 'node:fs';
import path from 'node:path';
import { scanFile, sumUsage } from './scan.mjs';
import { walkFiles } from './files.mjs';

const AGENT_CAP = 100;
const HEAD_BYTES = 64 * 1024;
const MODEL_SCAN_CAP = 1 << 20; // sampled subagent transcripts put the first assistant record up to 780 KB in

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

const modelOfLine = (line) => {
  if (!line.includes('"assistant"')) return null;
  try {
    const o = JSON.parse(line);
    return o.type === 'assistant' && typeof o.message?.model === 'string' ? o.message.model : null;
  } catch { return null; }
};

/**
 * Model of the first assistant record in a subagent transcript.
 * Reads 64 KB chunks and stops at the first hit or at MODEL_SCAN_CAP. It never reads the whole file.
 */
export function resolvedModel(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(HEAD_BYTES);
    let carry = Buffer.alloc(0), pos = 0;
    while (pos < MODEL_SCAN_CAP) {
      const n = fs.readSync(fd, chunk, 0, HEAD_BYTES, pos);
      if (n === 0) break;
      pos += n;
      carry = Buffer.concat([carry, chunk.subarray(0, n)]);
      let nl;
      while ((nl = carry.indexOf(10)) >= 0) {
        const m = modelOfLine(carry.toString('utf8', 0, nl));
        if (m) return m;
        carry = carry.subarray(nl + 1);
      }
    }
    if (pos < MODEL_SCAN_CAP) return modelOfLine(carry.toString('utf8')); // last line, no newline
  } catch { /* no transcript */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

/** agents[] from <sid>/subagents/**\/*.meta.json and workflows[] from <sid>/workflows/wf_*.json. */
export function factoryOf(sessDir, _logs, _sid) {
  const metas = walkFiles(path.join(sessDir, 'subagents'), (n) => n.endsWith('.meta.json'));
  const agents = [];
  for (const f of metas.slice(0, AGENT_CAP)) {
    const j = readJson(f);
    if (!j) continue;
    const model = j.model ?? resolvedModel(f.replace(/\.meta\.json$/, '.jsonl'));
    agents.push({ agentType: j.agentType ?? null, model, effort: j.effort ?? null, launchedWithDefaults: j.launchedWithDefaults ?? null, pickedEffortModel: j.pickedEffortModel ?? null, finished: j.finished ?? null, spawnDepth: j.spawnDepth ?? null });
  }
  const wfFiles = walkFiles(path.join(sessDir, 'workflows'), (n) => /^wf_.*\.json$/.test(n), 200);
  const workflows = [];
  let tokens = 0;
  for (const f of wfFiles) {
    const j = readJson(f);
    if (!j) continue;
    workflows.push({ workflowName: j.workflowName ?? null, status: j.status ?? null, agentCount: j.agentCount ?? null, totalTokens: j.totalTokens ?? null, durationMs: j.durationMs ?? null });
    tokens += typeof j.totalTokens === 'number' ? j.totalTokens : 0;
  }
  return { agents, agentsTotal: metas.length, workflows, workflowTokensReported: workflows.length ? tokens : null };
}

/** Stream <sid>/subagents/**\/*.jsonl (off by default; about 1.3 GB in the sampled history). */
export async function subagentFacts(subDir) {
  const files = walkFiles(subDir, (n) => n.endsWith('.jsonl'));
  const facts = [];
  let subagentTokens = 0, workflowTokens = 0;
  for (const f of files) {
    const S = await scanFile(f, { role: 'subagent' });
    const u = sumUsage(S);
    const total = u.input + u.output + u.cache_read + u.cache_create;
    if (/[\\/]workflows[\\/]/.test(f)) workflowTokens += total; else subagentTokens += total;
    facts.push(S);
  }
  return { facts, subagentTokens, workflowTokens };
}
