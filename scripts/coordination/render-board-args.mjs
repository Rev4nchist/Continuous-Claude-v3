/**
 * render-board-args -- the pure parts of render-board.mjs, kept apart so a test can import them without a database.
 *
 *   parseRenderArgs(argv)        --project <key>, --out <file>, --interactive, and the old positional [out.html]
 *   defaultOut(repo, board)      <repo>/lane-board.html for continuous-claude, <repo>/lane-board-<key>.html for any other board
 *   boardStamp / parseBoardStamp the <meta name="lane-board"> tag a page carries: board, template hash, generated time
 *   writeAtomic(file, text)      temp file in the same folder, then rename: a reader never sees half a page
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BOARD = 'continuous-claude';
const BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Reads the command line. An unknown flag, a flag with no value or a second output file is an error: `--project x` once became a file name.
 *  `--interactive` is a switch: it gives a board other than continuous-claude the interactive kanban (for a page that will be published). */
export function parseRenderArgs(argv) {
  const out = { project: null, out: null, interactive: false };
  const setOut = (value) => {
    if (out.out !== null) throw new Error('give one output file only (--out <file> or a positional file, not both)');
    out.out = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const name = eq ? eq[1] : a;
    if (name === '--interactive') {
      if (eq) throw new Error('--interactive takes no value');
      out.interactive = true;
    } else if (name === '--project' || name === '--out') {
      const value = eq ? eq[2] : argv[++i];
      if (value === undefined || value === '' || String(value).startsWith('--')) throw new Error(`${name} needs a value`);
      if (name === '--project') out.project = String(value);
      else setOut(String(value));
    } else if (a.startsWith('--')) {
      throw new Error(`unknown argument: ${a}`);
    } else {
      setOut(a);
    }
  }
  return out;
}

/** The default page for a board, in the repo root. A key that is not a plain board key never reaches a file name. */
export function defaultOut(repo, board) {
  if (!BOARD_KEY_RE.test(String(board))) throw new Error(`'${board}' is not a board key (lowercase letters, digits and dashes)`);
  return join(repo, board === DEFAULT_BOARD ? 'lane-board.html' : `lane-board-${board}.html`);
}

/** The identity tag of a page. Read it back with parseBoardStamp. */
export function boardStamp({ board, template, generated }) {
  return `<meta name="lane-board" content="board=${board};template=${template};generated=${generated}">`;
}

/** { board, template, generated } from a page, or null when it has no stamp. Accepts either quote style. */
export function parseBoardStamp(html) {
  const m = /<meta\s+name=["']?lane-board["']?\s+content=(?:"([^"]*)"|'([^']*)')/i.exec(String(html));
  if (!m) return null;
  const fields = Object.fromEntries((m[1] ?? m[2]).split(';').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  return { board: fields.board, template: fields.template, generated: fields.generated };
}

/** Writes `text` to a temp file beside `file`, then renames it over `file`. A failed write leaves the old file and no temp file. */
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw err;
  }
}
