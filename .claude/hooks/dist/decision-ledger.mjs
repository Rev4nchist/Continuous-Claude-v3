#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/decision-ledger.ts
import { readFileSync as readFileSync3 } from "fs";

// ../../scripts/github/lib/decisions.mjs
import { mkdirSync, readFileSync as readFileSync2, renameSync, unlinkSync as unlinkSync2, writeFileSync } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import os from "node:os";
import path from "node:path";

// ../../scripts/github/lib/file-lock.mjs
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
var MUTEX_STALE_MS = 2e3;
var sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
var readLock = (lock) => {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return null;
  }
};
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function staleContent(lock, lockStaleMs) {
  const st = statSync(lock);
  if (Date.now() - st.mtimeMs <= lockStaleMs) return null;
  if (!st.isFile()) return null;
  const content = readLock(lock);
  if (content === null) return null;
  const pid = Number.parseInt(content.split(" ")[0], 10);
  return pidAlive(pid) ? null : content;
}
function createExclusive(path2, token) {
  const fd = openSync(path2, "wx");
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
}
function clearDeadMutex(mutex) {
  const dead = staleContent(mutex, MUTEX_STALE_MS);
  if (dead !== null && readLock(mutex) === dead) unlinkSync(mutex);
}
function takeOver(lock, lockStaleMs) {
  const mutex = `${lock}.takeover`;
  const token = `${process.pid} ${randomUUID()}`;
  try {
    createExclusive(mutex, token);
  } catch (err) {
    if (err.code === "EEXIST") clearDeadMutex(mutex);
    return false;
  }
  try {
    if (staleContent(lock, lockStaleMs) === null) return false;
    unlinkSync(lock);
    return true;
  } finally {
    try {
      if (readLock(mutex) === token) unlinkSync(mutex);
    } catch {
    }
  }
}
function withLock(file, { lockWaitMs = 5e3, lockStaleMs = 3e4 } = {}, fn) {
  const lock = `${file}.lock`;
  const token = `${process.pid} ${randomUUID()}`;
  const began = Date.now();
  for (; ; ) {
    try {
      createExclusive(lock, token);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let taken = false;
      try {
        taken = staleContent(lock, lockStaleMs) !== null && takeOver(lock, lockStaleMs);
      } catch {
      }
      if (taken) continue;
      if (Date.now() - began >= lockWaitMs) return { ok: false, reason: "lock", detail: `the lock ${lock} is held by another session` };
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readLock(lock) === token) unlinkSync(lock);
    } catch {
    }
  }
}

