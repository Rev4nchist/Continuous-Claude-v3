# Verdicts for the Windows gate driver. The driver is not executed in tests
# (it requires Git Bash at a Windows path). Zero file counts never pass.

function Get-GateCount {
    param(
        [Parameter(Mandatory = $false)][AllowEmptyCollection()][string[]]$Lines,
        [Parameter(Mandatory = $true)][string]$Key
    )
    $pattern = '^' + [regex]::Escape($Key) + '=\s*(\d+)\s*$'
    foreach ($line in @($Lines)) {
        if ($line -match $pattern) { return [int]$Matches[1] }
    }
    return -1
}

function Get-W0TreeVerdict {
    param(
        [Parameter(Mandatory = $false)][AllowEmptyCollection()][string[]]$Porcelain
    )
    $tracked = [System.Collections.Generic.List[string]]::new()
    $untracked = [System.Collections.Generic.List[string]]::new()
    foreach ($line in @($Porcelain)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $row = $line.TrimEnd()
        if ($row -match '^\?\?\s+(.*)$') {
            $untracked.Add($Matches[1].Trim())
        } else {
            $tracked.Add($row)
        }
    }
    $pass = $tracked.Count -eq 0
    $warn = $pass -and $untracked.Count -gt 0
    $summary = ''
    if (-not $pass) {
        $summary = "FAIL: tracked changes: $($tracked -join ' | ')"
    } elseif ($warn) {
        $summary = "WARN: untracked only (does not fail): $($untracked -join ', ')"
    }
    [pscustomobject]@{
        Pass      = [bool]$pass
        Warn      = [bool]$warn
        Tracked   = @($tracked)
        Untracked = @($untracked)
        Summary   = $summary
    }
}

function Get-W2SyncVerdict {
    param(
        [Parameter(Mandatory = $true)][int]$SyncExit,
        [Parameter(Mandatory = $true)][int]$Files,
        [Parameter(Mandatory = $true)][int]$ArchiveDirs,
        [Parameter(Mandatory = $true)][int]$SkipSkills,
        [Parameter(Mandatory = $true)][int]$WorkPaths
    )
    $summary = ''
    if ($Files -le 0) {
        $summary = "FAIL: W2 files=$Files; zero inputs is not a pass"
    }
    $pass = ($SyncExit -eq 0) -and ($Files -gt 0) -and ($ArchiveDirs -eq 0) -and ($SkipSkills -eq 0) -and ($WorkPaths -eq 0)
    [pscustomobject]@{
        Pass    = [bool]$pass
        Summary = $summary
    }
}
