import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import {
  CHECK_KINDS, DRIVERS, FlowError, loadFlows, normalizeFlow, validateAction, validateCheck, validateFlow,
} from './flow.mjs';

// The example from section 4 of the spec, minus the P2 `serve` and the agent-only `note`.
const SPEC_YAML = `
id: pre-pr-gate-inline-body
title: pre-pr-gate denies an unmatched inline body
description: a PR create call whose body the gate cannot match to the stamp
goal: The hook blocks the call
paths: [.claude/hooks/src/pre-pr-gate.ts]
symbols: [bodyFileOf]
driver: hook
mode: scripted
profile: container
needs: [git]
start:
  git: commit
  remote: https://github.com/Rev4nchist/Continuous-Claude-v3.git
  stamp: fixtures/pre-pr-stamp.json
  run: [node, scripts/setup.mjs]
  cwd: .
steps:
  - action: {hook: .claude/hooks/dist/pre-pr-gate.mjs, payload: fixtures/pr-create-inline-body.json}
    checks:
      - {text: gate blocks the call, stdout: "BLOCKED \\\\(pre-pr-gate\\\\)"}
limits: {timeoutMs: 60000, retries: 2, maxSteps: 20}
severity: P1
`;

const good = () => parse(SPEC_YAML);
const withChange = (fn) => { const f = good(); fn(f); return f; };
const errorsOf = (fn) => validateFlow(withChange(fn));
const hasError = (errors, part) => errors.some((e) => e.includes(part));
const step = (n = 0) => ({ action: { hook: 'h.mjs', payload: 'p.json' }, checks: [{ text: `check ${n}`, exit: 0 }] });

test('the spec example is a valid flow', () => {
  assert.deepEqual(validateFlow(good()), []);
});

test('the exports list the five drivers and the check kinds', () => {
  assert.deepEqual([...DRIVERS], ['cli', 'hook', 'mod-event', 'api', 'browser']);
  assert.deepEqual([...CHECK_KINDS], ['exit', 'stdout', '!stdout', 'json', 'status', 'body', '!body', 'file', 'playwright', 'judge']);
});

// ---------- validateFlow: top-level fields ----------

// Breaks if: the not-an-object guard is removed.
test('validateFlow rejects a value that is not a mapping', () => {
  for (const v of [null, 'text', 7, [], undefined]) assert.ok(validateFlow(v).length > 0, String(v));
});

// Breaks if: a required field is dropped from the required list.
test('validateFlow rejects a missing required field', () => {
  for (const key of ['id', 'title', 'description', 'goal', 'paths', 'driver', 'steps']) {
    assert.ok(hasError(errorsOf((f) => delete f[key]), key), key);
  }
});

// Breaks if: the id regex is loosened or the length bounds change.
test('validateFlow rejects a bad id', () => {
  for (const id of ['ab', 'Upper-Case', 'has space', 'under_score', 'a'.repeat(65), 12345, '']) {
    assert.ok(hasError(errorsOf((f) => { f.id = id; }), 'id'), String(id));
  }
  assert.deepEqual(errorsOf((f) => { f.id = 'abc'; }), []);
  assert.deepEqual(errorsOf((f) => { f.id = 'a'.repeat(64); }), []);
});

// Breaks if: the title limit moves off 120.
test('validateFlow rejects a title over 120 characters and accepts 120', () => {
  assert.ok(hasError(errorsOf((f) => { f.title = 'x'.repeat(121); }), 'title'));
  assert.deepEqual(errorsOf((f) => { f.title = 'x'.repeat(120); }), []);
});

// Breaks if: the title may hold a newline.
test('validateFlow rejects a multi-line title', () => {
  assert.ok(hasError(errorsOf((f) => { f.title = 'one\ntwo'; }), 'title'));
});

// Breaks if: the unknown-key rule is removed. A typo such as `step:` would pass silently.
test('validateFlow rejects an unknown top-level key', () => {
  assert.ok(hasError(errorsOf((f) => { f.step = []; }), 'step'));
});

