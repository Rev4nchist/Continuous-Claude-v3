/**
 * destructive-command-guard — Phase 1a SAFE-floor tests (D2g-02 / GAP3-01)
 *
 * Verifies: (1) curated destructive set is caught incl. compound commands;
 * (2) routine dev commands are NOT false-flagged; (3) fail-CLOSED in unattended
 * contexts (deny, never an interactive ask that would hang); (4) ask in
 * interactive; (5) SKIP_DESTRUCTIVE_GUARD override.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDestructive,
  isUnattended,
  decide,
  stripQuotedStrings,
  parseExecutable,
  extractShellWrapperPayloads,
} from '../destructive-command-guard.js';

describe('no false-positive on destructive keywords inside string literals', () => {
  it('git commit -m with destructive words in the message → allow', () => {
    const cmd = 'git commit -m "set (recursive rm, git reset --hard / force-push / clean -f)"';
    expect(classifyDestructive(cmd)).toBeNull();
  });
  it('echo of destructive text → allow', () => {
    expect(classifyDestructive(`echo "to undo: git reset --hard HEAD~1"`)).toBeNull();
  });
  it('node -e diagnostic containing destructive strings → allow', () => {
    expect(classifyDestructive(`node -e "console.log('rm -rf and git push --force')"`)).toBeNull();
  });
  it('BUT a real destructive op alongside a quoted message is still caught', () => {
    expect(classifyDestructive('git commit -m "ok" && rm -rf build')).toBe('recursive rm');
  });
  it('stripQuotedStrings removes both quote styles', () => {
    expect(stripQuotedStrings('a "x y" b \'z\' c')).toBe('a "" b \'\' c');
  });
});

describe('override via command-string prefix (PreToolUse hooks do not inherit inline env)', () => {
  it('SKIP_DESTRUCTIVE_GUARD=1 prefix in the command → allow even destructive, even unattended', () => {
    expect(decide('SKIP_DESTRUCTIVE_GUARD=1 rm -rf build', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('allow');
  });
});

describe('classifyDestructive — catches high-blast-radius ops', () => {
  const destructive = [
    'rm -rf build',
    'rm -fr ./dist',
    'cd /tmp && rm -rf important',            // compound
    'git reset --hard HEAD~3',
    'git push --force origin main',
    'git push origin main -f',
    'git push --force-with-lease',
    'git push origin --delete oldbranch',
    'git clean -fdx',
    'git checkout -- src/app.ts',
    'git checkout .',
    'git branch -D feature/x',
    'git rebase main',
    'git stash clear',
    'git reflog expire --expire=now --all',
    'git gc --prune=now',
    'git filter-branch --tree-filter foo',
    'find . -name "*.tmp" -delete',
    'find . -type f -exec rm {} \\;',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'shred -u secrets.txt',
    'truncate -s 0 important.log',
    'docker system prune -a',
    'docker volume rm pgdata',
    'docker rm -f mycontainer',
    'sudo rm -rf /var/lib/x',                  // command-prefixed (sudo) still caught — unquoted
  ];
  for (const cmd of destructive) {
    it(`flags: ${cmd.slice(0, 42)}`, () => {
      expect(classifyDestructive(cmd)).not.toBeNull();
    });
  }
});

describe('classifyDestructive — does NOT false-flag routine dev', () => {
  const safe = [
    'git status',
    'git add -A',
    'git commit -m "fix"',
    'git push origin main',                    // non-force push
    'git log --oneline -5',
    'git diff HEAD',
    'git checkout -b new-feature',             // create branch, not discard
    'git checkout main',                       // switch branch
    'rm -f .git/index.lock',                   // single-file force, not recursive
    'rm package-lock.json',
    'npm run build',
    'node scripts/x.mjs',
    'cp a.ts b.ts',
    'mkdir -p out',
    'grep -r "DROP TABLE" migrations/',        // search text containing SQL, not exec
    'ls -la',
    'docker ps -a',
    'docker exec pg psql -c "SELECT 1"',
    'bash scripts/sync-to-active.sh',
    'cat findings.json',
  ];
  for (const cmd of safe) {
    it(`allows: ${cmd.slice(0, 42)}`, () => {
      expect(classifyDestructive(cmd)).toBeNull();
    });
  }
});

describe('isUnattended', () => {
  it('bypassPermissions → unattended', () => {
    expect(isUnattended({ permission_mode: 'bypassPermissions' }, {})).toBe(true);
  });
  it('CLAUDE_AGENT_ID (subagent) → unattended', () => {
    expect(isUnattended({ permission_mode: 'default' }, { CLAUDE_AGENT_ID: 'abc' })).toBe(true);
  });
  it('CI → unattended', () => {
    expect(isUnattended({ permission_mode: 'default' }, { CI: 'true' })).toBe(true);
  });
  it('interactive default → attended', () => {
    expect(isUnattended({ permission_mode: 'default' }, {})).toBe(false);
  });
  it('acceptEdits → attended', () => {
    expect(isUnattended({ permission_mode: 'acceptEdits' }, {})).toBe(false);
  });
});

describe('decide — ask interactive, deny unattended, never hang', () => {
  it('destructive + interactive → ask (prompt the human)', () => {
    expect(decide('git push --force', { permission_mode: 'default' }, {}).decision).toBe('ask');
  });
  it('destructive + bypass → deny (fail-closed, no hang)', () => {
    expect(decide('git push --force', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('deny');
  });
  it('destructive + subagent → deny (fail-closed)', () => {
    expect(decide('rm -rf x', { permission_mode: 'default' }, { CLAUDE_AGENT_ID: 'a' }).decision).toBe('deny');
  });
  it('safe command → allow in every mode', () => {
    expect(decide('git status', { permission_mode: 'default' }, {}).decision).toBe('allow');
    expect(decide('git status', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('allow');
  });
  it('SKIP_DESTRUCTIVE_GUARD=1 env → allow even destructive', () => {
    expect(decide('rm -rf x', { permission_mode: 'default' }, { SKIP_DESTRUCTIVE_GUARD: '1' }).decision).toBe('allow');
  });
});

describe('F3 — split-flag recursive deletion is caught (not just -rf)', () => {
  const splitDestructive = [
    'rm -f -r build',
    'rm -i -r build',
    'rm --force --recursive build',
    'rm --force -r build',
    'sudo rm -f -r /var/x',
    'cd x && rm -f -r y',
    'git clean -d -f',
    'git clean -x -d -f',
    'docker rm --force mycontainer',
  ];
  for (const cmd of splitDestructive) {
    it(`flags split-flag: ${cmd.slice(0, 40)}`, () => {
      expect(classifyDestructive(cmd)).not.toBeNull();
    });
  }
  it('still does NOT flag non-recursive single-file rm', () => {
    expect(classifyDestructive('rm -f .git/index.lock')).toBeNull();
    expect(classifyDestructive('rm -i config.json')).toBeNull();
  });
});

describe('F2 — SKIP override only as a LEADING prefix, never a substring', () => {
  it('leading prefix → allow', () => {
    expect(decide('SKIP_DESTRUCTIVE_GUARD=1 rm -rf build', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('allow');
  });
  it('substring elsewhere does NOT bypass (the exploit)', () => {
    expect(decide('echo SKIP_DESTRUCTIVE_GUARD=1 && rm -rf build', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('deny');
    expect(decide('rm -rf build # SKIP_DESTRUCTIVE_GUARD=1', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('deny');
  });
});

describe('Phase 1b — shell-wrapper recursion (closes the stripQuotedStrings blind spot)', () => {
  const wrapped = [
    'bash -c "rm -rf /tmp/x"',
    "bash -c 'rm -rf build'",
    'sh -c "rm -rf node_modules"',
    'bash -lc "git reset --hard HEAD~2"',          // combined flag cluster ending in c
    'bash --norc -c "git push --force origin main"',
    'sudo bash -c "rm -rf /var/x"',
    'powershell -Command "rm -rf C:/tmp/x"',
    'pwsh -c "rm -rf /x"',
    'cmd /c "rm -rf build"',
    'cmd.exe /c "git clean -fdx"',
    'cd /tmp && bash -c "rm -rf y"',               // wrapper in a later segment
    'bash -c "cd src && rm -rf dist"',             // destructive inside the payload
    'bash -c "bash -c \\"rm -rf deep\\""',         // nested wrapper (depth recursion)
  ];
  for (const cmd of wrapped) {
    it(`flags wrapped: ${cmd.slice(0, 44)}`, () => {
      expect(classifyDestructive(cmd)).not.toBeNull();
    });
  }
});

describe('Phase 1b — command-substitution recursion (the commit-message backtick incident class)', () => {
  const subst = [
    'git commit -m "deploy $(rm -rf build)"',      // $() in double quotes EXECUTES
    'echo "cleanup `git reset --hard`"',           // backtick in double quotes EXECUTES
    'x=$(rm -rf build)',
    'VAR="$(git push --force origin main)"',
  ];
  for (const cmd of subst) {
    it(`flags substitution: ${cmd.slice(0, 44)}`, () => {
      expect(classifyDestructive(cmd)).not.toBeNull();
    });
  }
});

describe('Phase 1b — find … | xargs rm (bulk delete, even without a recursive flag)', () => {
  it('flags find … | xargs rm -rf', () => {
    expect(classifyDestructive('find . -name "*.tmp" | xargs rm -rf')).not.toBeNull();
  });
  it('flags find … -print0 | xargs -0 rm (no -rf — the real gap)', () => {
    expect(classifyDestructive('find . -type f -print0 | xargs -0 rm')).not.toBeNull();
  });
  it('does NOT flag xargs without rm', () => {
    expect(classifyDestructive('ls | xargs echo')).toBeNull();
    expect(classifyDestructive('find . -name x | xargs grep foo')).toBeNull();
  });
});

describe('Phase 1b — recursion does NOT reintroduce string-literal false-positives', () => {
  const safe = [
    'git commit -m "fix: explain bash -c usage and rm -rf semantics"',  // wrapper TEXT in a message
    `echo 'run: bash -c "rm -rf x"'`,                                   // single-quoted literal, not a command position
    `git commit -m 'note: $(rm -rf x) is dangerous'`,                   // $() in SINGLE quotes does NOT execute
    `echo 'do not run: \`git reset --hard\`'`,                          // backtick in SINGLE quotes does NOT execute
    'node -e "console.log(\'rm -rf and git push --force\')"',           // node -e is JS, not a shell wrapper
    'docker exec pg psql -c "SELECT 1"',                                // psql -c is not a shell wrapper
    'bash scripts/sync-to-active.sh',                                   // bash <script> has no -c flag
  ];
  for (const cmd of safe) {
    it(`allows: ${cmd.slice(0, 44)}`, () => {
      expect(classifyDestructive(cmd)).toBeNull();
    });
  }
});

describe('parseExecutable — quote-aware segmentation + substitution extraction', () => {
  it('splits on unquoted separators', () => {
    expect(parseExecutable('a && b; c | d || e').segments).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('does not split on separators inside quotes', () => {
    expect(parseExecutable('echo "a; b && c"').segments).toEqual(['echo "a; b && c"']);
  });
  it('extracts $() and backtick substitutions OUTSIDE single quotes', () => {
    expect(parseExecutable('x=$(rm -rf a)').substitutions).toContain('rm -rf a');
    expect(parseExecutable('echo "`git reset --hard`"').substitutions).toContain('git reset --hard');
  });
  it('does NOT extract substitutions inside single quotes (bash treats them literally)', () => {
    expect(parseExecutable("echo '$(rm -rf a)'").substitutions).toEqual([]);
    expect(parseExecutable("echo '`rm -rf a`'").substitutions).toEqual([]);
  });
});

describe('extractShellWrapperPayloads — only real wrappers at a command position', () => {
  it('extracts the payload of bash -c', () => {
    expect(extractShellWrapperPayloads('bash -c "rm -rf x"')).toEqual(['rm -rf x']);
  });
  it('extracts across a compound command', () => {
    expect(extractShellWrapperPayloads('cd /tmp && bash -c "rm -rf y"')).toEqual(['rm -rf y']);
  });
  it('does NOT treat "bash -c" text inside a quoted arg as a wrapper', () => {
    expect(extractShellWrapperPayloads('echo "bash -c rm -rf"')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-2 — remediation of the white-box verify sweep (2026-06-29).
// ---------------------------------------------------------------------------

describe('Round-2: fixed false positives (these gate routine dev — must allow)', () => {
  const nowSafe = [
    'rm --force file.txt',         // long -f, NON-recursive (was flagged: "force" contains r)
    'rm --verbose file.txt',       // "verbose" contains r, but not recursive
    'rm --interactive file.txt',   // "interactive" contains r, but not recursive
    'git rebase --abort',          // recovery, UNDOES a rewrite
    'git rebase --continue',
    'git rebase --skip',
    'git rebase --quit',
    'git branch -d feature-branch', // lowercase = merged-only delete (safe)
    'echo shred',                   // shred as an echo argument, not the command
    'grep -r shred .',              // shred as a search term
  ];
  for (const cmd of nowSafe) {
    it(`now allows (was FP): ${cmd.slice(0, 40)}`, () => {
      expect(classifyDestructive(cmd)).toBeNull();
    });
  }
  it('but still flags the dangerous siblings', () => {
    expect(classifyDestructive('rm -rf build')).not.toBeNull();
    expect(classifyDestructive('rm --force --recursive build')).not.toBeNull();
    expect(classifyDestructive('rm -f -r build')).not.toBeNull();
    expect(classifyDestructive('git rebase main')).not.toBeNull();
    expect(classifyDestructive('git rebase -i HEAD~3')).not.toBeNull();
    expect(classifyDestructive('git branch -D feature-x')).not.toBeNull();
    expect(classifyDestructive('shred -u secrets.txt')).not.toBeNull();
  });
});

describe('Round-2: newly covered destructive ops (unambiguous, low false-positive)', () => {
  const destructive = [
    'find . -name "*.tmp" -execdir rm -f {} \\;', // -execdir (was only -exec)
    'rsync -a --delete emptied/ target/',
    'rsync --delete -r src/ dst/',
    'git push --mirror origin',
    'git push origin :branch-to-delete',           // colon-refspec delete
    'git push origin :refs/tags/v1.0',
    'git worktree remove --force wt/feature',
    'git worktree remove -f wt/feature',
    'git switch --discard-changes main',
    'git restore .',                                // whole-tree discard
    'git restore --worktree src/app.ts',
    'git submodule deinit -f --all',
    'rd /s /q C:/Users/x',
    'rmdir /s /q build',
    'del /f /s /q C:/tmp/x',
    'cmd /c rd /s /q C:/Users/victim',              // via cmd-wrapper recursion
    'cmd /c del /f /s /q C:/tmp/x',
    'wipefs /dev/sda',
    'blkdiscard /dev/sdb',
    'env -i sh -c "rm -rf /tmp/x"',                 // env-flag prefix before wrapper
    'sudo -E bash -c "rm -rf /var/x"',              // sudo-flag prefix before wrapper
  ];
  for (const cmd of destructive) {
    it(`flags: ${cmd.slice(0, 44)}`, () => {
      expect(classifyDestructive(cmd)).not.toBeNull();
    });
  }
  it('does NOT over-gate the safe siblings', () => {
    expect(classifyDestructive('git restore --staged file.txt')).toBeNull(); // unstage only
    expect(classifyDestructive('rsync -a src/ dst/')).toBeNull();            // no --delete
    expect(classifyDestructive('git push origin main')).toBeNull();          // normal push
    expect(classifyDestructive('git switch main')).toBeNull();               // normal switch
    expect(classifyDestructive('rmdir build')).toBeNull();                   // POSIX empty-dir rmdir (no /s)
    expect(classifyDestructive('del file.txt')).toBeNull();                  // single del (no /f|/s)
    expect(classifyDestructive('git worktree list')).toBeNull();
    expect(classifyDestructive('git restore file.txt')).toBeNull();          // single-file (accepted gap)
    expect(classifyDestructive('git submodule update --init')).toBeNull();
  });
});

describe('Round-2: documented ACCEPTED limitations (backstop, not a sandbox)', () => {
  // UNMATCHED by design — closing them risks false-positives or is an infinite
  // tail of shell-construction evasion. The guard is a backstop; human confirm-first
  // + settings deny + per-tool rules also apply. Asserting toBeNull() tracks the
  // gap so a future close flips the test and forces a header/doc update.
  const acceptedGaps = [
    '"rm" -rf /tmp/x',                     // quoted command name
    "'rm' -rf /tmp/x",
    'r\\m -rf /tmp/x',                     // backslash in name
    'rm${IFS}-rf /tmp/x',                  // IFS separator
    "printf 'rm -rf /tmp/x' | sh",         // dynamic payload to shell
    "bash <<< 'rm -rf /tmp/x'",            // here-string
    "bash <(echo 'rm -rf /tmp/x')",        // process substitution
    '$(echo rm) -rf /tmp/x',               // substitution-constructed command name
    'chmod -R 000 /var/data',              // too common to gate (chmod -R 755 is routine)
    'powershell -EncodedCommand cgBtAA==', // PowerShell reduced-scope (Remove-Item out)
  ];
  for (const cmd of acceptedGaps) {
    it(`[ACCEPTED GAP] not matched: ${cmd.slice(0, 38)}`, () => {
      expect(classifyDestructive(cmd)).toBeNull();
    });
  }
});


// 2026-09-23 Opus 5.5 eval, P42: the FourthBot demo folder (45 files) was swept by
// `git stash -u` and a later `reset --hard`, and destructive ops run through the
// PowerShell tool were never gated at all.
describe('P42: git stash -u and the PowerShell tool', () => {
  const stashSweeps = [
    'git stash -u',
    'git stash push -u -m "wip before refresh"',
    'git stash --include-untracked',
    'git stash push --all',
    'git stash save -u wip',
  ];
  for (const cmd of stashSweeps) {
    it(`catches untracked-sweeping stash: ${cmd}`, () => {
      expect(classifyDestructive(cmd)).toBe('git stash -u (sweeps untracked files)');
    });
  }
  const stashRoutine = ['git stash', 'git stash push -m "wip"', 'git stash pop', 'git stash apply stash@{1}', 'git stash list --all', 'git stash show -p'];
  for (const cmd of stashRoutine) {
    it(`does not flag routine stash: ${cmd}`, () => {
      expect(classifyDestructive(cmd)).toBeNull();
    });
  }

  const psRecursive = [
    'Remove-Item -Recurse -Force C:\\temp\\build',
    'Remove-Item "C:\\temp\\build" -Recurse',
    'ri .\\dist -r',
    'Get-Item x | ForEach-Object { Remove-Item $_ -Recurse -Force }',
    '[System.IO.Directory]::Delete("C:\\temp\\x", $true)',
  ];
  for (const cmd of psRecursive) {
    it(`PowerShell tool: catches ${cmd.slice(0, 40)}`, () => {
      expect(classifyDestructive(cmd, 0, 'PowerShell')).not.toBeNull();
    });
  }
  const psRoutine = [
    'Remove-Item .\\out.txt',
    'Remove-Item -Force C:\\temp\\one.log',
    '[System.IO.Directory]::Delete($junction, $false)',
    'Get-ChildItem -Recurse -Filter *.md | Select-Object -First 5',
    'git -C C:\\repo status --porcelain',
  ];
  for (const cmd of psRoutine) {
    it(`PowerShell tool: allows ${cmd.slice(0, 40)}`, () => {
      expect(classifyDestructive(cmd, 0, 'PowerShell')).toBeNull();
    });
  }

  it('PowerShell patterns do not apply to the Bash tool (Remove-Item there is quoted payload)', () => {
    expect(classifyDestructive('Remove-Item -Recurse -Force build', 0, 'Bash')).toBeNull();
  });

  it('decide() gates PowerShell-tool git ops: ask interactive, deny unattended', () => {
    const cmd = 'git -C C:\\Users\\x\\FourthBot reset --hard origin/main';
    expect(decide(cmd, { tool_name: 'PowerShell', permission_mode: 'default' }, {}).decision).toBe('ask');
    expect(decide(cmd, { tool_name: 'PowerShell', permission_mode: 'bypassPermissions' }, {}).decision).toBe('deny');
    expect(decide('Remove-Item -Recurse x', { tool_name: 'PowerShell', permission_mode: 'default' }, {}).decision).toBe('ask');
  });
});


describe('P42: git global options no longer hide the subcommand', () => {
  const hidden = [
    ['git -C C:/repo reset --hard origin/main', 'git reset --hard'],
    ['git -C "C:/My Repo" push --force fork main', 'git push --force'],
    ['git -c core.hooksPath=x clean -fdx', 'git clean -f'],
    ['git --git-dir=/r/.git --work-tree=/r checkout -- .', 'git checkout discard'],
    ['git --no-pager -C repo branch -D old', 'git branch -D'],
    ['git -C repo stash -u', 'git stash -u (sweeps untracked files)'],
  ];
  for (const [cmd, name] of hidden) {
    it(`catches ${cmd}`, () => {
      expect(classifyDestructive(cmd)).toBe(name);
    });
  }
  it('still allows routine git -C commands', () => {
    for (const cmd of ['git -C repo status', 'git -C repo log --oneline -5', 'git -C repo push fork main', 'git -C repo branch -d merged']) {
      expect(classifyDestructive(cmd)).toBeNull();
    }
  });
  it('PowerShell override: a leading $env:SKIP_DESTRUCTIVE_GUARD=\'1\'; statement', () => {
    const input = { tool_name: 'PowerShell', permission_mode: 'bypassPermissions' };
    expect(decide("$env:SKIP_DESTRUCTIVE_GUARD='1'; git -C r reset --hard x", input, {}).decision).toBe('allow');
    expect(decide("git status; $env:SKIP_DESTRUCTIVE_GUARD='1'; git -C r reset --hard x", input, {}).decision).toBe('deny');
  });
});


describe('P42 (CodeRabbit #47): PowerShell quoting rules', () => {
  it('a path ending in a backslash does not hide the git subcommand on the PowerShell tool', () => {
    expect(classifyDestructive('git -C "C:\\repo\\" reset --hard origin/main', 0, 'PowerShell')).toBe('git reset --hard');
    expect(classifyDestructive("Remove-Item 'C:\\x\\' -Recurse", 0, 'PowerShell')).not.toBeNull();
  });
  it('PowerShell escapes (backtick, doubled single quote) stay inside the string', () => {
    expect(classifyDestructive('Write-Host "say `"git reset --hard`" please"', 0, 'PowerShell')).toBeNull();
    expect(classifyDestructive("Write-Host 'it''s git reset --hard in a message'", 0, 'PowerShell')).toBeNull();
  });
  it('bash rules are unchanged for the Bash tool', () => {
    expect(classifyDestructive('echo "to undo: git reset --hard HEAD~1"')).toBeNull();
  });
});


// 2026-10-02 skill-intake-fabric Phase 1: two Fabric "never" items become hard guards.
// (a) pausing, resuming or resizing a capacity stops or bills every workload on it;
// (b) a bulk PUT to .../dataAccessRoles replaces ALL OneLake roles (DefaultReader too).
describe('Fabric: capacity suspend/resume/resize and bulk dataAccessRoles PUT', () => {
  const CAP = 'https://management.azure.com/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Fabric/capacities/cap1';
  const ROLES = 'https://api.fabric.microsoft.com/v1/workspaces/w1/items/i1/dataAccessRoles';

  const blockedBash = [
    'az fabric capacity suspend --capacity-name cap1 --resource-group rg',
    'az fabric capacity resume --capacity-name cap1 --resource-group rg',
    'az fabric capacity update --capacity-name cap1 --resource-group rg --sku name=F4 tier=Fabric',
    'az fabric capacity delete --capacity-name cap1 --resource-group rg --yes',
    'az.cmd fabric capacity suspend --capacity-name cap1 --resource-group rg',
    'AZ FABRIC CAPACITY SUSPEND --capacity-name cap1',                      // casing
    'cd infra && az fabric capacity resume --capacity-name cap1',           // compound
    `az rest --method post --url "${CAP}/suspend?api-version=2023-11-01"`,  // double-quoted URL
    `az rest --method post --url '${CAP}/resume?api-version=2023-11-01'`,   // single-quoted URL
    `az rest --method post --url ${CAP}/suspend`,                           // unquoted URL
    `az rest -m POST --url "${CAP}/RESUME?api-version=2023-11-01"`,         // casing
    `curl -s -X POST -H "Authorization: Bearer $T" "${CAP}/suspend?api-version=2023-11-01"`,
    `curl.exe -XPOST "${CAP}/resume?api-version=2023-11-01"`,
    `az rest --method patch --url "${CAP}?api-version=2023-11-01" --body '{"sku":{"name":"F64","tier":"Fabric"}}'`,
    `az rest -m PATCH --url "${CAP}?api-version=2023-11-01" --body @sku.json`,
    `curl -X PATCH -H "Authorization: Bearer $T" "${CAP}?api-version=2023-11-01" -d @sku.json`,
    `az rest --method put --url "${CAP}?api-version=2023-11-01" --body @cap.json`,
    `az rest --method put --url "${ROLES}" --body @roles.json`,
    `az rest -m PUT --url '${ROLES}' --body @roles.json`,
    `curl -s -X PUT -H "Authorization: Bearer $T" -H "Content-Type: application/json" "${ROLES}" -d @roles.json`,
    `curl --request PUT "${ROLES}?dryRun=false" -d @roles.json`,
    `fab api -X put "workspaces/w1/items/i1/dataAccessRoles" -i roles.json`,
    `bash -c "az rest --method post --url '${CAP}/suspend?api-version=2023-11-01'"`, // wrapper recursion
    `X=$(az rest --method put --url "${ROLES}" --body @r.json)`,                      // substitution
  ];
  for (const cmd of blockedBash) {
    it(`Bash: flags ${cmd.slice(0, 60)}`, () => {
      expect(classifyDestructive(cmd, 0, 'Bash')).not.toBeNull();
    });
  }

  const blockedPs = [
    'az fabric capacity suspend --capacity-name cap1 --resource-group rg',
    `Invoke-RestMethod -Method Post -Uri "${CAP}/suspend?api-version=2023-11-01" -Headers $h`,
    `Invoke-RestMethod -Method POST -Uri '${CAP}/resume?api-version=2023-11-01' -Headers $h`,
    `Invoke-WebRequest -Method Patch -Uri "${CAP}?api-version=2023-11-01" -Headers $h -Body $b`,
    `irm -Method Patch -Uri "${CAP}?api-version=2023-11-01" -Headers $h -Body $b`,
    `$r = Invoke-RestMethod -Method Put -Uri "${ROLES}" -Headers $h -Body $b`,
    `$r = invoke-restmethod -method put -uri "${ROLES}" -headers $h -body $b`,       // casing
    `Invoke-RestMethod \`\n  -Method Put \`\n  -Uri "${ROLES}" \`\n  -Headers $h`,    // backtick line continuation
    `az rest --method put --url "${ROLES}" --body @roles.json`,
  ];
  for (const cmd of blockedPs) {
    it(`PowerShell: flags ${cmd.slice(0, 60).replace(/\n/g, ' ')}`, () => {
      expect(classifyDestructive(cmd, 0, 'PowerShell')).not.toBeNull();
    });
  }

  const allowedBash = [
    'az fabric capacity show --capacity-name cap1 --resource-group rg',
    'az fabric capacity list --resource-group rg',
    'az fabric capacity list-skus --location westeurope',
    `az rest --method get --url "${CAP}?api-version=2023-11-01"`,
    `az rest --url "${CAP}/skus?api-version=2023-11-01"`,                  // default method is GET
    `az rest --method get --url "${ROLES}"`,
    `curl -s -H "Authorization: Bearer $T" "${ROLES}"`,                    // curl default is GET
    `curl -s -X GET "${ROLES}"`,
    `az rest --method put --url "${ROLES}/RoleA" --body @one.json`,        // one named role, not the bulk list
    `az rest --method post --url "${ROLES}" --body @one.json`,             // POST creates one role
    'az rest --method patch --url "https://api.fabric.microsoft.com/v1/workspaces/w1/lakehouses/l1" --body @b.json',
    'az rest --method post --url "https://api.fabric.microsoft.com/v1/workspaces/w1/items/i1/jobs/instances?jobType=Pipeline"',
    'fab api -X get "workspaces/w1/items/i1/dataAccessRoles"',
    'echo "az fabric capacity suspend"',                                   // text, not a command
    'git commit -m "docs: never run az fabric capacity resume from a script"',
    `echo "az rest --method put --url ${ROLES}"`,
    `grep -rn "capacities/cap1/suspend" docs/`,
    `git commit -m "note: PUT ${ROLES} replaces all roles"`,
  ];
  for (const cmd of allowedBash) {
    it(`Bash: allows ${cmd.slice(0, 60)}`, () => {
      expect(classifyDestructive(cmd, 0, 'Bash')).toBeNull();
    });
  }

  const allowedPs = [
    `Invoke-RestMethod -Method Get -Uri "${ROLES}" -Headers $h`,
    `Invoke-RestMethod -Uri "${ROLES}" -Headers $h`,
    `Invoke-RestMethod -Method Get -Uri "${CAP}?api-version=2023-11-01" -Headers $h`,
    `Invoke-RestMethod -Method Put -Uri "${ROLES}/RoleA" -Headers $h -Body $b`,
    'az fabric capacity show --capacity-name cap1 --resource-group rg',
    `Write-Host "az rest --method put --url ${ROLES}"`,
  ];
  for (const cmd of allowedPs) {
    it(`PowerShell: allows ${cmd.slice(0, 60)}`, () => {
      expect(classifyDestructive(cmd, 0, 'PowerShell')).toBeNull();
    });
  }

  it('names the pattern so the prompt tells the human what matched', () => {
    expect(classifyDestructive('az fabric capacity suspend --capacity-name c', 0, 'Bash')).toBe('Fabric capacity suspend/resume/resize/delete');
    expect(classifyDestructive(`az rest --method post --url "${CAP}/resume"`, 0, 'Bash')).toBe('Fabric capacity suspend/resume via REST');
    expect(classifyDestructive(`az rest --method patch --url "${CAP}?api-version=1"`, 0, 'Bash')).toBe('Fabric capacity SKU change via REST (PATCH/PUT)');
    expect(classifyDestructive(`az rest --method put --url "${ROLES}"`, 0, 'Bash')).toBe('OneLake bulk PUT dataAccessRoles (replaces ALL roles)');
  });

  it('decide(): ask interactive, deny unattended, on both tools', () => {
    const cmd = `az rest --method put --url "${ROLES}" --body @r.json`;
    expect(decide(cmd, { tool_name: 'Bash', permission_mode: 'default' }, {}).decision).toBe('ask');
    expect(decide(cmd, { tool_name: 'Bash', permission_mode: 'bypassPermissions' }, {}).decision).toBe('deny');
    const ps = `Invoke-RestMethod -Method Post -Uri "${CAP}/suspend" -Headers $h`;
    expect(decide(ps, { tool_name: 'PowerShell', permission_mode: 'default' }, {}).decision).toBe('ask');
    expect(decide(ps, { tool_name: 'PowerShell' }, { CLAUDE_AGENT_ID: 'a' }).decision).toBe('deny');
  });

  it('SKIP_DESTRUCTIVE_GUARD override still works for a known-good capacity call', () => {
    const cmd = 'SKIP_DESTRUCTIVE_GUARD=1 az fabric capacity resume --capacity-name c';
    expect(decide(cmd, { permission_mode: 'bypassPermissions' }, {}).decision).toBe('allow');
  });
});
