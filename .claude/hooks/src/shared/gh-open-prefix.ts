/**
 * The global options that may stand between `gh` and `pr` (`gh -R owner/repo pr create`, `gh --repo=owner/repo pr create`): 1 to 6 plain tokens,
 * each after horizontal space only. A token is letters, digits and . / : = @ - ; any other character (`;`, `&`, `|`, `$(`, a backtick, a quote)
 * or a line end ends the match, so a text this piece does not read is read as before (no open).
 *
 * One shared piece (PR 592, seat ruling V7.6: no second hand copy): the recognizer `PR_CREATE_RE` in pr-opened-review-loop.ts and
 * `OPEN_SEGMENT` in pre-pr-gate.ts both build from it.
 */
export const GH_OPT_PREFIX = String.raw`(?:[^\S\r\n]+[\w.\/:=@-]+){1,6}?`;
