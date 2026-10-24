# Pester tests for the prune backup gate.
# Run: pwsh -NoProfile -Command "Invoke-Pester scripts/__tests__/prune-backup.Tests.ps1"
# Uses a temp USERPROFILE. Does not touch the real home or a live ~/.claude.

BeforeAll {
    $repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:Prune = Join-Path $repo 'scripts/prune-stale-install.ps1'

    function script:New-PruneHome {
        $tempHome = Join-Path ([System.IO.Path]::GetTempPath()) ('prune-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path (Join-Path $tempHome '.claude') -Force | Out-Null
        return $tempHome
    }

    function script:Get-BakCount([string]$Root) {
        return @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '.claude.bak-*' }).Count
    }

    function script:Invoke-PruneAt([string]$Root) {
        $prev = $env:USERPROFILE
        try {
            $env:USERPROFILE = $Root
            $lines = @(& pwsh -NoProfile -File $script:Prune 2>&1 | ForEach-Object { "$_" })
            return @{ Code = $LASTEXITCODE; Out = ($lines -join "`n") }
        } finally {
            if ($null -eq $prev) { Remove-Item Env:USERPROFILE -ErrorAction SilentlyContinue }
            else { $env:USERPROFILE = $prev }
        }
    }
}

Describe 'prune backup gate' {
    It 'a failed pre-check throws and does not create a backup' {
        $tempHome = New-PruneHome
        try {
            $claude = Join-Path $tempHome '.claude'
            Set-Content -LiteralPath (Join-Path $claude 'settings.json') -Value '{"hook":"arch-context-inject.sh"}' -Encoding utf8
            $commands = Join-Path $claude 'commands'
            New-Item -ItemType Directory -Path $commands -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $commands 'chats.md') -Value 'stale' -Encoding utf8
            $before = Get-BakCount $tempHome
            $result = Invoke-PruneAt $tempHome
            $result.Code | Should -Not -Be 0
            $result.Out | Should -Match 'backup: none \(settings\.json still references arch-context-inject\.sh\)'
            $result.Out | Should -Match 'existing \.claude\.bak-\*: \d+'
            (Get-BakCount $tempHome) | Should -Be $before
            Test-Path -LiteralPath (Join-Path $commands 'chats.md') | Should -BeTrue
        } finally {
            Remove-Item -LiteralPath $tempHome -Recurse -Force
        }
    }

    It 'a no-op run prints backup: none and does not create a backup' {
        $tempHome = New-PruneHome
        try {
            Set-Content -LiteralPath (Join-Path $tempHome '.claude/settings.json') -Value '{}' -Encoding utf8
            $before = Get-BakCount $tempHome
            $result = Invoke-PruneAt $tempHome
            $result.Code | Should -Be 0
            $result.Out | Should -Match 'backup: none \(nothing to remove\)'
            (Get-BakCount $tempHome) | Should -Be $before
        } finally {
            Remove-Item -LiteralPath $tempHome -Recurse -Force
        }
    }

    It 'a run with one stale path creates exactly one named backup and a second run does not' {
        $tempHome = New-PruneHome
        try {
            $claude = Join-Path $tempHome '.claude'
            Set-Content -LiteralPath (Join-Path $claude 'settings.json') -Value '{}' -Encoding utf8
            $commands = Join-Path $claude 'commands'
            New-Item -ItemType Directory -Path $commands -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $commands 'chats.md') -Value 'stale' -Encoding utf8
            $fourth = Join-Path $claude 'skills/fourth-brand'
            New-Item -ItemType Directory -Path $fourth -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $fourth 'SKILL.md') -Value 'leave me' -Encoding utf8
            New-Item -ItemType Directory -Path (Join-Path $tempHome '.claude.bak-manual') -Force | Out-Null
            $before = Get-BakCount $tempHome

            $result = Invoke-PruneAt $tempHome
            $result.Code | Should -Be 0
            $result.Out | Should -Match 'backup .+\.claude\.bak-prune-\d{8}-\d{6}'
            $result.Out | Should -Match 'existing \.claude\.bak-\*: \d+'
            (Get-BakCount $tempHome) | Should -Be ($before + 1)
            $created = @(Get-ChildItem -LiteralPath $tempHome -Force | Where-Object { $_.Name -like '.claude.bak-prune-*' })
            $created.Count | Should -Be 1
            $created[0].Name | Should -Match '^\.claude\.bak-prune-\d{8}-\d{6}$'
            Test-Path -LiteralPath (Join-Path $commands 'chats.md') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $fourth 'SKILL.md') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $tempHome '.claude.bak-manual') | Should -BeTrue

            $again = Invoke-PruneAt $tempHome
            $again.Code | Should -Be 0
            $again.Out | Should -Match 'backup: none \(nothing to remove\)'
            (Get-BakCount $tempHome) | Should -Be ($before + 1)
            Test-Path -LiteralPath (Join-Path $fourth 'SKILL.md') | Should -BeTrue
        } finally {
            Remove-Item -LiteralPath $tempHome -Recurse -Force
        }
    }
}
