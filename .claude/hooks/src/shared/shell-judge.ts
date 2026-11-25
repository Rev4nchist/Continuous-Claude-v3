// shell-judge.ts: fail-closed rules F1-F6 over the call list of shared/shell-ast.ts (design note 02 sections 3, 4 and 13).
// A fully literal guarded call returns allow with rule 'judged': "readable". Real taps and remote checks are out of scope here.
// Port of the RE builder B scratch judge (judge.mjs) with no rule change.
import { parseCalls, progName, lineStartOf, BASH_KINDS_NOTE, BASH_KINDS_EXTRA, PWSH_KINDS, type Call, type ParseOpts, type ParseResult, type Word } from './shell-ast.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface JudgeOpts extends ParseOpts {
  allowedKinds?: string[];
  f6?: 'strict';
  noPrefix?: boolean;
  gitAlias?: (verb: string, cwdBefore: (string | null)[] | undefined) => Promise<string | null | undefined> | string | null | undefined;
}
export interface Verdict {
  verdict: 'allow' | 'deny';
  rule: string;
  reason: string;
  calls?: Call[];
  guarded?: Any[];
  residual?: Any[];
  parseOk?: boolean;
  prefix?: boolean;
  prog?: string;
  f6kind?: string;
}
export type EntryTest = (text: string) => boolean;
type Dialect = 'bash' | 'pwsh' | 'unknown';

export const DEFAULT_KINDS: string[] = [...BASH_KINDS_NOTE, ...BASH_KINDS_EXTRA, ...PWSH_KINDS];
const GUARDED_PROGS = new Set(['git', 'gh', 'cr', 'coderabbit', 'git-safe', 'git-for', 'land-pr']);
// Entry test (note 02 section 13, Q1): program words, guarded verb words, and the dynamic-call signs. A bare dot is left out: it matches every `find .`.
export const PROGRAM_WORDS = /\b(git|gh|cr|coderabbit|git-safe|git-for|land-pr)\b/i;
export const VERB_WORDS = /\b(push|review|pulls)\b|\bpr\s+(create|merge)\b/i;
export const DYNAMIC_SIGNS = /(^|\s)&\s|\b(iex|Invoke-Expression|Invoke-Command|Start-Process|cmd|bash|sh|pwsh|powershell)\b|-EncodedCommand/i;
export const defaultEntry: EntryTest = (t) => PROGRAM_WORDS.test(t) || VERB_WORDS.test(t) || DYNAMIC_SIGNS.test(t);
const PROG_RE = PROGRAM_WORDS;
const VERB_RE = /\b(push|review|pulls|pr\s+(create|merge))\b|(^|\s)-pr\b/i;
// A full guarded call inside one text: a program word, then a verb word (or the land script, then -Pr).
const FULL_CALL = /\b(git|gh|cr|coderabbit|git-safe|git-for|land-pr)\b[\s\S]*?\b(push|review|pulls|pr\s+(create|merge))\b|\bland-pr\b[\s\S]*-pr\b/i;
// Data-only programs (named residual, note 02 section 13): their quoted argument is data, so a guarded call named in it does not run.
export const DATA_ONLY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls', 'echo', 'printf', 'write-output', 'write-host', 'cat', 'get-content', 'type', 'gc', ':']);
export const DATA_ONLY_GIT = new Set(['commit', 'log', 'grep']);
const RUNNER_ALWAYS = new Set(['ssh', 'watch', 'xargs', 'env', 'sudo', 'nohup', 'timeout']);
const FREE_FLAG = /^(-m|--message|-message|-t|--title|-b|--body|--subject)$/i;
const FREE_EQ = /^(--message|--title|--body|--subject)=/i;
const FREE_KEYS = ['title=', 'body=', 'commit_title=', 'commit_message='];
const DECIDING_KEYS = ['head', 'base', 'sha', 'merge_method'];
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'builtin', 'sudo', 'time', 'nice', 'setsid']);
const GIT_BUILTIN = new Set('add am apply archive bisect blame branch bundle cat-file checkout cherry-pick clean clone commit config describe diff difftool fetch format-patch gc grep help init log ls-files ls-remote ls-tree merge mergetool mv notes pull push range-diff rebase reflog remote reset restore rev-list rev-parse revert rm shortlog show sparse-checkout stash status submodule switch tag version worktree'.split(' '));
const GH_VALUE_OPTS = new Set(['--title', '-t', '--body', '-b', '--body-file', '-F', '--head', '-H', '--base', '-B', '--repo', '-R', '--label', '-l', '--assignee', '-a', '--reviewer', '-r', '--milestone', '-m', '--project', '-p', '--template', '-T', '--subject', '--match-head-commit', '--author-email', '-X', '--method', '-f', '--field', '--raw-field', '--header', '-q', '--jq', '--hostname', '--input', '--preview', '--cache']);
const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);

