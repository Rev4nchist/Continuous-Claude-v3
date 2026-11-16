#!/usr/bin/env node
/**
 * decision-gate -- PreToolUse. Pathway flow v2, design N3.
 *
 * Denies, in a CCv3 checkout and in a covered app folder (see "App folders" below), a command that needs Dave's tap (an AskUserQuestion answer, written by decision-ledger as a
 * DECISION in the store, scripts/github/lib/decisions.mjs) when that tap is not on record. The deny text names the question to ask.
 *   open-pr   a PR create (gh api .../pulls POST, gh pr create): needs "Open draft PR" for (branch, head of the branch).
 *   land      land-pr.ps1, gh pr merge, gh api .../merge: need "Land now" or "Land when READY" for the PR. A PreToolUse hook
 *             does not call GitHub for the PR head. So land-pr.ps1 (which pins the head itself, land-decision.mjs) passes on a PR-level
 *             tap, and a raw merge command passes only with sha= or --match-head-commit equal to the tapped head.
 *             A command with several lands or merges (&& ; | newline) is judged one segment at a time: each needs its own tap and sha.
 *   store     a write to the decision store: Write, Edit, NotebookEdit, the Desktop Commander writes (write_file, edit_block,
 *             move_file and write_pdf, by path or destination; a .. in the path is collapsed), and shell text that writes the
 *             store or runs its code (node -e ...). Shell text that uses a tap up (land-decision.mjs use) or loops
 *             pr-checkpoint.mjs --json --pr is denied too: the model must not burn taps from a shell. That text check is best
 *             effort (a loop built from variables is not seen). Only decision-ledger writes decisions. A plain read passes.
 *   push      git push (git, git.exe, git-safe.ps1, git-for.ps1; any -C, -c, --no-pager before the verb) to the fork from a CCv3 checkout,
 *             to a branch other than main: needs "Commit and push" or "Push only" (ship step) for that branch and for the TREE being pushed.
 *             "Commit and push" is bound to the index tree before the commit (ship-ask.mjs), so the check compares it with <src|HEAD>^{tree}
 *             at push time: the head moves when the commit is made, the tree does not. "Push only" is asked with nothing staged and is bound
 *             to HEAD^{tree}. It licenses a push that has no commit chained before it, never a commit and push in one command. A force or delete form (--force, -f, --force-with-lease, +refspec,
 *             --mirror, --all, --tags, --delete, -d, --prune, :dst) is denied even with a tap. A push to origin (upstream) is denied.
 *             A dry run, --help, `git stash push`, another remote and a checkout that is neither CCv3 nor covered pass. A push to main passes unless it is a force form.
 *             A command with several pushes is judged one push at a time, like land.
 * App folders (card coord-decision-gate-app-repos, Dave's taps D1 a and D2 a; for the push, Dave's decision of 2026-11-13 replaces D2 a:
 * only a push to a default branch needs a tap). A folder that is NOT a CCv3 checkout is covered when
 * shared/tap-scope.ts says so: its git toplevel, or the main root of its worktree, EQUALS the root of a live registry entry that is not
 * continuous-claude and not switched off. isCcv3Checkout is always asked first (routeOf, fixer G), and every CCv3 path keeps its code, key
 * and texts (G4: stdout byte-equal to base main 7a0e2f34). The CCv3 differences, both listed: (R5c) a create or merge in a CCv3 checkout
 * whose gh call names another repo (-R, --repo, GH_REPO in its own or ANY earlier segment, a repos/<o>/<r> path, a PR URL) is denied
 * "go to that repo folder" (repo-foreign) before any CCv3 signal of the whole text counts, never judged with the CCv3 key; (BACKSLASH) a
 * -C value with a backslash is judged as the folder it names. The repo is read only where gh takes one, in the gh
 * call's own command, outside quoted prose (commandRepo, F1): a --body, a --title, a heredoc or a chained gh call names no repo. In a
 * covered folder a CCv3 slug outside that command (a CCv3 URL in a --body) does not open the CCv3 rule. In a covered folder the gate proves the tap only (no
 * pre-pr stamp, no CI, no READY). The key is ONE rule in scripts/github/lib/repo-identity.mjs (pushKey, ghKey), which app-ask.mjs runs over
 * the same git questions, so the tap it writes has the key read here (fix round 1, fixer C). Key repo: the lowercased GitHub owner/repo; a
 * URL with no github.com slug keys on the github field of the entry when its owner/repo equals it (an SSH host alias), else on
 * local:<entry key>:<target> (one key per non-GitHub target); a folder with no remote keys on local:<entry key>.
 *   push      the push URLs (every pushurl) of the remote the push names (a remote name is resolved by git first, then a URL or a path),
 *             else of @{push}; neither: denied "name the remote". Push URLs of two repos: denied (push-urls, one push URL per tap). The
 *             branch is the destination; a bare push updates the branch of @{push} when it goes to that remote (push.default=upstream).
 *             The offer names --remote, --branch and --src (the tree is of the source ref). Every remote is gated, none is banned.
 *             Dave 11-13: only a push that can update a DEFAULT branch of the target needs a tap (compared in lower case, fix round 5
 *             F6: Main and MASTER count): main, master, and the branch
 *             refs/remotes/<remote>/HEAD names (one git symbolic-ref --quiet --short, of a configured remote only: a URL target is off
 *             the list below). heads/<b> and refs/heads/<b> are <b>; @ is the current branch (both on the tap path).
 *             STRICT ALLOW-LIST (fix round 3, fixer H; it replaces the fixer F reading of shell text): a push skips the tap only when
 *             ALL hold. Command: every segment is a cd, read-only git, a plain commit or a push, 2>&1 allowed (steadyCommand: no
 *             checkout, tag, config or add before it). Text: git (plain path) or git-safe.ps1 (direct, or pwsh [-NoProfile] -File) push
 *             with no lead-in (no VAR=, env, sudo, xargs), no global option but -C, only the
 *             options -u --set-upstream -q --quiet -v --verbose --porcelain --progress --no-progress, and no positional or exactly
 *             <remote> <branch> as plain words (remote ^[A-Za-z0-9][A-Za-z0-9._-]*$; branch ^[A-Za-z0-9][A-Za-z0-9._/-]*$, no .., no //,
 *             no trailing / or .lock, not refs/ heads/ tags/ remotes/, not HEAD; so no colon, no +, no @, no quote). (Fix round 4: the
 *             GIT_CONFIG / HOME text test is gone; a lead-in or an assignment segment already fails the two rules above.) Checkout: a
 *             configured remote (git remote lists it); no push config in pushConfigOf; no local refs/tags/<branch>; a destination (a
 *             bare push: the branch of @{push}) that is not main, master or the branch of a readable remote HEAD. Anything else takes
 *             the tap path, unchanged; a command with several refspecs passes only when every one does.
 *             Hard denies, tap or not (scope app-push, below):
 *               push-unsafe: force, delete, mirror, all, branches, tags, prune, and any prefix of those long names (--mirr, --del,
 *               --al: git takes a unique prefix; fix round 4), a force letter before the o of a short bundle, a remote.<r>.mirror that
 *               is not false or a + remote.<r>.push (the text names the key and says to ask Dave).
 *               push-target-unresolved: --repo (name the repo as the remote argument); push config that makes git write more than the
 *               branch the tap would name (fix round 4, critic major 1): any remote.<r>.push for a push with no colon refspec, push.default=
 *               matching for a bare push only, push.recurseSubmodules (not a false word or check) or submodule.recurse on unless the command
 *               says --no-recurse-submodules, push.followTags on unless --no-follow-tags; the same on the command (--follow-tags,
 *               --recurse-submodules=<on>, a -c push.*, remote.* or submodule.* key); a short bundle with o (-oh, -uo x: the rest is the
 *               push option value); and a hidden push (below). The text names the way out: git push <remote> <src>:<dst>
 *               --no-recurse-submodules (plus --no-follow-tags), which takes the tap path.
 *               Also: a subagent push, push URLs of two repos, a remote or branch that cannot be named, position unknown.
 *             THE VERB RULE (fix round 6; Dave's decision 2026-11-13, seat session, "Stop accidents, list the rest"): the gate stops
 *             ordinary commands and mistakes (a plain force push, a push to a default branch, a subagent push, an unusual push form).
 *             rawVerdict judges by the VERB of each git call outside quotes (a git word anywhere outside quotes counts: fail closed),
 *             never by the word push anywhere in the text. Verb push: `ok` when the WHOLE text is the strict reading (steadyCommand, each
 *             push segment one call whose every word the strict reader accounts for: the listed options, a dry run or help (quiet is
 *             decided ONLY here, F1), one -C at most (F4), no or exactly <remote> <branch>); else every shape takes the tap path.
 *             Another plain verb (add, commit, log, stash): no push, so a commit message, a grep pattern or an echo text that holds push
 *             is text. The TAP PATH, never a hard deny, in the first covered folder of the raw folders (the cwd, the cd and -C words of
 *             the raw text, chained, and the move targets): a verb that is no plain word ($, backtick, a bracket, %, a quote, a backslash,
 *             a glob, or -c alias.<x>=), a shell -c, eval, cmd /c, pwsh -Command, Invoke-Expression or $( ) payload with git and push,
 *             and a push call no shape reads (an unknown global option, a wrapper or control word the shapes do not read). The HARD
 *             deny of the rule is a force spelling (--force*, --mirror, --delete and their prefixes, f or d in a short push bundle, +
 *             before a word) in a segment that holds a push call, such a payload or a -c alias.<x>= whose value holds push (seat ruling c,
 *             11-13): push-unsafe. A force word of another command (test -f)
 *             is no force. A reader throw is a push off the list: the tap path (catchShapes). A CCv3 or uncovered folder gets no deny
 *             from it (G4). PUSH_GIT and the CCv3 shapes are unchanged.
 *             KNOWN LIMITS (Dave 11-13: deliberate tricks are out of scope, listed, not read): a verb built at run time (git pu${x}sh,
 *             $'\x70ush', ${X:-push}, PowerShell ("pu"+"sh")) only takes the tap path when its git word is visible; an alias already in
 *             git config; encoded text; git send-pack; gh api writes to git refs; git config set in the environment; the git-safe and
 *             git-for wrappers pass git options on unread; a quoted $( ) whose git is not first (x="$(cd A && git push)"); text piped to a
 *             shell (echo '...' | sh); a variable for git ($GIT push).
 *             RULING B (F3, F4): a literal GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, --git-dir or --work-tree value names a repo folder
 *             (<root>/.git is <root>); a covered one is judged with the app rule (app-push), a CCv3 one or one that names no folder keeps
 *             the base path and text. Two or more -C values are applied in order, each relative to the one before (chainDir); a chain
 *             folder the base reading (last -C wins) misses is judged too when it is covered.
 *             RESIDUAL (fix round 4, critic major 4; seat rule: no network in the gate): the default branch is read from the local
 *             refs/remotes/<r>/HEAD. If GitHub's default changed and the local ref was not refreshed (git remote set-head <r> --auto),
 *             a push to the new default can pass with no tap. main and master are always default, so the common case holds.
 *             RESIDUAL: git config set in the environment (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT, a moved HOME) is not read; such a
 *             text is off the allow-list and takes the tap path, not a deny. A failed config read takes the tap path too. The wrappers
 *             (git-safe.ps1, git-for.ps1) get the -oh bundle test only: a git global option they pass on is not read. The config test
 *             denies on any matching line, where git uses the last one: a local false over a global true still denies (over-deny).
 *   create    "Open draft PR" for (key repo, branch, head); fix round 5 (F8): a base the create names (--base, -B, base=) is in the key
 *             (repo-identity.mjs openPrKey: repo@branch:base) and in the offer. merge: "Merge now (no READY check)", accepted only here, with sha= or
 *             --match-head-commit equal to the tapped head. Key repo: the FETCH URL (gh reads it) of the @{push} remote, else of the
 *             only remote. A named repo (-R) must be the fetch repo of a remote of the folder, and that remote keys it. Two or more
 *             remotes and none named, or one remote that fetches from one repo and pushes to another (fetch-push-differ): denied, name
 *             the repo with -R. Scope other (decisions.enforce). The land script stays a CCv3 tool.
 * Position unknown (popd, cd -, a bare cd) denies when the cwd or a known folder is CCv3 OR covered. Every deny text a covered folder shows
 * names the folder and the offer command by full path (node '<home>/continuous-claude/scripts/github/app-ask.mjs' <sub-command> --dir '<folder>';
 * the script path is in single quotes since seat review 1, item 6, and a home with a quote mark gets the stop line).
 * F2: a value from the repo or the command (branch, remote, folder) goes into that command only as one plain word (a folder in single
 * quotes). Fixer G: an unsafe value never gets a placeholder or a quoting rule. When app-ask reads the same value itself (the @{push}
 * remote, the current branch, the payload cwd) the command leaves the flag out; else the text holds one plain line: the value cannot be
 * passed safely in a command, tell Dave. An SSH host alias of an entry with no github field gets a line that the entry needs that field
 * (open-pr, merge). Every such value in an app text is one plain line (oneLine). Coverage runs no git unless a live entry root holds the folder by the path test (underLiveRoot: files only, F8).
 * Registry missing: nothing is covered, an allow; silent, except when LANE_REGISTRY_PATH names the file: then a guard-log row
 * (registry-missing, with the effect) and one warning line that names the file only; the line also ends the warn or deny text of the same
 * call. Registry corrupt (seat review 1, item 4; it replaces the S5 "pass with a warning"): the file exists but does not parse after one
 * retry (tap-scope.ts readRegistry). A push, a PR create and a merge in any folder outside CCv3 is then DENIED (registry-corrupt), with a
 * text that names the file and the way out (fix the file, or ask Dave); position unknown too. A push gets scope app-push off the tap path
 * (hard); a create or merge gets scope other, read with the home flags (decisions.enforce, as every app create or merge deny). A CCv3
 * checkout never reads the registry, so it keeps its old behaviour. Not covered by it: the denies that rest on a covered folder only
 * (the verb rule's unread push, cd-unexpanded, GIT_DIR and the cd alias, the catch of a git throw): with a corrupt registry no folder is
 * covered, so those keep their uncovered result.
 * LIMIT (seat answer S2): the gate reads the registry file itself, not the board key. Any session can edit the registry or its mirror, so
 * coverage guards against a slip, not against a session that edits the registry to dodge the gate. A create or merge that names a covered
 * repo, run from a folder that is neither CCv3 nor covered, is not judged.
 * KNOWN LIMITS of the app path (seat review 1, stated, not fixed):
 *   - A remote host with no dot (an ssh config alias such as github-work) is read as GitHub (repo-identity.mjs githubHost), so its
 *     owner/repo tail can take the github field of the entry.
 *   - A relative path target (git push ../other.git) keys on its text (local:<entry>:../other.git), not on the folder it names.
 *   - '@' in a local target makes the key ambiguous: decisions.mjs:34 joins repo and branch with '@' (local:e:/srv/a@b.git@feat).
 *   - git+ssh:// and www.github.com URLs give no GitHub slug. git+ssh:// keys as GitHub only through the github field of the entry
 *     (with no field, open-pr and merge ask for it). www.github.com always keys as local:, so open-pr and merge refuse it (gh cannot
 *     take that key): a dead end with no way out but a plain github.com remote.
 *   - git write-tree (a chained commit here, staged files in app-ask) writes tree objects into the repo: the one write of a read path.
 *   - The path test (underLiveRoot) treats a .git read error other than not-found as "no worktree", and the registry reader drops an
 *     entry with no key or a relative path, both silently.
 *   - app-ask.mjs (registryEntry) and tap-scope.ts (nearestEntry) pick an entry in a different order when two entries match one
 *     checkout: app-ask tests the raw and the real spelling of each entry in entry order; tap-scope tests the raw spelling against
 *     every entry first, then the real one. The entry key, and so a local: key, can then differ.
 *   - app-ask.mjs refuses a CCv3 checkout by the raw remote config (url, pushurl); the gate asks git remote -v (insteadOf applied).
 *   - commandRepo reads -R at the end of a short-flag cluster (-fR x) even when an earlier letter takes a value (-tR x is a title "R"):
 *     it fails closed.
 *   - Single use: an app tap is bound to the repo, the branch and one head or tree; the gate does not consume it; it ends with a new
 *     offer for the same step, key and head, or after 7 days (reviewer-2 round, seat 3c; pinned both sides).
 * Seat 3d (reviewer-2 round; Dave: never print a key): every remote in a text and in the offer --remote goes through stripCredentials
 * (repo-identity.mjs), and out() strips any scheme://user:token@ left in the output. The key is unchanged: a URL keys on its owner/repo
 * or on its stripped text, so the printed --remote gives the key the gate reads.
 * Reviewer-2 round, item 1 (an unpaired quote in a message hid a later push): readCommand blanks the body of a data heredoc or
 * here-string before any reading (blankBodies, the rule above blankHeredocs), so every maskQuoted site gets the blanked text. When a
 * quote is still left with no pair (hiddenPieces; # comments dropped first), a git push at a command position inside a quoted span is a
 * push no shape reads (rawVerdict: the tap path; a force, delete or wide spelling in that piece, or a subagent, makes it hard), and a gh
 * create or merge there is denied position-unknown in a covered folder. A CCv3 or uncovered folder gets no new deny from it. Item 3: the
 * cd-unexpanded and the unread-push denies are the tap path only when the push holds no hard kind and no agent_id; a payload push (sh -c)
 * with a force, delete (:dst) or wide (--all, --tags, --prune, --branches) spelling is push-unsafe. Item 4: a store write no longer
 * returns before the shapes; its deny comes first, and the shapes of the same command are judged too.
 * KNOWN LIMITS of this round (stated, not fixed):
 *   - In a CCv3 folder, when the blanker declines (PowerShell $msg = @' ... '@ then git commit -m $msg; git push --force fork feat), the
 *     push stays hidden as on main; card prflow-push-blocks carries it.
 *   - A git or gh subcommand that gives its stdin to a shell (for example a submodule foreach or an alias that starts sh) runs a
 *     blanked body: the blanker trusts the git or gh word of the segment.
 *   - git push -oh <remote> <branch>: the reader takes -h as help, so the push has no shape and takes the tap path; with enforceAppPush
 *     false it warns (seat ruling).
 *   - The missing-registry notice appears only when LANE_REGISTRY_PATH names the file; a corrupt registry gives no deny for a push that
 *     has no shape (the raw push denies need a covered folder, and a corrupt registry covers none).
 * Where it runs. A push, a create, a land and a merge are each judged in EVERY folder on the cd path before them (dirsAfter): with no cd,
 * the payload cwd; else the folder after each prefix of the cd list. The cwd joins them when any cd before the shape is joined to it by
 * something other than && (`;`, `||`, `|`, `&`, a line end), or follows a `||` or a pipe: that cd can fail or be skipped (`cd B extra`,
 * `true || cd B`) and the shell stays in the cwd (looseJoin, as pre-pr-gate planRun). A cd may not run (||, a subshell, &, a pipe, a comment),
 * so one deny in any of those folders denies. A cd after the shape never counts. When popd, Pop-Location, `cd -` or a bare cd comes
 * before a push, a create or a merge, the folder is unknown: it is denied if the cwd or a folder on the known cd path is a CCv3 checkout, or the
 * command names CCv3 (create and merge only). A push with an absolute -C names its folder, so it is judged there. The land script reads no folder, so it is judged by its tap only.
 * A cd target the shell expands and this hook cannot (`$D/..`, `$(pwd)/..`, a backtick, `~`, a glob, a PowerShell expression) is an unexpanded folder: denied in any checkout (cd-unexpanded),
 * and so is a relative cd after it (`cd $D && cd ..`). The same holds for a -C value. Fix round 6 (item 2): for the coverage test a leading ~, $HOME,
 * $env:USERPROFILE or %USERPROFILE% of a cd, -C or GIT_DIR value is the home folder (knownDirs); in a covered folder the deny is the app-push tap path;
 * a CCv3 or unknown target keeps the base deny and text. GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR in the text, and a cd alias (alias go=cd, Set-Alias go Set-Location),
 * are denied in any checkout too (the folder is not named). A bash cd name spelled `c\d`, `c''d` or `''cd` is read as cd. A comment line with an open `(` or backtick opens no subshell.
 * A wrapper before git (env, nice, timeout, xargs, setsid, sudo, with their options) is still a push.
 * Accepted over-deny: an unquoted read of the name (`echo $GIT_DIR`, `unset GIT_DIR`), an alias for cd that is never used, a variable cd before an absolute one (`cd $D && cd /abs`: the prefix is judged).
 * A quoted GIT_DIR= in an argument (`git commit -m "GIT_DIR= fix"`, `echo "GIT_DIR=x"`) is text. Accepted residual: `[Environment]::SetEnvironmentVariable('GIT_DIR', ...)`.
 * Accepted residual: `"cd" A` (a quoted name with letters in it), `sh -c '...'`, GIT_DIR set in the shell session before the command, GH_REPO, CDPATH,
 * a wrapper not listed (`doas`, `chrt`, `flock`), text sent to an existing Desktop Commander shell.
 * NOT gated: anything else. Known gaps: a push inside a child process (land-pr.ps1, scheduled jobs), `bash -c '...'`, a variable or alias for git.
 *
 * Mode. `decisions.enforce` is a TOP-LEVEL block of review-router.config.json (not `checkpoint`). Only a literal true denies.
 * Anything else, a missing file included, is WARN mode: the command runs and the hook adds a context line (and a log row).
 * This is the opposite of pre-pr-gate, which fails closed on a missing config: this gate ships OFF.
 * The push gate has its own flag, `decisions.enforcePush`, read the same way (a literal true denies; absent warns). A deny has a scope,
 * push, app-push or other, and the flag of its scope decides it in all three places: decide(), the subagent deny and the handle() catch.
 * app-push (a push deny in a covered folder) is the reverse: it DENIES by default, and only a literal false of `decisions.enforceAppPush`
 * makes it warn (seat condition G1). routerFlag reads only a literal true, so the gate parses the config text for that one key.
 * Dave 11-13 ("Hard denies always deny"): decisions.enforceAppPush literal false softens ONLY the tap path of an app push (a push to a
 * default branch, a push form off the strict list, the no-tap reasons: the shipTap deny, marked tapPath). The HARD denies of the app
 * push path stay denies whatever the flag says: a force push in any spelling (push-unsafe), a subagent push, a mirror or '+' push
 * config, config that widens the push, --repo, an o bundle, and every other app-push deny (hardAppDeny). The tap path (tapPath) is also
 * the verb rule's unread push and the cd-unexpanded deny of a covered folder (fix round 6). The catch does the same for the hard kinds the
 * text alone shows (hardAppCall). CCv3 scopes and texts are unchanged.
 * Fix round 5 (ruling C, F5): enforceAppPush is read ONLY from <home>/continuous-claude/review-router.config.json, never from the payload
 * cwd upward, so a config file inside an app repo cannot turn its denies into warnings. Fix round 6 (item 1): so is decisions.enforce for
 * a deny of a covered folder (homeFlags: an app create, merge, position-unknown, cd-unexpanded or repo-moved; and the catch of a covered
 * call). CCv3 and enforcePush keep the lookup below.
 * A git throw after the path test put the folder under a live root reaches the catch as AppScopeError (scope app-push). A throw before
 * that (git remote -v fails or times out) gets app-push too when a push of the call runs in a folder the path test puts under a live root
 * (pushUnderLiveRoot), and so does a cd-unexpanded or GIT_DIR deny (coveredAmong). App-folder git (Deps.appGit, run inside inApp) stops
 * 7 s after the hook start (GitDeadlineError); the CCv3 path, isCcv3Checkout included, keeps the base runner with no total deadline (fix
 * round 3, item 4). Each git answer is kept for the rest of the call (perCall), keyed by its runner too.
 * LIMIT (what is left of the old one): a git throw keeps scope push when the path test does not place the folder under a live root
 * outside the continuous-claude root: a folder on a network path that is a linked worktree of a root elsewhere (no file is read there),
 * a worktree whose .git file cannot be read, and a live entry nested in the continuous-claude root (it may be a CCv3 checkout).
 * A command that mixes a push with a land is judged per scope: either flag that is on denies its own part.
 * The config is read from the payload cwd upward (no git), then from <home>/continuous-claude.
 *
 * Posture when enforcing: a gated shape that cannot be judged (git fails, no PR number in the text) is denied. Everything else passes.
 * Unreadable input (not JSON) has no visible shape: it passes, with one line on stderr. Blocking it would block all work.
 * A subagent (agent_id) never has a tap: its create, land and merge are denied, and so is a push to the fork of a CCv3 checkout (a push in
 * another repo, or to another remote, is not ours), and so is any push in a covered folder. -CleanupOnly never merges, so it passes.
 * There is NO override: no SKIP_* variable. Dave's tap is the only way. The hook guards against mistakes, not a hostile agent:
 * a command built from variables, an indirect script, or a store write from a language other than node is not seen.
 * Known best-effort gap: a Windows 8.3 short name of the store (DECISI~1.JSN) reaches the same file and is not seen.
 * A tool path is read with a ::$DATA or :stream suffix and trailing dots or spaces removed. The fields read are PATH_FIELDS.
 *
 * Two gates: the PreToolUse matcher in settings.json.template and COMMAND_TOOLS / WRITE_TOOLS below.
 * Guard: hook-matcher-runtime-consistency.test.ts.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, posix, resolve } from 'path';
import { isPrOpenCommand, isPrOpenText, joinContinuations, normalizeGh, squashQuotes } from './pr-opened-review-loop.js';
import { CCV3_REPO, commandRepo, hasNonLiteralRepo, namedRepo, priorGhRepo } from './shared/checkpoint-shapes.js';
import { answerKeyHitsOf } from './shared/answer-paths-door.js';
import { decisionKey, decisionRead, decisionRows, decisionsPath } from './shared/decisions-store.js';
import { countIdsIn, loadHoldoutIds } from './shared/holdout-ids.js';
import { CALL_START, GLOBAL_OPT, PATH_PREFIX, VAL, gitCallRe, isGitToken, isSafeToken, safeCallRe } from './shared/git-call.js';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';
import { blankInertQuotes, isTextOnlyCommand } from './shared/inert-quotes.js';
import { maskQuoted, quotedSpans } from './shared/mask-quotes.js';
import { routerFlag } from './shared/router-config.js';
import { readShellCommand, mayRunUnderCmd } from './shared/shell-tools.js';
import {
  coverageOf, ghKey, ghRemote, keyRepo, needsGithubField, oneLine, openPrKey, pushDefaults, pushKey, readRegistry, underLiveRoot, type GitRun, type Registry,
} from './shared/tap-scope.js';
// @ts-ignore TS7016: repo-identity.mjs has no declaration file (tap-scope.ts imports it the same way; esbuild bundles it).
import { stripCredentials } from '../../../scripts/github/lib/repo-identity.mjs';

const HOOK = 'decision-gate';
/** Seat 3d (Dave: never print a key): a remote as text, with no user:token part (the strip app-ask and the key use). */
const noCreds: (remote: string) => string = stripCredentials;
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', `${DC}start_process`, `${DC}interact_with_process`]);
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit', `${DC}write_file`, `${DC}edit_block`, `${DC}move_file`, `${DC}write_pdf`]);
/** The fields of a write tool that name a file. The Desktop Commander field names are not fixed by a schema we can read: read them all. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'destination', 'source', 'outputPath'];
const GIT_TIMEOUT_MS = 2000;

/** The options of one git read (card coord-decision-gate-round3-content-scan, F5): only the push scan sets them; absent keeps the defaults. */
export interface GitReadOpts { maxBuffer?: number; timeout?: number }
export interface Deps {
  git: (cwd: string, args: string[], opts?: GitReadOpts) => { status: number; stdout: string };
  /**
   * The ms left of the hook budget (HOOK_BUDGET_MS from the hook start). The push scan gives its reads no more than this, and denies when it
   * is gone before a read can run: a hook killed at 10 s writes no deny. Absent (tests): no budget.
   */
  scanLeft?: () => number;
  readFile: (path: string) => string | null;
  env: NodeJS.ProcessEnv;
  home: string;
  /**
   * The push scan seams (card prflow-push-blocks). BOTH present: a CCv3 push of a `re/` branch, or of any branch whose diff touches an
   * answer-key path, is scanned for holdout ids (scanHoldout). Absent (the old tests): no scan, no extra git call. realDeps sets both.
   * `holdoutIds(dir)` returns the ids (it throws on any problem, and an empty list is a problem); `answerKeyHits(paths)` the matching paths.
   */
  holdoutIds?: (dir: string) => string[];
  answerKeyHits?: (paths: string[]) => string[];
  /**
   * The registry for app folders (shared/tap-scope.ts). Absent: no folder outside CCv3 is covered and no extra git runs (the old tests).
   * `registry` is read lazily, at most once per call, and never for a CCv3 checkout. `realpath` is passed to coverageOf (default: fs).
   * `readFile` reads the .git file of a linked worktree for the path test (underLiveRoot; default: fs). It throws as fs does.
   */
  tapScope?: { registry: () => Registry; realpath?: (p: string) => string; readFile?: (p: string) => string };
  /**
   * Fix round 3 (fixer H, item 4): the git runner of the app-folder path (coverage, the app push, create and merge judgments). realDeps
   * gives it the 7 s total deadline; `git` (the CCv3 path, isCcv3Checkout included) keeps the base runner with no total deadline.
   * Absent: the app path uses `git`.
   */
  appGit?: (cwd: string, args: string[]) => { status: number; stdout: string };
}
/**
 * Which flag decides a deny: `push` is decisions.enforcePush, `other` is decisions.enforce, `app-push` is a push in a covered folder
 * (denies unless decisions.enforceAppPush is false, and then only its tap path warns: Dave 11-13, hard denies always deny).
 */
export type Scope = 'push' | 'other' | 'app-push';
/**
 * `notice` (decide() only): a MISSING registry file named by LANE_REGISTRY_PATH (S5; seat review 1, item 4: a corrupt file is the
 * registry-corrupt deny, not a notice). It rides on an allow, a warn and a deny alike (item 7).
 * `tapPath` (app-push only, Dave 11-13 "Hard denies always deny"): the deny is the tap path of an app push (shipTap), the only app-push
 * deny that a literal false of decisions.enforceAppPush turns into a warning. decide() drops it from the deny it returns.
 * `homeFlags` (fix round 6, item 1): the deny is for a covered folder, so decisions.enforce is read from the home copy only.
 */
export type Deny = { action: 'deny'; reason: string; pattern: string; scope: Scope; notice?: string; tapPath?: true; homeFlags?: true; hard?: true };
export type Decision = { action: 'allow'; warn?: string; scope?: Scope; notice?: string } | Deny;
interface HookInput { tool_name?: string; tool?: string; tool_input?: Record<string, unknown>; cwd?: string; agent_id?: string; session_id?: string }

/** The label of a decision that lets the action run. Any other label (Keep open, Stop here, Show ..., a re-run) does not. */
export const isOpenPrLabel = (label: string): boolean => /^Open draft PR\b/.test(label);
export const isLandLabel = (label: string): boolean => /^Land (?:now|when READY)\b/.test(label);
export const isShipLabel = (label: string): boolean => /^Commit and push\b/.test(label);
/** The tap of ship-ask when nothing is staged. Anchored: "Push only now" is not this label. */
export const isPushOnlyLabel = (label: string): boolean => /^Push only(?: \(Recommended\))?$/.test(label);
/** The merge tap of an app folder (app-ask.mjs). Accepted only in a covered folder: the CCv3 land gate reads isLandLabel. */
export const isMergeNowLabel = (label: string): boolean => /^Merge now \(no READY check\)(?: \(Recommended\))?$/.test(label);

// ---------- the question to ask, per deny ----------

const deny = (pattern: string, why: string, scope: Scope = 'other'): Deny => ({ action: 'deny', pattern, scope, reason: `BLOCKED (decision-gate): ${why}` });
/** The CCv3 text of base main 7a0e2f34, byte for byte for every branch (seat condition G4, fixer G). F2 is for the app texts only. */
const openPrWhy = (branch: string, head: string): string =>
  `no "open-pr" decision from Dave for ${branch} at ${head.slice(0, 7)}. Ask him first: run node scripts/github/ship-ask.mjs open-pr --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then open the PR only if he taps "Open draft PR".`;
const landWhy = (pr: string): string =>
  `no "land" decision from Dave for PR #${pr}. Ask him first: run node scripts/github/ship-ask.mjs land --pr ${pr} --json, pass its JSON to AskUserQuestion word for word. Only "Land now" or "Land when READY" lets a land run. If the PR already merged, run land-pr.ps1 -Pr ${pr} -CleanupOnly.`;
