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

import { existsSync, readFileSync } from 'fs';
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
import maliciousPackages from './shared/malicious-packages.json';

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

type Ecosystem = 'pypi' | 'npm' | 'cargo' | 'go' | 'gem' | 'composer' | null;

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
const PIP_OPTS = String.raw`(?:\s+(?:--(?:proxy|log|cache-dir|timeout|retries|cert|client-cert|exists-action|trusted-host|python|use-feature|keyring-provider)\s+\S+|-[-\w]+(?:=\S+)?))*`;
// Interpreter flags before `-m` (-I, -u, -X utf8, -W ignore) and the py launcher version (-3.12).
const PY_OPTS = String.raw`(?:\s+(?:-[XW]\s*\S+|-[IuBEsSOqbdv]+|-\d(?:\.\d+)?))*`;

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
const NODE_OPTS = String.raw`(?:\s+(?:--(?:prefix|registry|cache|userconfig|globalconfig|loglevel|workspace|cwd|dir|filter|modules-folder)\s+\S+|-C\s+\S+|-\S+))*`;
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
  installPattern(String.raw`${DIR}(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?["']?${PY_OPTS}\s+-m\s*pip${PIP_OPTS}\s+${PIP_VERBS}${END}`, 'pypi', { requirePin: true, flags: 'pip', ignoreCase: true }),
  installPattern(String.raw`uv\s+pip\s+install${END}`, 'pypi', { requirePin: true, flags: 'pip' }),
  installPattern(String.raw`uv\s+add${END}`, 'pypi', { flags: 'pip' }),
  installPattern(String.raw`poetry\s+add${END}`, 'pypi', { flags: 'pip' }),
  installPattern(String.raw`pipenv\s+install${END}`, 'pypi', { flags: 'pip' }),
  // Python runners and tool installs (F13): the first token is the package, the rest is its argv.
  installPattern(String.raw`(?:uvx|uv\s+tool\s+(?:run|install)|pipx\s+(?:run|install))${END}`, 'pypi', { kind: 'first', flags: 'pyrunner' }),
  installPattern(String.raw`uv\s+run${END}`, 'pypi', { kind: 'run', flags: 'pyrunner' }),

  // JavaScript / Node
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+${NPM_INSTALL}${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+${NPM_UPDATE}${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+${NPM_CI}${END}`, 'npm', { kind: 'lockfile', flags: 'node' }),
  installPattern(String.raw`${bin('npm')}${NODE_OPTS}\s+(?:exec|x)${END}`, 'npm', { kind: 'first', flags: 'node', preferLocal: true }),
  installPattern(String.raw`(?:${bin('npm')}${NODE_OPTS}\s+(?:create|init|innit)|${bin('(?:yarn|pnpm|bun)')}${NODE_OPTS}\s+create)${END}`, 'npm', { kind: 'create', flags: 'node' }),
  installPattern(String.raw`${bin('yarn')}${NODE_OPTS}\s+(?:global\s+)?(?:add|up|upgrade)${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`${bin('pnpm')}${NODE_OPTS}\s+(?:add|install|i|update|up|upgrade)${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`${bin('bun')}${NODE_OPTS}\s+(?:add|a|install|i|update)${END}`, 'npm', { flags: 'node' }),
  installPattern(String.raw`(?:${bin('npx')}|${bin('bunx')}|${bin('bun')}${NODE_OPTS}\s+x)${END}`, 'npm', { kind: 'first', flags: 'node', preferLocal: true }),
  // pnpx is pnpm dlx. These always fetch, even when a local bin of that name exists.
  installPattern(String.raw`(?:${bin('pnpx')}|${bin('yarn')}${NODE_OPTS}\s+dlx|${bin('pnpm')}${NODE_OPTS}\s+dlx)${END}`, 'npm', { kind: 'first', flags: 'node' }),
  // deno names its sources npm:x, jsr:x or a URL; the classifier asks on each of them.
  installPattern(String.raw`${bin('deno')}\s+(?:install|i|add)${END}`, 'npm', { flags: 'node' }),

  // Rust, Go, Ruby, PHP: matched so the guard can ask. It has no blocklist or age check for them.
  installPattern(String.raw`cargo\s+(?:add|install)${END}`, 'cargo'),
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
const LEADER = new RegExp(String.raw`^(?:(?:${[
  String.raw`sudo(?:\s+(?:-[ugCDhpRrTt]\s+\S+|-\S+))*`,
  String.raw`doas(?:\s+-u\s+\S+)?`,
  String.raw`env(?:\s+(?:-[uCS]\s+\S+|-\S+))*`,
  String.raw`timeout(?:\s+(?:-[sk]\s+\S+|-\S+))*\s+\d+(?:\.\d+)?[smhd]?`,
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

/**
 * The executed segments of a Bash or PowerShell command that the guard must check. Text blocks that
 * only write text (a literal heredoc, a PowerShell here-string) are dropped and escapes resolved
 * first, as the destructive guard does. Also splits $(...) and shell-wrapper payloads
 * (bash -c "...", powershell -Command "..."). Fails open to the whole command on a parser error.
 */
export function installSegments(command: string, tool = 'Bash', depth = 0): string[] {
  try {
    const { segments, substitutions } = parseExecutable(normalizeEscapes(executableView(command, tool), tool));
    const found = segments.map(stripLeaders).filter((s) => needsCheck(s, tool));
    if (depth >= 3) return found;
    const nested = [...substitutions, ...wrapperPayloadsFromSegments(segments)];
    return [...found, ...nested.flatMap((inner) => installSegments(inner, tool, depth + 1))];
  } catch {
    return needsCheck(command, tool) ? [command.trim()] : [];
  }
}

/**
 * A segment needs a check when it names a package, a source or index the checks cannot read, or
 * is a lockfile install. A bare install (npm install, pip install -r file) does not.
 * A segment no pattern parses, but that holds an install outside quotes, also needs one:
 * an unknown leader (nice -n 5, xargs, a full path) must not hide the install (F10).
 */
function needsCheck(segment: string, tool: string): boolean {
  const a = analyzeInstall(segment);
  if (!a) return hiddenInstall(segment, tool);
  return a.packages.length > 0 || a.unparsed.length > 0 || a.customIndex.length > 0 || a.ambiguous.length > 0 || a.pattern.kind === 'lockfile';
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
  [/^(?:pip\d*(?:\.\d+)?|uv|pipx|pipenv)$/, word(PIP_VERBS)],
  [/^(?:uv|poetry)$/, /^add$/],
  [/^cargo$/, /^(?:add|install)$/],
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
  return commandWordInstall(segment);
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
const INDEX_CONFIG: RegExp[] = [
  /\b(?:PIP_(?:EXTRA_)?INDEX_URL|PIP_FIND_LINKS|PIP_CONFIG_FILE|UV_(?:EXTRA_|DEFAULT_)?INDEX(?:_URL)?|UV_FIND_LINKS|UV_CONFIG_FILE|npm_config_(?:registry|userconfig|globalconfig)|YARN_NPM_REGISTRY_SERVER|YARN_REGISTRY|YARN_RC_FILENAME|BUN_CONFIG_REGISTRY)\s*=/gi,
  /\bconfig\s+set\s+\S*(?:registry|userconfig|globalconfig|index|find-links)\S*/gi,
  /--(?:userconfig|globalconfig)\b/g,
  /--@[^\s=:]+:registry\b/g,
];

function indexConfigMarkers(command: string): string[] {
  return [...new Set(INDEX_CONFIG.flatMap((re) => [...command.matchAll(re)].map((m) => m[0].replace(/\s*=$/, ''))))];
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
  const ecosystemKey = ecosystem === 'pypi' ? 'pypi' : 'npm';

  // Only pypi and npm have blocklist entries currently
  if (ecosystemKey !== 'pypi' && ecosystemKey !== 'npm') {
    return { blocked: false };
  }

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

interface OsvResult {
  blocked: boolean;
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
    const vulns = await queryOsv(name, version, osvEcosystem);

    // Check for MAL- prefixed IDs (confirmed malware from OSSF)
    const malware = vulns.find((v: any) => v.id?.startsWith('MAL-'));
    if (malware) {
      return {
        blocked: true,
        advisoryId: malware.id,
        warning: `OSV.dev reports malware: ${malware.id}. ${malware.summary || malware.details?.slice(0, 200) || 'No details available'}.`,
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
      return {
        blocked: true,
        advisoryId: critical.id,
        warning: `OSV.dev reports CRITICAL vulnerability: ${critical.id}. ${critical.summary || 'No summary'}.`,
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
        warning: `OSV.dev reports HIGH severity vulnerability: ${high.id}. ${high.summary || 'No summary'}.`,
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
    const publishDate = await fetchPublishDate(name, ecosystem, requestedVersion);
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

function fetchPublishDate(
  name: string,
  ecosystem: 'pypi' | 'npm',
  requestedVersion?: string
): Promise<Date | null> {
  return new Promise((resolve) => {
    const url = ecosystem === 'pypi'
      ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
      : `https://registry.npmjs.org/${encodeURIComponent(name)}`;

    const timer = setTimeout(() => {
      resolve(null);
    }, 5000);

    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(publishDateFromRegistryJson(JSON.parse(data), ecosystem, requestedVersion));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timer);
      resolve(null);
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
function asksFor(segment: string, install: InstallAnalysis | null, cwd: string): string[] {
  if (!install) {
    return [`Install command the guard cannot parse: "${segment.slice(0, 200)}". No package check ran. Run it as a plain install (no wrapper or leader) or confirm it.`];
  }
  const asks: string[] = [];
  const { pattern } = install;
  if (pattern.kind === 'lockfile' && !['package-lock.json', 'npm-shrinkwrap.json'].some((f) => existsSync(join(cwd, f)))) {
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

/**
 * A node_modules/.bin/<name> file (or name.cmd, name.ps1) in npm's local prefix: the nearest
 * folder, cwd or an ancestor up to 10 levels, that holds package.json or node_modules.
 * Only that folder counts. npx fetches when the bin is missing there, even if a higher folder has it.
 */
function hasLocalBin(name: string, cwd: string): boolean {
  let dir = resolve(cwd);
  for (let level = 0; level < LOCAL_BIN_MAX_LEVELS; level++) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'node_modules'))) {
      const binDir = join(dir, 'node_modules', '.bin');
      return ['', '.cmd', '.ps1'].some((ext) => existsSync(join(binDir, name + ext)));
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

async function checkInstall(segment: string, cwd: string): Promise<InstallVerdict> {
  const install = analyzeInstall(segment);
  const asks = asksFor(segment, install, cwd);
  const advisories: string[] = [];
  const ecosystem = install?.pattern.ecosystem;
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') return { asks, advisories };
  // A runner that finds node_modules/.bin/<name> runs that file: nothing is fetched, so nothing to check.
  const packages = install!.packages.filter((p) => p !== install!.localBin || !hasLocalBin(p.name, cwd));

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
    const osvResult = await checkOsvAdvisory(pkg.name, pkg.version, ecosystem);
    if (osvResult.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: ${osvResult.warning} Advisory: ${osvResult.advisoryId}. Package: ${pkg.name}${pkg.version ? '@' + pkg.version : ''}. ${OVERRIDE}` };
    }
    if (osvResult.warning) advisories.push(`OSV ADVISORY: ${osvResult.warning}`);

    // F15 repair: npm install --tag next x installs the next tag, so age that one.
    const ageResult = await checkPackageAge(pkg.name, ecosystem, pkg.version ?? install!.tag);
    if (ageResult.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: ${ageResult.warning} Package: ${pkg.name}. ${OVERRIDE}` };
    }
    if (ageResult.warning) advisories.push(`PACKAGE ADVISORY: ${ageResult.warning}`);
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
  const installs = [...new Set(shell.dialects.flatMap((dialect) => installSegments(command, dialect)))];
  // F08: the override applies to the segment it prefixes, as a shell env assignment does.
  // A PowerShell `$env:SKIP_PACKAGE_GUARD=1;` first statement sets it for the whole command.
  const wholeOverride = PS_OVERRIDE.test(command);
  const checked = installs.filter((segment) => !wholeOverride && !checkOverride(segment));
  if (checked.length < installs.length) {
    logGuardDecision('package-install-guard', input, 'override', 'SKIP_PACKAGE_GUARD', { command });
  }
  if (checked.length === 0) {
    outputContinue();
    return;
  }

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const advisories: string[] = [];
  const asks: string[] = [];
  for (const segment of checked) {
    const result = await checkInstall(segment, cwd);
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
  const config = indexConfigMarkers(command);
  if (config.length > 0 && !asks.some((a) => a.startsWith('Custom package index'))) {
    asks.push(`Custom package index or config in the command: ${config.join(', ')}. The checks read the public PyPI or npm registry, not this index.`);
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

// Only run main() when executed as a standalone script, not when imported
// by vitest or other test runners. Vitest sets VITEST=true and
// VITEST_WORKER_ID in the environment.
if (!process.env.VITEST) {
  main().catch((err) => {
    // Fail-open: if the hook itself crashes, allow the command. Log the crash first.
    logGuardError('package-install-guard', err);
    outputContinue();
  });
}
