# W8 hook-error matcher. One pattern, used by run-windows-gates.ps1 and WINDOWS-GATES.md.
# Matches Claude Code debug-log failure lines (hook error / failed / timed out /
# ENOENT / non-zero exit). It does not match successful hook stdout that merely
# contains those words (ROADMAP text, "hook error handling", exit code 0).

$script:W8HookErrorPattern = '(?i)(\[ERROR\][^\r\n]*\bhook\b[^\r\n]*\b(fail(ed|ure)?|timed out|ENOENT|non-zero|exit code (?!0\b)\d+)\b|(?<![\w-])(Hook error:|Hook failed\b|Failed to run hook\b|Error running hook\b|Hook timed out\b|Hook command timed out\b)|spawn\S*\s+ENOENT)'

function Test-HookErrorLine {
    param([Parameter(Mandatory = $false)][AllowEmptyString()][string]$Line)
    if ([string]::IsNullOrEmpty($Line)) { return $false }
    return [bool]($Line -match $script:W8HookErrorPattern)
}
