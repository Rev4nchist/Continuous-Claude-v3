#!/usr/bin/env node
/**
 * Package Install Security Guard (PreToolUse: Bash, PowerShell, shell-running MCP tools)
 *
 * Intercepts package install commands and blocks dangerous installs.
 * Protects against supply-chain attacks like:
 * - Typosquatting (requets -> requests)
 * - Known malicious versions (litellm 1.82.7/1.82.8)
 * - Suspiciously new packages (<24h = block, <7d = warn)
 * - Unpinned pip installs (pip, uv pip, python -m pip): every package needs an exact == pin
 *
 * Every executed segment is checked, so `cd x; pip install y` and `Set-Location x; ...` are seen.
 *
 * Output contract: ALWAYS exit 0. A block is the PreToolUse
 * {hookSpecificOutput:{permissionDecision:'deny'}} envelope from shared/output.ts.
 * (Until 2026-09-01 this hook printed its own JSON shape and exited 2, which
 * Claude Code reports as "hook error: No stderr output" and drops the reason.)
 *
 * Override: prefix command with SKIP_PACKAGE_GUARD=1
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import https from 'https';
import http from 'http';
import { outputContinue, outputDeny } from './shared/output.js';
import {
  parseExecutable, executableView, normalizeEscapes, wrapperPayloadsFromSegments, stripQuotedStrings,
} from './shared/destructive-classifier.js';
import { isUnattended } from './shared/unattended.js';
import { checkTyposquat } from './shared/typosquat-detect.js';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';
import { readShellCommand } from './shared/shell-tools.js';
import maliciousPackages from './shared/malicious-packages.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PreToolUseInput {
  session_id: string;
  tool_name: string;
  cwd?: string;
  permission_mode?: string;
  tool_input: {
    command?: string;
    description?: string;
  };
}

interface PackageInfo {
  name: string;
  version: string | undefined;
}

type Ecosystem = 'pypi' | 'npm' | 'cargo' | 'go' | 'gem' | 'composer' | 'nuget' | 'brew' | 'chocolatey' | 'winget' | 'powershell' | null;

interface MaliciousCheckResult {
  blocked: boolean;
  reason?: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Install command patterns
//
// Each entry: regex for the command prefix, ecosystem, and whether pip pins apply.
// Package arguments are the tokens after the matched prefix.
//
// For npm/yarn/pnpm/bun install: bare "install" (no package arg) is NOT
// a targeted install. We require at least one package-looking argument.
// ---------------------------------------------------------------------------

// An optional folder before a launcher: .venv\Scripts\pip.exe, "C:\Program Files\Python312\python.exe".
const DIR = String.raw`(?:&\s*)?(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"']*[\\/])?`;

interface InstallPattern {
  regex: RegExp;
  ecosystem: Exclude<Ecosystem, null>;
  /** pip forms: every package needs an exact == pin. Lockfile tools (uv add, poetry add) do not. */
  requirePin?: boolean;
}

// pip global options before `install` (-q, --disable-pip-version-check, --proxy URL).
// The value is never a word the flag arm also reads, so "--proxy --proxy" parses one way only: no backtracking blow-up.
const PIP_OPTS = String.raw`(?:\s+(?:--(?:proxy|log|cache-dir|timeout|retries|cert|client-cert|exists-action|trusted-host|python|use-feature|keyring-provider)\s+(?!-[-\w]+(?:=\S+)?(?!\S))\S+|-[-\w]+(?:=\S+)?))*`;
// Interpreter flags before `-m` (-I, -u, -X utf8, -W ignore) and the py launcher version (-3.12).
const PY_OPTS = String.raw`(?:\s+(?:-[XW]\s*\S+|-[IuBEsSOqbdv]+|-\d(?:\.\d+)?))*`;
// uv global options before the verb (G1): uv --directory DIR run, uv --project DIR pip install.
// Only the listed options: an unknown one may take a value (uv --preview-features run pip install x), so it asks.
// A value never starts with "-" ((?!-)), so "--directory --directory" parses one way only: no backtracking blow-up.
const UV_OPTS = String.raw`(?:\s+(?:--(?:directory|project|config-file|cache-dir|python|color|python-preference|allow-insecure-host|index-strategy)(?:=|\s+(?!-))\S+|(?:-[qv]+|-n|--(?:quiet|verbose|offline|no-cache|no-progress|no-config|native-tls))(?=\s|$)))*`;
// A variable as the interpreter (G3): $PYTHON, ${PY}, $env:PYTHON, "$PYTHON". A path that holds a variable ("$VENV/bin/python") is a DIR.
// ${PY:-python3} and other parameter expansions are one braced word too.
const PY_VAR = String.raw`["']?\$(?:\{[^}\s]+\}|(?:env:)?\w+)`;

/**
 * How the tokens after the verb are read.
 * - list: every non-flag token is a package (npm install a b, pip install a b).
 * - first: only the first non-flag token is a package; the rest is that tool's own argv (npx, uvx).
 * - lockfile: no package is named; the lockfile decides what installs (npm ci).
 * - create: as first, but the package that runs is create-<word> (npm init x, yarn create x).
 * - run: no positional is a package; only package flags name one (uv run --with x cmd).
 */
type InstallKind = 'list' | 'first' | 'lockfile' | 'create' | 'run';

/** Which flag table reads the arguments (F11: -f and -r mean different things per manager). */
type FlagDialect = 'pip' | 'node' | 'pyrunner' | 'other';

interface InstallPattern {
  /** Matches at the start of a segment, after leaders and VAR=value prefixes are stripped. */
  regex: RegExp;
  /** The same pattern found at any word start. A hit here with no `regex` hit is an install the guard cannot parse. */
  loose: RegExp;
  ecosystem: Exclude<Ecosystem, null>;
  /** pip forms: every package needs an exact == pin. Lockfile tools (uv add, poetry add) do not. */
  requirePin?: boolean;
  kind: InstallKind;
  flags: FlagDialect;
  /** go run: only a module@version token is remote; main.go and . are local files. */
  remoteOnly?: boolean;
  /** npx, npm exec, bunx: a bare name with a node_modules/.bin file runs that file and fetches nothing. */
  preferLocal?: boolean;
}

function installPattern(
  body: string,
  ecosystem: Exclude<Ecosystem, null>,
  opts: { requirePin?: boolean; kind?: InstallKind; flags?: FlagDialect; ignoreCase?: boolean; remoteOnly?: boolean; preferLocal?: boolean } = {},
): InstallPattern {
  const f = opts.ignoreCase ? 'i' : '';
  return {
    regex: new RegExp(`^${body}`, f),
    loose: new RegExp(String.raw`(?:^|[\s;&|({])${body}`, f),
    ecosystem,
    requirePin: opts.requirePin,
    kind: opts.kind ?? 'list',
    flags: opts.flags ?? 'other',
    remoteOnly: opts.remoteOnly,
    preferLocal: opts.preferLocal,
  };
}

// The verb ends at whitespace or the end of the text (\b would let `install` match `install-clean`).
const END = String.raw`(?=\s|$)`;
// A Node launcher, with an optional folder and Windows suffix: npm, C:\nodejs\npm.cmd, pnpm.ps1.
const bin = (name: string) => String.raw`${DIR}${name}(?:\.cmd|\.exe|\.ps1)?["']?`;
// Node global options before the verb (F10): npm --prefix DIR install, npm -g install, yarn --cwd DIR add.
// A value never starts with "-" (the -\S+ arm reads it), so "--prefix --prefix" parses one way only.
const NODE_OPTS = String.raw`(?:\s+(?:--(?:prefix|registry|cache|userconfig|globalconfig|loglevel|workspace|cwd|dir|filter|modules-folder)\s+(?!-)\S+|-C\s+(?!-)\S+|-\S+))*`;
// npm's own aliases (npm help install / ci / exec).
const NPM_INSTALL = '(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|install-test|it)';
const NPM_CI = '(?:ci|clean-install|ic|install-clean|isntall-clean|install-ci-test|cit|clean-install-test|sit)';
// Verbs that fetch a newer version of a named package (F13 repair).
const NPM_UPDATE = '(?:update|up|upgrade|udpate)';
// pip verbs that fetch and build packages; an sdist build runs its setup.py (F13 repair).
const PIP_VERBS = '(?:install|download|wheel)';

