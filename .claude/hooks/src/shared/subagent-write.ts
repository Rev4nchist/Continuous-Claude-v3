/**
 * Card coord-subagent-write-guard (gap 8, rule S1.5): a read-only subagent must not write into the places that
 * hold state or policy. Design note: .claudedocs/coordination/2026-11-16-coord-subagent-write-guard-design.md.
 * Seat ruling 2026-11-16 13:45: warn everywhere outside the scratch folder, deny in the protected places.
 *
 * WHO is a subagent: the payload carries `agent_id` (the main thread carries none; live probe 2026-11-03).
 * WHICH subagent is read-only: `agent_type` is in READ_ONLY_AGENT_TYPES, the agents whose file lists no Write and no
 * Edit tool. A test reads `.claude/agents/*.md` and fails when this list and the files differ (a hand list drifts).
 * A subagent with an `agent_id` and no `agent_type` (a workflow agent): denied in the four protected places under
 * `~/.claude`, never warned, never denied at the repo root (it may be a builder).
 * Any other `agent_type` (kraken, spark, ...): not judged.
 *
 * WHAT is protected: `~/.claude/state`, `~/.claude/settings*`, `~/.claude/rules`, `~/.claude/rules-ondemand`, and a file
 * directly in the root of a checkout (read-only class only).
 *
 * KNOWN LIMIT, said in the PR body and the card's done line: a script that a subagent runs writes where it likes. This
 * guard reads the tool input and the shell text. It does not see what a script writes inside. The three faults of
 * 2026-11-11 (re-program.md:986, :1008) were such writes.
 *
 * Pure: every outside fact (home, temp folder, checkout tops, real path, once-per-path memory) is passed in.
 */
import { basename, dirname } from 'path';
import { classifyShellText, type HeldClaim } from './write-targets.js';

/** Agents with no Write and no Edit tool in `.claude/agents/<name>.md` (guard test: subagent-write-agents.test.ts). */
export const READ_ONLY_AGENT_TYPES: readonly string[] = [
  'architect',
  'cma-operator',
  'critic',
  'deployer',
  'grok-adversary',
  'grok-worker',
  'judge',
  'liaison',
  'oracle',
  'pathfinder',
  'phoenix',
  'plan-reviewer',
  'principal-reviewer',
  'profiler',
  'react-perf-reviewer',
  'scout',
  'security-refuter',
  'sleuth',
  'surveyor',
  'ui-compliance-reviewer',
];

export type ProtectedKind = 'state' | 'settings' | 'rules' | 'rules-ondemand' | 'repo-root';

export interface SubagentDeps {
  /** The user's home, any slash form. */
  home: string;
  /** The OS temp folder, any slash form. */
  tmp: string;
  /** Top folders of the checkouts (primary and worktrees), any slash form. */
  tops: readonly string[];
  /** The session id of the payload. */
  sessionId: string;
  cwd: string;
  /** True when the file system folds case (Windows, macOS). */
  fold: boolean;
  /** The canonical real path of a path a tool names, forward slashes; '' on error. */
  realPath: (p: string, cwd: string) => string;
  /** True the first time this path is seen in this session (and records it). */
  firstWarn: (path: string) => boolean;
  /** The scratch folder to show in a message, when the caller can find it. */
  scratchFolder?: string;
}

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'warn'; text: string }
  | { kind: 'deny'; reason: string };

const ALLOW: Verdict = { kind: 'allow' };

const fwd = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '');

type Class = 'readonly' | 'untyped' | 'other' | 'main';

export function classOf(input: { agent_id?: unknown; agent_type?: unknown }): Class {
  if (typeof input.agent_id !== 'string' || !input.agent_id) return 'main';
  if (typeof input.agent_type !== 'string' || !input.agent_type) return 'untyped';
  return READ_ONLY_AGENT_TYPES.includes(input.agent_type) ? 'readonly' : 'other';
}

