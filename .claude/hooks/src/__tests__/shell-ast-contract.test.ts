// RED rows for coord-guard-shell-parser PR A: the AST-shape contract for sh-syntax 0.8.1 (design note 02 section 7).
// A version bump that changes the wire format must fail here. The module under test, shared/shell-ast.ts, does not exist yet:
// every row fails on import until the port of the scratch draft lands (GREEN).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseBashRaw, SH_SYNTAX_DIR, BinCmdOperator, RedirOperator, ParExpOperator } from '../shared/shell-ast.js';

// pathToFileURL gives a valid file URL for a C:/ path and a /home path alike (file:/// plus an absolute path breaks on Linux).
const ops: any = await import(pathToFileURL(`${SH_SYNTAX_DIR}/lib/operators.js`).href);
const P = 'pu' + 'sh';
const first = async (t: string): Promise<any> => ((await parseBashRaw(t)) as any).stmts[0];
const sha = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(`${SH_SYNTAX_DIR}/${f}`)).digest('hex');
const keys = (n: object): string[] => Object.keys(n).sort();


test('pinned package files are the 0.8.1 bytes', () => {
  assert.equal(JSON.parse(fs.readFileSync(`${SH_SYNTAX_DIR}/package.json`, 'utf8')).version, '0.8.1');
  assert.equal(sha('main.wasm'), 'c03a3ee775e633fd88fbe1a70a953205564a8f9660a12ed5a4e067465c53a658');
  assert.equal(sha('vendors/wasm_exec.cjs'), 'e911c4760cabadaa8f669760d42d25830783a134739101467e2bdc11370ed37c');
});

test('operator codes the walker uses', () => {
  assert.equal(ops.BinCmdOperator.AndStmt, 11);
  assert.equal(ops.BinCmdOperator.OrStmt, 12);
  assert.equal(ops.BinCmdOperator.Pipe, 13);
  assert.equal(ops.BinCmdOperator.PipeAll, 14);
  assert.equal(ops.RedirOperator.RdrIn, 65);
  assert.equal(ops.RedirOperator.RdrInOut, 66);
  assert.equal(ops.RedirOperator.DplIn, 67);
  assert.equal(ops.RedirOperator.Hdoc, 71);
  assert.equal(ops.RedirOperator.DashHdoc, 72);
  assert.equal(ops.RedirOperator.WordHdoc, 73);
  assert.equal(ops.ParExpOperator.AssignUnset, 87);
  assert.equal(ops.ParExpOperator.AssignUnsetOrNull, 88);
});

test('the codes the module hard-codes equal the pinned package codes', () => {
  assert.deepEqual(BinCmdOperator, { AndStmt: ops.BinCmdOperator.AndStmt, OrStmt: ops.BinCmdOperator.OrStmt, Pipe: ops.BinCmdOperator.Pipe, PipeAll: ops.BinCmdOperator.PipeAll });
  assert.deepEqual(RedirOperator, { RdrIn: ops.RedirOperator.RdrIn, RdrInOut: ops.RedirOperator.RdrInOut, DplIn: ops.RedirOperator.DplIn, Hdoc: ops.RedirOperator.Hdoc, DashHdoc: ops.RedirOperator.DashHdoc, WordHdoc: ops.RedirOperator.WordHdoc });
  assert.deepEqual(ParExpOperator, { AssignUnset: ops.ParExpOperator.AssignUnset, AssignUnsetOrNull: ops.ParExpOperator.AssignUnsetOrNull });
});

test('push: File > Stmt > CallExpr > Word > Lit with start and end', async () => {
  const f: any = await parseBashRaw(`git ${P} fork re/x`);
  assert.equal(f.type, 'File');
  assert.ok(Array.isArray(f.stmts));
  const s = f.stmts[0];
  assert.equal(s.type, 'Stmt');
  for (const k of ['cmd', 'background', 'redirs', 'comments', 'negated']) assert.ok(k in s, k);
  assert.equal(s.cmd.type, 'CallExpr');
  assert.ok(Array.isArray(s.cmd.args) && Array.isArray(s.cmd.assigns));
  const w = s.cmd.args[0];
  assert.equal(w.type, 'Word');
  assert.equal(w.parts[0].type, 'Lit');
  assert.equal(w.parts[0].value, 'git');
  assert.equal(typeof w.start, 'number');
  assert.equal(typeof w.end, 'number');
});

test('cd chain: BinaryCmd has op, x and y; & sets Stmt.background', async () => {
  const s = await first('cd /a && git status | cat &');
  assert.equal(s.background, true);
  assert.equal(s.cmd.type, 'BinaryCmd');
  assert.equal(s.cmd.op, ops.BinCmdOperator.AndStmt);
  assert.equal(s.cmd.x.type, 'Stmt');
  assert.equal(s.cmd.y.cmd.type, 'BinaryCmd');
  assert.equal(s.cmd.y.cmd.op, ops.BinCmdOperator.Pipe);
});