// ../../scripts/github/lib/decisions.mjs
var DECISIONS_ENV = "CCV3_DECISIONS_FILE";
var STEPS = Object.freeze(["ship", "open-pr", "review", "land", "paid-round"]);
var MAX_REASKS = 2;
var MAX_AGE_MS = 7 * 24 * 3600 * 1e3;
var MISS_TTL_MS = 60 * 60 * 1e3;
var liveMisses = (m) => m && Date.now() - Date.parse(m.at) <= MISS_TTL_MS ? m.count : 0;
var decisionsPath = (env = process.env) => env[DECISIONS_ENV] || path.join(os.homedir(), ".claude", "state", "ccv3-mods", "decisions.json");
var empty = () => ({ version: 1, offers: {}, decisions: {}, misses: {} });
var idOf = ({ step, key, head }) => `${step}
${key}
${String(head).toLowerCase()}`;
var isText = (v) => typeof v === "string" && v !== "";
var isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function readStore(file) {
  try {
    const s = JSON.parse(readFileSync2(file, "utf8"));
    if (!isPlain(s)) return empty();
    const store = { ...empty(), ...s };
    return [store.offers, store.decisions, store.misses].every(isPlain) ? store : empty();
  } catch {
    return empty();
  }
}
function writeStore(file, store) {
  const tmp = `${file}.${process.pid}.${randomUUID2()}.tmp`;
  const text = `${JSON.stringify(store, null, 2)}
`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync2(tmp);
    } catch {
    }
    writeFileSync(file, text);
  }
}
function prune(store, now) {
  for (const group of [store.offers, store.decisions, store.misses]) {
    for (const [id, row] of Object.entries(group)) {
      if (!(now - Date.parse(row?.at) <= MAX_AGE_MS)) delete group[id];
    }
  }
}
function update(fn) {
  const file = decisionsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const locked = withLock(file, {}, () => {
    const store = readStore(file);
    prune(store, Date.now());
    const out = fn(store);
    writeStore(file, store);
    return out;
  });
  return locked;
}
function decisionRecord({ step, key, head, label }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return { ok: false, reason: "no-open-offer" };
  return update((store) => {
    const id = idOf({ step, key, head });
    const offer = store.offers[id];
    if (!offer || offer.open !== true) return { ok: false, reason: "no-open-offer" };
    if (typeof label !== "string" || !offer.labels.includes(label)) return { ok: false, reason: "no-match" };
    store.decisions[id] = { label, at: (/* @__PURE__ */ new Date()).toISOString(), tree: offer.tree, nonce: offer.nonce };
    offer.open = false;
    delete store.misses[id];
    return { ok: true };
  });
}
function missCount({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return 0;
  return liveMisses(readStore(decisionsPath()).misses[idOf({ step, key, head })]);
}
function missBump({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return MAX_REASKS + 1;
  const r = update((store) => {
    const id = idOf({ step, key, head });
    const count = liveMisses(store.misses[id]) + 1;
    store.misses[id] = { count, at: (/* @__PURE__ */ new Date()).toISOString() };
    return { ok: true, count };
  });
  return r.ok === true ? r.count : MAX_REASKS + 1;
}
function offerList() {
  return Object.values(readStore(decisionsPath()).offers).filter((o) => o?.open === true);
}

// src/shared/decisions-store.ts
var MAX_REASKS2 = MAX_REASKS;
var offerList2 = offerList;
var decisionRecord2 = decisionRecord;
var missCount2 = missCount;
var missBump2 = missBump;

// src/decision-ledger.ts
var TOOL = "AskUserQuestion";
var isText2 = (v) => typeof v === "string";
var labelsOf = (q) => Array.isArray(q.options) ? q.options.map((o) => o?.label).filter(isText2) : [];
var sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function parseAnswers(resp, questions) {
  if (isText2(resp)) {
    try {
      return parseAnswers(JSON.parse(resp), questions);
    } catch {
      return answersFromText(resp, questions);
    }
  }
  const answers = resp?.answers;
  if (!answers || typeof answers !== "object") return {};
  return Object.fromEntries(Object.entries(answers).filter((e) => isText2(e[1])));
}
function answersFromText(text, questions) {
  const out = {};
  for (const q of questions) {
    if (!isText2(q.question)) continue;
    const at = text.indexOf(`"${q.question}"="`);
    if (at < 0) continue;
    const rest = text.slice(at + q.question.length + 4);
    const label = [...labelsOf(q)].sort((a, b) => b.length - a.length).find((l) => rest.startsWith(`${l}"`));
    out[q.question] = label ?? rest.split(/"\. You can now continue/)[0].replace(/"\.?$/, "");
  }
  return out;
}
var engineOwned = (o) => o.step === "review" || o.step === "paid-round" && o.key.includes("!pick:");
var prOf = (o) => /#(\d+)/.exec(o.key)?.[1] ?? "";
var STOP_TAIL = {
  review: "The PR stays a draft.",
  "paid-round": "Nothing paid runs."
};
function missText(o) {
  const triple = { step: o.step, key: o.key, head: o.head };
  const engine = engineOwned(o);
  const count = engine ? missCount2(triple) : missBump2(triple);
  const stop = engine ? count >= MAX_REASKS2 : count > MAX_REASKS2;
  if (stop) return `Stop. Nothing was recorded: the answer to the "${o.step}" question matched no option after ${MAX_REASKS2} re-asks. ${STOP_TAIL[o.step] ?? "The action does not run."} Tell Dave. Do not ask again.`;
  const n = engine ? count + 1 : count;
  const how = engine ? `Call pr_checkpoint with pr: ${prOf(o)} (it returns the question again)` : "Ask the same question again with AskUserQuestion, word for word";
  return `No match. Nothing was recorded for the "${o.step}" question: the answer was not one of its options (re-ask ${n} of ${MAX_REASKS2}). ${how}.`;
}
function noteFor(q, answers, offers) {
  if (!isText2(q.question) || !isText2(q.header)) return null;
  const sameHeader = offers.filter((o2) => o2.spec?.header === q.header);
  if (sameHeader.length === 0) return null;
  const labels = labelsOf(q);
  const hits = sameHeader.filter((o2) => o2.spec?.question === q.question && sameList(o2.labels, labels));
  if (hits.length !== 1) return `Not recorded: the "${q.header}" question does not match one open offer (${hits.length === 0 ? "its text or options differ" : "two offers match"}). Ask the question exactly as the script printed it.`;
  const o = hits[0];
  const answer = answers[q.question];
  if (!isText2(answer) || !o.labels.includes(answer)) return missText(o);
  const r = decisionRecord2({ step: o.step, key: o.key, head: o.head, label: answer });
  if (r.ok) return `Recorded "${answer}" for the ${o.step} question (${o.key}).`;
  return r.reason === "lock" ? `Not recorded: the decision store was busy. Ask the same question again.` : null;
}
function handle(raw) {
  try {
    const input = JSON.parse(raw.trim() || "{}");
    if ((input.tool_name || input.tool) !== TOOL || input.agent_id || process.env.CLAUDE_AGENT_ID) return "{}";
    const asked = input.tool_input?.questions;
    const questions = Array.isArray(asked) ? asked : [];
    const answers = parseAnswers(input.tool_response, questions);
    const offers = offerList2();
    const notes = questions.map((q) => noteFor(q, answers, offers)).filter(isText2);
    if (notes.length === 0) return "{}";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes.join("\n") } });
  } catch {
    return "{}";
  }
}
if (!process.env.VITEST) {
  try {
    console.log(handle(readFileSync3(0, "utf8")));
  } catch {
    console.log("{}");
  }
}
export {
  handle,
  parseAnswers
};