// Breaks if: the driver enum accepts any string.
test('validateFlow rejects an unknown driver', () => {
  assert.ok(hasError(errorsOf((f) => { f.driver = 'ssh'; }), 'driver'));
});

// Breaks if: the mode, profile or needs enums are not checked.
test('validateFlow rejects a bad mode, profile and needs value', () => {
  assert.ok(hasError(errorsOf((f) => { f.mode = 'auto'; }), 'mode'));
  assert.ok(hasError(errorsOf((f) => { f.profile = 'vm'; }), 'profile'));
  assert.ok(hasError(errorsOf((f) => { f.needs = ['redis']; }), 'needs'));
  assert.ok(hasError(errorsOf((f) => { f.needs = 'git'; }), 'needs'));
  assert.ok(hasError(errorsOf((f) => { f.needs = ['git', 'git']; }), 'needs'));
});

// Breaks if: severity accepts P3 or a lowercase value.
test('validateFlow rejects a severity outside P0-P2', () => {
  for (const s of ['P3', 'p1', 'high', 1]) assert.ok(hasError(errorsOf((f) => { f.severity = s; }), 'severity'), String(s));
  for (const s of ['P0', 'P1', 'P2']) assert.deepEqual(errorsOf((f) => { f.severity = s; }), []);
});

// Breaks if: the host-is-scripted-only rule is removed.
test('validateFlow rejects profile host with mode agent', () => {
  const errors = errorsOf((f) => { f.profile = 'host'; f.mode = 'agent'; });
  assert.ok(hasError(errors, 'host'));
});

test('validateFlow accepts profile host with mode scripted', () => {
  assert.deepEqual(errorsOf((f) => { f.profile = 'host'; }), []);
});

// ---------- paths ----------

// Breaks if: the paths rule loses one of its syntax checks (matchGlob: posix, no ./, no braces).
test('validateFlow rejects paths outside matchGlob syntax', () => {
  const bad = ['./src/a.ts', '/abs/a.ts', 'src\\a.ts', 'src/{a,b}.ts', '', 'src/../a.ts'];
  for (const p of bad) assert.ok(hasError(errorsOf((f) => { f.paths = [p]; }), 'paths'), p);
});

// Breaks if: the empty-array check is removed.
test('validateFlow rejects empty and non-array paths', () => {
  assert.ok(hasError(errorsOf((f) => { f.paths = []; }), 'paths'));
  assert.ok(hasError(errorsOf((f) => { f.paths = 'src/a.ts'; }), 'paths'));
});

test('validateFlow accepts the glob forms matchGlob supports', () => {
  assert.deepEqual(errorsOf((f) => { f.paths = ['scripts/**', '.claude/hooks/src/*.ts', 'a/b?.md']; }), []);
});

// ---------- steps, limits ----------

// Breaks if: the lower bound of 1 is dropped.
test('validateFlow rejects 0 steps', () => {
  assert.ok(hasError(errorsOf((f) => { f.steps = []; }), 'steps'));
});

// Breaks if: the upper bound of 100 moves.
test('validateFlow rejects 101 steps and accepts 100', () => {
  const many = (n) => (f) => { f.limits = { maxSteps: 100 }; f.steps = Array.from({ length: n }, (_, i) => step(i)); };
  assert.ok(hasError(errorsOf(many(101)), 'steps'));
  assert.deepEqual(errorsOf(many(100)), []);
});

// Breaks if: the steps-versus-maxSteps comparison is removed.
test('validateFlow rejects more steps than limits.maxSteps', () => {
  const errors = errorsOf((f) => { f.limits = { maxSteps: 1 }; f.steps = [step(0), step(1)]; });
  assert.ok(hasError(errors, 'maxSteps'));
});