const INSTALL_PATTERNS: InstallPattern[] = [
  // Python (Windows runs Python.exe and PIP the same as python and pip, so these ignore case)
  installPattern(String.raw`${DIR}pip(?:3(?:\.\d+)?)?(?:\.exe)?["']?${PIP_OPTS}\s+${PIP_VERBS}${END}`, 'pypi', { requirePin: true, flags: 'pip', ignoreCase: true }),
  // -m and its module may be one word: python -mpip install x.
  installPattern(String.raw`${DIR}(?:python(?:3(?:\.\d+)?)?|py|${PY_VAR})(?:\.exe)?["']?${PY_OPTS}\s+-m\s*pip${PIP_OPTS}\s+${PIP_VERBS}${END}`, 'pypi', { requirePin: true, flags: 'pip', ignoreCase: true }),
  installPattern(String.raw`uv${UV_OPTS}\s+pip\s+install${END}`, 'pypi', { requirePin: true, flags: 'pip' }),
  installPattern(String.raw`uv${UV_OPTS}\s+add${END}`, 'pypi', { flags: 'pip' }),
  installPattern(String.raw`poetry\s+add${END}`, 'pypi', { flags: 'pip' }),
  installPattern(String.raw`pipenv\s+install${END}`, 'pypi', { flags: 'pip' }),
  // Python runners and tool installs (F13): the first token is the package, the rest is its argv.
  installPattern(String.raw`(?:uvx|uv${UV_OPTS}\s+tool\s+(?:run|install)|pipx\s+(?:run|install))${END}`, 'pypi', { kind: 'first', flags: 'pyrunner' }),
  installPattern(String.raw`uv${UV_OPTS}\s+run${END}`, 'pypi', { kind: 'run', flags: 'pyrunner' }),

  // JavaScript / Node
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+${NPM_INSTALL}${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+${NPM_UPDATE}${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+${NPM_CI}${END}`, 'npm', { kind: 'lockfile', flags: 'node' }),
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+(?:exec|x)${END}`, 'npm', { kind: 'first', flags: 'node', preferLocal: true }),
  installPattern(String.raw`(?:${bin('npm')}${NODE_OPTS}\s+(?:create|init|innit)|${bin('(?:yarn|pnpm|bun)')}${NODE_OPTS}\s+create)${END}`, 'npm', { kind: 'create', flags: 'node' }),
  installPattern(String.raw`${bin('yarn')}${NODE_OPTS}\s+(?:global\s+)?(?:add|up|upgrade)${END}`, 'npm', { flags: 'node' }),
  // A bare `yarn` / `yarn install` names no package. needsCheck counts it only when the command sets a registry (G2).
  // Its loose form never matches: `which yarn` and `echo yarn install` are not installs.
  { ...installPattern(String.raw`${bin('yarn')}${NODE_OPTS}(?:\s+install${END}|\s*$)`, 'npm', { flags: 'node' }), loose: /(?!)/ },
  installPattern(String.raw`${bin('pnpm')}${NODE_OPTS}\s+(?:add|install|i|update|up|upgrade)${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`${bin('bun')}${NODE_OPTS}\s+(?:add|a|install|i|update)${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`(?:${bin('npx')}|${bin('bunx')}|${bin('bun')}${NODE_OPTS}\s+x)${END}`, 'npm', { kind: 'first', flags: 'node', preferLocal: true }),
  // pnpx is pnpm dlx. These always fetch, even when a local bin of that name exists.
  installPattern(String.raw`(?:${bin('pnpx')}|${bin('yarn')}${NODE_OPTS}\s+dlx|${bin('pnpm')}${NODE_OPTS}\s+dlx)${END}`, 'npm', { kind: 'first', flags: 'node' }),
  // deno names its sources npm:x, jsr:x or a URL; the classifier asks on each of them.
  installPattern(String.raw`${bin('deno')}\s+(?:install|i|add)${END}`, 'npm', { flags: 'node' }),

  // Rust, Go, Ruby, PHP: matched so the guard can ask. It has no blocklist or age check for them.
  installPattern(String.raw`cargo\s+(?:add|install|binstall)${END}`, 'cargo'),
  // NuGet and Homebrew (G4): same policy as cargo, the guard has no blocklist, OSV or age check for them.
  // Up to 8 option words may come first (dotnet -d add package X), and up to 8 project words after add.
  // Both loops are bounded, so the loose scan stays linear: 1500 "dotnet add" words must not stall the hook.
  installPattern(String.raw`${bin('dotnet')}(?:\s+\S+){0,8}?\s+(?:add(?:\s+\S+){0,8}?\s+package|package\s+add|tool\s+(?:install|update|exec|run)|dnx)${END}`, 'nuget'),
  installPattern(String.raw`${bin('dnx')}${END}`, 'nuget', { kind: 'first' }),
  installPattern(String.raw`brew\s+(?:install|reinstall|upgrade)${END}`, 'brew'),
  installPattern(String.raw`go\s+(?:get|install)${END}`, 'go'),
  installPattern(String.raw`go\s+run${END}`, 'go', { remoteOnly: true }),
  installPattern(String.raw`gem\s+install${END}`, 'gem'),
  installPattern(String.raw`composer\s+require${END}`, 'composer'),
];

/** An exact pip pin: name==1.2.3 or name===1.2.3, extras allowed, no wildcard or second clause. */
const EXACT_PIN = /^[A-Za-z0-9_.-]+(?:\[[^\]]*\])?===?[^=<>~!*,;\s]+$/;

/**
 * Per-dialect flag tables (F11). A flag in no table is standalone: it takes no value, so the next
 * token is read as a package. That is the fail-closed direction: an unknown flag costs a check.
 * - value: the next token (or the text after `=`) is a value, not a package.
 * - pkg: the value IS a package (npx -p X, uvx --from X).
 * - source: the value is a file or folder; a remote one (URL, VCS) asks.
 * - index: a custom package index; the checks read the public registry, so it asks.
 * - extra: the value is one more package, and the first positional is still a package (uvx --with X tool).
 * - bare: a known flag that takes no value. A runner (npx, uvx) asks on a flag in no table, because
 *   that flag may take the next word as its value and the package would go unchecked.
 */
interface FlagTable { value: Set<string>; pkg: Set<string>; source: Set<string>; index: Set<string>; extra: Set<string>; bare: Set<string> }

const PIP_VALUE = [
  // uv global options (uvx --directory DIR tool, uvx --color never tool)
  '--directory', '--project', '--color', '--python-preference', '--allow-insecure-host',
  '-t', '--target', '--prefix', '--root', '--src',
  // pip and uv pip (a value here is not a package; the pin check would deny it)
  '--trusted-host', '--python', '-p', '--python-version', '--platform', '--abi', '--implementation',
  '--timeout', '--retries', '--proxy', '--cert', '--client-cert', '--cache-dir', '--log',
  '--upgrade-strategy', '--progress-bar', '--exists-action', '--report', '-C', '--config-settings',
  '--index-strategy', '--resolution', '--prerelease', '--keyring-provider', '--root-user-action',
];
const PIP_SOURCE = ['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '--with-requirements', '--with-editable'];
// A config file can set the index, so it asks the same as an index flag.
const PIP_INDEX = ['-i', '--index-url', '--extra-index-url', '--index', '--default-index', '-f', '--find-links', '--source', '--config-file'];
// '--' ends the runner's own options; the word after it is the package.
const PY_BARE = [
  '--',
  '-q', '--quiet', '-v', '--verbose', '-n', '--no-cache', '--offline', '--isolated', '--refresh', '-U', '--upgrade',
  '--force', '--native-tls', '--no-config', '--no-progress', '--preview', '-e', '--editable', '--include-deps',
];

const none = () => new Set<string>();
const FLAG_TABLES: Record<FlagDialect, FlagTable> = {
  pip: { value: new Set(PIP_VALUE), pkg: none(), source: new Set(PIP_SOURCE), index: new Set(PIP_INDEX), extra: none(), bare: none() },
  // Only --from and --spec name the package that runs; --with adds one more (F11/F13 repair).
  pyrunner: {
    value: new Set(PIP_VALUE), pkg: new Set(['--from', '--spec']), source: new Set(PIP_SOURCE.filter((f) => f !== '-e' && f !== '--editable')),
    index: new Set(PIP_INDEX), extra: new Set(['--with', '-w']), bare: new Set(PY_BARE),
  },
  node: {
    value: new Set([
      '--prefix', '--cache', '--tag', '--workspace', '-w', '--filter',
      '--dir', '--cwd', '--loglevel', '--omit', '--include', '--save-prefix', '--modules-folder',
      '--network-concurrency', '-C', '--call', '-c', '--node-options', '--shell', '--script-shell',
    ]),
    pkg: new Set(['-p', '--package']),
    source: none(),
    // A user or global config file can set the registry (F11 repair).
    index: new Set(['--registry', '--userconfig', '--globalconfig']),
    extra: none(),
    bare: new Set([
      '--', '-y', '--yes', '--no', '-q', '--quiet', '-s', '--silent', '--ignore-existing', '--no-install',
      '--prefer-offline', '--prefer-online', '--offline', '-g', '--global', '-D', '--dev', '-E', '--exact',
    ]),
  },
  other: { value: none(), pkg: none(), source: none(), index: none(), extra: none(), bare: none() },
};

// ---------------------------------------------------------------------------
// Exported detection functions
// ---------------------------------------------------------------------------

/**
 * Determine if a command is a package install command with named packages.
 * Returns false for bare installs (npm install, yarn install) and
 * requirements-file installs (pip install -r requirements.txt).
 */
export function isPackageInstallCommand(command: string): boolean {
  return extractPackageNames(command).length > 0;
}

/**
 * Identify the package ecosystem from a command string.
 */
export function parseEcosystem(command: string): Ecosystem {
  return matchInstall(command)?.pattern.ecosystem ?? null;
}

/**
 * Extract package names (and optional versions) from an install command.
 */
export function extractPackageNames(command: string): PackageInfo[] {
  return analyzeInstall(command)?.packages ?? [];
}

/**
 * The pip packages in an install command that lack an exact == pin. Empty for every other
 * installer: uv add and poetry add write a lockfile, npm is out of scope.
 */
export function unpinnedPipPackages(command: string): string[] {
  const install = analyzeInstall(command);
  if (!install?.pattern.requirePin) return [];
  return install.named
    .filter(({ raw }) => !EXACT_PIN.test(pipSpec(raw)))
    .map(({ pkg }) => pkg.name);
}

/** A pip requirement without its PEP 508 marker and spaces: "requests >= 2; python_version>'3'" -> requests>=2. */
function pipSpec(token: string): string {
  return token.split(';')[0].replace(/\s+/g, '');
}

// What runs a command without being it (F10). Each leader takes its own flags and values.
// A flag value never starts with "-" ((?!-)), so "-s -s" parses one way only: no exponential backtracking.
const LEADER = new RegExp(String.raw`^(?:(?:${[
  String.raw`sudo(?:\s+(?:-[ugCDhpRrTt]\s+(?!-)\S+|-\S+))*`,
  String.raw`doas(?:\s+-u\s+\S+)?`,
  String.raw`env(?:\s+(?:-[uCS]\s+(?!-)\S+|-\S+))*`,
  String.raw`timeout(?:\s+(?:-[sk]\s+(?!-)\S+|-\S+))*\s+\d+(?:\.\d+)?[smhd]?`,
  String.raw`nice(?:\s+-n\s+-?\d+|\s+-\d+)?`,
  String.raw`exec(?:\s+-a\s+\S+|\s+-[cl]+)*`,
  'time', 'nohup', 'command', 'builtin',
].join('|')})\s+|[{(]\s*)+`);

/** Drop what runs a command without being it: sudo, env, timeout, exec, time, nohup, a brace or parenthesis. */
function stripLeaders(segment: string): string {
  return segment.trim().replace(LEADER, '').replace(/\s*[})]\s*$/, '');
}

/** Strip leaders and VAR=value prefixes in any order: FOO=1 sudo env BAR=2 timeout 60 npm install x. */
function stripPrefixes(command: string): string {
  let s = command.trim();
  for (let prev = ''; s !== prev;) {
    prev = s;
    s = stripLeaders(stripEnvPrefix(s)).trim();
  }
  return s;
}

/** One install segment to check, and the folder it runs in (null: the guard cannot tell). */
export interface InstallPlan { segment: string; cwd: string | null; tool: string }

/**
 * The executed segments of a Bash or PowerShell command that the guard must check. Text blocks that
 * only write text (a literal heredoc, a PowerShell here-string) are dropped and escapes resolved
 * first, as the destructive guard does. Also splits $(...) and shell-wrapper payloads
 * (bash -c "...", powershell -Command "..."). Fails open to the whole command on a parser error.
 */
export function installSegments(command: string, tool = 'Bash', depth = 0): string[] {
  return installPlans(command, tool, null, depth).map((p) => p.segment);
}

// A pure file-descriptor redirection, one whole word: N>&M, >&N, N>&- (dup or close), or a redirect
// to /dev/null ($null in PowerShell). The fd is digits, `*` (PowerShell all streams) or, for `&>`, the `&`.
// No other target is removed: `2>err.log`, `2>$FD`, `2>&$FD` and `> out.txt` stay and still ask.
// `&>` reaches this strip only for `/dev/null`. parseExecutable keeps `&>file` in one segment, so
// `&>log` stays as typed and the words after its target stay with the command.
const FD_REDIRECT_BASH = /(?:(?:\d+)?>>?&(?:\d+|-)|(?:\d+|&)?>>?[ \t]*\/dev\/null)(?=[\s;|&)]|$)/y;
const FD_REDIRECT_PWSH = /(?:(?:\d+|\*)?>>?&(?:\d+|-)|(?:\d+|\*)?>>?[ \t]*(?:\/dev\/null|\$null))(?=[\s;|&)]|$)/y;

/**
 * Remove pure fd redirections from the executable view before it is split into segments, so the `&`
 * of `2>&1` does not cut the word and leave `2>` as an install source. Raw-text and fail closed:
 * a token goes only when it starts a word (after start or whitespace), is outside quotes, and is not
 * escaped. The escape is `\` in Bash and a backtick in PowerShell. An open quote keeps the rest of the
 * text. Everything else stays as typed.
 */
export function stripFdRedirects(text: string, tool = 'Bash'): string {
  const ps = tool === 'PowerShell';
  const re = ps ? FD_REDIRECT_PWSH : FD_REDIRECT_BASH;
  const esc = ps ? '`' : '\\';
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === esc && quote !== "'") { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (quote) { if (c === quote) quote = null; out += c; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (i === 0 || /\s/.test(text[i - 1])) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m) { i += m[0].length - 1; continue; }
    }
    // `npm ci&>/dev/null` or `bash -c&>/dev/null "..."`: the `&>` is glued to a word. Drop the redirect, keep a blank.
    if (!ps && c === '&' && text[i + 1] === '>' && i > 0 && !/[\s&|]/.test(text[i - 1])) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m) { out += ' '; i += m[0].length - 1; continue; }
    }
    out += c;
  }
  return out;
}

/**
 * installSegments, with the folder every segment runs in (`cwd`, from localBinCwd; null: not known).
 * When the whole command sets a registry or index (npm config set registry, export npm_config_registry=),
 * a bare install is a segment too: it installs from that registry (G2).
 */
export function installPlans(command: string, tool = 'Bash', cwd: string | null = null, depth = 0, configured?: boolean): InstallPlan[] {
  const config = configured ?? (indexConfigMarkers(command).length > 0 || persistentConfigMarkers(command, tool).length > 0 || rawConfigMarkers(command).length > 0);
  try {
    const { segments, substitutions } = parseExecutable(normalizeEscapes(stripFdRedirects(executableView(command, tool), tool), tool));
    const found = segments.map(stripLeaders).filter((s) => needsCheck(s, tool, config)).map((segment) => ({ segment, cwd, tool }));
    if (depth >= 3) return found;
    const nested = [...substitutions, ...wrapperPayloadsFromSegments(segments)];
    return [...found, ...nested.flatMap((text) => installPlans(text, tool, cwd, depth + 1, config))];
  } catch {
    return needsCheck(command, tool, config) ? [{ segment: command.trim(), cwd: null, tool }] : [];
  }
}

