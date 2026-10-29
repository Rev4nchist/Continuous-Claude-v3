/**
 * checkpoint-shapes-cli -- not a hook, never registered in settings.json. The ccv3-mods lock spawns the built file so the mod
 * holds no second shell lexer (memory: guard-shell-lexer-arms-race).
 *
 *   node dist/checkpoint-shapes-cli.mjs --shell bash|pwsh     the command text on stdin
 *
 * stdout, one JSON line, exit 0: the Shapes of shared/checkpoint-shapes.ts for the text with its continued lines joined, plus
 * `ccv3`: true when the text holds a visible CCv3 signal (namedRepo of the PR B gate). It prints no foreign repo.
 * exit 2, one stderr line, empty stdout: empty stdin, a missing --shell, or a --shell that is not bash or pwsh. The caller cannot
 * read "no shape" from a failure.
 */
import { joinContinuations, normalizeGh } from './pr-opened-review-loop.js';
import { CCV3_REPO, namedRepo, shapesOf } from './shared/checkpoint-shapes.js';

type Shell = 'bash' | 'pwsh';

export function shellArg(argv: string[]): Shell | null {
  const i = argv.indexOf('--shell');
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value === 'bash' || value === 'pwsh' ? value : null;
}

export function reportOf(text: string, shell: Shell): string {
  // The gate's order: join continued lines, normalize gh.exe / "gh", then read.
  const joined = normalizeGh(joinContinuations(text, shell));
  return JSON.stringify({ ...shapesOf(joined), ccv3: namedRepo(joined, {}) === CCV3_REPO });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const shell = shellArg(process.argv.slice(2));
  if (shell === null) {
    process.stderr.write('checkpoint-shapes-cli: --shell bash|pwsh is required\n');
    process.exitCode = 2;
    return;
  }
  const text = await readStdin();
  if (text.trim() === '') {
    process.stderr.write('checkpoint-shapes-cli: empty stdin: pass the command text on stdin\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${reportOf(text, shell)}\n`);
}

// Auto-run only as the CLI. A VITEST check would also stop a child spawned by a test, which inherits VITEST.
if ((process.argv[1] || '').includes('checkpoint-shapes-cli')) {
  main().catch((err) => {
    process.stderr.write(`checkpoint-shapes-cli: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