const pushWhy = (branch: string): string =>
  `no "ship" decision from Dave for the tree you push to ${branch}. Ask him first: run node scripts/github/ship-ask.mjs commit-and-push --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged). The tap is bound to one tree: the staged tree, or HEAD's tree for "Push only". A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
const PUSH_UNSAFE_WHY = 'a force, delete, mirror, all-branch or tag push can rewrite or remove remote refs, so it stays blocked even with Dave\'s tap. Push without that option. If it is really needed, ask Dave to run it himself.';
const PUSH_REFSPEC_WHY = 'a refspec that names a ref outside refs/heads and refs/tags, or holds a wildcard, can send refs that must stay local (refs/eval/*). Push one branch by name: git push fork <branch>.';
const PUSH_REPO_OPT_WHY = 'a --repo option names the push target, so the remote this gate reads is not where the push goes. Name the fork remote and push from the repo.';
const PUSH_ORIGIN_WHY = 'a push to origin is never allowed: origin is upstream (parcadei), not the fork. Push to the fork remote.';
const pushUnresolvedWhy = (what: string): string => `${what}, so its ship decision cannot be found. Name the remote and branch (git push fork <branch>) and run it from the repo.`;
const STORE_WHY = 'only decision-ledger writes the decision store, from Dave\'s tap in AskUserQuestion. Do not write it by hand. To record a decision, ask the question with AskUserQuestion.';
const SUBAGENT_WHY = 'a subagent cannot open a PR, land, merge or push: Dave\'s tap belongs to the main session. Ask the main session to do it.';
const NO_PR_WHY = 'the PR number cannot be read from this command, so its land decision cannot be found. Name the PR number in the command (land-pr.ps1 -Pr <n>, gh pr merge <n>).';
const goThereWhy = (repo: string): string => `this command names ${repo}, which is not the CCv3 repo, so it cannot be judged with a CCv3 decision: go to that repo folder and run it there.`;

// ---------- the texts of a covered app folder (R9, S6): the folder, the offer command by full path, no CCv3 tool, remote or switch ----------

const fwd = (p: string): string => p.replace(/\\/g, '/');
/** A value from the repo or the command (branch, remote, entry key, folder, head) as prose: one plain line (oneLine, G2), never raw. */
/** A scheme://user:token@ loses its user and token part. Used by prose (before its cut) and by out() on every output text. */
const CREDS_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/'"\\]*@/gi;
// PR 566 review (CodeRabbit, decision-gate.ts:472): the credentials go BEFORE the 200-code-point cut, so a cut cannot leave a user or token part.
const prose = (v: string): string => oneLine(v.replace(CREDS_RE, '$1'), 200);
/** The folder of a text, as prose. */
const at = (dir: string): string => prose(fwd(dir));
/** A remote of a text, as prose, with no user:token part (seat 3d). */
const remoteProse = (remote: string): string => prose(noCreds(remote));
/**
 * F2: a value goes into a runnable command only as one plain word: letters, digits and . _ / + -, and @ after the first character (not first
 * a -, never read as an option; PowerShell reads a leading @ as an operator). A remote may also hold : (a URL; : is a plain character in
 * Bash, PowerShell and cmd). A folder may also hold : and blanks, and goes in single quotes (no $, backtick or quote mark in it).
 * Fixer G (principal major): an unsafe value never gets a placeholder or a quoting rule. When app-ask reads the same value by itself in that
 * folder (the remote of @{push}, the current branch, the payload cwd), the command leaves the flag out; else the text holds one plain line:
 * the value cannot be passed safely in a command, tell Dave. U+2018 and U+2019 are unsafe (PowerShell reads them as quote marks).
 */
const SAFE_WORD = /^[A-Za-z0-9._/+][A-Za-z0-9._/@+-]*$/;
const SAFE_REMOTE = /^[A-Za-z0-9._/+][A-Za-z0-9._/@+:-]*$/;
const SAFE_DIR = /^[A-Za-z0-9._/@+:\\ -]+$/;
/** The payload cwd of a call, by its per-call Deps (decide): app-ask run with no --dir takes it. */
const CWDS = new WeakMap<Deps, string>();
/**
 * The arguments of an offer command, each a value from the repo or the command. `sub` is the app-ask sub-command (push, open-pr, merge).
 * `stop`: no command can serve this offer; the text holds this line instead (fixer G, item 7: an SSH alias with no github field).
 */
interface Offer { sub: 'push' | 'open-pr' | 'merge'; pr?: string; remote?: string | null; branch?: string; src?: string; base?: string; stop?: string }
/** The ask of a text: the offer command (with a note when app-ask reads a value itself), or one plain line when no command can serve it. */
type Ask = { ok: boolean; text: string };
const stopLine = (name: string, value: string): string => `the ${name} ${prose(value)} cannot be passed safely in a command; tell Dave.`;

/** The current branch of the folder, or null (git failed). */
function currentIn(deps: Deps, dir: string): string | null {
  const r = deps.git(dir, ['branch', '--show-current']);
  return r.status === 0 ? r.stdout.trim() : null;
}
/** What app-ask reads in `dir` when the flag is left out: the same rules (pushDefaults, ghRemote, the current branch). Null: unknown. */
function appAskReads(deps: Deps, dir: string, offer: Offer, name: string): string | null {
  const git = gitIn(deps, dir);
  try {
    if (name === 'remote') return offer.sub === 'push' ? pushDefaults(git, null).remote : ghRemote(git);
    if (name === 'branch') return offer.sub === 'push' ? pushDefaults(git, offer.remote ?? null).branch : currentIn(deps, dir);
    return currentIn(deps, dir);
  } catch {
    return null;
  }
}
/**
 * One flag of an offer: the word to add (`--flag value`), '' when app-ask reads the value itself, or null when it cannot be passed.
 * A <placeholder> stays (the text names the value to choose). An unsafe --src that is the current branch is HEAD to app-ask and the gate.
 */
function flagWord(deps: Deps, dir: string, offer: Offer, flag: string, value: string, safe: RegExp): string | null {
  if (value === `<${flag}>` || safe.test(value)) return `--${flag} ${value}`;
  // app-ask reads no PR number and no base by itself (F8: the base is in the key), so an unsafe one cannot be left out.
  if (flag === 'pr' || flag === 'base') return null;
  const read = appAskReads(deps, dir, offer, flag === 'src' ? 'current' : flag);
  if (read !== value) return null;
  return flag === 'src' ? '--src HEAD' : '';
}
/**
 * The offer command for an app folder: node <home>/continuous-claude/scripts/github/app-ask.mjs <sub> [--pr N] [--remote R] [--branch B]
 * [--src S] [--dir '<folder>'] --json, with a note when a flag is left out for app-ask to read; or (F2) one plain line.
 */
function askCmd(deps: Deps, offer: Offer, dir: string): Ask {
  if (offer.stop) return { ok: false, text: offer.stop };
  const flags: [string, string | null | undefined, RegExp][] = [
    // Seat 3d: the remote with no user:token part. app-ask keys a URL by its owner/repo (repoSlug) or its stripped text, so the key is the same.
    ['pr', offer.pr, /^\d+$/], ['remote', offer.remote ? noCreds(offer.remote) : offer.remote, SAFE_REMOTE], ['branch', offer.branch, SAFE_WORD], ['src', offer.src, SAFE_WORD], ['base', offer.base, SAFE_WORD],
  ];
  const words: string[] = [offer.sub];
  const read: string[] = [];
  for (const [flag, value, safe] of flags) {
    if (value === undefined || value === null) continue;
    const word = flagWord(deps, dir, offer, flag, value, safe);
    if (word === null) return { ok: false, text: stopLine(flag, value) };
    if (word === '') read.push(flag); else words.push(word);
  }
  const folder = fwd(dir);
  if (SAFE_DIR.test(folder)) words.push(`--dir '${folder}'`);
  else if (fwd(CWDS.get(deps) ?? '') === folder) read.push('folder');
  else return { ok: false, text: stopLine('folder', folder) };
  const note = read.length === 0 ? '' : ` (app-ask reads the ${read.join(' and the ')} itself: run it in that folder, on that branch)`;
  // Seat review 1, item 6: the script path in single quotes, as --dir, so a home with a space still runs; a home SAFE_DIR refuses gets the stop line.
  const script = `${fwd(deps.home)}/continuous-claude/scripts/github/app-ask.mjs`;
  if (!SAFE_DIR.test(script)) return { ok: false, text: stopLine('script path', script) };
  return { ok: true, text: `node '${script}' ${words.join(' ')} --json${note}` };
}
/** The ask part of a text: `ok(command)`, or the plain line when no command can serve the offer. */
const askPart = (deps: Deps, offer: Offer, dir: string, ok: (cmd: string) => string): string => {
  const a = askCmd(deps, offer, dir);
  return a.ok ? ok(a.text) : `Dave's question cannot be built as a command here: ${a.text}`;
};
const ASK_HOW = 'pass its JSON to AskUserQuestion word for word';
/** A key repo with the offer that builds the same key. */
interface AppRepo { key: string; offer: Offer }
const appOpenPrWhy = (deps: Deps, dir: string, repo: AppRepo, branch: string, head: string, base: string | null): string =>
  `no "open-pr" decision from Dave for ${prose(branch)}${base === null ? '' : ` into ${prose(base)}`} at ${prose(head.slice(0, 7))} in ${prose(repo.key)} (folder ${at(dir)}). ${askPart(deps, { ...repo.offer, branch, ...(base === null ? {} : { base }) }, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW}, then open the PR only if he taps "Open draft PR".`)}`;
const appMergeWhy = (deps: Deps, dir: string, repo: AppRepo, pr: string): string =>
  `no "land" decision from Dave for PR #${prose(pr)} of ${prose(repo.key)} at the head this command names (folder ${at(dir)}). ${askPart(deps, repo.offer, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW}.`)} Only "Merge now (no READY check)" lets the merge run, with sha= or --match-head-commit equal to the head he tapped.`;
const appMergeNoHeadWhy = (deps: Deps, dir: string, pr: string, offer: Offer): string =>
  `PR #${prose(pr)} (folder ${at(dir)}): a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Pass the tapped head: gh api .../merge -f sha=<head>, or gh pr merge ${/^\d+$/.test(pr) ? pr : '<n>'} --match-head-commit <head>. ${askPart(deps, offer, dir, (c) => `Ask the merge question first: ${c}.`)}`;
const appNoPrWhy = (dir: string): string => `the PR number cannot be read from this command (folder ${at(dir)}), so its land decision cannot be found. Name the PR number in the command (gh pr merge <n>).`;
/**
 * Why this push needs the tap, by the kind of risk (fixer F). A missing remote HEAD gets one plain line: the default branch is not known
 * here, and set-head records it. The remote goes into that command only as a plain word; else the line names no command (fixer G).
 */
function pushNeed(risk: PushRisk): string {
  if (risk.kind === 'default') return 'A push to main, master or the branch the remote HEAD names needs his tap; a push to another branch does not.';
  if (risk.kind === 'unsure') return 'This push can update a default branch of the repo, so it needs his tap.';
  if (!SAFE_WORD.test(risk.remote)) return `The default branch of remote ${remoteProse(risk.remote)} is not known in this checkout, so this push needs his tap.`;
  return `The default branch of remote ${remoteProse(risk.remote)} is not known in this checkout; git remote set-head ${risk.remote} --auto records it.`;
}
/** F3: the offer names the remote, the destination branch and the source ref of the push, so app-ask keys and binds what the gate reads. */
const appPushWhy = (deps: Deps, dir: string, repo: string, branch: string, offer: Offer, risk: PushRisk): string =>
  `no "ship" decision from Dave for the tree you push to ${prose(branch)}${risk.kind === 'default' ? ', a default branch of' : ' in'} ${prose(repo)} (folder ${at(dir)}). ${pushNeed(risk)} ${askPart(deps, offer, dir, (c) => `Ask him first: run ${c}, ${ASK_HOW}, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged).`)} The tap is bound to this repo, this branch and one tree. A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
/** The way out of a tap-path deny that no tap can clear as written (seat rulings a and b, 11-13). */
const PUSH_WAY_OUT = 'run git push as its own command: git push <remote> <branch>';
/**
 * Seat ruling a (11-13): a push with another command, a pipe or a redirect beside it (no commit before it) is not alone, so "Push only"
 * does not count for it. The deny stays; the text names the way out first, then the question for the push alone. It names no risk
 * line: the risk read here counts the other command, and the push alone may need no tap.
 */
const appNotAloneWhy = (deps: Deps, dir: string, offer: Offer): string =>
  `this push shares its command with another command, a pipe or a redirect (folder ${at(dir)}), so Dave's "Push only" tap does not count for it. To clear it, ${PUSH_WAY_OUT}. ${askPart(deps, offer, dir, (c) => `If the gate still asks for his tap then, ask him first: run ${c}, ${ASK_HOW}.`)}`;
const appPushUrlsWhy = (dir: string, remote: string, keys: string[]): string =>
  `remote ${remoteProse(remote)} of ${at(dir)} pushes to more than one repo (${prose(keys.join(', '))}), and one tap covers one push URL, so this push stays blocked even with Dave's tap. Push to one URL (git push <url> <branch>), or ask Dave to run it himself.`;
/** F6: the -R value is printed only as a plain owner/repo word; a local: key cannot be passed to gh. */
const ghRepoArg = (key: string): string => (SAFE_WORD.test(key) && !key.startsWith('local:') ? key : '<owner/repo>');
const appFetchPushWhy = (deps: Deps, dir: string, remote: string, key: string, pushKeys: string[], offer: Offer): string =>
  `remote ${remoteProse(remote)} of ${at(dir)} fetches from ${prose(key)} but pushes to ${prose(pushKeys.join(', '))}, so gh may act on another repo than the tap names. Name the repo gh acts on: add -R ${ghRepoArg(key)} to the command. ${askPart(deps, offer, dir, (c) => `The question for it: ${c}.`)}`;
const appNoTargetWhy = (deps: Deps, dir: string, remotes: string[], offer: Offer): string =>
  `${at(dir)} has more than one remote (${prose(remotes.join(', '))}) and its branch has no push target (@{push}), so the repo gh acts on is not known. Name the repo: add -R <owner/repo> (the repo of one remote). ${askPart(deps, offer, dir, (c) => `Then ask the question for that remote: ${c}.`)} Or set the push target first: git branch --set-upstream-to=<remote>/<branch>.`;
const appNameRemoteWhy = (deps: Deps, dir: string): string =>
  `this push names no remote and its branch has no push target (@{push}) in ${at(dir)}, so the repo of its ship decision cannot be known: name the remote and the branch (git push <remote> <branch>). ${askPart(deps, { sub: 'push', remote: '<remote>' }, dir, (c) => `Ask the ship question for that remote: ${c}.`)}`;
const appRepoOptWhy = (dir: string): string =>
  `--repo names the target of this push in ${at(dir)}, so the repo of its ship decision cannot be known, and it stays blocked even with Dave's tap: name the repo as the remote argument (git push <remote> <branch>).`;
const appPushUnresolvedWhy = (dir: string, what: string): string => `${prose(what)} (folder ${at(dir)}), so its ship decision cannot be found. Name the remote and the branch (git push <remote> <branch>) and run it from the repo folder.`;
/** The index tree read of a chained commit (shipTap): the one tree text that names no source word. */
const INDEX_TREE = 'the index (git write-tree)';
/**
 * Fix round 4 (fixer K, critic minor 6): a source word that is no plain ref (an expansion, a revision suffix, a splat) gives the same deny
 * again on a retry, so the text names the plain form. A plain branch or HEAD, and the index, keep the retry line.
 */
const appTreeWhy = (dir: string, what: string): string => {
  const plain = what === INDEX_TREE || what === 'HEAD' || strictBranch(what);
  return `cannot read the tree of ${prose(what)} in ${at(dir)}, so its ship decision cannot be found. ${plain ? 'Run the command again from the repo folder.' : 'To clear it, name the branch as plain text: git push <remote> <branch>.'}`;
};
const appUnsafeWhy = (dir: string): string => `a force, delete, mirror, all-branch or tag push can rewrite or remove remote refs (folder ${at(dir)}), so it stays blocked even with Dave's tap. Push without that option. If it is really needed, ask Dave to run it himself.`;
/** Fix round 4 (fixer K, critic minor 6): push-unsafe from config has no option to drop, so the text names the key. */
const appUnsafeConfigWhy = (dir: string, remote: string, key: string): string =>
  `remote ${remoteProse(remote)} is set as a mirror or has a + push refspec (${prose(key)}) in ${at(dir)}, so this push can rewrite or remove remote refs and stays blocked even with Dave's tap; ask Dave to run it himself or to change that config.`;
/** Fix round 4 (fixer K, critic major 1): the hard deny of push config that makes the push write more than the branch it names. */
const WIDER_WHY = 'git config makes this push write more than the branch it names; name both sides: git push <remote> <src>:<dst> --no-recurse-submodules, or ask Dave';
const appWiderConfigWhy = (dir: string, key: string): string =>
  `${WIDER_WHY}. The key: ${prose(key)} (folder ${at(dir)}).${key === 'push.followtags' ? ' With push.followTags set, add --no-follow-tags too.' : ''} A tap cannot cover it: the tap names one branch.`;
const appWiderOptWhy = (dir: string, opt: string): string =>
  `${prose(opt)} makes this push write more than the branch it names (tags, other branches or submodule repos) in ${at(dir)}, so it stays blocked even with Dave's tap: a tap names one branch. ${opt.startsWith('-c ') ? 'Run git push with no -c push setting' : 'Push without that option'}, or ask Dave.`;
/**
 * Fix round 5 (ruling A; it replaces the fix round 4 hidden-push text): a push word that no shape reads (a global option or an option
 * the gate does not know, more than one -C, sh -c, eval, a control word, a substitution, a git alias).
 */
/**
 * Fix round 6 (verb rule): a force spelling in a segment that holds a push call or a payload with git and push, off the strict reading.
 * A force-like word of another command in the same segment, or inside a payload, counts too, so the text names the way out.
 */
const appRawUnsafeWhy = (dir: string): string =>
  `this command holds a git push that is not one plain git push call, and a force or delete spelling is in its text (--force, --mirror, --delete, -f or -d in a short option bundle, a word that starts with +, a :branch delete, --all, --tags, --prune or --branches; folder ${at(dir)}), so it stays blocked even with Dave's tap. Run the push as its own command with no such word in it: git push <remote> <branch>. If a force push is really needed, ask Dave to run it himself.`;
const appUnreadWhy = (dir: string): string =>
  `this command holds a git push that this gate cannot read as one plain git push call (folder ${at(dir)}): a global option or an option it does not know, more than one -C, a shell -c, eval, a control word, a substitution or a git alias. To clear it, ${PUSH_WAY_OUT}, with no global option before push (git -C <folder> push is fine).`;
/** Item 1a: a gh create or merge behind a quote with no pair. */
const unpairedWhy = (dir: string): string =>
  `a quote mark in this command has no pair (a message the gate cannot read as one string), so where its PR create or merge runs and the repo it names cannot be read (folder ${at(dir)}). Put the message in a file (git commit -F <file>, --body-file <file>) and run the gh call as its own command.`;
/** Fix round 4 (fixer K, critic major 3): git reads the rest of a short bundle after o as the push option value. */
const appBundleWhy = (dir: string): string =>
  `a short option bundle with o (as in -oh or -uo) gives the rest of the word, or the next word, to the push option (folder ${at(dir)}), so the other flags of this push cannot be read: write -o <value> as its own word (git push -o <value> <remote> <branch>).`;
const appSubagentWhy = (dir: string): string => `a subagent cannot push in ${at(dir)}: Dave's tap belongs to the main session. Ask the main session to do it.`;
const appManyHeadsWhy = (dir: string, heads: string[]): string =>
  `this create names more than one head (${prose(heads.join(', '))}) in ${at(dir)}; gh opens the PR from the last one, so the head its open-pr decision is for cannot be known. Name one head (gh pr create --head <branch>, or one -f head=<branch>).`;
const appHeadOwnerWhy = (dir: string, owner: string): string =>
  `this create names its head with the owner ${prose(owner)}: (in ${at(dir)}), so the PR would open from that owner's fork, and a tap from Dave covers only a branch of this checkout. Name the head with no owner: prefix (gh pr create --head <branch>), or ask Dave to open it.`;
const appHeadWhy = (dir: string): string => `the head branch of this create cannot be named in ${at(dir)} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo folder on a branch.`;
/** Fix round 5 (F8, advisor review): a create that names two bases cannot be tied to one tap. */
const appManyBasesWhy = (dir: string, bases: string[]): string =>
  `this create names more than one base branch (${prose(bases.join(', '))}) in ${at(dir)}, so the base its open-pr decision is for cannot be known. Name one base (gh pr create --base <branch>, or one -f base=<branch>).`;
const appHeadReadWhy = (dir: string, branch: string): string => `cannot read the head of ${prose(branch)} in ${at(dir)}, so its open-pr decision cannot be found. Run the command again from the repo folder.`;
const appRepoUnreadableWhy = (dir: string): string => `the repo this command names is a variable (-R $R, GH_REPO=$X), so it cannot be compared with the repo of ${at(dir)}. Name the repo as owner/repo text.`;
const appRepoDiffersWhy = (deps: Deps, dir: string, named: string, key: string | null, offer: Offer): string =>
  `this command names ${prose(named)}, but no remote of ${at(dir)} fetches from it (the repo of the folder is ${key === null ? 'not known: several remotes and no push target' : prose(key)}). Run it from the folder of the repo it names, or name the repo of one of its remotes. ${askPart(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
const appRepoUnnamedWhy = (deps: Deps, dir: string, offer: Offer, key: string | null): string =>
  `${at(dir)} has more than one remote, so gh may act on another repo than the tap names. Name the repo: -R ${key === null ? '<owner/repo>' : ghRepoArg(key)} for the branch's push target (@{push}), or the repo of another remote. ${askPart(deps, offer, dir, (c) => `The question for this folder: ${c}.`)}`;
const appPositionWhy = (deps: Deps, dir: string, offer: Offer): string =>
  `popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, and ${at(dir)} is judged for Dave's tap, so the folder this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd. ${askPart(deps, offer, dir, (c) => `The question for that folder: ${c}.`)}`;
/**
 * Fixer G, item 7: an SSH host alias remote of an entry with no github field gives a local: key, and gh cannot take it, so app-ask refuses
 * open-pr and merge. The way out is Dave's: a github field in the registry entry. The line names no switch and no CCv3 tool.
 */
const needsFieldLine = (entryKey: string, remote: string): string =>
  `the registry entry ${prose(entryKey)} needs a github field naming owner/repo (remote ${remoteProse(remote)} is an SSH host alias, so gh has no repo to act on); tell Dave.`;
const inAppFolder = (dir: string): string => ` The command starts in ${at(dir)}, a folder judged for Dave's tap.`;
/**
 * S5, item 6: the visible line names the file only. What it means for coverage goes to the guard-log row (CORRUPT_EFFECT). Seat review 1,
 * item 4: the line is now for a MISSING file named by LANE_REGISTRY_PATH (a corrupt file denies, registryCorruptWhy); the log row says registry-missing.
 */
const corruptLine = (file: string): string => `WARNING (decision-gate): the project registry ${prose(fwd(file))} cannot be read. Tell Dave.`;
const CORRUPT_EFFECT = "folders outside CCv3 were not checked for Dave's tap (nothing is covered while the file is missing)";
/** Seat review 1, item 4: the deny of a push, create or merge outside CCv3 while the registry exists but does not parse. */
const registryCorruptWhy = (file: string, dir: string): string =>
  `the project registry ${prose(fwd(file))} exists but cannot be parsed (read twice), so this folder (${at(dir)}) cannot be checked for Dave's tap, and a push, PR create or merge outside CCv3 stays blocked. Fix the file (valid JSON with a projects list), or ask Dave.`;

// ---------- the store, as text and as a path ----------

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
const STORE_PATH_RE = /ccv3-mods\/decisions\.json(?:\.|$)/;

// For shell TEXT the path is not at the end: arguments, quotes or a ; follow it. Any prefix ($HOME, ~, %USERPROFILE%, a drive) ends the same way.
// A name that goes on (decisions.jsonx, decisions.json-old) is another file. A dot is not a word char here: decisions.json.lock is the lock.
const STORE_TEXT_RE = /ccv3-mods\/+decisions\.json(?![\w-])/;

/** A Windows path spelling that reaches the same file: drop a ::$DATA or :stream suffix, then trailing dots and spaces (not a lone . or ..). */
function dropAliasSuffix(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1;
  const leaf = p.slice(cut).replace(/:.*$/s, '').replace(/([^. ])[. ]+$/, '$1');
  return p.slice(0, cut) + leaf;
}

/**
 * True when a file path is the decision store, its lock or a tmp file of it (the default path, or the CCV3_DECISIONS_FILE path).
 * Known best-effort gap: an 8.3 short name (DECISI~1.JSN) reaches the same file and is not seen.
 */
function isStorePath(p: string, deps: Deps, cwd: string): boolean {
  const full = norm(resolve(cwd, dropAliasSuffix(p))); // always resolve: it collapses a .. in an absolute path too
  const store = norm(decisionsPath(deps.env));
  return STORE_PATH_RE.test(full) || full === store || full.startsWith(`${store}.`);
}

// Only flags that take no value may sit before the store: -Destination, -t and --target-directory name the store as the DESTINATION, so they never match.
// cp, copy or Copy-Item, optional flags, then the store as the FIRST path, then a destination. Quoted paths with spaces do not match: they stay denied.
const escRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The read-copy shape for the default store path and for the CCV3_DECISIONS_FILE path of this run. */
function readCopyRe(deps: Deps): RegExp {
  const store = escRe(norm(decisionsPath(deps.env)));
  return new RegExp(`\\b(?:cp|copy|copy-item)\\s+(?:-(?:[frpavinu]{1,4}|-?(?:force|recurse|recursive|verbose|confirm|whatif))\\s+)*["']?(?:(?:[^\\s"';|&]*\\/)?ccv3-mods\\/+decisions\\.json|${store})["']?(?=\\s+[^\\s;|&])`, 'gi');
}
const STORE_CODE_RE = /[\\/]lib[\\/]decisions\.mjs/i;
const STORE_FN_RE = /\b(?:decisionRecord|offerWrite|decisionUse|missBump)\b/;
const WRITE_SIGNAL_RE = /(?<![\d&])>|\b(?:Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|tee|sed|mv|cp|rm|del|truncate|dd|ln)\b|\b(?:writeFile|appendFile|writeFileSync|rename)/i;
const CODE_SIGNAL_RE = /\bnode(?:\.exe)?\b[^|;&\n]*?(?:\s-e\b|\s--eval\b|\s-p\b|\s--print\b|--input-type)|\bimport\s*\(|\brequire\s*\(/i;

// Code (node -e) that names the store is a write unless it only reads: it calls a read API and holds nothing that can write, copy, open, run a program or load code.
// Anything else stays denied (fail closed). `=>` and `>` still count as a write signal above.
// require() may load only fs or the store file itself: any other module, a variable argument, string building, a template or bracket access on a string can reach a writer, so it stays denied.
const READ_ONLY_CODE_RE = /\b(?:readFileSync|readFile)\s*\(|\brequire\s*\(\s*["'][^"']*decisions\.json["']\s*\)/;
const CODE_CAN_WRITE_RE = new RegExp([
  'write|append|copy|rename|unlink|\\brm|truncate|open|link|mkdir|chmod|chown|utimes|stream|child_process|spawn|exec|eval|\\bFunction\\b|import\\s*\\(|\\bflags?\\b|O_[A-Z]',
  'process\\.binding|decisions\\.mjs|decisionRecord|offerWrite|decisionUse|missBump|fetch|https?:',
  '\\brequire\\s*\\(\\s*(?!["\'](?:(?:node:)?fs|[^"\']*decisions\\.json)["\']\\s*\\))',
  '["\'`]\\s*\\+|\\+\\s*["\'`]|\\$\\{|\\[\\s*["\'`]',
].join('|'), 'i');

// A tap is used up by land-decision.mjs use (land-pr.ps1 calls it after the merge), and a pr-checkpoint.mjs run may post a probe or offer.
// The model must not run the first from a shell, nor loop the second.
const USE_TAP_RE = /land-decision\.mjs["']?\s+["']?use\b/i;
const CHECKPOINT_RUN_RE = /pr-checkpoint\.mjs\b(?=[^\n]*--json)(?=[^\n]*--pr\b)/i;
const LOOP_RE = /\b(?:for|foreach|while|until|xargs|seq)\b|ForEach-Object|\d+\.\.\d+|%\s*\{/i;

/**
 * Shell text that writes the store, runs its code, uses a tap up or loops pr-checkpoint. A read (cat, Get-Content, rg) of the path passes.
 * Best effort, like the whole gate: text built from variables or run through another script is not seen.
 */
function writesStoreText(text: string, deps: Deps): boolean {
  if (USE_TAP_RE.test(text) || (CHECKPOINT_RUN_RE.test(text) && LOOP_RE.test(text))) return true;
  const flat = text.replace(/\\/g, '/');
  // A copy whose first source is the store only reads it. The mention is cut out; a later mention (the destination, a second command) still counts.
  const lower = norm(flat.replace(readCopyRe(deps), ' '));
  const names = [lower, squashQuotes(lower)].some((t) => STORE_TEXT_RE.test(t)) || lower.includes(norm(decisionsPath(deps.env)));
  const code = CODE_SIGNAL_RE.test(text);
  if (names || STORE_CODE_RE.test(text)) {
    if (WRITE_SIGNAL_RE.test(flat)) return true;
    if (!code) return false;
    return !(names && !STORE_CODE_RE.test(text) && READ_ONLY_CODE_RE.test(text) && !CODE_CAN_WRITE_RE.test(text));
  }
  return STORE_FN_RE.test(text) && code;
}

// ---------- the command shapes ----------

/** One push, read from the text. `branch` and `remote` are null when the command names none (resolved later, in the checkout). */
interface PushShape {
  remote: string | null;
  /** The branch the push updates: the refspec destination, else its source; null for HEAD or no refspec (the current branch). */
  branch: string | null;
  /** The source ref whose tree is pushed; null is HEAD. */
  src: string | null;
  /** The -C value, raw: the last one, as base main 7a0e2f34 read it (G4). */
  dir: string | null;
  /** Fix round 5 (F4, ruling B): every -C value, raw, in order. git applies each one relative to the one before (chainDir). */
  cdirs: string[];
  /** The cd targets (raw) that come before this push in the command text, in order. They may set the folder git runs the push in. A cd may not run, so the push is judged in the folder after each prefix (pushDirsOf). */
  cds: string[];
  /** Some cd before this push is joined to it by something other than &&, or follows a || or a pipe (see looseJoin): the push may run in the payload cwd. */
  loose: boolean;
  /** A popd, Pop-Location, `cd -` or a bare cd comes before this push: the folder is unknown (see judgePushAt). */
  unknown: boolean;
  /** A force or delete form (see FORCE_LONG). */
  force: boolean;
  /** --git-dir or --work-tree moves the repo: the checkout cannot be known. */
  moved: boolean;
  /** No refspec at all (`git push`, `git push up`): in a covered folder it updates the branch of @{push} when it goes to that remote. */
  bare: boolean;
  /**
   * Covered folders only (fix round 3, fixer H): the call is on the strict text allow-list (STRICT_*): git or git-safe.ps1 with no lead-in,
   * no global option but -C, only the listed push options, and no positional or exactly <remote> <branch> as plain words. Anything else
   * takes the tap path. The checkout facts (config, tags, remote HEAD) are read later, in pushRisk.
   */
  plain: boolean;
  /** Covered folders only: --repo (any spelling) names the push target, so the remote the gate reads is not it (a hard deny there). */
  repoOpt: boolean;
  /**
   * Covered folders only (fix round 4, fixer K; none of these is in the shape id, so the CCv3 shape count stays). `unsafeOpt`: a long
   * option that is a prefix of an UNSAFE_LONG name (git parse-options takes any unique prefix: --mirr, --del, --al), or a force letter
   * before the o of a short bundle. `oBundle`: a short bundle that holds o (-uo, -vo x): o takes the rest as its value, so the words after
   * it are not read as git reads them. `widerOpt`: a command option or a -c key that makes git write more than the refspec names
   * (--follow-tags, --recurse-submodules=<on>, -c push.*|remote.*|submodule.*). `oneSide`: no refspec, or one with no colon or an empty
   * side, so git maps it through remote.<r>.push or push.default. `noRecurse`, `noFollowTags`: the command turns that config off.
   */
  unsafeOpt: boolean;
  /** --mirror or --all (any unique prefix): every ref or every branch. */
  wideOpt: boolean;
  oBundle: boolean;
  widerOpt: string | null;
  oneSide: boolean;
  noRecurse: boolean;
  noFollowTags: boolean;
}
/**
 * Where a create, a land or a merge runs: the cd targets (raw) before it, and whether a popd, Pop-Location, `cd -` or a bare cd made the folder unknowable.
 * `loose`: some cd before it is joined to the shape by a ; || | & or line end (not only &&), so that cd may fail and leave the shell in the payload cwd.
 */
interface Where { cds: string[]; unknown: boolean; loose: boolean }
interface Shape {
  kind: 'create' | 'land' | 'merge' | 'store' | 'push'; pr: string | null; sha?: string | null; push?: PushShape;
  /** Round 3 C2, a merge only: the head cannot be read as gh reads it (two values, a non-literal, an unknown flag, an unpaired quote). */
  shaBad?: true;
  /** Create, land and merge: where the shape runs. */
  at?: Where;
  /**
   * Create and merge (land too): the text of its own command (cut at the next break outside quotes), raw and with its quoted strings masked.
   * `text` is cut at every & as in base main 7a0e2f34: the CCv3 head read uses it (G4). `ftext` also keeps a -R or --head after the & of a
   * redirect (2>&1, &>): the repo of a create or merge (F1, R5c) and the app head read use it.
   */
  text?: string;
  mtext?: string;
  ftext?: string;
  fmtext?: string;
  /** Fixer G, item 5: the GH_REPO assignments of the segments before this one (priorGhRepo, under the Bash and the PowerShell mask). */
  prior?: Prior;
  /** Round 3 C1, seat ruling A: a create's raw tail (rawTail), read by createRead; it is not cut at a lone & or a CR. */
  tail?: string;
  /** Seat item 3: the payload tool is PowerShell (a backslash is literal there). */
  pwsh?: boolean;
}
interface Prior { repos: string[]; nonLiteral: boolean }
const NO_PRIOR: Prior = { repos: [], nonLiteral: false };
const scopeOf = (s: Shape): Scope => (s.kind === 'push' ? 'push' : 'other');

const LAND_SCRIPT_RE = /\bland-pr\.ps1\b/i;
const LAND_PR_RE = /(?:^|\s)-P(?:r)?(?:\s+|:|=)["']?(\d+)\b/i;
/** Looser than LAND_PR_RE: -P or -Pr, then any run of space, :, =, or quote marks, then a digit. Used only to refuse the text-only exemption. */
const PR_NUMBER_IN_TEXT_RE = /-Pr?[\s:="']*\d/i;
const CLEANUP_RE =/(?:^|\s)-CleanupOnly\b/i;
const MERGE_CLI_RE = /\bgh\s+pr\s+merge\b([^|;&\n]*)/i;
const MERGE_API_RE = /\bgh\s+api\b[^|;&\n]*\/pulls\/(\d+)\/merge\b[^|;&\n]*/i;
const GET_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))GET\b/i;
const SHA_RE = /(?:\bsha=|--match-head-commit(?:\s+|=))["']?([0-9a-f]{40})\b/i;
const SEGMENT_RE = /[;&|\r\n]+/;

const lastArg = (args: string, re: RegExp): string | null => re.exec(args)?.[1] ?? null;

/** The land and merge shapes of ONE command segment (no && ; | or newline in it), with the PR and the sha read from that segment alone. */
function landShapesOf(seg: string, textOnly = false, rawSeg = seg, tail = rawSeg, pwsh = false): Shape[] {
  const out: Shape[] = [];
  // The land script pins its own head: its sha is read as before (round 3 C2 changes only the merge read).
  const sha = SHA_RE.exec(seg)?.[1]?.toLowerCase() ?? null;
  // textOnly: the whole command only prints or reads text (isTextOnlyCommand), so the script name is a mention. A mention that names a PR (-Pr 12) stays a land shape.
  const pr = lastArg(seg, LAND_PR_RE);
  if (LAND_SCRIPT_RE.test(seg) && !CLEANUP_RE.test(seg) && !(textOnly && pr === null)) out.push({ kind: 'land', pr, sha });
  const cli = MERGE_CLI_RE.exec(seg);
  // Round 3 C2: the head is read from the RAW segment, whose quotes are what gh gets. When only the quotes-deleted view shows the merge
  // (quotes inside its words), the head cannot be read whole: fail closed. Seat ruling A: the words are read from the raw TAIL (the text up
  // to the next ; | newline or && outside quotes), not from the segment cut at every & and CR, so a head after 2>&1 is read too.
  // Seat delta q3: the gh word must open its command (only literal NAME=value settings before it), else another program parses the words.
  const opens = (m: RegExpExecArray | null): RegExpExecArray | null => (m !== null && GH_PREFIX_OK.test(tail.slice(0, m.index)) ? m : null);
  const rawCli = MERGE_CLI_RE.exec(rawSeg) ? opens(TAIL_CLI_RE.exec(tail)) : null;
  if (cli) out.push({ kind: 'merge', pr: lastArg(cli[1], /(?:^|\s)(?:["']?)(\d+)(?=\s|["']|$)/) ?? lastArg(cli[1], /\/pull\/(\d+)/), ...(rawCli ? cliMergeHead(rawCli[1], pwsh) : UNREAD_HEAD) });
  const api = MERGE_API_RE.exec(seg);
  const rawApi = MERGE_API_RE.exec(rawSeg) ? opens(TAIL_API_RE.exec(tail)) : null;
  if (api && !GET_RE.test(api[0])) out.push({ kind: 'merge', pr: api[1], ...(rawApi ? apiMergeHead(rawApi[0], pwsh) : UNREAD_HEAD) });
  return out;
}
const TAIL_CLI_RE = /\bgh\s+pr\s+merge\b([\s\S]*)$/i;
/** True when `pos` of `text` is inside a quote: single quotes are literal; the escape is \ in bash, a backtick in PowerShell. */
function quoteOpenAt(text: string, pos: number, pwsh: boolean): boolean {
  const esc = pwsh ? '`' : '\\';
  let q = '';
  for (let i = 0; i < pos && i < text.length; i++) {
    const ch = text[i];
    if (q === "'") { if (ch === "'") q = ''; continue; }
    if (ch === esc) { i++; continue; }
    if (q === '"') { if (ch === '"') q = ''; continue; }
    if (ch === "'" || ch === '"') q = ch;
  }
  return q !== '';
}
/**
 * Seat delta q3: what may stand before the gh word of a merge or create in its own command: nothing, or literal NAME=value settings
 * (GH_REPO=..., GH_PROMPT_DISABLED=1). A wrapper (bash -c, pwsh -Command, cmd /c, a here-string, sudo, time) runs gh through another parser.
 */
const GH_PREFIX_OK = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_\-./:]*\s+)*$/;
const TAIL_API_RE = /\bgh\s+api\b[\s\S]*$/i;

/**
 * Seat ruling A: the raw text of the command that starts `text`, up to the first ; | newline or && OUTSIDE quotes (bash and PowerShell
 * both end a command there). A lone & and a CR are kept in the tail, so the allowlist (unmodelled) refuses them; an open quote runs to
 * the end, so the pairing refuses it.
 */
function rawTail(text: string): string {
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = ''; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === ';' || ch === '|' || ch === '\n' || (ch === '&' && text[i + 1] === '&')) return text.slice(0, i);
  }
  return text;
}

// ---------- round 3 C2: the merge head, read from one known place, once ----------

/**
 * The words of a command text with their quotes paired (bash rules: '...' is literal, "..." takes \ escapes; a \ outside quotes escapes the
 * next character). Null when a quote is not closed: the reader cannot pair it, so the caller fails closed. A redirect word stays a word.
 */
function pairedWords(text: string, pwsh = false): string[] | null {
  const words: string[] = [];
  let cur = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (open) { words.push(cur); cur = ''; open = false; } continue; }
    open = true;
    if (ch === "'") { const end = text.indexOf("'", i + 1); if (end < 0) return null; cur += text.slice(i + 1, end); i = end; continue; }
    if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) { if (!pwsh && text[j] === '\\' && j + 1 < text.length) j++; cur += text[j]; }
      if (j >= text.length) return null;
      i = j;
      continue;
    }
    if (!pwsh && ch === '\\' && i + 1 < text.length) { cur += text[++i]; continue; }
    cur += ch;
  }
  if (open) words.push(cur);
  return words;
}

/**
 * Round 3 C2 and C1, seat ruling A (an allowlist, not a list of bad characters): true unless every character of the text is one whose
 * effect the reader models the same way in bash and PowerShell. A character not on the list makes the head unread.
 *   - outside quotes: ASCII letters, digits, space, tab, - _ . / = : and the two quote characters. An @ inside a word (body=@file) is
 *     literal in both shells; an @ that opens a word is a PowerShell splat, so it is refused.
 *   - inside '...': printable ASCII and a newline (literal in both shells; '' splits the same in both).
 *   - inside "...": the same but $, a backtick and a backslash (bash expands $ and escapes with \, PowerShell with a backtick).
 *   - anywhere: a non-ASCII character (a curly quote is a quote for PowerShell, NBSP and the Unicode spaces are word characters for bash),
 *     a CR, \v and \f. An open quote at the end is refused by pairedWords, the next step of every reader.
 * So a redirect (< >), a lone &, # (a comment), $, a backtick, a backslash, a glob, a brace, a paren and a comma outside quotes are refused.
 */
function unmodelled(text: string, pwsh = false): boolean {
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Seat item 3: a backslash next to a quote is refused in every tool (a native program can read \" as an escaped quote).
    if (ch === '\\' && (QUOTE_CH.has(text[i - 1] ?? '') || QUOTE_CH.has(text[i + 1] ?? ''))) return true;
    if (q === "'") { if (ch === "'") q = ''; else if (!QUOTED_OK.test(ch)) return true; continue; }
    if (q === '"') { if (ch === '"') q = ''; else if (!QUOTED_OK.test(ch) || '$`'.includes(ch) || (ch === '\\' && !pwsh)) return true; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '@' && i > 0 && !/[ \t]/.test(text[i - 1])) continue;
    if (ch === '\\' && pwsh) continue; // seat item 3: literal in PowerShell; the Bash tool refuses it (an escape)
    if (!BARE_OK.test(ch)) return true;
  }
  return false;
}
const QUOTE_CH = new Set(["'", '"']);
const BARE_OK = /^[A-Za-z0-9 \t\-_./=:]$/;
const QUOTED_OK = /^[\x20-\x7E\n]$/;

type MergeHead = { sha: string | null; shaBad?: true };
const UNREAD_HEAD: MergeHead = { sha: null, shaBad: true };
/** The deny text of a merge whose head cannot be read (CCv3 and covered folders: it names no CCv3 tool). */
const HEAD_UNREAD_WHY = (pr: string | null): string => `the merge head cannot be read as gh reads it: two head values, a value that is not a literal 40-hex sha, a flag this gate does not know, an unpaired quote, or a character this gate cannot read the same way in bash and PowerShell. Name the head once: gh pr merge ${pr && /^\d+$/.test(pr) ? pr : '<n>'} --match-head-commit <sha>, or gh api .../merge -f sha=<sha>. ${PLAIN_WAY_OUT}`;
/** Seat 07:4x, item 2: the exact way out of the two biggest measured costs (a redirect after the call, a $ value). */
const PLAIN_WAY_OUT = 'For a redirect: run the call with no redirect. For a $ variable or $(...): put the value in the command as plain text or use a body file.';
const HEX40 = /^[0-9a-f]{40}$/i;
/** One head from the values found: none is no head; any value that is not a literal 40-hex string, or two different values, is bad. */
function oneHead(values: string[]): MergeHead {
  if (values.some((v) => !HEX40.test(v))) return { sha: null, shaBad: true };
  const set = new Set(values.map((v) => v.toLowerCase()));
  if (set.size > 1) return { sha: null, shaBad: true };
  return { sha: [...set][0] ?? null };
}
const MERGE_BOOL = new Set(['--merge', '-m', '--squash', '-s', '--rebase', '-r', '--auto', '--disable-auto', '--admin', '--delete-branch', '-d']);
const MERGE_VALUE = new Set(['--body', '-b', '--body-file', '-F', '--subject', '-t', '--author-email', '-A', '--match-head-commit', '--repo', '-R']);
const SHORT_BOOL = 'msrd';
const SHORT_VALUE = 'bFtAR';

/**
 * A short-flag cluster (gh takes `-dR x` and `-dRx`): every letter but the last is a known short bool; the last is a bool or a known
 * short value flag, whose value is the rest of the word or the next word. Returns how many next words it uses, or null when unknown.
 */
function shortCluster(w: string, next: string | undefined): number | null {
  return clusterOf(w, next, SHORT_BOOL, SHORT_VALUE)?.used ?? null;
}
/** The cluster read with the letter sets of one command: the value flag it ends in (letter, value), and how many next words it uses. */
function clusterOf(w: string, next: string | undefined, bools: string, values: string): { used: number; letter: string | null; value: string | null } | null {
  const letters = w.slice(1);
  for (let k = 0; k < letters.length; k++) {
    const ch = letters[k];
    if (bools.includes(ch)) continue;
    if (!values.includes(ch)) return null;
    if (k < letters.length - 1) return { used: 0, letter: ch, value: letters.slice(k + 1) }; // the rest of the word is the value
    return next === undefined ? null : { used: 1, letter: ch, value: next };
  }
  return { used: 0, letter: null, value: null };
}

/**
 * `gh pr merge <args>`: the head is the value of --match-head-commit (space or =), and nothing else. Any flag outside the known set, a
 * value flag with no value or an unpaired quote is bad: the reader cannot tell what gh will take as the head. Positionals are not read.
 */
function cliMergeHead(args: string, pwsh = false): MergeHead {
  if (unmodelled(args, pwsh)) return UNREAD_HEAD;
  const words = pairedWords(args, pwsh);
  if (words === null) return UNREAD_HEAD;
  const heads: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('-') || w === '-') continue;
    if (/^-[A-Za-z]{2,}/.test(w)) { const used = shortCluster(w, words[i + 1]); if (used === null) return UNREAD_HEAD; i += used; continue; }
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (MERGE_BOOL.has(name) && eq < 0) continue;
    if (!MERGE_VALUE.has(name)) return { sha: null, shaBad: true };
    const value: string | undefined = eq > 0 ? w.slice(eq + 1) : words[++i];
    if (value === undefined) return { sha: null, shaBad: true };
    if (name === '--match-head-commit') heads.push(value);
  }
  return oneHead(heads);
}

const API_FIELD = /^(?:-f|-F|--raw-field|--field)$/;
const API_FIELD_EQ = /^(?:--raw-field|--field)=(.*)$/s;
const API_VALUE = new Set(['-X', '--method', '-H', '--header', '--hostname', '-q', '--jq', '-t', '--template', '--cache', '-p', '--preview']);

/**
 * The words of a gh api call after `api`, one by one: the endpoint (the first plain word), a known option with its value, or a field
 * (-f, -F, --raw-field, --field; space, = or attached -fkey=v). `null` field: an option, read and skipped. A word this reader does not
 * know (an unknown dash word, a second plain word, --input) gives `bad` (seat ruling B: the merge reader denies it, as the create reader does).
 */
type ApiWord = { bad: string } | { field: string | null; used: number };
function apiWord(w: string, next: string | undefined, endpointSeen: boolean): ApiWord {
  if (w === '--input' || w.startsWith('--input=')) return { bad: '--input (the body comes from a file)' };
  if (API_FIELD.test(w)) return next === undefined ? { bad: 'a field flag with no value' } : { field: next, used: 1 };
  if (API_FIELD_EQ.test(w)) return { field: API_FIELD_EQ.exec(w)![1], used: 0 };
  if (/^-[fF][^=]/.test(w)) return { field: w.slice(2), used: 0 };
  if (API_VALUE.has(w)) return next === undefined ? { bad: `${w} with no value` } : { field: null, used: 1 };
  if (/^--(?:method|hostname|header|jq|template|cache|preview)=/.test(w) || /^-X./.test(w) || API_BOOL.has(w)) return { field: null, used: 0 };
  if (!w.startsWith('-') && !endpointSeen) return { field: null, used: -1 };
  return { bad: `a word this gate does not know on the api call (${w})` };
}

/**
 * `gh api .../pulls/<n>/merge <args>`: the head is the value of the `sha` field, and nothing else. The value of another field
 * (commit_message="sha=...") is never read. An unknown word, --input or an unpaired quote is bad.
 */
function apiMergeHead(text: string, pwsh = false): MergeHead {
  const rest = text.replace(/^[\s\S]*?\bapi\b/, '');
  // gh's own placeholders ({owner}, {repo}, {branch}) hold no comma, so bash does not expand them, and they make one word in PowerShell.
  if (unmodelled(rest.replace(/\{(?:owner|repo|branch)\}/g, 'x'), pwsh)) return UNREAD_HEAD;
  const words = pairedWords(rest, pwsh);
  if (words === null) return UNREAD_HEAD;
  const heads: string[] = [];
  let endpoint = false;
  for (let i = 0; i < words.length; i++) {
    const r = apiWord(words[i], words[i + 1], endpoint);
    if ('bad' in r) return UNREAD_HEAD;
    if (r.used === -1) { endpoint = true; continue; }
    i += r.used;
    if (r.field === null) continue;
    const eq = r.field.indexOf('=');
    if (eq > 0 && r.field.slice(0, eq) === 'sha') heads.push(r.field.slice(eq + 1));
  }
  return oneHead(heads);
}

// ---------- the push shape ----------

// A wrapper may sit before git: env (with options and assignments), nice, timeout (with a duration), xargs, setsid, sudo (with options). The push is the same push.
// It is part of the lead-in (group 1), like the shared CALL_START words. Regex only. sh -c '...' stays a known gap.
const WRAPPERS = String.raw`(?:env(?:\s+(?:-[uCS]\s+\S+|-\S+|\w+=\S*))*|nice(?:\s+-\S+(?:\s+\d+)?)*|timeout(?:\s+-\S+(?:\s+[A-Z0-9]+)?)*\s+[\d.]+[smhd]?|xargs(?:\s+-\S+(?:\s+(?:\d+|\{\}))?)*|setsid(?:\s+-\S+)*|sudo(?:\s+-\S+(?:\s+\w+)?)*)\s+`;
const PUSH_GIT = new RegExp(String.raw`(${CALL_START}(?:${WRAPPERS})*)(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+push)(?=\s|$)`, 'g');
const PUSH_WRAPPERS = 'git-(?:safe|for)';
/** A PowerShell parameter may be shortened to its first letters (unique prefix) and ignores case. */
const abbr = (name: string, min: number): string => name.slice(0, min) + [...name.slice(min)].reduceRight((acc, ch) => `(?:${ch}${acc})?`, '');
// git-for.ps1 has its own parameters before the git arguments: `git-for.ps1 -UseGitSafe -Remote fork push fork b`, `-Path <dir> push ...`.
// -Path is the directory git runs in, like git -C.
const GIT_FOR_OPTS = String.raw`-(?:${abbr('Path', 2)}|${abbr('Remote', 1)})(?::|\s+)${VAL}|-(?:${abbr('WhichAccount', 2)}|${abbr('UseGitSafe', 1)})(?=\s)|`;
const PUSH_SAFE = safeCallRe('push', PUSH_WRAPPERS, GIT_FOR_OPTS, 'gi');
/** Where the arguments of a push end in the masked view: a segment break, or the ) or } that closes a group. */
const ARGS_END_RE = /[;&|\r\n)}]/;
const DIR_OPT_RE = new RegExp(String.raw`(?:^|\s)-C\s+(${VAL})`, 'g');
const PATH_OPT_RE = new RegExp(String.raw`(?:^|\s)-${abbr('Path', 2)}(?::|\s+)(${VAL})`, 'gi');
const MOVE_OPT_RE = /(?:^|\s)--(?:git-dir|work-tree)(?:=|\s)/;
const REDIRECT_RE = /(?:^|\s)\d*[<>]+\S*/g;
/** Options that take the next word as their value (or `--opt=value`, handled by the `--` branch). */
const VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
const FORCE_LONG = /^--(?:force(?:-with-lease|-if-includes)?|mirror|all|branches|tags|delete|prune)(?:=.*)?$/;

