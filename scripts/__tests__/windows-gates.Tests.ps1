# Pester tests for the W0 and W2 gate verdicts.
# Run: pwsh -NoProfile -Command "Invoke-Pester scripts/__tests__/windows-gates.Tests.ps1"
# The driver is not executed: it requires Git Bash at a Windows path.

BeforeAll {
    $repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:Lib = Join-Path $repo 'docs/ccv3-1/lib/windows-gate-verdicts.ps1'
    $script:Gates = Join-Path $repo 'docs/ccv3-1/run-windows-gates.ps1'
    $script:Doc = Join-Path $repo 'docs/ccv3-1/WINDOWS-GATES.md'
}

Describe 'W2 sync verdict' {
    BeforeAll {
        . $script:Lib
    }

    It 'parses a space-padded zero file count as zero' {
        (Get-GateCount -Lines @('files=       0') -Key 'files') | Should -Be 0
        (Get-GateCount -Lines @('files=852') -Key 'files') | Should -Be 852
        (Get-GateCount -Lines @('sync_exit=0') -Key 'files') | Should -Be -1
    }

    It 'files=0 is a loud fail even when the sync exit is 0' {
        $verdict = Get-W2SyncVerdict -SyncExit 0 -Files 0 -ArchiveDirs 0 -SkipSkills 0 -WorkPaths 0
        $verdict.Pass | Should -BeFalse
        $verdict.Summary | Should -Be 'FAIL: W2 files=0; zero inputs is not a pass'
    }

    It 'a missing file count is a loud fail' {
        $verdict = Get-W2SyncVerdict -SyncExit 0 -Files -1 -ArchiveDirs 0 -SkipSkills 0 -WorkPaths 0
        $verdict.Pass | Should -BeFalse
        $verdict.Summary | Should -Match 'FAIL: W2 files=-1; zero inputs is not a pass'
    }

    It 'a positive file count with the other counts clear passes' {
        $verdict = Get-W2SyncVerdict -SyncExit 0 -Files 852 -ArchiveDirs 0 -SkipSkills 0 -WorkPaths 0
        $verdict.Pass | Should -BeTrue
        $verdict.Summary | Should -Be ''
    }

    It 'a positive file count still fails when another count is wrong' {
        $verdict = Get-W2SyncVerdict -SyncExit 0 -Files 852 -ArchiveDirs 1 -SkipSkills 0 -WorkPaths 0
        $verdict.Pass | Should -BeFalse
        $verdict.Summary | Should -Be ''
    }
}

Describe 'W2 child override' {
    It 'sets SYNC_ALLOW_BRANCH only on the temp-HOME sync command' {
        $gates = Get-Content -LiteralPath $script:Gates -Raw
        $needle = 'HOME="$H" CCV3_MACHINE_PROFILE=personal SYNC_ALLOW_BRANCH=1 "$BASH" scripts/sync-to-active.sh --skip-build'
        $gates.Contains($needle) | Should -BeTrue
        $gates.Contains('$env:SYNC_ALLOW_BRANCH') | Should -BeFalse
        $doc = Get-Content -LiteralPath $script:Doc -Raw
        $doc.Contains($needle) | Should -BeTrue
        $doc.Contains('FAIL: W2 files=0; zero inputs is not a pass') | Should -BeTrue
        $doc.Contains('$env:SYNC_ALLOW_BRANCH') | Should -BeFalse
    }
}
