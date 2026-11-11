// check --diff: which changed files fall outside a lane's Owns list.
import { ownsMatch } from './owns.mjs';
import { git } from './git.mjs';
import { branchOf } from './pack.mjs';

// Pure. lanes is one branch group (a pack, or one lane): each has section.owns. A file is clean when any Owns entry
// of any lane in the group matches it (the union). Scope is ignored for the match. An entry outside git is skipped.
// A group with no lane, or only Owns: none, has every file outside.
export function outsideOwnsOf(lanes, files) {
  const owns = lanes.flatMap((lane) => lane.section?.owns ?? []).filter((e) => !e.outsideGit);
  return files.filter((file) => !owns.some((entry) => ownsMatch(entry, file)));
}

// One lane. Same as outsideOwnsOf([lane], files).
export const outsideOwns = (lane, files) => outsideOwnsOf([lane], files);

// The lanes (Waves lanes, then externals) that share the branch of lane `id`: its pack, or the lane alone.
// An unknown id gives an empty group.
export function packGroup(model, id) {
  const packs = model.packs ?? [];
  const all = [...model.lanes, ...model.externals];
  if (!all.some((l) => l.id === id)) return [];
  const branch = branchOf(id, packs);
  return all.filter((l) => branchOf(l.id, packs) === branch);
}

// Files changed on branch since it left base. Pass resolved commit ids. The trailing '--' marks the range as a revision,
// never a path. --no-renames lists the old path of a move too.
export function changedFiles(repo, baseSha, branchSha) {
  const out = git(repo, ['diff', '--name-only', '--no-renames', '-z', `${baseSha}...${branchSha}`, '--']);
  return out.split('\0').filter(Boolean);
}