/** The protected place a real path is in, or null. `repoRoot` is judged only when the caller asks for it. */
export function protectedKind(real: string, deps: Pick<SubagentDeps, 'home' | 'tops' | 'fold'>, repoRoot: boolean): ProtectedKind | null {
  const norm = (s: string): string => (deps.fold ? fwd(s).toLowerCase() : fwd(s));
  const p = norm(real);
  const home = norm(deps.home);
  if (p === `${home}/.claude/state` || p.startsWith(`${home}/.claude/state/`)) return 'state';
  if (p.startsWith(`${home}/.claude/rules-ondemand/`) || p === `${home}/.claude/rules-ondemand`) return 'rules-ondemand';
  if (p.startsWith(`${home}/.claude/rules/`) || p === `${home}/.claude/rules`) return 'rules';
  if (dirname(p) === `${home}/.claude` && basename(p).startsWith('settings')) return 'settings';
  if (repoRoot) {
    const dir = dirname(p);
    if (deps.tops.some((t) => norm(t) === dir)) return 'repo-root';
  }
  return null;
}

/** True for a path inside this session's scratchpad `<tmp>/claude/<hash>/<session>/scratchpad` or the OS temp folder. */
export function insideScratch(real: string, deps: Pick<SubagentDeps, 'tmp' | 'sessionId' | 'fold'>): boolean {
  const norm = (s: string): string => (deps.fold ? fwd(s).toLowerCase() : fwd(s));
  const p = norm(real);
  const tmp = norm(deps.tmp);
  if (!tmp || !(p === tmp || p.startsWith(`${tmp}/`))) return false;
  if (!deps.sessionId) return false;
  const rest = p.slice(tmp.length + 1);
  const sid = norm(deps.sessionId);
  return new RegExp(`^claude/[^/]+/${sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scratchpad(/|$)`).test(rest);
}

const printable = (s: string): string => s.replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029]/g, '?');

function scratchText(deps: SubagentDeps): string {
  return deps.scratchFolder ? printable(deps.scratchFolder) : `${fwd(deps.tmp)}/claude/<hash>/${deps.sessionId}/scratchpad`;
}

const KIND_TEXT: Record<ProtectedKind, string> = {
  state: 'the state folder',
  settings: 'a settings file',
  rules: 'the rules folder',
  'rules-ondemand': 'the on-demand rules folder',
  'repo-root': 'the root of a checkout',
};

function denyFor(path: string, kind: ProtectedKind, deps: SubagentDeps): Verdict {
  return {
    kind: 'deny',
    reason: `SUBAGENT WRITE BLOCKED: "${printable(path)}" is in ${KIND_TEXT[kind]}. A subagent does not write there. Write the file in your scratch folder instead: ${scratchText(deps)}. This check reads the call and cannot see what a script writes inside.`,
  };
}

function warnFor(path: string, deps: SubagentDeps): Verdict {
  return {
    kind: 'warn',
    text: `[WARN] subagent write: "${printable(path)}" is outside your scratch folder ${scratchText(deps)}. It is not stopped. This warning shows once per path.`,
  };
}

/** One path a tool names. `repoRoot`: true for the read-only class. */
function judgePath(raw: string, cls: Class, deps: SubagentDeps): Verdict {
  const real = deps.realPath(raw, deps.cwd) || fwd(raw);
  if (insideScratch(real, deps)) return ALLOW;
  const kind = protectedKind(real, deps, cls === 'readonly');
  if (kind) return denyFor(real, kind, deps);
  if (cls === 'readonly' && deps.firstWarn(real)) return warnFor(real, deps);
  return ALLOW;
}

/** Group A: the paths a tool names. The first deny wins; else the first warn. */
export function judgeDirect(input: { agent_id?: unknown; agent_type?: unknown }, paths: readonly string[], deps: SubagentDeps): Verdict {
  const cls = classOf(input);
  if (cls === 'main' || cls === 'other') return ALLOW;
  let warn: Verdict = ALLOW;
  for (const p of paths) {
    const v = judgePath(p, cls, deps);
    if (v.kind === 'deny') return v;
    if (v.kind === 'warn' && warn.kind === 'allow') warn = v;
  }
  return warn;
}

