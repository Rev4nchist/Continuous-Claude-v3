/**
 * commandRepo of shared/checkpoint-shapes.ts (card coord-decision-gate-app-repos, seat answer S4, rule R5c).
 *
 * commandRepo(text, mtext, env) gives the lowercased owner/repo that a gh command names, or null. `mtext` is `text` with its quoted
 * strings blanked (maskQuoted). The gate compares it with the key repo of a covered folder, and from a CCv3 folder it refuses a command
 * that names another repo. namedRepo stays as it was: every row also pins namedRepo, and the namedRepo cases ran green on the file
 * before commandRepo was added.
 *
 * How it can fail, and the source change that turns a row red:
 *   a source of the repo is not read (-R, --repo, GH_REPO=, env GH_REPO, gh api path, PR URL of merge/view/ready) -> drop that source: its row
 *   prose names a repo: a --body, --title or heredoc URL, a chained gh call (F1)  -> read the raw text or the whole text: j1, j2, k1 to k7
 *   a quoted value where gh takes a repo is lost (-R "x", "repos/..", 'URL')     -> read the masked view only: k8 to k11
 *   a URL counts outside merge/view/ready, an api path outside gh api           -> drop the shape test: d2, k13, k14
 *   the slug keeps its case or its .git                                       -> remove toLowerCase or the .git strip: rows a3, a4, f2
 *   two different repos give one of them (gh may use the last -R)           -> "first wins" or "last wins": rows g1, g2
 *   a placeholder or variable value reads as a repo                            -> loosen the value pattern: rows e2, e3, e4
 *   the default env is process.env, so a shell GH_REPO leaks into the gate   -> default env = process.env: row h1
 *   namedRepo changes (it must still name CCv3 or nothing)                  -> any edit of namedRepo or its regexes: the namedRepo cases
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as shapes from '../shared/checkpoint-shapes.js';
import { CCV3_REPO, commandRepo, namedRepo } from '../shared/checkpoint-shapes.js';
// Fix round 2 (fixer G): through the namespace, so a missing export fails its own rows only.
const priorGhRepo = (text: string, mtext: string): unknown => (shapes as unknown as { priorGhRepo: (t: string, m: string) => unknown }).priorGhRepo(text, mtext);
import { maskQuoted } from '../shared/mask-quotes.js';

process.env.CCV3_DECISIONS_FILE = '/nonexistent-scratch/decisions.json';
process.env.LANE_REGISTRY_PATH = '/nonexistent-scratch/project-registry.json';

type Env = Record<string, string>;
interface Row { id: string; text: string; env?: Env; repo: string | null; named: string | null }

const ROWS: Row[] = [
  { id: 'a1', text: 'gh pr create -R Acme/App --draft', repo: 'acme/app', named: null },
  { id: 'a2', text: 'gh pr merge 5 --repo acme/app', repo: 'acme/app', named: null },
  { id: 'a3', text: 'gh pr merge 5 --repo=Acme/App.git', repo: 'acme/app', named: null },
  { id: 'a4', text: 'gh pr view -R https://github.com/Acme/App', repo: 'acme/app', named: null },
  { id: 'a5', text: 'gh pr merge -R github.com/acme/app 5', repo: 'acme/app', named: null },
  { id: 'a6', text: 'gh pr merge -Racme/app 5', repo: 'acme/app', named: null },
  { id: 'b1', text: 'GH_REPO=acme/app gh pr create --draft', repo: 'acme/app', named: null },
  { id: 'b3', text: 'gh pr create --draft', env: { GH_REPO: 'Acme/App' }, repo: 'acme/app', named: null },
  { id: 'c1', text: 'gh api -X PUT repos/acme/app/pulls/5/merge', repo: 'acme/app', named: null },
  { id: 'c2', text: 'gh api -X PUT /repos/Acme/App/pulls/5/merge', repo: 'acme/app', named: null },
  { id: 'c3', text: 'gh api repos/acme/app/issues/5/labels -f labels[]=x', repo: 'acme/app', named: null },
  { id: 'c4', text: 'gh api repos/acme/app', repo: 'acme/app', named: null },
  { id: 'd1', text: 'gh pr merge https://github.com/Acme/App/pull/7 --squash', repo: 'acme/app', named: null },
  // F1: a URL counts only as the argument of gh pr merge, view or ready (the shapes the gate judges), not of gh issue.
  { id: 'd2', text: 'gh issue view https://github.com/acme/app/issues/3', repo: null, named: null },
  { id: 'e1', text: 'gh pr create --draft', repo: null, named: null },
  { id: 'e2', text: 'gh pr merge -R $REPO 5', repo: null, named: null },
  { id: 'e3', text: 'gh api repos/{owner}/{repo}/pulls', repo: null, named: null },
  { id: 'e4', text: 'gh pr create --draft', env: { GH_REPO: '$X' }, repo: null, named: null },
  { id: 'e5', text: 'gh pr merge -r acme/app 5', repo: null, named: null },
  { id: 'e6', text: 'git push fork feat/x', repo: null, named: null },
  { id: 'f1', text: 'gh pr merge 5 -R Rev4nchist/Continuous-Claude-v3', repo: CCV3_REPO, named: CCV3_REPO },
  { id: 'f2', text: 'gh pr merge https://github.com/Rev4nchist/continuous-claude-v3/pull/9', repo: CCV3_REPO, named: CCV3_REPO },
  { id: 'f3', text: 'gh api -X PUT repos/rev4nchist/continuous-claude-v3/pulls/9/merge', repo: CCV3_REPO, named: CCV3_REPO },
  { id: 'f4', text: 'gh pr create --draft', env: { GH_REPO: 'Rev4nchist/Continuous-Claude-v3.git' }, repo: CCV3_REPO, named: CCV3_REPO },
  { id: 'g1', text: 'gh pr merge -R other/lib -R acme/app 5', repo: 'acme/app other/lib', named: null },
  { id: 'g2', text: 'gh pr merge -R acme/app --repo rev4nchist/continuous-claude-v3 5', repo: `acme/app ${CCV3_REPO}`, named: CCV3_REPO },
  { id: 'g3', text: 'gh pr merge -R Acme/App https://github.com/acme/app/pull/5', repo: 'acme/app', named: null },
  { id: 'g4', text: 'gh pr create --draft', env: { GH_REPO: 'other/lib' }, repo: 'other/lib', named: null },
  { id: 'g5', text: 'gh pr create --draft -R acme/app', env: { GH_REPO: 'other/lib' }, repo: 'acme/app other/lib', named: null },
  // F1: quoted text is prose, not a place gh reads a repo: a title that holds a repos/ path names no repo.
  { id: 'g6', text: 'gh pr create --draft --title "see repos/acme/app/ now"', repo: null, named: null },
  { id: 'c5', text: 'gh api https://api.github.com/repos/Acme/App/pulls/5/merge -X PUT', repo: 'acme/app', named: null },
  { id: 'c6', text: 'gh api -X PUT --input=x.json repos/acme/app/pulls/5/merge', repo: 'acme/app', named: null },
  // A folder path that holds repos/ is not a REST path (change: drop the argument-start anchor of ANY_REPOS_PATH).
  { id: 'i1', text: 'cd ~/repos/acme/app && gh pr create --draft', repo: null, named: null },
  { id: 'i2', text: 'gh pr create --draft --body-file docs/repos/a/b.md', repo: null, named: null },
  // F1: only the gh call's own segment is read (the gate passes that segment): -R of another command names no repo.
  { id: 'j1', text: 'ls -R src/shared && gh pr create --draft', repo: null, named: null },
  // F1: a URL in a --body, a --title or a heredoc names no repo.
  { id: 'j2', text: 'gh pr create --draft --body "see https://github.com/other/lib/issues/3"', repo: null, named: null },
  { id: 'k1', text: 'gh pr create --draft --title t --body "Works around https://github.com/anthropics/claude-code/issues/1234"', repo: null, named: null },
  { id: 'k2', text: 'gh pr merge 5 --body "fixes https://github.com/other/lib/pull/2 and repos/other/lib/"', repo: null, named: null },
  { id: 'k3', text: 'gh pr create --draft --body "$(cat <<\'EOF\'\nsee https://github.com/other/lib/pull/3\nrepos/other/lib/pulls\nEOF\n)"', repo: null, named: null },
  { id: 'k4', text: 'gh pr create --draft --body-file - <<\'EOF\'\nsee https://github.com/other/lib/pull/3 -R other/lib\nEOF', repo: null, named: null },
  { id: 'k5', text: 'gh pr merge 5 -t "x -R other/lib --repo=other/lib"', repo: null, named: null },
  // F1: a chained second gh call names no repo for the first.
  { id: 'k6', text: 'gh pr create --draft && gh pr view 3 -R other/lib', repo: null, named: null },
  { id: 'k7', text: 'gh pr merge 5 --squash; gh api repos/other/lib/pulls/5', repo: null, named: null },
  // F1: where gh takes a repo, a quoted value is read raw: -R "x", a quoted api path, a quoted PR URL argument.
  { id: 'k8', text: 'gh pr merge 5 -R "Other/Lib"', repo: 'other/lib', named: null },
  { id: 'k9', text: 'gh api -X PUT "repos/other/lib/pulls/5/merge" -f sha=x', repo: 'other/lib', named: null },
  { id: 'k10', text: "gh pr merge 'https://github.com/other/lib/pull/7' --squash", repo: 'other/lib', named: null },
  { id: 'k11', text: 'GH_REPO="other/lib" gh pr create --draft', repo: 'other/lib', named: null },
  // F1: the api path names the repo, a quoted field of the same call does not.
  { id: 'k12', text: 'gh api -X PUT repos/acme/app/pulls/5/merge -f commit_message="see repos/other/lib/ now"', repo: 'acme/app', named: null },
  // F1: a PR URL counts for gh pr merge, view or ready, not for a create; an api path counts for gh api only.
  { id: 'k13', text: 'gh pr create --draft https://github.com/other/lib/pull/3', repo: null, named: null },
  { id: 'k14', text: 'gh pr create --draft --body-file repos/other/lib/x.md', repo: null, named: null },
  { id: 'k15', text: 'gh pr ready https://github.com/acme/app/pull/3', repo: 'acme/app', named: null },
  // commandRepo reads only the gh segment it is given; an earlier segment's GH_REPO comes in through priorGhRepo (fixer G, item 5, below).
  { id: 'b2', text: "$env:GH_REPO='acme/app'; gh pr create --draft", repo: null, named: null },
  // F1: a --title URL names no repo; the & of a redirect (2>&1, &>) ends no segment (change: cut at every &).
  { id: 'k17', text: 'gh pr merge 5 -t "see https://github.com/other/lib/pull/2"', repo: null, named: null },
  { id: 'k18', text: 'gh pr merge 5 2>&1 -R other/lib', repo: 'other/lib', named: null },
  { id: 'k19', text: 'gh pr merge 5 &>log.txt --repo other/lib', repo: 'other/lib', named: null },
  // A segment with no gh call names no repo.
  { id: 'k16', text: 'git push -R acme/app', repo: null, named: null },
];

describe('namedRepo is unchanged (CCv3 slug or null)', () => {
  for (const r of ROWS) {
    it(`${r.id}: ${r.text}`, () => {
      expect(namedRepo(r.text, r.env ?? {})).toBe(r.named);
    });
  }
});

describe('commandRepo', () => {
  for (const r of ROWS) {
    it(`${r.id}: ${r.text}`, () => {
      expect(commandRepo(r.text, maskQuoted(r.text), r.env ?? {})).toBe(r.repo);
    });
  }
});

describe('commandRepo default env', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('h1: the shell GH_REPO is not read when no env is passed', () => {
    vi.stubEnv('GH_REPO', 'acme/app');
    expect(commandRepo('gh pr create --draft', 'gh pr create --draft')).toBeNull();
  });
});

// Fix round 2, fixer G (item 5, fixer A open issue): a GH_REPO set in ANY earlier segment names the repo of the gh call. priorGhRepo
// reads the text before the gh segment (assignment outside quotes, value raw); commandRepo takes its repos as a fourth argument.
describe('priorGhRepo: GH_REPO assignments before the gh segment', () => {
  const rows: [string, string, string[], boolean][] = [
    ['p1', 'GH_REPO=Acme/App; ', ['acme/app'], false],
    ['p2', 'export GH_REPO=acme/app && ', ['acme/app'], false],
    ['p3', 'env GH_REPO=acme/app; ', ['acme/app'], false],
    ['p4', "$env:GH_REPO='acme/app'; ", ['acme/app'], false],
    ['p5', '$env:GH_REPO="https://github.com/acme/app"; ', ['acme/app'], false],
    ['p6', 'export GH_REPO=$X; ', [], true],
    ['p7', 'echo "GH_REPO=other/lib"; ', [], false],
    ['p8', 'ls -R $D && ', [], false],
    ['p9', 'GH_REPO=a/b; GH_REPO=c/d; ', ['a/b', 'c/d'], false],
  ];
  // Change that breaks it: read the raw text (p7 names other/lib), read only the gh segment (p1 to p5 name nothing), or treat a variable as no value (p6).
  for (const [id, text, repos, nonLiteral] of rows) {
    it(`${id}: ${text}`, () => {
      expect(priorGhRepo(text, maskQuoted(text))).toEqual({ repos, nonLiteral });
    });
  }
  it('p10: commandRepo merges the earlier repos with its own: one repo, or every slug sorted', () => {
    const own = 'gh pr merge 5';
    expect(commandRepo(own, own, {}, ['acme/app'])).toBe('acme/app');
    expect(commandRepo(`${own} -R other/lib`, `${own} -R other/lib`, {}, ['acme/app'])).toBe('acme/app other/lib');
    expect(commandRepo(own, own, {}, [])).toBeNull();
  });
});

describe('commandRepo reads the masked view the caller passes', () => {
  // Change that breaks it: read the flags from the raw text instead of confirming them in the masked view.
  it('m1: the same text with the body unmasked by the caller names the body repo; masked, it names none', () => {
    const text = 'gh pr create --draft --body "x https://github.com/other/lib/pull/3 -R other/lib"';
    expect(commandRepo(text, maskQuoted(text))).toBeNull();
    expect(commandRepo(text, text.replace(/"/g, ' '))).toBe('other/lib');
  });
});
