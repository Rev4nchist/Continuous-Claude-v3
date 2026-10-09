#!/usr/bin/env node
/**
 * Scan Scope Guard (PreToolUse:Bash|PowerShell)
 *
 * Denies a direct call to an active network / web scanner. These must run
 * through scripts/security/scoped-scan.mjs, which enforces the registry scope
 * gate (deny by default, fail closed). This is the control HexStrike AI lacks:
 * the harness decides the scope, not a prompt.
 *
 * The wrapper spawns the scanner as a child of node, which is not a Claude tool
 * call, so the guard never sees it. The guard only blocks Claude typing the
 * scanner directly.
 *
 * Scope: active web / network attack scanners only. General recon such as nmap
 * is dual-use and not blocked here.
 *
 * Output contract: ALWAYS exit 0. A block is the PreToolUse
 * {hookSpecificOutput:{permissionDecision:'deny'}} envelope from shared/output.ts.
 */

import { readFileSync } from 'fs';
import { outputContinue, outputDeny } from './shared/output.js';
import { logGuardDecision } from './shared/guard-log.js';

interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: { command?: string };
}

// Both shells can run these. The settings.json matcher must name the same tools.
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

// Active web / network attack scanners. Basename, lowercased, no extension.
const BLOCKED = new Set([
  'nuclei',
  'sqlmap',
  'nikto',
  'masscan',
  'wpscan',
  'dalfox',
  'zap-baseline',
  'zap-baseline.py',
]);

/**
 * The leading executable of a command segment, as a bare lowercased basename
 * without a .exe / .cmd / .py extension. Handles quotes, paths and VAR=val
 * prefixes. Returns '' when no executable is found.
 */
function leadingExe(segment: string): string {
  let s = segment.trim();
  // drop leading env assignments: FOO=bar baz. Progress-guarded so a bare "x="
  // (an assignment with no value) cannot spin forever.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/, '');
  } while (s !== prev);
  const m = s.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return '';
  let tok = m[1] || m[2] || m[3] || '';
  tok = tok.replace(/\\/g, '/');
  const base = tok.slice(tok.lastIndexOf('/') + 1).toLowerCase();
  // keep .py (zap-baseline.py); strip .exe / .cmd / .bat
  return base.replace(/\.(exe|cmd|bat)$/, '');
}

/**
 * Split a command into executable-position pieces. Splits on shell separators
 * and on substitution openers ($( and backtick), so a scanner inside
 * `$(nuclei ...)` is also seen. It does NOT normalize backslash escapes, so a
 * Windows path such as C:\tools\sqlmap.exe stays intact (the Bash classifier
 * turned \t into a tab and let it through).
 */
function segmentize(command: string): string[] {
  return command.split(/\|\||&&|[;|&\n(]|\$\(|`/).map((p) => p.trim()).filter(Boolean);
}

function blockedTool(command: string): string | null {
  for (const seg of segmentize(command)) {
    const exe = leadingExe(seg);
    if (BLOCKED.has(exe)) return exe;
  }
  return null;
}

function main(): void {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    outputContinue();
    return;
  }

  if (!COMMAND_TOOLS.has(input.tool_name)) {
    outputContinue();
    return;
  }
  const command = input.tool_input?.command;
  if (!command) {
    outputContinue();
    return;
  }

  const tool = blockedTool(command);
  if (!tool) {
    outputContinue();
    return;
  }

  logGuardDecision('scan-scope-guard', input, 'deny', tool, { command });
  outputDeny(
    `SCAN SCOPE: direct "${tool}" is blocked. Active scanners run through the ` +
    `scope gate: node scripts/security/scoped-scan.mjs web <url> (deny by default, ` +
    `owned targets only). See the security-scan skill. Scanning a host you do not ` +
    `own may be illegal.`
  );
}

// Only run when executed as a script, not when imported by vitest.
if (!process.env.VITEST) {
  try {
    main();
  } catch {
    outputContinue(); // fail-open: a guard crash must never block a tool call
  }
}

export { leadingExe, blockedTool, segmentize, BLOCKED };