// Breaks if: a step may carry no checks, or an unknown key.
test('validateFlow rejects a step with no checks, no action or a foreign key', () => {
  assert.ok(hasError(errorsOf((f) => { f.steps = [{ action: step().action, checks: [] }]; }), 'checks'));
  assert.ok(hasError(errorsOf((f) => { f.steps = [{ checks: step().checks }]; }), 'action'));
  assert.ok(hasError(errorsOf((f) => { f.steps = [{ ...step(), extra: 1 }]; }), 'extra'));
  assert.ok(hasError(errorsOf((f) => { f.steps = ['text']; }), 'steps'));
});

// Breaks if: a limit bound moves.
test('validateFlow enforces the limits bounds', () => {
  const lim = (limits) => errorsOf((f) => { f.limits = limits; });
  assert.ok(hasError(lim({ timeoutMs: 900001 }), 'timeoutMs'));
  assert.ok(hasError(lim({ timeoutMs: 0 }), 'timeoutMs'));
  assert.ok(hasError(lim({ retries: 3 }), 'retries'));
  assert.ok(hasError(lim({ retries: -1 }), 'retries'));
  assert.ok(hasError(lim({ maxSteps: 101 }), 'maxSteps'));
  assert.ok(hasError(lim({ retries: 1.5 }), 'retries'));
  assert.ok(hasError(lim({ turbo: 1 }), 'turbo'));
  assert.deepEqual(lim({ timeoutMs: 900000, retries: 0, maxSteps: 100 }), []);
});

// ---------- start ----------

// Breaks if: start.git accepts any value.
test('validateFlow accepts start.git only as "commit"', () => {
  assert.ok(hasError(errorsOf((f) => { f.start.git = 'clone'; }), 'start.git'));
});

// Breaks if: the agent-only rule on start.note is removed.
test('validateFlow allows start.note only in mode agent', () => {
  assert.ok(hasError(errorsOf((f) => { f.start.note = 'hint'; }), 'start.note'));
  assert.deepEqual(errorsOf((f) => { f.mode = 'agent'; f.start.note = 'hint'; }), []);
});

// Breaks if: start.db is accepted without needs: [db].
test('validateFlow requires needs db when start.db is set', () => {
  assert.ok(hasError(errorsOf((f) => { f.start.db = 'fixtures/seed.sql'; }), 'start.db'));
  assert.deepEqual(errorsOf((f) => { f.needs = ['db', 'git']; f.start.db = 'fixtures/seed.sql'; }), []);
});

// Breaks if: fixture paths may leave the flows dir.
test('validateFlow rejects a fixture path that escapes the flows dir', () => {
  for (const p of ['../x.json', '/etc/passwd', 'a/../../x', 'C:\\x.json', 'a\\b.json']) {
    assert.ok(hasError(errorsOf((f) => { f.start.stamp = p; }), 'start.stamp'), p);
  }
});

// Breaks if: start.run lets a string through. The runner would need a shell.
test('validateFlow requires start.run to be an argv array of strings', () => {
  assert.ok(hasError(errorsOf((f) => { f.start.run = 'node setup.mjs'; }), 'start.run'));
  assert.ok(hasError(errorsOf((f) => { f.start.run = []; }), 'start.run'));
  assert.ok(hasError(errorsOf((f) => { f.start.run = ['node', 3]; }), 'start.run'));
});

// Breaks if: the start key list is open.
test('validateFlow rejects an unknown start key and checks start.serve', () => {
  assert.ok(hasError(errorsOf((f) => { f.start.shell = 'sh'; }), 'shell'));
  const serve = (s) => errorsOf((f) => { f.start.serve = s; });
  assert.deepEqual(serve({ cmd: ['npx', 'next', 'start'], port: 13000, ready: '/' }), []);
  assert.ok(hasError(serve({ cmd: ['npx'], port: 70000, ready: '/' }), 'serve'));
  assert.ok(hasError(serve({ cmd: 'npx next', port: 1300, ready: '/' }), 'serve'));
});

