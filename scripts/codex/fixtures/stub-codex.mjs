#!/usr/bin/env node
// Stand-in for the Codex CLI. The runner spawns it when CODEX_ADVERSARY_STUB points here.
// STUB_MODE picks the behaviour. STUB_MARKER (optional) gets one line per invocation.
// STUB_PIDFILE (optional) gets the pids a hung run leaves behind.
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const mode = process.env.STUB_MODE || 'ok';
const VERSION = '0.162.1';
const USAGE = "You've hit your usage limit. Upgrade to Pro, or try again at 3:42 PM.";
const answerWith = (issue) => JSON.stringify({
  verdict: 'needs-attention',
  findings: [{ file: 'src/billing/invoice-access.js:12', category: 'auth', confidence: 0.95,
    issue, recommendation: 'Use === instead of !==.' }],
});
const ANSWER = answerWith('The owner check is inverted.');

const flag = (name) => args[args.indexOf(name) + 1];
const out = (s) => process.stdout.write(s + '\n');

function header(model, provider = 'openai') {
  const effort = (args.find((a) => a.startsWith('model_reasoning_effort=')) || '=?').split('=')[1];
  out(`OpenAI Codex v${VERSION}\n--------\nworkdir: ${flag('-C')}\nmodel: ${model}\nprovider: ${provider}\n` +
    `approval: never\nsandbox: read-only\nreasoning effort: ${effort}\nreasoning summaries: none\n` +
    `session id: 01a1323f-9dc5-70d0-b1e8-6103e0564974\n--------`);
}

function leakNote() {
  const leaked = Object.keys(process.env).some((k) => /^(openai|codex)_api_key$/i.test(k));
  return leaked ? 'key=yes' : 'key=no';
}

function login() {
  out(mode === 'nologin' ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(mode === 'nologin' ? 1 : 0);
}

function finish(answer) {
  writeFileSync(flag('-o'), answer);
  out(`codex\n${answer}\ntokens used\n1234\n${answer}`);
}

function hang() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true }); // detached escapes node's job object, so only a tree walk stops it
  if (process.env.STUB_PIDFILE) writeFileSync(process.env.STUB_PIDFILE, `${process.pid}\n${child.pid}\n`);
  setTimeout(() => {}, 60000);
}

function exec() {
  const prompt = readFileSync(0, 'utf8');
  const model = mode === 'mismatch' ? 'gpt-4.1' : flag('--model');
  if (mode === 'usage') { out(USAGE); process.exit(1); }
  if (mode !== 'noheader') header(model, mode === 'provider' ? 'other-vendor' : 'openai');
  out(`user\n${prompt}`);   // Codex echoes the whole prompt after the header
  if (mode === 'reject400') {
    out('ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":' +
      `"The '${model}' model is not supported when using Codex with a ChatGPT account."}}`);
    process.exit(1);
  }
  if (mode === 'empty127') process.exit(127);
  if (mode === 'hang') return hang();
  if (mode === 'prose') return finish('Looks fine to me, no real issues found.');
  finish(mode === 'quote' ? answerWith(`${USAGE} "status":400 model is not supported`) : ANSWER);
}

if (process.env.STUB_MARKER) appendFileSync(process.env.STUB_MARKER, `${args[0]} ${leakNote()}\n`);
if (args[0] === '--version') out(`codex-cli ${VERSION}`);
else if (args[0] === 'login') login();
else exec();
