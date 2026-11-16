/**
 * Card coord-subagent-write-guard (gap 8, rule S1.5): a read-only subagent must not write into the places that
 * hold state or policy. Design note: .claudedocs/coordination/2026-11-16-coord-subagent-write-guard-design.md.
 * Seat ruling 2026-11-16 13:45: warn everywhere outside the scratch folder, deny in the protected places.
 *
 * WHO is a subagent: the payload carries `agent_id` (the main thread carries none; live probe 2026-11-03).
 * WHICH subagent is read-only: `agent_type` is in READ_ONLY_AGENT_TYPES, the agents whose file lists no Write and no
 * Edit tool. A test (subagent-write.test.ts, test 11) reads `.claude/agents/*.md` and fails when this list and the
 * files differ (a hand list drifts).
 * A subagent with an `agent_id` and no `agent_type` (a workflow agent): denied in the four protected places under
 * `~/.claude`, never warned, never denied at the repo root (it may be a builder).
 * Any other `agent_type` (kraken, spark, ...): not judged.
 *
 * WHAT is protected: `~/.claude/state`, `~/.claude/settings*`, `~/.claude/rules`, `~/.claude/rules-ondemand`, and a file
 * directly in the root of a checkout (read-only class only).
 *
 * KNOWN LIMITS, said in the PR body and the card's done line:
 *  - A script that a subagent runs writes where it likes. This guard reads the tool input and the shell text. It does
 *    not see what a script writes inside. The faults of 2026-11-11 (re-program.md:986, :1008) were such writes.
 *  - Shell text is read without a lexer (memory guard-shell-lexer-arms-race). A path built at run time, `cd <dir> &&
 *    echo x > file`, `tee file` with a bare name, and a quoted heredoc body are not seen.
 *
 * A shell WRITE is: a redirect (`>` or `>>`) whose target is protected, or a write verb (tee, Set-Content, mv, cp, rm,
 * sed -i ...) with the protected path as one of its first two operands. A protected path that is only read is no write.
 *
 * Pure: every outside fact (home, temp folder, checkout tops, real path, once-per-path memory) is passed in.
 */
import { basename, dirname } from 'path';

/** Agents with no Write and no Edit tool in `.claude/agents/<name>.md` (guard test: subagent-write.test.ts, test 11). */
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
  /** The user's home as the file system names it (real path), any slash form. */
  home: string;
  /** The OS temp folder as the file system names it (real path), any slash form. */
  tmp: string;
  /** Top folders of the checkouts: the primary and every linked worktree, real case, any slash form. */
  tops: readonly string[];
  /** The session id of the payload. */
  sessionId: string;
  cwd: string;
  /** True when the file system folds case (Windows, macOS). */
  fold: boolean;
  /** The canonical real path of a path a tool names, forward slashes; '' on error. */
  realPath: (p: string, cwd: string) => string;
  /** True when a warn for this path was already shown in this session. */
  warned: (path: string) => boolean;
  /** The scratch folder to show in a message, when the caller can find it. */
  scratchFolder?: string;
}

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'warn'; text: string; path: string }
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

/** True for a path inside this session's scratchpad `<tmp>/claude/<hash>/<session>/scratchpad`. Nothing else in temp. */
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
  return deps.scratchFolder
    ? printable(deps.scratchFolder)
    : `${printable(fwd(deps.tmp))}/claude/<hash>/${printable(deps.sessionId)}/scratchpad`;
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
    path,
    text: `[WARN] subagent write: "${printable(path)}" is outside your scratch folder ${scratchText(deps)}. It is not stopped. This warning shows once per path.`,
  };
}

/** One real path a call writes. `repoRoot`: true for the read-only class. */
function judgeRealPath(real: string, cls: Class, deps: SubagentDeps): Verdict {
  if (insideScratch(real, deps)) return ALLOW;
  const kind = protectedKind(real, deps, cls === 'readonly');
  if (kind) return denyFor(real, kind, deps);
  if (cls === 'readonly' && !deps.warned(real)) return warnFor(real, deps);
  return ALLOW;
}

