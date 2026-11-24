// shell-ast.ts: bash text (sh-syntax 0.8.1, exact pin) and PowerShell text (a pwsh -File walker) become ONE normalized call list.
// No hand lexer: quotes, separators and heredocs come from the parser. Design notes 02 (sections 2, 3, 6, 7, 8) and 03.
//
// Two layouts, one module:
//  - src (vitest, tsx): the package files are in node_modules/sh-syntax and the walker is src/shell-ast-walk.ps1.
//  - dist (a bundled hook): the build ships flat copies beside the bundle,
//    dist/sh-syntax.wasm, dist/sh-syntax-wasm_exec.cjs and dist/shell-ast-walk.ps1 (note 02 section 8).
// sh-syntax 0.8.1 omits vendors/wasm_exec.cjs from its sideEffects list, so esbuild drops the import and
// the parse fails with "Go is not defined". We load wasm_exec ourselves, by path, before the first parse.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getProcessor } from 'sh-syntax';

const HERE: string = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/');
const SHIPPED_WASM = `${HERE}sh-syntax.wasm`;
const SHIPPED_WASM_EXEC = `${HERE}sh-syntax-wasm_exec.cjs`;
const SHIPPED: boolean = existsSync(SHIPPED_WASM) && existsSync(SHIPPED_WASM_EXEC);
const WALKER: string = existsSync(`${HERE}shell-ast-walk.ps1`) ? `${HERE}shell-ast-walk.ps1` : `${HERE}../shell-ast-walk.ps1`;

// The package folder, with forward slashes. Empty in a dist run, where only the shipped files exist.
function packageDir(): string {
  if (process.env.SH_SYNTAX_DIR) return process.env.SH_SYNTAX_DIR.replace(/\\/g, '/');
  try {
    const pkg = createRequire(import.meta.url).resolve('sh-syntax/package.json');
    return pkg.replace(/\\/g, '/').replace(/\/package\.json$/, '');
  } catch {
    return '';
  }
}
export const SH_SYNTAX_DIR: string = packageDir();

const WASM_PATH: string = SHIPPED ? SHIPPED_WASM : `${SH_SYNTAX_DIR}/main.wasm`;
const WASM_EXEC_PATH: string = SHIPPED ? SHIPPED_WASM_EXEC : `${SH_SYNTAX_DIR}/vendors/wasm_exec.cjs`;

// Operator codes the walker reads. The contract test (shell-ast-contract.test.ts) compares each one with
// the pinned package's lib/operators.js, so a version bump that moves a code fails there, not here.
export const BinCmdOperator = { AndStmt: 11, OrStmt: 12, Pipe: 13, PipeAll: 14 } as const;
export const RedirOperator = { Hdoc: 71, DashHdoc: 72, WordHdoc: 73 } as const;
export const ParExpOperator = { AssignUnset: 87, AssignUnsetOrNull: 88 } as const;

// An AST node of sh-syntax or a row of the pwsh walker. The shapes are pinned by the contract test, so the walk is untyped on purpose.
/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

export interface Word {
  lit: string | null;
  kind: string;
  raw: string;
  start: number;
  end: number;
  vars: string[];
  var?: string;
  quoted?: boolean;
  prefix?: string;
  viaVar?: string;
  st?: string;
  colon?: boolean;
}
export interface Place { pipe: boolean; chain: string | null; background: boolean }
export interface Nested { status: 'parsed' | 'dynamic' | 'error' | 'unparsed'; via?: string; dialect?: string; text?: string; payload?: string }
export interface Call {
  t: 'call';
  dialect: 'bash' | 'pwsh';
  words: Word[];
  assigns: { name: string; lit: string | null }[];
  place: Place;
  depth: number;
  func: string | null;
  inFunctionBody: boolean;
  op: string | null;
  stdin: { lit: string | null } | null;
  level: number;
  start: number;
  end: number;
  cwdBefore?: (string | null)[];
  nested?: Nested;
  nestedKinds?: Set<string>;
  viaPayload?: string;
  argsUnknown?: boolean;
}
export interface Assign { name: string; lit: string | null; raw: string; top: boolean }
/** `reader` is true when the READER failed (wasm did not load, the parser threw with no position, the pwsh child failed), false or absent for a syntax error of the text. */
export interface ParseError { msg: string; offset: number; line: number; column?: number; reader?: boolean }
/** A `$( )`, backtick or PowerShell `$( )` substitution: its span WITH its delimiters, and whether it sits inside a double-quoted string. */
export interface Subst { from: number; to: number; dq: boolean }
/** Ranges read straight from parser node positions (sh-syntax nodes, PowerShell AST extents), never from a text scan. Offsets are string indexes of the parsed text. */
export interface Spans {
  /** Content of each single or double quoted string and here-string, without its quote characters. */
  quoted: [number, number][];
  substs: Subst[];
  /** Heredoc bodies and here-string bodies. */
  bodies: [number, number][];
}
export interface ParseResult extends Spans {
  ok: boolean;
  calls: Call[];
  errors: ParseError[];
  kinds: string[];
  freeRanges: [number, number][];
  heredocs: { start: number; end: number; pipe: boolean; callStart: number | null }[];
  assigns: Assign[];
  dialect: string;
}
const NO_SPANS: Spans = { quoted: [], substs: [], bodies: [] };
/** `bashProvider` replaces the sh-syntax call (a test seam: one row per reader failure, each on its own path). */
/** `noNested` skips F3: a payload (`bash -c`, `eval`, `iex`, `xargs`) is not parsed and not added to the list. A caller that reads the payload text itself (the coderabbit guard) sets it, so each text is parsed once. */
export interface ParseOpts { pwshProvider?: (text: string) => { json?: N; error?: string }; bashProvider?: (text: string) => Promise<unknown>; timeoutMs?: number; noNested?: boolean }

