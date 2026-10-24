#!/usr/bin/env node
/**
 * scripts/tri-model/preflight.mjs
 *
 * This gate covers Grok work only: auth, identity pin, version pins,
 * and informational git state. Plain Node >=20, zero dependencies.
 *
 * Requirements: CONTRACT.md R1-R7; design: D1-D4.
 * Usage:
 *   node scripts/tri-model/preflight.mjs
 *   node scripts/tri-model/preflight.mjs --json
 *   node scripts/tri-model/preflight.mjs --project <dir>   (git_state for <dir>; default: the cwd)
 *
 * Env:
 *   PREFLIGHT_PINS_FILE  override path to harness-update.md (tamper tests)
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
// harness-update.md moved from .claude/rules/ to .claude/rules-ondemand/ on 2026-09-24 (context phase 2).
const DEFAULT_PINS_FILE = path.join(
  REPO_ROOT,
  ".claude",
  "rules-ondemand",
  "harness-update.md",
);
const GROK_AUTH_EMAIL_PIN = "dkhayes44@gmail.com";
const EXEC_TIMEOUT_MS = 20_000;
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.OPENAI_API_KEY;
delete CLEAN_ENV.XAI_API_KEY;
const WANT_JSON = process.argv.includes("--json");
// git_state reports the project the caller works in (/game-plan runs from that project), not this
// repo. --project <dir> overrides the working directory.
const PROJECT_ARG = process.argv.indexOf("--project");
const PROJECT_DIR = path.resolve(PROJECT_ARG >= 0 ? process.argv[PROJECT_ARG + 1] : process.cwd());

/** @typedef {{ name: string, ok: boolean, detail: string, informational?: boolean }} Check */

