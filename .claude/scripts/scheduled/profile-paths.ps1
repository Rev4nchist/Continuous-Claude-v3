# Resolve harness paths from machine/<profile>.json.
# Dot-source from scheduled scripts. ASCII only (Windows PowerShell 5.1).
# No profile: warn and use the home directory plus this checkout.

function Get-Ccv3Paths {
  $home = $env:USERPROFILE
  if (-not $home) { $home = $env:HOME }
  $name = $env:CCV3_MACHINE_PROFILE
  $state = Join-Path $home '.claude\state\machine-profile'
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
  if (-not $repo) { $repo = Join-Path $home 'continuous-claude' }

  $profile = $null
  if ($name) {
    $candidates = @(
      (Join-Path $repo "machine\$name.json"),
      (Join-Path $home ".claude\machine\$name.json")
    )
    foreach ($candidate in $candidates) {
      if (Test-Path -LiteralPath $candidate) {
        $profile = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
        break
      }
    }
    if (-not $profile) {
      Write-Warning "machine profile '$name' was selected but no JSON was found; using home-directory defaults"
    }
  } else {
    Write-Warning "no machine profile selected; using home-directory defaults"
  }

  $gitBash = 'C:\Program Files\Git\bin\bash.exe'
  if ($profile -and $profile.gitBash) { $gitBash = $profile.gitBash }
  $userHome = $home
  if ($profile -and $profile.userHome) { $userHome = $profile.userHome }
  $repoRoot = $repo
  if ($profile -and $profile.repoRoot) { $repoRoot = $profile.repoRoot }
  $claudeHome = Join-Path $userHome '.claude'
  if ($profile -and $profile.claudeHome) { $claudeHome = $profile.claudeHome }
  $opcDir = Join-Path $repoRoot 'opc'
  if ($profile -and $profile.opcDir) { $opcDir = $profile.opcDir }

  return [pscustomobject]@{
    ProfileName = $(if ($profile) { $name } else { '' })
    UserHome = $userHome
    RepoRoot = $repoRoot
    ClaudeHome = $claudeHome
    OpcDir = $opcDir
    GitBash = $gitBash
  }
}
