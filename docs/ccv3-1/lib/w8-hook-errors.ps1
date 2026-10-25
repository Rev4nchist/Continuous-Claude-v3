# W8 hook-error matcher. One pattern, used by run-windows-gates.ps1 and WINDOWS-GATES.md.
# Matches documented Claude Code debug-log failure lines (hook error / failed /
# timed out / ENOENT / non-zero exit / completed with status N / status code N,
# N not 0). Alternative 2 does not match a Hook stdout: line. Exit code 0,
# status 0, and status code 0 do not match.

$script:W8HookErrorPattern = '(?i)(\[ERROR\][^\r\n]*\bhook\b[^\r\n]*\b(fail(ed|ure)?|timed out|ENOENT|non-zero|exit code (?!0\b)\d+)\b|(?<!Hook stdout:[^\r\n]*)(?<![\w-])(Hook error:|Hook failed\b|Failed to run hook\b|Error running hook\b|Hook timed out\b|Hook command timed out\b)|completed with status (?!0\b)\d+|status code (?!0\b)\d+|spawn\S*\s+ENOENT)'

function Test-HookErrorLine {
    param([Parameter(Mandatory = $false)][AllowEmptyString()][string]$Line)
    if ([string]::IsNullOrEmpty($Line)) { return $false }
    return [bool]($Line -match $script:W8HookErrorPattern)
}
