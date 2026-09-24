#!/usr/bin/env node
/**
 * Hook Unit Tests
 * Tests maestro-state-manager, maestro-enforcer, ralph-delegation-enforcer, memory-awareness
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';

const TEST_SESSION = 'hook-unit-test';
const MAESTRO_STATE = join(tmpdir(), `claude-maestro-state-${TEST_SESSION}.json`);
const RALPH_STATE = join(tmpdir(), `claude-ralph-state-${TEST_SESSION}.json`);
const LEGACY_MAESTRO = join(tmpdir(), 'claude-maestro-state.json');
const LEGACY_RALPH = join(tmpdir(), 'claude-ralph-state.json');

async function runHook(hookName, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [`dist/${hookName}.mjs`], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', code => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

function cleanState() {
  [MAESTRO_STATE, RALPH_STATE, LEGACY_MAESTRO, LEGACY_RALPH].forEach(f => {
    if (existsSync(f)) try { unlinkSync(f); } catch {}
  });
  // Clean up PID-based state files from child processes
  const tmp = tmpdir();
  for (const f of readdirSync(tmp)) {
    if ((f.startsWith('claude-maestro-state-') || f.startsWith('claude-ralph-state-')) && f.endsWith('.json')) {
      try { unlinkSync(join(tmp, f)); } catch {}
    }
  }
}

function setMaestroState(state) {
  writeFileSync(MAESTRO_STATE, JSON.stringify({
    active: true,
    taskType: 'implementation',
    reconComplete: state.reconComplete || false,
    interviewComplete: state.interviewComplete || false,
    planApproved: state.planApproved || false,
    activatedAt: Date.now(),
    ...state
  }));
}

function setRalphState(storyId = 'TEST-001') {
  writeFileSync(RALPH_STATE, JSON.stringify({
    active: true,
    storyId,
    activatedAt: Date.now(),
    sessionId: TEST_SESSION
  }));
}

// Test results
const results = { passed: 0, failed: 0, tests: [] };

function test(name, fn) {
  return async () => {
    try {
      await fn();
      results.passed++;
      results.tests.push({ name, status: 'PASS' });
      console.log(`PASS: ${name}`);
    } catch (err) {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', error: err.message });
      console.log(`FAIL: ${name}: ${err.message}`);
    }
  };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// Hooks output {"result":"continue"} or {} to allow
function isContinue(output) {
  return output === '{}' || output === '{"result":"continue"}';
}

// ============ MAESTRO STATE MANAGER TESTS ============

const stateManagerTests = [
  test('StateManager: Activation creates state', async () => {
    cleanState();
    const { stdout } = await runHook('maestro-state-manager', { session_id: TEST_SESSION, prompt: 'yes use maestro' });
    assert(stdout.includes('MAESTRO ACTIVATED'), 'Should show activation');
    assert(existsSync(MAESTRO_STATE), 'State file should exist');
  }),

  test('StateManager: /maestro command activates', async () => {
    cleanState();
    const { stdout } = await runHook('maestro-state-manager', { session_id: TEST_SESSION, prompt: '/maestro' });
    assert(stdout.includes('MAESTRO ACTIVATED'), 'Should activate on /maestro');
  }),

  test('StateManager: recon complete advances phase', async () => {
    cleanState();
    setMaestroState({ reconComplete: false });
    const { stdout } = await runHook('maestro-state-manager', { session_id: TEST_SESSION, prompt: 'recon complete' });
    assert(stdout.includes('Recon Complete'), 'Should show recon complete message');
  }),

  test('StateManager: interview complete advances phase', async () => {
    cleanState();
    setMaestroState({ reconComplete: true, interviewComplete: false });
    const { stdout } = await runHook('maestro-state-manager', { session_id: TEST_SESSION, prompt: 'interview complete' });
    assert(stdout.includes('Interview Complete'), 'Should show interview complete');
  }),

  test('StateManager: approval unlocks execution', async () => {
    cleanState();
    setMaestroState({ reconComplete: true, interviewComplete: true, planApproved: false });
    const { stdout } = await runHook('maestro-state-manager', { session_id: TEST_SESSION, prompt: 'yes' });
    assert(stdout.includes('Plan Approved') || stdout.includes('Answers Received'), 'Should approve plan');
  }),

  test('StateManager: cancel clears state', async () => {
    cleanState();
    setMaestroState({ reconComplete: true });
    const { stdout } = await runHook('maestro-state-manager', { session_id: TEST_SESSION, prompt: 'cancel maestro' });
    assert(stdout.includes('DEACTIVATED'), 'Should show deactivation');
    assert(!existsSync(MAESTRO_STATE), 'State file should be deleted');
  }),
];

// ============ MAESTRO ENFORCER TESTS ============

const enforcerTests = [
  test('Enforcer: scout allowed during recon', async () => {
    cleanState();
    setMaestroState({ reconComplete: false });
    const { stdout } = await runHook('maestro-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Task',
      tool_input: { subagent_type: 'scout', prompt: 'explore codebase' }
    });
    assert(isContinue(stdout), 'Scout should be allowed');
  }),

  test('Enforcer: kraken blocked during recon', async () => {
    cleanState();
    setMaestroState({ reconComplete: false });
    const { stdout } = await runHook('maestro-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Task',
      tool_input: { subagent_type: 'kraken', prompt: 'implement feature' }
    });
    const output = JSON.parse(stdout);
    assert(output.hookSpecificOutput?.permissionDecision === 'deny', 'kraken should be blocked');
  }),

  test('Enforcer: all agents blocked during interview', async () => {
    cleanState();
    setMaestroState({ reconComplete: true, interviewComplete: false });
    const { stdout } = await runHook('maestro-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Task',
      tool_input: { subagent_type: 'scout', prompt: 'explore more' }
    });
    const output = JSON.parse(stdout);
    assert(output.hookSpecificOutput?.permissionDecision === 'deny', 'Should block during interview');
  }),

  test('Enforcer: all agents blocked awaiting approval', async () => {
    cleanState();
    setMaestroState({ reconComplete: true, interviewComplete: true, planApproved: false });
    const { stdout } = await runHook('maestro-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Task',
      tool_input: { subagent_type: 'kraken', prompt: 'implement' }
    });
    const output = JSON.parse(stdout);
    assert(output.hookSpecificOutput?.permissionDecision === 'deny', 'Should block before approval');
  }),

  test('Enforcer: all agents allowed after approval', async () => {
    cleanState();
    setMaestroState({ reconComplete: true, interviewComplete: true, planApproved: true });
    const { stdout } = await runHook('maestro-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Task',
      tool_input: { subagent_type: 'kraken', prompt: 'implement feature' }
    });
    assert(isContinue(stdout), 'kraken should be allowed after approval');
  }),

  test('Enforcer: non-Task tools pass through', async () => {
    cleanState();
    setMaestroState({ reconComplete: false });
    const { stdout } = await runHook('maestro-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.ts' }
    });
    assert(isContinue(stdout), 'Non-Task tools should pass through');
  }),

  test('Enforcer: no state = all allowed', async () => {
    cleanState();
    const { stdout } = await runHook('maestro-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Task',
      tool_input: { subagent_type: 'kraken', prompt: 'implement' }
    });
    assert(isContinue(stdout), 'No maestro state = allow all');
  }),
];

// ============ RALPH DELEGATION ENFORCER TESTS ============

const ralphTests = [
  test('Ralph: Edit on code file blocked', async () => {
    cleanState();
    setRalphState();
    const { stdout } = await runHook('ralph-delegation-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts', old_string: 'x', new_string: 'y' }
    });
    const output = JSON.parse(stdout);
    assert(output.hookSpecificOutput?.permissionDecision === 'deny', 'Code edits should be blocked');
  }),

  test('Ralph: Edit on config file allowed', async () => {
    cleanState();
    setRalphState();
    const { stdout } = await runHook('ralph-delegation-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Edit',
      tool_input: { file_path: 'package.json', old_string: '"v1"', new_string: '"v2"' }
    });
    assert(isContinue(stdout), 'Config edits should be allowed');
  }),

  test('Ralph: Write to .ralph/ allowed', async () => {
    cleanState();
    setRalphState();
    const { stdout } = await runHook('ralph-delegation-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Write',
      tool_input: { file_path: '.ralph/plan.md', content: '# Plan' }
    });
    assert(isContinue(stdout), '.ralph/ writes should be allowed');
  }),

  test('Ralph: Write to code file blocked', async () => {
    cleanState();
    setRalphState();
    const { stdout } = await runHook('ralph-delegation-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Write',
      tool_input: { file_path: 'src/new-file.ts', content: 'code' }
    });
    const output = JSON.parse(stdout);
    assert(output.hookSpecificOutput?.permissionDecision === 'deny', 'Code writes should be blocked');
  }),

  test('Ralph: npm test blocked', async () => {
    cleanState();
    setRalphState();
    const { stdout } = await runHook('ralph-delegation-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    });
    const output = JSON.parse(stdout);
    assert(output.hookSpecificOutput?.permissionDecision === 'deny', 'npm test should be blocked');
  }),

  test('Ralph: git status allowed', async () => {
    cleanState();
    setRalphState();
    const { stdout } = await runHook('ralph-delegation-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'git status' }
    });
    assert(isContinue(stdout), 'git commands should be allowed');
  }),

  test('Ralph: no state = all allowed', async () => {
    cleanState();
    const { stdout } = await runHook('ralph-delegation-enforcer', {
      session_id: TEST_SESSION,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/code.ts', old_string: 'x', new_string: 'y' }
    });
    assert(isContinue(stdout), 'No ralph state = allow all');
  }),
];

// ============ MEMORY AWARENESS TESTS ============
// Note: These require DB - we test skip conditions and output format

const memoryTests = [
  test('Memory: Short prompts skip', async () => {
    const { stdout } = await runHook('memory-awareness', {
      session_id: 'test',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
      cwd: process.cwd()
    });
    assert(isContinue(stdout), 'Short prompts should skip');
  }),

  test('Memory: Slash commands skip', async () => {
    const { stdout } = await runHook('memory-awareness', {
      session_id: 'test',
      hook_event_name: 'UserPromptSubmit',
      prompt: '/recall something',
      cwd: process.cwd()
    });
    assert(isContinue(stdout), 'Slash commands should skip');
  }),
];

// ============ RUN ALL TESTS ============

async function runAll() {
  console.log('\n========================================');
  console.log('      HOOK UNIT TESTS');
  console.log('========================================\n');

  console.log('\n--- MAESTRO STATE MANAGER ---');
  for (const t of stateManagerTests) await t();

  console.log('\n--- MAESTRO ENFORCER ---');
  for (const t of enforcerTests) await t();

  console.log('\n--- RALPH DELEGATION ---');
  for (const t of ralphTests) await t();

  console.log('\n--- MEMORY AWARENESS ---');
  for (const t of memoryTests) await t();

  // Cleanup
  cleanState();

  console.log('\n========================================');
  console.log(`RESULTS: ${results.passed} passed, ${results.failed} failed`);
  console.log('========================================\n');

  process.exit(results.failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