// ---------- validateCheck ----------

const checkErrors = (check, mode = 'scripted') => validateCheck(check, mode);

// Breaks if: judge is allowed in scripted mode, or refused in agent mode.
test('validateCheck allows judge only in mode agent', () => {
  const judge = { text: 'looks right', judge: { artifact: 'out.png' } };
  assert.ok(hasError(checkErrors(judge, 'scripted'), 'judge'));
  assert.deepEqual(checkErrors(judge, 'agent'), []);
  assert.ok(hasError(errorsOf((f) => { f.steps = [{ ...step(), checks: [judge] }]; }), 'judge'));
});

// Breaks if: the one-line rule on text is removed.
test('validateCheck rejects a missing, empty or multi-line text', () => {
  assert.ok(hasError(checkErrors({ exit: 0 }), 'text'));
  assert.ok(hasError(checkErrors({ text: '', exit: 0 }), 'text'));
  assert.ok(hasError(checkErrors({ text: 'a\nb', exit: 0 }), 'text'));
  assert.ok(hasError(checkErrors({ text: 'a\r\nb', exit: 0 }), 'text'));
});

// Breaks if: the one-line rule covers text only and not the regex values.
test('validateCheck rejects a multi-line value in a check', () => {
  assert.ok(hasError(checkErrors({ text: 't', stdout: 'a\nb' }), 'stdout'));
  assert.ok(hasError(checkErrors({ text: 't', '!body': 'a\nb' }), '!body'));
  assert.ok(hasError(checkErrors({ text: 't', file: 'a\nb' }), 'file'));
});

// Breaks if: a check may hold zero or two kinds.
test('validateCheck requires exactly one kind', () => {
  assert.ok(hasError(checkErrors({ text: 't' }), 'kind'));
  assert.ok(hasError(checkErrors({ text: 't', exit: 0, stdout: 'x' }), 'kind'));
  assert.ok(hasError(checkErrors({ text: 't', exit: 0, extra: 1 }), 'extra'));
});

// Breaks if: the check value is not type-checked.
test('validateCheck accepts each kind and rejects a wrong value type', () => {
  const okCases = [
    { exit: 0 }, { exit: 2 }, { stdout: 'ok' }, { '!stdout': 'error' }, { status: 200 }, { body: '"id"' }, { '!body': 'trace' },
    { json: { file: 'out.json', path: 'a.b', equals: 3 } }, { file: 'out.txt' }, { file: 'out.txt', '~': 'ok' },
    { file: 'out.txt', '!~': 'bad' }, { playwright: 'passed' },
  ];
  for (const c of okCases) assert.deepEqual(checkErrors({ text: 't', ...c }), [], JSON.stringify(c));
  const badCases = [
    { exit: '0' }, { exit: 1.5 }, { exit: -1 }, { exit: 2 ** 32 }, { stdout: 5 }, { status: 99 }, { status: '200' }, { body: '' },
    { json: { file: 'f', path: 'p' } }, { json: { file: 'f', equals: 1 } }, { json: 'x' }, { json: { file: 'f', path: 'p', equals: 1, x: 1 } },
    { playwright: 'failed' }, { playwright: true }, { '~': 'x' }, { file: 'f', '~': 'a', '!~': 'b' }, { file: '' },
  ];
  for (const c of badCases) assert.ok(checkErrors({ text: 't', ...c }).length > 0, JSON.stringify(c));
});

// Breaks if: regex values are not compiled.
test('validateCheck rejects a regex that does not compile', () => {
  for (const c of [{ stdout: '(' }, { '!stdout': '[' }, { body: '*a' }, { '!body': '(?<' }, { file: 'f', '~': '(' }, { file: 'f', '!~': '+' }]) {
    assert.ok(checkErrors({ text: 't', ...c }).length > 0, JSON.stringify(c));
  }
});