export const strip = (t: string): string => t.replace(/["'`\\]/g, '');
const lc = (w: Word | undefined | null): string | null => w?.lit?.toLowerCase() ?? null;
const lit = (w: Word | undefined | null): string | null => w?.lit ?? null;
const dyn = (w: Word): boolean => w.lit === null;
const out = (verdict: 'allow' | 'deny', rule: string, reason: string, extra: Partial<Verdict> = {}): Verdict => ({ verdict, rule, reason, ...extra });
const denyOf = (rule: string, reason: string): { deny: { rule: string; reason: string } } => ({ deny: { rule, reason } });
const prefixOf = (long: string, l: string | null): boolean => !!l && l.length >= 2 && long.startsWith(l.toLowerCase());
const synth = (s: string): Word => ({ lit: s, kind: 'lit', raw: s, start: 0, end: 0, vars: [] });

// ---- unwrap: env, command, pwsh -File, Start-Process
function envUnwrap(ws: Word[]): Any {
  const cwd: (string | null)[] = []; let i = 1;
  while (i < ws.length) {
    const l = lit(ws[i]);
    if (l === null) { if (ws[i].prefix && /^[A-Za-z_]\w*=/.test(ws[i].prefix as string)) { i++; continue; } break; }
    if (/^(-S|--split-string)/.test(l)) return { deny: { rule: 'F2', reason: 'env -S hides the command' } };
    if (/^--chdir=/.test(l)) cwd.push(l.slice(8));
    else if (l === '--chdir' || l === '-C') { cwd.push(lit(ws[i + 1])); i++; }
    else if (l === '-u') i++;
    else if (!/^-/.test(l) && !/^[A-Za-z_]\w*=/.test(l)) break;
    i++;
  }
  return { words: ws.slice(i), cwd };
}
function pwshFile(ws: Word[]): Any {
  const i = ws.findIndex((w, k) => k > 0 && prefixOf('-file', lc(w)) && /^-/.test(lc(w) ?? ''));
  return i > 0 && ws[i + 1] ? { words: ws.slice(i + 1), cwd: [] } : null;
}
function startProcess(ws: Word[]): Any {
  const pi = ws.findIndex((w) => w.kind === 'param' && prefixOf('-filepath', lc(w)));
  const fi = pi >= 0 ? pi + 1 : ws.findIndex((w, k) => k > 0 && w.kind !== 'param' && ws[k - 1].kind !== 'param');
  const ai = ws.findIndex((w) => w.kind === 'param' && /^-(argumentlist|args|a)$/i.test(w.lit as string));
  if (fi < 0 || !ws[fi]) return null;
  const arg = ai >= 0 ? ws[ai + 1] : null;
  if (ai >= 0 && (!arg || dyn(arg))) return { words: [ws[fi]], cwd: [], argsUnknown: true };
  const split = arg ? (arg.lit as string).split(/\s+/).filter(Boolean).map(synth) : [];
  return { words: [ws[fi], ...split], cwd: [] };
}
function timeoutUnwrap(ws: Word[]): Any {
  let i = 1;
  while (ws[i] && lit(ws[i]) !== null && /^-/.test(ws[i].lit as string)) i += ['-k', '-s', '--kill-after', '--signal'].includes(ws[i].lit as string) ? 2 : 1;
  return { words: ws.slice(i + 1), cwd: [] }; // one positional (the duration) comes before the command
}
function unwrap(call: Call): Any {
  let words = call.words; const cwd: (string | null)[] = []; let argsUnknown = !!call.argsUnknown;
  for (let n = 0; n < 4 && words[0] && words[0].lit !== null; n++) {
    const p = progName(words[0].lit) ?? '';
    let r: Any = null;
    if (p === 'env') r = envUnwrap(words);
    else if (p === 'timeout') r = timeoutUnwrap(words);
    else if (WRAPPERS.has(p)) r = { words: words.slice(1).filter((w, k, a) => !(lit(w) !== null && /^-/.test(w.lit as string) && a.slice(0, k).every((x) => /^-/.test(lit(x) ?? 'x')))), cwd: [] };
    else if (p === 'pwsh' || p === 'powershell') r = pwshFile(words);
    else if (p === 'start-process' || p === 'saps' || p === 'start') r = startProcess(words);
    if (!r) break;
    if (r.deny) return r;
    cwd.push(...r.cwd); words = r.words; argsUnknown ||= !!r.argsUnknown;
    if (!words.length) break;
  }
  return { words, cwd, argsUnknown };
}

// ---- per-program analysis; each returns { deny } | { guarded } | null
function gitGlobals(ws: Word[]): Any {
  const g: Any = { dir: undefined, dirDyn: false, cVals: [], other: [], i: 1 };
  for (; g.i < ws.length; g.i++) {
    const w = ws[g.i]; const l = lit(w);
    if (l === '-C') { const d = ws[++g.i]; g.dir = lit(d); g.dirDyn ||= !d || dyn(d); }
    else if (l === '-c') g.cVals.push(ws[++g.i]);
    else if (l === '--git-dir' || l === '--work-tree') g.other.push(ws[++g.i]);
    else if (l !== null && /^--(git-dir|work-tree)=/.test(l)) g.other.push(w);
    else if (l !== null && /^-/.test(l)) continue;
    else break;
  }
  return g;
}
function aliasCheck(g: Any): Any {
  for (const v of g.cVals) {
    if (!v) continue;
    const text = v.lit ?? v.prefix ?? '';
    if (!/^alias\./i.test(text)) continue;
    if (v.lit === null || VERB_RE.test(v.lit.split('=').slice(1).join('='))) return denyOf('S4', 'git -c alias hides a guarded verb');
  }
  return null;
}
// git config alias.<name> <value>: a value that is not literal, or holds a guarded verb or a trigger word, is S4.
function configAlias(rest: Word[], entry: EntryTest): Any {
  const i = rest.findIndex((w) => /^alias\./i.test(w.lit ?? w.prefix ?? ''));
  const v = i >= 0 ? rest[i + 1] : null;
  if (!v) return null;
  if (dyn(v) || VERB_RE.test(v.lit as string) || entry(v.lit as string)) return denyOf('S4', 'git config alias value is not literal or holds a guarded call');
  return null;
}
async function gitCall(ws: Word[], call: Call, ctx: Any): Promise<Any> {
  const g = gitGlobals(ws);
  const bad = aliasCheck(g); if (bad) return bad;
  const sub = ws[g.i];
  if (!sub) return null;
  if (dyn(sub)) return denyOf('F2', 'git subcommand is not literal');
  let verb = sub.lit as string; let rest = ws.slice(g.i + 1);
  if (!GIT_BUILTIN.has(verb) && ctx.opts.gitAlias) {
    const v = await ctx.opts.gitAlias(verb, call.cwdBefore);
    if (v && v.startsWith('!')) { if (ctx.entry(v)) return denyOf('S4', 'git shell alias holds a trigger word'); } else if (v) { const parts = v.trim().split(/\s+/); verb = parts[0]; rest = [...parts.slice(1).map(synth), ...rest]; }
  }
  if (verb === 'config') return configAlias(rest, ctx.entry);
  if (verb !== 'push') return null;
  if (g.dirDyn || g.cVals.some((v: Word | undefined) => v && dyn(v)) || g.other.some((v: Word | undefined) => v && dyn(v))) return denyOf('F2', 'git -C, -c or --git-dir value is not literal');
  if (rest.some(dyn)) return denyOf('F2', 'git push remote or refspec is not literal');
  const pos = rest.filter((w) => !/^-/.test(w.lit as string)).map((w) => w.lit);
  return { guarded: { kind: 'git-push', prog: 'git', remote: pos[0] ?? null, refspecs: pos.slice(1), dir: g.dir ?? null, cwd: g.dir ? [g.dir] : [] } };
}
function wrapperCall(ws: Word[], prog: string): Any {
  const freeWords: Word[] = []; let free = false;
  for (const w of ws.slice(1)) {
    if (free) { freeWords.push(w); free = false; continue; }
    if (/^-(m|message)$/i.test(w.lit ?? '')) { free = true; continue; }
    if (dyn(w)) return denyOf('F2', `${prog} word is not literal`);
  }
  return { guarded: { kind: 'wrapper', prog, cwd: [], freeWords } };
}
function landCall(ws: Word[]): Any {
  const i = ws.findIndex((w) => lc(w) === '-pr');
  if (i > 0 && (!ws[i + 1] || dyn(ws[i + 1]))) return denyOf('F2', 'land-pr -Pr value is not literal');
  return { guarded: { kind: 'land', prog: 'land-pr', pr: i > 0 ? lit(ws[i + 1]) : null, cwd: [] } };
}
function crCall(ws: Word[], prog: string): Any {
  if (ws.slice(1).some(dyn)) return denyOf('F2', `${prog} option is not literal`);
  return { guarded: { kind: 'cr', prog, cwd: [] } };
}

function optName(w: Word): Any {
  if (w.lit !== null) return { name: w.lit.split('=')[0], eq: w.lit.includes('='), value: w.lit.includes('=') ? w.lit.slice(w.lit.indexOf('=') + 1) : undefined };
  const m = /^(--?[\w-]+)=/.exec(w.prefix ?? '');
  return m ? { name: m[1], eq: true, value: null } : null;
}
function ghOptions(ws: Word[], from: number): { opts: Any[]; pos: Word[] } {
  const opts: Any[] = []; const pos: Word[] = [];
  for (let i = from; i < ws.length; i++) {
    const w = ws[i]; const o = optName(w);
    const isOpt = o && /^-/.test(o.name);
    if (!isOpt) { pos.push(w); continue; }
    if (o.eq) opts.push({ name: o.name, value: o.value, word: w });
    else if (GH_VALUE_OPTS.has(o.name) && ws[i + 1]) { opts.push({ name: o.name, value: lit(ws[i + 1]), word: ws[i + 1] }); i++; } else opts.push({ name: o.name, value: true, word: w });
  }
  return { opts, pos };
}
function ghPr(ws: Word[], verb: string, from: number): Any {
  const { opts, pos } = ghOptions(ws, from);
  for (const o of opts) if (['--head', '-H', '--base', '-B', '--repo', '-R'].includes(o.name) && o.value === null) return denyOf('F2', `gh ${o.name} is not literal`);
  if (verb === 'merge' && pos.some(dyn)) return denyOf('F2', 'gh pr merge number is not literal');
  const free = opts.filter((o) => ['--title', '-t', '--body', '-b', '--subject'].includes(o.name)).map((o) => o.word);
  return { guarded: { kind: 'gh-pr', prog: 'gh', verb, pr: pos[0]?.lit ?? null, cwd: [], freeWords: free } };
}
function ghApi(ws: Word[], from: number): Any {
  const { opts, pos } = ghOptions(ws, from);
  const ep = pos[0];
  if (!ep || dyn(ep)) return denyOf('F2', 'gh api endpoint is not literal');
  if (!/pulls/i.test(ep.lit as string)) return null;
  if (opts.some((o) => o.name === '--input')) return denyOf('F2', 'gh api --input hides the fields');
  const freeWords: Word[] = [];
  for (const o of opts) {
    if (['-X', '--method'].includes(o.name) && o.value === null) return denyOf('F2', 'gh api method is not literal');
    if (!FIELD_FLAGS.has(o.name)) continue;
    const text: string = o.word.lit ?? o.word.prefix ?? '';
    const key = text.includes('=') ? text.split('=')[0] : null;
    if (key === null) return denyOf('F2', 'gh api field key is not literal');
    if (FREE_KEYS.includes(`${key}=`)) freeWords.push(o.word);
    else if (DECIDING_KEYS.includes(key) && o.word.lit === null) return denyOf('F2', `gh api field ${key} is not literal`);
  }
  return { guarded: { kind: 'gh-api-pulls', prog: 'gh', endpoint: ep.lit, cwd: [], freeWords } };
}
function ghCall(ws: Word[]): Any {
  let i = 1;
  while (ws[i] && lit(ws[i]) !== null && /^-/.test(ws[i].lit as string)) i += GH_VALUE_OPTS.has(ws[i].lit as string) ? 2 : 1;
  const grp = ws[i]; if (!grp) return null;
  if (dyn(grp)) return denyOf('F2', 'gh command group is not literal');
  if (grp.lit === 'api') return ghApi(ws, i + 1);
  const verb = ws[i + 1];
  if (grp.lit === 'alias' && lit(verb) === 'set') return VERB_RE.test(ws.slice(i + 2).map((w) => w.lit ?? w.raw).join(' ')) ? denyOf('S4', 'gh alias set with a guarded value') : null;
  if (grp.lit !== 'pr' || !verb) return null;
  if (dyn(verb)) return denyOf('F2', 'gh pr verb is not literal');
  return ['create', 'merge'].includes(verb.lit as string) ? ghPr(ws, verb.lit as string, i + 2) : null;
}

// ---- F2b: run-time program names (note 02 section 3, rules 1-4; rule 1 is done by shell-ast F2c)
function hasGuardedVerb(args: Word[]): boolean {
  const l = args.map((w) => w.lit);
  if (l.includes('push') || l.includes('review')) return true;
  if (l.some((x, k) => x === 'pr' && ['create', 'merge'].includes(l[k + 1] as string))) return true;
  return l.includes('api') && args.some((w) => /pulls/i.test(w.lit ?? w.raw ?? ''));
}
function nameCall(call: Call, ctx: Any): Any {
  const w0 = call.words[0];
  if (hasGuardedVerb(call.words.slice(1))) return denyOf('F2b', 'run-time program name with a guarded verb');
  const key = (n: string): string => (call.dialect === 'pwsh' ? n.toLowerCase() : n);
  const rhs = ctx.assigns.filter((a: Any) => w0.vars.some((v) => key(v) === a.name)).map((a: Any) => a.raw);
  if (ctx.entry([w0.raw, ...rhs].join(' '))) return denyOf('F2b', 'the sources of a run-time program name hold a trigger word');
  return { residual: { raw: w0.raw }, plain: { prog: null, words: call.words } };
}

// ---- S4 indirection at call level
function aliasCall(call: Call, ctx: Any): Any {
  const p = progName(call.words[0].lit) ?? '';
  if (call.dialect === 'bash' && p === 'alias') ctx.state.bashAliases.push(...call.words.slice(1));
  if (call.dialect === 'bash' && p === 'shopt' && call.words.some((w) => w.lit === 'expand_aliases')) ctx.state.expand = true;
  if (!['set-alias', 'new-alias', 'sal', 'nal'].includes(p)) return null;
  const v = psAliasValue(call.words.slice(1));
  return v !== null && ctx.entry(v) ? denyOf('S4', 'alias value holds a trigger word') : null;
}
function psAliasValue(ws: Word[]): string | null {
  const pos: Word[] = []; let value: Word | null = null;
  for (let i = 0; i < ws.length; i++) {
    if (ws[i].kind === 'param') { const l = (ws[i].lit as string).toLowerCase(); if (prefixOf('-value', l) && l.length >= 2) value = ws[++i]; else if (prefixOf('-name', l)) i++; } else pos.push(ws[i]);
  }
  const w = value ?? pos[1];
  return w ? (w.lit ?? w.raw) : null;
}

async function analyze(call: Call, ctx: Any): Promise<Any> {
  const early = aliasCall(call, ctx);
  if (early) return early;
  const nest = nestedCheck(call, ctx); if (nest) return nest;
  if (call.words[0].lit === null) return nameCall(call, ctx);
  const eff = unwrap(call);
  if (eff.deny) return eff;
  if (!eff.words.length) return null;
  if (eff.words[0].lit === null) return nameCall({ ...call, words: eff.words }, ctx);
  const prog = progName(eff.words[0].lit) as string;
  const r = await dispatch(prog, eff.words, call, ctx);
  if (!r) return GUARDED_PROGS.has(prog) && eff.argsUnknown ? denyOf(call.viaPayload === 'xargs' ? 'F3' : 'F2', `${prog} arguments are not known`) : { plain: { prog, words: eff.words } };
  if (r.deny) return r;
  if (eff.argsUnknown) return denyOf(call.viaPayload === 'xargs' ? 'F3' : 'F2', `${prog} arguments are not known`);
  const cwd = [...(call.cwdBefore ?? []), ...eff.cwd, ...r.guarded.cwd];
  if (cwd.includes(null) || cwd.includes(undefined)) return denyOf('F2', 'a folder change before a guarded call is not literal');
  return { guarded: { ...r.guarded, cwd, words: eff.words.map((w: Word) => w.lit) } };
}
function dispatch(prog: string, ws: Word[], call: Call, ctx: Any): Any {
  if (prog === 'git') return gitCall(ws, call, ctx);
  if (prog === 'git-safe' || prog === 'git-for') return wrapperCall(ws, prog);
  if (prog === 'land-pr') return landCall(ws);
  if (prog === 'gh') return ghCall(ws);
  if (prog === 'cr' || prog === 'coderabbit') return crCall(ws, prog);
  return null;
}
function nestedCheck(call: Call, ctx: Any): Any {
  const n = call.nested; if (!n) return null;
  if (n.status === 'dynamic') return denyOf('F3', `payload of ${n.via} is not literal`);
  if (n.status === 'unparsed') return ctx.entry(n.payload) ? denyOf('F3', 'cmd /c payload holds a trigger word and has no parser') : null;
  if (n.status === 'error') return ctx.entry(n.text) ? denyOf('F1', 'nested payload does not parse') : null;
  return null;
}

// ---- F6
// Indexes of the words of a guarded program that decide nothing: a message, a title or a body.
function freeIndexes(words: Word[]): Set<number> {
  const free = new Set<number>();
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const field = prev && FIELD_FLAGS.has(prev.lit as string) && FREE_KEYS.some((k) => (w.lit ?? w.prefix ?? '').startsWith(k));
    if (field || (prev && FREE_FLAG.test(prev.lit ?? '')) || (w.lit && FREE_EQ.test(w.lit))) free.add(i);
  });
  return free;
}
function freeValueRanges(calls: Call[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const c of calls.filter((x) => x.level === 0 && GUARDED_PROGS.has(progName(x.words[0].lit) ?? ''))) {
    freeIndexes(c.words).forEach((i) => ranges.push([c.words[i].start, c.words[i].end]));
  }
  return ranges;
}
// Round 1 reading, kept for the count: any guarded program word and verb word left in the raw text.
function rawBackstop(text: string, r: ParseResult, state: Any): boolean {
  const ranges = [...r.freeRanges, ...freeValueRanges(r.calls)];
  if (!state.expand) for (const w of state.bashAliases) ranges.push([w.start, w.end]);
  let t = text;
  for (const [s, e] of ranges) t = t.slice(0, s) + ' '.repeat(e - s) + t.slice(e);
  const s = strip(t);
  return PROG_RE.test(s) && VERB_RE.test(s);
}