// The guard follows no cd (round 4: two verify rounds found a cd-follow bypass each, e.g. PowerShell Set-Location @zz splats).
// Text that may move the folder, read raw and with quotes and escapes removed (c''d, c\d, "cd"), makes the folder unknown.
const MAY_MOVE_WORD = /\b(?:cd|pushd|popd|chdir|sl|set-location|push-location|pop-location|source|eval|iex|invoke-expression)\b|(?:^|\s)\.\s|(?:^|\s)-(?:wd|wo\w*)(?=[\s:=]|$)/i;
// pwsh -WorkingDirectory / -wd (any case, any prefix from -wo) is in MAY_MOVE_WORD.
// A folder option (env -C, git -C, sudo -D, npm --prefix, yarn --cwd, pnpm --dir), npm's prefix setting, or an expansion ($X, ${X}, `x`).
// Case-sensitive: bash -c and npx -c take a command, not a folder.
const MAY_MOVE_OTHER = /(?:^|\s)(?:-[CD]|--chdir|--prefix|--cwd|--dir|--directory)(?=[\s=]|$)|(?:^|\s)-[CD]\S|[$`]/;

function mayMoveFolder(text: string): boolean {
  // A line continuation (backslash, newline) joins words: c\<LF>d runs cd.
  const plain = text.replace(/\\\r?\n/g, '').replace(/[\\'"`^]/g, '');
  return MAY_MOVE_WORD.test(text) || MAY_MOVE_WORD.test(plain) || MAY_MOVE_OTHER.test(text) || /npm_config_prefix/i.test(text);
}

// npm global mode looks in the global .bin, not node_modules/.bin, so the local bin does not count.
const GLOBAL_MODE = /(?:^|\s)(?:-g|--global|--location[=\s]+global)(?=\s|$)|npm_config_global|npm_config_location/i;

