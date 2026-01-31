#!/usr/bin/env node
/**
 * Hook Diagnostics Dashboard
 *
 * Provides visibility into hook health, errors, and performance.
 *
 * Usage:
 *   node dist/diagnostics.mjs              # Full diagnostics
 *   node dist/diagnostics.mjs --errors     # Recent errors only
 *   node dist/diagnostics.mjs --hooks      # Hook inventory
 *   node dist/diagnostics.mjs --json       # JSON output
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const HOOKS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'hooks');
const DIST_DIR = path.join(HOOKS_DIR, 'dist');
const SRC_DIR = path.join(HOOKS_DIR, 'src');
const ERROR_LOG = path.join(HOOKS_DIR, 'errors.log');
const SETTINGS_PATH = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'settings.json');

interface HookConfig {
  type: string;
  command: string;
  timeout: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookConfig[];
}

interface Settings {
  hooks?: {
    [event: string]: HookEntry[];
  };
}

interface DiagnosticResult {
  timestamp: string;
  hooks: {
    total: number;
    byEvent: { [event: string]: number };
    inventory: HookInventoryItem[];
  };
  errors: {
    count: number;
    recent: ErrorEntry[];
  };
  health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    issues: string[];
  };
}

interface HookInventoryItem {
  name: string;
  event: string;
  matcher: string;
  sourceExists: boolean;
  builtExists: boolean;
  timeout: number;
}

interface ErrorEntry {
  timestamp: string;
  message: string;
}

/**
 * Parse settings.json to get hook configuration
 */
function getHookConfig(): Settings {
  try {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(content) as Settings;
  } catch {
    return {};
  }
}

/**
 * Build hook inventory from settings
 */
function buildInventory(settings: Settings): HookInventoryItem[] {
  const inventory: HookInventoryItem[] = [];

  if (!settings.hooks) return inventory;

  for (const [event, entries] of Object.entries(settings.hooks)) {
    for (const entry of entries) {
      const matcher = entry.matcher || '*';
      for (const hook of entry.hooks) {
        // Extract hook name from command
        const match = hook.command.match(/([^/\\]+)\.mjs|([^/\\]+)\.ps1/);
        const name = match ? (match[1] || match[2]) : hook.command;

        // Check if source and built files exist
        const isTypeScript = hook.command.includes('.mjs');
        const isPowerShell = hook.command.includes('.ps1');

        let sourceExists = false;
        let builtExists = false;

        if (isTypeScript) {
          const srcName = name.replace('.mjs', '') + '.ts';
          sourceExists = fs.existsSync(path.join(SRC_DIR, srcName));
          builtExists = fs.existsSync(path.join(DIST_DIR, name + '.mjs'));
        } else if (isPowerShell) {
          sourceExists = fs.existsSync(path.join(HOOKS_DIR, name + '.ps1'));
          builtExists = sourceExists; // PS scripts don't need building
        }

        inventory.push({
          name,
          event,
          matcher,
          sourceExists,
          builtExists,
          timeout: hook.timeout,
        });
      }
    }
  }

  return inventory;
}

/**
 * Parse recent errors from error log
 */