/** Group A: the paths a tool names. The first deny wins; else the first warn. */
export function judgeDirect(input: { agent_id?: unknown; agent_type?: unknown }, paths: readonly string[], deps: SubagentDeps): Verdict {
  const cls = classOf(input);
  if (cls === 'main' || cls === 'other') return ALLOW;
  let warn: Verdict = ALLOW;
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const v = judgeRealPath(deps.realPath(p, deps.cwd) || fwd(p), cls, deps);
    if (v.kind === 'deny') return v;
    if (v.kind === 'warn' && warn.kind === 'allow') warn = v;
  }
  return warn;
}

const SIZE_CAP = 64 * 1024;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Home spellings a shell text can use, forward slashes. */
function homeForms(home: string): string[] {
  const h = fwd(home);
  const forms = [h, '~', '$HOME', '${HOME}', '$env:USERPROFILE', '%USERPROFILE%'];
  const drive = /^([a-z]):\/(.*)$/i.exec(h);
  if (drive) forms.push(`/${drive[1].toLowerCase()}/${drive[2]}`);
  return forms;
}

/** A shell home spelling at the start of a token (`~`, `$HOME`, `/c/Users/x`) becomes the real home. */
function expandHome(token: string, home: string): string {
  const h = fwd(home);
  for (const form of homeForms(home)) {
    if (form !== h && token.toLowerCase().startsWith(`${form.toLowerCase()}/`)) return `${h}${token.slice(form.length)}`;
  }
  return token;
}