// Breaks if: a non-object check crashes or passes.
test('validateCheck rejects a non-object check', () => {
  for (const c of [null, 'text', 3, []]) assert.ok(checkErrors(c).length > 0, String(c));
});

// ---------- validateAction ----------

const ACTIONS = {
  cli: [{ cmd: ['node', 'a.mjs'], cwd: 'sub', env: { A: '1' }, stdin: 'in' }, { cmd: ['node'] }],
  hook: [{ hook: '.claude/hooks/dist/x.mjs', payload: 'fixtures/p.json' }],
  'mod-event': [{ test: 'tests/event.json' }],
  api: [{ method: 'POST', path: '/api/x', bodyFile: 'fixtures/b.json' }, { method: 'GET', path: '/health' }],
  browser: [{ playwright: 'e2e/trex-a.spec.ts', config: 'playwright.trex.config.ts', projects: ['chromium'] }],
};

// Breaks if: a driver loses its shape rule.
test('validateAction accepts the documented shape of every driver', () => {
  for (const driver of DRIVERS) {
    for (const action of ACTIONS[driver]) assert.deepEqual(validateAction(driver, action), [], `${driver} ${JSON.stringify(action)}`);
  }
});

// Breaks if: a required key can be dropped. Drops every required key in turn.
test('validateAction rejects an action with a required key removed', () => {
  const required = { cli: ['cmd'], hook: ['hook', 'payload'], 'mod-event': ['test'], api: ['method', 'path'], browser: ['playwright', 'config', 'projects'] };
  for (const driver of DRIVERS) {
    for (const key of required[driver]) {
      const action = { ...ACTIONS[driver][0] };
      delete action[key];
      assert.ok(validateAction(driver, action).length > 0, `${driver} without ${key}`);
    }
  }
});

// Breaks if: unknown keys are tolerated. A cli action holding `hook` must fail.
test('validateAction rejects a key that belongs to another driver', () => {
  assert.ok(hasError(validateAction('cli', { cmd: ['x'], hook: 'h' }), 'hook'));
  assert.ok(hasError(validateAction('hook', { hook: 'h', payload: 'p', cmd: ['x'] }), 'cmd'));
  assert.ok(hasError(validateAction('api', { method: 'GET', path: '/', test: 't' }), 'test'));
});

// Breaks if: the shell-string form of cmd is accepted.
test('validateAction requires cli cmd to be a non-empty argv array of strings', () => {
  for (const cmd of ['node a.mjs', [], ['node', 1], 'x']) assert.ok(hasError(validateAction('cli', { cmd }), 'cmd'), JSON.stringify(cmd));
  assert.ok(hasError(validateAction('cli', { cmd: ['x'], env: { A: 1 } }), 'env'));
  assert.ok(hasError(validateAction('cli', { cmd: ['x'], cwd: '../up' }), 'cwd'));
});

// Breaks if: fixture and tree paths may escape.
test('validateAction rejects an absolute or escaping fixture path', () => {
  assert.ok(hasError(validateAction('hook', { hook: 'h.mjs', payload: '../p.json' }), 'payload'));
  assert.ok(hasError(validateAction('hook', { hook: '/abs/h.mjs', payload: 'p.json' }), 'hook'));
  assert.ok(hasError(validateAction('api', { method: 'POST', path: '/x', bodyFile: '/abs.json' }), 'bodyFile'));
});

// Breaks if: the api method or path rules are loosened.
test('validateAction checks the api method and path', () => {
  assert.ok(hasError(validateAction('api', { method: 'TRACE', path: '/x' }), 'method'));
  assert.ok(hasError(validateAction('api', { method: 'get', path: '/x' }), 'method'));
  assert.ok(hasError(validateAction('api', { method: 'GET', path: 'x' }), 'path'));
});

