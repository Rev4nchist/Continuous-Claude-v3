// Pure helpers that clean the findings of a review answer. No file or process access.
//   repairJsonText(text)               fixed JSON text, or null when the text needs no repair or cannot be repaired safely
//   filterFindingPaths(findings, ok)   { kept, dropped: [{ file, title }] }: drops findings on files that are not in the reviewed tree
//
// The repair is conservative. It fixes brackets and trailing commas only. It never adds a key, a value or a character
// inside a string. If the text ends inside a string, or after a key or a comma with no value, it gives up.

const CLOSER = { '{': '}', '[': ']' };
const OPENER = { '}': '{', ']': '[' };

/** Closers for the open brackets on the stack, innermost first, until `want` (an opener) is on top. null if `want` is not open. */
function closersUntil(stack, want) {
  const at = stack.lastIndexOf(want);
  return at < 0 ? null : stack.slice(at + 1).reverse().map((o) => CLOSER[o]);
}

/** Drops a comma that sits just before a closer (the last non-space output character). */
function dropTrailingComma(out) {
  const at = out.length - 1 - [...out].reverse().findIndex((c) => !/\s/.test(c));
  return out[at] === ',' ? out.slice(0, at) + out.slice(at + 1) : out;
}

/** Walks the text outside strings. Returns the rebuilt text, or null when it cannot be balanced safely. */
function rebalance(text) {
  const stack = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { i += 1; out += text[i] ?? ''; } else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; }
    else if (c === '{' || c === '[') { stack.push(c); out += c; }
    else if (c === '}' || c === ']') {
      const extra = closersUntil(stack, OPENER[c]);
      if (extra === null) return null;
      out = dropTrailingComma(out) + extra.join('') + c;
      stack.length -= extra.length + 1;
    } else out += c;
  }
  if (inString) return null;
  const tail = stack.reverse().map((o) => CLOSER[o]).join('');
  return tail ? dropTrailingComma(out) + tail : out;
}

export function repairJsonText(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try { JSON.parse(text); return null; } catch { /* needs a look */ }
  const fixed = rebalance(text);
  if (fixed === null) return null;
  try { JSON.parse(fixed); return fixed; } catch { return null; }
}

const lookupForm = (file) => file.trim().replace(/\\/g, '/').replace(/^\.\//, '');

/** Keeps '(unspecified)' (flagged elsewhere). `exists(path)` checks the reviewed tree. The kept findings are not changed. */
export function filterFindingPaths(findings, exists) {
  const kept = [];
  const dropped = [];
  for (const f of findings) {
    if (f.file === '(unspecified)' || exists(lookupForm(String(f.file ?? '')))) kept.push(f);
    else dropped.push({ file: f.file, title: f.title });
  }
  return { kept, dropped };
}
