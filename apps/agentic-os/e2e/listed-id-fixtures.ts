/**
 * Made-up fixtures for the listed-id mask specs (card agentic-os-listed-id-mask). NOT a spec file: the pure config matches by name.
 *
 * Every value here is invented. They are the same made-up values as scripts/coordination/board-mask.test.mjs (a 4-digit PR number, a 10-digit
 * comment id, their key, one sha), so no real listed id is typed in the app. A made-up number can still equal a real one: the seat counts
 * every new file of the branch against the real list before pre-pr.
 */

export const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
export const PR = '4242';
export const COMMENT = '9000000123';
export const KEY = `${PR}:${COMMENT}`;
/** A listed id that is neither a number, a key nor a sha (a non-digit comment id): the "word" form of the mask. */
export const WORD_ID = 'IC_kwmade';
/** A made-up gold sha and PR number, in the shape of the gold folder (a row with target.pr and a sha field). */
export const GOLD_SHA = '1234abcd5678ef901234abcd5678ef90';
export const GOLD_PR = 6161;

export const DS = { prs: [{ pr: Number(PR) }], findings: [{ pr: Number(PR), comment_id: Number(COMMENT), round: SHA }] };
export const IDS = [PR, COMMENT, KEY, SHA];
export const IDS_WITH_WORD = [...IDS, WORD_ID];

/** Texts for the mask: each one holds a made-up listed id in one form, or none. `masks` says whether the mask must change it. */
export const TEXTS: { label: string; text: string; masks: boolean }[] = [
  { label: '#N', text: `landed in #${PR} today`, masks: true },
  { label: 'PR N', text: `see PR ${PR} now`, masks: true },
  { label: 'PR #N', text: `see PR #${PR} now`, masks: true },
  { label: 'pull/N', text: `https://github.com/o/r/pull/${PR}/files`, masks: true },
  { label: 'comment id as a bare run', text: `comment ${COMMENT} said`, masks: true },
  { label: 'key', text: `finding ${KEY} open`, masks: true },
  { label: 'full sha', text: `head ${SHA} pushed`, masks: true },
  { label: 'short sha (10 of 40)', text: `head ${SHA.slice(0, 10)} pushed`, masks: true },
  { label: 'upper case sha', text: `head ${SHA.toUpperCase()} pushed`, masks: true },
  { label: 'sha inside a hex run over 40', text: `blob ${SHA}ffff end`, masks: true },
  { label: 'word id, upper case', text: `see ${WORD_ID.toUpperCase()} now`, masks: true },
  { label: 'word id with the Kelvin sign', text: `see IC_Kwmade now`, masks: true },
  { label: 'fullwidth digits after #', text: `landed in #${[...PR].map((d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0)).join('')} today`, masks: true },
  { label: 'zero-width mark inside the number', text: `see PR ${PR.slice(0, 2)}​${PR.slice(2)} now`, masks: true },
  { label: 'PR then 7 spaces then the number', text: `see PR${' '.repeat(7)}${PR} now`, masks: true },
  { label: 'a bare short number, no context', text: `build ${PR} passed`, masks: false },
  { label: 'a number that is not listed', text: 'see PR 17 now', masks: false },
  { label: 'a hex run that is not a listed sha', text: 'head 0123456789abcdef pushed', masks: false },
  { label: 'plain text', text: 'the lane waits on the seat', masks: false },
  { label: 'empty text', text: '', masks: false },
];

export type TreeKind = 'good' | 'absent' | 'bad-json' | 'no-config' | 'empty' | 'excluded-all' | 'gold-missing' | 'gold-broken' | 'gold-wrong-shape';
export const TREE_KINDS: TreeKind[] = ['good', 'absent', 'bad-json', 'no-config', 'empty', 'excluded-all', 'gold-missing', 'gold-broken', 'gold-wrong-shape'];

const goldRows = [{ target: { pr: GOLD_PR }, head: GOLD_SHA }];

/**
 * A fake file tree for readIdList / loadListedIds: `read` and `list` take the paths the loader builds (either slash), `rel` names the three
 * paths. A missing file throws an ENOENT error like fs does.
 */
export function makeTree(kind: TreeKind, rel: { dataset: string; config: string; goldDir: string }, root = 'ROOT') {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const at = (r: string) => `${root}/${r}`;
  const dataset = kind === 'empty' ? { prs: [], findings: [] } : DS;
  const config = kind === 'excluded-all' ? { holdoutExclude: [Number(PR)] } : {};
  if (kind !== 'absent') files.set(at(rel.dataset), kind === 'bad-json' ? '{ not json' : JSON.stringify(dataset));
  if (kind !== 'absent' && kind !== 'no-config') files.set(at(rel.config), JSON.stringify(config));
  if (kind !== 'gold-missing') {
    dirs.set(at(rel.goldDir), ['rows.json', 'escape-baseline.json']);
    files.set(at(`${rel.goldDir}/rows.json`), kind === 'gold-broken' ? '[ not json' : JSON.stringify(kind === 'gold-wrong-shape' ? { rows: 1 } : goldRows));
    files.set(at(`${rel.goldDir}/escape-baseline.json`), '{}');
  }
  const enoent = (): never => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    root,
    read: (p: string): string => files.get(norm(p)) ?? enoent(),
    list: (d: string): string[] => dirs.get(norm(d)) ?? enoent(),
  };
}
