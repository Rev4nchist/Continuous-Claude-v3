# Resolve harness paths from machine/<profile>.json.
# Dot-source from scheduled scripts. ASCII only (Windows PowerShell 5.1).
# No profile: warn and use the home directory plus this checkout.

function Get-Ccv3Paths {
  # $HOME and $PROFILE are read-only automatic variables. Do not assign them.
  $ccvHome = $env:USERPROFILE
  if (-not $ccvHome) { $ccvHome = $env:HOME }
  $name = $env:CCV3_MACHINE_PROFILE
  $state = Join-Path $ccvHome '.claude\state\machine-profile'
  if (-not $name -and (Test-Path -LiteralPath $state)) {
    $name = (Get-Content -LiteralPath $state -Raw).Trim()
  }

  $repo = $env:CCV3_REPO_ROOT
  if (-not $repo) {
    $dir = $PSScriptRoot
    while ($dir) {
      if (Test-Path (Join-Path $dir 'machine')) { $repo = $dir; break }
      $parent = Split-Path $dir -Parent
      if (-not $parent -or $parent -eq $dir) { break }
      $dir = $parent
    }
  }
  if (-not $repo) { $repo = Join-Path $ccvHome 'continuous-claude' }

  $ccvProfile = $null
  if ($name) {
    $candidates = @(
      (Join-Path $repo "machine\$name.json"),
      (Join-Path $ccvHome ".claude\machine\$name.json")
    )
    foreach ($candidate in $candidates) {
      if (Test-Path -LiteralPath $candidate) {
        $ccvProfile = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
        break
      }
    }
    if (-not $ccvProfile) {
      Write-Warning "machine profile '$name' was selected but no JSON was found; using home-directory defaults"
    }
  } else {
    Write-Warning "no machine profile selected; using home-directory defaults"
  }

  $gitBash = 'C:\Program Files\Git\bin\bash.exe'
  if ($ccvProfile -and $ccvProfile.gitBash) { $gitBash = $ccvProfile.gitBash }
  $userHome = $ccvHome
  if ($ccvProfile -and $ccvProfile.userHome) { $userHome = $ccvProfile.userHome }
  $repoRoot = $repo
  if ($ccvProfile -and $ccvProfile.repoRoot) { $repoRoot = $ccvProfile.repoRoot }
  $claudeHome = Join-Path $userHome '.claude'
  if ($ccvProfile -and $ccvProfile.claudeHome) { $claudeHome = $ccvProfile.claudeHome }
  $opcDir = Join-Path $repoRoot 'opc'
  if ($ccvProfile -and $ccvProfile.opcDir) { $opcDir = $ccvProfile.opcDir }

  return [pscustomobject]@{
    ProfileName = $(if ($ccvProfile) { $name } else { '' })
    UserHome = $userHome
    RepoRoot = $repoRoot
    ClaudeHome = $claudeHome
    OpcDir = $opcDir
    GitBash = $gitBash
  }
}