// Section 13, Q5: a quoted literal argument is judged by its PROGRAM.
function isDataOnly(prog: string, ws: Word[]): boolean {
  if (DATA_ONLY.has(prog)) return true;
  return prog === 'git' && DATA_ONLY_GIT.has(ws[gitGlobals(ws).i]?.lit as string);
}
function argsText(prog: string | null, ws: Word[]): string {
  const free = prog && GUARDED_PROGS.has(prog) ? freeIndexes(ws) : new Set<number>();
  return ws.slice(1).filter((w, i) => w.kind !== 'cmdsubst' && !free.has(i + 1)).map((w) => w.lit ?? w.raw).join(' ');
}
function runsArgument(prog: string | null, text: string): boolean {
  if (prog && RUNNER_ALWAYS.has(prog)) return true;
  if (prog === 'find') return /(^|\s)-(exec|execdir|ok|okdir)\b/.test(text);
  if (prog === 'sed') return /\/[a-z]*e[a-z]*(\s|$)/i.test(text);
  return (prog === 'awk' || prog === 'gawk') && /\bsystem\s*\(/.test(text);
}
function dataCheck(plain: Any, call: Call): Any {
  const { prog, words } = plain;
  if (call.nested?.status === 'parsed' || prog === 'alias') return null;
  if (prog && isDataOnly(prog, words)) return null;
  const text = strip(argsText(prog, words));
  if (!FULL_CALL.test(text)) return null;
  return { deny: { rule: runsArgument(prog, text) ? 'F3' : 'F6', reason: `${prog ?? 'a run-time program'} gets a full guarded call in its argument: put that text in a file`, prog, f6kind: 'data-only' } };
}
// A heredoc body is data only for a data-only program outside a pipe. A shell reads its body as a payload (parsed already).
function heredocCheck(r: ParseResult, text: string): Any {
  for (const h of r.heredocs ?? []) {
    const owner = r.calls.find((c) => c.level === 0 && c.start === h.callStart);
    const prog = owner ? progName(unwrap(owner).words[0]?.lit ?? null) : null;
    const free = !h.pipe && (!owner || owner.nested?.status === 'parsed' || (prog && isDataOnly(prog, unwrap(owner).words)));
    if (!free && FULL_CALL.test(strip(text.slice(h.start, h.end)))) return { deny: { rule: 'F6', reason: `heredoc body of ${prog ?? 'a pipeline'} holds a full guarded call: put that text in a file`, prog: prog ?? '(pipeline)', f6kind: 'heredoc' } };
  }
  return null;
}
// ---- judge one parsed text
function funcCheck(calls: Call[], found: Any[]): Any {
  const wrapped = new Set(calls.filter((c, i) => c.func && found[i]?.guarded).map((c) => (c.func as string).toLowerCase()));
  for (const c of calls) {
    if (c.func || !wrapped.has((c.words[0].lit ?? '').toLowerCase()) || !(c.cwdBefore ?? []).length) continue;
    return denyOf('S4', 'a function with a guarded call runs after a folder change');
  }
  return null;
}
function kindCheck(r: ParseResult, opts: JudgeOpts): Any {
  const allowed = new Set(opts.allowedKinds ?? DEFAULT_KINDS);
  const bad = r.kinds.filter((k) => !allowed.has(k));
  return bad.length ? denyOf('F5', `node kinds not on the list: ${bad.join(', ')}`) : null;
}
async function judgeParsed(r: ParseResult, text: string, entry: EntryTest, opts: JudgeOpts): Promise<Verdict> {
  if (!entry(text)) return out('allow', 'not-entry', 'no trigger word', { calls: r.calls, guarded: [], residual: [] });
  const k = kindCheck(r, opts); if (k) return out('deny', k.deny.rule, k.deny.reason, { calls: r.calls });
  const strict = opts.f6 === 'strict';
  const ctx: Any = { entry, opts, assigns: r.assigns, state: { bashAliases: [], expand: false } };
  const guarded: Any[] = []; const residual: Any[] = []; const found: Any[] = [];
  for (const c of r.calls) {
    const a = await analyze(c, ctx);
    found.push(a);
    if (a?.deny) return out('deny', a.deny.rule, a.deny.reason, { calls: r.calls, guarded });
    if (a?.guarded) guarded.push(a.guarded);
    if (a?.residual) residual.push(a.residual);
    const d = !strict && a?.plain && dataCheck(a.plain, c);
    if (d) return out('deny', d.deny.rule, d.deny.reason, { calls: r.calls, guarded, prog: d.deny.prog, f6kind: d.deny.f6kind });
  }
  const hd = !strict && heredocCheck(r, text);
  if (hd) return out('deny', hd.deny.rule, hd.deny.reason, { calls: r.calls, guarded, prog: hd.deny.prog, f6kind: hd.deny.f6kind });
  const f = funcCheck(r.calls, found); if (f) return out('deny', f.deny.rule, f.deny.reason, { calls: r.calls, guarded });
  const aliasBad = ctx.state.expand && ctx.state.bashAliases.some((w: Word) => entry(w.lit ?? w.raw));
  if (aliasBad) return out('deny', 'S4', 'alias with a trigger word and expand_aliases', { calls: r.calls, guarded });
  if (strict && !guarded.length && rawBackstop(text, r, ctx.state)) return out('deny', 'F6', 'guarded program and verb words in the raw text with no guarded call found', { calls: r.calls, f6kind: 'strict' });
  const rule = guarded.length ? 'judged' : residual.length ? 'F2b-residual' : 'clean';
  return out('allow', rule, 'readable', { calls: r.calls, guarded, residual });
}

// ---- F1
async function judgeText(text: string, dialect: 'bash' | 'pwsh', entry: EntryTest, opts: JudgeOpts): Promise<Verdict> {
  const r = await parseCalls(text, dialect, opts);
  if (r.ok) return { ...(await judgeParsed(r, text, entry, opts)), parseOk: true };
  const err = r.errors[0];
  const fail = out('deny', 'F1', `parse error: ${err.msg}. Split the command or use a script file.`, { calls: [], parseOk: false });
  if (opts.noPrefix) return fail;
  const prefix = text.slice(0, lineStartOf(text, err.offset));
  if (!prefix.trim()) return fail;
  const p = await parseCalls(prefix, dialect, opts);
  if (!p.ok) return fail;
  const j = await judgeParsed(p, prefix, entry, opts);
  if (j.verdict === 'allow' && remainderHoldsCall(text.slice(prefix.length))) {
    return out('deny', 'F6', 'the broken remainder holds a guarded program word and verb word', { calls: p.calls, prefix: true, parseOk: false, f6kind: 'remainder' });
  }
  return { ...j, prefix: true, parseOk: false };
}
// Q4, deny-only: the broken lines cannot be parsed, so the raw words decide, with no free position.
function remainderHoldsCall(rest: string): boolean {
  const s = strip(rest);
  return PROG_RE.test(s) && VERB_RE.test(s);
}

// ---- F4
async function judgeUnknown(text: string, entry: EntryTest, opts: JudgeOpts): Promise<Verdict> {
  const o: JudgeOpts = { ...opts, noPrefix: true };
  const rs = await Promise.all([judgeText(text, 'bash', entry, o), judgeText(text, 'pwsh', entry, o)]);
  const passed = rs.filter((x) => x.parseOk);
  if (!passed.length) return out('deny', 'F1', 'both parses fail and the text holds a trigger word', { calls: [] });
  return passed.find((x) => x.verdict === 'deny') ?? passed[0];
}

export async function judge(text: string, dialect: Dialect, entryTest: EntryTest, opts: JudgeOpts = {}): Promise<Verdict> {
  const entry: EntryTest = (t) => entryTest(strip(t));
  if (!entry(text)) return out('allow', 'not-entry', 'no trigger word', { calls: [], guarded: [], residual: [] });
  if (dialect === 'unknown') return judgeUnknown(text, entry, opts);
  return judgeText(text, dialect, entry, opts);
}