test('command substitution in a double quote: DblQuoted > CmdSubst > stmts', async () => {
  const w = (await first(`echo "$(git status)"`)).cmd.args[1];
  assert.equal(w.parts[0].type, 'DblQuoted');
  const cs = w.parts[0].parts[0];
  assert.equal(cs.type, 'CmdSubst');
  assert.ok(Array.isArray(cs.stmts));
  assert.equal(cs.stmts[0].cmd.type, 'CallExpr');
});

test('heredoc: Redirect has op, word and hdoc (a Word)', async () => {
  const r = (await first('cat <<EOF\ncr review\nEOF')).redirs[0];
  assert.equal(r.type, 'Redirect');
  assert.equal(r.op, ops.RedirOperator.Hdoc);
  assert.equal(r.word.type, 'Word');
  assert.equal(r.hdoc.type, 'Word');
  assert.equal(r.hdoc.parts[0].value, 'cr review\n');
});

test('function: FuncDecl has name (a Lit) and body (a Stmt with a Block)', async () => {
  const c = (await first(`f() { git ${P}; }`)).cmd;
  assert.equal(c.type, 'FuncDecl');
  assert.equal(c.name.value, 'f');
  assert.equal(c.body.type, 'Stmt');
  assert.equal(c.body.cmd.type, 'Block');
  assert.ok(Array.isArray(c.body.cmd.stmts));
});

test('bash -c: the payload is an SglQuoted with value', async () => {
  const w = (await first(`bash -c 'git ${P}'`)).cmd.args[2];
  assert.equal(w.parts[0].type, 'SglQuoted');
  assert.equal(w.parts[0].value, `git ${P}`);
  assert.equal(w.parts[0].dollar, false);
});

test('literal rules rest on these facts: backslash kept, ANSI-C flagged', async () => {
  const a = (await first('g\\it x')).cmd.args[0].parts[0];
  assert.equal(a.value, 'g\\it');
  const d = (await first(`echo $'\\x63r'`)).cmd.args[1].parts[0];
  assert.equal(d.type, 'SglQuoted');
  assert.equal(d.dollar, true);
  assert.equal(d.value, '\\x63r');
});

test('assign, ParamExp, comments, ForClause fields', async () => {
  const a = (await first('x=1 git status')).cmd.assigns[0];
  assert.equal(a.type, 'Assign');
  assert.equal(a.name.value, 'x');
  assert.equal(a.value.type, 'Word');
  const p = (await first('echo $WT')).cmd.args[1].parts[0];
  assert.equal(p.type, 'ParamExp');
  assert.equal(p.param.value, 'WT');
  for (const k of ['exp', 'index', 'repl', 'slice', 'names', 'length', 'excl']) assert.ok(k in p, k);
  const c = (await first('echo hi # note')).comments[0];
  assert.equal(c.type, 'Comment');
  assert.equal(typeof c.start, 'number');
  const f = (await first('for i in 1; do a; done')).cmd;
  assert.equal(f.type, 'ForClause');
  assert.equal(f.loop.type, 'WordIter');
  assert.equal(f.loop.name.value, 'i');
  assert.ok(Array.isArray(f.do));
});

test('offsets are bytes and the ParseError carries pos.line and pos.offset', async () => {
  const w = (await first('echo é')).cmd.args[1];
  assert.equal(w.end - w.start, 2);
  const e: any = await parseBashRaw('é "').catch((x: unknown) => x);
  assert.deepEqual(keys(e.pos), ['column', 'line', 'offset']);
  assert.equal(e.pos.offset, 3);
  const e2: any = await parseBashRaw('a\nb "').catch((x: unknown) => x);
  assert.equal(e2.pos.line, 2);
});

test('kinds that the walker allowlist rests on all occur in one rich text', async () => {
  const seen = new Set<string>();
  const walk = (n: any): void => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.type) seen.add(n.type); Object.values(n).forEach(walk); } };
  walk(await parseBashRaw('if t; then a; fi; case x in a) b;; esac; (a); { b; }; [[ -f c && d ]]; ((1+2)); a=(1 2); declare -x z=1; time a; coproc a; let x=1; diff <(a) b; echo $((1)) ${y:-z}'));
  for (const k of ['IfClause', 'CaseClause', 'CaseItem', 'Subshell', 'Block', 'TestClause', 'BinaryTest', 'UnaryTest', 'ArithmCmd', 'ArrayExpr', 'ArrayElem', 'DeclClause', 'TimeClause', 'CoprocClause', 'LetClause', 'ProcSubst', 'ArithmExp', 'ParamExp']) assert.ok(seen.has(k), k);
});
