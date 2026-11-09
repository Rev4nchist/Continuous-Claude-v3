/**
 * Shared fixtures of the guard-prompt-text-fp tests (lane guard-prompt-text-fp). Not a test file.
 *
 * TEXT: words of a PR create, land or merge inside quoted text of a command that only prints, sends or stores that text.
 * The command is harmless, so no gate may stop it. Probed before the fix (decision-gate and pre-pr-gate denied every one).
 * REAL: the same words as a command that runs. Every one keeps its gate, bare, wrapped, in a substitution inside quotes,
 * after a quoted string, and fed to a shell by a pipe.
 */
export type Tool = 'Bash' | 'PowerShell';

export interface Word { family: 'create' | 'land' | 'merge'; text: string }

export const WORDS: Word[] = [
  { family: 'create', text: 'gh pr create for fix' },
  { family: 'create', text: 'gh pr create --title x --body y' },
  { family: 'create', text: 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=x' },
  { family: 'land', text: 'land-pr.ps1 -Pr 5' },
  { family: 'merge', text: 'gh pr merge 5 --squash' },
  { family: 'merge', text: 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/5/merge -X PUT' },
];

/** Commands that print, send or store their quoted text and run none of it. `q` is the quote character. */
export const TEXT_CONTEXTS: Array<[string, (w: string, q: string) => string]> = [
  ['lane add title', (w, q) => `node lane.mjs add x --title ${q}${w}${q}`],
  ['lane shim note', (w, q) => `node C:/Users/dkhay/.claude/scripts/lane.mjs note x --note ${q}${w}${q}`],
  ['lane say', (w, q) => `node lane.mjs say --to trex ${q}${w}${q}`],
  ['claude -p', (w, q) => `claude -p ${q}${w}${q}`],
  ['claude -p flags', (w, q) => `claude -p ${q}${w}${q} --output-format json`],
  ['git commit -m', (w, q) => `git commit -m ${q}${w}${q}`],
  ['echo', (w, q) => `echo ${q}${w}${q}`],
  ['printf', (w, q) => `printf ${q}%s\\n${q} ${q}${w}${q}`],
  ['gh pr comment', (w, q) => `gh pr comment 1 --body ${q}${w}${q}`],
  ['Write-Host', (w, q) => `Write-Host ${q}${w}${q}`],
  ['Write-Output', (w, q) => `Write-Output ${q}${w}${q}`],
  ['curl -d', (w, q) => `curl -d ${q}${w}${q} https://example.com/x`],
  ['ntn payload', (w) => `ntn api v1/pages -d '{"title":"${w}"}'`],
  ['after cd &&', (w, q) => `cd /tmp && echo ${q}${w}${q}`],
  ['after echo ;', (w, q) => `echo start; node lane.mjs add x --title ${q}${w}${q}`],
  ['two prints', (w, q) => `echo ${q}${w}${q}; echo ${q}${w}${q}`],
  ['newline', (w, q) => `echo ${q}one${q}\nnode lane.mjs note x --note ${q}${w}${q}`],
  ['redirect to null', (w, q) => `echo ${q}${w}${q} 2>&1`],
];

/** The same words as a command that runs. Each is built from the word `w`. */
export const REAL_SHAPES: Array<[string, (w: string) => string]> = [
  ['bare', (w) => w],
  ['bash -c', (w) => `bash -c "${w}"`],
  ['sh -c single quotes', (w) => `sh -c '${w}'`],
  ['pwsh -c', (w) => `pwsh -c "${w}"`],
  ['pwsh -Command', (w) => `pwsh -NoProfile -Command "${w}"`],
  ['eval', (w) => `eval "${w}"`],
  ['Invoke-Expression', (w) => `Invoke-Expression "${w}"`],
  ['iex', (w) => `iex "${w}"`],
  ['ssh', (w) => `ssh host "${w}"`],
  ['after echo ;', (w) => `echo "x"; ${w}`],
  ['after echo &&', (w) => `echo "x" && ${w}`],
  ['after echo ||', (w) => `echo "x" || ${w}`],
  ['after echo |', (w) => `echo "x" | ${w}`],
  ['after newline', (w) => `echo "x"\n${w}`],
  ['after lane add ;', (w) => `node lane.mjs add x --title "t"; ${w}`],
  ['after lane add && with create words in the title', (w) => `node lane.mjs add x --title "gh pr create for fix" && ${w}`],
  ['substitution in echo', (w) => `echo "a $(${w})"`],
  ['substitution in commit message', (w) => `git commit -m "$(${w})"`],
  ['substitution in lane title', (w) => `node lane.mjs add x --title "t $(${w})"`],
  ['substitution in claude -p', (w) => `claude -p "do $(${w})"`],
  ['substitution after text words', (w) => `echo "gh pr create for fix $(${w})"`],
  ['backtick in echo', (w) => `echo "a \`${w}\`"`],
  ['bare substitution after echo', (w) => `echo $(${w})`],
  ['bare backtick after echo', (w) => `echo \`${w}\``],
  ['pipe into sh', (w) => `echo "${w}" | sh`],
  ['pipe into bash', (w) => `echo '${w}' | bash`],
  ['pipe into Invoke-Expression', (w) => `"${w}" | Invoke-Expression`],
  ['pipe into pwsh', (w) => `echo "${w}" | pwsh -Command -`],
  ['printf piped into sh', (w) => `printf "%s" "${w}" | sh`],
  ['write a script then it is the next command', (w) => `echo "${w}" > run.sh`],
  ['append to a script', (w) => `echo "${w}" >> run.sh`],
  ['tee a script', (w) => `echo "${w}" | tee run.sh`],
  // a quote that PowerShell and Bash read differently: the PowerShell reading shows a real command
  ['quote read differently by the two shells', (w) => `echo "a\\" ; ${w} ; echo "b"`],
];

/**
 * Fix round: the same words as a command that runs, hidden by a quote the shared regex misreads, or by a harmless-looking segment.
 * Each was a fail-open (allowed where the base denied) and keeps its gate now. Built from the word `w`.
 */
export const FINDING_SHAPES: Array<[string, (w: string) => string]> = [
  ['ANSI-C string with an escaped quote', (w) => `echo $'it\\'s' ; ${w} ; echo 'x'`],
  ['comment apostrophe pairs across the newline', (w) => `echo "x" # it's\n${w}\necho "a'b"`],
  ['smart quote closes an ASCII quote', (w) => `Write-Output 'x\u2019 ; ${w} ; Write-Output 'y'`],
  ['smart quote opens a string', (w) => `Write-Output \u201cx" ; ${w} ; Write-Output "y\u201d`],
  ['indented leading pipe into Invoke-Expression', (w) => `Write-Output "${w}"\n   | Invoke-Expression`],
  ['leading pipe into iex after a tab', (w) => `Write-Output '${w}'\n\t| iex`],
  ['eval of a backtick substitution with an echo after ;', (w) => `eval \`echo a; echo '${w}'\``],
  ['bare command position fed by a substitution', (w) => `$(echo a; echo '${w}')`],
  ['eval of a substitution with an echo after ;', (w) => `eval $(echo a; echo "${w}")`],
  ['printf -v stores the text, a later segment runs it', (w) => `printf -v x '${w}'; eval "$x"`],
  ['printf -v then the variable as a command', (w) => `printf -v x '${w}'; $x`],
  ['Write-Output -OutVariable then iex', (w) => `Write-Output -OutVariable v "${w}"; iex $v`],
  ['Write-Output -ov alias then iex', (w) => `Write-Output -ov v '${w}'; Invoke-Expression $v`],
  ['echo redefined as a function', (w) => `echo() { eval "$@"; }; echo '${w}'`],
  ['echo redefined as a function on lines', (w) => `echo () {\n eval "$1"\n}\necho "${w}"`],
  ['echo aliased to Invoke-Expression', (w) => `Set-Alias echo Invoke-Expression; echo "${w}"`],
  ['echo aliased with sal', (w) => `sal echo iex; Write-Output '${w}'; echo '${w}'`],
  ['echo aliased with alias', (w) => `alias echo=eval; echo '${w}'`],
  ['redirect to nul with ..\\ then run the file', (w) => `Write-Output "${w}" > nul\\..\\x.ps1; & .\\x.ps1`],
  ['redirect to nul with ../ then run the file', (w) => `echo '${w}' >nul/../x.sh; sh x.sh`],
  ['redirect to /dev/null with ../ then run the file', (w) => `echo '${w}' > /dev/null/../x.sh; sh x.sh`],
];

export const tools: Tool[] = ['Bash', 'PowerShell'];