// Breaks if: browser projects may be a string or empty.
test('validateAction requires browser projects to be a non-empty string array', () => {
  const b = (projects) => validateAction('browser', { playwright: 'a.spec.ts', config: 'c.ts', projects });
  assert.ok(hasError(b('chromium'), 'projects'));
  assert.ok(hasError(b([]), 'projects'));
});

// Breaks if: an unknown driver crashes or passes.
test('validateAction rejects an unknown driver', () => {
  assert.ok(hasError(validateAction('ssh', { cmd: ['x'] }), 'driver'));
});

// Breaks if: validateFlow stops passing the flow driver to validateAction.
test('validateFlow applies the driver action shape to each step', () => {
  const errors = errorsOf((f) => { f.steps[0].action = { cmd: ['node'] }; });
  assert.ok(hasError(errors, 'steps[0].action'));
});

// ---------- normalizeFlow ----------

// Breaks if: a default is changed or the input is mutated.
test('normalizeFlow fills defaults on a copy', () => {
  const flow = { id: 'abc', title: 't', description: 'd', goal: 'g', paths: ['a'], driver: 'cli', steps: [step()] };
  const out = normalizeFlow(flow);
  assert.equal(out.mode, 'scripted');
  assert.equal(out.profile, 'container');
  assert.deepEqual(out.needs, []);
  assert.equal(out.severity, 'P1');
  assert.deepEqual(Object.keys(out.limits).sort(), ['maxSteps', 'retries', 'timeoutMs']);
  assert.equal(flow.mode, undefined);
});

// ---------- loadFlows ----------

const SHA = 'a'.repeat(40);

/** A fake git: `files` maps a repo path to its text. Records every call. */
function fakeGit(files, { lsStatus = 0, showFails = [] } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'ls-tree') {
      const out = Object.keys(files).map((p) => `${p}\0`).join('');
      return { status: lsStatus, stdout: lsStatus ? '' : out, stderr: lsStatus ? 'fatal: bad object' : '' };
    }
    const p = args[1].split(':')[1];
    if (args[0] === 'show' && !showFails.includes(p) && p in files) return { status: 0, stdout: files[p], stderr: '' };
    return { status: 128, stdout: '', stderr: 'fatal: path missing' };
  };
  return { git, calls };
}

const yamlOf = (id) => SPEC_YAML.replace('pre-pr-gate-inline-body', id);

// Breaks if: loadFlows reads the working tree or an unpinned ref instead of the sha.
test('loadFlows reads only through git, at the given sha', () => {
  const { git, calls } = fakeGit({ '.trex/flows/a.yaml': yamlOf('flow-a') });
  const flows = loadFlows(git, SHA, '.trex/flows');
  assert.equal(flows.length, 1);
  assert.equal(flows[0].id, 'flow-a');
  assert.ok(calls.every((c) => c.includes(SHA) || c.some((a) => a.startsWith(`${SHA}:`))));
  assert.deepEqual(calls.map((c) => c[0]), ['ls-tree', 'show']);
});

// Breaks if: the flows dir default changes.
test('loadFlows defaults the dir to .trex/flows and accepts a trailing slash', () => {
  const a = fakeGit({});
  loadFlows(a.git, SHA);
  assert.ok(a.calls[0].includes('.trex/flows'));
  const b = fakeGit({});
  loadFlows(b.git, SHA, 'x/flows/');
  assert.ok(b.calls[0].includes('x/flows'));
});

// Breaks if: the extension filter is removed or too narrow.
test('loadFlows keeps .yaml and .yml files and skips other files', () => {
  const { git } = fakeGit({
    '.trex/flows/a.yaml': yamlOf('flow-a'), '.trex/flows/b.yml': yamlOf('flow-b'),
    '.trex/flows/fixtures/seed.sql': 'select 1', '.trex/flows/README.md': '# hi', '.trex/flows/c.yaml.bak': 'x: [',
  });
  assert.deepEqual(loadFlows(git, SHA).map((f) => f.id).sort(), ['flow-a', 'flow-b']);
});