const SIZE_CAP = 64 * 1024;

/** Home spellings a shell text can use, forward slashes. */
function homeForms(home: string): string[] {
  const h = fwd(home);
  const drive = /^([a-z]):\/(.*)$/i.exec(h);
  const forms = [h, '~', '$HOME', '$env:USERPROFILE', '%USERPROFILE%', '${HOME}'];
  if (drive) forms.push(`/${drive[1].toLowerCase()}/${drive[2]}`);
  return forms;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A shell home spelling at the start of a token (`~`, `$HOME`, `/c/Users/x`) becomes the real home. */
function expandHome(token: string, home: string): string {
  const h = fwd(home);
  for (const form of homeForms(home)) {
    if (form !== h && token.toLowerCase().startsWith(`${form.toLowerCase()}/`)) return `${h}${token.slice(form.length)}`;
  }
  return token;
}
const PATH_CHARS = "[^\\s'\"|;&<>)]*";

/** Candidate path tokens in shell text that sit in a protected place. */
function protectedTokens(text: string, deps: SubagentDeps, repoRoot: boolean): string[] {
  const t = text.replace(/\\/g, '/');
  const out = new Set<string>();
  const homeAlt = homeForms(deps.home).map(esc).join('|');
  const re = new RegExp(`(?<![\\w./-])(?:${homeAlt})/\\.claude/(?:state|rules-ondemand|rules|settings[\\w.-]*)${PATH_CHARS}`, deps.fold ? 'gi' : 'g');
  for (const m of t.matchAll(re)) out.add(m[0]);
  if (repoRoot) {
    for (const top of deps.tops) {
      const re2 = new RegExp(`(?<![\\w./-])${esc(fwd(top))}/[^\\s'"|;&<>)/]+(?![\\w./-])`, deps.fold ? 'gi' : 'g');
      for (const m of t.matchAll(re2)) out.add(m[0]);
    }
  }
  return [...out];
}

/** The target of each `>` or `>>` redirect that is a plain path. */
function redirectTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![-=\d&>])>>?\s*['"]?([^\s'"|;&<>)]+)/g)) {
    const p = m[1];
    if (/^(\/dev\/|\$null$|nul$|&)/i.test(p)) continue;
    out.push(p);
  }
  return out;
}

/** Group B: shell text. Protected paths with a write cue deny; a plain redirect outside scratch warns (read-only class). */
export function judgeShell(
  input: { agent_id?: unknown; agent_type?: unknown },
  text: string,
  pwsh: boolean,
  deps: SubagentDeps,
): Verdict {
  const cls = classOf(input);
  if (cls === 'main' || cls === 'other' || !text || text.length > SIZE_CAP) return ALLOW;
  const tokens = protectedTokens(text, deps, cls === 'readonly');
  if (tokens.length > 0) {
    const claims: HeldClaim[] = tokens.map((tok) => ({ filePath: tok, forms: [tok], ciForms: [] }));
    const verdict = classifyShellText(text, claims, deps.fold, pwsh);
    if (verdict.kind === 'deny') {
      const expanded = expandHome(verdict.filePath, deps.home);
      const kind = protectedKind(deps.realPath(expanded, deps.cwd) || expanded, deps, cls === 'readonly');
      return denyFor(verdict.filePath, kind ?? 'state', deps);
    }
  }
  if (cls === 'readonly') {
    for (const target of redirectTargets(text)) {
      const real = deps.realPath(target, deps.cwd) || fwd(target);
      if (insideScratch(real, deps)) continue;
      if (deps.firstWarn(real)) return warnFor(real, deps);
    }
  }
  return ALLOW;
}
