# Account routing with personal as the only account.
# Parses the readers. Does not call gh.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
. (Join-Path $here 'accounts-lib.ps1')

$fail = 0
$pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ }
  else { Write-Host "FAIL  $name"; $script:fail++ }
}

$cfg = Get-AccountsConfig
$names = @($cfg.accounts.PSObject.Properties.Name)
Check 'only account is personal' ($names.Count -eq 1 -and $names[0] -eq 'personal')
Check 'personal user is Rev4nchist' ($cfg.accounts.personal.user -eq 'Rev4nchist')
Check 'default owner maps to personal' ($cfg.authByOwner._default -eq 'personal')

$badMap = @()
foreach ($prop in $cfg.authByOwner.PSObject.Properties) {
  if (-not $cfg.accounts.PSObject.Properties.Name.Contains([string]$prop.Value)) {
    $badMap += "$($prop.Name)->$($prop.Value)"
  }
}
Check 'every authByOwner value names a defined account' ($badMap.Count -eq 0)

$badRoute = @($cfg.routes | Where-Object { $_.commitAccount -ne 'personal' })
Check 'every route is personal' ($badRoute.Count -eq 0)
Check 'the personal catch-all route is present' (@($cfg.routes | Where-Object { $_.prefix -eq 'C:/Users/dkhay' }).Count -eq 1)

Check 'an unmapped owner falls back to personal' ((Get-AccountNameForOwner $cfg 'fourth') -eq 'personal')
Check 'a dkhay path uses the personal route' ((Get-AccountNameForPath $cfg 'C:/Users/dkhay/Projects/anything') -eq 'personal')

$missingThrew = $false
try { Get-AccountByName $cfg 'work' | Out-Null } catch { $missingThrew = $true }
Check 'a missing work account is refused' $missingThrew

$readers = @(
  'accounts-lib.ps1',
  'verify-github-accounts.ps1',
  'apply-commit-identity.ps1',
  'transfer-repo.ps1',
  'gh-for.ps1',
  'git-for.ps1',
  'gh-shim.ps1'
)
foreach ($name in $readers) {
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $here $name), [ref]$null, [ref]$errs)
  Check "parse $name" (-not $errs -or $errs.Count -eq 0)
}

$plan = & pwsh -NoProfile -File (Join-Path $here 'apply-commit-identity.ps1') 2>&1
Check 'apply-commit-identity exits 0' ($LASTEXITCODE -eq 0)
Check 'apply-commit-identity stays on personal' (($plan -join "`n") -match 'personal only')

$xfer = & pwsh -NoProfile -File (Join-Path $here 'transfer-repo.ps1') -Repo example 2>&1
Check 'transfer-repo refuses without a work account' ($LASTEXITCODE -ne 0)
Check 'transfer-repo names the missing account' (($xfer -join "`n") -match 'no work account')

Write-Host "passed=$pass failed=$fail"
if ($fail) { exit 1 }
exit 0