/**
 * `lead`: the text before the executable (a separator, then/do/else, `& `, an env prefix, a wrapper). `token`: the executable as written.
 * `squashed`: read from the quotes-deleted view (pushCallsIn), whose text is not what the shell runs: it never earns the strict allow.
 */
interface RawPush { opts: string; args: string; cds: string[]; loose: boolean; unknown: boolean; lead: string; token: string; squashed: boolean }

/**
 * The push calls of one view. `masked` and `raw` have the same length. `atStart`: the call must open the text (the squashed view).
 * `before`: the cd targets that come before the text (the squashed view is one segment; the segments before it hold the cds).
 */
type CallKinds = [RegExp, (token: string) => boolean][];
const PUSH_KINDS: CallKinds = [[PUSH_GIT, isGitToken], [PUSH_SAFE, (t) => isSafeToken(t, PUSH_WRAPPERS)]];
function pushCallsOf(masked: string, raw: string, atStart: boolean, before: Where = { cds: [], unknown: false, loose: false }, cutView: string = masked, kinds: CallKinds = PUSH_KINDS): RawPush[] {
  const calls: RawPush[] = [];
  for (const [re, valid] of kinds) {
    for (const m of masked.matchAll(re)) {
      const tokenStart = m.index! + m[1].length;
      if (!valid(raw.slice(tokenStart, tokenStart + m[2].length))) continue;
      if (atStart && masked.slice(0, m.index!).trim() !== '') continue;
      const optsStart = tokenStart + m[2].length;
      const end = m.index! + m[0].length;
      const cut = cutView.slice(end).search(ARGS_END_RE);
      const own = cdsBefore(masked.slice(0, tokenStart), raw.slice(0, tokenStart));
      calls.push({
        opts: raw.slice(optsStart, optsStart + m[3].length), args: raw.slice(end, cut < 0 ? raw.length : end + cut),
        cds: [...before.cds, ...own.cds], loose: before.loose || own.loose, unknown: before.unknown || own.unknown,
        lead: raw.slice(m.index!, tokenStart), token: raw.slice(tokenStart, optsStart), squashed: atStart,
      });
    }
  }
  return calls;
}

// ---------- heredoc and here-string bodies (reviewer-2 round, item 1) ----------
//
// A message body with one unpaired quote (Don't, 27") made maskQuoted pair it with a later quote and mask the push after it. blankBodies
// blanks the body of a bash heredoc or a PowerShell here-string first (same length, line ends kept), only when the body is data: the
// segment starts with git or gh and the opener is outside its quotes, or is the body of a cat that is a whole open $( ) in it
// (opensData); no pipe follows the opener on its line; a closing line ends it (the first line that is the delimiter; a here-string close with blanks before it is refused), and nothing in it
// runs (an unquoted delimiter or @" with $( or a backtick in the body is refused). Anything else stays as it is, and hiddenPieces (item 1a)
// judges it. writesStoreText reads the text before the blank: a heredoc body is how a store write is spelled.

