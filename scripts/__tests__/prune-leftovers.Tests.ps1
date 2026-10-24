# Pester tests for the prune leftover scan.
# Run: pwsh -NoProfile -Command "Invoke-Pester scripts/__tests__/prune-leftovers.Tests.ps1"
# Uses a temp USERPROFILE. The planted name is built at runtime so this file
# does not carry the stale-install token the ratchet counts.

BeforeAll {
    $repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:Prune = Join-Path $repo 'scripts/prune-stale-install.ps1'
    $script:Planted = -join @('co', 'dex')

    function script:New-PruneRoot {
        $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('prune-left-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path (Join-Path $tempRoot '.claude') -Force | Out-Null
        return $tempRoot
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

Describe 'prune leftover scan' {
    It 'skips vendor trees, reports them, and still fails on a non-vendor leftover' {
        $tempRoot = New-PruneRoot
        try {
            $claude = Join-Path $tempRoot '.claude'
            Set-Content -LiteralPath (Join-Path $claude 'settings.json') -Value '{}' -Encoding utf8
            $vendorFile = Join-Path $claude "hooks/node_modules/pkg/$($script:Planted)-file.js"
            New-Item -ItemType Directory -Path (Split-Path -Parent $vendorFile) -Force | Out-Null
            Set-Content -LiteralPath $vendorFile -Value 'third party' -Encoding utf8
            $plainVendor = Join-Path $claude 'hooks/node_modules/pkg/readme.js'
            Set-Content -LiteralPath $plainVendor -Value 'not a leftover' -Encoding utf8
            $fourthFile = Join-Path $claude "skills/fourth-brand/$($script:Planted).md"
            New-Item -ItemType Directory -Path (Split-Path -Parent $fourthFile) -Force | Out-Null
            Set-Content -LiteralPath $fourthFile -Value 'leave' -Encoding utf8
            $staleFile = Join-Path $claude "skills/kept/$($script:Planted)-leftover.txt"
            New-Item -ItemType Directory -Path (Split-Path -Parent $staleFile) -Force | Out-Null
            Set-Content -LiteralPath $staleFile -Value 'real leftover' -Encoding utf8

            $result = Invoke-PruneAt $tempRoot
            $result.Code | Should -Not -Be 0
            $excludedLine = @($result.Out -split "`n" | Where-Object { $_ -like 'excluded:*' })
            $excludedLine.Count | Should -Be 1
            $excludedLine[0] | Should -Match '^excluded: 1 paths \(node_modules\): '
            $plantedNeedle = [regex]::Escape("$($script:Planted)-file.js")
            $excludedLine[0] | Should -Match $plantedNeedle
            $excludedLine[0] | Should -Not -Match 'readme\.js'
            $vendorTotal = 0
            if ($excludedLine[0] -match 'vendor entries: (\d+)') { $vendorTotal = [int]$Matches[1] }
            $vendorTotal | Should -BeGreaterThan 1
            $result.Out | Should -Match 'leftovers: 1'
            $result.Out | Should -Match 'leftovers 1'
            $result.Out | Should -Match 'backup: none \(nothing to remove\)'
            $listed = @($result.Out -split "`n" | Where-Object { $_ -like '*node_modules*' -and $_ -notlike 'excluded:*' })
            $listed.Count | Should -Be 0
            Test-Path -LiteralPath $vendorFile | Should -BeTrue
            Test-Path -LiteralPath $fourthFile | Should -BeTrue
        } finally {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }

    It 'leaves a synced fourth copy in place and does not throw' {
        $tempRoot = New-PruneRoot
        try {
            $claude = Join-Path $tempRoot '.claude'
            Set-Content -LiteralPath (Join-Path $claude 'settings.json') -Value '{}' -Encoding utf8
            $guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
            $synced = Join-Path $claude "skills/synced/$guid/fourth-sample/sample-deck.pptx"
            New-Item -ItemType Directory -Path (Split-Path -Parent $synced) -Force | Out-Null
            Set-Content -LiteralPath $synced -Value 'synced copy' -Encoding utf8
            $fourthFile = Join-Path $claude 'skills/fourth-sample/kept.txt'
            New-Item -ItemType Directory -Path (Split-Path -Parent $fourthFile) -Force | Out-Null
            Set-Content -LiteralPath $fourthFile -Value 'leave' -Encoding utf8

            $result = Invoke-PruneAt $tempRoot
            $result.Code | Should -Be 0
            $result.Out | Should -Match 'leftovers: 0'
            $result.Out | Should -Not -Match 'leftovers \d+'
            $managed = @($result.Out -split "`n" | Where-Object { $_ -like 'managed-sync:*' })
            $managed.Count | Should -Be 1
            $managed[0] | Should -Match '^managed-sync: 1 paths \(skills/synced; managed by sync, not ours\): '
            $managed[0] | Should -Match 'skills/synced/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/fourth-sample/sample-deck\.pptx'
            Test-Path -LiteralPath $synced | Should -BeTrue
            Test-Path -LiteralPath $fourthFile | Should -BeTrue
        } finally {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }
}

Describe 'managed sync path predicate' {
    BeforeAll {
        $repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        . (Join-Path $repo 'scripts/lib/prune-managed-sync.ps1')
    }

    It 'recognises skills/synced/<guid>/fourth-* with a slash' {
        Test-PruneManagedSyncPath '/skills/synced/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/fourth-sample/sample-deck.pptx' | Should -BeTrue
    }

    It 'recognises skills\synced\<guid>\fourth-* with a backslash' {
        Test-PruneManagedSyncPath '\skills\synced\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\fourth-sample\sample-deck.pptx' | Should -BeTrue
    }

    It 'does not treat skills/fourth-* as a synced copy' {
        Test-PruneManagedSyncPath '/skills/fourth-sample/sample-deck.pptx' | Should -BeFalse
        Test-PruneManagedSyncPath '\skills\fourth-sample\sample-deck.pptx' | Should -BeFalse
    }
}
