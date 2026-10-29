#!/usr/bin/env node
/**
 * Stress Test Runner
 *
 * Runs all stress test categories and produces a summary report.
 *
 * Usage:
 *   node run-all-tests.mjs [--verbose] [--category <name>]
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_FILES = [
  { name: 'Agent Trust (A)', file: 'agent-trust-tests.mjs' },
  { name: 'State Corruption (B)', file: 'state-corruption-tests.mjs' },
  { name: 'Error Learning (D)', file: 'error-learning-tests.mjs' },
  { name: 'Long-Running (E)', file: 'long-running-tests.mjs' },
  { name: 'Cross-Session (F)', file: 'cross-session-tests.mjs' },
];

async function runTest(testFile) {
  return new Promise((resolve) => {
    const testPath = join(__dirname, testFile.file);
    const proc = spawn('node', [testPath], {
      stdio: 'pipe',
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        name: testFile.name,
        file: testFile.file,
        exitCode: code,
        stdout,
        stderr,
        passed: code === 0
      });
    });

    proc.on('error', (err) => {
      resolve({
        name: testFile.name,
        file: testFile.file,
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        passed: false
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const categoryArg = args.find((_, i, arr) => arr[i - 1] === '--category' || arr[i - 1] === '-c');

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   RALPH STRESS TEST SUITE                            ║');
  console.log('║   Finding where the system BREAKS                    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  const testsToRun = categoryArg
    ? TEST_FILES.filter(t => t.name.toLowerCase().includes(categoryArg.toLowerCase()))
    : TEST_FILES;

  if (testsToRun.length === 0) {
    console.log(`No tests matching category: ${categoryArg}`);
    console.log(`Available: ${TEST_FILES.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`Running ${testsToRun.length} test categories...`);
  console.log('');

  const results = [];

  for (const testFile of testsToRun) {
    console.log(`━━━ Running: ${testFile.name} ━━━`);

    const result = await runTest(testFile);
    results.push(result);

    if (verbose) {
      console.log(result.stdout);
      if (result.stderr) {
        console.error(result.stderr);
      }
    } else {
      // Extract just the summary line
      const summaryMatch = result.stdout.match(/Total: (\d+) passed, (\d+) failed/);
      if (summaryMatch) {
        const [, passed, failed] = summaryMatch;
        const status = result.passed ? '✅' : '❌';
        console.log(`${status} ${passed} passed, ${failed} failed`);
      } else {
        console.log(result.passed ? '✅ Passed' : '❌ Failed');
      }
    }
    console.log('');
  }

  // Final Summary
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   FINAL SUMMARY                                      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  results.forEach(r => {
    const status = r.passed ? '✅' : '❌';
    console.log(`${status} ${r.name}`);
  });

  console.log('');
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`TOTAL: ${passed}/${results.length} categories passing`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (failed > 0) {
    console.log('');
    console.log('Failed categories:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.file}`);
    });
    console.log('');
    console.log('Run with --verbose to see detailed output.');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