/** A bash heredoc opener (not <<<): <<WORD, <<-WORD, <<'WORD', <<"WORD", <<\WORD. */
const HEREDOC_OPEN = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][\w.-]*))/g;
/** A PowerShell here-string opener: @' or @" at the end of its line. */
const HERESTRING_OPEN = /@(['"])[ \t]*\r?\n/g;
/** The commands whose heredoc or here-string is data, never run: the first word of the segment. cat only inside its $( ). */
const DATA_CMD = /^(?:[^\s;&|()`'"]*[\\/])?(?:git|gh)(?:\.exe)?$/i;
const INNER_CAT = /^cat$/;
const RUNS_IN_BODY = /\$\(|`/;
const blankChars = (s: string): string => s.replace(/[^\r\n]/g, ' ');
const firstWord = (t: string): string => t.trim().split(/\s+/)[0] ?? '';
type QuoteTool = 'Bash' | 'PowerShell';
/** The text with every quoted span of the shell's reading (maskQuoted pairing) blanked, marks included, and escapes blanked. */
function outsideQuotes(t: string, tool: QuoteTool): string {
  let rest = t;
  for (const [s, e] of quotedSpans(t, tool)) rest = rest.slice(0, s) + ' '.repeat(e - s) + rest.slice(e);
  return rest.replace(tool === 'PowerShell' ? /`[\s\S]/g : /\\[\s\S]/g, '  ');
}
/** True when a quote mark of `t` has no pair in the shell's reading (a string still open at its end, or a stray mark). */
const quoteLeft = (t: string, tool: QuoteTool): boolean => /["']/.test(outsideQuotes(t, tool));

/**
 * True when the opener at `at` is data: the segment (cut at a line end, ; & or |) starts with git or gh, and the opener is either
 * outside every quoted span of the text before it (reviewer-2 minor 1: the spans, not a count of marks), or the body of a cat that is
 * the whole of an open $( in it (git commit -m "$(cat <<'EOF'), with no open quote before that $( but its own ".
 * eval "$(cat <<EOF", bash -c, cat <<EOF | bash and a here-string in a variable are refused (their body runs).
 */
function opensData(text: string, at: number, tool: QuoteTool): boolean {
  const lead = text.slice(0, at);
  // F1 (seat delta read): the segment start, its first word and its $( are read on the lead with every quoted span blanked (same
  // length), so a ; & | or line end inside a quoted word ('x; git y') starts no segment.
  const bare = outsideQuotes(lead, tool);
  const segStart = Math.max(...['\n', ';', '&', '|'].map((c) => bare.lastIndexOf(c))) + 1;
  const seg = bare.slice(segStart);
  if (!DATA_CMD.test(firstWord(seg))) return false;
  const sub = seg.lastIndexOf('$(');
  if (sub < 0 || seg.includes(')', sub)) return !quoteLeft(lead, tool);
  const inner = seg.slice(sub + 2);
  return INNER_CAT.test(firstWord(inner)) && !quoteLeft(lead.slice(0, segStart + sub).replace(/"$/, ''), tool) && !quoteLeft(inner, tool);
}
/** The start of the first line at or after `from` that `ends` accepts, or -1. */
function closingLine(text: string, from: number, ends: (line: string) => boolean): number {
  for (let pos = from; pos <= text.length;) {
    const eol = text.indexOf('\n', pos);
    if (ends(text.slice(pos, eol < 0 ? text.length : eol).replace(/\r$/, ''))) return pos;
    if (eol < 0) return -1;
    pos = eol + 1;
  }
  return -1;
}
function blankHeredocs(text: string): string {
  let out = text;
  let next = 0;
  for (const m of text.matchAll(HEREDOC_OPEN)) {
    if (m.index! < next) continue;
    const nl = text.indexOf('\n', m.index! + m[0].length);
    if (nl < 0) break;
    const start = Math.max(nl + 1, next);
    const delim = m[2] ?? m[3] ?? m[5];
    const end = closingLine(text, start, (line) => (m[1] === '-' ? line.replace(/^\t+/, '') : line) === delim);
    if (end < 0) break; // no closing line: the shell reads the rest as the body; leave it to hiddenPieces
    const quoted = m[5] === undefined || m[4] === '\\';
    // Refused: a pipe after the opener on its line (the body goes on to another command); a line that ends with a backslash or holds an
    // open quote after the opener (reviewer-2 major 2: bash starts the body after the LOGICAL line, so the next lines are commands).
    const rest = text.slice(m.index! + m[0].length, nl).replace(/\r$/, '');
    const plainLine = !rest.includes('|') && !rest.endsWith('\\') && !quoteLeft(rest, 'Bash');
    if (plainLine && opensData(out, m.index!, 'Bash') && (quoted || !RUNS_IN_BODY.test(text.slice(start, end)))) out = out.slice(0, start) + blankChars(text.slice(start, end)) + out.slice(end);
    const eol = text.indexOf('\n', end);
    next = eol < 0 ? text.length : eol + 1;
  }
  return out;
}
function blankHereStrings(text: string): string {
  let out = text;
  let next = 0;
  for (const m of text.matchAll(HERESTRING_OPEN)) {
    if (m.index! < next) continue;
    const start = m.index! + m[0].length;
    const end = closingLine(text, start, (line) => line.trimStart().startsWith(`${m[1]}@`));
    if (end < 0) break;
    const closedAtStart = text.startsWith(`${m[1]}@`, end);
    const body = text.slice(start, end);
    if (closedAtStart && opensData(out, m.index!, 'PowerShell') && (m[1] === "'" || !RUNS_IN_BODY.test(body))) out = out.slice(0, start) + blankChars(body) + out.slice(end);
    next = end + 2;
  }
  return out;
}
/** Item 1b: the text with each data body blanked, by the shell of the tool. Desktop Commander may run each body line: no blank there. */
function blankBodies(text: string, tool: string | undefined): string {
  if (tool === 'Bash') return text.includes('<<') ? blankHeredocs(text) : text;
  if (tool === 'PowerShell') return text.includes('@') ? blankHereStrings(text) : text;
  return text;
}
/** The shell command of a call with its data bodies blanked: every reader of this file (each maskQuoted site) gets it through here. */
function readCommand(input: HookInput): ReturnType<typeof readShellCommand> {
  const cmd = readShellCommand(input);
  return cmd.kind === 'command' ? { ...cmd, text: blankBodies(cmd.text, cmd.tool) } : cmd;
}

/**
 * Reviewer-2 major 1: a # at a word start outside quotes opens a comment to the line end (Bash and PowerShell). Each comment is blanked
 * in turn from the left, and the spans are read again after each, so a quote inside a comment pairs with nothing. Only a comment with
 * no quote mark after its line is dropped (the comment at the end of a command).
 */
function dropComments(view: string, tool: QuoteTool): string {
  let out = view;
  for (let from = 0; ;) {
    const spans = quotedSpans(out, tool);
    const re = /(^|[\s;&|(])#[^\n]*/g;
    re.lastIndex = from;
    let hit: { at: number; end: number } | null = null;
    for (let m = re.exec(out); m !== null && hit === null; m = re.exec(out)) {
      const at = m.index + m[1].length;
      const end = m.index + m[0].length;
      // Only when no quote mark follows the comment line: a # line may be data (a heredoc body the blanker left), and its quote then
      // pairs with a later one in the readers' mask; kept, the unpaired test sees it (advisor review of this round).
      if (!spans.some(([s, e]) => at > s && at < e) && !/["']/.test(out.slice(end))) hit = { at, end };
    }
    if (hit === null) return out;
    out = out.slice(0, hit.at) + ' '.repeat(hit.end - hit.at) + out.slice(hit.end);
    from = hit.end;
  }
}
/**
 * Item 1a: when a quote is left with no pair in the tool's reading (comments dropped), the pieces of each quoted span that sit at a
 * command position in it (after ; & | ( or a line end inside the span; reviewer-2 blocker: never the span start, which is a word of the
 * text before). Such a quote can pair with the wrong one and mask a call: these pieces are the calls the mask may have hidden.
 */
function hiddenPieces(raw: string, tool?: string): string[] {
  const tools: QuoteTool[] = tool === 'Bash' || tool === 'PowerShell' ? [tool] : ['Bash', 'PowerShell'];
  return tools.flatMap((t) => {
    const view = dropComments(joinContinuations(raw, t === 'PowerShell' ? 'pwsh' : 'bash'), t);
    if (!quoteLeft(view, t)) return [];
    return quotedSpans(view, t).flatMap(([s, e]) => view.slice(s + 1, e - 1).split(/[;&|\r\n(]+/).slice(1));
  });
}
const RUNNER_WORD = /^(?:[^\s'"]*[\\/])?(?:git(?:\.exe)?|git-(?:safe|for)\.ps1)$/i;
/** A lead word before the program of a piece: a control word, a wrapper (as the header lists), its option or number, or VAR=. */
const LEAD_WORD = /^(?:then|do|else|\{|!|sudo|env|nice|nohup|time|timeout|xargs|setsid|-\S*|\d+[smhd]?|[A-Za-z_]\w*=\S*)$/;
/** The program word of a piece, after its lead words. */
const programOf = (p: string): string => p.trim().split(/\s+/).find((w) => !LEAD_WORD.test(w)) ?? '';
/** A hidden piece that is a git push call: git (or a git wrapper script) as its program, and the word push. */
const hiddenPush = (p: string): boolean => RUNNER_WORD.test(programOf(p)) && holdsGitPush(p);
/** A hidden piece that is a gh create or merge (gh pr create|new|merge, or gh api to a pulls or merge path). */
const hiddenGh = (p: string): boolean => {
  const t = squashMarks(p);
  return /^(?:[^\s]*[\\/])?gh(?:\.exe)?$/i.test(programOf(t)) && (/\bpr\s+(?:create|new|merge)\b/i.test(t) || /\bapi\b[\s\S]*\b(?:pulls|merge)\b/i.test(t));
};
/** Reviewer-2: the wide push words (--all, --tags, --prune, --branches; forceSpelled is the round 6 force list) and a :dst delete refspec. */
const wideSpelled = (s: string): boolean => squashMarks(s).split(/[\s;&|(){}<>]+/).some((w) => /^--(?:all|tags|prune|branches)$/i.test(w) || /^:[^:\s]/.test(w));
/** A hard push spelling in one segment or piece: force, delete, mirror, wide. */
const hardSpelled = (s: string): boolean => forceSpelled(s) || wideSpelled(s);

/** The quote marks of a view become segment breaks, same length. A call inside a quoted string then sits at a command position. */
const quotesToBreaks = (view: string): string => view.replace(/["']/g, ';');
/** The quote marks become spaces, same length. cmd.exe runs a quoted program name (`"git" push`), so that call has to stay one command. */
const quotesToSpaces = (view: string): string => view.replace(/["']/g, ' ');
/**
 * `cd "<path>"` at a command position, written with its double quotes as spaces, same length: the path is one plain word. cmd.exe pairs the double
 * quote and cds to the path. Only a path with no space and no %, $, backtick, ^, ( ), & | ; < > (nothing that expands or splits), ending the segment.
 * A single-quoted target stays a bare cd under the break view: cmd.exe reads 'A' as a folder name, so the shell may not move (unknown, denied).
 * A drive-letter target (D:\A) stays too: cd without /d changes the folder of drive D only, the current drive stays and the push runs where it was.
 * Only a relative path is read as a known folder.
 * Without this the quote-break view reads `cd "A" && git push` as a bare cd and denies a push whose folder the text names.
 */
const PLAIN_QUOTED_CD = /(^|[;&|\r\n(]\s*)((?:cd|chdir)\s+)"(?![A-Za-z]:)([^\s"'%$`^()&|;<>\r\n]+)"(?=\s*(?:$|[;&|\r\n)]))/gi;
const plainCdUnquoted = (view: string): string => {
  // cmd.exe reads ^ as an escape: any ^ keeps every quote as it is (fail closed).
  if (view.includes('^')) return view;
  return view.replace(PLAIN_QUOTED_CD, (match: string, lead: string, cd: string, path: string, offset: number) => {
    // A cd inside a double-quoted span of the text is no command for cmd.exe (an odd number of " before it): it stays a bare cd and is denied.
    const quotesBefore = (view.slice(0, offset).match(/"/g) ?? []).length;
    return quotesBefore % 2 === 0 ? `${lead}${cd} ${path} ` : match;
  });
};

/**
 * The push calls of a command: the bash view, the pwsh view, and each bash segment with its quotes deleted (`g"i"t push`, `git "push"`).
 * `cmdExe`: Desktop Commander may run cmd.exe. cmd.exe treats ' as a plain character and & as a command break, so
 * echo 'x & git push fork b & rem ' runs the push. Then a third reading (only when blanking changed the text) sees a call inside quotes.
 * The arguments of that call end at the first break in the real text (quotes kept). A double-quoted echo of a push is denied too (accepted over-deny).
 */
function pushCallsIn(raw: string, cmdExe = false, kinds: CallKinds = PUSH_KINDS): RawPush[] {
  const bash = joinContinuations(raw, 'bash');
  const pwsh = joinContinuations(raw, 'pwsh');
  const maskedBash = maskQuoted(bash, 'Bash');
  const maskedPwshOnBash = maskQuoted(bash, 'PowerShell');
  const maskedPwsh = maskQuoted(pwsh, 'PowerShell');
  const calls = [...pushCallsOf(maskedBash, bash, false, undefined, maskedBash, kinds), ...pushCallsOf(maskedPwsh, pwsh, false, undefined, maskedPwsh, kinds)];
  if (cmdExe) {
    const cmdBash = plainCdUnquoted(bash);
    const cmdPwsh = plainCdUnquoted(pwsh);
    for (const view of [quotesToBreaks, quotesToSpaces]) {
      if (maskedBash !== bash) calls.push(...pushCallsOf(view(cmdBash), cmdBash, false, undefined, cmdBash, kinds));
      if (maskedPwsh !== pwsh) calls.push(...pushCallsOf(view(cmdPwsh), cmdPwsh, false, undefined, cmdPwsh, kinds));
    }
  }
  let from = 0;
  const breaks = [...maskedBash.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  for (const [start, next] of [...breaks, [bash.length, bash.length] as const]) {
    const seg = bash.slice(from, start);
    // \" escapes in bash, not in PowerShell: each mask can hide a cd the other shows. Read the cds under both and keep each list that differs.
    const lists = [cdsBefore(maskedBash.slice(0, from), bash.slice(0, from)), cdsBefore(maskedPwshOnBash.slice(0, from), bash.slice(0, from))];
    from = next;
    const squashed = squashQuotes(seg);
    if (squashed === seg) continue;
    for (const before of distinctWheres(lists)) calls.push(...pushCallsOf(squashed, squashed, true, before, squashed, kinds));
  }
  return calls;
}

const REF_HEADS = /^refs\/heads\//;
/** --repo and --repo=<x> (and the abbreviation --rep) name the target of the push: the remote the gate reads is not it. */
const REPO_OPT = /^--repo?(?:=|$)/;

// Fix round 3 (fixer H): the strict positive allow-list of a covered push with no tap. Each rule is a positive match on the RAW text;
// no hand reading of what a shell would expand. Anything off the list takes the tap path (the critic's arms race ends here).
/** The only push options of a no-tap push (exact words, raw: a quoted or combined option is off the list). */
const STRICT_OPTS: ReadonlySet<string> = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--porcelain', '--progress', '--no-progress']);
const STRICT_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STRICT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** A branch word that git reads as something else: a range, an empty path part, a lock file, a ref namespace, HEAD. */
const NOT_A_BRANCH = /\.\.|\/\/|\/$|\.lock$|^(?:refs|heads|tags|remotes)\/|^HEAD$/;
// Fix round 4 (fixer K, critic minor 7): the CONFIG_TEXT test (GIT_CONFIG_*, HOME= in the text) is gone. No row needed it: a lead-in
// fails strictCall and an earlier assignment segment fails steadyCommand, so each such push already takes the tap path.
/** A plain branch word of the allow-list (also the destination a bare push reads from @{push}). */
const strictBranch = (b: string): boolean => STRICT_BRANCH.test(b) && !NOT_A_BRANCH.test(b);

/**
 * The executable, matched positively: git or git.exe with a plain path, or git-safe.ps1 with a plain path, run directly or as
 * `pwsh|powershell [-NoProfile] -File <path>` (no other pwsh flag: -WorkingDirectory moves the push). No $, %, quote or backtick.
 */
const STRICT_TOKEN = /^(?:(?:[A-Za-z0-9._:/\\-]*[\\/])?git(?:\.exe)?|(?:(?:pwsh|powershell)(?:\.exe)?\s+(?:-NoProfile\s+)?-File\s+)?(?:[A-Za-z0-9._:/\\-]*[\\/])?git-safe\.ps1)$/i;
/**
 * The call itself: no lead-in but a separator, then/do/else or `& `; a STRICT_TOKEN executable; no global option but ONE -C (fix round
 * 5, F4: git applies each -C in order, so two of them are off the list).
 */
function strictCall(call: RawPush): boolean {
  const lead = call.lead.replace(/\b(?:then|do|else)\b/g, '').replace(/[\s;&|(){}]/g, '');
  const opts = call.opts.replace(DIR_OPT_RE, ' ').trim();
  return !call.squashed && lead === '' && opts === '' && [...call.opts.matchAll(DIR_OPT_RE)].length <= 1 && STRICT_TOKEN.test(call.token);
}
/** The positionals: none (a bare push), or exactly <remote> <branch>, each a plain word (raw: no quote, no @, no colon, no +). */
const strictPositionals = (raw: string[]): boolean => raw.length === 0 || (raw.length === 2 && STRICT_REMOTE.test(raw[0]) && strictBranch(raw[1]));

/** The words after `push`, raw (redirects dropped), and the same words with their quotes deleted. */
function argWordsOf(call: RawPush): { raws: string[]; tokens: string[] } {
  const raws = call.args.replace(REDIRECT_RE, ' ').split(/\s+/).filter((r) => squashQuotes(r) !== '');
  return { raws, tokens: raws.map(squashQuotes) };
}
/** Every -C (or git-for -Path) value of a call, in order. */
function callDirsOf(call: RawPush): string[] {
  const dirs = [...call.opts.matchAll(DIR_OPT_RE), ...call.opts.matchAll(PATH_OPT_RE)].sort((a, b) => a.index! - b.index!);
  // A -C value with a backslash stays raw: resolveDir unquotes it by the rules of the shell. squashQuotes deleted the backslashes of
  // C:\repo, so a PowerShell or quoted Bash path read as C:repo, a folder that does not exist (report of #0f5ea433; the BACKSLASH
  // difference of G4). Any other -C value is squashed as in base main 7a0e2f34 (fixer G: no other CCv3 difference).
  return dirs.map((m) => (m[1].includes('\\') ? m[1] : squashQuotes(m[1])));
}
/** The -C folder of a call as base main 7a0e2f34 read it: the last one wins (G4). Fix round 5 (F4) judges the chain too (chainDir). */
const callDirOf = (call: RawPush): string | null => callDirsOf(call).pop() ?? null;

/** Fix round 4 (fixer K, critic major 3): the long options that rewrite, remove or add many remote refs. Any prefix of one counts. */
/** The options that push every ref (--mirror) or every branch (--all). */
const WIDE_LONG = ['mirror', 'all'];
const UNSAFE_LONG = ['mirror', 'all', 'branches', 'tags', 'delete', 'prune', 'force', 'force-with-lease', 'force-if-includes'];
/** A -c key that changes what a push writes (push.*, remote.*, submodule.*): the repo config the gate reads is then not what git uses. */
const PUSH_KEY_RE = /^(?:push|remote|submodule)\./;
const C_OPT_RE = /(?:^|\s)-c\s+((?:[^\s"']|"[^"]*"|'[^']*')+)/g;
type AppFlags = Pick<PushShape, 'unsafeOpt' | 'wideOpt' | 'oBundle' | 'widerOpt' | 'noRecurse' | 'noFollowTags'>;

/** One long option, for the app flags: an unsafe prefix, recursion and tag following on or off. */
function readLongFlag(f: AppFlags, t: string): void {
  const eq = t.indexOf('=');
  const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
  const value = eq < 0 ? null : t.slice(eq + 1).toLowerCase();
  if (UNSAFE_LONG.some((n) => n.startsWith(name))) f.unsafeOpt = true;
  // --mirror and --all (any unique prefix) push every ref or every branch: a hard deny in CCv3 (card prflow-push-blocks, seat 16:5x).
  if (name.length >= 2 && (WIDE_LONG.some((n) => n.startsWith(name)))) f.wideOpt = true;
  if (name === 'no-recurse-submodules') f.noRecurse = true;
  else if (name.length >= 4 && 'recurse-submodules'.startsWith(name)) {
    if (value === 'no' || value === 'check') f.noRecurse = true;
    else f.widerOpt ??= t;
  }
  if (name === 'no-follow-tags') f.noFollowTags = true;
  else if (name.length >= 3 && 'follow-tags'.startsWith(name)) f.widerOpt ??= t;
}

/**
 * The app-only flags of a push call (fix round 4, fixer K). The CCv3 reading (force, quiet, the positionals) is not changed: in a short
 * bundle git reads o as the push option and the rest of the word as its value, so only the letters before the o count here.
 */
function appFlagsOf(tokens: string[], opts: string): AppFlags {
  const f: AppFlags = { unsafeOpt: false, wideOpt: false, oBundle: false, widerOpt: null, noRecurse: false, noFollowTags: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') break;
    if (!t.startsWith('-') || t === '-') continue;
    if (VALUE_OPTS.has(t)) { i++; continue; }
    if (t.startsWith('--')) readLongFlag(f, t);
    else if (/^-[A-Za-z0-9]+$/.test(t)) {
      const body = t.slice(1);
      const o = body.indexOf('o');
      if (o >= 0) f.oBundle = true;
      if (/[fd]/.test(o < 0 ? body : body.slice(0, o))) f.unsafeOpt = true;
    }
  }
  for (const m of opts.matchAll(C_OPT_RE)) {
    const key = squashQuotes(m[1]).split('=')[0].toLowerCase();
    if (PUSH_KEY_RE.test(key)) { f.widerOpt ??= `-c ${key}`; break; }
  }
  return f;
}

/** The shapes of one push call: one per refspec, or one with no refspec. A dry run or a help request has none. */
function pushShapesFrom(call: RawPush): Shape[] {
  const { raws, tokens } = argWordsOf(call);
  const cdirs = callDirsOf(call);
  const dir = cdirs[cdirs.length - 1] ?? null;
  const positional: string[] = [];
  const rawPositional: string[] = [];
  let force = false;
  let quiet = false; // --dry-run, -n, --help, -h
  let literal = false;
  let repoOpt = false;
  let plainOpts = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (literal || !t.startsWith('-') || t === '-') { positional.push(t); rawPositional.push(raws[i]); continue; }
    if (!STRICT_OPTS.has(raws[i])) plainOpts = false;
    if (t === '--') { literal = true; continue; }
    if (REPO_OPT.test(t)) repoOpt = true;
    if (VALUE_OPTS.has(t)) { i++; continue; }
    if (t.startsWith('--')) {
      if (FORCE_LONG.test(t)) force = true;
      if (t === '--dry-run' || t === '--help') quiet = true;
    } else if (/^-[A-Za-z0-9]+$/.test(t)) {
      if (/[fd]/.test(t)) force = true;
      if (/[nh]/.test(t)) quiet = true;
    }
  }
  if (quiet) return [];
  const [remote = null, ...specs] = positional;
  const plain = plainOpts && strictCall(call) && strictPositionals(rawPositional);
  const base = { remote, dir, cdirs, cds: call.cds, loose: call.loose, unknown: call.unknown, moved: MOVE_OPT_RE.test(` ${call.opts}`), plain, repoOpt, ...appFlagsOf(tokens, call.opts) };
  if (specs.length === 0) return [{ kind: 'push', pr: null, push: { ...base, branch: null, src: null, force, bare: true, oneSide: true } }];
  const out: Shape[] = [];
  for (let i = 0; i < specs.length; i++) {
    let spec = specs[i];
    let rewrite = force;
    if (spec === 'tag') { rewrite = true; i++; spec = specs[i] ?? 'tag'; } // `tag <name>` pushes refs/tags/<name>
    if (spec.startsWith('+')) { rewrite = true; spec = spec.slice(1); }
    const colon = spec.indexOf(':');
    const rawSrc = colon < 0 ? spec : spec.slice(0, colon);
    const rawDst = colon < 0 ? '' : spec.slice(colon + 1);
    if (colon >= 0 && rawSrc === '') rewrite = true; // `:dst` deletes dst
    if (/^refs\/tags\//.test(rawDst || rawSrc)) rewrite = true;
    const src = rawSrc.replace(REF_HEADS, '');
    const name = (rawDst || rawSrc).replace(REF_HEADS, '');
    // oneSide (app only): git maps a refspec with no colon or an empty side through remote.<r>.push (and push.default for a bare push).
    const oneSide = colon < 0 || rawSrc === '' || rawDst === '';
    out.push({ kind: 'push', pr: null, push: { ...base, branch: name === '' || name === 'HEAD' ? null : name, src: src === '' || src === 'HEAD' ? null : src, force: rewrite, bare: false, oneSide } });
  }
  return out;
}

/** Every push shape of a command, de-duplicated across the views. Exported for the shape count of the backslash tests (fixer E, item 7). */
export function pushShapesOf(raw: string, tool?: string): Shape[] {
  const out: Shape[] = [];
  const seen = new Map<string, PushShape>();
  // Fix round 3 (fixer H): text that sets git config anywhere in the command, or any segment that is not a cd, read-only git, a plain
  // commit or a push (a checkout, a tag, a git config, an add), keeps every push of it off the strict allow-list.
  // Fix round 5 (ruling A): a push stays on the list only when the WHOLE text is the strict reading (rawVerdict 'ok').
  const verdict = rawVerdict(raw, tool);
  const offList = verdict === null ? !steadyCommand(raw, tool === 'PowerShell' ? 'pwsh' : 'bash') : verdict.kind !== 'ok';
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const shape of pushShapesFrom(call)) {
      const p = shape.push!;
      if (offList) p.plain = false;
      // The dir is compared with its quotes and backslashes deleted: the quotes-deleted reading of the same call (pushCallsIn) has lost the
      // backslashes of C:\repo, so its copy is dropped and the raw reading, which comes first, is judged.
      // `bare` is in the id: `git push up` and `git push up HEAD` update different branches in a covered folder (push.default=upstream).
      // Fix round 5 (F4): two or more -C values join the id, so `-C /a -C .` and `-C /b -C .` stay two shapes (one -C: the id of before).
      const chain = p.cdirs.length > 1 ? p.cdirs.map(squashQuotes).join('\0') : '';
      const id = [p.remote, p.branch, p.src, p.dir === null ? null : squashQuotes(p.dir), p.force, p.moved, p.loose, p.unknown, p.bare, p.cds.join('\0')].join('|') + (chain === '' ? '' : `|-C:${chain}`);
      const kept = seen.get(id);
      // `plain` and `repoOpt` are not in the id (the CCv3 shape count stays). A dropped copy passes them on, fail closed: a real reading
      // that is off the list takes the kept shape off it (AND); the squashed reading is not the text the shell runs, so it does not count
      // there (a quoted -C keeps a push on the list). Any reading that sees --repo marks it (OR).
      if (kept) {
        if (!call.squashed) kept.plain &&= p.plain;
        kept.repoOpt ||= p.repoOpt;
        // Fix round 4 (fixer K): a flag that denies is OR-merged and a flag that clears a deny is AND-merged, so the dropped copy of
        // `git push up topic && git push --mirr up topic` still denies.
        kept.unsafeOpt ||= p.unsafeOpt;
        kept.wideOpt ||= p.wideOpt;
        kept.oBundle ||= p.oBundle;
        kept.widerOpt ??= p.widerOpt;
        kept.oneSide ||= p.oneSide;
        kept.noRecurse &&= p.noRecurse;
        kept.noFollowTags &&= p.noFollowTags;
      } else { seen.set(id, p); out.push(shape); }
    }
  }
  return out;
}

// ---------- the verb rule (fix round 6, Dave 11-13 "Stop accidents, list the rest"; app folders only) ----------
//
// A push is judged by the VERB of each git call outside quotes (a git word anywhere outside quotes counts: fail closed), never by the
// word push anywhere in the text. Verb push: the strict reader. Another plain verb (add, commit, log, stash ...): no push, so a message,
// a grep pattern or an echo text that holds push is text. A verb that is not a plain word, or a shell -c, eval, cmd /c, pwsh -Command or
// $( ) payload with git and push: the tap path, read no further. A force spelling counts only in a segment with a push call or such a payload.

/** The raw text with the marks a shell strips from a word deleted: g"i"t, g\it, p''ush and `git push` read as git and push. */
const squashMarks = (t: string): string => t.replace(/["'\\^`]/g, '');
/** A word ends at a blank, a separator, a bracket, = (alias.x=push) or a redirect. */
const WORD_SPLIT = /[\s;&|(){}<>=,]+/;
const isPushWord = (w: string): boolean => /^push$/i.test(w) || /(?:^|[\\/])git-push(?:\.exe)?$/i.test(w);
/**
 * A git executable word outside quotes (git, git.exe, git-safe.ps1, git-for.ps1; group 1: git-push, whose verb is push), or a quoted
 * word whose raw text is one of them ("git", "C:\...\git.exe": checked by isRunner, as PUSH_GIT does).
 */
const GIT_WORD = /(?<![^\s;&|(){}`!])(?:(?:[^\s;&|(){}`'"]*[\\/])?(?:git(?:\.exe)?|git-(?:safe|for)\.ps1|(git-push(?:\.exe)?))|"[^"]*"|'[^']*')(?=\s|$)/gi;
const isRunner = (rs: string, g: RegExpMatchArray): boolean => {
  const raw = rs.slice(g.index!, g.index! + g[0].length);
  return !/^["']/.test(g[0]) || isGitToken(raw) || isSafeToken(raw, PUSH_WRAPPERS);
};
/** A global option (git, and git-for.ps1 -Path and -Remote) whose value is the next word. */
const VALUE_GLOBAL = /^(?:-C|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|-Pa(?:th?)?|-R(?:e(?:m(?:o(?:te?)?)?)?)?)$/i;
/** A verb that is no plain word: it holds a $, backtick, bracket, %, quote, backslash or glob. */
const ODD_VERB = /[$`{}()%"'\\*?[\]]/;
const WORDS = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;
/** A shell payload (sh -c, bash -lc, eval, cmd /c, pwsh -Command, Invoke-Expression) or a $( ) or backtick substitution that starts with git. */
const PAYLOAD = /\b(?:(?:ba|z|da|k)?sh(?:\.exe)?\s+(?:-\w+\s+)*-\w*c\b|eval\b|cmd(?:\.exe)?\s+(?:\/\w+\s+)*\/[ck]\b|(?:pwsh|powershell)(?:\.exe)?\s.*?-c(?:ommand)?\b|Invoke-Expression\b|iex\b)|(?:\$\(|`)\s*(?:[^\s;&|()`'"]*[\\/])?git(?:\.exe)?\s/i;
const holdsGitPush = (s: string): boolean => { const w = squashMarks(s).split(WORD_SPLIT); return w.some((x) => /(?:^|[\\/])git(?:\.exe)?$/i.test(x)) && w.some(isPushWord); };

/** Seat ruling c (11-13): the value of an inline -c alias.<n>=<value> holds the word push (git push or !git push). */
const aliasPushes = (w: string): boolean => { const t = squashMarks(w); return t.slice(t.indexOf('=') + 1).split(WORD_SPLIT).some(isPushWord); };
/**
 * The verb of one git word of a segment (`ms` masked, `rs` raw): push, odd (the tap path), odd-push (an inline alias whose value
 * holds push: the tap path, and a push segment for the force test), another plain verb, or none.
 */
function verbAt(ms: string, rs: string, g: RegExpMatchArray): 'push' | 'odd' | 'odd-push' | 'other' | null {
  if (g[1]) return 'push';
  const from = g.index! + g[0].length;
  const cut = ms.slice(from).search(ARGS_END_RE);
  const words = [...ms.slice(from, cut < 0 ? ms.length : from + cut).matchAll(WORDS)].map((w) => rs.slice(from + w.index!, from + w.index! + w[0].length));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('-')) return ODD_VERB.test(w) ? 'odd' : /^push$/i.test(w) ? 'push' : 'other';
    // -c alias.<x>=... defines a verb in the command itself: the tap path.
    if (w === '-c' && /^alias\./i.test(squashMarks(words[i + 1] ?? ''))) return aliasPushes(words[i + 1]) ? 'odd-push' : 'odd';
    if (w === '-c' || VALUE_GLOBAL.test(w)) i++;
  }
  return null;
}
/** The verb reading of a command: its push calls, whether any call or payload takes the tap path, and the segments a force word counts in. */
function verbsOf(raw: string, shell: 'bash' | 'pwsh'): { pushes: number; odd: boolean; segs: string[] } {
  const { view, masked } = viewOf(raw, shell);
  const read = { pushes: 0, odd: false, segs: [] as string[] };
  let from = 0;
  for (const m of [...masked.matchAll(/[;&|\r\n]+/g), null]) {
    const to = m === null ? masked.length : m.index!;
    const ms = masked.slice(from, to);
    const rs = view.slice(from, to);
    from = m === null ? to : to + m[0].length;
    const verbs = [...ms.matchAll(GIT_WORD)].filter((g) => isRunner(rs, g)).map((g) => verbAt(ms, rs, g));
    const pushes = verbs.filter((v) => v === 'push').length;
    const payload = PAYLOAD.test(rs) && holdsGitPush(rs);
    const aliasPush = verbs.includes('odd-push');
    read.pushes += pushes;
    read.odd ||= payload || aliasPush || verbs.includes('odd');
    if (pushes > 0 || payload || aliasPush) read.segs.push(rs);
  }
  return read;
}
/** The long options ruling A names as force spellings; any prefix of one counts (git takes a unique prefix). */
const FORCE_LONG_NAMES = ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete'];
/**
 * A short bundle of git push letters that holds f or d (-f, -fu, -df). A word with another letter (-NoProfile, -rf) is no push bundle.
 * Two linear tests (F7: one regex with a star on each side of [fd] is quadratic on a long -fff...x word).
 */
const isForceBundle = (w: string): boolean => /^-[vqnfduoh46]+$/.test(w) && /[fd]/.test(w);
/** True when a force spelling is anywhere in the raw text: --force*, --mirror, --delete (and their prefixes), -f or -d in a short bundle, + before a refspec. */
function forceSpelled(raw: string): boolean {
  return squashMarks(raw).split(WORD_SPLIT).some((w) => {
    if (/^\+[^+\s]/.test(w) || isForceBundle(w)) return true;
    const long = /^--([A-Za-z][A-Za-z-]*)$/.exec(w);
    return long !== null && FORCE_LONG_NAMES.some((n) => n.startsWith(long[1].toLowerCase()));
  });
}
/** The words the strict reader accounts for in a push call: the listed options, and a dry run or help request (quiet: no shape). */
const STRICT_QUIET: ReadonlySet<string> = new Set(['-n', '--dry-run', '-h', '--help']);
/** One push call the strict reader accounts for, word by word: strictCall, every option listed, no or exactly <remote> <branch>. */
function strictAccounted(call: RawPush): boolean {
  if (!strictCall(call)) return false;
  const { raws } = argWordsOf(call);
  const positional = raws.filter((r) => !r.startsWith('-'));
  return raws.every((r) => !r.startsWith('-') || STRICT_OPTS.has(r) || STRICT_QUIET.has(r)) && strictPositionals(positional);
}
const viewOf = (raw: string, shell: 'bash' | 'pwsh'): { view: string; masked: string } => {
  const view = joinContinuations(raw, shell);
  return { view, masked: maskQuoted(view, shell === 'pwsh' ? 'PowerShell' : 'Bash') };
};
/**
 * True when the WHOLE text is the strict reading: every segment is a cd, read-only git, a plain commit or a push (steadyCommand), and
 * each push segment is one call the strict reader accounts for. A commit message is text here. cmd.exe reads ' as a letter and ^ as
 * an escape, so a text that may run under cmd.exe and holds either is off the list.
 */
function strictWhole(raw: string, tool: string | undefined, shell: 'bash' | 'pwsh'): boolean {
  if (!steadyCommand(raw, shell) || (mayRunUnderCmd(tool) && /['^]/.test(raw))) return false;
  const { view, masked } = viewOf(raw, shell);
  const calls = pushCallsOf(masked, view, false);
  const pushSegs = segmentsOf(fdBlank(raw), shell)?.seq.filter((k) => k === 'push').length ?? -1;
  return calls.length === pushSegs && calls.every(strictAccounted);
}
/** The push calls that make a shape: the most of the tool's own view and of the quotes-deleted segments (`git "push"`). */
function shapedCalls(raw: string, tool: string | undefined, shell: 'bash' | 'pwsh'): number {
  const { view, masked } = viewOf(raw, shell);
  const shaped = (calls: RawPush[]): number => calls.filter((c) => pushShapesFrom(c).length > 0).length;
  return Math.max(shaped(pushCallsOf(masked, view, false)), shaped(pushCallsIn(raw, mayRunUnderCmd(tool)).filter((c) => c.squashed)));
}
/**
 * The verb verdict of a command (no git): null when no git call has the verb push and nothing takes the tap path. `ok`: the whole
 * text is the strict reading (the shapes decide, and a strict dry run passes). Else `tap` (every shape takes the tap path) or `unsafe`
 * (a force spelling in a push segment: push-unsafe). `unread` (the tap path): an odd verb or a payload, or more push calls than calls
 * that make a shape (behind an unknown option or global option, a wrapper the shapes do not read, a quiet word the strict reader did not account for).
 */
type RawVerdict = { kind: 'ok' | 'tap' | 'unsafe'; unread: boolean } | null;
function rawVerdict(raw: string, tool?: string): RawVerdict {
  const shell = tool === 'PowerShell' ? 'pwsh' : 'bash';
  const read = verbsOf(raw, shell);
  // Item 1a: a git push in a span an unpaired quote may have masked is a push no shape reads; a force or wide word anywhere makes it hard.
  const hidden = hiddenPieces(raw, tool).filter(hiddenPush);
  if (read.pushes === 0 && !read.odd && hidden.length === 0) return null;
  if (hidden.length === 0 && strictWhole(raw, tool, shell)) return { kind: 'ok', unread: false };
  // Reviewer-2 major 3 and blocker: a hard spelling counts in a push segment or payload, and in a hidden push piece, never elsewhere.
  const unsafe = read.segs.some(hardSpelled) || hidden.some(hardSpelled);
  return { kind: unsafe ? 'unsafe' : 'tap', unread: read.odd || hidden.length > 0 || read.pushes > shapedCalls(raw, tool, shell) };
}

/** Each folder of a -C chain: git applies each -C relative to the one before (F4, ruling B). A posix base keeps posix rules (tests on Windows). */
function chainStep(base: string, value: string, shell: 'bash' | 'pwsh'): string {
  const raw = value.includes('\\') ? unquotePath(value, shell) : value;
  if (hasUnexpandedPart(value)) return UNEXPANDED + raw;
  const t = shell === 'bash' ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  if (isUnexpanded(base)) return base;
  return base.startsWith('/') ? posix.resolve(base, t) : resolve(base, t);
}
const chainDir = (base: string, values: string[], shell: 'bash' | 'pwsh'): string => values.reduce((dir, v) => chainStep(dir, v, shell), base);
/** F4: the folders a push with two or more -C runs in (each cd prefix moved by the whole chain), or none for one -C (the base reading). */
function chainDirsOf(p: PushShape, cwd: string, shell: 'bash' | 'pwsh'): string[] {
  if (p.cdirs.length < 2) return [];
  return [...new Set(dirsAfter(cwd, p.cds, shell, p.loose).map((b) => chainDir(b, p.cdirs, shell)))].filter((d) => !isUnexpanded(d));
}

/**
 * Ruling B (F3): the repo folder a literal GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, --git-dir or --work-tree value names: <root>/.git and
 * <root>/.git/worktrees/<n> name <root>; another value names itself. A value with a variable is left out (the cwd rule decides); a home
 * value is expanded (knownDirs).
 */
const MOVE_VALUE_RE = /(?:\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)[ \t]*=[ \t]*|--(?:git-dir|work-tree)(?:=|\s+))(\S+)/gi;
function moveTargets(raw: string, cwd: string, shell: 'bash' | 'pwsh', home: string): string[] {
  const out: string[] = [];
  for (const m of raw.replace(/["']/g, '').matchAll(MOVE_VALUE_RE)) {
    for (const dir of knownDirs([chainStep(cwd, m[1].replace(/[;&|)]+$/, ''), shell)], home)) out.push(dir.replace(/[\\/]\.git(?:[\\/]worktrees[\\/][^\\/]+)?[\\/]*$/i, ''));
  }
  return [...new Set(out)];
}
/**
 * Fix round 6 (item 2): the folders of a list for a coverage test. An unexpanded folder that starts with ~, $HOME, ${HOME},
 * $env:USERPROFILE or %USERPROFILE% (and holds nothing else to expand) gets the home folder; any other unexpanded folder is left out.
 */
const HOME_LEAD = /^(?:~|\$HOME\b|\$\{HOME\}|\$env:USERPROFILE\b|%USERPROFILE%)(?=$|[\\/])/i;
function knownDirs(dirs: string[], home: string): string[] {
  return dirs.flatMap((d) => {
    if (!isUnexpanded(d)) return [d];
    const raw = d.slice(UNEXPANDED.length);
    const lead = HOME_LEAD.exec(raw);
    const rest = lead === null ? '' : raw.slice(lead[0].length);
    if (lead === null || hasUnexpandedPart(rest.replace(/^[\\/]+/, ''))) return [];
    return [home.startsWith('/') ? posix.join(home, rest) : join(home, rest)];
  });
}
/** The first folder of the list that is covered and no CCv3 checkout, each judged alone (coveredAmong stops at a CCv3 folder). */
const firstCovered = (deps: Deps, dirs: string[]): string | null => dirs.find((d) => coveredAmong(deps, [d]) !== null) ?? null;

/**
 * The folders a raw push may run in (fail closed: more folders, never fewer): the cwd, the cd path and -C chain of every call the views
 * find, and every cd or -C value of the raw text with its marks deleted (inside sh -c '...' too), from the cwd and chained from the
 * folder before; plus the move targets (ruling B).
 */
const RAW_CD = /^(?:cd|chdir|pushd|set-location|sl|push-location)$/i;
function rawDirs(raw: string, tool: string | undefined, cwd: string, shell: 'bash' | 'pwsh', home: string): string[] {
  const out = [cwd];
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const base of dirsAfter(cwd, call.cds, shell, true)) out.push(base, chainDir(base, callDirsOf(call), shell));
  }
  // Round 3 C3 (F-1): the cut words of the old reading, AND the quote-paired words of the text and of each payload word in it, so a
  // quoted folder that holds a space ("/x/My App") is read whole. A union only: more folders, never fewer.
  const lists = [raw.replace(/["'`^]/g, '').split(/[\s;&|(){}<>]+/), ...(payloadWords(raw, shell) ?? [])];
  for (const words of lists) {
    let chained = cwd;
    for (let i = 0; i + 1 < words.length; i++) {
      if (!RAW_CD.test(words[i]) && words[i] !== '-C' && !/^-path$/i.test(words[i])) continue;
      out.push(chainStep(cwd, words[i + 1], shell));
      chained = chainStep(chained, words[i + 1], shell);
      out.push(chained);
    }
  }
  return [...new Set([...knownDirs(out, home), ...moveTargets(raw, cwd, shell, home)])];
}
/**
 * Round 3 C3 (F-1, F-2): the quote-paired words (pairedWords) of the text, and of each word in it that holds a blank (a payload such as
 * sh -c '...'), read by both shells' rules; one level, no new reader. Null when a quote cannot be paired at either level: the folder of
 * a payload push cannot be read, so the caller denies.
 */
function payloadWords(raw: string, shell: 'bash' | 'pwsh'): string[][] | null {
  const top = pairedWords(raw, shell === 'pwsh');
  if (top === null) return null;
  const lists = [top];
  for (const w of top.filter((t) => /\s/.test(t))) {
    const inner = [pairedWords(w, false), pairedWords(w, true)];
    if (inner.some((l) => l === null)) return null;
    lists.push(...(inner as string[][]));
  }
  return lists;
}
const RAW_PUSH_WHY = 'this push sits inside the text of another program (sh -c, bash -c, pwsh -c) or in a quote this gate cannot pair, so its folder, remote and branch cannot be read. Run git push as its own command: git push <remote> <branch>.';

/**
 * The deny of the raw rule: in the first covered folder of rawDirs (none in a CCv3 checkout or an uncovered folder, so their output stays
 * as before), push-unsafe for a force spelling, else push-target-unresolved for a push word no shape reads. A git throw is caught in
 * coveredAmong: a folder the path test puts under a live root counts as covered (fail closed, scope app-push).
 */
function rawPushDenies(raw: string, tool: string | undefined, deps: Deps, cwd: string, shell: 'bash' | 'pwsh', subagent: boolean): Deny[] {
  const v = rawVerdict(raw, tool);
  if (v === null || v.kind === 'ok' || (v.kind === 'tap' && !v.unread)) return [];
  const dirs = rawDirs(raw, tool, cwd, shell, deps.home);
  const dir = firstCovered(deps, dirs);
  if (dir === null) {
    // Round 3 C3 (seat Q1, F-2): a push no shape reads is a HARD deny when a folder of it is a CCv3 checkout, or when a quote of its
    // payload cannot be paired (its folder cannot be read, so it cannot be shown uncovered: every folder, seat ACCEPTED cost).
    if (!v.unread) return [];
    // Seat fix 2: a folder whose remotes git cannot list counts as CCv3 unless it is a resolved folder under no registry root.
    const hit = payloadWords(raw, shell) === null || dirs.some((d) => !isUnexpanded(d) && ccv3OrUnplaced(deps, d));
    return hit ? [hardOf(deny('push-target-unresolved', RAW_PUSH_WHY, 'push'))] : [];
  }
  // Fix round 6: an unread push takes the tap path; only a force spelling in a push segment is hard. Reviewer-2 item 3: a subagent's too.
  if (v.kind === 'unsafe') return [deny('push-unsafe', appRawUnsafeWhy(dir), 'app-push')];
  const unread = deny('push-target-unresolved', appUnreadWhy(dir), 'app-push');
  return [subagent ? unread : { ...unread, tapPath: true }];
}
/**
 * Item 1a: a gh create or merge in a span an unpaired quote may have masked (a cd before it or a -R in it is not read). In the first
 * covered folder of the raw folders it is denied position-unknown (scope other, the home flags); a CCv3 or uncovered folder gets nothing.
 */
function hiddenGhDenies(raw: string, tool: string | undefined, deps: Deps, cwd: string, shell: 'bash' | 'pwsh'): Deny[] {
  if (!hiddenPieces(raw, tool).some(hiddenGh)) return [];
  const dir = firstCovered(deps, rawDirs(raw, tool, cwd, shell, deps.home));
  return dir === null ? [] : [{ ...deny('position-unknown', unpairedWhy(dir)), homeFlags: true }];
}

/**
 * Round 3 C1-12 (Dave 2026-11-15 09:14, "Fix in round 3 now"; seat milestone 550): a gh flag before the subcommand (gh -R <repo> pr
 * create, gh --repo <repo> pr merge) hides the call from the create and merge readers, which need `gh pr` or `gh api` as adjacent
 * words. Fail closed on the raw text: when a gh word is followed by a dash word and the text also names a create or a merge, the head
 * is unread. Read on the quotes-deleted text, so a quoted spelling counts too (more denies, never fewer). Measured: 0 of 764 gh commands
 * in 7 days. A CCv3 folder gets the CCv3 deny, a covered folder the app one (homeFlags); an uncovered folder nothing, as for every create.
 */
// Seat fix 3: gh may be named by its path (/usr/bin/gh, C:\tools\gh.exe, "C:\Program Files\GitHub CLI\gh.exe"), with a quote after it.
const GH_FLAG_FIRST = /(?:^|[\s;&|(){}"'])(?:[^\s;&|(){}"']*[\\/])?gh(?:\.exe)?["']?\s+-/i;
const GH_MERGE_TEXT = /\bpr\s+merge\b|\bapi\b[^\n]*\/merge\b/i;
const GH_CREATE_TEXT = /\bpr\s+(?:create|new)\b|\bapi\b[^\n]*\/pulls\b/i;
const GH_FLAG_FIRST_WHY = 'a gh flag stands before the subcommand (gh -R <repo> pr ...), so this gate cannot read the call. Put the flag after the subcommand: gh pr create -R <repo> --head <branch> --base <base> ..., or gh pr merge <n> -R <repo> --match-head-commit <sha> ...';
function ghFlagFirstDenies(raw: string, tool: string | undefined, deps: Deps, cwd: string, shell: 'bash' | 'pwsh'): Deny[] {
  // The raw text too: squashMarks deletes the backslash of a Windows path (seat fix 3).
  const text = squashMarks(raw);
  if (!GH_FLAG_FIRST.test(text) && !GH_FLAG_FIRST.test(raw)) return [];
  const pattern = GH_MERGE_TEXT.test(text) ? 'merge-no-head' : GH_CREATE_TEXT.test(text) ? 'head-unresolved' : null;
  if (pattern === null) return [];
  const dirs = rawDirs(raw, tool, cwd, shell, deps.home).filter((d) => !isUnexpanded(d));
  const app = firstCovered(deps, dirs);
  if (app !== null) return [{ ...deny(pattern, `${GH_FLAG_FIRST_WHY}${inAppFolder(app)}`), homeFlags: true }];
  // Seat fix 2: a folder whose remotes git cannot list counts as CCv3 unless it is a resolved folder under no registry root.
  if (dirs.some((d) => ccv3OrUnplaced(deps, d))) return [deny(pattern, GH_FLAG_FIRST_WHY)];
  // CLI :1681 (seat word 2026-11-15): outside CCv3 a registry that does not parse denies the call, as for every create and merge.
  for (const d of dirs) {
    const place = appPlace(deps, d);
    if (place.corrupt) return [registryCorruptDeny(place.corrupt, d, 'other')];
  }
  return [];
}


/** The segments of a view, split on && ; | and line ends in the RAW text, each with its start offset. A quoted break splits too: detection reads more, never less. */
function cmdSegments(view: string): { seg: string; from: number }[] {
  const out: { seg: string; from: number }[] = [];
  let from = 0;
  for (const m of view.matchAll(new RegExp(SEGMENT_RE.source, 'g'))) {
    out.push({ seg: view.slice(from, m.index!), from });
    from = m.index! + m[0].length;
  }
  out.push({ seg: view.slice(from), from });
  return out;
}

const whereId = (at: Where): string => `${at.unknown ? '?' : ''}${at.loose ? '~' : ''}${at.cds.join('\0')}`;

interface Own { text: string; mtext: string; ftext: string; fmtext: string }
/**
 * The own command of the segment at `from`: it ends at the next break OUTSIDE quotes, so a quoted ; in --title or --body does not cut off a
 * flag after it. `text` ends at any & (base main 7a0e2f34: the CCv3 head read, G4). `ftext`: the & of a redirect (2>&1, &>file) is no
 * break, so a -R or --head after it still goes to gh (the repo read, and the app head read).
 */
function ownCommand(view: string, masked: string, from: number): Own {
  const end = (cut: number): number => (cut < 0 ? view.length : from + cut);
  const to = end(masked.slice(from).search(SEGMENT_RE));
  const fto = end(masked.slice(from).replace(/>&|&>/g, '  ').search(SEGMENT_RE));
  return { text: view.slice(from, to), mtext: masked.slice(from, to), ftext: view.slice(from, fto), fmtext: masked.slice(from, fto) };
}
/** The earlier GH_REPO of a segment, read under each mask of the view and united (fixer G, item 5). */
function priorOf(view: string, masks: string[], from: number): Prior {
  const all = masks.map((m) => priorGhRepo(view.slice(0, from), m.slice(0, from)));
  return { repos: [...new Set(all.flatMap((a) => a.repos))].sort(), nonLiteral: all.some((a) => a.nonLiteral) };
}
/** The id part of an earlier GH_REPO: empty when there is none, so every id of a command with none is the id of before. */
const priorId = (p: Prior): string => (p.repos.length === 0 && !p.nonLiteral ? '' : `|GH_REPO=${p.repos.join(',')}${p.nonLiteral ? '$' : ''}`);
/** The id part of the redirect-aware cut: empty when it equals the base cut. */
const fullId = (own: Own): string => (own.ftext === own.text ? '' : `|${own.ftext}`);
/** A merge keeps its own command in the id (F1): two merges of one PR and head with different -R values are two shapes. */
const landId = (shape: Shape, at: Where, own: Own, prior: Prior): string =>
  `${shape.kind}|${shape.pr}|${shape.sha}${shape.shaBad ? '!' : ''}|${whereId(at)}${shape.kind === 'merge' ? `|${own.ftext}${priorId(prior)}` : ''}`;
/** The folders a segment may run in, one `Where` per distinct reading of the cds before it. */
const distinctWheres = (wheres: Where[]): Where[] => wheres.filter((w, i) => wheres.findIndex((o) => whereId(o) === whereId(w)) === i);

/**
 * The shapes of one command text (continued lines joined, both shells read). EVERY create, land and merge shape is returned, one per segment:
 * the text is split on && ; | and newlines, and each segment is read alone, so a tap for the first PR does not cover the second.
 * Each shape also carries where it runs: the cds before its segment, read under the Bash mask AND the PowerShell mask (a \" escapes in one
 * and not in the other, so each mask can hide a cd the other shows). The readings (bash, pwsh, quotes deleted) are united and de-duplicated,
 * and the cds are part of the id: the same shape in two folders is two shapes. An extra shape only makes the gate stricter.
 */
function shapesOf(raw: string, tool?: string): Shape[] {
  // The words of a create, land or merge inside the quoted text of a harmless command (lane add --title "gh pr create", echo, commit -m) are text. Push is read from raw below.
  const text = normalizeGh(blankInertQuotes(raw, tool));
  const views = [...new Set([joinContinuations(text, 'bash'), joinContinuations(text, 'pwsh')])];
  // A read or print command that only names the land script is text. Only for the tools whose quote rules we read (Bash, PowerShell):
  // Desktop Commander may run cmd.exe. All three readings of the raw text must be text-only (a continuation can differ between shells).
  // A PR number anywhere in the raw text (class B) keeps the land shape. It is read from the RAW text, with no space needed before -Pr:
  // an inert head blanks a quoted "-Pr 12", and LAND_PR_RE (which needs a space before -Pr) misses `"-Pr 12"`.
  const textOnly = (tool === 'Bash' || tool === 'PowerShell')
    && !PR_NUMBER_IN_TEXT_RE.test(raw)
    && [raw, joinContinuations(raw, 'bash'), joinContinuations(raw, 'pwsh')].every(isTextOnlyCommand);
  const out: Shape[] = [];
  // Seat item 3: the tool decides one fact of the merge and create readers (a backslash is literal in PowerShell).
  const pwshTool = tool === 'PowerShell';
  const seen = new Set<string>();
  const add = (shape: Shape, id: string): void => { if (!seen.has(id)) { seen.add(id); out.push(shape); } };
  let created = false;
  for (const view of views) {
    const reads = (['Bash', 'PowerShell'] as const).map((tool) => { const masked = maskQuoted(view, tool); return { masked, pos: cdPositions(masked, view) }; });
    for (const { seg, from } of cmdSegments(view)) {
      const wheres = distinctWheres(reads.map((r) => whereAt(r.pos, from)));
      const owns = reads.map(({ masked }) => ownCommand(view, masked, from));
      const prior = priorOf(view, reads.map((r) => r.masked), from);
      // Seat delta q3: a segment that starts inside a quote of the whole text (a here-string line, a quoted -c payload) is text that
      // another program may run: its tail is empty, so every head read from it is unread.
      const tail = quoteOpenAt(view, from, pwshTool) ? '' : rawTail(view.slice(from));
      for (const s of new Set([seg, squashQuotes(seg)])) {
        for (const shape of landShapesOf(s, textOnly, seg, tail, pwshTool)) {
          for (const own of owns) for (const at of wheres) add({ ...shape, at, ...own, prior }, landId(shape, at, own, prior));
        }
      }
      if (!isPrOpenText(seg)) continue;
      created = true;
      for (const own of owns) for (const at of wheres) add({ kind: 'create', pr: null, at, ...own, prior, tail, pwsh: pwshTool }, `create|${whereId(at)}|${own.text}${fullId(own)}${priorId(prior)}|${tail}`);
    }
  }
  // A create that no single segment shows (`gh pr` + newline + `create`): judge the whole text in the cwd and in every folder of the cds.
  if (!created && isPrOpenCommand(text)) {
    const view = views[0];
    const masked = maskQuoted(view, 'Bash');
    for (const at of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
      add({ kind: 'create', pr: null, at, text: view, mtext: masked, ftext: view, fmtext: masked, tail: view, pwsh: pwshTool }, `create|${whereId(at)}|${view}`);
    }
  }
  out.push(...pushShapesOf(raw, tool));
  return out;
}

// ---------- config ----------

/** decisions.enforce of the review-router.config.json found from `cwd` upward, else under <home>/continuous-claude. Only a literal true enforces. */
const enforcing = (deps: Deps, cwd: string): boolean => routerFlag(cwd, deps.readFile, deps.home, 'decisions', 'enforce');
/** decisions.enforcePush: the push gate's own flag, so a push can warn while create, land and merge enforce. Absent is warn. */
const enforcingPush = (deps: Deps, cwd: string): boolean => routerFlag(cwd, deps.readFile, deps.home, 'decisions', 'enforcePush');
/**
 * The app-push scope DENIES unless decisions.enforceAppPush is the literal false (D2 a, G1). routerFlag reads only a literal true, so the
 * config text is parsed here. Fix round 5 (ruling C, F5): the flag is read ONLY from <home>/continuous-claude/review-router.config.json,
 * never from the payload cwd upward, so a config file inside an app repo cannot turn its denies into warnings. No file, bad JSON or any
 * other value: deny. A literal false softens the tap path only (Dave 11-13): decide() asks hardAppDeny first.
 * Fix round 6 (item 1): a deny for a covered folder (`homeOnly`) reads decisions.enforce from the same home copy only.
 */
function homeFlag(deps: Deps, key: string): unknown {
  try {
    const cfg = JSON.parse(deps.readFile(join(deps.home, 'continuous-claude', 'review-router.config.json')) ?? 'null') as { decisions?: Record<string, unknown> } | null;
    return cfg?.decisions?.[key];
  } catch {
    return null;
  }
}
function enforcingScope(scope: Scope, deps: Deps, cwd: string, homeOnly = false): boolean {
  if (scope === 'app-push') return homeFlag(deps, 'enforceAppPush') !== false;
  if (homeOnly && scope === 'other') return homeFlag(deps, 'enforce') === true;
  return scope === 'push' ? enforcingPush(deps, cwd) : enforcing(deps, cwd);
}
const FLAG_OF: Record<Scope, string> = { push: 'decisions.enforcePush', other: 'decisions.enforce', 'app-push': 'decisions.enforceAppPush' };

// ---------- the checkout ----------

// The same reading as pre-pr-gate (PR #411: CMD_POS, CD_NAMES, CD_TARGET, UNKNOWN_CD), kept as its own copy. A cd that is not seen runs the shape in a folder
// that is never judged. A SURE command position is the start or a separator, then any run of openers (a brace, `(`, a backtick, `!`, then, else, do, if,
// while, until, elif, time). `{`, then, else and do count only there: in `echo then cd B` or `Start-Job { cd B }` the word is no command position, so the
// cd is no sure cd. They still count as LOOSE positions (the `soft` group): the cd is read, but the cwd is judged too (cdPositions). `(`, a backtick,
// `)` (a case pattern) are loose anywhere. After the opener: variable prefixes (X=1), a PowerShell `$x =`, builtin, command or eval words, a module name
// (Microsoft.PowerShell.Management\) and one backslash (\cd). The scriptblock of `Invoke-Command` and `icm` runs in the current session: a sure position.
// The gap after the name is spaces or tabs only: `cd` + newline is a bare cd (UNKNOWN_CD_SOURCE), and the next line is not its target.
const OPENER = String.raw`(?:\{\s*|[(\`!]\s*|(?:then|else|do|if|while|until|elif)\s+|time\s+(?:(?:-p|--)\s+)*)`;
const CMD_POS = String.raw`(?:(?<hard>(?:^|[;&|\r\n]\s*|#>\s*|\b(?:Invoke-Command|icm)\s+(?:-ScriptBlock\s+)?(?=\{))${OPENER}*)|(?<soft>(?:[)(\`]\s*|\{\s*|\b(?:then|else|do)\s+)${OPENER}*))`
  + String.raw`(?:(?:[A-Za-z_]\w*\+?=[^\s;&|]*|(?:\d*[<>]{1,2}&?|&>>?)[^\s;&|]+)[ \t]+)*(?:\$\w+[ \t]*=[ \t]*)?(?:(?:builtin|command|eval)\s+(?:(?:-p|--)\s+)*)*(?:[\w.]+\\)?\\?`;
// A bash cd name may be spelled with a backslash or an empty quote pair between (and around) its letters: `c\d`, `c''d`, `c""d`, `''cd`. Bash still runs cd, so the cd is read
// and its folder judged. A quoted name with letters inside (`"cd" A`) stays a residual: the mask blanks it. PowerShell names stay literal.
const NOISE = String.raw`(?:\\|''|"")*`;
const spell = (word: string): string => NOISE + [...word].join(NOISE) + NOISE;
const CD_NAMES = `${spell('cd')}|Set-Location|sl|${spell('chdir')}|${spell('pushd')}|Push-Location`;
// A bash option (cd -P A, cd -- A) or a PowerShell parameter (-Path A, -Path:A) may come before the target. The target is one word of plain
// characters, quoted parts and escapes (`P/"x"`, `P/x\ y`); it ends before a closing `)` or backtick of a subshell. A backtick pair is one part of the target
// (a command substitution: `cd `pwd`/x`), so the cd is read and its folder fails closed. A backslash escapes a character that is no separator, so a PowerShell
// folder that ends in `\` (`Set-Location X\&& y`) does not swallow the next `;`, `&` or `|`. The same reading as pre-pr-gate CD_TARGET (PR #421).
const CD_SOURCE = CMD_POS + String.raw`(?:${CD_NAMES})[ \t]+(?:(?:-[PLe@]+|--)[ \t]+)*(?:-(?:LiteralPath|Path|PSPath)(?:[ \t]+|:))?(?<t>(?:"[^"]*"|'[^']*'|\`[^\`]*\`|\\[^;&|\r\n]|[^\s;&|)\`"'\\])+)`;
// A job, a parallel block or a remote block runs its cd in another runspace, process or machine: the parent shell does not move. True when the text before a cd
// has an open `{` that follows such a word: Start-Job, Start-ThreadJob, pwsh, -Parallel and -AsJob (also -Pa, -Para ... and -As, -AsJo ...), or an Invoke-Command /
// icm with anything between the word and the block but -ScriptBlock (`icm -cn srv {`, `Invoke-Command srv {`, `Invoke-Command @p {`: the target comes before the block).
// It runs on the text with its closed `{ ... }` groups removed (withoutClosed), so `if (1) {}` or `@{}` inside the block does not end it.
const JOB_BLOCK = /(?:\bStart-(?:Job|ThreadJob)\b|\bsajb\b|\b(?:pwsh|powershell)(?:\.exe)?\b|-(?:Pa(?:r(?:a(?:l(?:l(?:e(?:l)?)?)?)?)?)?|As(?:J(?:o(?:b)?)?)?)\b|\b(?:Invoke-Command|icm)\b(?!\s+(?:-ScriptBlock\s+)?\{))[^{};&|\r\n]*\{[^}]*$/i;

/** The text with every closed group the pattern finds removed, innermost first (`a { b { c } d } e` becomes `a  e`). A group left over is an open one. Regex only, no scan of characters. */
function withoutClosed(text: string, group: RegExp): string {
  let t = text;
  for (;;) {
    const next = t.replace(group, '');
    if (next === t) return t;
    t = next;
  }
}
const CLOSED_BRACES = /\{[^{}]*\}/g;
const CLOSED_PARENS = /\([^()]*\)|`[^`]*`/g;
/** True when the text before a cd leaves a `(`, `$(`, `<(` or backtick open: the cd is inside a subshell or a substitution, so it may not last (`(true && cd B) && push`). */
// A comment line (`# (x`) opens no subshell: the text from a `#` at the start or after a blank to the line end is dropped first. A blank after a backslash is escaped, so its `#`
// is no comment. A `#` inside a word (`a#(x`, `$#`) is no comment either. The cost of a wrong guess is an over-deny, never a fail-open.
const COMMENT = /(?:^|(?<!\\)\s)#[^\r\n]*/g;
const insideSubshell = (before: string): boolean => /[(`]/.test(withoutClosed(before.replace(COMMENT, ''), CLOSED_PARENS));
const gitBashPath = (p: string): string => (process.platform === 'win32' ? p.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : p);

/**
 * True when a cd target holds text the shell expands and this hook does not: `$var`, `$(..)`, `${..}`, `%VAR%`, a backtick, a leading `~`, a glob (`*`, `?`, `[`)
 * or a leading `(` or `@` (a PowerShell expression). Read as a path it names a folder that does not exist, or, with a `..` after it (`$D/..`), the cwd. The same
 * reading as pre-pr-gate hasUnexpandedPart, kept as this gate's own copy.
 */
function hasUnexpandedPart(target: string): boolean {
  const t = target.replace(/^["']|["']$/g, '');
  return /[$`*?[]/.test(t) || /%[^%\s]+%/.test(t) || t.startsWith('~') || /^[(@]/.test(t);
}
/** A folder this hook cannot name. It starts every such path, so a later relative cd keeps it (`cd $D && cd ..`), and only an absolute cd names a folder again. */
const UNEXPANDED = '<cannot-expand>';
const isUnexpanded = (dir: string): boolean => dir.startsWith(UNEXPANDED);
const unexpandedWhy = (dir: string): string => `a cd target or -C value (${dir.slice(UNEXPANDED.length, UNEXPANDED.length + 120)}) holds a variable, a command substitution, a ~ or a glob, so the checkout this command runs in cannot be known. Use a literal path in the cd (cd <full path> && ...).`;
const absoluteText = (t: string): boolean => isAbsolute(t) || /^[A-Za-z]:/.test(t);

/** `base` moved by one cd target (raw, quotes still on): absolute as given, else under `base`. An unexpanded target, or a relative one after it, gives an unexpanded folder. */
/**
 * A cd target or a -C value as the shell passes it. Every quote mark goes (P/"x" is P/x); a backslash before a space or a quote is an
 * escape (bash), so the mark itself stays. PowerShell has no backslash escape: a quoted part is taken whole, and a quote inside the other
 * kind is a letter of the name. Other backslashes stay (C:\repo).
 */
function unquotePath(target: string, shell: 'bash' | 'pwsh'): string {
  return shell === 'pwsh'
    ? target.replace(/"([^"]*)"|'([^']*)'/g, (_m, d: string | undefined, s: string | undefined) => d ?? s ?? '').trimEnd()
    : target.replace(/\\([ "'])|["']/g, (_m, esc: string | undefined) => esc ?? '');
}

function moveTo(base: string, target: string, shell: 'bash' | 'pwsh'): string {
  const raw = unquotePath(target, shell);
  if (hasUnexpandedPart(target)) return UNEXPANDED + raw;
  const t = shell === 'bash' ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  return isUnexpanded(base) ? base : resolve(base, t);
}

/**
 * Where the text that ENDS at a push runs: the cds in it, whether the folder is unknown, whether the cwd must be judged too. A cd is found
 * in the masked view, so a quoted `; cd x` is not one; the target is read from the raw text at the same offsets (both views have the same
 * length). Callers pass the text up to the start of a push: only what runs before it. The same reading as a create or a merge (whereAt).
 */
const cdsBefore = (masked: string, raw: string): Where => whereAt(cdPositions(masked, raw), masked.length);

/**
 * True when the text between a cd and the shape it runs before (masked, so a quoted break is blank) is NOT joined only by `&&`: a `;`, `||`, `|`, `&`
 * or line end lets the shape run after that cd failed (`cd B extra`, a missing folder), and the shell then stays where it was. Same rule as
 * pre-pr-gate cdSteps. It reads separator characters only; it finds no command.
 */
function looseJoin(between: string): boolean {
  // The & of a file-descriptor redirect (2>&1, >&2, &>file) is no joiner: blank it first (as pre-pr-gate cdSteps).
  const joiners = between.replace(FD_REDIRECT, ' ').match(/&&|\|\||[;&|\r\n]/g) ?? [];
  return !(joiners.length > 0 && joiners.every((j) => j === '&&'));
}

/** 2>&1, >&2, <&3, 2>&-, &>file and &>>file: the & belongs to a redirect. */
const FD_REDIRECT = /\d*[<>]&\d*-?|&>>?/g;

/** True when the text ends in a pipe (|, || or |&), looking past blanks and comment lines. Text that only looks like a comment makes the cd loose: fail closed. */
function endsInPipe(before: string): boolean {
  let t = before.trimEnd();
  for (;;) {
    const c = t.replace(/(?:^|\s)#[^\r\n]*$/, '').trimEnd();
    if (c === t) break;
    t = c;
  }
  return t.endsWith('|') || t.endsWith('|&');
}

// popd, Pop-Location, `cd -`, a bare cd (also with only options: cd -P, cd --) go to a folder the text does not name. Found in the masked view, at a command position.
const UNKNOWN_CD_SOURCE = CMD_POS + String.raw`(?:(?:${spell('popd')}|Pop-Location)(?=\s|[;&|\r\n]|$)|(?:${CD_NAMES})(?:[ \t]+(?:-[PLe@]+|--|[-+]))*[ \t]*(?=[;&|\r\n]|$))`;
/** A cd target that is no folder: `cd -`, or an option with nothing after it (`cd -P`, `cd --`). The shell goes to a place the text does not name. */
const NO_FOLDER = /^(?:[-+]|-[PLe@]+|--)$/i;

// Invoke-Command names its target AFTER the block: `{ cd B } -ComputerName srv` (or -cn, -Comp, -CU, -VMGuid) runs the cd elsewhere. Aliases and prefixes cannot be
// listed safely, so ANY parameter after the closing brace in the same statement counts. A local-only parameter, or a later unrelated block, over-denies (fail closed).
const REMOTE_AFTER_BLOCK = /^[^;\r\n]*?\}[^;&|\r\n{]*?\s(?:-[A-Za-z]|@\w)/;

/** Every cd of a masked view with the offset where it ends, and where each popd-like command ends. Read once per view: a segment takes the ones before it. */
interface CdPositions { cds: { end: number; target: string; piped: boolean }[]; unknown: number[]; masked: string }
function cdPositions(masked: string, raw: string): CdPositions {
  const cds: CdPositions['cds'] = [];
  const unknown = [...masked.matchAll(new RegExp(UNKNOWN_CD_SOURCE, 'gi'))].map((m) => m.index! + m[0].length);
  for (const m of masked.matchAll(new RegExp(CD_SOURCE, 'gi'))) {
    const end = m.index! + m[0].length;
    const target = raw.slice(end - m.groups!.t.length, end);
    if (NO_FOLDER.test(target)) { unknown.push(end); continue; }
    // The match opens on the separator before the cd. A | there (|| or a pipe), a pipe before a comment line (endsInPipe), a `(` (a subshell)
    // or a backtick means the cd may be skipped or may not last: it is loose. So is a cd at a soft position (CMD_POS) and a cd inside a job block.
    // insideSubshell: a separator inside an open `(`, `$(` or backtick (`(true && cd B) && push`) does not make the match start with the `(`. JOB_BLOCK runs on the text
    // with its closed `{ }` groups removed, so a closed brace in the job (`if (1) {}`, `@{}`) does not hide the block.
    const before = masked.slice(0, m.index!);
    const piped = m.groups!.soft !== undefined || /^\||[(`]/.test(m.groups!.hard ?? '') || endsInPipe(before) || insideSubshell(before)
      || JOB_BLOCK.test(withoutClosed(before, CLOSED_BRACES)) || REMOTE_AFTER_BLOCK.test(masked.slice(end));
    cds.push({ end, target, piped });
  }
  return { cds, unknown, masked };
}

/** Where a segment that starts at `from` runs: only a cd that ends before the segment counts, never one in or after it. */
function whereAt(pos: CdPositions, from: number): Where {
  const before = pos.cds.filter((c) => c.end <= from);
  return {
    cds: before.map((c) => c.target),
    unknown: pos.unknown.some((end) => end <= from),
    loose: before.some((c) => c.piped || looseJoin(pos.masked.slice(c.end, from))),
  };
}

/** The folder a push runs in: the payload cwd moved by each cd before the push, in order (the last absolute one wins). */
function pushDir(cwd: string, cds: string[], shell: 'bash' | 'pwsh'): string {
  return cds.reduce((dir, target) => moveTo(dir, target, shell), cwd);
}

/** True when a remote of the checkout is the CCv3 fork. Throws when git cannot list the remotes (the caller denies a gated shape). */
function isCcv3Checkout(deps: Deps, dir: string): boolean {
  const r = deps.git(dir, ['remote', '-v']);
  if (r.status !== 0) throw new Error(`git remote -v failed in ${dir} (exit ${r.status})`);
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1] ?? '';
    const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
    return m !== null && m[1].toLowerCase() === CCV3_REPO;
  });
}

// ---------- app folders (tap-scope.ts) ----------

/**
 * A folder outside CCv3: covered or not, the entry key, and the registry file when it could not be used. `github`: the github field of the
 * entry (F5): the key repo of a remote URL with no github.com slug whose owner/repo equals it. Seat review 1, item 4: `corrupt` is a file
 * that exists but does not parse (read twice): a push, create or merge here is DENIED (registryCorruptDeny). `notice` is a MISSING file
 * named by LANE_REGISTRY_PATH: an allow with the one notice line.
 */
interface Place { covered: boolean; entryKey: string; github: string | null; corrupt: string | null; notice?: string }
const NOT_COVERED: Place = { covered: false, entryKey: '', github: null, corrupt: null };
const TOP_ARGS = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'];
const COMMON_ARGS = ['rev-parse', '--path-format=absolute', '--git-common-dir'];

/** The coverage of each folder, once per call (item 5): keyed by the per-call Deps that decide() builds. */
const PLACES = new WeakMap<Deps, Map<string, Place>>();

/**
 * Coverage of a folder the caller has found is NOT a CCv3 checkout. No tapScope, or a missing registry: not covered, and no git runs.
 * F8: no git runs either unless a live entry root holds the folder by the path test (underLiveRoot: files only). From there on a git
 * throw is AppScopeError (scope app-push), and so is a root that cannot be read.
 */
function appPlace(deps: Deps, dir: string): Place {
  if (!deps.tapScope) return NOT_COVERED;
  let memo = PLACES.get(deps);
  if (!memo) PLACES.set(deps, (memo = new Map()));
  const known = memo.get(dir);
  if (known) return known;
  const scope = deps.tapScope;
  const place = inApp(deps, () => readPlace(deps, scope, dir));
  memo.set(dir, place);
  return place;
}
type TapScopeDeps = NonNullable<Deps['tapScope']>;
function readPlace(deps: Deps, scope: TapScopeDeps, dir: string): Place {
  const reg = scope.registry();
  if (reg.state === 'corrupt') return { ...NOT_COVERED, corrupt: reg.file };
  if (reg.state === 'missing') return reg.envPath ? { ...NOT_COVERED, notice: reg.file } : NOT_COVERED;
  if (!underLiveRoot(dir, reg, scope)) return NOT_COVERED;
  try {
    const { top, main } = repoRoots(deps, dir);
    const cov = coverageOf({ toplevel: top, worktreeMainRoot: main, isCcv3: false }, reg, { realpath: scope.realpath });
    return cov.covered ? { covered: true, entryKey: cov.entryKey ?? '', github: cov.github ?? null, corrupt: null } : NOT_COVERED;
  } catch (err) {
    throw err instanceof AppScopeError ? err : new AppScopeError(err);
  }
}

/** The main root named by a common dir: its parent when it is <root>/.git (a relative answer is resolved against the folder), else null. */
function rootOfCommon(dir: string, common: string): string | null {
  const commonDir = common === '' || absoluteText(common) ? common : resolve(dir, common);
  return /[\\/]\.git$/.test(commonDir) ? commonDir.replace(/[\\/]\.git$/, '') : null;
}

/**
 * The toplevel and the main root of the repo of `dir`. F7: inside <root>/.git, --show-toplevel fails while --git-common-dir answers, so
 * the parent of the common dir is the root. When neither gives a root (a bare repo, a folder git cannot read) the folder, which the path
 * test put under a live root, cannot be judged: AppScopeError.
 */
function repoRoots(deps: Deps, dir: string): { top: string; main: string | null } {
  const r = deps.git(dir, TOP_ARGS);
  const [top = '', common = ''] = r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()) : [];
  if (top !== '') return { top, main: rootOfCommon(dir, common) };
  const c = deps.git(dir, COMMON_ARGS);
  const root = c.status === 0 ? rootOfCommon(dir, c.stdout.trim()) : null;
  if (root === null) throw new AppScopeError(new Error(`the repo root of ${at(dir)} cannot be read (no work tree, and no <root>/.git common dir)`));
  return { top: root, main: root };
}
/**
 * The verdict of a push, create or merge in a folder that is not covered: the registry-corrupt deny (seat review 1, item 4; scope app-push
 * for a push, off the tap path, so hard; other for a create or merge, read with the home flags by homeRead), else an allow, with the notice
 * of a missing file named by LANE_REGISTRY_PATH.
 */
function passOf(place: Place, dir: string, scope: Scope): Decision {
  if (place.corrupt) return registryCorruptDeny(place.corrupt, dir, scope);
  return place.notice ? { action: 'allow', notice: place.notice } : ALLOW;
}
const registryCorruptDeny = (file: string, dir: string, scope: Scope): Deny => ({ ...deny('registry-corrupt', registryCorruptWhy(file, dir), scope), homeFlags: true });

/**
 * The first covered folder of the list, for a deny that fires in any checkout (cd-unexpanded, GIT_DIR). A CCv3 folder keeps today's text.
 * A git error (a timeout, the deadline) keeps today's text too, unless the path test (no git) puts the folder under a live root outside
 * the continuous-claude root: then the folder counts as covered, so the deny keeps scope app-push (fail closed).
 */
function coveredAmong(deps: Deps, dirs: string[]): string | null {
  const scope = deps.tapScope;
  if (!scope) return null;
  for (const dir of dirs) {
    try {
      if (isCcv3Checkout(deps, dir)) return null;
      if (appPlace(deps, dir).covered) return dir;
    } catch {
      if (underLiveRoot(dir, scope.registry(), scope, { outsideCcv3: true })) return dir;
    }
  }
  return null;
}

/**
 * git in one folder, for the ONE key rule of repo-identity.mjs (pushKey, ghKey through tap-scope.ts). app-ask.mjs runs the same rule over
 * the same git questions, so a tap it writes has the key this gate reads (fix round 1, F3 to F6).
 */
const gitIn = (deps: Deps, dir: string): GitRun => (args) => deps.git(dir, args);

/**
 * What a create or merge says about the repo (R5c). `named`: namedRepo of the whole raw text, as before the card (any CCv3 signal).
 * `repo` and `nonLiteral` (F1): read from the shape's own command only (its redirect-aware cut), where gh takes a repo, so a body, a
 * title, a heredoc or a chained gh call names no repo; plus a GH_REPO set in an earlier segment (fixer G, item 5).
 */
interface CmdRepo { named: string | null; repo: string | null; foreign: boolean; nonLiteral: boolean }
function cmdRepoOf(s: Shape, named: string | null, env: NodeJS.ProcessEnv): CmdRepo {
  const text = s.ftext ?? s.text ?? '';
  const prior = s.prior ?? NO_PRIOR;
  const repo = commandRepo(text, s.fmtext ?? s.mtext ?? text, env, prior.repos);
  return { named, repo, foreign: repo !== null && repo !== CCV3_REPO, nonLiteral: hasNonLiteralRepo(text) || CLUSTER_VAR_REPO.test(text) || prior.nonLiteral };
}
/**
 * Seat review 1, item 1: a variable after -R at the end of a short-flag cluster (-dR $R, -fR=%R%). hasNonLiteralRepo (checkpoint-shapes.ts,
 * frozen) needs a space before -R. Read only by appRepoFor (the app path): `nonLiteral` has no CCv3 reader.
 */
const CLUSTER_VAR_REPO = /(?:^|\s)-[A-Za-z]+R\s*=?["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)/;

const namesCcv3 = (repo: string | null): boolean => repo !== null && repo.split(' ').includes(CCV3_REPO);

/**
 * Which rule judges a create or merge in `dir` (fixer G, items 1 and 2). isCcv3Checkout is asked first, on every path:
 *   a CCv3 checkout       a gh segment that names another repo is denied (R5c, 'foreign') before any CCv3 signal of the whole text
 *                         counts; else the CCv3 rule. Coverage (appPlace) never runs for it, so its throw never gives a CCv3 call app-push.
 *   git cannot tell       (git remote -v fails) a text that names CCv3 keeps the CCv3 rule with no further git, as base did (it never
 *                         asked git then); any other text throws, as before.
 *   another folder        a text that names CCv3 keeps the CCv3 rule, except in a covered folder where only the gh segment's own repo
 *                         can name CCv3 (R9: a CCv3 URL in a --body does not open the CCv3 rule); else the app rule.
 */
function routeOf(deps: Deps, dir: string, cmd: CmdRepo): 'ccv3' | 'app' | 'foreign' {
  const named = cmd.named === CCV3_REPO;
  let ccv3: boolean;
  try {
    ccv3 = isCcv3Checkout(deps, dir);
  } catch (err) {
    if (named) return 'ccv3';
    throw err;
  }
  if (ccv3) return cmd.foreign ? 'foreign' : 'ccv3';
  if (!named) return 'app';
  return namesCcv3(cmd.repo) || !appPlace(deps, dir).covered ? 'ccv3' : 'app';
}

/**
 * The key repo of a create or merge in a covered folder (repo-identity.mjs ghKey: the FETCH repo of a remote, or the named repo when a
 * remote fetches it), with the offer that builds the same key (`base` plus --remote of that remote); or the deny: a variable repo, a named
 * repo no remote fetches, several remotes and none named, or a remote that fetches from one repo and pushes to another (F6).
 */
function appRepoFor(cmd: CmdRepo, deps: Deps, dir: string, place: Place, base: Offer): AppRepo | Deny {
  if (cmd.nonLiteral) return deny('repo-unreadable', appRepoUnreadableWhy(dir));
  const k = ghKey(gitIn(deps, dir), { named: cmd.repo, entryKey: place.entryKey, github: place.github });
  if (k.ok) return { key: k.key, offer: { ...base, remote: k.remote, ...aliasStop(deps, dir, place, k.key, k.remote) } };
  const offer: Offer = { ...base, remote: k.remote ?? '<remote>', ...aliasStop(deps, dir, place, k.key ?? '', k.remote ?? null) };
  if (k.why === 'repo-differs') return deny('repo-differs', appRepoDiffersWhy(deps, dir, cmd.repo ?? '', k.key ?? null, offer));
  if (k.why === 'fetch-push-differ') return deny('fetch-push-differ', appFetchPushWhy(deps, dir, k.remote ?? '', k.key ?? '', (k.pushKeys ?? []).map(String), offer));
  if (k.why === 'unnamed') return deny('repo-unnamed', appRepoUnnamedWhy(deps, dir, offer, k.key ?? null));
  return deny('repo-unnamed', appNoTargetWhy(deps, dir, k.remotes ?? [], offer));
}

/**
 * Fixer G, item 7: the stop line of an open-pr or merge offer whose key is local: because the remote is an SSH host alias and the entry has
 * no github field (app-ask refuses it; the way out is Dave's). Empty when the offer command can serve.
 */
function aliasStop(deps: Deps, dir: string, place: Place, key: string, remote: string | null): { stop?: string } {
  if (!key.startsWith('local:') || remote === null) return {};
  const url = fetchUrlOf(deps, dir, remote);
  return url !== null && needsGithubField(url, place.github) ? { stop: needsFieldLine(place.entryKey, remote) } : {};
}

/**
 * A git throw in a covered folder, after coverage is known: the catch reads decisions.enforce from the home copy only. `push` (the
 * default, a push or the coverage read): app-push joins the scopes. PR 566 round 2 (b, c): a throw inside a covered create or merge
 * carries push false, so it keeps scope other with the home flag, and the push flag does not judge it.
 */
class AppScopeError extends Error {
  constructor(readonly inner: unknown, readonly push = true) {
    super(String((inner as Error)?.message ?? inner));
    this.name = 'AppScopeError';
  }
}


// ---------- round 3 C1: the head and base of a create, read from one known place, once ----------

/**
 * The reading of a create: `bad` is the reason the words gh gets cannot be read whole (head-unresolved). `heads` and `bases`: every
 * distinct value named (the callers deny two or more, each with its own text).
 */
interface CreateRead { bad: string | null; heads: string[]; bases: string[] }
const CREATE_BOOL = new Set(['--draft', '-d', '--fill', '-f', '--fill-first', '--fill-verbose', '--web', '-w', '--no-maintainer-edit', '--dry-run', '--editor', '-e']);
const CREATE_VALUE = new Set(['--title', '-t', '--body', '-b', '--body-file', '-F', '--label', '-l', '--assignee', '-a', '--reviewer', '-r',
  '--milestone', '-m', '--project', '-p', '--head', '-H', '--base', '-B', '--repo', '-R', '--template', '-T', '--recover']);
const CREATE_SHORT_BOOL = 'dwef';
const CREATE_SHORT_VALUE = 'tbFlarmpHBRT';
const API_CREATE_KEYS = new Set(['head', 'base', 'title', 'body', 'draft', 'maintainer_can_modify', 'issue']);
const API_BOOL = new Set(['--paginate', '--slurp', '--silent', '--verbose', '-i', '--include']);
const CLI_CREATE_RE = /\bgh\s+pr\s+(?:create|new)\b/i;
const API_CMD_RE = /\bgh\s+api\b/i;
/** A value that is not a literal: cmd.exe %VAR% (the shell forms are caught by unmodelled). */
const NOT_LITERAL_RE = /%[^%\s]+%/;
const BAD = (why: string): CreateRead => ({ bad: why, heads: [], bases: [] });

/** `gh pr create|new <args>`: every word is a known flag or a value of one. -F is --body-file. */
function cliCreateRead(args: string, pwsh: boolean): CreateRead {
  const words = pairedWords(args, pwsh);
  if (words === null) return BAD('an unpaired quote');
  const heads: string[] = [];
  const bases: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('-') || w === '-') return BAD(`a word gh pr create does not take (${w})`);
    if (/^-[A-Za-z]{2,}/.test(w)) {
      const c = clusterOf(w, words[i + 1], CREATE_SHORT_BOOL, CREATE_SHORT_VALUE);
      if (c === null) return BAD(`a flag this gate does not know (${w})`);
      // -dH x and -dHx name a head (-B a base) as the long flag would.
      if (c.letter === 'H') heads.push(c.value!);
      if (c.letter === 'B') bases.push(c.value!);
      i += c.used;
      continue;
    }
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (CREATE_BOOL.has(name) && eq < 0) continue;
    if (!CREATE_VALUE.has(name)) return BAD(`a flag this gate does not know (${name})`);
    const value = eq > 0 ? w.slice(eq + 1) : words[++i];
    if (value === undefined) return BAD(`${name} with no value`);
    if (name === '--head' || name === '-H') heads.push(value);
    if (name === '--base' || name === '-B') bases.push(value);
  }
  return headAndBase(heads, bases);
}

/** A head or base value that is empty or not literal is bad; else every distinct value. An empty base (--base "") counts as none, as before. */
function headAndBase(heads: string[], bases: string[]): CreateRead {
  if (heads.some((v) => v === '' || NOT_LITERAL_RE.test(v))) return BAD('a head value that is empty or not a literal');
  const named = bases.filter((b) => b !== '');
  if (named.some((v) => NOT_LITERAL_RE.test(v))) return BAD('a base value that is not a literal');
  return { bad: null, heads: [...new Set(heads)], bases: [...new Set(named)] };
}

/** `gh api .../pulls <args>`: fields only from the known keys; an unknown word, --input, a head or base from a file (=@) or head_repo is bad. */
function apiCreateRead(rest: string, pwsh: boolean): CreateRead {
  const words = pairedWords(rest, pwsh);
  if (words === null) return BAD('an unpaired quote');
  const heads: string[] = [];
  const bases: string[] = [];
  let endpoint = false;
  for (let i = 0; i < words.length; i++) {
    const r = apiWord(words[i], words[i + 1], endpoint);
    if ('bad' in r) return BAD(r.bad);
    if (r.used === -1) { endpoint = true; continue; }
    i += r.used;
    if (r.field === null) continue;
    const eq = r.field.indexOf('=');
    const key = eq > 0 ? r.field.slice(0, eq) : r.field;
    if (!API_CREATE_KEYS.has(key)) return BAD(`a field this gate does not know (${key})`);
    const value = eq > 0 ? r.field.slice(eq + 1) : '';
    if ((key === 'head' || key === 'base') && value.startsWith('@')) return BAD(`a ${key} read from a file (${key}=@...)`);
    if (key === 'head') heads.push(value);
    if (key === 'base') bases.push(value);
  }
  return headAndBase(heads, bases);
}

/**
 * The head and base a create names, from the raw tail of its command (rawTail: up to the next ; | newline or && outside quotes, so a
 * head after 2>&1 is in it). The reader is the one of the EARLIER gh call: a quoted title that names gh pr new does not make an api create
 * a CLI one. A create that only the quotes-deleted view shows, or a text the allowlist refuses (unmodelled), is bad. gh's
 * {owner}/{repo}/{branch} placeholders are allowed, as in the merge read.
 */
function createRead(text: string, pwsh = false): CreateRead {
  const cli = CLI_CREATE_RE.exec(text);
  const api = API_CMD_RE.exec(text);
  const isCli = cli !== null && (api === null || cli.index < api.index);
  const m = isCli ? cli : api;
  if (m === null) return BAD('the create can only be read with its quotes deleted');
  if (!GH_PREFIX_OK.test(text.slice(0, m.index))) return BAD('the gh call is run by another program (a wrapper such as bash -c, pwsh -Command or cmd /c), which reads the words again');
  const rest = text.slice(m.index + m[0].length);
  if (unmodelled(rest.replace(/\{(?:owner|repo|branch)\}/g, 'x'), pwsh)) return BAD(CREATE_CHAR_WHY);
  return isCli ? cliCreateRead(rest, pwsh) : apiCreateRead(rest, pwsh);
}
const CREATE_CHAR_WHY = 'a character whose effect this gate cannot read the same way in bash and PowerShell (outside quotes only letters, digits, - _ . / = : and spaces; no $, backtick or backslash in double quotes; no redirect, &, non-ASCII or CR)';
const createBadWhy = (dir: string, why: string): string =>
  `the head or base of this create cannot be read as gh reads it in ${dir}: ${why}. Name the head and base once, in the plain form: gh pr create --head <branch> --base <base> ..., or gh api .../pulls -X POST -f head=<branch> -f base=<base> .... A body made by $(...) or a heredoc is refused: pass it as a file with --body-file <path> or -F body=@<path>, with forward slashes in the path. ${PLAIN_WAY_OUT}`;

/** The branch of a named head (its `owner:` prefix dropped), else the checked-out branch. */
function readBranch(named: string | null, deps: Deps, dir: string): string {
  if (named) return named.replace(/^[^:\s]+:/, '');
  const r = deps.git(dir, ['branch', '--show-current']);
  if (r.status !== 0) throw new Error('git branch --show-current failed');
  return r.stdout.trim();
}
// ---------- a plain commit before the push, in the same command ----------

const COMMIT_GIT = gitCallRe('commit');
const COMMIT_SAFE = safeCallRe('commit', PUSH_WRAPPERS, '', 'gi');
const READ_VERB = '(?:status|diff|log|show|rev-parse)';
const READ_GIT = gitCallRe(READ_VERB);
const READ_SAFE = safeCallRe(READ_VERB, PUSH_WRAPPERS, '', 'gi');
/** The only commit arguments a chained commit may have: a message by file or text, and quiet. Nothing that stages, amends or names a path. */
const COMMIT_MSG = String.raw`(?:-[Fm]\s+${VAL}|--(?:file|message)(?:=|\s+)${VAL})`;
const COMMIT_ARGS_RE = new RegExp(String.raw`^(?:\s+(?:-q|--quiet))*\s+${COMMIT_MSG}(?:\s+(?:-q|--quiet|${COMMIT_MSG}))*\s*$`);
const CD_SEG_RE = /^\s*(?:cd|Set-Location|sl|chdir|pushd|Push-Location)\s+\S/i;
/** 'stage' comes only from stageKind (shipFlow, a text choice); segmentKind never returns it. */
type SegKind = 'cd' | 'commit' | 'push' | 'read' | 'stage' | 'other';

/** The call that opens a segment (no env prefix, no `then`, no wrapper word). Null when the segment opens with something else. */
function openCall(ms: string, rs: string, git: RegExp, safe: RegExp): { opts: string; end: number } | null {
  const kinds: [RegExp, (token: string) => boolean][] = [[git, isGitToken], [safe, (t) => isSafeToken(t, PUSH_WRAPPERS)]];
  for (const [re, valid] of kinds) {
    for (const m of ms.matchAll(re)) {
      if (m[1].trim() !== '') continue;
      const tokenStart = m.index! + m[1].length;
      if (!valid(rs.slice(tokenStart, tokenStart + m[2].length))) continue;
      const optsStart = tokenStart + m[2].length;
      return { opts: rs.slice(optsStart, optsStart + m[3].length), end: m.index! + m[0].length };
    }
  }
  return null;
}

/** What one command segment is. Anything that is not plainly one of the kinds is 'other'. `ms` is the masked view, `rs` the raw text. */
function segmentKind(ms: string, rs: string): SegKind {
  // A group, a redirect or an expansion can hide a second command. $ and a backtick are checked in the raw text, because a quoted $( ) still runs.
  if (/[(){}<>]/.test(ms) || /[$`]/.test(rs)) return 'other';
  if (CD_SEG_RE.test(ms)) return 'cd';
  const commit = openCall(ms, rs, COMMIT_GIT, COMMIT_SAFE);
  if (commit) return commit.opts.trim() === '' && COMMIT_ARGS_RE.test(rs.slice(commit.end)) ? 'commit' : 'other';
  if (openCall(ms, rs, PUSH_GIT, PUSH_SAFE)) return 'push';
  const read = openCall(ms, rs, READ_GIT, READ_SAFE);
  return read && read.opts.trim() === '' ? 'read' : 'other';
}

/**
 * True when the command commits what is staged and only then pushes, so the tree the push sends is the INDEX tree read now, not HEAD's
 * (HEAD is still the parent while the hook runs). Every segment must be plain: one cd at most, before the first commit; plain commits
 * (segmentKind); pushes; read-only git. Every commit comes before every push, and only && joins the commit to the push (a failed commit
 * must stop it; `;`, a newline or `||` would still push HEAD). A `|`, a lone `&` (background) or any other segment
 * (git add, a checkout, a script, a commit with --amend or -a) gives false, and the push keeps the HEAD tree rule.
 */
function commitPrecedesPush(raw: string, shell: 'bash' | 'pwsh'): boolean {
  const segs = segmentsOf(raw, shell);
  if (segs === null) return false;
  const { seq, before } = segs;
  const firstCommit = seq.indexOf('commit');
  const lastPush = seq.lastIndexOf('push');
  const firstPush = seq.indexOf('push');
  if (seq.includes('other') || firstCommit < 0 || firstPush < 0 || seq.lastIndexOf('commit') > firstPush) return false;
  // A failed commit must stop the push: `;`, a newline or `||` would still run it and send HEAD's tree. Only && joins the commit to the push.
  if (before.slice(firstCommit + 1, lastPush + 1).some((op) => op !== '&&')) return false;
  const cds = seq.flatMap((k, i) => (k === 'cd' ? [i] : []));
  return cds.length === 0 || (cds.length === 1 && cds[0] < firstCommit);
}

/**
 * True when every segment of the command is a cd, a read-only git call or a push, with at least one push. Only then does "Push only" apply:
 * nothing in the command can stage, commit or move HEAD before the push, so the tree pushed is the HEAD tree the tap bound. A redirect, a
 * trailing command, an add, a commit, a merge or any 'other' segment gives false, and the Push only tap does not count (fail closed).
 */
function pushesAlone(raw: string, shell: 'bash' | 'pwsh'): boolean {
  const segs = segmentsOf(raw, shell);
  return segs !== null && segs.seq.includes('push') && segs.seq.every((k) => k === 'cd' || k === 'push' || k === 'read');
}

/** 2>&1 and 1>&2 only join two outputs and write no file. Blanked (same length) so the segment reading does not see a redirect or a lone &. */
const FD_DUP = /(^|\s)[12]?>&[12](?=\s|$)/g;
/** The text with each 2>&1 or 1>&2 blanked, same length. */
const fdBlank = (raw: string): string => raw.replace(FD_DUP, (m: string, lead: string) => lead + ' '.repeat(m.length - lead.length));
/**
 * Fix round 3 (fixer H, advisor review): true when nothing in the command can switch the branch, make a tag or write config before a push:
 * every segment is a cd, read-only git, a plain commit or a push (pushesAlone or commitPrecedesPush), with 2>&1 allowed. A covered push
 * earns the no-tap allow only in such a command; the gate reads @{push}, the tags and the config as they are when the hook runs.
 */
function steadyCommand(raw: string, shell: 'bash' | 'pwsh'): boolean {
  const view = fdBlank(raw);
  return pushesAlone(view, shell) || commitPrecedesPush(view, shell);
}

/**
 * Round 3 C4: true when nothing the gate does not model can change HEAD, the branch or the tree before a push runs. Either the command
 * is the modelled commit-then-push (commitPrecedesPush: the index rule), or every step before the LAST step that names a push is a cd,
 * a read-only git call or a push, joined by ; && or ||. What follows the last push (a pipe, 2>&1, a git log) cannot change what it
 * sends. A pipe or a lone & before it, a group, a redirect, another program or any other step before it: false.
 */
function stateModelled(raw: string, shell: 'bash' | 'pwsh'): boolean {
  const r = pushPrefix(raw, shell);
  return r !== null && !r.localPush && r.pipeOk && (r.plain || commitPrecedesPush(r.prefix, shell));
}
/**
 * The text up to the end of the LAST step that names a push (null when no step names one), whether every step before it is a cd, popd,
 * a read-only git call or a push joined by ; && or || (`plain`), and whether a push before it goes to a local path (`localPush`). What
 * follows the last push (a pipe, 2>&1 | Select-Object) cannot change what it sends, so commitPrecedesPush reads the prefix: the
 * commit-and-push flow with a trailing pipe is the index rule; so is commit && push && commit (the last commit is after the push).
 * Accepted over-deny: a step after the push that names the word push (git push ... | Select-String push) becomes the last named step.
 */
function pushPrefix(raw: string, shell: 'bash' | 'pwsh'): { prefix: string; plain: boolean; localPush: boolean; pipeOk: boolean } | null {
  const view = fdBlank(joinContinuations(raw, shell));
  const masked = maskQuoted(view, shell === 'pwsh' ? 'PowerShell' : 'Bash');
  const steps: { kind: SegKind | 'popd'; named: boolean; op: string; end: number; raw: string }[] = [];
  let from = 0;
  let pending = '';
  for (const [start, next] of [...[...masked.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index!, m.index! + m[0].length] as const), [view.length, view.length] as const]) {
    const ms = masked.slice(from, start);
    const rs = view.slice(from, start);
    // A step names a push when its quotes-deleted text holds the word (git "push" is a push too).
    if (ms.trim() !== '') { steps.push({ kind: /^\s*(?:popd|Pop-Location)\s*$/i.test(ms) ? 'popd' : segmentKind(ms, rs), named: /\bpush\b/i.test(squashQuotes(rs)), op: pending, end: start, raw: rs }); pending = ''; } else pending += ms;
    pending += masked.slice(start, next);
    from = next;
  }
  // Only the steps BEFORE the last step that names a push are C4's business. The words of that step itself (a wrapper, $B, git "push")
  // are read by the push reader (its tap path and C3), not here.
  const last = steps.map((s) => s.named).lastIndexOf(true);
  if (last < 0) return null;
  // popd and Pop-Location only move the folder: the position reader judges them (position-unknown), so they count as a cd here.
  const plain = steps.slice(0, last).every((s) => s.kind === 'cd' || s.kind === 'read' || s.kind === 'push' || s.kind === 'popd')
    && steps.slice(1, last + 1).every((s) => !s.op.includes('|') && !/(?<!&)&(?!&)/.test(s.op));
  // Seat fix 6: a push step before the last one that pushes to a local path (git push . HEAD:x, git push ../r main) moves a local branch.
  const tool = shell === 'pwsh' ? 'PowerShell' : 'Bash';
  const localPush = steps.slice(0, last).some((s) => s.kind === 'push' && pushShapesOf(s.raw, tool).some((p) => LOCAL_REMOTE.test(p.push?.remote ?? '')));
  // CLI :2394 (Dave 2026-11-15, "Fix now"): both sides of a pipe run at the same time, so a step the last push pipes into can move HEAD
  // before the push reads it. Each step of that pipe chain must be a listed read-only program (first word of the masked step), with no
  // file redirect (a null target is fine) and no command substitution or block in it.
  let pipeOk = true;
  // Seat read of f1e57235: a single & (background) puts the push in the background with every step joined to it by |, && or ||, so
  // the next step runs at the same time. A trailing & with no step after it is the same (the push is not done when the next command
  // runs). The first ; newline or single & after the last push decides: a & refuses; a ; or a newline ends the list, and the push is done.
  if (backgroundAfter([...steps.slice(last + 1).map((s) => s.op), pending])) pipeOk = false;
  for (let i = last + 1; i < steps.length && /(?<!\|)\|(?!\|)/.test(steps[i].op); i++) {
    const ms = masked.slice(steps[i].end - steps[i].raw.length, steps[i].end);
    if (!PIPE_CONSUMER.test(ms.trim().split(/\s+/)[0] ?? '') || /[$`@({<]/.test(ms.replace(/\$null\b/gi, '')) || fileRedirect(ms)) pipeOk = false;
  }
  return { prefix: view.slice(0, steps[last].end), plain, localPush, pipeOk };
}
/**
 * CLI :2394, seat list (2026-11-15): the read-only programs a push may pipe its output into. Not Tee-Object, ForEach-Object, node or git;
 * not sort (seat read of f1e57235: sort -o writes a file with no redirect; 0 of 588 measured pushes pipe into sort).
 */
const PIPE_CONSUMER = /^(?:Select-Object|Select-String|Out-String|Out-Null|tail|head|cut|grep|findstr|wc|more)$/i;
/** True when, in the separators after the last push, a single & comes before the first ; or newline (the push runs in the background). */
function backgroundAfter(ops: string[]): boolean {
  for (const op of ops) {
    const m = /(?<!&)&(?!&)|[;\r\n]/.exec(op);
    if (m !== null) return m[0] === '&';
  }
  return false;
}
/** A > or >> to a file: a target other than $null, /dev/null or NUL. 2>&1 is blanked before (fdBlank). */
const fileRedirect = (ms: string): boolean => [...ms.matchAll(/[0-9*]?>{1,2}\s*(\S*)/g)].some((m) => !/^(?:\$null|\/dev\/null|nul)$/i.test(m[1]));
/** A push remote that is a path on this machine, not a remote name: ., .., ./x, ../x, /x, ~, a drive letter, file:, a backslash. */
const LOCAL_REMOTE = /^(?:\.{1,2}(?:[\\/]|$)|[\\/~]|[A-Za-z]:|file:)|\\/i;
const PUSH_STATE_WHY = 'a step before this push, or a step that runs at the same time (a pipe, a background &), can change the branch, HEAD or the tree it sends (a checkout, a reset, a merge, a commit joined by ; or ||, a group, a pipe or another program), and this gate reads them before the command runs. Run the branch change and the push as two commands; run git push as its own command: git push <remote> <branch>. For a commit: commit first, push in a separate command: commit in one command (git add <files> then git commit -F <file>), and push in the next command (git push <remote> <branch>), after the Commit and push question.';
const PUSH_CHECKOUT_WHY = 'the commit before this push runs in one checkout and the push in another (or the checkout of the push folder cannot be read), so the tree it sends cannot be judged. Commit and push in two commands, or push from the same folder: git commit ...; git push <remote> <branch>.';

/**
 * Round 3 C4 (R3-b): true when the push folder and every folder the chained commit can run in are one checkout: rev-parse
 * --show-toplevel is equal (2 git calls for the common case). A failed call is false.
 */
function sameCheckout(deps: Deps, commitDirs: string[], dir: string): boolean {
  const top = (d: string): string | null => {
    const r = deps.git(d, ['rev-parse', '--path-format=absolute', '--show-toplevel']);
    return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  };
  // Seat fix 7: the bound is a count of git calls, not a clock: the push folder and at most 2 commit folders (3 calls). More: false.
  if (commitDirs.length === 0 || commitDirs.length > 2) return false;
  const push = top(dir);
  return push !== null && commitDirs.every((c) => top(c) === push);
}

const ADD_GIT = gitCallRe('add');
const ADD_SAFE = safeCallRe('add', PUSH_WRAPPERS, '', 'gi');
/** segmentKind, plus 'stage' for a git add and 'commit' for any git commit (no group, redirect or expansion): the ship flow text only. */
function stageKind(ms: string, rs: string): SegKind {
  const k = segmentKind(ms, rs);
  if (k !== 'other' || /[(){}<>]/.test(ms) || /[$`]/.test(rs)) return k;
  if (openCall(ms, rs, COMMIT_GIT, COMMIT_SAFE)) return 'commit';
  return openCall(ms, rs, ADD_GIT, ADD_SAFE) ? 'stage' : 'other';
}
/**
 * Coordinator review of seat ruling a (11-13): true when the command is the Commit and push flow: git add calls and at least one git
 * commit, all before the push, with only cd and read-only git beside them. A "Commit and push" tap is the way out there, so it keeps
 * the ship text. Text only: the tap rule (chained, alone) is unchanged.
 */
function shipFlow(raw: string, shell: 'bash' | 'pwsh'): boolean {
  const segs = segmentsOf(fdBlank(raw), shell, stageKind);
  if (segs === null || segs.seq.includes('other')) return false;
  const firstPush = segs.seq.indexOf('push');
  const lastCommit = segs.seq.lastIndexOf('commit');
  return firstPush >= 0 && lastCommit >= 0 && Math.max(lastCommit, segs.seq.lastIndexOf('stage')) < firstPush;
}

/** The kinds of the command's segments and the operators before each, or null when a pipe or a lone & (background) is present. */
function segmentsOf(raw: string, shell: 'bash' | 'pwsh', kindOf: (ms: string, rs: string) => SegKind = segmentKind): { seq: SegKind[]; before: string[] } | null {
  const view = joinContinuations(raw, shell);
  const masked = maskQuoted(view, shell === 'pwsh' ? 'PowerShell' : 'Bash');
  if (masked.includes('|') || /(?<!&)&(?!&)/.test(masked)) return null;
  const seq: SegKind[] = [];
  const before: string[] = []; // before[i]: the operators and blanks between segment i-1 and segment i
  let from = 0;
  let pending = '';
  const breaks = [...masked.matchAll(/[;&\r\n]+/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  for (const [start, next] of [...breaks, [view.length, view.length] as const]) {
    const ms = masked.slice(from, start);
    if (ms.trim() !== '') { seq.push(kindOf(ms, view.slice(from, start))); before.push(pending.trim()); pending = ''; } else pending += ms;
    pending += masked.slice(start, next);
    from = next;
  }
  return { seq, before };
}

// ---------- the judgment ----------

const shellOf = (input: HookInput): 'bash' | 'pwsh' => ((input.tool_name || input.tool) === 'PowerShell' ? 'pwsh' : 'bash');
const ALLOW: Decision = { action: 'allow' };

/**
 * Create: the open-pr decision for (branch, head of the branch). A create from main, or outside CCv3 and every covered folder, is not gated.
 * In a CCv3 checkout a create that names another repo is denied (R5c). Outside CCv3 the covered-folder rule decides (judgeAppCreate).
 */
function judgeCreate(s: Shape, deps: Deps, dir: string, cmd: CmdRepo): Decision {
  const route = routeOf(deps, dir, cmd);
  // Round 3 C1 (seat ruling A): both paths read the head from the raw tail, not from the &-cut text.
  if (route === 'app') return judgeAppCreate(s.tail ?? s.ftext ?? s.text!, s.pwsh === true, deps, dir, cmd);
  if (route === 'foreign') return deny('repo-foreign', goThereWhy(cmd.repo!));
  // G4: the CCv3 head is read from the base cut (any & ends it), as in base main 7a0e2f34. Round 3 C1: from one known place, once.
  const cr = createRead(s.tail ?? s.text!, s.pwsh === true);
  if (cr.bad !== null) return deny('head-unresolved', createBadWhy(dir, cr.bad));
  if (cr.heads.length > 1) return deny('head-unresolved', createBadWhy(dir, `two head values (${cr.heads.join(', ')}); gh takes the last`));
  const branch = readBranch(cr.heads[0] ?? null, deps, dir);
  // An empty head (detached HEAD, or no head the text names) cannot be tied to a tap: deny, never allow.
  if (branch === '') return deny('head-unresolved', `the head branch of this create cannot be named in ${dir} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo on a branch.`);
  if (branch === 'main') return ALLOW;
  const r = deps.git(dir, ['rev-parse', `${branch}^{commit}`]);
  if (r.status !== 0) return deny('head-unresolved', `cannot read the head of ${branch} in ${dir}, so its open-pr decision cannot be found. Run the command again from the repo.`);
  const head = r.stdout.trim();
  const d = decisionRead({ step: 'open-pr', key: decisionKey({ branch }), head });
  return d && isOpenPrLabel(d.label) ? ALLOW : deny('open-pr', openPrWhy(branch, head));
}

/** Land or merge: a land decision for the PR whose label allows it (and whose head is the sha= of its own segment, when the segment has one). */
function judgeLand(shape: Shape, deps: Deps, dir: string, cmd: CmdRepo): Decision {
  // land-pr.ps1 is CCv3 only. A merge command is gated in a CCv3 checkout, when it names CCv3, or in a covered folder (judgeAppMerge).
  const route = shape.kind === 'merge' ? routeOf(deps, dir, cmd) : 'ccv3';
  if (route === 'app') return judgeAppMerge(shape, deps, dir, cmd);
  if (route === 'foreign') return deny('repo-foreign', goThereWhy(cmd.repo!));
  if (shape.pr === null) return deny('no-pr', NO_PR_WHY);
  if (shape.kind === 'merge' && shape.shaBad) return deny('merge-no-head', `PR #${shape.pr}: ${HEAD_UNREAD_WHY(shape.pr)} The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr}).`);
  const sha = shape.sha ?? undefined;
  // A raw merge with no sha= has no head to compare, so an old tap (a head that has since moved) could land a new head. land-pr.ps1 pins the head itself.
  if (shape.kind === 'merge' && !sha) return deny('merge-no-head', `${shape.pr ? `PR #${shape.pr}` : 'this PR'}: a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Run land-pr.ps1 -Pr ${shape.pr ?? '<n>'} (it pins the head), or pass the tapped head: gh api .../merge -f sha=<head>, gh pr merge --match-head-commit <head>. The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr ?? '<n>'}).`);
  const key = decisionKey({ pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === 'land' && r.key === key && isLandLabel(r.label) && (!sha || r.head.toLowerCase() === sha));
  return ok ? ALLOW : deny('land', landWhy(shape.pr));
}

/** Create in a folder outside CCv3: when covered, "Open draft PR" for (key repo, branch, head). Unlike CCv3, a create from main needs a tap too. */
function judgeAppCreate(text: string, pwsh: boolean, deps: Deps, dir: string, cmd: CmdRepo): Decision {
  return homeRead(inApp(deps, () => appCreate(text, pwsh, deps, dir, cmd)));
}
/** Fix round 6 (item 1): a deny for a covered folder reads decisions.enforce from the home copy only. */
const homeRead = (d: Decision): Decision => (d.action === 'deny' ? { ...d, homeFlags: true as const } : d);
/**
 * PR 566 round 2 (b, c): the coverage read of a create or merge, then its body. A throw after coverage is known (the coverage read's own
 * AppScopeError, or any throw in the body) leaves as AppScopeError with push false: the catch reads decisions.enforce from the home copy
 * only and keeps scope other. A throw before coverage is known stays as it is.
 */
function coveredCall(deps: Deps, dir: string, body: (place: Place) => Decision): Decision {
  let place: Place;
  try {
    place = appPlace(deps, dir);
  } catch (err) {
    throw err instanceof AppScopeError ? new AppScopeError(err.inner, false) : err;
  }
  if (!place.covered) return passOf(place, dir, 'other');
  try {
    return body(place);
  } catch (err) {
    throw new AppScopeError(err instanceof AppScopeError ? err.inner : err, false);
  }
}
function appCreate(text: string, pwsh: boolean, deps: Deps, dir: string, cmd: CmdRepo): Decision {
  return coveredCall(deps, dir, (place) => appCreateIn(text, pwsh, deps, dir, cmd, place));
}
function appCreateIn(text: string, pwsh: boolean, deps: Deps, dir: string, cmd: CmdRepo, place: Place): Decision {
  // PR 566 round 2 (a): gh takes the LAST of a repeated --head, the gate reads the first. Two different heads: no tap can name the one
  // that opens, so the create is denied before any head is read.
  // Round 3 C1: the head and base are read from one known place, once (createRead); a create the reader cannot read whole is denied.
  const cr = createRead(text, pwsh);
  if (cr.bad !== null) return deny('head-unresolved', createBadWhy(dir, cr.bad));
  const heads = cr.heads;
  if (heads.length > 1) return deny('head-unresolved', appManyHeadsWhy(dir, heads));
  // PR 566 review: an `owner:` head opens the PR from that owner's fork. The tap is keyed on the local branch and its local head, so it
  // cannot cover another fork's branch: denied before the prefix is dropped (readBranch keeps dropping it for the CCv3 path).
  const owner = /^([^:\s]+):/.exec(heads[0] ?? '')?.[1] ?? null;
  if (owner !== null) return deny('head-foreign', appHeadOwnerWhy(dir, owner));
  // The head first: every repo deny below then offers open-pr with the branch this create names (--head), not the checked-out one.
  const branch = readBranch(heads[0] ?? null, deps, dir);
  if (branch === '') return deny('head-unresolved', appHeadWhy(dir));
  // Fix round 5 (F8): the base the create names is in the key and in the offer (repo-identity.mjs openPrKey, the rule of app-ask).
  if (cr.bases.length > 1) return deny('base-unresolved', appManyBasesWhy(dir, cr.bases));
  const base = cr.bases[0] ?? null;
  const repo = appRepoFor(cmd, deps, dir, place, { sub: 'open-pr', branch, ...(base === null ? {} : { base }) });
  if ('action' in repo) return repo;
  const r = deps.git(dir, ['rev-parse', `${branch}^{commit}`]);
  if (r.status !== 0) return deny('head-unresolved', appHeadReadWhy(dir, branch));
  const head = r.stdout.trim();
  const d = decisionRead({ step: 'open-pr', key: openPrKey({ repo: repo.key, branch, base }), head });
  return d && isOpenPrLabel(d.label) ? ALLOW : deny('open-pr', appOpenPrWhy(deps, dir, repo, branch, head, base));
}

/** Merge in a folder outside CCv3: when covered, "Merge now (no READY check)" for (key repo, PR) at the head the command names. */
function judgeAppMerge(shape: Shape, deps: Deps, dir: string, cmd: CmdRepo): Decision {
  return homeRead(inApp(deps, () => appMerge(shape, deps, dir, cmd)));
}
function appMerge(shape: Shape, deps: Deps, dir: string, cmd: CmdRepo): Decision {
  return coveredCall(deps, dir, (place) => appMergeIn(shape, deps, dir, cmd, place));
}
function appMergeIn(shape: Shape, deps: Deps, dir: string, cmd: CmdRepo, place: Place): Decision {
  if (shape.pr === null) return deny('no-pr', appNoPrWhy(dir));
  const repo = appRepoFor(cmd, deps, dir, place, { sub: 'merge', pr: shape.pr });
  if ('action' in repo) return repo;
  if (shape.shaBad) return deny('merge-no-head', `PR #${prose(shape.pr)} (folder ${at(dir)}): ${HEAD_UNREAD_WHY(shape.pr)}`);
  const sha = shape.sha ?? null;
  if (!sha) return deny('merge-no-head', appMergeNoHeadWhy(deps, dir, shape.pr, repo.offer));
  const key = decisionKey({ repo: repo.key, pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === 'land' && r.key === key && isMergeNowLabel(r.label) && r.head.toLowerCase() === sha);
  return ok ? ALLOW : deny('land', appMergeWhy(deps, dir, repo, shape.pr));
}

/**
 * `-C <path>` of a push: absolute as given, else under the directory the command acts in. A value with a backslash is raw (quotes still
 * on) and is unquoted by the rules of the shell; any other value was squashed already (pushShapesFrom), as in base.
 */
function resolveDir(base: string, value: string, shell: 'bash' | 'pwsh'): string {
  const raw = value.includes('\\') ? unquotePath(value, shell) : value;
  if (hasUnexpandedPart(value)) return UNEXPANDED + raw;
  const t = shell === 'bash' ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  return isUnexpanded(base) ? base : resolve(base, t);
}

/**
 * Every folder a shape may run in. A cd in the text may never run (|| short-circuit, a failed cd, a comment) or may not last (a subshell,
 * a pipe, the background), so the shape is judged in the folder after each prefix of its cds. With no cd it is the payload cwd.
 * `dir` is a -C (or -Path) of the shape itself: it then moves each of them. Used by push, create, land and merge.
 * `loose`: a cd before the shape is joined to it by something other than && (looseJoin), so it can fail and the shape runs in the payload
 * cwd (or the folder of an earlier cd, which the prefixes already hold). The cwd is judged too, as planRun in pre-pr-gate does.
 */
function dirsAfter(cwd: string, cds: string[], shell: 'bash' | 'pwsh', loose: boolean, dir: string | null = null): string[] {
  const dirs = cds.length === 0 ? [cwd] : [...(loose ? [cwd] : []), ...cds.map((_, i) => pushDir(cwd, cds.slice(0, i + 1), shell))];
  return [...new Set(dirs.map((d) => (dir === null ? d : resolveDir(d, dir, shell))))];
}
const pushDirsOf = (p: PushShape, cwd: string, shell: 'bash' | 'pwsh'): string[] => dirsAfter(cwd, p.cds, shell, p.loose, p.dir);

const POSITION_WHY = 'popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, so the checkout this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd.';

/** Every deny of one create, land or merge: judged in each folder on its cd path. A position that is unknown is denied when CCv3 may be the place. */
function judgeAt(s: Shape, deps: Deps, cwd: string, shell: 'bash' | 'pwsh', named: string | null): Decision[] {
  const at = s.at!;
  const cmd = cmdRepoOf(s, named, deps.env);
  const dirs = dirsAfter(cwd, at.cds, shell, at.loose);
  // An unexpanded cd target names a folder this hook cannot know: denied in any checkout (as pre-pr-gate: cannot expand). The land script reads no folder.
  const lost = dirs.find(isUnexpanded);
  if (lost !== undefined && s.kind !== 'land') return [unexpandedDeny(deps, [cwd, ...dirs], lost, 'other', 'other')];
  // judgeLand reads no folder for the land script, so a popd never blocks it: its PR tap alone decides.
  if (at.unknown && s.kind !== 'land') {
    const all = [...new Set([cwd, ...dirs])];
    const ccv3 = cmd.named === CCV3_REPO || all.some((d) => isCcv3Checkout(deps, d));
    // No CCv3 folder: a covered folder on the path denies too (R3a).
    return ccv3 ? [deny('position-unknown', POSITION_WHY)] : appPositionAt(deps, all, 'other', s.kind === 'create' ? { sub: 'open-pr' } : { sub: 'merge', pr: s.pr ?? '<pr>' });
  }
  return dirs.map((d) => (s.kind === 'create' ? judgeCreate(s, deps, d, cmd) : judgeLand(s, deps, d, cmd)));
}

/**
 * The cd-unexpanded deny: the app text and scope when a folder of the list is covered (round 6, item 2: each judged alone, a home value
 * expanded by knownDirs, so a CCv3 cwd no longer hides a covered folder beside the value), else today's. The app deny is the tap path
 * (round 6): a force push is hard by the verb rule.
 */
function unexpandedDeny(deps: Deps, dirs: string[], lost: string, scope: Scope, appScope: Scope, soft = true): Deny {
  const dir = firstCovered(deps, knownDirs(dirs, deps.home));
  if (dir === null) return deny('cd-unexpanded', unexpandedWhy(lost), scope);
  const d: Deny = { ...deny('cd-unexpanded', unexpandedWhy(lost) + inAppFolder(dir), appScope), homeFlags: true };
  return soft ? { ...d, tapPath: true } : d;
}
/** Reviewer-2 item 3: a push is on the tap path only when nothing in it is a hard deny (subagent, force or delete, a wide or unsafe option, --repo, an o bundle, a widening option). */
const softPush = (p: PushShape, subagent: boolean): boolean => !subagent && !p.force && !p.unsafeOpt && !p.repoOpt && !p.oBundle && p.widerOpt === null;

/** Position unknown with no CCv3 folder on the path (the caller tested every one): a deny when one of the folders is covered (R3a). */
function appPositionAt(deps: Deps, dirs: string[], scope: Scope, offer: Offer): Decision[] {
  let notice: string | null = null;
  for (const dir of dirs) {
    const place = appPlace(deps, dir);
    if (place.covered) return [{ ...deny('position-unknown', inApp(deps, () => appPositionWhy(deps, dir, offer)), scope), homeFlags: true as const }];
    // Seat review 1, item 4: a corrupt registry denies the shape in a folder outside CCv3 (the caller found no CCv3 folder on the path).
    if (place.corrupt) return [registryCorruptDeny(place.corrupt, dir, scope)];
    notice ??= place.notice ?? null;
  }
  return notice === null ? [] : [{ action: 'allow', notice }];
}
const pushOffer = (p: PushShape): Offer => ({ sub: 'push', remote: p.remote });

/**
 * Every deny of one push: judged in each folder on its cd path (pushDirsOf). When a popd, Pop-Location, `cd -` or a bare cd comes before it the
 * folder is unknown (as in judgeAt): it is denied, tap or not, if the cwd or a folder on the known cd path is a CCv3 checkout. A -C that is
 * absolute names the folder itself, so the position does not matter and the push is judged there.
 */
/** `text`, `shell`: the command, for the move targets of each judged folder (ruling B). */
/** `flow`: the command is the Commit and push flow (shipFlow), so a not-alone push keeps the ship text. */
/**
 * `unregistered` (round 3 C3, item 10): every push folder of the call is resolved and under no registry root (pushFoldersUnregistered).
 * Only there does a push that moves the repo keep the old warning (the R18-C3 narrowing, Dave D1); elsewhere it is a hard deny.
 */
interface PushCtx { subagent: boolean; chained: boolean; alone: boolean; flow: boolean; text: string; shell: 'bash' | 'pwsh'; modelled: boolean; commitDirs?: string[]; unregistered?: boolean }
/** Round 3 C3 (item 10): a deny of a push whose checkout is unknown is hard, unless every push folder is a resolved unregistered one. */
const hardUnlessUnregistered = (d: Deny, unregistered: boolean | undefined): Deny => (unregistered ? d : hardOf(d));
function judgePushAt(s: Shape, deps: Deps, cwd: string, shell: 'bash' | 'pwsh', ctx: PushCtx): Decision[] {
  const { subagent, chained, alone } = ctx;
  const p = s.push!;
  const dirs = pushDirsOf(p, cwd, shell);
  // Fix round 5 (F4, ruling B): git applies every -C in order. A chain folder the base reading (last -C) misses is judged too, when it is
  // covered (firstCovered: a CCv3 or uncovered chain folder adds nothing, so the base output stays). It comes first: a git throw in a
  // base folder then ends in the catch, which also reads the chain (pushUnderLiveRoot).
  const chainOnly = chainDirsOf(p, cwd, shell).filter((d) => !dirs.includes(d) && firstCovered(deps, [d]) !== null);
  const c4: PushCtx = { ...ctx, commitDirs: dirsAfter(cwd, p.cds, shell, p.loose, null) };
  const fromChain = chainOnly.map((d) => judgeAppPushAt(s, deps, d, subagent, chained, alone, ctx.flow, c4));
  const lost = dirs.find(isUnexpanded);
  if (lost !== undefined) return [unexpandedDeny(deps, [cwd, ...dirs], lost, 'push', 'app-push', softPush(p, subagent))];
  const fixedByDir = p.dir !== null && resolveDir('/a', p.dir, shell) === resolveDir('/b', p.dir, shell);
  if (p.unknown && !fixedByDir) {
    const all = [...new Set([cwd, ...dirs])];
    const ccv3 = all.some((d) => isCcv3Checkout(deps, d));
    if (ccv3) return [intentDeny(p, subagent, deny('position-unknown', POSITION_WHY, 'push'))];
    // A covered folder on the path denies too (R3a). Else judge the known folders anyway, so a --git-dir or --work-tree push (p.moved) still denies.
    const app = appPositionAt(deps, all, 'app-push', pushOffer(p));
    if (app.some((d) => d.action === 'deny')) return app;
  }
  return [...fromChain, ...dirs.map((d) => judgePush(s, deps, d, c4))];
}

/** A remote name or URL: the upstream (origin, parcadei), the fork (fork, the CCv3 repo URL) or neither. */
function remoteKind(remote: string): 'origin' | 'fork' | null {
  const r = remote.toLowerCase();
  if (r === 'origin' || r.includes('parcadei')) return 'origin';
  return r === 'fork' || r.includes(CCV3_REPO) ? 'fork' : null;
}

/** The source or the destination of the refspec names a ref outside refs/heads and refs/tags (the shape drops refs/heads/ itself), or holds a wildcard. */
const outsideHeads = (p: PushShape): boolean => [p.src, p.branch].some((r) => typeof r === 'string' && ((r.startsWith('refs/') && !r.startsWith('refs/tags/')) || r.includes('*')));

/** A hard deny: it holds whatever decisions.enforcePush says (decide() asks hardAppDeny first). */
const hardOf = (d: Deny): Deny => ({ ...d, hard: true });

/**
 * The intent of a push judged BEFORE its folder is known (card prflow-push-blocks): the push has an early return (--git-dir, popd, GIT_DIR,
 * a cd alias) whose deny has scope push and so only warns while decisions.enforcePush is absent. Read from the shape alone (no git, no
 * folder): a subagent push, a literal origin or parcadei remote, a prefixed unsafe option, a force form, --repo. The target is unknown, so
 * a force form cannot be shown to be an own feature branch: it is hard. Returns the hard deny of the intent, else `fallback` unchanged.
 */
function intentDeny(p: PushShape, subagent: boolean, fallback: Deny): Deny {
  if (subagent) return hardOf(deny('subagent', SUBAGENT_WHY, 'push'));
  const r = (p.remote ?? '').toLowerCase();
  if (r === 'origin' || r.includes('parcadei')) return hardOf(deny('push-origin', PUSH_ORIGIN_WHY, 'push'));
  if (p.force || p.unsafeOpt || p.wideOpt) return hardOf(deny('push-unsafe', PUSH_UNSAFE_WHY, 'push'));
  if (outsideHeads(p)) return hardOf(deny('push-target-unresolved', PUSH_REFSPEC_WHY, 'push'));
  if (p.repoOpt) return hardOf(deny('push-target-unresolved', PUSH_REPO_OPT_WHY, 'push'));
  return fallback;
}

/**
 * Holdout scan of a CCv3 push (card prflow-push-blocks; seat conditions 3b). Runs only when both seams are present and the push is of a
 * `re/` branch, or the diff against fork/main touches an answer-key path. It reads the lines the branch ADDS (three dots: from the merge
 * base, so a merge of main adds nothing of main's), the commit messages of the range and the changed file names (an id can stand in a path).
 * Every failure is a hard deny: the id list unreadable or empty, a git read that fails, a diff over the size bound. The bound is by size
 * (files, bytes), never by a clock. The deny text and the log hold a COUNT only: no id, no title, no path.
 */
/** The most changed file names the scan reads (the names of every commit of the range, C5 read 1). */
const SCAN_MAX_FILES = 2000;
/**
 * C5 bounds (card coord-decision-gate-round3-content-scan, seat S-Q2): by size, never by a clock. The last 60 real branches on main had at
 * most 27 commits and 936,270 bytes of log text. A read over a bound is a hard deny with the bound in the text; a prefix is never scanned.
 */
const SCAN_MAX_COMMITS = 200;
const SCAN_MAX_BYTES = 8_000_000;
/** The content read gets min(SCAN_READ_MS, budget left - SCAN_RESERVE_MS); the names read min(GIT_TIMEOUT_MS, the same). */
const SCAN_READ_MS = 6000;
/** Kept back from the hook budget for the match (about 1.1 s on 10 MB) and the deny write, so a deny is written before the 10 s kill. */
const SCAN_RESERVE_MS = 1500;
/** Below this many ms for a read, the scan does not start it: it writes the clock deny instead. */
const SCAN_MIN_READ_MS = 300;
/** The start of each commit record in both reads (format %x01c5). A token or line that equals it is a commit, not a path or a diff line. */
const COMMIT_MARK = '\u0001c5';
/** Seat read 2, item 6: the full ref. A local branch or tag named fork/main would shadow the short name and empty the range. */
const FORK_MAIN = 'refs/remotes/fork/main';
const SPLIT_WAY_OUT = 'Every later push of this branch reads the same commits (the range is fork/main..head). Ways out: a new branch from fork/main that does not carry those commits, or a history rewrite with Dave\'s yes.';

/** Thrown by the budgeted git of the scan when the hook budget is gone before a read can start. */
class ScanClockError extends Error {}

/**
 * Seat read 2, item 3: EVERY git read of the scan (currentBranch, the chained path reads, rev-parse, show-ref, the logs, the tags) checks the
 * budget first and gets at most the time left, so their sum ends inside HOOK_BUDGET_MS - SCAN_RESERVE_MS. Absent scanLeft (tests): unchanged.
 */
function budgetedDeps(deps: Deps): Deps {
  if (!deps.scanLeft) return deps;
  const left = (): number => deps.scanLeft!() - SCAN_RESERVE_MS;
  return {
    ...deps,
    git: (cwd, args, opts) => {
      const ms = left();
      if (ms < SCAN_MIN_READ_MS) throw new ScanClockError('budget');
      return deps.git(cwd, args, { ...opts, timeout: Math.min(opts?.timeout ?? GIT_TIMEOUT_MS, ms) });
    },
  };
}

function scanHoldout(p: PushShape, deps: Deps, dir: string, branch: string, chained: boolean, alone: boolean): Deny | null {
  if (!deps.holdoutIds || !deps.answerKeyHits) return null;
  try {
    return scanHoldoutRead(p, budgetedDeps(deps), dir, branch, chained, alone);
  } catch (e) {
    // The budget gone, or a read that timed out: the clock text (a killed hook writes no deny).
    if (e instanceof ScanClockError || errCode(e) === 'ETIMEDOUT') return clockDeny(branch);
    // Any other throw in the scan path (a spawn error) is a hard deny: the catch path of handle() only warns in scope push.
    return hardOf(deny('holdout-scan-unavailable', `this push of ${branch} cannot be checked for holdout ids: a git read failed. Run the push again from the repo.`, 'push'));
  }
}

/**
 * The path union of a chained push: names against fork/main (three dots, HEAD), the staged names, the names changed against HEAD (a `commit -a`)
 * and the untracked names (a `git add -A` or `git add <new file>` in the chain). 'hit' = an answer-key path is in it; 'unreadable' = a git read
 * failed; 'too-large' = a list over the bound. No path is returned: the callers print a fixed text.
 */
function chainedAnswerKeyPaths(deps: Deps, dir: string): 'none' | 'hit' | 'unreadable' | 'too-large' {
  const reads: string[][] = [
    ['diff', '--name-only', '--no-renames', '-z', `${FORK_MAIN}...HEAD`],
    ['diff', '--name-only', '--no-renames', '-z', '--cached'],
    ['diff', '--name-only', '--no-renames', '-z', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const all = new Set<string>();
  for (const args of reads) {
    const r = deps.git(dir, args);
    if (r.status !== 0) return 'unreadable';
    for (const f of r.stdout.split('\0')) if (f) all.add(f);
    if (all.size > SCAN_MAX_FILES) return 'too-large';
  }
  return deps.answerKeyHits!([...all]).length > 0 ? 'hit' : 'none';
}

/** Round 3 C3 (item 15): a ref name without refs/heads/. */
const headName = (ref: string): string => ref.replace(/^refs\/heads\//, '');
/**
 * Round 3 C3 (item 15): the push sends a re/ branch when the destination OR the source is re/. A source of HEAD (or @) is the checked-out
 * branch: one more git call, only for that form. A failed read of it throws (the scan's catch: a hard deny).
 */
function sendsRe(p: PushShape, deps: Deps, dir: string, branch: string): boolean {
  if (headName(branch).startsWith('re/')) return true;
  // The push reader gives src null for HEAD (HEAD:dst, or a bare push whose branch is already the current one).
  // A bare push (no branch) already has the current branch as `branch`: no second git call.
  if (p.src === null && p.branch === null) return false;
  const src = headName(p.src ?? 'HEAD');
  if (src.startsWith('re/')) return true;
  // Seat fix 4: HEAD or @ alone, or followed by ~, ^ or @ (HEAD~0, @^0, HEAD@{0}) names a commit of the checked-out branch.
  return /^(?:HEAD|@)(?:$|[~^@])/.test(src) && currentBranch(deps, dir).startsWith('re/');
}
const RE_NOT_ALONE_WHY = 'the push output goes to a pipe or a redirect, or another step runs in the same command, so this gate does not scan this form. Run the push with no pipe and no redirect, as its own command: git push <remote> <branch>.';

/**
 * C5 change 3: the tag refs the push names (refs/tags/<x>, or a name with a local tag of that name). Such a push sends that tag, and an
 * annotated tag's message is not in the commit log.
 */
function namedTags(p: PushShape, deps: Deps, dir: string): string[] {
  const out = new Set<string>();
  for (const r of [p.src, p.branch]) {
    if (typeof r !== 'string' || r === '') continue;
    if (r.startsWith('refs/tags/')) { out.add(r); continue; }
    if (r.startsWith('refs/') || /^(?:HEAD|@)(?:$|[~^@])/.test(r)) continue;
    if (deps.git(dir, ['show-ref', '--verify', '--quiet', `refs/tags/${r}`]).status === 0) out.add(`refs/tags/${r}`);
  }
  return [...out];
}

/**
 * The tag text a scanned push can send (seat read 2, rules T1 to T3). --follow-tags and push.followTags send every annotated tag that points
 * at a commit reachable from the pushed ref, and main's commits are reachable from every branch. So:
 *   T1 an annotated tag reachable from the pushed sha (--merged <sha>): its name and its OWN message;
 *   T2 a lightweight tag: its name only (its %(contents) is a commit message, read in the range or on fork/main already);
 *   T3 a tag the push names: its target is the pushed sha, so --merged <sha> reads it by T1/T2; a force or wide form (how --tags reads):
 *      every tag by T1/T2.
 * A read that times out throws to the scan catch (the clock text).
 * A read that fails, times out or is over the bound returns a Deny.
 */
function tagText(wide: boolean, sha: string, deps: Deps, dir: string, stop: (pattern: string, why: string) => Deny): string | Deny {
  const fmt = '--format=%(refname)%00%(objecttype)%00%(contents)%00';
  const reads: string[][] = [wide ? ['for-each-ref', fmt, 'refs/tags'] : ['for-each-ref', fmt, '--merged', sha, 'refs/tags']];
  let text = '';
  for (const args of reads) {
    let t: { status: number; stdout: string };
    try {
      t = deps.git(dir, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: SCAN_MAX_BYTES + 1 });
    } catch (e) {
      if (errCode(e) === 'ENOBUFS') return stop('holdout-scan-too-large', `its local tags are over ${SCAN_MAX_BYTES} bytes. ${SPLIT_WAY_OUT}`);
      throw e;
    }
    if (t.status !== 0) return stop('holdout-scan-unavailable', 'the local tags could not be read. Run the push again from the repo.');
    const f = t.stdout.split('\0');
    // Records of three fields: name, object type, contents. Only an annotated tag ("tag") gives its contents (T1, T2).
    for (let i = 0; i + 2 < f.length; i += 3) text += `${f[i].replace(/^\n+/, '')}\n${f[i + 1] === 'tag' ? `${f[i + 2]}\n` : ''}`;
  }
  return text;
}

/** The hard deny when the hook budget is gone before a read can run: a hook killed at 10 s writes no deny (seat change 2, F6). */
const clockDeny = (branch: string): Deny => hardOf(deny('holdout-scan-unavailable', `this push of ${branch} cannot be checked: the time of the hook ran out before its reads could run. Run the push again when the machine is less busy.`, 'push'));
/** F6 (seat 15:2x): shipTap makes at most two more git reads (2 s each). Below this many ms of budget the push is denied on the clock first. */
const SHIP_RESERVE_MS = 1500;

/** The error code of a failed git read (makeGit throws spawnSync's error: ENOBUFS over maxBuffer, ETIMEDOUT on the timeout). */
const errCode = (e: unknown): string => String((e as NodeJS.ErrnoException | undefined)?.code ?? '');

/**
 * The added text of a `git log -p --cc` output: commit records, file headers and every hunk line whose prefix columns hold a +. A removed or
 * context line is not read (it is in a parent, which is in the range or on fork/main). The prefix width is the count of @ in the hunk header
 * minus one: 1 for a normal diff, the parent count for a combined diff. The message is indented one space (%w(0,1,1)), so no message line can
 * start a diff or a hunk; a hunk header counts only inside a diff.
 */
function addedText(log: string): { text: string; binary: boolean } {
  const out: string[] = [];
  let inDiff = false;
  let binary = false;
  let width = 0; // 0: not in a hunk (a commit record or a file header: read whole)
  for (const line of log.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) { inDiff = false; width = 0; out.push(line); continue; }
    if (line.startsWith('diff --')) { inDiff = true; width = 0; out.push(line); continue; }
    const at = inDiff ? /^(@{2,}) /.exec(line) : null;
    if (at) { width = at[1].length - 1; continue; }
    // --cc ignores --text: a binary file in a merge prints only this line, so its resolution cannot be read (measured on git 2.47).
    if (inDiff && width === 0 && /^Binary files (?:.* )?differ$/.test(line)) binary = true;
    if (width === 0) { out.push(line); continue; }
    // Only a line that is new against EVERY parent: a column with no + means the line equals that parent's line, which is read in its own
    // commit of the range or is on fork/main (a merge of main must not deny on main's own lines).
    if (line.slice(0, width) === '+'.repeat(width)) out.push(line);
  }
  return { text: out.join('\n'), binary };
}

function scanHoldoutRead(p: PushShape, deps: Deps, dir: string, branch: string, chainedCommit: boolean, alone: boolean): Deny | null {
  // The budget of every read here is budgetedDeps (seat read 2, item 3): a spent budget or a timeout throws to scanHoldout's clock deny.
  const isRe = sendsRe(p, deps, dir, branch);
  // `alone` is false when the command holds anything but cd, read-only git and pushes (a commit -a, an amend, a merge, a redirect):
  // such a command can change the branch before the push, so it counts as chained.
  const chained = chainedCommit || !alone;
  const stop = (pattern: string, why: string): Deny => hardOf(deny(pattern, `this push of ${branch} cannot be checked for holdout ids: ${why}`, 'push'));
  // A push chained after a commit is scanned at the head BEFORE that commit: its content is not on the branch yet. Fail closed for a re/ branch.
  if (isRe && chainedCommit) return stop('holdout-scan-unavailable', 'the same command also commits or changes the branch, so the new content cannot be read yet. Commit first, then push in a separate command.');
  // Round 3 C3 (builder A, seat Q4 option b): the same hard deny, with the real cause and its way out. No scan of a prefix (seat ruling).
  if (isRe && chained) return stop('holdout-scan-unavailable', RE_NOT_ALONE_WHY);
  // Item 4 (seat YES): a chained or not-alone push of a branch that is NOT re/ is scanned at the old head too, so its change can add or edit an
  // answer-key file the scan below never sees (`commit -am`, `git add <new file>`). Read the union of the paths and fail closed.
  if (!isRe && chained) {
    const hit = chainedAnswerKeyPaths(deps, dir);
    if (hit === 'unreadable') return stop('holdout-scan-unavailable', 'the same command also changes files, and the paths it can change could not be read. Commit first, push in a separate command.');
    if (hit === 'too-large') return stop('holdout-scan-too-large', `the same command also changes more than ${SCAN_MAX_FILES} files. Commit first, push in a separate command.`);
    if (hit === 'hit') return stop('holdout-chained-answer-key', 'the same command also changes an answer-key path, so the new content cannot be read yet. Commit first, push in a separate command.');
  }
  const ref = p.src ?? 'HEAD';
  // C5 F2: a source that starts with a dash was trusted to shipTap, which a push to main never reaches. Deny it here (git takes no such ref).
  if (ref.startsWith('-')) return stop('holdout-scan-unavailable', 'its source ref starts with a dash. Name the branch: git push <remote> <branch>.');
  const sha = deps.git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  // C5 change 3: a push that names a tag is a scanned class (its tag message and its commits). A force or wide form of a scanned push is how
  // --tags reads in CCv3: its log reads start from every local tag too (--tags), so a tagged commit outside the branch is read.
  const named = namedTags(p, deps, dir);
  const scanned = isRe || named.length > 0;
  const allTags = scanned && p.force ? ['--tags'] : [];
  if (sha.status !== 0 || sha.stdout.trim() === '') return scanned ? stop('holdout-scan-unavailable', 'its head could not be read. Run the push again from the repo.') : null;
  const head = sha.stdout.trim();
  const range = `${FORK_MAIN}..${head}`;
  // C5 read 1 (items 9b, C10): the names and the count of every commit of the range, merge resolutions too (--cc).
  let names: { status: number; stdout: string };
  try {
    names = deps.git(dir, ['log', '--cc', '--root', '--name-only', '--no-renames', '-z', '--format=%x01c5%x00%H', ...allTags, range], { timeout: GIT_TIMEOUT_MS, maxBuffer: SCAN_MAX_BYTES + 1 });
  } catch (e) {
    if (errCode(e) === 'ENOBUFS') return stop('holdout-scan-too-large', `its commit list is over ${SCAN_MAX_BYTES} bytes. ${SPLIT_WAY_OUT}`);
    throw e;
  }
  if (names.status !== 0) return stop('holdout-scan-unavailable', 'the commits against fork/main could not be read. Run git fetch fork main in the repo, then push again.');
  const tokens = names.stdout.split('\0').map((t) => t.replace(/^\n+/, ''));
  const commits = tokens.filter((t) => t === COMMIT_MARK).length;
  const files = tokens.filter((t, i) => t !== '' && t !== COMMIT_MARK && tokens[i - 1] !== COMMIT_MARK);
  // The trigger first: a push outside both scanned classes is not bounded here (main let a long feature branch pass; advisor item 2).
  if (!scanned && deps.answerKeyHits!(files).length === 0) return null;
  if (commits > SCAN_MAX_COMMITS) return stop('holdout-scan-too-large', `it sends ${commits} commits, over the bound of ${SCAN_MAX_COMMITS}. ${SPLIT_WAY_OUT}`);
  if (new Set(files).size > SCAN_MAX_FILES) return stop('holdout-scan-too-large', `it changes ${new Set(files).size} files, over the bound of ${SCAN_MAX_FILES}. ${SPLIT_WAY_OUT}`);
  let ids: string[];
  try { ids = deps.holdoutIds!(dir); } catch { return stop('holdout-scan-unavailable', 'the holdout id list could not be read, so the scan cannot run.'); }
  if (!Array.isArray(ids) || ids.length === 0) return stop('holdout-scan-unavailable', 'the holdout id list is empty, so the scan cannot run.');
  // C5 read 2 (items 9, 12, F1, binary): every added line of every commit, with its message. --text: a binary file is read, not named.
  // --no-textconv, --no-ext-diff: no repo or user config changes what git prints.
  let log: { status: number; stdout: string };
  try {
    // Seat read 2, item 2: --root (log.showRoot=false hides the root commit of an orphan branch), --encoding=UTF-8 (i18n.logOutputEncoding).
    log = deps.git(dir, ['log', '-p', '--cc', '--root', '--encoding=UTF-8', '--text', '--no-textconv', '--no-ext-diff', '--unified=0', '--no-color', '--no-renames', '--format=%x01c5 %H%n%w(0,1,1)%B', ...allTags, range], { timeout: SCAN_READ_MS, maxBuffer: SCAN_MAX_BYTES + 1 });
  } catch (e) {
    if (errCode(e) === 'ENOBUFS') return stop('holdout-scan-too-large', `its commit content is over ${SCAN_MAX_BYTES} bytes. ${SPLIT_WAY_OUT}`);
    throw e;
  }
  if (log.status !== 0) return stop('holdout-scan-unavailable', 'the commit content could not be read. Run the push again from the repo.');
  // C5 change 3: a scanned push can carry annotated tags (--follow-tags, push.followTags, a tag refspec): read the local tag names and messages.
  // CLI finding at 8263b158 (seat ruling 18:48): every push that reaches this line is triggered (line `!scanned && ... return null` above),
  // the answer-key trigger of a push that is not re/ included, so the tag text is read for each one.
  const tags = tagText(p.force, head, deps, dir, stop);
  if (typeof tags !== 'string') return tags;
  const added = addedText(log.stdout);
  if (added.binary) return stop('holdout-scan-unavailable', `it sends a binary file that git prints only as "Binary files differ" (a merge resolution), so its content cannot be read. ${SPLIT_WAY_OUT}`);
  // Seat read 2, item 1: a UTF-16 file prints a NUL between characters under --text. Count the text and the text without NUL (an id counts once).
  // PR 612 review (major): a tag name the push names leaves too, with or without a local tag of that name (tagText reads local tags only).
  const all = `${added.text}\n${files.join('\n')}\n${tags}\n${named.join('\n')}`;
  const count = countIdsIn(`${all}\n${all.replace(/\0/g, '')}`, ids);
  if (count === 0) return null;
  return hardOf(deny('holdout-id', `this push of ${branch} carries ${count} holdout id${count === 1 ? '' : 's'} in the added lines, commit messages, file names or tag messages of what it sends (an older commit of the branch counts too). Remove them from every commit and local tag. ${SPLIT_WAY_OUT} Which ones stays with the seat: this text names a count only.`, 'push'));
}

/**
 * Push: a ship decision ("Commit and push", or "Push only" when no commit is chained) for the branch, bound to the tree being pushed.
 * The head is not compared: the tap was made before the commit, so its head is the parent of the commit now at HEAD. The tree is the
 * same before and after the commit. "Push only" is bound to HEAD's tree (in a covered folder also to its head: seat review 1, item 3,
 * shipTap pushOnlyHead; the CCv3 rule here is unchanged). It counts only when `alone` is true (pushesAlone: the command holds
 * nothing but cd, read-only git and pushes), so a command that can stage or commit before the push never takes it, whatever shape it has.
 * `chained`: the same command commits the staged tree first (commitPrecedesPush), so the tree pushed is `git write-tree`, not HEAD's.
 * Order: unreadable target, not CCv3, origin, other remote, subagent, force or delete form, branch, main, tree, tap.
 * A force form is denied before the main check: a force push to the fork's main rewrites the branch every PR lands on.
 */
function judgePush(shape: Shape, deps: Deps, dir: string, ctx: PushCtx): Decision {
  const { subagent, chained, alone } = ctx;
  const p = shape.push!;
  const d = (pattern: string, why: string): Deny => deny(pattern, why, 'push');
  if (p.moved) {
    const what = '--git-dir or --work-tree moves the repo, so the checkout is unknown';
    // Ruling B (F3): the repo the value names decides first (a covered one gives app-push); a CCv3 or unknown one keeps the base text.
    // A relative value is resolved from the judged folder (its cd path and -C): advisor review of fix round 5.
    const app = firstCovered(deps, moveTargets(ctx.text, dir, ctx.shell, deps.home)) ?? coveredAmong(deps, [dir]);
    if (app !== null) return deny('push-target-unresolved', appPushUnresolvedWhy(app, what), 'app-push');
    // The target is unknown (CCv3 or a folder nobody covers): the intent decides before the folder (card prflow-push-blocks).
    // Round 3 C3 (item 10): the fallback is hard (a re/ push would go out unscanned), except in a resolved unregistered folder.
    return intentDeny(p, subagent, hardUnlessUnregistered(d('push-target-unresolved', pushUnresolvedWhy(what)), ctx.unregistered));
  }
  if (!isCcv3Checkout(deps, dir)) return judgeAppPushAt(shape, deps, dir, subagent, chained, alone, ctx.flow, ctx);
  // --repo names the push target, so the remote this gate reads is not where the push goes: a hard deny, before any remote is read.
  if (p.repoOpt) return hardOf(subagent ? d('subagent', SUBAGENT_WHY) : d('push-target-unresolved', PUSH_REPO_OPT_WHY));
  let remote = p.remote;
  if (remote === null) {
    const up = deps.git(dir, ['rev-parse', '--abbrev-ref', '@{push}']);
    remote = up.status === 0 && up.stdout.trim() !== '' ? up.stdout.trim().split('/')[0] : 'fork';
  }
  let kind = remoteKind(remote);
  if (kind === null) { // another name for a URL we gate: ask git what the remote points at
    const u = deps.git(dir, ['remote', 'get-url', remote]);
    if (u.status === 0) kind = remoteKind(u.stdout.trim());
  }
  // Hard denies (card prflow-push-blocks): they hold whatever decisions.enforcePush says. A push to origin, a subagent push, a wide or
  // prefixed unsafe option, --repo, and a force push to main or to a branch that cannot be named. A force push to an OWN feature branch stays a
  // soft push-unsafe: the destructive-command-guard asks Dave there (seat ruling 2026-11-14).
  if (kind === 'origin') return hardOf(d('push-origin', PUSH_ORIGIN_WHY));
  if (kind === null) return ALLOW;
  // A subagent never has a tap (D3): any push to the fork is denied, main included. Its pushes elsewhere are not our business.
  if (subagent) return hardOf(d('subagent', SUBAGENT_WHY));
  if (p.wideOpt || (p.unsafeOpt && !p.force)) return hardOf(d('push-unsafe', PUSH_UNSAFE_WHY));
  if (outsideHeads(p)) return hardOf(d('push-target-unresolved', PUSH_REFSPEC_WHY));
  // Round 3 C4 (item 16): a step the gate does not model can move HEAD or the branch first; the head and tree read below would be old.
  if (!ctx.modelled) return hardOf(d('push-state-unknown', PUSH_STATE_WHY));
  const branch = p.branch ?? currentBranch(deps, dir);
  if (p.force && (branch === 'main' || branch === '')) return hardOf(d('push-unsafe', PUSH_UNSAFE_WHY));
  // The holdout scan runs BEFORE the force return: a force push of a re/ branch must not skip it (the guard's yes would send it out unscanned).
  // It also runs for main: a push of main whose diff touches an answer-key path is scanned (CLI round 1, item a).
  if (branch !== '') {
    // `alone` is false when the command holds anything but cd, read-only git and pushes (a commit -a, an amend, a merge, a redirect):
    // such a command can change the branch before the push, so for a re/ branch it counts as chained.
    const scanned = scanHoldout(p, deps, dir, branch, chained, alone);
    if (scanned !== null) return scanned;
  }
  if (p.force) return d('push-unsafe', PUSH_UNSAFE_WHY);
  if (branch === '') return d('push-target-unresolved', pushUnresolvedWhy('the branch of this push cannot be named (detached HEAD?)'));
  if (branch === 'main') return ALLOW;
  // F6 (card coord-decision-gate-round3-content-scan, seat word): the reads of shipTap must end before the 10 s kill, or its deny is never
  // written. Budget at most 7000 ms from the start; shipTap's two reads take at most 4000 ms more.
  if (deps.scanLeft && deps.scanLeft() < SHIP_RESERVE_MS) return clockDeny(branch);
  const texts: ShipTexts = {
    notRef: (ref) => pushUnresolvedWhy(`${ref} is not a ref`),
    tree: (what) => `cannot read the tree of ${what} in ${dir}, so its ship decision cannot be found. Run the command again from the repo.`,
    ship: () => pushWhy(branch),
  };
  return shipTap({ p, deps, dir, chained, alone, key: decisionKey({ branch }), scope: 'push', texts, commitDirs: ctx.commitDirs });
}

function currentBranch(deps: Deps, dir: string): string {
  const r = deps.git(dir, ['branch', '--show-current']);
  if (r.status !== 0) throw new Error('git branch --show-current failed');
  return r.stdout.trim();
}

interface ShipTexts { notRef: (ref: string) => string; tree: (what: string) => string; ship: () => string }
/**
 * `pushOnlyHead` (seat review 1, item 3; the app path only, judgeAppPush): a "Push only" tap counts only when its head (the commit app-ask
 * stored) equals the commit of the pushed ref. "Commit and push" keeps the tree rule: its chained commit moves the head after the tap.
 * The CCv3 call never sets it, so the CCv3 shipTap and its git calls are unchanged (G4).
 */
interface ShipCheck { p: PushShape; deps: Deps; dir: string; chained: boolean; alone: boolean; key: string; scope: Scope; texts: ShipTexts; pushOnlyHead?: true; commitDirs?: string[] }

/** The ship tap of a push for `key`, bound to the tree being pushed (judgePush). Shared by CCv3 and the app folders; only the key, scope and texts differ. */
function shipTap({ p, deps, dir, chained, alone, key, scope, texts, pushOnlyHead, commitDirs }: ShipCheck): Decision {
  const ref = p.src ?? 'HEAD';
  if (ref.startsWith('-')) return deny('push-target-unresolved', texts.notRef(ref), scope);
  // Round 3 C4 (R3-b): after a chained commit, a push with its own -C reads the index only when it is proven the same checkout.
  if (chained && p.dir !== null && !sameCheckout(deps, commitDirs ?? [], dir)) return deny('push-tree-unresolved', PUSH_CHECKOUT_WHY, scope);
  // A plain commit earlier in the same command moves HEAD to the staged tree before this push runs: read the index. The commit lands on the
  // checked-out branch in this directory, so the push must send HEAD or that branch, with no -C of its own. Anything else keeps the HEAD rule.
  const viaIndex = chained && (p.src === null || deps.git(dir, ['branch', '--show-current']).stdout.trim() === p.src);
  const r = viaIndex ? deps.git(dir, ['write-tree']) : deps.git(dir, ['rev-parse', `${ref}^{tree}`]);
  if (r.status !== 0) return deny('push-tree-unresolved', texts.tree(viaIndex ? 'the index (git write-tree)' : ref), scope);
  const tree = r.stdout.trim();
  // The head of the pushed ref, read at most once and only when a Push only row matched everything else (item 3). A failed read is no match.
  let refHead: string | null | undefined;
  const headOf = (): string | null => {
    if (refHead === undefined) {
      const h = deps.git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
      refHead = h.status === 0 && h.stdout.trim() !== '' ? h.stdout.trim().toLowerCase() : null;
    }
    return refHead;
  };
  const pushOnly = (head: string): boolean => !pushOnlyHead || (headOf() !== null && head.toLowerCase() === headOf());
  const ok = decisionRows(deps.env).some((row) => row.step === 'ship' && row.key === key && row.tree !== null && row.tree === tree
    && (isShipLabel(row.label) || (!viaIndex && alone && isPushOnlyLabel(row.label) && pushOnly(row.head))));
  return ok ? ALLOW : deny('ship', texts.ship(), scope);
}

/** A push in a folder outside CCv3: judged only when covered. A git throw from here on is judged with scope app-push (AppScopeError). */
function judgeAppPushAt(shape: Shape, deps: Deps, dir: string, subagent: boolean, chained: boolean, alone: boolean, flow: boolean, ctx?: PushCtx): Decision {
  const place = appPlace(deps, dir);
  if (!place.covered) return passOf(place, dir, 'app-push');
  try {
    return inApp(deps, () => judgeAppPush(shape, deps, dir, place, subagent, chained, alone, flow, ctx));
  } catch (err) {
    throw new AppScopeError(err);
  }
}

/** Dave 11-13: main and master are a default branch of every push target. */
const FIXED_DEFAULTS: ReadonlySet<string> = new Set(['main', 'master']);
/** The branch a push destination updates: git matches heads/<b> and refs/heads/<b> as the branch <b> on the remote. */
const destBranch = (dest: string): string => dest.replace(/^refs\//, '').replace(/^heads\//, '');

/**
 * The branch refs/remotes/<remote>/HEAD names (git symbolic-ref --quiet --short, one start, through the per-call memo and the deadline).
 * --short prints <remote>/<b>, or remotes/<remote>/<b> when a local branch has that name. undefined: no remote HEAD (a non-zero status or
 * an empty line). null: an output that names no branch of this remote, so the caller fails closed.
 */
function remoteHeadOf(deps: Deps, dir: string, remote: string): string | null | undefined {
  const r = deps.git(dir, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  const text = r.status === 0 ? r.stdout.trim() : '';
  if (text === '') return undefined;
  const prefix = `${remote}/`;
  const hit = [text, text.replace(/^remotes\//, ''), text.replace(/^refs\/remotes\//, '')].find((s) => s.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

/**
 * Why a covered push needs the tap (fixer F). `default`: it updates a default branch. `unsure`: the gate cannot be sure it leaves every
 * default branch alone (a push off the strict allow-list, push config that widens it, a local tag, a split remote).
 * `no-head`: no readable remote HEAD; `remote` is the configured remote whose HEAD is missing.
 */
type PushRisk = { kind: 'default' } | { kind: 'unsure' } | { kind: 'no-head'; remote: string };
interface PushTarget { key: string; remote: string; branch: string; configured: boolean }
interface KeyId { entryKey: string | null; github: string | null }
const DEFAULT_RISK: PushRisk = { kind: 'default' };
const UNSURE_RISK: PushRisk = { kind: 'unsure' };

/**
 * Null only when the push is on the strict allow-list (fix round 3, fixer H) and surely leaves every default branch of its target alone
 * (Dave 11-13, fail closed): the text is plain (pushShapesFrom), the push config of the repo widens nothing, the remote is a configured
 * remote (git remote lists it), the destination is a plain branch word that is not main or master and not a local tag, and a readable
 * remote HEAD of the target names another branch.
 */
function pushRisk(deps: Deps, dir: string, p: PushShape, k: PushTarget, id: KeyId, config: PushConfig): PushRisk | null {
  const dest = destBranch(k.branch);
  // Fix round 5 (F6): the default-branch compare is in lower case (Main, MASTER, Develop are the default branch to this gate).
  if (FIXED_DEFAULTS.has(dest.toLowerCase())) return DEFAULT_RISK;
  if (!p.plain || config.kind !== 'none' || !k.configured || !strictBranch(dest) || !remoteNamesOf(deps, dir).includes(k.remote)) return UNSURE_RISK;
  if (deps.git(dir, ['show-ref', '--verify', '--quiet', `refs/tags/${dest}`]).status !== 1) return UNSURE_RISK;
  return headRisk(deps, dir, k, dest, id);
}

/** The remote names of the checkout (git remote), one start per call through the memo. */
const remoteNamesOf = (deps: Deps, dir: string): string[] => deps.git(dir, ['remote']).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/**
 * The remote HEAD test of a configured remote (pushRisk lets no URL target reach it, fix round 3). Its HEAD tells the default branch
 * only when the remote fetches from the repo it pushes to (else the tap path). A missing HEAD fails closed (no-head); a match is a
 * default branch.
 */
function headRisk(deps: Deps, dir: string, k: PushTarget, dest: string, id: KeyId): PushRisk | null {
  const url = fetchUrlOf(deps, dir, k.remote);
  if (url === null || keyRepo({ url, ...id }) !== k.key) return UNSURE_RISK;
  const head = remoteHeadOf(deps, dir, k.remote);
  if (head === undefined || head === null) return { kind: 'no-head', remote: k.remote };
  return head.toLowerCase() === dest.toLowerCase() ? DEFAULT_RISK : null;
}

/** The fetch URL of a remote (git remote get-url, first line), or null. */
function fetchUrlOf(deps: Deps, dir: string, remote: string): string | null {
  const r = deps.git(dir, ['remote', 'get-url', remote]);
  const url = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
  return url === '' ? null : url;
}

/**
 * git config --get-regexp of the push keys (fix round 3, fixer H). git prints the section and the variable lowercased (push.followtags),
 * so the pattern and the compare use lower case. The remote name is matched in code, never put into the pattern.
 */
const PUSH_CONFIG_RE = '^(push\\.(default|followtags|recursesubmodules)|submodule\\.recurse|remote\\..*\\.(push|mirror))$';
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', 'off', '0']);
/**
 * What the push config does to a push to `remote` (fix round 4, fixer K, critic major 1): nothing; `widens` (the tap path: the push
 * is off the allow-list, but git still writes only what the refspec names); `wider` (a hard deny: git writes more than the branch the
 * tap would name); `unsafe` (a mirror or force push, push-unsafe). `key` names the config key of a wider or unsafe answer.
 */
interface PushConfig { kind: 'none' | 'widens' | 'wider' | 'unsafe'; key: string }
const RANK = { none: 0, widens: 1, wider: 2, unsafe: 3 } as const;

/**
 * The push config of the repo for a push to `remote`, read for every covered push. unsafe: remote.<r>.mirror with any value but a false
 * word (git reads a valueless key as true), or a remote.<r>.push value that starts with + (a force refspec). wider: any other
 * remote.<r>.push for a push with no colon refspec (git maps the source through it: feat can write main); push.default=matching for a
 * bare push (every matching branch); push.recurseSubmodules (not a false word or check) or submodule.recurse on, unless the command says
 * --no-recurse-submodules (it pushes other repos); push.followTags on, unless --no-follow-tags (it pushes annotated tags). widens: a
 * remote.<r>.push with a colon refspec (git does not use it then). Exit 1 with no output is "none set"; any other failure widens.
 */
function pushConfigOf(deps: Deps, dir: string, remote: string, p: PushShape): PushConfig {
  const r = deps.git(dir, ['config', '--get-regexp', PUSH_CONFIG_RE]);
  if (r.status === 1 && r.stdout.trim() === '') return { kind: 'none', key: '' };
  if (r.status !== 0) return { kind: 'widens', key: '' };
  let found: PushConfig = { kind: 'none', key: '' };
  for (const line of r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line.trim() : line.slice(0, sp);
    const raw = sp < 0 ? '' : line.slice(sp + 1).trim();
    const kind = configKind(key, raw, remote, p);
    if (RANK[kind] > RANK[found.kind]) found = { kind, key };
  }
  return found;
}
function configKind(key: string, raw: string, remote: string, p: PushShape): PushConfig['kind'] {
  const value = raw.toLowerCase();
  const on = !FALSE_WORDS.has(value);
  if (key === `remote.${remote}.mirror`) return on ? 'unsafe' : 'none';
  if (key === `remote.${remote}.push`) return raw.startsWith('+') ? 'unsafe' : p.oneSide ? 'wider' : 'widens';
  if (key === 'push.default') return value === 'matching' && p.bare ? 'wider' : 'none';
  if (key === 'push.recursesubmodules') return on && value !== 'check' && !p.noRecurse ? 'wider' : 'none';
  if (key === 'submodule.recurse') return on && !p.noRecurse ? 'wider' : 'none';
  if (key === 'push.followtags') return on && !p.noFollowTags ? 'wider' : 'none';
  return 'none';
}

/**
 * Push in a covered folder (R5b, R6): every remote gated, none banned. Order: subagent, force, --repo, remote, branch, push config
 * (mirror or + refspec: push-unsafe), the strict allow-list and default branch (pushRisk), tree, tap.
 * The key is repo-identity.mjs pushKey (the ONE rule app-ask.mjs runs too): the push URLs of the remote (two repos: denied), the
 * destination branch (a bare push: the branch of @{push} when it goes to that remote). Dave 11-13 (replaces D2 a for the push): a
 * push that surely leaves every default branch of the target alone (pushRisk null) passes with no tree read and no tap. Every deny
 * before it stays. The offer names --remote, --branch and --src (F3). A source @ is the current branch for the index rule (viaIndex).
 */
function judgeAppPush(shape: Shape, deps: Deps, dir: string, place: Place, subagent: boolean, chained: boolean, alone: boolean, flow: boolean, ctx?: PushCtx): Decision {
  const p = shape.push!;
  const d = (pattern: string, why: string): Deny => deny(pattern, why, 'app-push');
  if (subagent) return d('subagent', appSubagentWhy(dir));
  // Fix round 4 (critic major 3): a prefix of an unsafe long option (--mirr, --del, --al) is that option.
  if (p.force || p.unsafeOpt) return d('push-unsafe', appUnsafeWhy(dir));
  // Fix round 3 (critic major 5): --repo sends the push to a target the remote positional does not name, so no key fits it, tap or not.
  if (p.repoOpt) return d('push-target-unresolved', appRepoOptWhy(dir));
  // Fix round 4: a short bundle with o hides the words after it; a command option or -c key makes git write more than the tap names.
  if (p.oBundle) return d('push-target-unresolved', appBundleWhy(dir));
  if (p.widerOpt !== null) return d('push-target-unresolved', appWiderOptWhy(dir, p.widerOpt));
  // git reads @ as HEAD: `git push up @` updates the current branch.
  const named = p.branch === '@' ? null : p.branch;
  const branch = named ?? (p.bare ? null : currentBranch(deps, dir));
  const k = pushKey(gitIn(deps, dir), { remote: p.remote, branch, entryKey: place.entryKey, github: place.github });
  if (!k.ok && k.why === 'multi-pushurl') return d('push-urls', appPushUrlsWhy(dir, k.remote ?? '', k.keys ?? []));
  if (!k.ok && k.why === 'no-branch') return d('push-target-unresolved', appPushUnresolvedWhy(dir, 'the branch of this push cannot be named (detached HEAD?)'));
  if (!k.ok) return d('push-remote-unresolved', appNameRemoteWhy(deps, dir));
  if (p.src?.startsWith('-')) return d('push-target-unresolved', appPushUnresolvedWhy(dir, `${p.src} is not a ref`));
  // Fix round 3 (critic major 4): a mirror or + push config is push-unsafe like the flag form, before the allow and before the tap.
  const config = pushConfigOf(deps, dir, k.remote, p);
  if (config.kind === 'unsafe') return d('push-unsafe', appUnsafeConfigWhy(dir, k.remote, config.key));
  // Fix round 4 (critic major 1): config that makes git write more than the branch the tap names is a hard deny, never the tap path.
  if (config.kind === 'wider') return d('push-target-unresolved', appWiderConfigWhy(dir, config.key));
  const risk = pushRisk(deps, dir, p, k, { entryKey: place.entryKey, github: place.github }, config);
  if (risk === null) return ALLOW;
  // A source @ is offered as HEAD: git and app-ask read both as the current branch, and PowerShell reads a bare @ as an operator (fixer G).
  const offer: Offer = { sub: 'push', remote: k.remote, branch: k.branch, src: p.src === null || p.src === '@' ? 'HEAD' : p.src };
  const texts: ShipTexts = {
    notRef: (ref) => appPushUnresolvedWhy(dir, `${ref} is not a ref`),
    tree: (what) => appTreeWhy(dir, what),
    // Seat ruling a: no Push only tap counts for a push that is not alone and has no commit before it, so the text names the way out.
    // The Commit and push flow (git add, git commit, then the push: flow) keeps the ship text: its tap is the way out.
    ship: () => (alone || chained || flow ? appPushWhy(deps, dir, k.key, k.branch, offer, risk) : appNotAloneWhy(deps, dir, offer)),
  };
  // git reads a source @ as HEAD: a commit chained before `git push up @` moves the current branch, so the index rule applies (item 5).
  const q: PushShape = p.src === '@' ? { ...p, src: null } : p;
  // Round 3 C4 (Dave 2026-11-15, "Strict here, soft in apps"): a step the gate does not model can change the tree first. No tap clears it,
  // but it is a tap-path deny, so decisions.enforceAppPush false still softens it (Dave 11-13, R6-V3: never a hard deny in an app folder).
  if (ctx !== undefined && !ctx.modelled) return { ...d('push-state-unknown', `${PUSH_STATE_WHY} (folder ${at(dir)})`), tapPath: true as const };
  const r = shipTap({ p: q, deps, dir, chained, alone, key: decisionKey({ repo: k.key, branch: k.branch }), scope: 'app-push', texts, pushOnlyHead: true, commitDirs: ctx?.commitDirs });
  // Dave 11-13: this is the tap path, the only app-push deny that decisions.enforceAppPush false softens. Every deny above stays hard.
  return r.action === 'deny' ? { ...r, tapPath: true as const } : r;
}

// The environment can point git at another repo than the folder: GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR. The flag forms (--git-dir, --work-tree) are p.moved. The name is
// read in the quote-masked text (a quoted mention such as echo "the GIT_DIR variable" is text) and as `NAME=` in the raw text (env "GIT_DIR=x" is a real assignment).
// A cd alias (alias go=cd, Set-Alias go Set-Location, sal, nal, New-Alias) runs a cd the text does not show: the definition is read in the text with its quotes deleted.
// Neither names a folder, so the shape is denied in any checkout (fail closed). An unquoted read of the name (echo $GIT_DIR) over-denies: pinned by tests.
const MOVE_ENV_MASKED = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
// The raw text adds one thing the mask hides: a QUOTED assignment given to env or export, or at a command position (env "GIT_DIR=x" git push). A quoted GIT_DIR= in an argument is text.
const MOVE_ENV_RAW = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
const CD_ALIAS = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
const MOVED_WHY = 'GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.';
function movesRepo(text: string): boolean {
  return MOVE_ENV_RAW.test(text) || (['Bash', 'PowerShell'] as const).some((tool) => MOVE_ENV_MASKED.test(maskQuoted(text, tool))) || CD_ALIAS.test(squashQuotes(text));
}

/** Every deny of a command. All shapes are judged (no early return), so each deny keeps its scope and decide() applies the flag of that scope. */
// Item 18 (round 3): `denies` is the caller's sink. Each deny goes in as it is found, so a later throw does not lose it (handle() reads it).
function judgeCommand(input: HookInput, deps: Deps, notes: Set<string>, denies: Deny[] = []): Deny[] {
  const cmd = readCommand(input);
  if (cmd.kind !== 'command' || cmd.text === '') return denies;
  const cwd = input.cwd || process.cwd();
  // Reviewer-2 item 4: the store write denies first, and the shapes are judged on (a force push beside it is not lost). The raw text:
  // a heredoc body is how a store write is spelled.
  if (storeWriteCall(input, deps)) denies.push(deny('store-write', STORE_WHY));
  const shapes = shapesOf(cmd.text, cmd.tool);
  // A subagent never has a tap: any create, land or merge is denied at once. A push is judged (the checkout and the remote decide), see judgePush.
  const shell = shellOf(input);
  if (input.agent_id && shapes.some((s) => s.kind !== 'push')) denies.push(subagentDeny(shapes, deps, cwd, shell));
  const pushes = shapes.filter((s) => s.kind === 'push');
  const rest = input.agent_id ? [] : shapes.filter((s) => s.kind !== 'push');
  const add = (d: Deny): void => { if (!denies.some((o) => o.pattern === d.pattern && o.reason === d.reason && o.scope === d.scope && o.tapPath === d.tapPath)) denies.push(d); };
  if (pushes.length > 0 || rest.length > 0) {
    const named = namedRepo(cmd.text, deps.env);
    // Round 3 C4: the chained commit is read up to the end of the last push (a pipe after the push does not undo the index rule).
    const prefix = pushes.length > 0 ? pushPrefix(cmd.text, shell) : null;
    const chained = pushes.length > 0 && (commitPrecedesPush(cmd.text, shell) || (prefix !== null && commitPrecedesPush(prefix.prefix, shell)));
    const alone = pushes.length > 0 && pushesAlone(cmd.text, shell);
    const modelled = pushes.length === 0 || stateModelled(cmd.text, shell);
    const moved = movesRepo(cmd.text);
    // Round 3 C3 (item 10): files only, no git; false when a push folder is CCv3, live, unplaceable or holds a variable.
    // Read only for a push that moves the repo: a CCv3 push reads no registry (C5 of the app-repos tests).
    const unregistered = (moved || pushes.some((s) => s.push!.moved)) && pushFoldersUnregistered(input, deps);
    for (const s of [...rest, ...pushes]) {
      // The land script reads no folder, so GIT_DIR and an alias never block it.
      if (moved && s.kind !== 'land') {
        denies.push(movedDeny(s, deps, cwd, shell, cmd.text, Boolean(input.agent_id), unregistered));
        continue;
      }
      const found = s.kind === 'push' ? judgePushAt(s, deps, cwd, shell, { subagent: Boolean(input.agent_id), chained, alone, flow: pushes.length > 0 && shipFlow(cmd.text, shell), text: cmd.text, shell, modelled, unregistered }) : judgeAt(s, deps, cwd, shell, named);
      for (const d of found) {
        if (d.action === 'deny') add(d);
        else if (d.notice) notes.add(d.notice);
      }
    }
  }
  // Fix round 5 (ruling A): a push word that no shape reads, or a force spelling anywhere, in a covered folder. It comes after the shape
  // denies (their texts are more precise) and also runs when the text has no shape. A CCv3 or uncovered folder gets nothing (G4).
  for (const d of rawPushDenies(cmd.text, cmd.tool, deps, cwd, shell, Boolean(input.agent_id))) add(d);
  for (const d of hiddenGhDenies(cmd.text, cmd.tool, deps, cwd, shell)) add(d);
  for (const d of ghFlagFirstDenies(cmd.text, cmd.tool, deps, cwd, shell)) add(d);
  return denies;
}
/**
 * PR 566 review (CodeRabbit, decision-gate.ts:2514): the subagent deny of a create, land or merge. When a folder on its path is a covered
 * app folder (coveredAmong: none is CCv3), decisions.enforce is read from the home copy only (homeFlags), as for every app create or merge.
 * Otherwise the CCv3 lookup is unchanged.
 */
function subagentDeny(shapes: Shape[], deps: Deps, cwd: string, shell: 'bash' | 'pwsh'): Deny {
  const base = deny('subagent', SUBAGENT_WHY);
  const covered = shapes.some((s) => s.kind !== 'push' && coveredAmong(deps, (s.at ? dirsAfter(cwd, s.at.cds, shell, s.at.loose) : [cwd]).filter((d) => !isUnexpanded(d))) !== null);
  return covered ? { ...base, homeFlags: true } : base;
}

/** The shell text of the call (before any blank) writes the decision store. Never throws: the catch reads it too. */
function storeWriteCall(input: HookInput, deps: Deps): boolean {
  try {
    const cmd = readShellCommand(input);
    return cmd.kind === 'command' && cmd.text !== '' && writesStoreText(cmd.text, deps);
  } catch {
    return false;
  }
}

/**
 * The GIT_DIR or cd-alias deny: the app text and scope when a move target is covered (ruling B: judged by the rule of the repo it names),
 * or when the cwd or a known folder is covered (and none is CCv3), else today's. A target that is a CCv3 checkout or names no folder
 * keeps the base path and text.
 */
function movedDeny(s: Shape, deps: Deps, cwd: string, shell: 'bash' | 'pwsh', text: string, subagent = false, unregistered = false): Deny {
  const dirs = s.kind === 'push' ? pushDirsOf(s.push!, cwd, shell) : dirsAfter(cwd, s.at!.cds, shell, s.at!.loose);
  // Ruling B names the push: only a push reads the move targets, each resolved from every folder of its path (a cd before it moves the
  // shell first). A create or merge keeps the cwd rule.
  const targets = s.kind === 'push' ? [...new Set([cwd, ...dirs].flatMap((d) => (isUnexpanded(d) ? [] : moveTargets(text, d, shell, deps.home))))] : [];
  const dir = firstCovered(deps, targets) ?? coveredAmong(deps, [cwd, ...dirs].filter((d) => !isUnexpanded(d)));
  if (s.kind === 'push') {
    // Round 3 C3 (item 10): hard, except in a resolved unregistered folder (R18-C3).
    return dir === null ? intentDeny(s.push!, subagent, hardUnlessUnregistered(deny('push-target-unresolved', pushUnresolvedWhy(MOVED_WHY), 'push'), unregistered)) : deny('push-target-unresolved', MOVED_WHY + inAppFolder(dir), 'app-push');
  }
  return dir === null ? deny('repo-moved', MOVED_WHY) : { ...deny('repo-moved', MOVED_WHY + inAppFolder(dir)), homeFlags: true };
}

function judgeWrite(input: HookInput, deps: Deps): Deny[] {
  const args = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const hit = PATH_FIELDS.some((f) => typeof args[f] === 'string' && isStorePath(args[f] as string, deps, cwd));
  return hit ? [deny('store-write', STORE_WHY)] : [];
}

/** The raw judgment, as if enforcing: every deny, each with its scope, put in `sink` as found. May throw (git): `sink` keeps what came before. */
function judge(input: HookInput, deps: Deps, notes: Set<string>, sink: Deny[]): Deny[] {
  const tool = input.tool_name || input.tool || '';
  if (WRITE_TOOLS.has(tool)) { sink.push(...judgeWrite(input, deps)); return sink; }
  return COMMAND_TOOLS.has(tool) ? judgeCommand(input, deps, notes, sink) : sink;
}

/**
 * Pure given its deps. A deny whose flag is on (decisions.enforce for most shapes, decisions.enforcePush for a push, app-push unless
 * decisions.enforceAppPush is false) is returned as a deny, and so is an app-push deny off the tap path whatever its flag says
 * (hardAppDeny, Dave 11-13). Other denies become an allow with `warn`. With no deny, a missing registry named by LANE_REGISTRY_PATH,
 * seen in a folder outside CCv3, is an allow with `notice` (S5; a corrupt one is the registry-corrupt deny: seat review 1, item 4).
 */
export function decide(input: HookInput, deps: Deps, found: Deny[] = []): Decision {
  const notes = new Set<string>();
  const call = perCall(deps);
  CWDS.set(call, input.cwd || process.cwd());
  const denies = judge(input, call, notes, found);
  const notice = notes.size === 0 ? {} : { notice: [...notes][0] };
  if (denies.length === 0) return notes.size === 0 ? ALLOW : { action: 'allow', ...notice };
  const cwd = input.cwd || process.cwd();
  const live = denies.find((d) => hardAppDeny(d) || enforcingScope(d.scope, deps, cwd, d.homeFlags));
  if (live) {
    const { tapPath: _tap, homeFlags: _home, hard: _hard, ...shown } = live;
    return { ...shown, ...notice };
  }
  return { action: 'allow', warn: `${denies[0].pattern}: ${denies[0].reason}`, scope: denies[0].scope, ...notice };
}
/**
 * Dave 11-13 ("Hard denies always deny"): an app-push deny off the tap path (force in any spelling, a subagent push, mirror or + push
 * config, config or an option that widens the push, --repo, a push no shape reads, and every other app-push deny but shipTap's) denies
 * whatever decisions.enforceAppPush says. With the flag not false every app-push deny denies anyway, so the result is the same there.
 */
const hardAppDeny = (d: Deny): boolean => d.hard === true || (d.scope === 'app-push' && d.tapPath !== true);

/**
 * The Deps of one call (item 5): every git answer is kept by folder and arguments, so isCcv3Checkout, the coverage rev-parse and the
 * rest run once per folder in a call. A throw is kept too. The hook reads only; nothing in one call changes what git answers.
 * A new object per call, so appPlace's memo (PLACES) is per call too.
 */
function perCall(deps: Deps): Deps {
  const seen = new Map<string, { ok: ReturnType<Deps['git']> } | { err: unknown }>();
  const mode = { app: false };
  const git: Deps['git'] = (cwd, args, opts) => {
    // The runner is in the key: a deadline throw of the app runner is never the answer of a CCv3 call (fix round 3, item 4).
    const run = mode.app && deps.appGit ? deps.appGit : deps.git;
    // C5 (F5): the read options go through, and are in the key: a read with its own buffer or timeout is not the answer of a default read.
    const key = `${run === deps.git ? '' : 'app\0'}${cwd}\0${args.join('\0')}${opts ? `\0${JSON.stringify(opts)}` : ''}`;
    let hit = seen.get(key);
    if (!hit) {
      try { hit = { ok: opts ? run(cwd, args, opts) : run(cwd, args) }; } catch (err) { hit = { err }; }
      seen.set(key, hit);
    }
    if ('err' in hit) throw hit.err;
    return hit.ok;
  };
  const call: Deps = { ...deps, git };
  APP_MODE.set(call, mode);
  return call;
}

/** The app mode of each per-call Deps (perCall): while it is on, git runs deps.appGit. */
const APP_MODE = new WeakMap<Deps, { app: boolean }>();
/**
 * Run an app-folder judgment with the app git runner (fix round 3, fixer H, item 4: the 7 s deadline is for app-folder git only). One
 * Deps object, so the per-call maps (CWDS, PLACES) still find it. isCcv3Checkout never runs inside: every caller asks it first.
 */
function inApp<T>(deps: Deps, run: () => T): T {
  const mode = APP_MODE.get(deps);
  if (!mode || mode.app) return run();
  mode.app = true;
  try {
    return run();
  } finally {
    mode.app = false;
  }
}

// ---------- hook plumbing ----------

/** Seat 3d, last line of defence: a scheme://user:token@ in any output text loses its user and token part (CREDS_RE, next to prose). */
const out = (extra: Record<string, unknown>): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...extra } }).replace(CREDS_RE, '$1');
const denyOut = (reason: string): string => out({ permissionDecision: 'deny', permissionDecisionReason: reason });
/** The app-push warning names no flag: no covered text says how to switch the gate (S6). */
const warnLead = (scope: Scope): string => (scope === 'app-push'
  ? 'this push in an app folder has no tap from Dave; it would be blocked in block mode.'
  : `this command would be blocked when ${FLAG_OF[scope]} is true.`);
const warnOut = (text: string, scope: Scope = 'other', tail = ''): string => out({ additionalContext: `WARNING (decision-gate, warn mode): ${warnLead(scope)} ${text.replace(/^BLOCKED \(decision-gate\): /, '')}${tail}` });

/**
 * The scopes of the gated shapes of the tool call, empty when it is not gated. Cheap, no git: it decides what an internal error does.
 * `app`: the error came from a covered folder (AppScopeError), so app-push joins the scopes. gatedScopes cannot learn coverage itself.
 */
function gatedScopes(input: HookInput, app = false): Set<Scope> {
  const tool = input.tool_name || input.tool || '';
  if (WRITE_TOOLS.has(tool)) return new Set<Scope>(['other']);
  const shapes = catchShapes(input);
  const scopes = new Set<Scope>((shapes ?? []).map(scopeOf));
  // Fix round 6 (item 3): a reader throw in a covered folder is a push off the list: scope app-push, the tap path.
  if (app && (scopes.size > 0 || shapes === null)) scopes.add('app-push');
  return scopes;
}

/**
 * One line on stderr when the input cannot be read. The text never holds the input or the parse error (a V8 parse error quotes the input).
 * The log row is a fixed text for the same reason.
 */
function unreadableInput(): string {
  const note = 'decision-gate: the hook input is not readable JSON, so no command shape can be judged; the call is allowed.';
  try { logGuardError(HOOK, new Error('unreadable hook input')); } catch { /* the log never blocks */ }
  try { process.stderr.write(`${note}\n`); } catch { /* stderr is only a note */ }
  return '{}';
}

/**
 * The whole hook: raw stdin text in, stdout text out. Never throws.
 * Unreadable input (not JSON, or JSON that is not an object) is ALLOWED, with a note on stderr. This is the documented posture, not a gap:
 * the gate fails closed only for a gated shape, and it cannot see a shape in input it cannot read. Denying here would block all work.
 */
export function handle(raw: string, deps: Deps): string {
  let input: HookInput = {};
  try {
    const parsed: unknown = JSON.parse(raw.trim() || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return unreadableInput();
    input = parsed as HookInput;
  } catch {
    return unreadableInput();
  }
  const found: Deny[] = [];
  try {
    const d = decide(input, deps, found);
    // S5, item 7: the registry line rides on the warn or the deny text of the same call, as its last line; else it is the whole output.
    const tail = d.notice ? `\n${corruptLine(d.notice)}` : '';
    let shown = '{}';
    if (d.action === 'allow' && d.warn) {
      logGuardDecision(HOOK, input, 'warn', d.warn.split(':')[0]);
      shown = warnOut(d.warn.slice(d.warn.indexOf(':') + 2), d.scope, tail);
    } else if (d.action === 'deny') {
      logGuardDecision(HOOK, input, 'deny', d.pattern);
      shown = denyOut(d.reason + tail);
    } else if (d.notice) {
      shown = out({ additionalContext: corruptLine(d.notice) });
    }
    if (d.notice) logGuardDecision(HOOK, input, 'warn', `registry-missing ${fwd(d.notice)}: ${CORRUPT_EFFECT}`);
    return shown;
  } catch (err) {
    return unjudgeable(input, deps, err, found);
  }
}

/**
 * A gated call that could not be judged because git failed or threw: fail closed where a flag is on, warn where it is off.
 * A missing cwd (MissingCwdError) is a condition of the call, not a crash of the hook: it is logged as a deny or warn row
 * (reason cwd-missing), so it does not show as an error row in the harness doctor. Any other throw stays an error row.
 */
function unjudgeable(input: HookInput, deps: Deps, thrown: unknown, found: Deny[] = []): string {
  const cwd = input.cwd || process.cwd();
  // A throw in a covered folder after the path test carries scope app-push (AppScopeError); the cause inside it is judged as before.
  // Item 4: a throw before that (git remote -v of isCcv3Checkout) gets app-push too when a push runs in a folder under a live registry
  // root by the path test (no git), so the D2 a block holds. A folder under the continuous-claude root keeps its old scope.
  // PR 566 round 2 (c): a throw inside a covered create or merge (AppScopeError with push false) keeps the home flag but adds no app-push.
  const underRoot = pushUnderLiveRoot(input, deps);
  const app = thrown instanceof AppScopeError || underRoot;
  const appPush = (thrown instanceof AppScopeError && thrown.push) || underRoot;
  const err = thrown instanceof AppScopeError ? thrown.inner : thrown;
  const gone = err instanceof MissingCwdError;
  if (!gone) { try { logGuardError(HOOK, err); } catch { /* the log never blocks */ } }
  // Item 18 (round 3, Dave: "Land now, fix first in round 3"): a deny judged before the throw is not lost, and a push the throw kept from
  // being judged still gets its git-free intent check (an origin push AFTER the throwing member). The first deny that decide() would return
  // wins (a hard deny, or one whose flag is on). After the error log: a git crash behind a deny is still an error row for the doctor.
  const prior = found.find((d) => { try { return hardAppDeny(d) || enforcingScope(d.scope, deps, cwd, d.homeFlags); } catch { return d.hard === true; } })
    ?? catchIntentDeny(input);
  if (prior) {
    try { logGuardDecision(HOOK, input, 'deny', prior.pattern); } catch { /* the log never blocks */ }
    return denyOut(prior.reason);
  }
  const scopes = gatedScopesSafe(input, appPush);
  // Reviewer-2 item 4: a store write no longer returns before the shapes, so a throw there must not drop its scope.
  if (storeWriteCall(input, deps)) scopes.add('other');
  if (scopes.size === 0) return '{}';
  const raw = gone ? err.message : String((err as Error)?.message ?? err).slice(0, 160);
  const detail = app ? prose(raw) : raw;
  const hint = gone ? 'Run the command from a folder that exists.' : 'Run the command again. If it keeps failing, ask Dave.';
  const why = `could not verify Dave's tap (${detail}). ${hint}`;
  // Each gated scope is judged by its own flag. A mixed command denies when either flag is on. Dave 11-13: in a covered folder a call
  // that holds a hard deny (hardAppCall, no git) denies whatever decisions.enforceAppPush says.
  // Item 18: a command that holds a push and threw outside a covered folder is a hard deny: the set git sends cannot be proven. In a covered
  // folder the line below is unchanged (Dave 11-13: enforceAppPush false softens the tap path only; hardAppCall keeps the hard kinds).
  // Seat 2026-11-14 20:00 (Dave's D1: the gate acts in live registered projects): a push whose folders are all resolved and all outside every
  // registry root (CCv3 included) keeps the old result. A missing cwd, a CCv3 root, or a folder the path test cannot place denies.
  const holdsPush = !app && scopes.has('push') && (gone || !pushFoldersUnregistered(input, deps));
  const live = holdsPush || (app && hardAppCall(input)) || [...scopes].some((s) => enforcingScope(s, deps, cwd, app));
  if (gone) logGuardDecision(HOOK, input, live ? 'deny' : 'warn', 'cwd-missing');
  // Seat 2026-11-14 (read of 2276351b): a push denied only because its check threw says so, so a session does not read it as a policy block.
  if (holdsPush && !(app && hardAppCall(input)) && ![...scopes].some((s) => enforcingScope(s, deps, cwd, app))) {
    const again = gone ? 'Run the push again from a folder that exists.' : 'Run the push again. If it fails again, ask Dave.';
    return denyOut(`BLOCKED (decision-gate): the push check could not run (${detail}), so this push was not judged. This is not a policy block. ${again}`);
  }
  return live ? denyOut(`BLOCKED (decision-gate): ${why}`) : warnOut(why, scopes.has('other') ? 'other' : scopes.has('app-push') ? 'app-push' : 'push');
}

const gatedScopesSafe = (input: HookInput, app = false): Set<Scope> => { try { return gatedScopes(input, app); } catch { return new Set(); } };

/**
 * Item 18, the catch: the git-free intent of every push shape of the call (intentDeny: a subagent push, a literal origin or parcadei
 * remote, a force or unsafe form, a ref outside heads, --repo). A throw in one chain member can stop the judging before a later push is
 * read, so this reads them all from the text alone. Returns the first hard deny, else null. A reader throw returns null (gatedScopes and
 * hardAppCall decide then, as before).
 */
function catchIntentDeny(input: HookInput): Deny | null {
  const shapes = catchShapes(input);
  if (shapes === null) return null;
  const none = deny('none', '', 'push');
  for (const s of shapes) {
    if (s.kind !== 'push' || s.push === undefined) continue;
    const d = intentDeny(s.push, Boolean(input.agent_id), none);
    if (d.hard === true) return d;
  }
  return null;
}

/**
 * Dave 11-13 ("Hard denies always deny"), the catch: a git throw in a covered folder leaves no deny to read, so the hard kinds the text
 * alone shows are read here (no git): a subagent push, a push shape with a force, unsafe, --repo, o-bundle or widening option, and a raw
 * verdict of push-unsafe or a push no shape reads. A hard kind that needs git (push config, two push URLs) cannot be seen here. A throw
 * while reading counts as hard (fail closed; the caller reaches here only for a gated call in a covered folder).
 */
function hardAppCall(input: HookInput): boolean {
  try {
    const cmd = readCommand(input);
    if (cmd.kind !== 'command') return false;
    const pushes = shapesOf(cmd.text, cmd.tool).filter((s) => s.kind === 'push');
    if (input.agent_id && pushes.length > 0) return true;
    if (rawVerdict(cmd.text, cmd.tool)?.kind === 'unsafe') return true;
    return pushes.some(({ push: p }) => p !== undefined && (p.force || p.unsafeOpt || p.repoOpt || p.oBundle || p.widerOpt !== null));
  } catch {
    // Fix round 6 (item 3): a throw of the push reader is a push off the list, the tap path; a subagent call stays hard.
    return Boolean(input.agent_id);
  }
}
/** Fix round 6 (item 3): the shapes of a shell call for the catch, or null when the reader throws (gatedScopes, pushUnderLiveRoot). */
function catchShapes(input: HookInput): Shape[] | null {
  const cmd = readCommand(input);
  if (cmd.kind !== 'command') return [];
  try {
    return shapesOf(cmd.text, cmd.tool);
  } catch {
    return null;
  }
}

/**
 * True when the call holds a push whose folder (the cwd, its cd path, its -C) is under a live registry root by the path test: files
 * only, no git (underLiveRoot, outside the continuous-claude root). Never throws.
 */
function pushUnderLiveRoot(input: HookInput, deps: Deps): boolean {
  try {
    const scope = deps.tapScope;
    const cmd = readCommand(input);
    if (!scope || cmd.kind !== 'command') return false;
    // A reader throw (null) is a push off the list: the cwd is its folder.
    const pushes = catchShapes(input)?.filter((s) => s.kind === 'push') ?? null;
    if (pushes?.length === 0) return false;
    const reg = scope.registry();
    const cwd = input.cwd || process.cwd();
    const shell = shellOf(input);
    // Fix round 5 (F4, F3): the -C chain folders, and the move targets resolved from each folder. Round 6: a home folder is expanded.
    const paths = knownDirs((pushes ?? []).flatMap((s) => [cwd, ...pushDirsOf(s.push!, cwd, shell), ...chainDirsOf(s.push!, cwd, shell)]).concat(cwd), deps.home);
    const dirs = [...paths, ...paths.flatMap((d) => moveTargets(cmd.text, d, shell, deps.home))];
    return dirs.some((d) => underLiveRoot(d, reg, scope, { outsideCcv3: true }));
  } catch {
    return false;
  }
}

/** The registry key of the CCv3 entry (tap-scope.ts CCV3_ENTRY, not exported there; that file is outside this card). */
const CCV3_ENTRY_KEY = 'continuous-claude';

/**
 * Item 18, seat ruling 2026-11-14 20:00: true only when the push folders of the call (the cwd, its cd path, its -C chain, the move targets)
 * are all known by the path test and none is under a registry root: not the CCv3 root, not a live entry. Files only, no git. False (so the
 * catch denies) when there is no registry, a reader throw, a folder that is not absolute or holds a variable, or any CCv3 or live root.
 */
function pushFoldersUnregistered(input: HookInput, deps: Deps): boolean {
  try {
    const scope = deps.tapScope;
    const cmd = readCommand(input);
    if (!scope || cmd.kind !== 'command') return false;
    const pushes = catchShapes(input)?.filter((s) => s.kind === 'push');
    if (!pushes || pushes.length === 0) return false;
    const reg = scope.registry();
    if (reg.state !== 'ok') return false;
    const cwd = input.cwd || process.cwd();
    const shell = shellOf(input);
    const raw = pushes.flatMap((s) => [cwd, ...pushDirsOf(s.push!, cwd, shell), ...chainDirsOf(s.push!, cwd, shell)]).concat(cwd);
    if (raw.some((d) => isUnexpanded(d))) return false;
    const paths = knownDirs(raw, deps.home);
    const dirs = [...paths, ...paths.flatMap((d) => moveTargets(cmd.text, d, shell, deps.home))];
    if (dirs.length === 0 || dirs.some((d) => !isAbsolute(d) || isUnexpanded(d))) return false;
    return !dirs.some((d) => underRegistryRoot(d, reg, scope));
  } catch {
    return false;
  }
}
/** True when the path test puts `d` under a live registry root or the CCv3 root. Files only. */
function underRegistryRoot(d: string, reg: ReturnType<TapScopeDeps['registry']>, scope: TapScopeDeps): boolean {
  // The CCv3 root as a live entry, so the public path test finds it (underLiveRoot never counts the CCv3 key as live).
  const ccv3 = { ...reg, entries: reg.entries.filter((e) => e.key === CCV3_ENTRY_KEY).map((e) => ({ ...e, key: `${CCV3_ENTRY_KEY}#root`, status: 'active', tapGate: null })) };
  return underLiveRoot(d, reg, scope) || underLiveRoot(d, ccv3, scope);
}
/** Round 3 seat fix 2: `d` is an absolute folder with no variable under no registry root (the R18-C3 test for one folder). Never throws. */
function folderUnregistered(deps: Deps, d: string): boolean {
  try {
    const scope = deps.tapScope;
    if (!scope || !isAbsolute(d) || isUnexpanded(d)) return false;
    const reg = scope.registry();
    return reg.state === 'ok' && !underRegistryRoot(d, reg, scope);
  } catch {
    return false;
  }
}
/**
 * Round 3 seat fix 2: a CCv3 checkout, or a folder whose remotes git cannot list and that is not shown to be a resolved folder under
 * no registry root (fail closed: a throw is no proof of "not CCv3"). Never throws.
 */
function ccv3OrUnplaced(deps: Deps, d: string): boolean {
  try {
    return isCcv3Checkout(deps, d);
  } catch {
    return !folderUnregistered(deps, d);
  }
}

/**
 * The cwd of a git call is gone (a removed worktree). Node reports that as "spawnSync git ENOENT", the text of a missing git binary,
 * so makeGit checks the folder first and throws this instead. The call stays unjudged (fail closed), with the folder named.
 */
export class MissingCwdError extends Error {
  constructor(readonly cwd: string) {
    super(`the working folder does not exist: ${cwd}`);
    this.name = 'MissingCwdError';
  }
}

/** The hook ran out of time before a git call (item 5): the call is unjudgeable, with the scope the catch gives it. */
export class GitDeadlineError extends Error {
  constructor(readonly args: string[]) {
    super(`the time limit of the hook (${HOOK_BUDGET_MS / 1000} s) passed before git ${args[0] ?? ''} could run`);
    this.name = 'GitDeadlineError';
  }
}

/** Every git call of one hook run ends by this many ms after the hook start (the hook itself is killed at 10 s). */
const HOOK_BUDGET_MS = 7000;
type Spawn = (cmd: string, args: string[], opts: { cwd?: string; encoding: 'utf8'; timeout?: number; windowsHide?: boolean; maxBuffer?: number }) => { status: number | null; stdout?: string | null; error?: Error };
export interface GitOptions {
  /** Epoch ms after which no git call starts (GitDeadlineError). Absent: no deadline, each call keeps its own 2 s timeout. */
  deadline?: number;
  now?: () => number;
  spawn?: Spawn;
  exists?: (p: string) => boolean;
}

export function makeGit(opts: GitOptions = {}): Deps['git'] {
  const now = opts.now ?? Date.now;
  // PR 566 CI (semgrep detect-child-process): the default runs only git, as a literal. makeGit calls spawn with 'git' alone.
  const spawn: Spawn = opts.spawn ?? ((_cmd, args, o) => spawnSync('git', args, o));
  const exists = opts.exists ?? existsSync;
  return (cwd, args, read = {}) => {
    const own = read.timeout ?? GIT_TIMEOUT_MS;
    const left = opts.deadline === undefined ? own : opts.deadline - now();
    if (left <= 0) throw new GitDeadlineError(args);
    if (!exists(cwd)) throw new MissingCwdError(cwd);
    // F5 (card coord-decision-gate-round3-content-scan): maxBuffer only when the caller names one, so every other read keeps Node's default.
    const r = spawn('git', args, { cwd, encoding: 'utf8', timeout: Math.min(own, left), windowsHide: true, ...(read.maxBuffer ? { maxBuffer: read.maxBuffer } : {}) });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  };
}

/**
 * The Deps of the hook. The registry comes from LANE_REGISTRY_PATH, else <home>/.claude/project-registry.json (tap-scope.ts), read once
 * and only when needed. `start`: the hook start (default now). App-folder git (appGit) stops HOOK_BUDGET_MS after it; the CCv3 path
 * (git) has no total deadline, as in base main 7a0e2f34 (fix round 3, item 4). `now`, `spawn` and `exists` are test seams of makeGit.
 */
export function realDeps(opts: { start?: number } & Pick<GitOptions, 'now' | 'spawn' | 'exists'> = {}): Deps {
  const { start, ...run } = opts;
  const t0 = start ?? Date.now();
  const clock = run.now ?? Date.now;
  let registry: Registry | null = null;
  return {
    git: makeGit(run),
    scanLeft: () => t0 + HOOK_BUDGET_MS - clock(),
    appGit: makeGit({ ...run, deadline: t0 + HOOK_BUDGET_MS }),
    readFile: (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; } },
    env: process.env,
    home: homedir(),
    tapScope: { registry: () => (registry ??= readRegistry({ env: process.env })) },
    // The push scan: the ids come from the primary checkout of the folder being pushed (the dataset is git-ignored, so a worktree has none).
    holdoutIds: (dir) => loadHoldoutIds(primaryRootOf(makeGit(run), dir)),
    answerKeyHits: answerKeyHitsOf,
  };
}

/** The primary checkout of a folder: the parent of git's common dir. Throws when git cannot say (the scan then denies). */
function primaryRootOf(git: Deps['git'], dir: string): string {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0 || r.stdout.trim() === '') throw new Error('no common dir');
  return resolve(r.stdout.trim(), '..');
}

async function main(): Promise<void> {
  const start = Date.now(); // before the stdin read: the deadline counts from the hook start
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(handle(Buffer.concat(chunks).toString('utf-8'), realDeps({ start })));
}

// Auto-run only as a hook; VITEST imports the pure functions above.
if (!process.env.VITEST) {
  main().catch((err) => { logGuardError(HOOK, err); console.error('decision-gate: stdin could not be read; the call is allowed.'); console.log('{}'); });
}
