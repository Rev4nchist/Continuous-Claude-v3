/**
 * destructive-command-guard — Phase 1a SAFE-floor tests (D2g-02 / GAP3-01)
 *
 * Verifies: (1) curated destructive set is caught incl. compound commands;
 * (2) routine dev commands are NOT false-flagged; (3) fail-CLOSED in unattended
 * contexts (deny, never an interactive ask that would hang); (4) ask in
 * interactive; (5) SKIP_DESTRUCTIVE_GUARD override.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  classifyDestructive,
  isUnattended,
  decide,
  stripQuotedStrings,
  parseExecutable,
  extractShellWrapperPayloads,
  reasonFor,
} from '../destructive-command-guard.js';
import { installSegments } from '../package-install-guard.js';

describe('deny text does not teach the agent to override the guard', () => {
  // 59 of 59 agent overrides in the mods usage review followed the old advice in this text.
  const deny = reasonFor('deny', 'recursive rm', 'rm -rf build');

  it('never names SKIP_DESTRUCTIVE_GUARD or the PowerShell override form', () => {
    expect(deny).not.toMatch(/SKIP_DESTRUCTIVE_GUARD/);
    expect(deny).not.toMatch(/\$env:/);
    expect(deny).not.toMatch(/re-run with/i);
  });

  it('tells the agent to ask Dave for a yes, or state the reason', () => {
    expect(deny).toMatch(/ask Dave for a yes/i);
    expect(deny).toMatch(/state the reason/i);
  });

  it('keeps the matched rule and the command so the agent can see what was blocked', () => {
    expect(deny).toContain('Matched: recursive rm');
    expect(deny).toContain('Command: rm -rf build');
  });

  it('leaves the interactive ask text unchanged', () => {
    const ask = reasonFor('ask', 'recursive rm', 'rm -rf build');
    expect(ask).toMatch(/^CONFIRM: this is a destructive command/);
    expect(ask).toContain('Approve only if you intend this irreversible operation');
  });

  it('still honours the override mechanism itself (Dave uses it)', () => {
    expect(decide('SKIP_DESTRUCTIVE_GUARD=1 rm -rf build', { permission_mode: 'bypassPermissions' }, {}).decision).toBe('allow');
  });
});

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
    expect(classifyDestructive(`az rest --method patch --url "${CAP}?api-version=1"`, 0, 'Bash')).toBe('Fabric capacity SKU change or delete via REST (PATCH/PUT/DELETE)');
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
    // The classifier must SEE the command (a VAR=1 prefix does not hide it), so the override is what allows it.
    expect(classifyDestructive(cmd, 0, 'Bash')).not.toBeNull();
    expect(decide(cmd, { permission_mode: 'bypassPermissions' }, {}).decision).toBe('allow');
  });
});

// Round 2 (critic on PR #80): bypasses of the Fabric guard. Each case below passed with no prompt on 0fe2250.
describe('Fabric guard round 2: lead-ins, host-less URLs, trailing slash, PowerShell method forms, more clients', () => {
  const CAP = 'https://management.azure.com/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Fabric/capacities/cap1';
  const CAP_PATH = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Fabric/capacities/cap1';
  const ROLES = 'https://api.fabric.microsoft.com/v1/workspaces/w1/items/i1/dataAccessRoles';
  const bash = (c: string) => classifyDestructive(c, 0, 'Bash');
  const ps = (c: string) => classifyDestructive(c, 0, 'PowerShell');

  describe('1. the CLI form after a line break, an assignment, an env prefix or a block opener', () => {
    const both = [
      'cd infra\naz fabric capacity suspend --capacity-name cap1 --resource-group rg',
      'AZURE_CORE_OUTPUT=json az fabric capacity suspend --capacity-name cap1 --resource-group rg',
      'FOO=1 az fabric capacity resume --capacity-name cap1 --resource-group rg',
      '(az fabric capacity suspend --capacity-name cap1 --resource-group rg)',
      '{ az fabric capacity suspend --capacity-name cap1 --resource-group rg; }',
    ];
    for (const cmd of both) {
      it(`Bash: flags ${cmd.replace(/\n/g, '\\n').slice(0, 60)}`, () => expect(bash(cmd)).not.toBeNull());
      it(`PowerShell: flags ${cmd.replace(/\n/g, '\\n').slice(0, 60)}`, () => expect(ps(cmd)).not.toBeNull());
    }
    const psOnly = [
      '$null = az fabric capacity suspend --capacity-name cap1 --resource-group rg',
      '$out = az fabric capacity resume --capacity-name cap1 --resource-group rg',
      'if ($go) { az fabric capacity resume --capacity-name cap1 --resource-group rg }',
      'try { az fabric capacity update --capacity-name cap1 --sku name=F4 } catch { }',
      'foreach ($c in $caps) { az fabric capacity suspend --capacity-name $c }',
      '$caps | ForEach-Object { az fabric capacity suspend --capacity-name $_ }',
      '[void](az fabric capacity suspend --capacity-name cap1)',
    ];
    for (const cmd of psOnly) {
      it(`PowerShell: flags ${cmd.slice(0, 60)}`, () => expect(ps(cmd)).not.toBeNull());
    }
    it('still allows the read-only twins after the same lead-ins', () => {
      expect(bash('cd infra\naz fabric capacity show --capacity-name cap1 --resource-group rg')).toBeNull();
      expect(bash('AZURE_CORE_OUTPUT=json az fabric capacity list --resource-group rg')).toBeNull();
      expect(ps('$null = az fabric capacity show --capacity-name cap1 --resource-group rg')).toBeNull();
      expect(ps('if ($go) { az fabric capacity list --resource-group rg }')).toBeNull();
    });
  });

  describe('3. capacity DELETE through REST, az resource, and the Az.Fabric cmdlets', () => {
    const blocked = [
      `az rest --method delete --url "${CAP}?api-version=2023-11-01"`,
      `curl -s -X DELETE -H "Authorization: Bearer $T" "${CAP}?api-version=2023-11-01"`,
      `az resource delete --ids ${CAP_PATH}`,
      `az resource delete -g rg -n cap1 --resource-type Microsoft.Fabric/capacities`,
      `az resource invoke-action --action suspend --ids ${CAP_PATH}`,
      `az resource invoke-action --action resume --ids "${CAP_PATH}"`,
      `az resource update --ids ${CAP_PATH} --set sku.name=F4`,
      `Suspend-AzFabricCapacity -ResourceGroupName rg -Name cap1`,
      `Resume-AzFabricCapacity -ResourceGroupName rg -Name cap1`,
      `Update-AzFabricCapacity -ResourceGroupName rg -Name cap1 -SkuName F4`,
      `Remove-AzFabricCapacity -ResourceGroupName rg -Name cap1`,
      `Get-AzFabricCapacity -ResourceGroupName rg | Suspend-AzFabricCapacity`,
      `fab stop .capacities/cap1.Capacity -f`,
      `fab start .capacities/cap1.Capacity`,
      `fab set .capacities/cap1.Capacity -q sku.name -i F4 -f`,
      `fab rm .capacities/cap1.Capacity -f`,
    ];
    for (const cmd of blocked) {
      it(`Bash: flags ${cmd.slice(0, 64)}`, () => expect(bash(cmd)).not.toBeNull());
    }
    it('PowerShell: flags Invoke-RestMethod -Method Delete on a capacity', () => {
      expect(ps(`Invoke-RestMethod -Method Delete -Uri "${CAP}?api-version=2023-11-01" -Headers $h`)).not.toBeNull();
    });
    const allowed = [
      `az resource show --ids ${CAP_PATH}`,
      `az resource list --resource-type Microsoft.Fabric/capacities`,
      `az resource delete --ids /subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/app1`,
      `az rest --method delete --url "https://api.fabric.microsoft.com/v1/workspaces/w1/lakehouses/l1"`,
      `Get-AzFabricCapacity -ResourceGroupName rg`,
      `Get-AzFabricCapacitySku -Location westeurope`,
      `fab get .capacities/cap1.Capacity`,
      `fab ls .capacities`,
      `fab set ws1.Workspace/nb1.Notebook -q displayName -i x`,
      `fab stop ws1.Workspace/db1.MirroredDatabase`,
    ];
    for (const cmd of allowed) {
      it(`Bash: allows ${cmd.slice(0, 64)}`, () => expect(bash(cmd)).toBeNull());
    }
  });

  describe('4. host-less ARM URLs (az rest accepts a path with no host)', () => {
    it('az rest PATCH on a host-less capacity path', () => {
      expect(bash(`az rest --method patch --url "${CAP_PATH}?api-version=2023-11-01" --body @sku.json`)).not.toBeNull();
    });
    it('az rest DELETE on a host-less capacity path', () => {
      expect(bash(`az rest --method delete --url "${CAP_PATH}?api-version=2023-11-01"`)).not.toBeNull();
    });
    it('az rest POST suspend on a host-less capacity path', () => {
      expect(bash(`az rest --method post --url "${CAP_PATH}/suspend?api-version=2023-11-01"`)).not.toBeNull();
    });
    it('az rest GET on a host-less capacity path stays allowed', () => {
      expect(bash(`az rest --method get --url "${CAP_PATH}?api-version=2023-11-01"`)).toBeNull();
    });
  });

  describe('5. a trailing slash does not defeat the end check', () => {
    it('PUT .../dataAccessRoles/', () => {
      expect(bash(`az rest --method put --url "${ROLES}/" --body @r.json`)).not.toBeNull();
    });
    it('PUT .../dataAccessRoles/?api-version=1', () => {
      expect(bash(`curl -X PUT "${ROLES}/?api-version=1" -d @r.json`)).not.toBeNull();
    });
    it('PUT .../dataAccessRoles#frag', () => {
      expect(bash(`curl -X PUT "${ROLES}#x" -d @r.json`)).not.toBeNull();
    });
    it('PATCH .../capacities/cap1/?api-version=1', () => {
      expect(bash(`az rest --method patch --url "${CAP}/?api-version=2023-11-01" --body @s.json`)).not.toBeNull();
    });
    it('a named role with a trailing slash stays allowed', () => {
      expect(bash(`az rest --method put --url "${ROLES}/RoleA/" --body @one.json`)).toBeNull();
    });
  });

  describe('6. PowerShell method spellings', () => {
    const blocked = [
      `Invoke-RestMethod -Method:Put -Uri "${ROLES}" -Headers $h -Body $b`,
      `Invoke-RestMethod -CustomMethod PUT -Uri "${ROLES}" -Headers $h -Body $b`,
      `Invoke-WebRequest -Meth Put -Uri "${ROLES}" -Headers $h -Body $b`,
      `Invoke-RestMethod -Method:Patch -Uri "${CAP}?api-version=2023-11-01" -Headers $h -Body $b`,
      `Invoke-RestMethod -Method:Post -Uri "${CAP}/suspend?api-version=2023-11-01" -Headers $h`,
      `irm -method:delete -uri "${CAP}?api-version=2023-11-01" -headers $h`,
    ];
    for (const cmd of blocked) {
      it(`PowerShell: flags ${cmd.slice(0, 64)}`, () => expect(ps(cmd)).not.toBeNull());
    }
    it('PowerShell: -Method:Get stays allowed', () => {
      expect(ps(`Invoke-RestMethod -Method:Get -Uri "${ROLES}" -Headers $h`)).toBeNull();
      expect(ps(`Invoke-RestMethod -Meth Get -Uri "${CAP}?api-version=2023-11-01" -Headers $h`)).toBeNull();
    });
  });

  describe('7. Invoke-AzRestMethod and lead-ins before a client', () => {
    const blocked = [
      `Invoke-AzRestMethod -Path "${CAP_PATH}/suspend?api-version=2023-11-01" -Method POST`,
      `Invoke-AzRestMethod -Path "${CAP_PATH}?api-version=2023-11-01" -Method PATCH -Payload $b`,
      `Invoke-AzRestMethod -Uri "${ROLES}" -Method PUT -Payload $b`,
      `try { Invoke-RestMethod -Method Put -Uri "${ROLES}" -Headers $h -Body $b } catch { }`,
      `[void](Invoke-RestMethod -Method Put -Uri "${ROLES}" -Headers $h -Body $b)`,
      `$r = (Invoke-RestMethod -Method Put -Uri "${ROLES}" -Headers $h -Body $b)`,
      `if ($go) { Invoke-RestMethod -Method Post -Uri "${CAP}/resume?api-version=2023-11-01" -Headers $h }`,
    ];
    for (const cmd of blocked) {
      it(`PowerShell: flags ${cmd.slice(0, 64)}`, () => expect(ps(cmd)).not.toBeNull());
    }
    it('Invoke-AzRestMethod GET stays allowed', () => {
      expect(ps(`Invoke-AzRestMethod -Path "${CAP_PATH}?api-version=2023-11-01" -Method GET`)).toBeNull();
    });
  });

  describe('lead-in regex stays linear (a hook that hangs bricks the tool call)', () => {
    const shapes = ['if (x) { ', 'A=1 ', '$a = ', 'try { ', '(( ', 'if ('];
    for (const s of shapes) {
      it(`3000 x "${s}" classifies in under 2 s`, () => {
        const t0 = Date.now();
        expect(ps(s.repeat(3000) + 'echo hi')).toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
      });
    }
  });

  describe('12. heredoc bodies that only write a file are text, not commands', () => {
    it('cat > file <<EOF with a curl PUT line is allowed', () => {
      expect(bash(`cat > docs/note.md <<'EOF'\ncurl -X PUT "${ROLES}" -d @r.json\nEOF`)).toBeNull();
    });
    it('cat <<EOF > file with a capacity CLI line is allowed', () => {
      expect(bash('cat <<EOF > docs/note.md\naz fabric capacity suspend --capacity-name c\nEOF')).toBeNull();
    });
    it('a command AFTER the heredoc terminator is still checked', () => {
      expect(bash(`cat > f <<EOF\ntext\nEOF\naz fabric capacity suspend --capacity-name c`)).not.toBeNull();
    });
    it('PowerShell: a $x = @\' here-string that only holds text is allowed', () => {
      expect(ps(`$doc = @'\nInvoke-RestMethod -Method Put -Uri "${ROLES}"\n'@\nSet-Content docs/n.md $doc`)).toBeNull();
    });
    it('PowerShell: a command after the here-string is still checked', () => {
      expect(ps(`$doc = @'\ntext\n'@\naz fabric capacity suspend --capacity-name c`)).not.toBeNull();
    });
    it('a heredoc fed to a shell still runs its body: bash <<EOF', () => {
      expect(bash('bash <<EOF\naz fabric capacity suspend --capacity-name c\nEOF')).not.toBeNull();
    });
    it('a heredoc piped to a shell still runs its body: cat <<EOF | bash', () => {
      expect(bash('cat <<EOF | bash\naz fabric capacity suspend --capacity-name c\nEOF')).not.toBeNull();
    });
  });
});

// Round 3 (CodeRabbit on ce61984).
describe('Fabric guard round 3: substitutions inside text blocks, PowerShell backtick escapes', () => {
  const bash = (c: string) => classifyDestructive(c, 0, 'Bash');
  const ps = (c: string) => classifyDestructive(c, 0, 'PowerShell');
  const DEL = 'az fabric capacity delete --capacity-name cap1 --resource-group rg --yes';

  describe('1. an unquoted heredoc / @" here-string EXECUTES $(...) and backticks in its body', () => {
    it('Bash: cat > f <<EOF with $(az fabric capacity delete ...) is flagged', () => {
      expect(bash(`cat > f <<EOF\nnotes\n$(${DEL})\nEOF`)).not.toBeNull();
    });
    it('Bash: cat <<EOF > f with a backtick substitution is flagged', () => {
      expect(bash(`cat <<EOF > f\nnotes\n\`az fabric capacity suspend --capacity-name c\`\nEOF`)).not.toBeNull();
    });
    it('Bash: an inline substitution in a line of prose is flagged', () => {
      expect(bash(`cat > f <<EOF\nRun it now: $(${DEL}) then wait.\nEOF`)).not.toBeNull();
    });
    it('Bash: a destructive substitution of any kind in an unquoted body is flagged', () => {
      expect(bash('cat > f <<EOF\n$(rm -rf build)\nEOF')).not.toBeNull();
    });
    it('PowerShell: $doc = @" here-string with $(Remove-AzFabricCapacity ...) is flagged', () => {
      expect(ps('$doc = @"\nnotes\n$(Remove-AzFabricCapacity -ResourceGroupName rg -Name cap1)\n"@\nSet-Content n.md $doc')).not.toBeNull();
    });
    it('PowerShell: $doc = @" with $(az fabric capacity delete ...) is flagged', () => {
      expect(ps(`$doc = @"\n$(${DEL})\n"@`)).not.toBeNull();
    });

    // The same text in a LITERAL body is only text.
    it("Bash: <<'EOF' (quoted delimiter) keeps $(...) literal: allowed", () => {
      expect(bash(`cat > f <<'EOF'\n$(${DEL})\nEOF`)).toBeNull();
    });
    it('Bash: <<"EOF" keeps $(...) literal: allowed', () => {
      expect(bash(`cat > f <<"EOF"\n$(${DEL})\n\`az fabric capacity suspend --capacity-name c\`\nEOF`)).toBeNull();
    });
    it('Bash: a backslash-escaped $( in an unquoted body is literal: allowed', () => {
      expect(bash(`cat > f <<EOF\n\\$(${DEL})\nEOF`)).toBeNull();
    });
    it("PowerShell: @' here-string keeps $(...) literal: allowed", () => {
      expect(ps(`$doc = @'\n$(Remove-AzFabricCapacity -Name cap1)\n'@`)).toBeNull();
    });
    it('PowerShell: a backtick-escaped $( in @" is literal: allowed', () => {
      expect(ps('$doc = @"\n`$(Remove-AzFabricCapacity -Name cap1)\n"@')).toBeNull();
    });

    // A plain doc body, or a read-only substitution, stays allowed.
    it('Bash: an unquoted body with no substitution is allowed', () => {
      expect(bash(`cat > f <<EOF\ncurl -X PUT "https://api.fabric.microsoft.com/v1/workspaces/w/items/i/dataAccessRoles"\nEOF`)).toBeNull();
    });
    it('Bash: an unquoted body with a read-only substitution is allowed', () => {
      expect(bash('cat > f <<EOF\n$(az fabric capacity show --capacity-name c --resource-group rg)\nEOF')).toBeNull();
    });
    it('PowerShell: @" with no substitution is allowed', () => {
      expect(ps('$doc = @"\nRemove-AzFabricCapacity is gated.\n"@')).toBeNull();
    });
    it('PowerShell: @" with a read-only substitution is allowed', () => {
      expect(ps('$doc = @"\n$(Get-AzFabricCapacity -ResourceGroupName rg)\n"@')).toBeNull();
    });
    it('a body that holds the terminator inside text is still skipped to the real terminator, then checked after it', () => {
      expect(bash(`cat > f <<EOF\n$(echo ok)\nEOF\n${DEL}`)).not.toBeNull();
    });
  });

  describe('2. a PowerShell backtick keeps the escaped character', () => {
    const blocked = [
      'az fabric capacity del`ete --capacity-name cap1 --resource-group rg',
      'Suspend-AzFabricCap`acity -ResourceGroupName rg -Name cap1',
      'Remove-AzFabric`Capacity -ResourceGroupName rg -Name cap1',
      'az fab`ric capacity suspend --capacity-name cap1',
      'Invoke-RestMethod -Method P`ut -Uri "https://api.fabric.microsoft.com/v1/workspaces/w/items/i/dataAccessRoles" -Headers $h',
      'git res`et --hard origin/main',
    ];
    for (const cmd of blocked) {
      it(`PowerShell: flags ${cmd.slice(0, 60)}`, () => expect(ps(cmd)).not.toBeNull());
    }
    it('a backtick-newline continuation still joins the lines', () => {
      expect(ps('az fabric capacity `\n  suspend --capacity-name cap1')).not.toBeNull();
      expect(ps('Invoke-RestMethod `\n -Method Put `\n -Uri "https://api.fabric.microsoft.com/v1/workspaces/w/items/i/dataAccessRoles"')).not.toBeNull();
    });
    it('a continuation and an escaped letter together', () => {
      expect(ps('az fabric capacity `\n  del`ete --capacity-name cap1')).not.toBeNull();
    });
    it('escaped letters in a read-only command stay allowed', () => {
      expect(ps('az fabric capacity sh`ow --capacity-name cap1')).toBeNull();
      expect(ps('Get-AzFabric`Capacity -Name cap1')).toBeNull();
    });
    it('escaped quotes inside a string still stay inside the string', () => {
      expect(ps('Write-Host "say `"az fabric capacity suspend`" please"')).toBeNull();
    });
    it('a trailing backslash in PowerShell is a path, not a continuation', () => {
      expect(ps('cd C:\\work\\\naz fabric capacity suspend --capacity-name cap1')).not.toBeNull();
    });
  });

  describe('text-block scanning stays linear', () => {
    const blocks: Array<[string, string, 'Bash' | 'PowerShell']> = [
      ['unterminated $( in an unquoted heredoc', 'cat > f <<EOF\n' + '$( '.repeat(3000), 'Bash'],
      ['unmatched backticks in an unquoted heredoc', 'cat > f <<EOF\n' + 'a ` '.repeat(3000) + '\nEOF', 'Bash'],
      ['many closed substitutions', 'cat > f <<EOF\n' + '$(echo a) '.repeat(3000) + '\nEOF', 'Bash'],
      ['unterminated $( in @" here-string', '$d = @"\n' + '$( '.repeat(3000), 'PowerShell'],
      ['many heredoc openers', 'cat > f <<EOF\nx\nEOF\n'.repeat(1500), 'Bash'],
    ];
    for (const [name, cmd, tool] of blocks) {
      it(`${name}: under 2 s`, () => {
        const t0 = Date.now();
        classifyDestructive(cmd, 0, tool);
        expect(Date.now() - t0).toBeLessThan(2000);
      });
    }
  });
});

// F07 (2026-11-03 Cloudflare paper eval): shell-running MCP tools skipped this guard.
describe('shell-running MCP tools (F07)', () => {
  const START = 'mcp__plugin_desktop-commander_desktop-commander__start_process';
  const INTERACT = 'mcp__plugin_desktop-commander_desktop-commander__interact_with_process';
  const PS_DELETE = 'Remove-Item -Recurse -Force C:\\Users\\dkhay\\important';
  const BASH_DELETE = 'rm -rf /c/Users/dkhay/important';

  it('decide() classifies a start_process command as PowerShell too (its default shell)', () => {
    expect(decide(PS_DELETE, { tool_name: START }, {}).decision).toBe('ask');
  });

  it('decide() still classifies a start_process command as Bash', () => {
    expect(decide(BASH_DELETE, { tool_name: START }, {}).decision).toBe('ask');
  });

  describe('built hook, subprocess', () => {
    async function run(payload: object): Promise<Record<string, any>> {
      const { spawnSync } = await import('node:child_process');
      const { existsSync, mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const dist = fileURLToPath(new URL('../../dist/destructive-command-guard.mjs', import.meta.url));
      expect(existsSync(dist)).toBe(true);
      // The built hook runs without VITEST, so its guard log goes to a temp file.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CCV3_GUARD_DECISIONS_LOG: join(mkdtempSync(join(tmpdir(), 'dcg-f07-')), 'guard-decisions.jsonl'),
      };
      for (const k of ['VITEST', 'VITEST_WORKER_ID', 'CI', 'CLAUDE_AGENT_ID']) delete env[k];
      const res = spawnSync(process.execPath, [dist], {
        input: JSON.stringify({ session_id: 'test-session', permission_mode: 'default', ...payload }),
        encoding: 'utf8',
        timeout: 20_000,
        env,
      });
      expect(res.status).toBe(0);
      return JSON.parse(res.stdout.trim().split('\n').pop()!);
    }
    const verdict = (out: Record<string, any>) => out.hookSpecificOutput?.permissionDecision;

    it('asks on a recursive delete sent through start_process', async () => {
      expect(verdict(await run({ tool_name: START, tool_input: { command: PS_DELETE, timeout_ms: 5000 } }))).toBe('ask');
      expect(verdict(await run({ tool_name: START, tool_input: { command: BASH_DELETE, timeout_ms: 5000 } }))).toBe('ask');
    });

    it('denies the same delete in bypassPermissions mode', async () => {
      const out = await run({ tool_name: START, permission_mode: 'bypassPermissions', tool_input: { command: PS_DELETE, timeout_ms: 5000 } });
      expect(verdict(out)).toBe('deny');
    });

    it('reads interact_with_process text from its input field', async () => {
      expect(verdict(await run({ tool_name: INTERACT, tool_input: { pid: 4242, input: BASH_DELETE } }))).toBe('ask');
    });

    it('fails closed when a listed MCP tool has no readable command text', async () => {
      const out = await run({ tool_name: START, tool_input: { cmd: BASH_DELETE, timeout_ms: 5000 } });
      expect(verdict(out)).toBe('ask');
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/unreadable/i);
    });

    it('passes a routine start_process command and an unlisted MCP tool', async () => {
      expect(await run({ tool_name: START, tool_input: { command: 'git status', timeout_ms: 5000 } })).toEqual({});
      expect(await run({ tool_name: 'mcp__plugin_desktop-commander_desktop-commander__read_file', tool_input: { path: 'C:\\x' } })).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// Eval bypasses F01-F06, F14, F16 and the quoted-option wrapper (spec 2026-11-04).
// Every row below is `allow` on fork/main 9af5e0e5 and must become ask/deny.
// ---------------------------------------------------------------------------
const interactiveFor = (tool: 'Bash' | 'PowerShell') => ({ tool_name: tool, permission_mode: 'default' });

describe('eval bypasses: the guard must not allow these (F01-F06, F14, wrapper quote)', () => {
  const bash: Array<[string, string]> = [
    ['F01 bash: lone double quote inside single quotes hides rm', `echo '"'; rm -rf x; echo '"'`],
    ['F01 git: lone double quote inside single quotes hides git reset', `echo '"'; git reset --hard; echo '"'`],
    ['F01 sq-escape: backslash is literal inside single quotes', String.raw`echo 'a\'; rm -rf x; echo '`],
    ['F02: sh -c with single-quoted payload and trailing args', `sh -c 'rm -rf "$1"' _ /some/path`],
    ['F03 /bin/bash path prefix', `/bin/bash -c "rm -rf /"`],
    ['F03 wsl leader', `wsl bash -c "rm -rf ~"`],
    ['F03 exec leader', `exec bash -c "rm -rf x"`],
    ['F03 timeout leader', `timeout 5 bash -c "rm -rf x"`],
    ['F03 xargs sh', `find . | xargs sh -c 'rm -rf "$@"' _`],
    ['F03 sudo -u value', `sudo -u root bash -c "rm -rf x"`],
    ['F03 powershell.exe full path', String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -Command "Remove-Item -Recurse x"`],
    ['F03 cmd.exe full path', String.raw`C:\Windows\System32\cmd.exe /c "rd /s /q x"`],
    ['F04: flag after the operand (rm build -rf)', `rm build -rf`],
    ['F04: flag after the operand (rm -f path -r)', `rm -f path -r`],
    ['F05: git push origin +main', `git push origin +main`],
    ['F05: git push origin +HEAD:main', `git push origin +HEAD:main`],
    ['F05: git push -uf', `git push -uf origin main`],
    ['F05: git push -fu', `git push -fu origin main`],
    ['F05: git reset HEAD~3 --hard', `git reset HEAD~3 --hard`],
    ['F05: git reset -q --hard', `git reset -q --hard`],
    ['F05: git checkout HEAD -- .', `git checkout HEAD -- .`],
    ['F05: git checkout main -- src', `git checkout main -- src`],
    ['F05: git branch -f main abc123', `git branch -f main abc123`],
    ['F05: docker compose down -v', `docker compose down -v`],
    ['F05: docker-compose down --volumes', `docker-compose down --volumes`],
    ['F14: quote opened before a heredoc line keeps the body in the view', `echo "x\ncat <<'EOF'\ny"\nbash -c "rm -rf /"\nEOF`],
    ['WR bash: quoted --rcfile value before -c', `bash --rcfile "/zz x" -c "rm -rf x"`],
    ['WR pwsh via Bash tool: quoted -wd value before -c', `pwsh -wd "C:/zz" -c "Remove-Item -Recurse x"`],
  ];
  for (const [name, cmd] of bash) {
    it(`Bash ${name}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }

  const ps: Array<[string, string]> = [
    ['F01 ps: lone double quote inside single quotes hides Remove-Item', `Write-Output '"'; Remove-Item -Recurse x; Write-Output '"'`],
    ['F06: splatted Remove-Item', `$p=@{Path='C:\\data';Recurse=$true;Force=$true}; Remove-Item @p`],
    ['F06: pipe into Remove-Item', `Get-ChildItem C:\\data -Recurse -File | Remove-Item -Force`],
    ['F06: [IO.Directory]::Delete with variable recurse flag', `$r=$true; [IO.Directory]::Delete($p,$r)`],
    ['WR pwsh: quoted -wd value before -c', `pwsh -wd "C:/zz" -c "Remove-Item -Recurse x"`],
  ];
  for (const [name, cmd] of ps) {
    it(`PowerShell ${name}`, () => {
      expect(decide(cmd, interactiveFor('PowerShell'), {}).decision).not.toBe('allow');
    });
  }
});

describe('F16: decide() stays fast on adversarial option runs', () => {
  it('rm with 28 repeated long options finishes in under 1000 ms', () => {
    const cmd = 'rm ' + '--a '.repeat(28) + 'x';
    const t0 = performance.now();
    decide(cmd, interactiveFor('Bash'), {});
    expect(performance.now() - t0).toBeLessThan(1000);
  });
  it('git clean with 28 repeated long options finishes in under 1000 ms', () => {
    const cmd = 'git clean ' + '--a '.repeat(28) + 'x';
    const t0 = performance.now();
    decide(cmd, interactiveFor('Bash'), {});
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('package guard: shared WRAPPER_RES reaches the install inside a wrapper', () => {
  it('pwsh -wd "<dir>" -c "npm install ..." yields an install segment', () => {
    expect(installSegments(`pwsh -wd "C:/zz" -c "npm install zz-fake-pkg-a1"`, 'Bash').length).toBeGreaterThanOrEqual(1);
  });
  it('bash --rcfile "<file>" -c "npm install ..." yields an install segment', () => {
    expect(installSegments(`bash --rcfile "/zz x" -c "npm install zz-fake-pkg-a1"`, 'Bash').length).toBeGreaterThanOrEqual(1);
  });
  it(`sh -c 'npm install evil' _ x yields an install segment`, () => {
    expect(installSegments(`sh -c 'npm install evil' _ x`, 'Bash').length).toBeGreaterThanOrEqual(1);
  });
});

describe('guard-prompt-text-fp control', () => {
  const bashControls: Array<[string, string]> = [
    ['commit message that names rm -rf', `git commit -m "docs: explain when rm -rf is blocked"`],
    ['claude -p prompt that names git rebase', `claude -p "explain why git rebase rewrites history"`],
    ['echo of a destructive warning', `echo "never run git reset --hard here"`],
    ['ls -la', `ls -la`],
    ['git push to a feature branch', `git push origin fix/x`],
    ['rm of a single file', `rm build.log`],
    ['git push -u origin feat', `git push -u origin feat`],
    ['git checkout -b', `git checkout -b new-branch`],
    ['git branch -d', `git branch -d old`],
    ['docker run --rm', `docker run --rm -it node:20 node -v`],
    ['git clean -n (dry run)', `git clean -n`],
    ['git reset --soft', `git reset --soft HEAD~1`],
    ['heredoc doc body that names a destructive az command', `cat <<'EOF' > doc.md\nHow to stop it: az fabric capacity suspend --name x\nEOF`],
  ];
  for (const [name, cmd] of bashControls) {
    it(`Bash allows: ${name}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).toBe('allow');
    });
  }

  const psControls: Array<[string, string]> = [
    ['Get-ChildItem piped to Select-Object', String.raw`Get-ChildItem C:\data | Select-Object Name`],
    ['Remove-Item of a single file', `Remove-Item build.log`],
    ['[IO.Directory]::Delete with literal $false', `[IO.Directory]::Delete($p,$false)`],
  ];
  for (const [name, cmd] of psControls) {
    it(`PowerShell allows: ${name}`, () => {
      expect(decide(cmd, interactiveFor('PowerShell'), {}).decision).toBe('allow');
    });
  }
});

// ---------------------------------------------------------------------------
// Round 2 critic findings on 5f89c87f (C1, H1, H2, M1).
// ---------------------------------------------------------------------------

// C1: a catastrophic regex is synchronous, so vitest cannot time it out in-process. Each case runs the
// real src (bundled with esbuild) in a child process with a hard kill, so a hang fails instead of stalling the file.
// Call inside a describe: it registers the bundle build and returns the timer.
function childTimer(): (fn: 'decide' | 'install', cmd: string) => Promise<number> {
  let bundle = '';
  beforeAll(async () => {
    const { buildSync } = await import('esbuild');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const hooksDir = fileURLToPath(new URL('../../', import.meta.url));
    const entry = [
      `import { decide } from './src/destructive-command-guard.ts';`,
      `import { installSegments } from './src/package-install-guard.ts';`,
      `import { readFileSync } from 'node:fs';`,
      `const cmd = readFileSync(0, 'utf8');`,
      `const t0 = performance.now();`,
      `if (process.argv[2] === 'decide') decide(cmd, { tool_name: 'Bash', permission_mode: 'default' }, {});`,
      `else installSegments(cmd, 'Bash');`,
      `console.log(JSON.stringify({ ms: performance.now() - t0 }));`,
    ].join('\n');
    const out = buildSync({
      stdin: { contents: entry, resolveDir: hooksDir, loader: 'ts', sourcefile: 'c1-entry.ts' },
      bundle: true, platform: 'node', format: 'esm', write: false, preserveSymlinks: true,
      external: ['better-sqlite3'],
      banner: { js: "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);" },
    });
    bundle = join(mkdtempSync(join(tmpdir(), 'dcg-c1-')), 'c1.mjs');
    writeFileSync(bundle, out.outputFiles[0].text);
  });

  return async (fn, cmd) => {
    const { spawnSync } = await import('node:child_process');
    // VITEST keeps the bundled hooks' main() from running in the child.
    const res = spawnSync(process.execPath, [bundle, fn], { input: cmd, encoding: 'utf8', timeout: 5000, env: { ...process.env, VITEST: 'true' } });
    expect(res.signal, `${fn} killed after 5000 ms`).toBeNull();
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout.trim().split('\n').pop()!).ms;
  };
}

describe('C1: launcher regexes stay linear (x200 of each overlapping token)', () => {
  const timeIt = childTimer();
  const cases: Array<[string, string]> = [
    ['sudo -u run', 'sudo ' + '-u '.repeat(200) + 'x'],
    ['sudo -g run', 'sudo ' + '-g '.repeat(200) + 'x'],
    ['env -u run', 'env ' + '-u '.repeat(200) + 'x'],
    ['env -u run with a substitution after it (critic repro shape)', 'env ' + '-u '.repeat(200) + 'x; echo "$(rm -rf y)"'],
    ['timeout flag run (flag vs duration)', 'timeout ' + '-k '.repeat(200) + 'x'],
    ['xargs flag run', 'xargs ' + '-a '.repeat(200) + 'x'],
    // Audit find: `x=/nohup` matched both the VAR=x item and a path-prefixed launcher.
    ['VAR=x item that is also a path-prefixed launcher', 'x=/nohup '.repeat(200) + 'y'],
  ];
  for (const [name, cmd] of cases) {
    it(`decide(): ${name} finishes in under 1000 ms`, async () => {
      expect(await timeIt('decide', cmd)).toBeLessThan(1000);
    }, 20_000);
    it(`installSegments(): ${name} finishes in under 1000 ms`, async () => {
      expect(await timeIt('install', cmd)).toBeLessThan(1000);
    }, 20_000);
  }

  it('the critic repro still asks (the substitution after the env run is classified)', () => {
    expect(decide('env ' + '-u '.repeat(5) + 'x; echo "$(rm -rf y)"', interactiveFor('Bash'), {}).decision).not.toBe('allow');
  });
});

describe('H1: a top-level escaped quote does not open a string', () => {
  const bash: Array<[string, string]> = [
    ['escaped single quotes around rm -rf', String.raw`echo \'; rm -rf x; echo \'`],
    ['escaped single quotes around git reset --hard', String.raw`echo \'; git reset --hard; echo \'`],
    ['F01 sq-escape still asks (backslash is literal inside single quotes)', String.raw`echo 'a\'; rm -rf x; echo '`],
    // CodeRabbit CLI on 24d6dba1: inside "...", bash keeps \' as \', so the inner shell reads an escaped quote.
    ['escaped single quotes inside a double-quoted wrapper payload', String.raw`bash -c "echo \'; rm -rf x; echo \'"`],
    ['escaped single quotes inside a double-quoted wrapper payload (git)', String.raw`sh -c "echo \'; git reset --hard; echo \'"`],
  ];
  for (const [name, cmd] of bash) {
    it(`Bash asks: ${name}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  it('PowerShell asks: backtick-escaped single quotes around Remove-Item -Recurse', () => {
    const cmd = "Write-Output `'; Remove-Item -Recurse x; Write-Output `'";
    expect(decide(cmd, interactiveFor('PowerShell'), {}).decision).not.toBe('allow');
  });
});

describe('H2: git -C and a Git Bash /c/ path are not exec flags', () => {
  const allowRows: Array<['Bash' | 'PowerShell', string, string]> = [
    ['PowerShell', 'git-safe -C with a commit message naming rm -rf', String.raw`pwsh -File scripts/git-safe.ps1 -C C:\repo commit -m "fix(guard): ask on rm -rf build"`],
    ['Bash', 'git-safe -C with a commit message naming git reset --hard', String.raw`pwsh -File scripts/git-safe.ps1 -C C:\repo commit -m "fix: git reset --hard now asks"`],
    ['Bash', 'pwsh -File with a /c/ path', `pwsh -File /c/Users/dkhay/continuous-claude/scripts/git-safe.ps1 commit -m "fix: rm -rf build now asks"`],
    ['Bash', 'bash running a script under /c/', `bash /c/Users/dkhay/x/run.sh "git reset --hard"`],
  ];
  for (const [tool, name, cmd] of allowRows) {
    it(`${tool} allows: ${name}`, () => {
      expect(decide(cmd, interactiveFor(tool), {}).decision).toBe('allow');
    });
  }

  // Layer 2 no longer runs on a segment the wrapper regex matched, so layer 1 must reach every F03/WR row.
  const layer1Rows = [
    `/bin/bash -c "rm -rf /"`,
    `wsl bash -c "rm -rf ~"`,
    `exec bash -c "rm -rf x"`,
    `timeout 5 bash -c "rm -rf x"`,
    `find . | xargs sh -c 'rm -rf "$@"' _`,
    `sudo -u root bash -c "rm -rf x"`,
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -Command "Remove-Item -Recurse x"`,
    String.raw`C:\Windows\System32\cmd.exe /c "rd /s /q x"`,
    `bash --rcfile "/zz x" -c "rm -rf x"`,
    `pwsh -wd "C:/zz" -c "Remove-Item -Recurse x"`,
  ];
  for (const cmd of layer1Rows) {
    it(`layer 1 extracts a payload: ${cmd}`, () => {
      expect(extractShellWrapperPayloads(cmd).length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('heredoc bodies: the top-level scan reads them, as on fork/main (R2 reverts M1)', () => {
  // Accepted false positive (same as fork/main): a literal heredoc body that names a destructive
  // command asks. Dropping the body let a written script run unseen (R2: write-then-run).
  it('Bash asks (accepted FP): a literal heredoc PR body that names rm build -rf', () => {
    const cmd = `cat <<'EOF' > PR.md\n- rm build -rf now asks (F04)\nEOF`;
    expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
  });
  const askRows: Array<[string, string]> = [
    ['heredoc piped into bash', `cat <<'EOF' | bash\nrm -rf x\nEOF`],
    ['bash reading a heredoc', `bash <<'EOF'\nrm -rf x\nEOF`],
    ['expanding heredoc body with a substitution', `cat <<EOF > x\n$(rm -rf y)\nEOF`],
    ['F14: quote opened before a heredoc line', `echo "x\ncat <<'EOF'\ny"\nbash -c "rm -rf /"\nEOF`],
  ];
  for (const [name, cmd] of askRows) {
    it(`Bash asks: ${name}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
});

// ---------------------------------------------------------------------------
// Round 3: regressions vs fork/main 9af5e0e5 (R1-R5). Each row asked (or ran fast) on fork/main.
// ---------------------------------------------------------------------------

// R1: the wrapper payload tail `\S.*)(?:\s.*)?$` cannot cross a `\r` (JS `.` excludes it), so every exec
// flag position retried every split of the tail: cubic. 10 KB of ' -c x' then '\r' runs.
describe('R1: the wrapper payload tail stays linear on a mid-line CR', () => {
  const timeIt = childTimer();
  const tail = '\ry\rz\nbash -c "rm -rf ~/x"';
  const cases: Array<[string, string]> = [
    ['bash -c run', 'bash' + ' -c x'.repeat(2000) + tail],
    ['pwsh -c run', 'pwsh' + ' -c x'.repeat(2000) + tail],
    ['cmd /c run', 'cmd' + ' /c x'.repeat(2000) + tail],
  ];
  for (const [name, cmd] of cases) {
    it(`decide(): ${name} finishes in under 1000 ms`, async () => {
      expect(await timeIt('decide', cmd)).toBeLessThan(1000);
    }, 20_000);
    it(`installSegments(): ${name} finishes in under 1000 ms`, async () => {
      expect(await timeIt('install', cmd)).toBeLessThan(1000);
    }, 20_000);
  }
  it('decide(): docker compose down x500 finishes in under 200 ms', async () => {
    expect(await timeIt('decide', 'docker compose down '.repeat(500))).toBeLessThan(200);
  }, 20_000);
  it('the critic repro still asks (the wrapper on the last line is classified)', () => {
    const cmd = 'bash' + ' -c x'.repeat(5) + tail;
    expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
  });
  it('a wrapper payload with a CR inside still yields the payload', () => {
    expect(extractShellWrapperPayloads('bash -c x\ry').length).toBeGreaterThanOrEqual(1);
  });
});

describe('R2: a heredoc that writes a script which then runs asks', () => {
  const rows: Array<[string, string]> = [
    ['cat <<EOF > x.sh, then bash x.sh', `cat <<'EOF' > x.sh\nrm -rf /\nEOF\nbash x.sh`],
    ['cat > x.sh <<EOF, then sh x.sh', `cat > x.sh <<'EOF'\nrm -rf ~\nEOF\nsh x.sh`],
    ['tee x.sh <<EOF with git reset --hard, then bash x.sh', `tee x.sh <<'EOF'\ngit reset --hard\nEOF\nbash x.sh`],
    ['cat <<EOF > x.sh, then chmod +x and ./x.sh', `cat <<'EOF' > x.sh\nrm -rf /\nEOF\nchmod +x x.sh; ./x.sh`],
  ];
  for (const [name, cmd] of rows) {
    it(`Bash asks: ${name}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
});

describe('R3: git checkout with a pathspec discards changes', () => {
  const ask = [
    'git checkout ./src',
    'git checkout ./',
    'git checkout --pathspec-from-file=list.txt',
    'git checkout --theirs src/a.ts',
    'git checkout --ours src/a.ts',
  ];
  for (const cmd of ask) {
    it(`Bash asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  const allow = ['git checkout -b new-branch', 'git checkout main', 'git checkout fix/x', 'git checkout --track origin/x'];
  for (const cmd of allow) {
    it(`Bash allows: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).toBe('allow');
    });
  }
});

// git parse-options accepts any unique prefix of a long option.
describe('R4: an abbreviated long option is the option', () => {
  const ask = [
    'git clean --fo',
    'git clean --forc -d',
    'git clean -d --f',
    'git checkout --forc main',
    'git push --forc origin main',
    'git reset --har',
    'git branch --forc main abc',
  ];
  for (const cmd of ask) {
    it(`Bash asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  // --follow-tags shares `--fo` with --force (push); --format shares `--for` with --force (branch).
  const allow = [
    'git clean -n',
    'git clean --dry-run',
    'git reset --soft HEAD~1',
    'git push --follow-tags',
    `git branch --format='%(refname)' --list`,
  ];
  for (const cmd of allow) {
    it(`Bash allows: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).toBe('allow');
    });
  }
});

describe('R5: docker compose down must be the verb, not a file name', () => {
  it('Bash allows: docker compose -f down.yml up -v', () => {
    expect(decide('docker compose -f down.yml up -v', interactiveFor('Bash'), {}).decision).toBe('allow');
  });
  it('Bash asks: docker compose -f x.yml down -v', () => {
    expect(decide('docker compose -f x.yml down -v', interactiveFor('Bash'), {}).decision).not.toBe('allow');
  });
});

// pwsh, powershell and cmd join every argument after -c / -Command / /c into the command they run
// (`pwsh -c echo '; Write-Output INJECTED'` prints INJECTED). A POSIX shell takes the next word as $0.
describe('B1: pwsh/powershell/cmd run the arguments after the quoted payload', () => {
  const bash = [
    `pwsh -c "echo" "; git reset --hard"`,
    `pwsh -c "echo" "; rm -rf x"`,
    `pwsh -c 'echo' '; git push --force'`,
    `cmd /c "echo A" "& rd /s /q C:\\data"`,
    `cmd /c "echo A" "& git reset --hard"`,
  ];
  for (const cmd of bash) {
    it(`Bash asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  const ps = [
    `pwsh -c "echo" "; git reset --hard"`,
    `pwsh -c "echo" "; Remove-Item -Recurse x"`,
    `cmd /c "echo A" "& rd /s /q C:\\data"`,
    `powershell -Command "echo" "; Remove-Item -Recurse C:\\data"`,
  ];
  for (const cmd of ps) {
    it(`PowerShell asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('PowerShell'), {}).decision).not.toBe('allow');
    });
  }
  // F1 flips this row: accepted fail-closed false positive. The trailing args of a POSIX wrapper are read
  // with the payload, because the payload can run them ($1, $@, eval). Here the second string is only $0.
  for (const cmd of [`bash -c "echo" "; rm -rf x"`, `sh -c "echo" "; rm -rf x"`]) {
    it(`Bash asks (accepted FP): ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  const installs: Array<[string, string]> = [
    [`pwsh -c "echo" "; npm install zz-fake-pkg-a1"`, 'Bash'],
    [`pwsh -c "echo" "; npm install zz-fake-pkg-a1"`, 'PowerShell'],
    [`cmd /c "echo A" "& npm install zz-fake-pkg-a1"`, 'Bash'],
  ];
  for (const [cmd, tool] of installs) {
    it(`installSegments (${tool}) finds the install in: ${cmd}`, () => {
      expect(installSegments(cmd, tool).length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('B2: git checkout asks on a long option outside the branch-switch set', () => {
  const ask = [
    'git checkout --no-overlay main src/',
    'git checkout --no-overlay HEAD~3 src/a.ts',
    'git checkout --quiet src/a.ts',
    'git checkout --progress main src/a.ts',
    'git checkout --merge src/a.ts',
    'git checkout --conflict=merge src/a.ts',
  ];
  for (const cmd of ask) {
    it(`Bash asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  const allow = [
    'git checkout --track origin/x',
    'git checkout --detach',
    'git checkout --orphan x',
    'git checkout -b new-branch',
    'git checkout main',
    'git checkout fix/x',
    'git checkout --no-track main',
  ];
  for (const cmd of allow) {
    it(`Bash allows: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).toBe('allow');
    });
  }
});

describe('B3: time/nohup take flags; the interpreter fallback runs SEGMENT_PATTERNS', () => {
  const fabric = 'az fabric capacity suspend -n cap -g rg';
  const bash = [
    `time -p bash -c "${fabric}"`,
    `nohup -- bash -c "${fabric}"`,
    `time -p sh -c '${fabric}'`,
    // A launcher shape the wrapper regex does not parse (`nice -n 5`): only the fallback sees it.
    `nice -n 5 bash -c "${fabric}"`,
  ];
  for (const cmd of bash) {
    it(`Bash asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  it(`PowerShell asks: time -p bash -c "${fabric}"`, () => {
    expect(decide(`time -p bash -c "${fabric}"`, interactiveFor('PowerShell'), {}).decision).not.toBe('allow');
  });
  const installs = [`time -p bash -c "npm install zz-fake-pkg-a1"`, `nohup -- bash -c "npm install zz-fake-pkg-a1"`];
  for (const cmd of installs) {
    it(`installSegments finds the install in: ${cmd}`, () => {
      expect(installSegments(cmd, 'Bash').length).toBeGreaterThanOrEqual(1);
    });
  }
});

// F1: a POSIX wrapper payload can run its trailing args (`bash -c 'eval "$1"' _ 'rm -rf x'`). The payload
// and the trailing args (quote characters deleted) are classified as one text, for every shell.
describe('F1: a wrapper payload can run its trailing args, for every shell', () => {
  const bash = [
    `bash -c 'eval "$1"' _ 'rm -rf x'`,
    `bash -c '$1' _ 'git reset --hard'`,
    `bash -c 'eval "$1"' _ 'git push --force'`,
  ];
  for (const cmd of bash) {
    it(`Bash asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  it(`PowerShell asks: bash -c 'eval "$1"' _ 'rm -rf x'`, () => {
    expect(decide(`bash -c 'eval "$1"' _ 'rm -rf x'`, interactiveFor('PowerShell'), {}).decision).not.toBe('allow');
  });
  it(`installSegments finds the install in: bash -c 'eval "$1"' _ 'npm install zz-fake-pkg-a1'`, () => {
    expect(installSegments(`bash -c 'eval "$1"' _ 'npm install zz-fake-pkg-a1'`, 'Bash').length).toBeGreaterThanOrEqual(1);
  });
});

// F2: only the switches git rejects together with a pathspec stay allowed. Every other long option before a
// pathspec (`--guess main src`) restores files.
describe('F2: git checkout switch allowlist holds only switches that reject a pathspec', () => {
  const ask = [
    'git checkout --recurse-submodules main src',
    'git checkout --no-recurse-submodules main src',
    'git checkout --overwrite-ignore main src',
    'git checkout --ignore-other-worktrees main src',
    'git checkout --guess main src',
    'git checkout --no-guess main src',
    String.raw`git -C C:\repo checkout --recurse-submodules main src`,
  ];
  for (const cmd of ask) {
    it(`Bash asks: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).not.toBe('allow');
    });
  }
  const allow = [
    'git checkout --track origin/x',
    'git checkout --detach',
    'git checkout --orphan x',
    'git checkout --no-track main',
    'git checkout -b new-branch',
    'git checkout main',
    'git checkout fix/x',
  ];
  for (const cmd of allow) {
    it(`Bash allows: ${cmd}`, () => {
      expect(decide(cmd, interactiveFor('Bash'), {}).decision).toBe('allow');
    });
  }
});

describe('B3: time/nohup flag runs stay linear (x200)', () => {
  const timeIt = childTimer();
  const cases: Array<[string, string]> = [
    ['time -p run', 'time ' + '-p '.repeat(200) + 'x'],
    ['nohup -- run', 'nohup ' + '-- '.repeat(200) + 'x'],
    // A flag that is also a VAR=x item, and a flag that is also a path-prefixed launcher.
    ['time flag that is also a VAR=x item', 'time ' + '-x=y '.repeat(200) + 'z'],
    ['time flag that is also a path-prefixed launcher', 'time ' + '-x/time '.repeat(200) + 'z'],
    ['nohup flag that is also a path-prefixed launcher', 'nohup ' + '-x/nohup '.repeat(200) + 'z'],
  ];
  for (const [name, cmd] of cases) {
    it(`decide(): ${name} finishes in under 1000 ms`, async () => {
      expect(await timeIt('decide', cmd)).toBeLessThan(1000);
    }, 20_000);
    it(`installSegments(): ${name} finishes in under 1000 ms`, async () => {
      expect(await timeIt('install', cmd)).toBeLessThan(1000);
    }, 20_000);
  }
});