function getRecentErrors(maxLines: number = 50): ErrorEntry[] {
  const errors: ErrorEntry[] = [];

  if (!fs.existsSync(ERROR_LOG)) {
    return errors;
  }

  try {
    const content = fs.readFileSync(ERROR_LOG, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // Take last N lines
    const recentLines = lines.slice(-maxLines);

    for (const line of recentLines) {
      // Try to parse timestamp if present
      const timestampMatch = line.match(/^\[?(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2})/);
      errors.push({
        timestamp: timestampMatch ? timestampMatch[1] : 'unknown',
        message: line.slice(0, 200), // Truncate long messages
      });
    }
  } catch {
    // Ignore errors reading log
  }

  return errors;
}

/**
 * Determine overall health status
 */
function assessHealth(inventory: HookInventoryItem[], errors: ErrorEntry[]): { status: 'healthy' | 'degraded' | 'unhealthy'; issues: string[] } {
  const issues: string[] = [];

  // Check for missing builds
  const missingBuilds = inventory.filter(h => h.sourceExists && !h.builtExists);
  if (missingBuilds.length > 0) {
    issues.push(`${missingBuilds.length} hook(s) not built: ${missingBuilds.map(h => h.name).join(', ')}`);
  }

  // Check for missing sources
  const missingSources = inventory.filter(h => !h.sourceExists);
  if (missingSources.length > 0) {
    issues.push(`${missingSources.length} hook(s) missing source: ${missingSources.map(h => h.name).join(', ')}`);
  }

  // Check for recent errors (last hour)
  const recentErrorCount = errors.filter(e => {
    if (e.timestamp === 'unknown') return false;
    const errorTime = new Date(e.timestamp).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return errorTime > oneHourAgo;
  }).length;

  if (recentErrorCount > 10) {
    issues.push(`${recentErrorCount} errors in the last hour`);
  } else if (recentErrorCount > 0) {
    issues.push(`${recentErrorCount} recent error(s)`);
  }

  // Determine status
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (missingBuilds.length > 0 || recentErrorCount > 10) {
    status = 'unhealthy';
  } else if (missingSources.length > 0 || recentErrorCount > 0) {
    status = 'degraded';
  }

  return { status, issues };
}

/**
 * Main diagnostics function
 */
function runDiagnostics(args: string[]): DiagnosticResult {
  const settings = getHookConfig();
  const inventory = buildInventory(settings);
  const errors = getRecentErrors();
  const health = assessHealth(inventory, errors);

  // Count hooks by event
  const byEvent: { [event: string]: number } = {};
  for (const hook of inventory) {
    byEvent[hook.event] = (byEvent[hook.event] || 0) + 1;
  }

  return {
    timestamp: new Date().toISOString(),
    hooks: {
      total: inventory.length,
      byEvent,
      inventory,
    },
    errors: {
      count: errors.length,
      recent: errors.slice(-10), // Last 10 errors
    },
    health,
  };
}

/**
 * Format diagnostics for human-readable output
 */
function formatDiagnostics(result: DiagnosticResult): string {
  const lines: string[] = [];

  // Header
  lines.push('='.repeat(60));
  lines.push('HOOK DIAGNOSTICS DASHBOARD');
  lines.push(`Generated: ${result.timestamp}`);
  lines.push('='.repeat(60));
  lines.push('');

  // Health Status
  const statusEmoji = result.health.status === 'healthy' ? '[OK]' :
                      result.health.status === 'degraded' ? '[WARN]' : '[FAIL]';
  lines.push(`HEALTH: ${statusEmoji} ${result.health.status.toUpperCase()}`);
  if (result.health.issues.length > 0) {
    for (const issue of result.health.issues) {
      lines.push(`  - ${issue}`);
    }
  }
  lines.push('');

  // Hook Summary
  lines.push('HOOKS SUMMARY');
  lines.push(`  Total: ${result.hooks.total}`);
  for (const [event, count] of Object.entries(result.hooks.byEvent)) {
    lines.push(`  ${event}: ${count}`);
  }
  lines.push('');

  // Hook Inventory
  lines.push('HOOK INVENTORY');
  lines.push('-'.repeat(60));
  const byEvent: { [event: string]: HookInventoryItem[] } = {};
  for (const hook of result.hooks.inventory) {
    if (!byEvent[hook.event]) byEvent[hook.event] = [];
    byEvent[hook.event].push(hook);
  }

  for (const [event, hooks] of Object.entries(byEvent)) {
    lines.push(`[${event}]`);
    for (const hook of hooks) {
      const status = hook.builtExists ? '[OK]' : (hook.sourceExists ? '[BUILD]' : '[MISS]');
      const matcherStr = hook.matcher !== '*' ? ` (${hook.matcher})` : '';
      lines.push(`  ${status} ${hook.name}${matcherStr} [${hook.timeout}ms]`);
    }
    lines.push('');
  }

  // Recent Errors
  if (result.errors.recent.length > 0) {
    lines.push('RECENT ERRORS');
    lines.push('-'.repeat(60));
    for (const error of result.errors.recent) {
      lines.push(`[${error.timestamp}] ${error.message}`);
    }
  } else {
    lines.push('RECENT ERRORS: None');
  }

  return lines.join('\n');
}

// CLI Entry Point
const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const errorsOnly = args.includes('--errors');
const hooksOnly = args.includes('--hooks');

const result = runDiagnostics(args);

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else if (errorsOnly) {
  if (result.errors.recent.length === 0) {
    console.log('No recent errors.');
  } else {
    console.log('Recent Errors:');
    for (const error of result.errors.recent) {
      console.log(`[${error.timestamp}] ${error.message}`);
    }
  }
} else if (hooksOnly) {
  console.log('Hook Inventory:');
  for (const hook of result.hooks.inventory) {
    const status = hook.builtExists ? '[OK]' : '[MISS]';
    console.log(`${status} ${hook.event}/${hook.name}`);
  }
} else {
  console.log(formatDiagnostics(result));
}
