import { redact } from './redact';
import { scrubPathsInText } from './safe-message';

/** A secret prefix at the very end of the text. The heartbeat hook stores only the first 100
 *  characters of a prompt, so a token can be cut in half there and then no longer matches the
 *  full-token rules of `redact`. */
const CUT_TOKEN_TAIL =
  /(?:sk-[A-Za-z0-9_-]*|ghp_[A-Za-z0-9]*|gho_[A-Za-z0-9]*|ghs_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*|xox[baprs]-[A-Za-z0-9-]*|(?:AKIA|ASIA)[A-Z0-9]*|AIza[0-9A-Za-z_-]*)$/;

/** The prompt line the fleet strip shows: secrets and a cut-off secret tail removed, absolute
 *  paths replaced by `<path>`, then clipped. Redact and scrub run on the whole value before the
 *  display clip, so a clip cannot split a token or a path. */
export function promptText(raw: string, max: number): string {
  const scrubbed = scrubPathsInText(redact(raw).text);
  return scrubbed.replace(CUT_TOKEN_TAIL, '[REDACTED:provider_token]').slice(0, max);
}
