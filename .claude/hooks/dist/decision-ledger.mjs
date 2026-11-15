#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lib/trace-boot.ts
import fs from "fs";
import { homedir } from "os";
import { basename, join, resolve, sep } from "path";
import { syncBuiltinESMExports } from "module";

// src/shared/guard-log.ts
var SECRET_NAME = "[\\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie)[\\w.-]*";
var MASKS = [
  // A URL inside quotes may hold a password with a space: the closing quote ends it, not the space.
  [/(["'])([a-z][\w+.-]*:\/\/)[^\s/@:"']+:(?:(?!\1)[^/@])+@/gi, "$1$2***@"],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1***@"],
  // `curl -u user:pass`, `curl --user user:pass`. A numeric user (`docker run -u 1000:1000`) is a uid:gid.
  // Quoting decides where the credential ends: `-u "user:two words"`, `-u user:"two words"`.
  [/(\s(?:-u[\s=]*|--user[\s=]+)")(?!\d+:)([^":]+):[^"]*"/g, '$1$2:***"'],
  [/(\s(?:-u[\s=]*|--user[\s=]+)')(?!\d+:)([^':]+):[^']*'/g, "$1$2:***'"],
  [/(\s(?:-u[\s=]*|--user[\s=]+))(?!\d+:)([^\s:"']+):(?:"[^"]*"|'[^']*'|[^\s"'])+/g, "$1$2:***"],
  // `mysql -uroot -pS3cret`: the password is glued to -p. Case matters: -P is the port.
  [/(\b(?:mysql|mariadb)\w*\b[^|;&\n]*?\s-p)(?:"[^"]*"|'[^']*'|[^\s"'])+/g, "$1***"],
  // `sshpass -p pw ssh host`
  [/(\bsshpass\s+-p\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/g, "$1***"],
  [/\b(Bearer|Basic|Token)\s+[^\s'"]+/gi, "$1 ***"],
  [new RegExp(`(${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s'"]+)`, "gi"), "$1$2***"],
  [new RegExp(`(--?${SECRET_NAME})(\\s+)("[^"]*"|'[^']*'|[^\\s'"-][^\\s'"]*)`, "gi"), "$1$2***"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "***"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***"],
  [/\bgithub_pat_\w+/g, "***"],
  [/\bxox[abprs]-[\w-]+/g, "***"],
  [/\bnpm_[A-Za-z0-9]{20,}/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
  [/\bAIza[\w-]{30,}/g, "***"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***"],
  // Any other long opaque run that mixes letters and digits (hex, base64url keys).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g, "***"]
];
function guardSource(env) {
  const named = env.CCV3_GUARD_SOURCE;
  if (named === "test" || named === "probe") return named;
  if (Object.hasOwn(env, "VITEST")) return "test";
  return env.CCV3_GUARD_DECISIONS_LOG ? "probe" : "live";
}
var MARK_OPEN = String.fromCharCode(57344);
var MARK_CLOSE = String.fromCharCode(57345);
var UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
var PATH_MASKS = [
  ...MASKS.slice(0, -1),
  [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, "***"]
];

// src/lib/trace-boot.ts
var TRACE_MARKER = "__CCV3_HOOK_TRACE_V1__";
var HOT_PROGRAMS = [
  "architecture-stats-sync",
  "commit-preflight",
  "decision-gate",
  "destructive-command-guard",
  "git-commit-roadmap",
  "file-claims",
  "holdout-scan",
  "hook-health-monitor",
  "identity-probe",
  "lane-agent-tag",
  "lane-board-republish-reminder",
  "lane-context",
  "mcp-activity-tracker",
  "msys-crash-capture",
  "package-install-guard",
  "periodic-extract",
  "pr-opened-review-loop",
  "pre-pr-gate",
  "roadmap-completion",
  "roadmap-reconcile",
  "rule-router",
  "scan-scope-guard",
  "session-register",
  "session-start-context-loaders",
  "session-start-continuity",
  "session-start-docker",
  "session-start-init-check",
  "session-start-intel-prune",
  "session-start-memory-loaders",
  "smarter-everyday",
  "test-run-tracker"
];
var DAY_CAP_BYTES = 32 * 1024 * 1024;
var PRUNE_DAYS = 10;
var STDIN_KEEP = 64 * 1024;
var STDOUT_KEEP = 8 * 1024;
var ERROR_MAX = 120;
function traceModeFrom(env, modeText) {
  if (env.CCV3_HOOK_TRACE === "0") return "off";
  const t = (modeText ?? "").trim().toLowerCase();
  return t === "off" || t === "all" ? t : "hot";
}
function readTraceMode(env, read = (p) => fs.readFileSync(p, "utf8")) {
  let text = null;
  try {
    text = read(env.CCV3_HOOK_TRACE_MODE_FILE || join(homedir(), ".claude", "state", "hook-trace-mode"));
  } catch {
  }
  return traceModeFrom(env, text);
}
function shouldTrace(name, mode) {
  return mode === "all" || mode === "hot" && HOT_PROGRAMS.includes(name);
}
var realPath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return resolve(p);
  }
};
var caseKey = (p) => process.platform === "win32" ? p.toLowerCase() : p;
function underLiveDist(script, home) {
  if (!script) return false;
  try {
    return caseKey(realPath(script)).startsWith(caseKey(realPath(join(home, ".claude", "hooks", "dist"))) + sep);
  } catch {
    return false;
  }
}
function traceSource(env, script = process.argv[1], home = homedir()) {
  const g = guardSource(env);
  if (g !== "live") return g;
  if (env.CCV3_HOOK_TRACE_DIR) return "probe";
  return underLiveDist(script, home) ? "live" : "probe";
}
var traceDir = (env) => env.CCV3_HOOK_TRACE_DIR || join(homedir(), ".claude", "cache");
var SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
var EVENT_NAME = /^[A-Za-z]{1,40}$/;
var TOOL_NAME = /^[\w.:-]{1,100}$/;
var pick = (v, re) => typeof v === "string" && re.test(v) ? v : null;
function extractPayloadFields(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      return { sessionId: pick(o.session_id, SESSION_ID), event: pick(o.hook_event_name, EVENT_NAME), tool: pick(o.tool_name, TOOL_NAME) };
    }
  } catch {
  }
  const key = (k, re) => pick(new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]{1,100})"`).exec(text)?.[1], re);
  return { sessionId: key("session_id", SESSION_ID), event: key("hook_event_name", EVENT_NAME), tool: key("tool_name", TOOL_NAME) };
}
function classifyObject(o) {
  const hso = o.hookSpecificOutput ?? {};
  const pd = hso.permissionDecision ?? o.permissionDecision;
  if (pd === "deny" || pd === "ask" || pd === "allow") return pd;
  if (o.decision === "block" || o.result === "block") return "block";
  if (typeof hso.additionalContext === "string") return "inject";
  if (typeof o.systemMessage === "string") return "message";
  return "none";
}
function classifyOut(text) {
  const t = text.trim();
  if (!t) return "none";
  try {
    const o = JSON.parse(t);
    return o && typeof o === "object" && !Array.isArray(o) ? classifyObject(o) : "none";
  } catch {
  }
  const pd = /"permissionDecision"\s*:\s*"(deny|ask|allow)"/.exec(t)?.[1];
  if (pd) return pd;
  if (/"decision"\s*:\s*"block"/.test(t)) return "block";
  if (/"additionalContext"\s*:/.test(t)) return "inject";
  if (/"systemMessage"\s*:/.test(t)) return "message";
  return "none";
}
var ERROR_WORD = /^[A-Za-z0-9_.]{1,40}$/;
var ERROR_CODE = /^[A-Za-z0-9_]{1,40}$/;
function maskError(err) {
  if (!(err instanceof Error)) return typeof err;
  try {
    const rawName = err.name;
    const name = typeof rawName === "string" && ERROR_WORD.test(rawName) ? rawName : "Error";
    const code = err.code;
    return (typeof code === "string" && ERROR_CODE.test(code) ? `${name}/${code}` : name).slice(0, ERROR_MAX);
  } catch {
    return "Error";
  }
}
var round1 = (n) => Math.round(n * 10) / 10;
function buildRow(i) {
  return {
    ts: i.ts.toISOString(),
    name: i.name,
    event: i.event,
    tool: i.tool,
    startupMs: round1(i.startupMs),
    durationMs: round1(i.durationMs),
    exitCode: i.code === 0 ? 0 : 1,
    code: i.code,
    sessionId: i.sessionId,
    out: i.out,
    error: i.error,
    source: i.source
  };
}
var DAY_FILE = /^hook-trace-(\d{4}-\d{2}-\d{2})\.(?:jsonl|dropped)$/;
function pruneOld(dir, day, days) {
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = DAY_FILE.exec(f);
    if (m && m[1] < cutoff) {
      try {
        fs.unlinkSync(join(dir, f));
      } catch {
      }
    }
  }
}
function bumpDropped(file) {
  let n = 0;
  try {
    n = Number(JSON.parse(fs.readFileSync(file, "utf8")).dropped) || 0;
  } catch {
  }
  fs.writeFileSync(file, `${JSON.stringify({ dropped: n + 1, ts: (/* @__PURE__ */ new Date()).toISOString() })}
`);
}
function appendTraceRow(row, opts = {}) {
  try {
    const dir = opts.dir ?? traceDir(process.env);
    const day = row.ts.slice(0, 10);
    const file = join(dir, `hook-trace-${day}.jsonl`);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(dir, { recursive: true });
      try {
        pruneOld(dir, day, opts.pruneDays ?? PRUNE_DAYS);
      } catch {
      }
    }
    if (size >= (opts.capBytes ?? DAY_CAP_BYTES)) {
      bumpDropped(join(dir, `hook-trace-${day}.dropped`));
      return "dropped";
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}
`);
    return "written";
  } catch {
    return "error";
  }
}
var keep = (cur, chunk, max) => {
  if (cur.length >= max) return cur;
  const s = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
  return cur + s.slice(0, max - cur.length);
};
function lazyTap(name, onStream) {
  const d = Object.getOwnPropertyDescriptor(process, name);
  if (!d || !d.get || !d.configurable) return;
  const orig = d.get;
  let seen;
  Object.defineProperty(process, name, {
    configurable: true,
    enumerable: d.enumerable,
    get() {
      const s = orig.call(this);
      if (s && s !== seen) {
        seen = s;
        try {
          onStream(s);
        } catch {
        }
      }
      return s;
    }
  });
}
function bootTrace(env = process.env, _bootCall) {
  try {
    if (!process.argv[1]) return;
    const name = basename(process.argv[1], ".mjs");
    if (!shouldTrace(name, readTraceMode(env))) return;
    const startupMs = process.uptime() * 1e3;
    const t0 = performance.now();
    const state = { v: 1, stdinTouched: false, stdoutTouched: false };
    globalThis[TRACE_MARKER] = state;
    let stdinText = "";
    let stdoutText = "";
    let errText = null;
    const rawRead = fs.readFileSync;
    fs.readFileSync = function(...args) {
      const r = rawRead.apply(this, args);
      try {
        if (args[0] === 0 || args[0] === "/dev/stdin") stdinText = keep(stdinText, r, STDIN_KEEP);
      } catch {
      }
      return r;
    };
    try {
      Object.defineProperty(fs.readFileSync, "name", { value: "readFileSync", configurable: true });
      Object.defineProperty(fs.readFileSync, "length", { value: 2, configurable: true });
    } catch {
    }
    syncBuiltinESMExports();
    lazyTap("stdin", (s) => {
      state.stdinTouched = true;
      const emit = s.emit;
      s.emit = function(ev, chunk) {
        if (ev === "data") {
          try {
            stdinText = keep(stdinText, chunk, STDIN_KEEP);
          } catch {
          }
        }
        return emit.apply(this, arguments);
      };
    });
    lazyTap("stdout", (s) => {
      state.stdoutTouched = true;
      const write = s.write;
      s.write = function(chunk) {
        try {
          stdoutText = keep(stdoutText, chunk, STDOUT_KEEP);
        } catch {
        }
        return write.apply(this, arguments);
      };
    });
    process.on("uncaughtExceptionMonitor", (err) => {
      try {
        errText = maskError(err);
      } catch {
      }
    });
    process.on("exit", (code) => {
      try {
        const f = extractPayloadFields(stdinText);
        const row = buildRow({
          ts: /* @__PURE__ */ new Date(),
          name,
          event: f.event,
          tool: f.tool,
          startupMs,
          durationMs: performance.now() - t0,
          code: typeof code === "number" ? code : 0,
          sessionId: f.sessionId,
          out: classifyOut(stdoutText),
          error: errText,
          source: traceSource(env, process.argv[1])
        });
        appendTraceRow(row, { dir: traceDir(env) });
      } catch {
      }
    });
  } catch {
  }
}
if (!Object.hasOwn(process.env, "VITEST")) bootTrace(process.env, "__CCV3_HOOK_TRACE_BOOT_V1__");

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
var STEPS = Object.freeze(["ship", "open-pr", "review", "land", "paid-round", "cli-skip"]);
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
  "paid-round": "Nothing paid runs.",
  "cli-skip": "The CLI review skip stays refused."
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