/** Quote one argv token for cmd.exe /c line. */
function quoteCmdArg(s) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(s)) return s;
  return `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * Resolve a PATH command for execFileSync on Windows.
 * Prefer .exe; for .cmd use cmd.exe /c (Node blocks bare .cmd spawn).
 * Never spawn .ps1.
 * @returns {{ mode: "direct", file: string } | { mode: "cmd", cmdline: (args: string[]) => string }}
 */
function resolveCli(cmd) {
  if (process.platform !== "win32") {
    return { mode: "direct", file: cmd };
  }
  try {
    const out = execFileSync("where.exe", [cmd], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const candidates = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const exe = candidates.find((c) => /\.exe$/i.test(c));
    if (exe) return { mode: "direct", file: exe };
    const cmdShim = candidates.find((c) => /\.cmd$/i.test(c));
    const target = cmdShim || cmd;
    return {
      mode: "cmd",
      cmdline: (args) =>
        [quoteCmdArg(target), ...args.map(quoteCmdArg)].join(" "),
    };
  } catch {
    return {
      mode: "cmd",
      cmdline: (args) =>
        [quoteCmdArg(cmd), ...args.map(quoteCmdArg)].join(" "),
    };
  }
}

/**
 * Run a CLI; never throws to caller for missing binary / non-zero / timeout.
 * Captures stdout AND stderr (stderr is part of the captured output).
 * @returns {{ ok: boolean, stdout: string, stderr: string, error: string | null }}
 */
function runCli(cmd, args) {
  const resolved = resolveCli(cmd);
  /** @type {import('node:child_process').SpawnSyncReturns<string>} */
  let r;
  if (resolved.mode === "direct") {
    r = spawnSync(resolved.file, args, {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: CLEAN_ENV,
      shell: false,
    });
  } else {
    // Single string after /c so flags reach the real CLI
    r = spawnSync("cmd.exe", ["/d", "/s", "/c", resolved.cmdline(args)], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: CLEAN_ENV,
      shell: false,
    });
  }

  const stdout = String(r.stdout ?? "");
  const stderr = String(r.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;

  if (r.error) {
    const e = /** @type {NodeJS.ErrnoException} */ (r.error);
    if (e.code === "ETIMEDOUT") {
      return {
        ok: false,
        stdout,
        stderr,
        error: `timeout after ${EXEC_TIMEOUT_MS}ms: ${cmd}`,
      };
    }
    if (e.code === "ENOENT") {
      return {
        ok: false,
        stdout,
        stderr,
        error: `CLI not found: ${cmd}`,
      };
    }
    return {
      ok: false,
      stdout,
      stderr,
      error: e.message || String(e),
    };
  }
  if (
    /is not recognized as an internal or external command/i.test(combined) ||
    /command not found/i.test(combined)
  ) {
    return {
      ok: false,
      stdout,
      stderr,
      error: `CLI not found: ${cmd}`,
    };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      error: `exit ${r.status ?? "unknown"}`,
    };
  }
  return { ok: true, stdout, stderr, error: null };
}

/**
 * Parse verified version pins from harness-update.md Evidence trail table.
 * Rows look like: | Grok | `docs/...` | 0.2.93, 2026-07-11 |
 * @returns {{ pins: Record<string, string> | null, error: string | null }}
 */
function parsePinsTable(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    return {
      pins: null,
      error: `pins file unreadable: ${filePath} (${e.code || e.message})`,
    };
  }

  // Prefer the "## Evidence trail" section; fall back to whole file.
  const evidenceIdx = text.search(/^##\s+Evidence trail\b/im);
  let section = text;
  if (evidenceIdx >= 0) {
    const headingLineEnd = text.indexOf("\n", evidenceIdx);
    const searchStart = headingLineEnd >= 0 ? headingLineEnd + 1 : text.length;
    const nextHeadingMatch = /^##\s+/m.exec(text.slice(searchStart));
    const sectionEnd =
      nextHeadingMatch === null
        ? text.length
        : searchStart + nextHeadingMatch.index;
    section = text.slice(evidenceIdx, sectionEnd);
  }

  /** @type {Record<string, string>} */
  const pins = {};
  // | Grok | ... | 0.2.93, 2026-07-11 |
  for (const line of section.split(/\r?\n/)) {
    const rowMatch = /^\|\s*(Grok)\s*\|/i.exec(line); // Grok is the only harness row
    if (rowMatch === null) continue;
    const harness = rowMatch[1];
    if (harness in pins) continue;
    const versionMatch = /\d+\.\d+\.\d+/.exec(line);
    if (versionMatch !== null) {
      pins[harness] = versionMatch[0];
    }
  }

  if (!pins.Grok) {
    return {
      pins: null,
      error: `pins table missing Grok version row in ${filePath}`,
    };
  }
  return { pins, error: null };
}

/**
 * Extract a semver X.Y.Z from CLI version output.
 * grok 0.2.93 (<hash>) [stable]
 */
function extractSemver(text) {
  const m = String(text).match(/\b(\d+\.\d+\.\d+)\b/);
  return m ? m[1] : null;
}

/**
 * R2 — Grok auth + identity pin.
 * Only ever reads .email from first auth.json entry.
 */
function checkGrokAuthAndIdentity() {
  const r = runCli("grok", ["models"]);
  const combined = `${r.stdout}\n${r.stderr}`;
  if (r.error && r.error.startsWith("CLI not found")) {
    return {
      name: "grok_auth",
      ok: false,
      detail: r.error,
    };
  }
  if (r.error && r.error.startsWith("timeout")) {
    return {
      name: "grok_auth",
      ok: false,
      detail: r.error,
    };
  }
  const loggedIn = /logged in/i.test(combined);
  if (!loggedIn) {
    const failDetail = r.error
      ? `grok models failed: ${r.error}`
      : 'output missing "logged in"';
    return {
      name: "grok_auth",
      ok: false,
      detail: failDetail,
    };
  }

  const authPath = path.join(os.homedir(), ".grok", "auth.json");
  let raw;
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    return {
      name: "grok_identity",
      ok: false,
      detail: `auth file unreadable: ${authPath} (${e.code || e.message})`,
    };
  }

  let email;
  try {
    const data = JSON.parse(raw);
    // First entry: object map -> first value; or array -> [0]
    let entry;
    if (Array.isArray(data)) {
      entry = data[0];
    } else if (data && typeof data === "object") {
      const keys = Object.keys(data);
      if (keys.length === 0) {
        return {
          name: "grok_identity",
          ok: false,
          detail: "auth.json has no entries",
        };
      }
      entry = data[keys[0]];
    } else {
      return {
        name: "grok_identity",
        ok: false,
        detail: "auth.json unparseable shape",
      };
    }
    if (!entry || typeof entry !== "object") {
      return {
        name: "grok_identity",
        ok: false,
        detail: "auth.json first entry is not an object",
      };
    }
    // D4: only .email — never touch .key / .refresh_token
    email = /** @type {{ email?: string }} */ (entry).email;
  } catch (err) {
    return {
      name: "grok_identity",
      ok: false,
      detail: "auth.json is present but not valid JSON",
    };
  }

  if (email !== GROK_AUTH_EMAIL_PIN) {
    return {
      name: "grok_identity",
      ok: false,
      detail: `email pin mismatch: expected ${GROK_AUTH_EMAIL_PIN}, got ${email == null ? "(missing)" : String(email)}`,
    };
  }

  // Combined R2 as one logical pair of checks; both must pass for ready.
  // Return both as separate named checks for clarity in the table.
  return {
    name: "grok_auth",
    ok: true,
    detail: "logged in; identity pin matches",
    _split: true,
    identity: {
      name: "grok_identity",
      ok: true,
      detail: `email=${GROK_AUTH_EMAIL_PIN}`,
    },
  };
}

/**
 * R3 — version pin gate for one harness.
 * @param {"grok"} harness - the only harness this gate checks
 * @param {string | null | undefined} pinned
 * @param {string | null} pinsError
 */
function checkVersionPin(harness, pinned, pinsError) {
  const name = `${harness}_version`;
  if (pinsError) {
    return {
      name,
      ok: false,
      detail: pinsError,
    };
  }
  if (!pinned) {
    return {
      name,
      ok: false,
      detail: `no pin for ${harness}; run /harness-update ${harness}`,
    };
  }

  const r = runCli(harness, ["--version"]);
  const combined = `${r.stdout}\n${r.stderr}`;
  if (r.error && r.error.startsWith("CLI not found")) {
    return { name, ok: false, detail: r.error };
  }
  if (r.error && r.error.startsWith("timeout")) {
    return { name, ok: false, detail: r.error };
  }
  // version often exits 0; if not, still try parse
  const live = extractSemver(combined);
  if (!live) {
    return {
      name,
      ok: false,
      detail: r.error
        ? `${harness} --version failed: ${r.error}`
        : `could not parse version from: ${combined.trim().slice(0, 120)}`,
    };
  }
  if (live !== pinned) {
    return {
      name,
      ok: false,
      detail: `live ${live} != pin ${pinned}; run /harness-update ${harness}`,
    };
  }
  return {
    name,
    ok: true,
    detail: `${live} matches pin`,
  };
}

/** R4 — git state (informational only) */
function checkGitState() {
  let branch = "(unknown)";
  let dirtyCount = 0;
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      cwd: PROJECT_DIR,
    }).trim();
  } catch {
    return {
      name: "git_state",
      ok: true,
      informational: true,
      detail: `project=${path.basename(PROJECT_DIR)} branch=(unavailable, not a git repo?) dirty=(unavailable)`,
    };
  }
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      cwd: PROJECT_DIR,
    });
    dirtyCount = status
      .split(/\r?\n/)
      .filter((line) => line.length > 0).length;
  } catch {
    dirtyCount = -1;
  }
  const dirtyLabel = dirtyCount < 0 ? "unavailable" : String(dirtyCount);
  return {
    name: "git_state",
    ok: true,
    informational: true,
    detail: `project=${path.basename(PROJECT_DIR)} branch=${branch} dirty=${dirtyLabel}`,
  };
}

function main() {
  /** @type {Check[]} */
  const checks = [];
  /** @type {Record<string, string>} */
  const versions = {};

  // Auth + identity as two checks when possible
  const grokResult = checkGrokAuthAndIdentity();
  if (
    /** @type {{ _split?: boolean, identity?: Check }} */ (grokResult)._split
  ) {
    const g = /** @type {Check & { identity: Check }} */ (grokResult);
    checks.push({
      name: g.name,
      ok: g.ok,
      detail: "logged in",
    });
    checks.push(g.identity);
  } else if (grokResult.name === "grok_identity") {
    // auth passed path failed at identity — still need grok_auth OK
    checks.push({
      name: "grok_auth",
      ok: true,
      detail: "logged in",
    });
    checks.push(grokResult);
  } else {
    // auth failed early — still emit identity as FAIL skip/named
    checks.push(grokResult);
    if (grokResult.name === "grok_auth") {
      checks.push({
        name: "grok_identity",
        ok: false,
        detail: "skipped (grok auth failed)",
      });
    }
  }

  // R3 pins
  const pinsFile =
    process.env.PREFLIGHT_PINS_FILE || DEFAULT_PINS_FILE;
  const { pins, error: pinsError } = parsePinsTable(pinsFile);
  if (pins) {
    versions.grok_pin = pins.Grok;
  }

  const grokVer = checkVersionPin("grok", pins?.Grok, pinsError);
  checks.push(grokVer);
  if (grokVer.ok) {
    versions.grok = pins?.Grok || "";
  } else {
    const live = runCli("grok", ["--version"]);
    const v = extractSemver(`${live.stdout}\n${live.stderr}`);
    if (v) versions.grok = v;
  }

  // Always attach live versions when available and not set
  if (!versions.grok) {
    const live = runCli("grok", ["--version"]);
    const v = extractSemver(`${live.stdout}\n${live.stderr}`);
    if (v) versions.grok = v;
  }

  // R4
  checks.push(checkGitState());

  const ready = checks
    .filter((c) => !c.informational)
    .every((c) => c.ok);

  if (WANT_JSON) {
    const payload = {
      ready,
      checks: checks.map((c) => ({
        name: c.name,
        ok: c.ok,
        detail: c.detail,
        ...(c.informational ? { informational: true } : {}),
      })),
      versions,
    };
    // ASCII-only JSON to stdout
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    // Human-readable table (ASCII only)
    process.stdout.write("tri-model preflight\n");
    process.stdout.write("-------------------\n");
    for (const c of checks) {
      const mark = c.informational
        ? "[INFO]"
        : c.ok
          ? "[OK]  "
          : "[FAIL]";
      process.stdout.write(
        `${mark}  ${c.name.padEnd(16)}  ${c.detail}\n`,
      );
    }
    process.stdout.write("-------------------\n");
    process.stdout.write(
      `ready: ${ready ? "true" : "false"}\n`,
    );
    if (versions.grok != null && versions.grok) {
      process.stdout.write(
        `grok version ${versions.grok || "?"}` +
          (versions.grok_pin ? ` (pin grok=${versions.grok_pin})` : "") +
          "\n",
      );
    }
  }

  process.exit(ready ? 0 : 1);
}

try {
  main();
} catch (err) {
  process.stdout.write("[FAIL] preflight crashed: unexpected error\n");
  process.exit(1);
}
