# Run every hook test file in ISOLATION with a bounded timeout.
#
# Why this exists: `npx vitest run` in .claude/hooks never finishes. At least two
# files hang, and a hung vitest worker sits at ~0 CPU indefinitely rather than
# dying -- so the full suite produces no verdict at all, and any change lands
# without a regression signal. This is the only way to get a complete one.
#
# It also survives the two traps that cost real time on 2026-07-29:
#   * a hung run is KILLED with `taskkill /T /F` -- Stop-Process misses the
#     descendant workers, which is how a run from the previous day was still
#     alive 29 hours later at ~0 CPU with a 0-byte output file
#   * per-file, so one hang cannot mask the other 112 results
#
# Baseline 2026-07-29: 99 pass / 12 fail / 2 timeout of 113. Inventory and
# failure classes: docs/harness-strategy/README.md section 1.
#
# Usage:  pwsh -File scripts/hooks/test-bisect.ps1 [-TimeoutMs 45000] [-Filter '<substring>']

param(
  [int]$TimeoutMs = 45000,
  [string]$Filter = ''
)

$ErrorActionPreference = 'Continue'
$repo  = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$hooks = Join-Path $repo '.claude\hooks'
if (-not (Test-Path $hooks)) { Write-Error "hooks dir not found: $hooks"; exit 2 }
Set-Location $hooks

$vitest = Join-Path $hooks 'node_modules\vitest\vitest.mjs'
if (-not (Test-Path $vitest)) { Write-Error "vitest not installed at $vitest"; exit 2 }

$files = Get-ChildItem src/__tests__ -Filter *.test.ts | Sort-Object Name
if ($Filter) { $files = $files | Where-Object { $_.Name -like "*$Filter*" } }

$results = @()
$okCount = 0
foreach ($f in $files) {
  $rel = "src/__tests__/$($f.Name)"
  $out = [System.IO.Path]::GetTempFileName()
  $p = Start-Process -FilePath 'node' `
      -ArgumentList @($vitest, 'run', $rel, '--reporter=dot', '--no-file-parallelism') `
      -WorkingDirectory $hooks -PassThru -NoNewWindow `
      -RedirectStandardOutput $out -RedirectStandardError "$out.err"

  if (-not $p.WaitForExit($TimeoutMs)) {
    # /T /F: kill the whole tree. A plain kill leaves orphaned workers behind.
    & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
    $results += [pscustomobject]@{ File = $f.Name; Status = "TIMEOUT-$([int]($TimeoutMs/1000))s"; Detail = '' }
    Write-Host "TIMEOUT  $($f.Name)" -ForegroundColor Red
  }
  elseif ($p.ExitCode -eq 0) {
    $okCount++
    Write-Host "ok       $($f.Name)" -ForegroundColor DarkGray
  }
  else {
    $txt  = (Get-Content $out -Raw -EA SilentlyContinue) + (Get-Content "$out.err" -Raw -EA SilentlyContinue)
    # "No test suite found" is its own class: the file imports from node:test, so
    # vitest collects nothing. Those cases run under NO runner -- see README.
    $line = ($txt -split "`n" | Where-Object { $_ -match 'Tests\s+\d+ failed|No test suite found|Startup Error' } | Select-Object -First 1)
    $results += [pscustomobject]@{ File = $f.Name; Status = "FAIL(exit $($p.ExitCode))"; Detail = ($line -replace '\s+', ' ').Trim() }
    Write-Host "FAIL     $($f.Name)" -ForegroundColor Yellow
  }
  Remove-Item $out, "$out.err" -Force -EA SilentlyContinue
}

Write-Host ""
Write-Host "=== $okCount pass / $(($results | Where-Object Status -like 'FAIL*').Count) fail / $(($results | Where-Object Status -like 'TIMEOUT*').Count) timeout  of $($files.Count) ==="
if ($results.Count) { $results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host }
exit ($(if ($results.Count) { 1 } else { 0 }))
