# Pester tests for the W8 hook-error matcher.
# Run: pwsh -NoProfile -Command "Invoke-Pester scripts/__tests__/w8-hook-errors.Tests.ps1"
# The fixture is synthetic. It is not a copy of the rog-strix debug log.

BeforeAll {
    $repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:Lib = Join-Path $repo 'docs/ccv3-1/lib/w8-hook-errors.ps1'
    $script:Gates = Join-Path $repo 'docs/ccv3-1/run-windows-gates.ps1'
    $script:Doc = Join-Path $repo 'docs/ccv3-1/WINDOWS-GATES.md'
    $script:Fixture = Join-Path $PSScriptRoot 'fixtures/w8-hook-errors-synthetic.txt'
    . $script:Lib
    $script:OldPattern = 'hook.*(error|fail|timed out|ENOENT)'
}

Describe 'W8 hook-error matcher (synthetic fixture)' {
    It 'the fixture is labelled synthetic and has both kinds of line' {
        $raw = Get-Content -LiteralPath $script:Fixture
        $raw[0] | Should -Match 'SYNTHETIC'
        @($raw | Where-Object { $_ -match '^SUCCESS ' }).Count | Should -BeGreaterThan 0
        @($raw | Where-Object { $_ -match '^ERROR ' }).Count | Should -BeGreaterThan 0
    }

    It 'successful hook output, including ROADMAP text, matches 0 lines' {
        $hits = @(Get-Content -LiteralPath $script:Fixture | Where-Object { $_ -match '^SUCCESS ' } | Where-Object { Test-HookErrorLine ($_ -replace '^SUCCESS ','') })
        $hits.Count | Should -Be 0
    }

    It 'each seeded real hook error matches' {
        $errors = @(Get-Content -LiteralPath $script:Fixture | Where-Object { $_ -match '^ERROR ' })
        $errors.Count | Should -BeGreaterThan 0
        foreach ($row in $errors) {
            (Test-HookErrorLine ($row -replace '^ERROR ','')) | Should -BeTrue
        }
    }
}

Describe 'W8 pattern is shared' {
    It 'run-windows-gates.ps1 and WINDOWS-GATES.md use the same pattern and not the old one' {
        $gates = Get-Content -LiteralPath $script:Gates -Raw
        $doc = Get-Content -LiteralPath $script:Doc -Raw
        $gates | Should -Match 'Test-HookErrorLine'
        $gates | Should -Match 'w8-hook-errors\.ps1'
        $doc | Should -Match 'Test-HookErrorLine'
        $doc.Contains($script:W8HookErrorPattern) | Should -BeTrue
        $gates.Contains($script:OldPattern) | Should -BeFalse
        $doc.Contains($script:OldPattern) | Should -BeFalse
    }
}
