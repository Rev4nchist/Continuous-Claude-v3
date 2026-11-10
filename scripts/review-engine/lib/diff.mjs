// check --diff: which changed files fall outside a lane's Owns list.
import { ownsMatch } from './owns.mjs';
import { git } from './git.mjs';

// Pure. lane has section.owns. Scope is ignored for the match. An entry outside git is skipped.
// A lane with Owns: none has an empty list, so every file is outside.
export function outsideOwns(lane, files) {
  const owns = (lane.section?.owns ?? []).filter((e) => !e.outsideGit);
  return files.filter((file) => !owns.some((entry) => ownsMatch(entry, file)));
}

// Files changed on branch since it left base. Pass resolved commit ids. The trailing '--' marks the range as a revision,
// never a path. --no-renames lists the old path of a move too.
export function changedFiles(repo, baseSha, branchSha) {
  const out = git(repo, ['diff', '--name-only', '--no-renames', '-z', `${baseSha}...${branchSha}`, '--']);
  return out.split('\0').filter(Boolean);
}