// PowerShell can move the folder with no cd word: a script, function or alias run by name, a call operator, a command lookup, a wildcard command word.
// A script (.ps1, .psm1, .bat, .cmd) that ends a statement. Its name may be a path, quoted.
const PS_SCRIPT_END = /\.(?:ps1|psm1|bat|cmd)["']?\s*(?:[;|&)\r\n]|$)/i;
// A command word that is a path to a script, with arguments: C:\tools\go.ps1 -Verbose.
const PS_SCRIPT_PATH = /^["']?[^\s"']*[\\/][^\s"']*\.(?:ps1|psm1|bat|cmd)["']?$/i;
// Command lookup and indirect run: & (gcm Set-Loc*) X, icm { ... }, Invoke-Item go.ps1.
const PS_LOOKUP = /\b(?:gcm|get-command|icm|invoke-command|invoke-item)\b/i;
// The call operator `&` before a group, a variable or a quoted name. Bash `&` is a background job, so only PowerShell reads this.
const PS_CALL_OP = /&\s*[($"']/;

function psMayMoveFolder(text: string): boolean {
  const plain = text.replace(/[`'"]/g, '');
  if (PS_SCRIPT_END.test(text) || PS_SCRIPT_END.test(plain) || PS_LOOKUP.test(text) || PS_LOOKUP.test(plain) || PS_CALL_OP.test(text)) return true;
  // The command word of each statement: a wildcard in it (Set-Loc*, S?t-Location) names a command at run time.
  return text.split(/[;|&\r\n(){}]/).some((piece) => {
    const first = piece.trim().split(/\s+/)[0] ?? '';
    return /[*?]/.test(first) || PS_SCRIPT_PATH.test(first);
  });
}

/**
 * The folder the local-bin skip and the lockfile read may trust: the payload cwd, or null (every check runs)
 * when the text may move it. `tool` is the dialect the text is read in: PowerShell has extra rules (psMayMoveFolder).
 */
function localBinCwd(command: string, cwd: string | null, tool = 'Bash'): string | null {
  if (cwd === null || mayMoveFolder(command) || GLOBAL_MODE.test(command)) return null;
  return tool === 'PowerShell' && psMayMoveFolder(command) ? null : cwd;
}

/**
 * A segment needs a check when it names a package, a source or index the checks cannot read, or
 * is a lockfile install. A bare install (npm install, pip install -r file) does not, unless the
 * command sets a registry or index (`configured`): then it installs from that registry.
 * A segment no pattern parses, but that holds an install outside quotes, also needs one:
 * an unknown leader (nice -n 5, xargs, a full path) must not hide the install (F10).
 */
function needsCheck(segment: string, tool: string, configured = false): boolean {
  const a = analyzeInstall(segment);
  if (!a) return hiddenInstall(segment, tool);
  return configured || a.packages.length > 0 || a.unparsed.length > 0 || a.customIndex.length > 0 || a.ambiguous.length > 0 || a.pattern.kind === 'lockfile';
}

// Manager words and the verbs that install with them. A runner (npx, uvx) installs with any word after it.
// Used only on segments no INSTALL_PATTERNS entry parses, so an unknown option before the verb
// (npm -w ws install x, npm --tag beta install x) still asks.
const ANY_WORD = /./;
const word = (alts: string) => new RegExp(`^${alts}$`);
const MANAGER_VERBS: [RegExp, RegExp][] = [
  [/^npm$/, new RegExp(`^(?:${NPM_INSTALL.slice(3, -1)}|${NPM_CI.slice(3, -1)}|${NPM_UPDATE.slice(3, -1)}|exec|x|create|init|innit)$`)],
  [/^pnpm$/, /^(?:add|install|i|dlx|create|update|up|upgrade)$/],
  [/^yarn$/, /^(?:add|dlx|create|up|upgrade)$/],
  [/^bun$/, /^(?:add|a|install|i|x|create|update)$/],
  [/^(?:pip\d*(?:\.\d+)?|pipx|pipenv)$/, word(PIP_VERBS)],
  // uv with an option the patterns do not know (uv --foo X run --with y) still asks. managerVerbs takes the first entry, so uv has one.
  [/^uv$/, /^(?:install|download|wheel|add|run|tool)$/],
  [/^poetry$/, /^add$/],
  [/^cargo$/, /^(?:add|install|binstall)$/],
  [/^brew$/, /^(?:install|reinstall|upgrade)$/],
  [/^go$/, /^(?:get|install)$/],
  [/^gem$/, /^install$/],
  [/^composer$/, /^require$/],
  [/^deno$/, /^(?:install|i|add)$/],
  [/^(?:npx|pnpx|bunx|uvx)$/, ANY_WORD],
];

/** The command name of a word: C:\nodejs\npm.cmd -> npm, .venv/bin/pip3 -> pip3. */
function commandName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:cmd|exe|ps1)$/, '');
}

/** The MANAGER_VERBS entry a word names. A backslash inside the word (pi\p, np\m) is dropped first. */
function managerVerbs(word: string): RegExp | undefined {
  const names = [commandName(word), commandName(word.replace(/\\/g, ''))];
  return MANAGER_VERBS.find(([manager]) => names.some((n) => manager.test(n)))?.[1];
}

/** A verb word, or one that hides its text: a backslash (i\nstall), a $variable or a substitution. */
function verbOrHidden(word: string, verbs: RegExp): boolean {
  return /^[$`]/.test(word) || verbs.test(word) || verbs.test(word.replace(/\\/g, ''));
}

// Every install verb of every manager: a $PM command word followed by one of them asks.
const ANY_VERB = new RegExp(`^(?:${MANAGER_VERBS.filter(([, v]) => v !== ANY_WORD).map(([, v]) => v.source.replace(/^\^|\$$/g, '')).join('|')})$`);

// A PowerShell launcher whose arguments name the command to start.
const START_PROCESS = /^(?:start-process|saps|start)$/i;

// Subcommands that run a script or a local file. Test the verbs first: npm exec is an install form.
const NOT_INSTALL = /^(?:test|t|tst|run|run-script|start|stop|restart|build|exec)$/;

/**
 * Some word names a manager, and an install verb follows it. A subcommand ends the scan: a word
 * that is not a flag and does not follow a flag (npm -w test install x: test is the -w value).
 * A NOT_INSTALL subcommand is not an install (npm test -- -t install). A bare -- after a
 * subcommand passes the rest to it (pnpm foo -- add). A -- before any subcommand only ends the
 * options, so npm -w ws -- install x still installs.
 */
function anyManagerInstall(words: string[]): boolean {
  return words.some((w, i) => {
    const verbs = managerVerbs(w);
    if (verbs === undefined) return false;
    let subcommandSeen = false;
    for (let j = i + 1; j < words.length; j++) {
      const v = words[j];
      if (verbs.test(v)) return true;
      if (v === '--' && subcommandSeen) return false;
      if (v.startsWith('-') || words[j - 1].startsWith('-')) continue;
      if (NOT_INSTALL.test(v)) return false;
      subcommandSeen = true;
    }
    return false;
  });
}

function hiddenInstall(segment: string, tool: string): boolean {
  // $(...) and `...` bodies are checked as their own segments (installSegments recurses into them).
  const scan = stripQuotedStrings(segment, tool).replace(/\$\([^)]*\)?|`[^`]*`?/g, '');
  if (INSTALL_PATTERNS.some((p) => p.loose.test(scan))) return true;
  if (anyManagerInstall(tokenize(scan))) return true;
  return commandWordInstall(segment) || ecosystemInstall(segment) !== null;
}

// ---------------------------------------------------------------------------
// Ecosystems with no registry check: Chocolatey, winget, NuGet and dotnet, brew bundle, the PowerShell
// Gallery cmdlets, cargo-binstall. The guard reads only the npm and PyPI registries, so an install from
// one of these always asks (fail closed): it cannot say what the install fetches.
// Read from the raw words of a segment, no shell lexer: the same disguises as the other managers
// (path, .exe suffix, quotes or a backslash inside the name, a call operator, sudo and env prefixes).
// ---------------------------------------------------------------------------

type EcoName = Exclude<Ecosystem, null>;

interface EcoRule {
  ecosystem: EcoName;
  /** The command name: lower case, no folder, no .exe/.cmd/.ps1. */
  names: RegExp;
  /** true: the name counts only as the command word (or after a launcher), because the name is a common word or a cmdlet. */
  commandOnly: boolean;
  /** The words after the command name. */
  installs: (rest: string[]) => boolean;
}

// A word that may start a flag: -y, --source, /p:Prop (msbuild), /? (winget).
const isFlagWord = (w: string) => /^[-/]/.test(w);
// The first non-flag words, lower case, with a backslash inside removed (in\stall).
function positionals(rest: string[], max: number): string[] {
  const out: string[] = [];
  for (const w of rest) {
    if (out.length >= max) break;
    if (!isFlagWord(w)) out.push(w.replace(/\\/g, '').toLowerCase());
  }
  return out;
}

/**
 * Some positional (the first 4) is an install verb, or hides its text ($VERB). A read-only verb before it
 * ends the scan: `choco list install` and `winget search install` look for a package named "install".
 */
function installVerbFirst(rest: string[], verbs: RegExp, readOnly: RegExp): boolean {
  for (const w of positionals(rest, 4)) {
    if (/^[$`]/.test(w) || verbs.test(w)) return true;
    if (readOnly.test(w)) return false;
  }
  return false;
}

const CHOCO_VERBS = /^(?:install|upgrade|update|download|sync|synchronize)$/;
const CHOCO_READ_ONLY = /^(?:list|ls|search|find|info|help|outdated|config|source|feature|pin|apikey|setapikey|new|pack|push|uninstall|export|license|template|templates)$/;
const WINGET_VERBS = /^(?:install|add|upgrade|update|import|download|configure|repair)$/;
const WINGET_READ_ONLY = /^(?:list|ls|search|find|show|view|source|settings|setting|hash|validate|export|features|complete|uninstall|remove|rm|pin|test)$/;
const NUGET_VERBS = /^(?:install|update)$/;
const NUGET_READ_ONLY = /^(?:locals|sources|source|config|help|list|pack|push|delete|setapikey|spec|verify|sign|trusted-signers|client-certs|init|add)$/;
// nuget.exe restore, install: -Source and -ConfigFile name another feed.
const NUGET_SOURCE_FLAG = /^-(?:source|configfile|fallbacksource)(?:[=:].*)?$/i;
// dotnet restore, build, publish, pack: --source, -s, --add-source, --configfile (also -s:URL, --source=URL), and the msbuild properties.
const DOTNET_SOURCE_FLAG = /^(?:--source|-s|--add-source|--configfile|--config-file)(?:[=:].*)?$/i;
const DOTNET_SOURCE_PROP = /restoresources|restoreadditionalprojectsources|restoreconfigfile/i;
const DOTNET_RESTORING = /^(?:restore|build|publish|pack)$/;
// brew bundle sub-commands that install nothing. A bare `brew bundle`, `install`, `add` and a --file option install.
const BREW_BUNDLE_READ_ONLY = /^(?:check|list|dump|cleanup|exec|env|sh|edit|remove)$/;

/** A positional `a` directly followed by a positional that matches `next`: dotnet new install. */
function pair(pos: string[], a: string, next: RegExp): boolean {
  return pos.some((w, i) => w === a && next.test(pos[i + 1] ?? ''));
}

function dotnetInstall(rest: string[]): boolean {
  const pos = positionals(rest, 8);
  const add = pos.indexOf('add');
  return pair(pos, 'new', /^(?:install|update)$/)
    || (pos.includes('new') && rest.some((w) => /^(?:--install|-i)(?:[=:].*)?$/i.test(w)))
    || pair(pos, 'workload', /^(?:install|update|restore)$/)
    || pair(pos, 'tool', /^(?:install|update|exec|run)$/)
    || pair(pos, 'package', /^add$/)
    || (add >= 0 && pos.indexOf('package', add + 1) >= 0)
    || (pos.some((w) => DOTNET_RESTORING.test(w)) && rest.some((w) => DOTNET_SOURCE_FLAG.test(w)))
    // test, run and msbuild restore too, and a RestoreSources property needs no verb gate (-s on test is a settings flag).
    || rest.some((w) => DOTNET_SOURCE_PROP.test(w));
}

const ECO_RULES: EcoRule[] = [
  { ecosystem: 'cargo', names: /^cargo-binstall$/, commandOnly: false, installs: () => true },
  { ecosystem: 'chocolatey', names: /^choco$/, commandOnly: false, installs: (r) => installVerbFirst(r, CHOCO_VERBS, CHOCO_READ_ONLY) },
  { ecosystem: 'chocolatey', names: /^cinst$/, commandOnly: false, installs: () => true },
  // cup is a common English word: it counts only as a command.
  { ecosystem: 'chocolatey', names: /^cup$/, commandOnly: true, installs: () => true },
  { ecosystem: 'winget', names: /^winget$/, commandOnly: false, installs: (r) => installVerbFirst(r, WINGET_VERBS, WINGET_READ_ONLY) },
  {
    ecosystem: 'nuget',
    names: /^nuget$/,
    commandOnly: false,
    installs: (r) => installVerbFirst(r, NUGET_VERBS, NUGET_READ_ONLY)
      || (positionals(r, 4).includes('restore') && r.some((w) => NUGET_SOURCE_FLAG.test(w))),
  },
  { ecosystem: 'nuget', names: /^dotnet$/, commandOnly: false, installs: dotnetInstall },
  { ecosystem: 'brew', names: /^brew$/, commandOnly: false, installs: (r) => { const [a, b] = positionals(r, 2); return a === 'bundle' && !BREW_BUNDLE_READ_ONLY.test(b ?? ''); } },
  // The cmdlets install, save or update a module, script or package. A block body counts ({ Install-Module x }).
  { ecosystem: 'winget', names: /^(?:install|update)-wingetpackage$/, commandOnly: false, installs: () => true },
  { ecosystem: 'powershell', names: /^(?:install-(?:module|script|package|psresource|packageprovider)|save-(?:module|script|package|psresource)|update-(?:module|script|psresource))$/, commandOnly: false, installs: () => true },
];

// A word after which the next word is a command: xargs, cmd /c, start, a block opener ({ ( &), then, do, else.
const LAUNCHER = /^(?:xargs|call|start|\/[ck]|cmd|cmd\.exe|[{(&]|then|do|else|elif|if|while|until|!)$/i;
// A word that looks a name up or prints it: `which choco`, `Get-Help Install-Module`, `echo cinst`. The next word is text, not a command.
const LOOKUP = /^(?:which|where|where\.exe|type|whereis|man|help|get-help|get-command|gcm|get-alias|echo|write-host|write-output|printf)$/i;

/**
 * The ecosystem a segment installs from, or null. Any word of the segment may be the command (a leader the
 * guard does not know, xargs, cmd /c, a PowerShell block), except after a lookup word and for the names marked commandOnly.
 */
function ecosystemInstall(segment: string): EcoName | null {
  let words = tokenize(stripPrefixes(segment)).flatMap((w) => w.split(',')).filter(Boolean);
  if (words[0] === '&') words.shift();
  // Start-Process pwsh -ArgumentList "-c","Install-Module x" and iex "choco install x": a quoted argument holds the command.
  const spawns = START_PROCESS.test(words[0] ?? '') || /^(?:iex|invoke-expression)$/i.test(words[0] ?? '');
  if (spawns) words = words.flatMap((w) => w.split(/\s+/)).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (i > 0 && !spawns && LOOKUP.test(words[i - 1])) continue;
    // A block opener glued to the name: {Install-Module, (choco.
    const word = words[i].replace(/^[({]+(?=.)/, '');
    const names = [commandName(word), commandName(word.replace(/\\/g, ''))];
    const atCommand = i === 0 || spawns || LAUNCHER.test(words[i - 1]) || word !== words[i];
    const rule = ECO_RULES.find((r) => names.some((n) => r.names.test(n)) && (atCommand || !r.commandOnly) && r.installs(words.slice(i + 1)));
    if (rule) return rule.ecosystem;
  }
  return null;
}

/**
 * F10 repair: the command word of the segment, read with its quotes removed (tokenize), names a
 * manager whose verb is an install verb or is hidden ("pip" install, pi\p install, npm $V, $PM install).
 * Only the command position counts, so `echo "npm install x"` and `git commit -m "..."` stay allowed.
 * A Start-Process launcher counts when any of its arguments (comma lists split) is a manager and verb.
 */
function commandWordInstall(segment: string): boolean {
  const words = tokenize(stripPrefixes(segment)).flatMap((w) => w.split(',')).filter(Boolean);
  if (words[0] === '&') words.shift();
  if (words.length < 2) return false;
  if (START_PROCESS.test(words[0])) return anyManagerInstall(words);
  const next = words.slice(1).find((w) => !w.startsWith('-'));
  if (next === undefined) return false;
  if (/^[$`]/.test(words[0])) return ANY_VERB.test(next);
  const verbs = managerVerbs(words[0]);
  return verbs !== undefined && verbOrHidden(next, verbs);
}

/** A quoted word with no space or quote inside, as the command or verb: "pip" install, npm 'i' x. */
const QUOTED_WORD = /(^|\s)(["'])([^"'\s]+)\2(?=\s|$)/g;

/** The first install pattern a command matches, and the text after the matched prefix. */
function matchInstall(command: string): { pattern: InstallPattern; head: string; args: string } | null {
  const trimmed = stripPrefixes(command);
  // F10 repair: a quoted command or verb word runs the same as a bare one, so match that form too.
  // Removing the quotes of a one-word argument does not change how tokenize() reads it.
  const unquoted = stripPrefixes(command.replace(QUOTED_WORD, '$1$3'));
  for (const text of trimmed === unquoted ? [trimmed] : [trimmed, unquoted]) {
    for (const pattern of INSTALL_PATTERNS) {
      const m = text.match(pattern.regex);
      if (m) return { pattern, head: m[0], args: text.slice(m[0].length) };
    }
  }
  return null;
}

interface InstallAnalysis {
  pattern: InstallPattern;
  /** Registry packages the checks can read, with the token each came from. */
  named: { raw: string; pkg: PackageInfo }[];
  packages: PackageInfo[];
  /** Tokens that name a source the checks cannot read: a URL, VCS, github:, user/repo, a tarball (F12). */
  unparsed: string[];
  /** Custom index flags and their values (F11). */
  customIndex: string[];
  /** Runner flags in no table, each followed by a word that may be its value (F11/F13 repair). */
  ambiguous: string[];
  /** npm --tag X: the dist-tag an unversioned package installs from (F15 repair). */
  tag?: string;
  /** The runner package that runs a local node_modules/.bin file, if that file exists (see hasLocalBin). */
  localBin?: PackageInfo;
}

const takesValue = (t: FlagTable, n: string) => t.value.has(n) || t.pkg.has(n) || t.source.has(n) || t.index.has(n) || t.extra.has(n);
/** An index flag, or npm's scoped form --@scope:registry=URL. */
const isIndexFlag = (t: FlagTable, n: string) => t.index.has(n) || /^--@[^:\s]+:registry$/.test(n);

/** Split `--flag=value` and a short flag with its value attached (`-iURL`). */
function splitFlag(token: string, table: FlagTable): { name: string; inline?: string } {
  const eq = token.indexOf('=');
  if (token.startsWith('--') && eq > 2) return { name: token.slice(0, eq), inline: token.slice(eq + 1) };
  const short = token.slice(0, 2);
  if (/^-[A-Za-z]./.test(token) && takesValue(table, short)) return { name: short, inline: token.slice(2) };
  return { name: token };
}

/**
 * The package `npm init x` / `yarn create x` runs: create-x, @scope/create, @scope/create-x.
 * A non-registry spec (a path, user/repo) is returned as typed, so the classifier asks on it.
 */
function createPackage(token: string): string {
  if (NPM_NON_REGISTRY.test(token)) return token;
  const scoped = token.match(/^(@[^/@]+)(?:\/([^@]+))?(@.*)?$/);
  if (scoped) return `${scoped[1]}/create${scoped[2] ? `-${scoped[2]}` : ''}${scoped[3] ?? ''}`;
  return `create-${token}`;
}

// A VAR=value prefix that points the installer at another index or registry (F11, env form).
const INDEX_ENV = /(?:^|\s)(?:PIP_(?:EXTRA_)?INDEX_URL|PIP_FIND_LINKS|UV_(?:EXTRA_|DEFAULT_)?INDEX(?:_URL)?|UV_FIND_LINKS|npm_config_registry|YARN_NPM_REGISTRY_SERVER|YARN_REGISTRY|BUN_CONFIG_REGISTRY)=\S*/gi;

// Index, registry and config settings in any form or position of the whole command (F11 repair):
// export PIP_INDEX_URL=..., $env:PIP_INDEX_URL='...', npm config set registry, pip config set
// global.index-url, --@scope:registry=, --userconfig, NPM_CONFIG_USERCONFIG=, PIP_CONFIG_FILE=.
// Variables that point an installer at another index, registry or config file.
const INDEX_VARS = String.raw`(?:PIP_(?:EXTRA_)?INDEX_URL|PIP_FIND_LINKS|PIP_CONFIG_FILE|UV_(?:EXTRA_|DEFAULT_)?INDEX(?:_URL)?|UV_FIND_LINKS|UV_CONFIG_FILE|npm_config_(?:registry|userconfig|globalconfig)|YARN_NPM_REGISTRY_SERVER|YARN_REGISTRY|YARN_RC_FILENAME|BUN_CONFIG_REGISTRY)`;
// Config files that can set a registry or index.
const RC_FILE = String.raw`(?:\.npmrc|\.yarnrc(?:\.yml)?|bunfig\.toml|pip\.ini|pip\.conf)\b`;
// Settings that outlive the command (G2): a config set or an rc file write persists for every later install.
const PERSISTENT_CONFIG: RegExp[] = [
  /\b(?:(?:config|c)\s+set|npm\s+set|pnpm\s+set)\s+\S*(?:registry|userconfig|globalconfig|index|find-links)\S*/gi,
  // A write into an npm, yarn, bun or pip config file: echo registry=URL > .npmrc, tee -a .yarnrc.yml.
  new RegExp(String.raw`(?:>>?|\btee(?:\s+-a)?)\s*["']?\S*${RC_FILE}`, 'gi'),
  // The same through a PowerShell or copy command, up to 8 words before the file: Set-Content -Path '.npmrc', cp x .npmrc.
  new RegExp(String.raw`(?:^|[\s;&|({])(?:set-content|add-content|out-file|sc|ac|cp|copy|copy-item|cpi|mv|move|move-item|mi)(?:\s+[^\s;&|]+){0,8}?\s+["']?[^\s;&|"']*${RC_FILE}`, 'gi'),
  // A registry variable set through the Env: drive or .NET: Set-Item Env:npm_config_registry, SetEnvironmentVariable('npm_config_registry'.
  new RegExp(String.raw`(?:(?<!\$)\benv:[\\/]?|SetEnvironmentVariable\(\s*["'])${INDEX_VARS}\b`, 'gi'),
];
const INDEX_CONFIG: RegExp[] = [
  new RegExp(String.raw`\b${INDEX_VARS}\s*=`, 'gi'),
  ...PERSISTENT_CONFIG,
  /--(?:userconfig|globalconfig)\b/g,
  /--@[^\s=:]+:registry\b/g,
];

function indexConfigMarkers(command: string, patterns: RegExp[] = INDEX_CONFIG): string[] {
  return [...new Set(patterns.flatMap((re) => [...command.matchAll(re)].map((m) => m[0].replace(/\s*=$/, ''))))];
}

// A registry key in an npm, pnpm or yarn set command: registry, @scope:registry, npmRegistryServer, npmScopes.
const REGISTRY_KEY = /^(?:--?)?(?:@[^:\s]+:)?(?:registry|npmRegistryServer|npmScopes|registries)\b/i;

/** npm config set -g registry U, npm set a=b registry=U, yarn config set -H npmRegistryServer U: words in any order. */
function registrySet(segment: string): string[] {
  const words = tokenize(stripPrefixes(segment));
  const manager = commandName(words[0] ?? '');
  const key = words.find((w) => REGISTRY_KEY.test(w));
  return /^(?:npm|pnpm|yarn)$/.test(manager) && words.includes('set') && key ? [`${manager} set ${key.split("=")[0]}`] : [];
}

// G2 raw rule (round 4): the raw text, never parsed, with backslashes, quotes and backticks removed (reg\istry, r'e'gistry).
// A registry or index key word, or a package-manager or pip config file name, anywhere in the text.
// A hyphen after a letter or digit is inside a name (npm-registry-fetch); a flag dash (--registry) still counts.
const RAW_CONFIG_WORD = /(?<![a-z0-9]|[a-z0-9]-)(?:registry|registries|npmRegistryServer|npmScopes|(?:extra-)?index-url|trusted-host|find[-_]links|userconfig|globalconfig|UV_INDEX|UV_DEFAULT_INDEX|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_CONFIG_FILE|UV_CONFIG_FILE|npm_config_registry)|\.npmrc|\.yarnrc|bunfig\.toml|pip\.ini|pip\.conf|uv\.toml|\.pypirc/gi;
const RAW_MANAGER = /\b(?:npm|pnpm|yarn|bun|pip\d*|uv|poetry|pdm|conda)\b/i;
const RAW_SET_MANAGER = /\b(?:npm|pnpm)\b/i;

/**
 * Registry, index or config text in the command, read raw (G2). It makes a chained install, even a bare
 * one, ask. Fail closed: quoted text, a read (cat .npmrc) or any config command (npm config get) counts.
 * A segment with a package manager and the word config (or npm/pnpm with set) is a config write; a $ or
 * backtick key there (npm config set $K) is one too.
 */
function rawConfigMarkers(command: string): string[] {
  const text = command.replace(/[\\'"`]/g, '');
  const writes = text.split(/[;&|\r\n]/).filter((seg) =>
    // Whole shell words only: eslint-config-prettier, set-value and lodash.set are package names, not config writes.
    (RAW_MANAGER.test(seg) && /(?:^|\s)(?:config|c)(?=\s|$)/i.test(seg)) || (RAW_SET_MANAGER.test(seg) && /(?:^|\s)set(?=\s|$)/i.test(seg)));
  return [...new Set([...writes.map((seg) => seg.trim().slice(0, 80)), ...[...text.matchAll(RAW_CONFIG_WORD)].map((m) => m[0]), ...builtNameMarkers(command, text)])];
}

// G2 run-time-built names: the shell builds an rc file name or an env variable name, so the raw text never holds
// ".npmrc" or "npm_config_registry" (.np{m,}rc, .n${X}pmrc, npm_config_{reg,}istry, npm_config_reg$()istry).
// An expansion char: a brace, a variable, a glob or a backtick.
const EXPANSION = /[{$*?[`]/;
// An env-name prefix of a package manager, then name characters, then an expansion char inside the name.
const BUILT_ENV_NAME = /(?<![A-Za-z0-9_])(?:npm_config_|PIP_|UV_|YARN_|BUN_CONFIG_)[A-Za-z0-9_]*[{$*?[`]/i;

/**
 * (a) a word whose basename starts with a dot and holds an expansion char; (b) an env-name prefix with one
 * inside the name. Read from the raw text twice: once with quotes and backslashes removed (a backtick stays,
 * it is an expansion here) and once with the backticks removed as well. Fail closed: `ls .cache/*` is not
 * one (the glob is not in the dot word), `.eslintrc.{js,json}` is.
 */
function builtNameMarkers(command: string, stripped: string): string[] {
  const views = [command.replace(/[\\'"]/g, ''), stripped];
  const found: string[] = [];
  for (const view of views) {
    for (const token of view.split(/[\s;&|<>()]+/)) {
      const base = token.split(/[\\/]/).pop() ?? '';
      if (base.startsWith('.') && EXPANSION.test(base)) found.push(token.slice(0, 80));
    }
    const env = view.match(BUILT_ENV_NAME);
    if (env) found.push(env[0]);
  }
  return found;
}

/**
 * Persistent registry or index settings the command executes (config set, a write into an rc file),
 * read outside quoted text, so `git commit -m "npm config set registry"` is not one. Wrapper payloads count.
 */
function persistentConfigMarkers(command: string, tool: string, depth = 0): string[] {
  try {
    const { segments, substitutions } = parseExecutable(normalizeEscapes(executableView(command, tool), tool));
    const own = segments.flatMap((seg) => [...indexConfigMarkers(stripQuotedStrings(seg, tool), PERSISTENT_CONFIG), ...registrySet(seg)]);
    if (depth >= 3) return own;
    const nested = [...substitutions, ...wrapperPayloadsFromSegments(segments)];
    return [...own, ...nested.flatMap((text) => persistentConfigMarkers(text, tool, depth + 1))];
  } catch {
    return [...indexConfigMarkers(command, PERSISTENT_CONFIG), ...registrySet(command)];
  }
}

/** Read an install command: its pattern, registry packages, unreadable sources and custom indexes. */
function analyzeInstall(command: string): InstallAnalysis | null {
  const install = matchInstall(command);
  if (!install) return null;
  const { pattern } = install;
  const table = FLAG_TABLES[pattern.flags];
  const out: InstallAnalysis = { pattern, named: [], packages: [], unparsed: [], customIndex: [], ambiguous: [] };
  const add = (raw: string) => {
    const t = classifyToken(raw, pattern);
    if (t.pkg) { out.named.push({ raw, pkg: t.pkg }); out.packages.push(t.pkg); }
    if (t.unparsed) out.unparsed.push(raw);
  };
  for (const m of command.matchAll(INDEX_ENV)) out.customIndex.push(m[0].trim());
  // An index option before the verb: npm --registry URL install x, pip --index-url=URL install x.
  const headWords = tokenize(install.head);
  headWords.forEach((word, i) => {
    const { name, inline } = splitFlag(word, table);
    if (isIndexFlag(table, name)) out.customIndex.push(`${name} ${inline ?? headWords[i + 1] ?? ''}`.trim());
  });
  const words = tokenize(install.args);
  const runner = pattern.kind === 'first' || pattern.kind === 'create';
  let pkgFlagSeen = false;
  let unknownFlag: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith('-')) {
      const { name, inline } = splitFlag(word, table);
      const value = inline ?? (takesValue(table, name) ? words[++i] : undefined);
      unknownFlag = value === undefined && !table.bare.has(name) ? word : undefined;
      if (isIndexFlag(table, name)) out.customIndex.push(`${name} ${value ?? ''}`.trim());
      // npx -c / npm exec --call: npm runs the value as a shell command. The checks cannot read it.
      else if (pattern.flags === 'node' && (name === '-c' || name === '--call')) out.ambiguous.push(`${name} ${value ?? ''}`.trim());
      else if (table.pkg.has(name) && value !== undefined) { pkgFlagSeen = true; add(value); }
      else if (table.extra.has(name) && value !== undefined) add(value);
      else if (table.source.has(name) && value !== undefined && isRemoteSource(value)) out.unparsed.push(value);
      // F11 repair: a URL the flag tables did not place (pip -qiURL, --proxy URL, npm --reg=URL) asks.
      else if (`${word} ${value ?? ''}`.includes('://')) out.customIndex.push(`${word} ${value ?? ''}`.trim());
      if (name === '--tag' && value !== undefined) out.tag = value;
      continue;
    }
    if (pattern.kind === 'run') break;
    if (runner) {
      // A runner flag in no table may have taken this word as its value: the package is unknown.
      if (unknownFlag !== undefined) out.ambiguous.push(`${unknownFlag} ${word}`);
      // npx -p X cmd: cmd is a binary of X, not a package. npx X args: args belong to X.
      else if (!pkgFlagSeen) {
        const before = out.packages.length;
        add(pattern.kind === 'create' ? createPackage(word) : word);
        const pkg = out.packages[before];
        // Only a bare, unscoped name with no tag: npm looks for node_modules/.bin/<word> as typed,
        // so @scope/x never runs a local bin, and x@1.0 fetches that version.
        if (pattern.preferLocal && pkg && !pkg.version && !out.tag && !pkg.name.startsWith('@')) out.localBin = pkg;
      }
      break;
    }
    add(word);
  }
  return out;
}

/** A URL, VCS or network-share source: git+https://..., https://..., name @ https://..., \\host\share, //host/share. */
function isRemoteSource(token: string): boolean {
  return /:\/\/|^(?:git|hg|svn|bzr)\+|@|^(?:\\\\|\/\/)/i.test(token);
}

// An npm spec that is not a registry name: a protocol (github:, git+, file:, npm: alias, https:),
// a path, a tarball, or user/repo shorthand. Scoped names (@scope/name) are registry names.
const NPM_NON_REGISTRY = /[:\\]|^[.~/]|\.(?:tgz|tar|tar\.gz)$|^[^@][^/]*\//i;
const NPM_NAME = /^(?:@[\w.~-]+\/)?[\w.~-]+$/;

// A built or downloaded archive: no check can read what is inside it (F12 repair).
const ARCHIVE = /\.(?:whl|zip|tgz|tar|tar\.gz|tar\.bz2|tar\.xz)$/i;

/**
 * Read one argument token. `unparsed` marks a token the checks cannot verify (fail closed: ask).
 * A pip local folder (., .\pkg, ../src) is neither: it is the project on disk, not a registry
 * package. A pip archive file (x.whl, dist\x.tar.gz) is unparsed: it may be a fresh download.
 */
function classifyToken(token: string, pattern: InstallPattern): { pkg?: PackageInfo; unparsed?: boolean } {
  const { ecosystem } = pattern;
  if (ecosystem === 'npm') {
    if (NPM_NON_REGISTRY.test(token)) return { unparsed: true };
    const pkg = parsePackageToken(token, ecosystem);
    // F12 repair: the spec after the last @ can be a source too (@scope/name@user/repo, @scope/name@../dir).
    if (pkg?.version && NPM_NON_REGISTRY.test(pkg.version)) return { unparsed: true };
    return pkg && NPM_NAME.test(pkg.name) ? { pkg } : { unparsed: true };
  }
  if (ecosystem === 'pypi') {
    const spec = pipSpec(token);
    // uvx tool@1.0 / tool@latest: the runner form of a pin.
    const at = pattern.kind === 'first' ? spec.match(/^([A-Za-z0-9_.-]+)@([^:/@]+)$/) : null;
    if (at) return { pkg: { name: at[1], version: at[2] === 'latest' ? undefined : at[2] } };
    if (isRemoteSource(spec) || ARCHIVE.test(spec)) return { unparsed: true };
    if (/^[.~/]|[\\/]/.test(token)) return {};
    const pkg = parsePackageToken(token, ecosystem);
    return pkg ? { pkg } : { unparsed: true };
  }
  // go run main.go and go run . are local; only module@version fetches code.
  if (pattern.remoteOnly && !token.includes('@')) return {};
  const pkg = parsePackageToken(token, ecosystem);
  return pkg ? { pkg } : { unparsed: true };
}

const BASH_OVERRIDE = /^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*SKIP_PACKAGE_GUARD=1(?=[ \t]|$)/;
// PowerShell sets the variable as its own first statement: $env:SKIP_PACKAGE_GUARD=1; npm install x
// Only the literal SKIP_PACKAGE_GUARD=1 text counts, as in the base guard: a quoted '1' or spaces
// around = were denied there, and this form must not loosen that.
const PS_OVERRIDE = /^\s*\$(?:env|Env|ENV):SKIP_PACKAGE_GUARD=1\s*(?:;|\r?\n)/;

/**
 * Check if the command has the SKIP_PACKAGE_GUARD=1 override (F08). It counts only as a leading
 * env assignment of the command (optionally among other VAR=value assignments), or as the
 * PowerShell `$env:SKIP_PACKAGE_GUARD=1;` first statement. Text in a comment or an echo does not count.
 */
export function checkOverride(command: string): boolean {
  return BASH_OVERRIDE.test(command) || PS_OVERRIDE.test(command);
}

/**
 * Check if a package+version is in the malicious packages blocklist.
 */
export function checkMaliciousPackage(
  name: string,
  version: string | undefined,
  ecosystem: Exclude<Ecosystem, null>
): MaliciousCheckResult {
  // Only pypi and npm have blocklist entries. Any other ecosystem must not fall back to the npm list.
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') {
    return { blocked: false };
  }
  const ecosystemKey = ecosystem;

  const entry = blocklistIndex(ecosystemKey).get(normalizeName(name, ecosystemKey));
  if (!entry) return { blocked: false };
  // F15: compare versions in canonical form. A range or tag is not a pin, so it gets the warning.
  version = canonicalVersion(version, ecosystemKey);

  // blocked_all = true means ALL versions are blocked
  if (entry.blocked_all === true) {
    return {
      blocked: true,
      reason: entry.reason || `Package "${name}" is entirely blocked`,
    };
  }

  // Check specific version blocks
  if (entry.blocked_versions && Array.isArray(entry.blocked_versions)) {
    if (version && entry.blocked_versions.some((v: string) => canonicalVersion(v, ecosystemKey) === version)) {
      return {
        blocked: true,
        reason: entry.reason || `Version ${version} of "${name}" is known malicious`,
      };
    }

    // No version specified but package has known-bad versions -> warn
    if (!version && entry.blocked_versions.length > 0) {
      return {
        blocked: false,
        warning: `Package "${name}" has known malicious versions: ${entry.blocked_versions.join(', ')}. Ensure you are installing a safe version.`,
      };
    }
  }

  return { blocked: false };
}

/** PyPI names compare after PEP 503 normalisation (Foo.Bar == foo_bar == foo-bar); npm names in lower case. */
function normalizeName(name: string, ecosystem: 'pypi' | 'npm'): string {
  const lower = name.toLowerCase();
  return ecosystem === 'pypi' ? lower.replace(/[-_.]+/g, '-') : lower;
}

const blocklistCache = new Map<string, Map<string, any>>();

/** The blocklist keyed by normalised name, so a mixed-case key (jeIlyfish) still matches. */
function blocklistIndex(ecosystem: 'pypi' | 'npm'): Map<string, any> {
  let index = blocklistCache.get(ecosystem);
  if (!index) {
    const registry = (maliciousPackages as Record<string, Record<string, any>>)[ecosystem] ?? {};
    index = new Map(Object.entries(registry).map(([k, v]) => [normalizeName(k, ecosystem), v]));
    blocklistCache.set(ecosystem, index);
  }
  return index;
}

/**
 * PEP 440 equality for a release: lower case, no leading v, no leading zeros in a number,
 * no trailing .0 segments. 01.82.7.0 and v1.82.7 both give 1.82.7.
 */
function pep440Key(v: string): string {
  return v.toLowerCase().replace(/^v/, '').replace(/^(\d+(?:\.\d+)*)/, (rel) =>
    rel.split('.').map((n) => n.replace(/^0+(?=\d)/, '')).join('.').replace(/(\.0+)+$/, ''));
}

/**
 * The exact version a spec pins, in the form the blocklist compares, or undefined for a range or tag.
 * npm: =1.4.1, v1.4.1 and 1.4.1+build all pin 1.4.1 (semver ignores build metadata).
 */
function canonicalVersion(version: string | undefined, ecosystem: 'pypi' | 'npm'): string | undefined {
  if (!version) return undefined;
  if (ecosystem === 'pypi') return pep440Key(version);
  const v = version.trim().replace(/^=+/, '').replace(/^v/i, '').replace(/\+.*$/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// OSV.dev real-time vulnerability check
// ---------------------------------------------------------------------------

// An exact npm version. checkInstall passes a pypi version only for an exact == or === pin.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

interface OsvResult {
  blocked: boolean;
  /** A CRITICAL advisory for an unknown version: ask (deny when unattended), do not hard-deny. */
  ask?: boolean;
  warning?: string;
  advisoryId?: string;
}

export async function checkOsvAdvisory(
  name: string,
  version: string | undefined,
  ecosystem: Exclude<Ecosystem, null>
): Promise<OsvResult> {
  // Only check pypi and npm
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') {
    return { blocked: false };
  }

  const osvEcosystem = ecosystem === 'pypi' ? 'PyPI' : 'npm';

  try {
    // G6b: an npm tag or range (latest, next, ^1.0.0) is not a version. Query every version, as with no version.
    const known = version !== undefined && (ecosystem === 'pypi' || EXACT_SEMVER.test(version));
    const vulns = await queryOsv(name, known ? version : undefined, osvEcosystem);

    // Check for MAL- prefixed IDs (confirmed malware from OSSF)
    // No version: OSV lists the advisories of every version. Say so; the advisory may not apply to what installs.
    const scope = known ? '' : ' The version to install is unknown (no exact version in the command), so this advisory may not apply to it.';
    const malware = vulns.find((v: any) => v.id?.startsWith('MAL-'));
    if (malware) {
      return {
        blocked: true,
        advisoryId: malware.id,
        warning: `OSV.dev reports malware: ${malware.id}. ${malware.summary || malware.details?.slice(0, 200) || 'No details available'}.${scope}`,
      };
    }

    // Check for CRITICAL severity CVEs
    const critical = vulns.find((v: any) => {
      const severity = v.database_specific?.severity ||
        v.severity?.find((s: any) => s.type === 'CVSS_V3')?.score;
      if (typeof severity === 'string') return severity === 'CRITICAL';
      if (typeof severity === 'number') return severity >= 9.0;
      return false;
    });
    if (critical) {
      // Dave 11-04 (CodeRabbit #291): with no exact version the advisory may not apply, so ask; an exact version denies.
      return {
        blocked: known,
        ask: !known,
        advisoryId: critical.id,
        warning: `OSV.dev reports CRITICAL vulnerability: ${critical.id}. ${critical.summary || 'No summary'}.${scope}`,
      };
    }

    // Check for HIGH severity -- warn but allow
    const high = vulns.find((v: any) => {
      const severity = v.database_specific?.severity ||
        v.severity?.find((s: any) => s.type === 'CVSS_V3')?.score;
      if (typeof severity === 'string') return severity === 'HIGH';
      if (typeof severity === 'number') return severity >= 7.0 && severity < 9.0;
      return false;
    });
    if (high) {
      return {
        blocked: false,
        advisoryId: high.id,
        warning: `OSV.dev reports HIGH severity vulnerability: ${high.id}. ${high.summary || 'No summary'}.${scope}`,
      };
    }

    return { blocked: false };
  } catch {
    // Fail-open on network/API errors
    return { blocked: false };
  }
}

function queryOsv(
  name: string,
  version: string | undefined,
  ecosystem: string
): Promise<any[]> {
  return new Promise((resolve) => {
    const body: any = {
      package: { name, ecosystem },
    };
    if (version) {
      body.version = version;
    }

    const postData = JSON.stringify(body);
    const timer = setTimeout(() => resolve([]), 5000);

    const req = https.request(
      {
        hostname: 'api.osv.dev',
        path: '/v1/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(data);
            resolve(json.vulns || []);
          } catch {
            resolve([]);
          }
        });
      }
    );

    req.on('error', () => { clearTimeout(timer); resolve([]); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve([]); });
    req.write(postData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Registry age check (PyPI / npm)
// ---------------------------------------------------------------------------

interface AgeCheckResult {
  ageHours: number | null;
  blocked: boolean;
  warning?: string;
  error?: string;
  /** The registry answered HTTP 404: the package does not exist there. */
  notFound?: boolean;
}

export async function checkPackageAge(
  name: string,
  ecosystem: Exclude<Ecosystem, null>,
  requestedVersion?: string
): Promise<AgeCheckResult> {
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') {
    return { ageHours: null, blocked: false };
  }

  try {
    const { date: publishDate, notFound } = await fetchPublishDate(name, ecosystem, requestedVersion);
    if (notFound) {
      return { ageHours: null, blocked: false, notFound: true };
    }
    if (!publishDate) {
      return { ageHours: null, blocked: false };
    }

    const ageMs = Date.now() - publishDate.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours < 24) {
      return {
        ageHours,
        blocked: true,
        warning: `Package "${name}" was published less than 24 hours ago (${Math.round(ageHours)}h). This is suspicious for supply-chain attacks.`,
      };
    }

    if (ageHours < 168) { // 7 days
      const ageDays = Math.round(ageHours / 24);
      return {
        ageHours,
        blocked: false,
        warning: `Package "${name}" was published ${ageDays} day(s) ago. Proceed with caution.`,
      };
    }

    return { ageHours, blocked: false };
  } catch {
    // Fail-open for network issues
    return { ageHours: null, blocked: false, error: 'Registry check failed (network)' };
  }
}

/**
 * Pick the publish date to age-check from a registry document.
 *
 * If the command pinned an EXACT version that the registry knows, use that
 * version's date -- that is what will be installed. Otherwise (no version, or
 * a range like ^1.2.0 / >=1.0) fall back to the latest release, which is the
 * conservative choice because a range usually resolves to it.
 *
 * Before 2026-09-01 this always used latest, so `@types/node@24.13.3`
 * (8 weeks old) was blocked because 25.x had shipped an hour earlier.
 */
export function publishDateFromRegistryJson(
  json: unknown,
  ecosystem: 'pypi' | 'npm',
  requestedVersion?: string
): Date | null {
  const doc = json as Record<string, any> | null;
  if (!doc) return null;

  if (ecosystem === 'pypi') {
    // PEP 440 public versions, which npm's semver pattern rejects: 1.9.0rc1, 2.0, 1.0.post1,
    // 3.1.dev4. A rejected pin fell back to info.version, so a brand-new pre-release could be
    // aged by an older stable release's date and pass.
    const exact = requestedVersion && /^v?\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/i.test(requestedVersion)
      ? requestedVersion.replace(/^v/, '')
      : undefined;
    // PEP 440 treats trailing zero release segments as equal (1.8 == 1.8.0), but PyPI keys the
    // release dict by the published string. Match on the normalized form so a shortened pin
    // does not fall back to info.version and age-check the wrong release.
    const norm = pep440Key;
    const releaseKey = exact
      ? (doc.releases?.[exact] ? exact : Object.keys(doc.releases ?? {}).find((k) => norm(k) === norm(exact)))
      : undefined;
    const version = releaseKey ?? doc.info?.version;
    // A release is several files uploaded separately, and pip may pick a wheel added long after
    // the sdist. Age-check the NEWEST upload, or a fresh wheel on an old release passes.
    let newest: Date | null = null;
    for (const file of doc.releases?.[version] ?? []) {
      const d = file?.upload_time_iso_8601 ? new Date(file.upload_time_iso_8601) : null;
      if (d && !Number.isNaN(d.getTime()) && (!newest || d > newest)) newest = d;
    }
    return newest;
  }

  const exact = requestedVersion && /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(requestedVersion)
    ? requestedVersion.replace(/^v/, '')
    : undefined;
  // F15: a tag pin (@next, @beta) installs that tag's version, so age that one, not latest.
  const tags = doc['dist-tags'] ?? {};
  const tagged = requestedVersion && Object.prototype.hasOwnProperty.call(tags, requestedVersion) ? tags[requestedVersion] : undefined;
  let version = exact && doc.time?.[exact] ? exact : tagged ?? tags.latest;
  // F15 repair: a range with a pre-release part (^2.0.0-next.0, >=2.0.0-0) can install a version
  // newer than latest. Without a semver resolver, age the newest version the registry lists.
  if (!exact && tagged === undefined && requestedVersion && /\d/.test(requestedVersion) && requestedVersion.includes('-')) {
    version = newestNpmVersion(doc.time) ?? version;
  }
  const timeEntry = doc.time?.[version];
  return timeEntry ? new Date(timeEntry) : null;
}

/** The version with the newest publish time in an npm `time` map (created and modified are not versions). */
function newestNpmVersion(time: Record<string, string> | undefined): string | undefined {
  let best: string | undefined;
  for (const [v, t] of Object.entries(time ?? {})) {
    if (v === 'created' || v === 'modified' || Number.isNaN(Date.parse(t))) continue;
    if (!best || Date.parse(t) > Date.parse(time![best])) best = v;
  }
  return best;
}

/** The publish date to age-check, and whether the registry answered HTTP 404 (no such package). */
interface PublishLookup {
  date: Date | null;
  notFound: boolean;
}

function fetchPublishDate(
  name: string,
  ecosystem: 'pypi' | 'npm',
  requestedVersion?: string
): Promise<PublishLookup> {
  return new Promise((resolve) => {
    const unknown: PublishLookup = { date: null, notFound: false };
    const url = ecosystem === 'pypi'
      ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
      : `https://registry.npmjs.org/${encodeURIComponent(name)}`;

    const timer = setTimeout(() => {
      resolve(unknown);
    }, 5000);

    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        // Only a real HTTP 404 counts. Any other status, and a body that does not parse, stay fail-open.
        if (res.statusCode === 404) {
          resolve({ date: null, notFound: true });
          return;
        }
        try {
          resolve({ date: publishDateFromRegistryJson(JSON.parse(data), ecosystem, requestedVersion), notFound: false });
        } catch {
          resolve(unknown);
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve(unknown);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timer);
      resolve(unknown);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip env var prefixes like "FOO=bar BAZ=1 " from a command. */
function stripEnvPrefix(command: string): string {
  return command.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*/, '');
}

/** Simple tokenizer that respects quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse a single token into a PackageInfo.
 * Handles npm-style @scope/name@version and pip-style name==version.
 * Paths, URLs and other sources are sorted out first, in classifyToken.
 */
function parsePackageToken(
  token: string,
  ecosystem: Exclude<Ecosystem, null>
): PackageInfo | null {
  if (ecosystem === 'pypi') {
    // pip: name==version, name>=version, name~=version, name[extras]==version
    const match = pipSpec(token).match(/^([a-zA-Z0-9_.-]+)(?:\[.*?\])?(?:[=<>~!]+(.+))?$/);
    if (match) {
      return { name: match[1], version: match[2] || undefined };
    }
  } else if (ecosystem === 'npm') {
    // npm: @scope/name@version or name@version
    if (token.startsWith('@')) {
      // Scoped package: @scope/name or @scope/name@version
      const lastAt = token.lastIndexOf('@');
      if (lastAt > 0) {
        // Could be @scope/name@version
        const name = token.slice(0, lastAt);
        const version = token.slice(lastAt + 1);
        if (name.includes('/')) {
          return { name, version: version || undefined };
        }
      }
      // @scope/name without version
      return { name: token, version: undefined };
    } else {
      // Unscoped: name or name@version
      const atIdx = token.indexOf('@');
      if (atIdx > 0) {
        return { name: token.slice(0, atIdx), version: token.slice(atIdx + 1) || undefined };
      }
      return { name: token, version: undefined };
    }
  } else if (ecosystem === 'go') {
    // go get: github.com/user/repo@version
    const atIdx = token.indexOf('@');
    if (atIdx > 0) {
      return { name: token.slice(0, atIdx), version: token.slice(atIdx + 1) };
    }
    return { name: token, version: undefined };
  } else if (ecosystem === 'composer') {
    // composer: vendor/package:version or vendor/package
    const colonIdx = token.indexOf(':');
    if (colonIdx > 0) {
      return { name: token.slice(0, colonIdx), version: token.slice(colonIdx + 1) };
    }
    return { name: token, version: undefined };
  } else {
    // cargo, gem, etc.
    return { name: token, version: undefined };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function outputAllowWithAdvisory(advisory: string): void {
  const output = {
    hookSpecificOutput: {
      additionalContext: advisory,
    },
  };
  console.log(JSON.stringify(output));
}

function outputAllowOk(): void {
  outputContinue();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

const OVERRIDE = 'To override: prefix command with SKIP_PACKAGE_GUARD=1';

/**
 * Run every check on one install segment. The local checks (typosquat, blocklist, pin) run
 * before the network checks (OSV, package age), so a deny on them costs no request.
 */
interface InstallVerdict { deny?: string; asks: string[]; advisories: string[] }

/**
 * The reasons a segment must ask: the checks cannot vouch for what it installs (fail closed).
 * A deny from the package checks still wins over these.
 */
function asksFor(segment: string, install: InstallAnalysis | null, cwd: string | null, tool: string): string[] {
  if (!install) {
    // An ecosystem with no registry check: say which, in the same words as cargo, nuget and brew.
    const eco = ecosystemInstall(segment);
    if (eco) return [`No blocklist, OSV or age check exists for ${eco} packages: ${segment.slice(0, 200)}.`];
    return [`Install command the guard cannot parse: "${segment.slice(0, 200)}". No package check ran. Run it as a plain install (no wrapper or leader) or confirm it.`];
  }
  const asks: string[] = [];
  const { pattern } = install;
  // Bash splits an unquoted $VAR into words: PY='npx y'; $PY -m pip install x runs npx. "$PY" is one word.
  // PowerShell does not split a variable (& $python), and a desktop-commander command is also read as Bash.
  const commandWord = stripPrefixes(segment).split(/\s/)[0];
  if (tool !== 'PowerShell' && commandWord.startsWith('$')) {
    asks.push(`The command word is an unquoted variable (${commandWord}). Bash splits its value into words, so it may run another program. Quote it ("$VAR") or confirm it.`);
  }
  if (pattern.kind === 'lockfile' && cwd === null) {
    asks.push('Lockfile install in a folder the guard cannot vouch for (a cd, a folder option or an expansion in the command). Nothing pinned to check.');
  } else if (pattern.kind === 'lockfile' && cwd !== null && !['package-lock.json', 'npm-shrinkwrap.json'].some((f) => existsSync(join(cwd, f)))) {
    asks.push(`Lockfile install with no package-lock.json in ${cwd}. Nothing pinned to check.`);
  }
  if (install.unparsed.length > 0) {
    asks.push(`Non-registry source: ${install.unparsed.join(', ')}. A URL, VCS, github:, user/repo, path or tarball install skips the blocklist, OSV and age checks.`);
  }
  if (install.customIndex.length > 0) {
    asks.push(`Custom package index: ${install.customIndex.join(', ')}. The checks read the public PyPI or npm registry, not this index.`);
  }
  if (install.ambiguous.length > 0) {
    asks.push(`Runner flag the guard cannot read: ${install.ambiguous.join(', ')}. The flag may take the next word as its value, so the package that runs is not known.`);
  }
  if (pattern.ecosystem !== 'pypi' && pattern.ecosystem !== 'npm') {
    const names = install.packages.map((p) => p.name).join(', ') || segment.slice(0, 200);
    asks.push(`No blocklist, OSV or age check exists for ${pattern.ecosystem} packages: ${names}.`);
  }
  return asks;
}

const LOCAL_BIN_MAX_LEVELS = 10;

// ---------------------------------------------------------------------------
// rc files on disk (G2, disk half)
// ---------------------------------------------------------------------------

const RC_FILES = ['.npmrc', '.yarnrc.yml', 'bunfig.toml', 'pip.conf', 'pip.ini', 'uv.toml'];
// Where each tool keeps its USER config, relative to the home folder. The home folder also gets RC_FILES (fail closed).
const HOME_RC_FILES = ['.npmrc', '.yarnrc.yml', '.bunfig.toml', '.config/pip/pip.conf', '.pip/pip.conf', '.config/uv/uv.toml', 'AppData/Roaming/pip/pip.ini'];
const RC_MAX_BYTES = 64 * 1024;
// Hosts whose registry or index the checks read. Any other host in a registry key asks.
const RC_PUBLIC_HOSTS = new Set(['npmjs.org', 'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org']);
// The KEY decides, not a line that holds the word: `//registry.npmjs.org/:_authToken=` is an auth key.
// npm @scope:registry, yarn npmRegistryServer, pip and uv index-url, extra-index-url, find-links. uv.toml also lists an index as `url`.
const RC_KEY = /^(?:@[^\s=:'"]+:)?(?:registry|npmRegistryServer|index[-_]url|extra[-_]index[-_]url|find[-_]links)$/i;
const RC_LINE = /^\s*["']?([^\s=:"']+(?::[^\s=:"']+)?)["']?\s*[=:]\s*(.*)$/;
const URL_IN_VALUE = /[a-z][a-z0-9+.-]*:\/\/[^\s"',}]+/i;

/** The first 64 KB of a regular file as text, and whether the file is longer. A missing file, a folder or any read error gives null. */
function readRcFile(path: string): { text: string; truncated: boolean } | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(RC_MAX_BYTES);
      return { text: buf.toString('utf8', 0, readSync(fd, buf, 0, RC_MAX_BYTES, 0)), truncated: st.size > RC_MAX_BYTES };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The host a registry value names, or null when it is not a URL (a path, ${VAR}, protocol-relative). */
function rcValueHost(value: string): string | null {
  const url = value.match(URL_IN_VALUE)?.[0] ?? value.trim().replace(/^["']|["']$/g, '');
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** Registry-key settings in one rc file whose host is not a public registry: "path (key=host)". */
function rcFileSettings(file: string, text: string): string[] {
  const keyOk = (key: string) => RC_KEY.test(key) || (file.endsWith('uv.toml') && key.toLowerCase() === 'url');
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const judge = (key: string, value: string) => {
    const host = rcValueHost(value);
    if (host === null || !RC_PUBLIC_HOSTS.has(host)) out.push(`${file} (${key}=${host ?? value.trim().slice(0, 60)})`);
  };
  lines.forEach((line, i) => {
    if (/^\s*[#;]/.test(line)) return;
    const m = line.match(RC_LINE);
    if (!m || !keyOk(m[1])) return;
    if (m[2].trim() !== '') judge(m[1], m[2]);
    // pip lists more values on the indented lines after the key, with or without a value on the key line:
    // extra-index-url = URL, then one URL per indented line. A comment or an indented `key = value` line (a TOML key) ends the list.
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*[#;]/.test(lines[j]) && !/^\s+[\w.-]+\s*=/.test(lines[j]); j++) judge(m[1], lines[j]);
  });
  return out;
}

/**
 * Registry or index settings that point away from the public registries, read from the rc files an install reads:
 * the cwd, up to 10 folders above it, the home folder (CCV3_GUARD_RC_HOME overrides it, for tests) and %APPDATA%.
 * Read errors are ignored. A null cwd is not read by the caller.
 */
function rcFileMarkers(cwd: string): string[] {
  const dirs = new Set<string>();
  let dir = resolve(cwd);
  for (let level = 0; level < LOCAL_BIN_MAX_LEVELS; level++) {
    dirs.add(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const paths = new Set<string>();
  for (const d of dirs) for (const name of RC_FILES) paths.add(join(d, name));
  try {
    const home = resolve(process.env.CCV3_GUARD_RC_HOME || homedir());
    for (const name of [...RC_FILES, ...HOME_RC_FILES]) paths.add(join(home, name));
  } catch { /* no home folder: skip it */ }
  // pip on Windows: %APPDATA%\pip\pip.ini
  if (process.env.APPDATA) paths.add(join(resolve(process.env.APPDATA), 'pip', 'pip.ini'));
  const out: string[] = [];
  for (const path of paths) {
    const rc = readRcFile(path);
    if (rc === null) continue;
    out.push(...rcFileSettings(path, rc.text));
    // A file longer than the cap is not fully read: the rest may hold a registry key. Parse doubt asks.
    if (rc.truncated) out.push(`${path} (larger than ${RC_MAX_BYTES} bytes, not fully read)`);
  }
  return [...new Set(out)];
}

/**
 * A node_modules/.bin/<name> file (a symlink to a file counts) in cwd or an ancestor, up to 10 levels.
 * npm 11.12.1 (libnpmexec localFileExists) starts at the local prefix and walks up to the root:
 * the first folder with that file wins, and then npx runs it and fetches nothing.
 * So a bin in a parent node_modules counts, even when a nearer folder has package.json.
 * An ANCESTOR node_modules counts only when it holds .package-lock.json, the hidden lockfile npm writes
 * into a node_modules it installed. Any earlier command can plant a bare bin file in a workspace root.
 * The guard stops at 10 levels. A bin higher up reads as not found, so the checks still run.
 */
function hasLocalBin(name: string, cwd: string): boolean {
  let dir = resolve(cwd);
  for (let level = 0; level < LOCAL_BIN_MAX_LEVELS; level++) {
    // npm (libnpmexec) runs only a file with the exact name. A folder, or a lone .cmd or .ps1, is not one.
    try {
      if (statSync(join(dir, 'node_modules', '.bin', name)).isFile()
        && (level === 0 || statSync(join(dir, 'node_modules', '.package-lock.json')).isFile())) return true;
    } catch { /* no bin here, or no marker above cwd: check the parent */ }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

async function checkInstall(segment: string, cwd: string | null, tool: string): Promise<InstallVerdict> {
  const install = analyzeInstall(segment);
  const asks = asksFor(segment, install, cwd, tool);
  const advisories: string[] = [];
  const ecosystem = install?.pattern.ecosystem;
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') return { asks, advisories };
  // A runner that finds node_modules/.bin/<name> runs that file: nothing is fetched, so nothing to check.
  // cwd comes from localBinCwd; null (not known) never skips.
  // A trailing @ (npx name@) asks for name@*, which npx fetches even when the bin exists.
  const trailingAt = /\S@(?=\s|$)/.test(segment);
  const packages = install!.packages.filter((p) => p !== install!.localBin || cwd === null || trailingAt || !hasLocalBin(p.name, cwd));

  for (const pkg of packages) {
    const typo = checkTyposquat(pkg.name, ecosystem);
    if (typo.isTyposquat) {
      return { asks, advisories, deny: `PACKAGE SECURITY: Suspected typosquat. "${pkg.name}" looks like "${typo.similarTo}". ${typo.reason}. Package: ${pkg.name}. ${OVERRIDE}` };
    }
    const malCheck = checkMaliciousPackage(pkg.name, pkg.version, ecosystem);
    if (malCheck.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: Known malicious package/version. ${malCheck.reason}. Package: ${pkg.name}${pkg.version ? '@' + pkg.version : ''}. ${OVERRIDE}` };
    }
    if (malCheck.warning) advisories.push(malCheck.warning);
  }

  const unpinned = unpinnedPipPackages(segment);
  if (unpinned.length > 0) {
    return { asks, advisories, deny: `PACKAGE SECURITY: Unpinned pip install. Every pip install needs an exact == pin. Unpinned: ${unpinned.join(', ')}. Pin each one, for example ${unpinned[0]}==<version>, with a version at least 7 days old on PyPI.` };
  }

  for (const pkg of packages) {
    // A pypi version is known only with an exact == or === pin: x>=1.0 may install any later version.
    const raw = install!.named.find((n) => n.pkg === pkg)?.raw ?? '';
    const osvVersion = ecosystem === 'pypi' && !EXACT_PIN.test(pipSpec(raw)) ? undefined : pkg.version;
    const osvResult = await checkOsvAdvisory(pkg.name, osvVersion, ecosystem);
    if (osvResult.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: ${osvResult.warning} Advisory: ${osvResult.advisoryId}. Package: ${pkg.name}${pkg.version ? '@' + pkg.version : ''}. ${OVERRIDE}` };
    }
    if (osvResult.ask) asks.push(`${osvResult.warning} Advisory: ${osvResult.advisoryId}. Package: ${pkg.name}${pkg.version ? '@' + pkg.version : ''}. Pin an exact version to check it, or confirm.`);
    else if (osvResult.warning) advisories.push(`OSV ADVISORY: ${osvResult.warning}`);

    // F15 repair: npm install --tag next x installs the next tag, so age that one.
    const ageResult = await checkPackageAge(pkg.name, ecosystem, pkg.version ?? install!.tag);
    if (ageResult.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: ${ageResult.warning} Package: ${pkg.name}. ${OVERRIDE}` };
    }
    if (ageResult.warning) advisories.push(`PACKAGE ADVISORY: ${ageResult.warning}`);
    if (ageResult.notFound) asks.push(`Package "${pkg.name}" was not found on the registry (404). Check the name or confirm.`);
  }
  return { asks, advisories };
}

async function main() {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(readStdin());
  } catch (err) {
    logGuardError('package-install-guard', err);
    outputContinue();
    return;
  }

  // Bash, PowerShell and the shell-running MCP tools (F07) all run installs. The list lives in
  // shared/shell-tools.ts. The settings.json matchers must name the same tools (two gates).
  const shell = readShellCommand(input);
  if (shell.kind === 'not-shell') {
    outputContinue();
    return;
  }
  if (shell.kind === 'unreadable') {
    // Fail closed: an unreadable shell command is always denied (never downgraded to ask).
    const reason = `PACKAGE SECURITY: Unreadable command text. ${shell.tool} has no string field "${shell.field}", so the install check cannot run.`;
    logGuardDecision('package-install-guard', input, 'deny', 'unreadable command text', { command: shell.tool });
    outputDeny(reason);
    return;
  }

  const command = shell.text;
  if (!command) {
    outputContinue();
    return;
  }

  // Fast path: no segment installs a package -> passthrough immediately.
  // A desktop-commander shell is chosen at run time, so its text is read as Bash and PowerShell.
  // A desktop-commander shell keeps its own folder, not the session folder: the local-bin skip and the lockfile read cannot use it.
  const payloadCwd = /desktop-commander/i.test(String(input.tool_name)) ? null : typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  // An rc file on disk (the cwd, its ancestors, the home folder) that points at another registry makes every install a configured one.
  const rcMarkers = payloadCwd === null ? [] : rcFileMarkers(payloadCwd);
  const plans = shell.dialects.flatMap((dialect) =>
    installPlans(command, dialect, localBinCwd(stripFdRedirects(command, dialect), payloadCwd, dialect), 0, rcMarkers.length > 0 ? true : undefined));
  const installs = plans.filter((p, i) => plans.findIndex((q) => q.segment === p.segment && q.cwd === p.cwd) === i);
  // F08: the override applies to the segment it prefixes, as a shell env assignment does.
  // A PowerShell `$env:SKIP_PACKAGE_GUARD=1;` first statement sets it for the whole command.
  const wholeOverride = PS_OVERRIDE.test(command);
  const checked = installs.filter(({ segment }) => !wholeOverride && !checkOverride(segment));
  if (checked.length < installs.length) {
    logGuardDecision('package-install-guard', input, 'override', 'SKIP_PACKAGE_GUARD', { command });
  }
  if (checked.length === 0) {
    // A registry change on its own persists: the next install, in another command, reads from it (G2).
    const persistent = installs.length === 0 && !wholeOverride && !checkOverride(command)
      ? [...new Set(shell.dialects.flatMap((dialect) => persistentConfigMarkers(command, dialect)))]
      : [];
    if (persistent.length === 0) {
      outputContinue();
      return;
    }
    const decision = isUnattended(input) ? 'deny' : 'ask';
    logGuardDecision('package-install-guard', input, decision, 'persistent registry config', { command });
    outputDeny(`PACKAGE SECURITY: Registry or index change that persists for later installs: ${persistent.join(', ')}. The checks read the public PyPI or npm registry, not this one. ${OVERRIDE}`, decision);
    return;
  }

  const advisories: string[] = [];
  const asks: string[] = [];
  for (const { segment, cwd, tool } of checked) {
    const result = await checkInstall(segment, cwd, tool);
    if (result.deny) {
      logGuardDecision('package-install-guard', input, 'deny', result.deny.replace(/^PACKAGE SECURITY:\s*/, '').split(/\.\s/)[0], { command });
      outputDeny(result.deny);
      return;
    }
    asks.push(...result.asks);
    advisories.push(...result.advisories);
  }

  // F11 repair: an index or config set anywhere in the command (an earlier export, $env:, npm config
  // set) applies to the install segment too. A segment-level ask already names an inline one.
  const config = [...new Set([...indexConfigMarkers(command), ...shell.dialects.flatMap((dialect) => persistentConfigMarkers(command, dialect)), ...rawConfigMarkers(command)])];
  if (config.length > 0 && !asks.some((a) => a.startsWith('Custom package index'))) {
    asks.push(`Custom package index or config in the command: ${config.join(', ')}. The checks read the public PyPI or npm registry, not this index.`);
  }

  if (rcMarkers.length > 0) {
    asks.push(`Registry or index set in an rc file on disk: ${rcMarkers.join(', ')}. The checks read the public PyPI or npm registry, not this one.`);
  }

  // The checks could not vouch for part of the install: ask, or deny where no human can answer.
  if (asks.length > 0) {
    const decision = isUnattended(input) ? 'deny' : 'ask';
    logGuardDecision('package-install-guard', input, decision, asks[0].split(/\.\s/)[0], { command });
    outputDeny(`PACKAGE SECURITY: ${asks.join(' ')} ${OVERRIDE}`, decision);
    return;
  }

  // All checks passed
  if (advisories.length > 0) {
    outputAllowWithAdvisory(advisories.join('\n'));
  } else {
    outputAllowOk();
  }
}

// Only run main() when executed as the hook itself. Two gates: vitest sets VITEST=true when it
// imports this file, and a harness that bundles the file and imports installSegments has a different
// argv[1]. Without the second gate that import reads stdin and logs a crash row to the real log.
// The pattern accepts / and \ separators and the .mjs dist file, like heartbeat.ts.
if (!process.env.VITEST && /(^|[\\/])package-install-guard\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  main().catch((err) => {
    // Fail-open: if the hook itself crashes, allow the command. Log the crash first.
    logGuardError('package-install-guard', err);
    outputContinue();
  });
}