/** Git Bash `/c/x` is `C:/x` where drive letters exist (the file system folds case there). */
function unmsys(p: string, fold: boolean): string {
  const m = fold ? /^\/([a-z])\/(.*)$/i.exec(p) : null;
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

/** A top folder spelled the ways a shell text can spell it: `C:/x/y` and `/c/x/y`. */
function topForms(top: string): string[] {
  const t = fwd(top);
  const drive = /^([a-z]):\/(.*)$/i.exec(t);
  return drive ? [t, `/${drive[1].toLowerCase()}/${drive[2]}`] : [t];
}

const PATH_CHARS = "[^\\s'\"|;&<>)]*";
const TOKEN_START = '(?<![\\w./-])';

/** Candidate protected path tokens in shell text, as spelled. */
function protectedTokens(text: string, deps: SubagentDeps, repoRoot: boolean): string[] {
  const t = text.replace(/\\/g, '/');
  const flags = deps.fold ? 'gi' : 'g';
  const out = new Set<string>();
  const homeAlt = homeForms(deps.home).map(esc).join('|');
  // After the folder name: a "/" and more path, or the end of the token. "statefile.txt" is no state path.
  const re = new RegExp(`${TOKEN_START}(?:${homeAlt})/\\.claude/(?:state|rules-ondemand|rules)(?:/${PATH_CHARS})?(?![\\w.-])`, flags);
  for (const m of t.matchAll(re)) out.add(m[0]);
  const re1 = new RegExp(`${TOKEN_START}(?:${homeAlt})/\\.claude/settings[\\w.-]*(?![\\w./-])`, flags);
  for (const m of t.matchAll(re1)) out.add(m[0]);
  if (repoRoot) {
    for (const top of deps.tops) {
      for (const form of topForms(top)) {
        const re2 = new RegExp(`${TOKEN_START}${esc(form)}/[^\\s'"|;&<>)/]+(?![\\w./-])`, flags);
        for (const m of t.matchAll(re2)) out.add(m[0]);
      }
    }
  }
  return [...out];
}

/**
 * A redirect operator: `>`, `>>`, `>|`, and the same behind a descriptor, an ampersand or a star (`2>`, `1>>`, `&>`,
 * `&>>`, `*>`, `*>>`): the prefix is any character except `-`, `=`, `<` and `>`, so only the `>` is matched. Not `->`
 * or `=>`, and not a duplicate of a descriptor (`2>&1`, `>&2`: a `&` straight after the `>`; the target pattern also
 * refuses a target that starts with `&`). One source for the token test and the target scan, so the two cannot drift.
 */
const REDIRECT_OP = '(?<![-=<>])>{1,2}\\|?(?!&)';

/**
 * Verbs that write an operand. COPY_VERBS only read their first operand, so the protected path must be the second.
 * Every other verb may name the protected path as its first or second operand (`mv a b` writes both).
 */
const COPY_VERBS = '(?:cp|copy|copy-item)';
const WRITE_VERBS =
  '(?:tee|tee-object|set-content|add-content|clear-content|out-file|mv|move|move-item|rm|del|erase|ri|remove-item|sed\\s+(?:-\\S+\\s+)*-i\\S*|git\\s+checkout|git\\s+restore|git\\s+apply)';

/** True when the token is the target of a redirect, or the written operand of a write verb. */
function writesToken(text: string, token: string, fold: boolean): boolean {
  const t = text.replace(/\\/g, '/');
  const tk = esc(token.replace(/\\/g, '/'));
  const flags = fold ? 'i' : '';
  if (new RegExp(`${REDIRECT_OP}\\s*['"]?${tk}(?![\\w./-])`, flags).test(t)) return true;
  const start = '(?<![\\w./-])';
  const end = '(?![\\w./-])';
  const op = '(?:\\s+-\\S+)*\\s+';
  const other = "['\"]?[^\\s'\"|;&<>]+['\"]?\\s+";
  const target = `['"]?${tk}${end}`;
  const patterns = [
    `${start}${WRITE_VERBS}${end}${op}${target}`,
    `${start}${WRITE_VERBS}${end}${op}${other}${target}`,
    `${start}${COPY_VERBS}${end}${op}${other}${target}`,
  ];
  return patterns.some((p) => new RegExp(p, flags).test(t));
}

/** The target of each `>` or `>>` redirect that is a plain path outside quotes. */
function redirectTargets(text: string): string[] {
  // A quoted segment is data (`node -e "1 > 0"`), unless a redirect points straight at it.
  const bare = text.replace(/(?<!>\s*)(["'])(?:(?!\1)[^\\])*\1/g, ' ');
  const out: string[] = [];
  for (const m of bare.matchAll(new RegExp(`${REDIRECT_OP}\\s*['"]?([^\\s'"|;&<>)]+)`, 'g'))) {
    const p = m[1];
    if (/^(\/dev\/|\$null$|nul$|&)/i.test(p)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Group B: shell text. A write to a protected place denies. A redirect to any other path outside the scratch folder
 * warns (read-only class only).
 */
export function judgeShell(
  input: { agent_id?: unknown; agent_type?: unknown },
  text: string,
  deps: SubagentDeps,
): Verdict {
  const cls = classOf(input);
  if (cls === 'main' || cls === 'other' || typeof text !== 'string' || !text || text.length > SIZE_CAP) return ALLOW;
  const repoRoot = cls === 'readonly';
  // 1. A named protected path that a redirect or a write verb targets.
  for (const token of protectedTokens(text, deps, repoRoot)) {
    if (!writesToken(text, token, deps.fold)) continue;
    const expanded = unmsys(expandHome(token, deps.home), deps.fold);
    const real = deps.realPath(expanded, deps.cwd) || expanded;
    const kind = protectedKind(real, deps, repoRoot);
    if (kind) return denyFor(token, kind, deps);
  }
  // 2. Every redirect target, by its real path (a relative name resolves against the cwd; `..` is folded).
  let warn: Verdict = ALLOW;
  for (const target of redirectTargets(text)) {
    const expanded = unmsys(expandHome(target, deps.home), deps.fold);
    const real = deps.realPath(expanded, deps.cwd) || fwd(expanded);
    if (insideScratch(real, deps)) continue;
    const kind = protectedKind(real, deps, repoRoot);
    if (kind) return denyFor(target, kind, deps);
    if (cls === 'readonly' && warn.kind === 'allow' && !deps.warned(real)) warn = warnFor(real, deps);
  }
  return warn;
}