// Breaks if: an empty flows dir is treated as an error.
test('loadFlows returns [] for an empty flows dir', () => {
  assert.deepEqual(loadFlows(fakeGit({}).git, SHA), []);
});

// Breaks if: a git failure is read as "no flows". That would read as a clean run.
test('loadFlows throws when ls-tree or show fails', () => {
  assert.throws(() => loadFlows(fakeGit({}, { lsStatus: 128 }).git, SHA), /ls-tree/);
  const files = { '.trex/flows/a.yaml': yamlOf('flow-a') };
  assert.throws(() => loadFlows(fakeGit(files, { showFails: ['.trex/flows/a.yaml'] }).git, SHA), /a\.yaml/);
});

// Breaks if: a parse error or an invalid flow is skipped.
test('loadFlows throws a FlowError that names the file and the problems', () => {
  const bad = yamlOf('flow-a').replace('driver: hook', 'driver: ssh');
  const { git } = fakeGit({ '.trex/flows/bad.yaml': bad, '.trex/flows/ok.yaml': yamlOf('flow-b') });
  let err;
  try { loadFlows(git, SHA); } catch (e) { err = e; }
  assert.ok(err instanceof FlowError);
  assert.equal(err.problems.length, 1);
  assert.equal(err.problems[0].file, '.trex/flows/bad.yaml');
  assert.ok(hasError(err.problems[0].errors, 'driver'));
  assert.match(err.message, /bad\.yaml/);
});

// Breaks if: invalid YAML text or a non-mapping document is accepted.
test('loadFlows rejects broken YAML, an empty file and a list document', () => {
  for (const text of ['id: [unclosed', '', '- a\n- b\n', 'just text']) {
    const { git } = fakeGit({ '.trex/flows/x.yaml': text });
    assert.throws(() => loadFlows(git, SHA), FlowError, JSON.stringify(text));
  }
});

// Breaks if: duplicate keys in one file are accepted. The last key would win without a warning.
test('loadFlows rejects a duplicate YAML key', () => {
  const { git } = fakeGit({ '.trex/flows/x.yaml': `${yamlOf('flow-a')}\ntitle: second\n` });
  assert.throws(() => loadFlows(git, SHA), FlowError);
});

// Breaks if: the duplicate-id Set is removed. Two flows with one id would collide in the report.
test('loadFlows rejects two files with the same id', () => {
  const { git } = fakeGit({ '.trex/flows/a.yaml': yamlOf('same-id'), '.trex/flows/b.yaml': yamlOf('same-id') });
  assert.throws(() => loadFlows(git, SHA), /same-id/);
});

// Breaks if: CRLF text (core.autocrlf on Windows) breaks the parse or leaks \r into values.
test('loadFlows parses CRLF files', () => {
  const { git } = fakeGit({ '.trex/flows/a.yaml': yamlOf('flow-a').replace(/\n/g, '\r\n') });
  const [flow] = loadFlows(git, SHA);
  assert.equal(flow.title, 'pre-pr-gate denies an unmatched inline body');
});

// Breaks if: loadFlows stops applying defaults.
test('loadFlows returns flows with defaults applied', () => {
  const text = yamlOf('flow-a').replace(/^severity: P1\n/m, '').replace(/^mode: scripted\n/m, '');
  const [flow] = loadFlows(fakeGit({ '.trex/flows/a.yaml': text }).git, SHA);
  assert.equal(flow.severity, 'P1');
  assert.equal(flow.mode, 'scripted');
});

// Breaks if: the file order depends on git output order instead of a sort.
test('loadFlows returns flows in path order', () => {
  const { git } = fakeGit({ '.trex/flows/z.yaml': yamlOf('flow-z'), '.trex/flows/a.yaml': yamlOf('flow-a') });
  assert.deepEqual(loadFlows(git, SHA).map((f) => f.id), ['flow-a', 'flow-z']);
});
