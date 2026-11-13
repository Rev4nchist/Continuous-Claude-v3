// fixture-gap.mjs: a fact for the reviewer, never a gate.
// A changed parser, guard or lexer source file with no entry in the parser-fixtures registry has no property test behind it.
// The word list lives here, so a new word is one edit in one place.
import { REGISTRY } from './parser-fixtures/registry.mjs';

/** Basename patterns of files that parse, guard or clean text. Matched on the file name only, not on the folders. */
export const GAP_PATTERNS = Object.freeze([/(parse|parser|lexer|guard|sanitiz|scrub|tokeniz)/i]);

/** Source extensions the registry can run. */
const SOURCE_EXT = /\.(mjs|js|ts)$/;
/** A test, spec, test helper or test util file: .test.* .spec.* .test-helpers.* or a name with test-utils. */
const TEST_FILE = /\.(?:test|spec|test-helpers)\.[^/]+$|test-utils/i;
/** The fixture runner and its inputs hold the word "parser" but are not parsers. */
export const GAP_EXCLUDE = Object.freeze(['scripts/checks/parser-fixtures.mjs']);

const norm = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '');

/** True for a source file that the gap check looks at. */
function onList(file) {
  if (!SOURCE_EXT.test(file) || TEST_FILE.test(file)) return false;
  if (file.split('/').some((d) => d === 'dist' || d === '__tests__')) return false;
  if (GAP_EXCLUDE.includes(file) || file.startsWith('scripts/checks/parser-fixtures/')) return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  return GAP_PATTERNS.some((re) => re.test(base));
}

/** files: changed paths. registry: entries with a `file`. Returns { files }: listed files with no registry entry. */
export function fixtureGap(files, registry = REGISTRY) {
  const registered = new Set(registry.map((e) => norm(e.file)));
  const listed = (files ?? []).map(norm).filter(onList);
  return { files: [...new Set(listed)].filter((f) => !registered.has(f)) };
}