// F5 lists. BASH_KINDS_NOTE is note 02 section 3 as written; the EXTRA kinds occur in real scripts and the note omits them.
export const BASH_KINDS_NOTE = ['File', 'Stmt', 'CallExpr', 'BinaryCmd', 'Word', 'Lit', 'SglQuoted', 'DblQuoted', 'ParamExp', 'CmdSubst', 'ProcSubst', 'Assign', 'Redirect', 'Subshell', 'Block', 'IfClause', 'WhileClause', 'ForClause', 'WordIter', 'CaseClause', 'CaseItem', 'FuncDecl', 'DeclClause', 'TimeClause', 'ArithmExp', 'BinaryArithm', 'ParenArithm', 'ArrayExpr', 'ArrayElem', 'Comment', 'CoprocClause', 'CStyleLoop', 'UnaryArithm', 'TestClause'];
export const BASH_KINDS_EXTRA = ['BinaryTest', 'UnaryTest', 'ArithmCmd', 'LetClause'];
// Built from the walker's output on its own test texts: the note names 46 types but does not list them. Class, using and DSC kinds are left off on purpose.
export const PWSH_KINDS = ['ScriptBlockAst', 'NamedBlockAst', 'StatementBlockAst', 'PipelineAst', 'PipelineChainAst', 'CommandAst', 'CommandExpressionAst', 'CommandParameterAst', 'StringConstantExpressionAst', 'ExpandableStringExpressionAst', 'ConstantExpressionAst', 'VariableExpressionAst', 'MemberExpressionAst', 'InvokeMemberExpressionAst', 'ArrayExpressionAst', 'ArrayLiteralAst', 'HashtableAst', 'ParenExpressionAst', 'SubExpressionAst', 'ScriptBlockExpressionAst', 'BinaryExpressionAst', 'UnaryExpressionAst', 'ConvertExpressionAst', 'TypeExpressionAst', 'TypeConstraintAst', 'IndexExpressionAst', 'AssignmentStatementAst', 'IfStatementAst', 'ForStatementAst', 'ForEachStatementAst', 'WhileStatementAst', 'DoWhileStatementAst', 'DoUntilStatementAst', 'SwitchStatementAst', 'TryStatementAst', 'CatchClauseAst', 'TrapStatementAst', 'FunctionDefinitionAst', 'ParamBlockAst', 'ParameterAst', 'AttributeAst', 'NamedAttributeArgumentAst', 'FileRedirectionAst', 'MergingRedirectionAst', 'ReturnStatementAst', 'BreakStatementAst', 'ContinueStatementAst', 'ThrowStatementAst', 'ExitStatementAst', 'UsingExpressionAst', 'TernaryExpressionAst', 'AttributedExpressionAst', 'DataStatementAst'];

const CD_NAMES = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const POP_NAMES = new Set(['popd', 'pop-location']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PWSHS = new Set(['pwsh', 'powershell']);
const READ_WRITERS = new Set(['read', 'mapfile', 'readarray', 'getopts']);
const MAX_NEST = 4;

// ---- sh-syntax loader
type Processor = (text: string) => Promise<unknown>;
let processor: Processor | undefined;

function bashProcessor(): Processor {
  if (!processor) {
    createRequire(import.meta.url)(WASM_EXEC_PATH);
    processor = getProcessor(() => fs.readFile(WASM_PATH)) as Processor;
  }
  return processor;
}

// Raw sh-syntax AST of a bash text. A syntax error rejects with a ParseError that carries pos.line and pos.offset.
export async function parseBashRaw(text: string): Promise<unknown> {
  return bashProcessor()(text);
}

export function progName(lit: string | null | undefined): string | null {
  if (lit == null) return null;
  return lit.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
}

// ---- bash words
const GLOB = /[*?]|\[[^\]]*\]|\{[^{}]*(,|\.\.)[^{}]*\}/;
const DQ_ESC = /\\[$`"\\\n]/;
function partLit(p: N): string | null {
  if (p.type === 'Lit') return (/\\/.test(p.value) || GLOB.test(p.value)) ? null : p.value;
  if (p.type === 'SglQuoted') return (p.dollar && p.value.includes('\\')) ? null : p.value;
  if (p.type === 'DblQuoted') {
    if (p.dollar || !(p.parts ?? []).every((q: N) => q.type === 'Lit')) return null;
    const v: string = p.parts.map((q: N) => q.value).join('');
    return DQ_ESC.test(v) ? null : v;
  }
  return null;
}
function wordLit(w: N): string | null {
  let s = '';
  for (const p of w.parts ?? []) { const v = partLit(p); if (v === null) return null; s += v; }
  return s;
}
function partPrefix(p: N): { s: string; end: boolean } {
  if (p.type !== 'DblQuoted') { const v = partLit(p); return v === null ? { s: '', end: true } : { s: v, end: false }; }
  let s = '';
  for (const q of p.parts ?? []) { const r = partPrefix(q); s += r.s; if (r.end) return { s, end: true }; }
  return { s, end: false };
}
function wordPrefix(w: N): string {
  let s = '';
  for (const p of w.parts ?? []) { const r = partPrefix(p); s += r.s; if (r.end) break; }
  return s;
}
const walkAll = (n: N, fn: (x: N) => void): void => {
  if (Array.isArray(n)) { n.forEach((x) => walkAll(x, fn)); return; }
  if (!n || typeof n !== 'object') return;
  if (n.type) fn(n);
  for (const v of Object.values(n)) if (v && typeof v === 'object') walkAll(v, fn);
};
const nodesOf = (n: N, types: string[]): N[] => { const out: N[] = []; walkAll(n, (x) => { if (types.includes(x.type)) out.push(x); }); return out; };
const plainParam = (p: N): boolean => !p.exp && !p.index && !p.repl && !p.slice && !p.names && !p.length && !p.excl && !p.width && !p.isSet && !p.flags;
function singleVar(w: N): { name: string; quoted: boolean } | null {
  const parts: N[] = w.parts ?? [];
  const p = parts.length === 1 ? parts[0] : null;
  const quoted = p?.type === 'DblQuoted';
  const q = quoted && p.parts.length === 1 ? p.parts[0] : p;
  return q?.type === 'ParamExp' && plainParam(q) ? { name: q.param.value, quoted } : null;
}

interface Conv { c: (o: number) => number; slice: (s: number, e: number) => string }
function makeConv(text: string): Conv {
  const buf = Buffer.from(text, 'utf8');
  const ascii = buf.length === text.length;
  return { c: (o) => (ascii ? o : buf.subarray(0, o).toString().length), slice: (s, e) => (ascii ? text.slice(s, e) : buf.subarray(s, e).toString()) };
}

function makeBashWord(w: N, conv: Conv): Word {
  const lit = wordLit(w);
  const cs = nodesOf(w, ['CmdSubst', 'ProcSubst']).length > 0;
  const sv = lit === null ? singleVar(w) : null;
  const kind = lit !== null ? 'lit' : cs ? 'cmdsubst' : sv ? 'var' : 'dyn';
  const vars: string[] = nodesOf(w, ['ParamExp']).map((p) => p.param?.value).filter(Boolean);
  const [start, end] = [conv.c(w.start), conv.c(w.end)];
  const out: Word = { lit, kind, raw: conv.slice(w.start, w.end), start, end, vars };
  if (sv) { out.var = sv.name; out.quoted = sv.quoted; }
  if (lit === null) out.prefix = wordPrefix(w);
  return out;
}

// ---- bash walk: events in evaluation order (inner calls before the call that holds them)
interface Ctx { place: Place; depth: number; func: string | null; top: boolean }
type Ev = N;
interface Walked { events: Ev[]; kinds: Set<string>; free: [number, number][]; heredocs: ParseResult['heredocs']; spans: Spans }

function walkBash(file: N, text: string): Walked {
  const conv = makeConv(text);
  const ev: Ev[] = []; const kinds = new Set<string>(); const free: [number, number][] = [];
  const quoted: [number, number][] = []; const dqRanges: [number, number][] = []; const substRaw: [number, number][] = [];
  walkAll(file, (n) => {
    kinds.add(n.type);
    if (n.type === 'Comment') free.push([conv.c(n.start), conv.c(n.end)]);
    // A quoted string node spans its quote characters: the content is what lies between them ($'..' has one more character in front).
    else if (n.type === 'SglQuoted') quoted.push([conv.c(n.start) + (n.dollar ? 2 : 1), conv.c(n.end) - 1]);
    else if (n.type === 'DblQuoted') { const r: [number, number] = [conv.c(n.start) + (n.dollar ? 2 : 1), conv.c(n.end) - 1]; quoted.push(r); dqRanges.push(r); }
    // ArithmExp (`$(( ))`) is listed with the substitutions: the lexer this replaces read its `$(` as code, and so does the scan that uses the list.
    else if (n.type === 'CmdSubst' || n.type === 'ProcSubst' || n.type === 'ArithmExp') substRaw.push([conv.c(n.start), conv.c(n.end)]);
  });
  const delims: [number, number][] = [];
  const substs: Subst[] = substRaw.map(([from, to]) => ({ from, to, dq: dqRanges.some(([a, b]) => a <= from && to <= b + 1) }));
  const base: Place = { pipe: false, chain: null, background: false };
  const root: Ctx = { place: base, depth: 0, func: null, top: true };
  // Only the outermost substitutions are entered here; stmts() reaches the nested ones itself.
  const subst = (node: N, ctx: Ctx): void => {
    const outer: N[] = [];
    const find = (n: N): void => {
      if (Array.isArray(n)) return n.forEach(find);
      if (!n || typeof n !== 'object') return;
      if (n.type === 'CmdSubst' || n.type === 'ProcSubst') { outer.push(n); return; }
      Object.values(n).forEach((v) => v && typeof v === 'object' && find(v));
    };
    find(node);
    for (const n of outer) stmts(n.stmts, { ...ctx, depth: ctx.depth + 1, top: false });
  };
  const stmts = (list: N[], ctx: Ctx): void => list.forEach((s, i) => stmt(s, i ? { ...ctx, place: { ...ctx.place, chain: ';' } } : ctx));
  const stmt = (s: N, ctx: Ctx): void => {
    const bg = ctx.place.background || s.background;
    const c: Ctx = { ...ctx, place: { ...ctx.place, background: bg }, top: ctx.top && !s.background };
    const prog = s.cmd?.type === 'CallExpr' && s.cmd.args.length ? progName(wordLit(s.cmd.args[0])) : null;
    for (const r of s.redirs ?? []) redirect(r, c, prog, s);
    cmd(s.cmd, c, s);
  };
  const heredocs: Walked['heredocs'] = [];
  const redirect = (r: N, ctx: Ctx, prog: string | null, s: N): void => {
    for (const w of [r.word, r.hdoc]) if (w) subst(w, ctx);
    // The delimiter word of a heredoc (`<<'EOF'`) is no quoted string: its range is taken out of `quoted` below.
    if (r.word && (r.op === RedirOperator.Hdoc || r.op === RedirOperator.DashHdoc)) delims.push([conv.c(r.word.start), conv.c(r.word.end)]);
    if (r.hdoc) heredocs.push({ start: conv.c(r.hdoc.start), end: conv.c(r.hdoc.end), pipe: ctx.place.pipe, callStart: s.cmd?.type === 'CallExpr' && s.cmd.args.length ? conv.c(s.cmd.start) : null });
    if (r.hdoc && !ctx.place.pipe && !SHELLS.has(prog ?? '') && !PWSHS.has(prog ?? '')) free.push([conv.c(r.hdoc.start), conv.c(r.hdoc.end)]);
  };
  const cmd = (c: N, ctx: Ctx, s: N): void => {
    const inner: Ctx = { ...ctx, top: false };
    switch (c?.type) {
      case 'CallExpr': return call(c, ctx, s);
      case 'BinaryCmd': return binary(c, ctx);
      case 'FuncDecl': return stmt(c.body, { ...inner, depth: ctx.depth + 1, func: c.name.value });
      case 'ForClause': return loop(c, { ...inner, depth: ctx.depth + 1 });
      case 'WhileClause': stmts(c.cond ?? [], { ...inner, depth: ctx.depth + 1 }); return stmts(c.do ?? [], { ...inner, depth: ctx.depth + 1 });
      case 'IfClause': return ifc(c, inner);
      case 'CaseClause': subst(c.word, inner); return c.items.forEach((i: N) => stmts(i.stmts ?? [], inner));
      case 'Subshell': return stmts(c.stmts, inner);
      case 'Block': return stmts(c.stmts, ctx);
      case 'TimeClause': case 'CoprocClause': if (c.stmt) stmt(c.stmt, inner); return;
      case 'DeclClause': return decl(c, inner);
      default: return subst(c, inner);
    }
  };
  const ifc = (c: N, ctx: Ctx): void => { stmts(c.cond ?? [], ctx); stmts(c.then ?? [], ctx); if (c.else) ifc(c.else, ctx); };
  const loop = (c: N, ctx: Ctx): void => {
    if (c.loop?.type === 'WordIter') {
      subst(c.loop.items ?? [], ctx);
      const raw = (c.loop.items ?? []).map((w: N) => conv.slice(w.start, w.end)).join(' ');
      ev.push({ t: 'assign', name: c.loop.name.value, lit: null, raw, top: false });
    } else subst(c.loop, ctx);
    stmts(c.do ?? [], ctx);
  };
  const binary = (c: N, ctx: Ctx): void => {
    const pipe = c.op === BinCmdOperator.Pipe || c.op === BinCmdOperator.PipeAll;
    const chain = c.op === BinCmdOperator.AndStmt ? '&&' : c.op === BinCmdOperator.OrStmt ? '||' : null;
    if (pipe) { const p: Ctx = { ...ctx, place: { ...ctx.place, pipe: true }, top: false }; stmt(c.x, p); stmt(c.y, p); return; }
    stmt(c.x, ctx);
    stmt(c.y, { ...ctx, place: { ...ctx.place, chain }, top: false });
  };
  const decl = (c: N, ctx: Ctx): void => {
    if (c.variant?.value === 'export') ev.push({ t: 'barrier' });
    for (const a of c.args ?? []) {
      if (a.value) subst(a.value, ctx);
      if (a.type === 'Assign' && a.name) ev.push({ t: 'assign', name: a.name.value, lit: null, top: false });
    }
  };
  const call = (c: N, ctx: Ctx, s: N): void => {
    for (const a of c.assigns) if (a.value) subst(a.value, ctx);
    for (const w of c.args) { subst(w, ctx); paramWrites(w); }
    if (!c.args.length) {
      for (const a of c.assigns) ev.push({ t: 'assign', name: a.name.value, lit: a.value && !a.array ? wordLit(a.value) : null, raw: a.value ? conv.slice(a.value.start, a.value.end) : '', top: ctx.top });
      return;
    }
    const words: Word[] = c.args.map((w: N) => makeBashWord(w, conv));
    const assigns = c.assigns.map((a: N) => ({ name: a.name.value, lit: a.value ? wordLit(a.value) : null }));
    const call2: Call = { t: 'call', dialect: 'bash', words, assigns, place: ctx.place, depth: ctx.depth, func: ctx.func, inFunctionBody: ctx.func !== null, op: null, stdin: stdinOf(s), level: 0, start: conv.c(c.start), end: conv.c(c.end) };
    writersOf(words);
    ev.push(call2);
  };
  const writersOf = (words: Word[]): void => {
    const p = progName(words[0].lit);
    if (READ_WRITERS.has(p ?? '')) for (const w of words.slice(1)) ev.push({ t: 'assign', name: w.lit ?? w.raw, lit: null, top: false });
    if (p === 'printf') words.forEach((w, i) => w.lit === '-v' && words[i + 1] && ev.push({ t: 'assign', name: words[i + 1].lit ?? words[i + 1].raw, lit: null, top: false }));
    if (['eval', 'source', '.'].includes(words[0].lit ?? '')) ev.push({ t: 'unsafe' });
  };
  const paramWrites = (w: N): void => {
    for (const p of nodesOf(w, ['ParamExp'])) if (p.exp && (p.exp.op === ParExpOperator.AssignUnset || p.exp.op === ParExpOperator.AssignUnsetOrNull) && p.param) ev.push({ t: 'assign', name: p.param.value, lit: null, top: false });
  };
  stmts(file.stmts, root);
  if (kinds.has('LetClause') || kinds.has('ArithmCmd') || kinds.has('ArithmExp') || kinds.has('CStyleLoop')) ev.push({ t: 'unsafe' });
  return { events: ev, kinds, free, heredocs, spans: { quoted: quoted.filter(([a, b]) => !delims.some(([x, y]) => x <= a && b <= y)), substs, bodies: heredocs.map((h) => [h.start, h.end] as [number, number]) } };
}

// stdin of a call: heredoc or here-string body, when the Stmt has one
function stdinOf(s: N): { lit: string | null } | null {
  for (const r of s?.redirs ?? []) {
    if (r.op === RedirOperator.Hdoc || r.op === RedirOperator.DashHdoc) return { lit: r.hdoc ? wordLit(r.hdoc) : null };
    if (r.op === RedirOperator.WordHdoc) return { lit: r.word ? wordLit(r.word) : null };
  }
  return null;
}

// ---- PowerShell
type WalkerOut = { json?: N; error?: string };
function runWalker(text: string, timeoutMs: number): Promise<WalkerOut> {
  return new Promise((resolve) => {
    const cp = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', WALKER], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let done = false;
    const fin = (v: WalkerOut): void => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { cp.kill(); fin({ error: 'pwsh timeout' }); }, timeoutMs);
    cp.stdout.setEncoding('utf8');
    cp.stdout.on('data', (d: string) => { out += d; });
    cp.on('error', (e) => fin({ error: `pwsh spawn: ${e.message}` }));
    cp.on('close', (code) => {
      if (code !== 0) return fin({ error: `pwsh exit ${code}` });
      try { fin({ json: JSON.parse(out) }); } catch { fin({ error: 'pwsh bad json' }); }
    });
    cp.stdin.on('error', () => {});
    cp.stdin.end(text, 'utf8');
  });
}

// One pwsh process for a whole corpus: one walker result per text, in order ({ error } for a text the walker could not read).
export function walkBatch(texts: string[], timeoutMs = 900000): Promise<WalkerOut[]> {
  return new Promise((resolve) => {
    const cp = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', WALKER, '-Batch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows: string[] = []; let buf = '';
    const timer = setTimeout(() => { cp.kill(); }, timeoutMs);
    cp.stdout.setEncoding('utf8');
    cp.stdout.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { rows.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    });
    cp.on('close', () => {
      clearTimeout(timer);
      resolve(texts.map((_, k) => { try { const j = JSON.parse(rows[k]); return j.fatal ? { error: j.fatal } : { json: j }; } catch { return { error: 'batch row missing' }; } }));
    });
    cp.stdin.on('error', () => {});
    cp.stdin.end(JSON.stringify(texts), 'utf8');
  });
}

function psWord(el: N, text: string): Word {
  const w: Word = { lit: null, kind: el.k, raw: text.slice(el.s, el.e), start: el.s, end: el.e, vars: [] };
  if (el.k === 'lit') { w.lit = el.v; w.st = el.st; }
  else if (el.k === 'param') { w.lit = el.v; w.kind = 'param'; }
  else if (el.k === 'subexpr') w.kind = 'cmdsubst';
  else if (el.k === 'var') { w.var = el.var; w.vars = [el.var]; }
  else if (el.k === 'expandable') w.prefix = el.prefix;
  if (el.colon) w.colon = true;
  return w;
}

function walkPwsh(j: N, text: string): Walked {
  const evs: { key: number; ev: Ev }[] = [];
  for (const c of j.cmds) {
    const words: Word[] = c.els.map((e: N) => psWord(e, text));
    evs.push({ key: c.s, ev: { t: 'call', dialect: 'pwsh', words, assigns: [], place: { pipe: c.pipe, chain: c.chain, background: c.bg }, depth: c.depth, func: c.func, inFunctionBody: c.func !== null, op: c.op, stdin: null, level: 0, start: c.s, end: c.e } });
    for (const w of outVarWrites(words)) evs.push({ key: c.s, ev: { t: 'assign', name: w, lit: null, top: false } });
  }
  for (const a of j.assigns) evs.push({ key: a.end - 0.5, ev: { t: 'assign', name: a.name, lit: a.lit, raw: text.slice(a.s, a.end), top: a.top } });
  evs.sort((x, y) => x.key - y.key);
  // The walker script reads these ranges from PowerShell AST extents (older output has none: empty lists).
  const rng = (l: N): [number, number][] => (Array.isArray(l) ? l : []).map((x: N): [number, number] => [x.s, x.e]);
  const substs: Subst[] = (Array.isArray(j.substs) ? j.substs : []).map((x: N) => ({ from: x.s, to: x.e, dq: x.dq === true }));
  return { events: evs.map((x) => x.ev), kinds: new Set<string>(j.kinds), free: j.comments.map((c: N): [number, number] => [c.s, c.e]), heredocs: [], spans: { quoted: rng(j.quoted), substs, bodies: rng(j.bodies) } };
}
const OUTVAR = /^-(ov|outvariable|ev|errorvariable|iv|informationvariable|wv|warningvariable|pv|pipelinevariable)$/i;
function outVarWrites(words: Word[]): string[] {
  const out: string[] = [];
  words.forEach((w, i) => { if (w.kind === 'param' && OUTVAR.test(w.lit ?? '') && words[i + 1]) out.push(words[i + 1].lit ?? words[i + 1].raw); });
  return out;
}

// ---- resolution pass: F2c literal propagation and cwdBefore
function cdTarget(call: Call): string | null | undefined {
  const p = progName(call.words[0].lit);
  if (POP_NAMES.has(p ?? '')) return null;
  if (!CD_NAMES.has(p ?? '')) return undefined;
  const arg = call.words.slice(1).find((w) => w.kind !== 'param' && !(w.lit !== null && /^-./.test(w.lit)));
  return arg ? arg.lit : '~';
}

// A call that can rewrite variables without a visible assignment: no literal may be carried across it (note 02 section 13, F2c final).
const BARRIER_PROGS = new Set(['read', 'mapfile', 'readarray', 'unset', 'set-variable', 'sv', 'new-variable', 'nv', 'remove-variable', 'rv', 'clear-variable', 'clv', 'read-host']);
const isBarrier = (e: Ev): boolean => e.t === 'barrier' || (e.t === 'call' && (BARRIER_PROGS.has(progName(e.words[0].lit) ?? '') || (progName(e.words[0].lit) === 'set' && e.words.some((w: Word) => w.lit === '--'))));

function resolve(events: Ev[], dialect: string): { calls: Call[]; assigns: Assign[] } {
  const key = (n: string): string => (dialect === 'pwsh' ? n.toLowerCase() : n);
  const unsafe = events.some((e) => e.t === 'unsafe');
  const writes = new Map<string, Ev[]>();
  events.forEach((e, i) => { if (e.t === 'assign') { const k = key(e.name); writes.set(k, [...(writes.get(k) ?? []), { ...e, i }]); } });
  const barriers: number[] = []; events.forEach((e, i) => { if (isBarrier(e)) barriers.push(i); });
  const cwd: (string | null)[] = [];
  events.forEach((e, i) => {
    if (e.t !== 'call') return;
    for (const w of e.words) resolveWord(w, i, writes, key, unsafe, barriers);
    e.cwdBefore = [...cwd];
    const t = cdTarget(e);
    if (t !== undefined) cwd.push(t);
  });
  const assigns: Assign[] = events.filter((e) => e.t === 'assign').map((e) => ({ name: key(e.name), lit: e.lit, raw: e.raw ?? '', top: e.top }));
  return { calls: events.filter((e) => e.t === 'call') as Call[], assigns };
}
// An unquoted bash variable splits on spaces and globs, so a value with those (or an empty one) is not one literal word.
const SPLITS = /[\s*?[\]{]|^$/;
function resolveWord(w: Word, i: number, writes: Map<string, Ev[]>, key: (n: string) => string, unsafe: boolean, barriers: number[]): void {
  if (w.kind !== 'var' || w.lit !== null || unsafe) return;
  const ws = writes.get(key(w.var as string));
  if (ws?.length !== 1 || ws[0].lit == null || !ws[0].top || !(ws[0].i < i)) return;
  if (barriers.some((b) => b > ws[0].i && b < i)) return;
  if (w.quoted === false && SPLITS.test(ws[0].lit)) return;
  w.lit = ws[0].lit; w.kind = 'lit'; w.viaVar = w.var;
}

// ---- F3 nested payloads
const isFlagC = (l: string): boolean => /^-[A-Za-z]*c[A-Za-z]*$/.test(l);
const prefixOf = (long: string, l: string): boolean => l.length >= 2 && long.startsWith(l.toLowerCase());
function joinLits(words: Word[]): string | null { return words.some((w) => w.lit === null) ? null : words.map((w) => w.lit).join(' '); }

// The first -Command or -EncodedCommand flag, unless a -File flag comes first: its arguments belong to the script.
function pwshPayloadIndex(ws: Word[]): number {
  for (let k = 1; k < ws.length; k++) {
    const l = ws[k].lit;
    if (l === null || !/^-/.test(l)) continue;
    if (prefixOf('-file', l)) return -1;
    if (prefixOf('-command', l) || prefixOf('-encodedcommand', l)) return k;
  }
  return -1;
}

interface Payload { dialect: 'bash' | 'pwsh' | 'cmd'; via: string; text?: string | null; payload?: string }
function payloadOf(call: Call): Payload | null {
  const ws = call.words; const p = progName(ws[0].lit) ?? '';
  const lit = (i: number): string => (ws[i]?.lit ?? '');
  if (SHELLS.has(p)) {
    const i = ws.findIndex((w, k) => k > 0 && w.lit !== null && isFlagC(w.lit));
    if (i > 0) return { dialect: 'bash', via: 'bash-c', text: ws[i + 1] ? ws[i + 1].lit : null };
    if (call.stdin) return { dialect: 'bash', via: 'stdin', text: call.stdin.lit };
  }
  if (PWSHS.has(p)) {
    const i = pwshPayloadIndex(ws);
    if (i > 0 && prefixOf('-encodedcommand', lit(i))) return { dialect: 'pwsh', via: 'encoded', text: ws[i + 1]?.lit == null ? null : Buffer.from(ws[i + 1].lit as string, 'base64').toString('utf16le') };
    if (i > 0) return { dialect: 'pwsh', via: 'pwsh-c', text: joinLits(ws.slice(i + 1)) };
    if (call.stdin) return { dialect: 'pwsh', via: 'stdin', text: call.stdin.lit };
  }
  if (p === 'eval') return { dialect: 'bash', via: 'eval', text: joinLits(ws.slice(1)) };
  if (p === 'iex' || p === 'invoke-expression') return { dialect: 'pwsh', via: 'iex', text: ws[1] ? ws[1].lit : null };
  if (p === 'cmd') return cmdPayload(ws);
  return null;
}
function cmdPayload(ws: Word[]): Payload | null {
  const i = ws.findIndex((w, k) => k > 0 && w.lit !== null && /^\/[ck]$/i.test(w.lit));
  if (i < 0) return null;
  return { dialect: 'cmd', via: 'cmd-c', payload: ws.slice(i + 1).map((w) => w.lit ?? w.raw).join(' ') };
}

const XARGS_VALUE = new Set(['-a', '-i', '-n', '-p', '-d', '-e', '-s', '-l', '-I', '-P', '-E', '-L', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--max-lines', '--eof', '--replace']);
function xargsInner(call: Call): Call | null {
  if (progName(call.words[0].lit) !== 'xargs') return null;
  let i = 1;
  while (i < call.words.length && call.words[i].lit !== null && /^-/.test(call.words[i].lit as string)) i += XARGS_VALUE.has(call.words[i].lit as string) ? 2 : 1;
  const words = call.words.slice(i);
  return words.length ? { ...call, words, argsUnknown: true, viaPayload: 'xargs', depth: call.depth + 1, level: call.level + 1, nested: undefined } : null;
}

async function expandNested(calls: Call[], opts: ParseOpts, level: number): Promise<Call[]> {
  if (opts.noNested) return calls;
  const out: Call[] = [];
  for (const c of calls) {
    out.push(c);
    const x = xargsInner(c);
    if (x) out.push(x);
    const pay = payloadOf(c);
    if (!pay) continue;
    if (pay.dialect === 'cmd') { c.nested = { status: 'unparsed', dialect: 'cmd', payload: pay.payload }; continue; }
    if (pay.text === null || pay.text === undefined || level >= MAX_NEST) { c.nested = { status: 'dynamic', via: pay.via }; continue; }
    const r = await parseLevel(pay.text, pay.dialect, opts, level + 1);
    if (!r.ok) { c.nested = { status: 'error', via: pay.via, dialect: pay.dialect, text: pay.text }; continue; }
    c.nested = { status: 'parsed', via: pay.via, dialect: pay.dialect };
    for (const ic of r.calls) out.push({ ...ic, depth: ic.depth + c.depth + 1, level: level + 1, viaPayload: pay.via, cwdBefore: [...(c.cwdBefore ?? []), ...(ic.cwdBefore ?? [])] });
    r.kinds.forEach((k) => (c.nestedKinds ??= new Set()).add(k));
  }
  return out;
}

// ---- levels
export function lineStartOf(text: string, offset: number): number { return text.lastIndexOf('\n', offset - 1) + 1; }
function lineOf(text: string, offset: number): number { return text.slice(0, offset).split('\n').length; }

interface Level extends Spans { ok: boolean; calls: Call[]; errors: ParseError[]; kinds: Set<string>; freeRanges: [number, number][]; heredocs: ParseResult['heredocs']; assigns: Assign[]; dialect: string }
interface Raw { ok: boolean; errors: ParseError[]; kinds: Set<string>; events?: Ev[]; free?: [number, number][]; heredocs?: ParseResult['heredocs']; spans?: Spans }

async function parseLevel(text: string, dialect: string, opts: ParseOpts, level: number): Promise<Level> {
  const r = dialect === 'pwsh' ? await levelPwsh(text, opts) : await levelBash(text, opts);
  if (!r.ok) return { ok: false, calls: [], errors: r.errors, kinds: r.kinds, freeRanges: [], heredocs: [], assigns: [], dialect, ...NO_SPANS };
  const { calls, assigns } = resolve(r.events as Ev[], dialect);
  const expanded = await expandNested(calls, opts, level);
  const kinds = new Set(r.kinds);
  for (const c of expanded) c.nestedKinds?.forEach((k) => kinds.add(k));
  return { ok: true, calls: expanded, errors: [], kinds, freeRanges: r.free as [number, number][], heredocs: r.heredocs as ParseResult['heredocs'], assigns, dialect, ...(r.spans ?? NO_SPANS) };
}
async function levelBash(text: string, opts: ParseOpts = {}): Promise<Raw> {
  let file: N;
  try { file = await (opts.bashProvider ?? parseBashRaw)(text); } catch (e: N) {
    const conv = makeConv(text);
    const pos = e?.pos ?? { offset: 0, line: 1, column: 1 };
    // A syntax error of sh-syntax carries `pos`. A throw without it (wasm file missing, bad bytes, a Go panic) is the reader failing.
    return { ok: false, errors: [{ msg: String(e?.message ?? e), offset: conv.c(pos.offset), line: pos.line, column: pos.column, reader: e?.pos === undefined }], kinds: new Set() };
  }
  if (file === null || typeof file !== 'object') return { ok: false, errors: [{ msg: 'sh-syntax returned no tree', offset: 0, line: 1, reader: true }], kinds: new Set() };
  const w = walkBash(file, text);
  return { ok: true, errors: [], kinds: w.kinds, events: w.events, free: w.free, heredocs: w.heredocs, spans: w.spans };
}
async function levelPwsh(text: string, opts: ParseOpts): Promise<Raw> {
  const { json, error } = opts.pwshProvider ? opts.pwshProvider(text) : await runWalker(text, opts.timeoutMs ?? 3000);
  if (error || !json) return { ok: false, errors: [{ msg: error ?? 'pwsh no result', offset: 0, line: 1, reader: true }], kinds: new Set() };
  if (json.errors.length) return { ok: false, errors: json.errors.map((e: N) => ({ msg: e.msg, offset: e.offset, line: lineOf(text, e.offset) })), kinds: new Set<string>(json.kinds) };
  const w = walkPwsh(json, text);
  return { ok: true, errors: [], kinds: w.kinds, events: w.events, free: w.free, heredocs: w.heredocs, spans: w.spans };
}

export async function parseCalls(text: string, dialect: string, opts: ParseOpts = {}): Promise<ParseResult> {
  const r = await parseLevel(text, dialect, opts, 0);
  return { ...r, kinds: [...r.kinds] };
}
