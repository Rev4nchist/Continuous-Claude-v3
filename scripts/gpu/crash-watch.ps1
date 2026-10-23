<#
.SYNOPSIS
  Verdict on the GPU-crash mitigation. Read-only.

.DESCRIPTION
  This box bugchecked 8 times in the System log's entire retained window
  (oldest retained event 2026-06-15 08:13, first bugcheck 08:25 - so 8 is a
  floor, not a total). Seven were display-driver: five 0x116 VIDEO_TDR_ERROR
  with identical param3 c000009a, two 0x10E. Crashes cluster in unattended
  hours and the box then sits dead for hours despite AutoReboot=1, i.e. it
  dies idle, not under load. Machine is Modern Standby only (S0 Low Power
  Idle, no S3) on hybrid Intel UHD + NVIDIA T1200.

  On 2026-07-27 exactly ONE thing was changed: PCIe ASPM went from "Maximum
  power savings" (index 2) to "Off" (index 0) on both AC and DC. Fast Startup
  was deliberately left ON so the next crash stays attributable.

  Run this to see whether that worked. Do not call it fixed on vibes.

    Another 0x116 within ~1 week  -> ASPM eliminated, go at the driver.
    14 clear days                 -> ~2% likely if the rate were unchanged.

  Event 153 (recovered TDR) is the faster signal: it fired on 8 separate days
  out of 25 before the change, so it reads in days rather than weeks. If 153
  keeps clustering, ASPM did nothing regardless of whether a bugcheck lands.

.NOTES
  PowerShell 5.1 safe. ASCII only. No writes, no elevation required.
#>

[CmdletBinding()]
param(
  # The moment the ASPM mitigation was applied. MUST be a timestamp, not a date:
  # a bare '2026-07-27' means midnight, which swallows the 07:55 crash that
  # happened BEFORE the change that morning and reports a false FAILED.
  [datetime] $Since = [datetime]'2026-07-27 09:52:00',

  # Pre-mitigation GPU-bugcheck interval, days (6 crashes / 22 days, 07-05..07-27).
  [double] $BaselineIntervalDays = 3.7
)

$ErrorActionPreference = 'Continue'

function Write-Head ($t) { ''; '=== ' + $t + ' ==='; }

# --- 1. is the mitigation still in place? -----------------------------------
Write-Head 'MITIGATION STATE (PCIe ASPM must read 0x00000000)'
$aspm = powercfg /query SCHEME_CURRENT SUB_PCIEXPRESS 2>&1 |
        Select-String -Pattern 'Current AC Power Setting Index|Current DC Power Setting Index'
if ($aspm) {
  $aspm | ForEach-Object { '  ' + $_.Line.Trim() }
  if (($aspm -join ' ') -match '0x00000002') {
    '  WARNING: ASPM is back on Maximum power savings. The mitigation was reverted;'
    '           any clean streak below is NOT evidence.'
  }
} else {
  '  could not read ASPM setting'
}

$fs = try { (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction Stop).HiberbootEnabled } catch { 'unreadable' }
'  Fast Startup (HiberbootEnabled): ' + $fs + '   (expected 1 - intentionally untouched)'

# --- 2. bugchecks ------------------------------------------------------------
Write-Head 'BUGCHECKS (full retained history)'
$bugs = @(Get-WinEvent -FilterHashtable @{
  LogName      = 'System'
  ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'
  Id           = 1001
} -ErrorAction SilentlyContinue)

if (-not $bugs) {
  '  none logged (or the System log rolled over)'
} else {
  foreach ($b in ($bugs | Sort-Object TimeCreated)) {
    $code = if ($b.Message -match 'bugcheck was: (0x[0-9a-fA-F]+)') { $matches[1] } else { '?' }
    $dmp  = if ($b.Message -match 'A dump was saved in: (\S+?\.dmp)')  { $matches[1] } else { 'NO DUMP' }
    $flag = if ($b.TimeCreated -ge $Since) { '  <-- POST-MITIGATION' } else { '' }
    '  {0:yyyy-MM-dd HH:mm}  {1}  {2}{3}' -f $b.TimeCreated, $code, $dmp, $flag
  }
  ''
  '  NOTE: times above are the REBOOT, not the crash. The crash time is in'
  '        System event 6008 ("previous system shutdown at ... was unexpected").'
}

# GPU-only bugchecks are the ones this mitigation targets.
$gpu = @($bugs | Where-Object { $_.Message -match 'bugcheck was: 0x00000116|bugcheck was: 0x0000010e' })
$gpuSince = @($gpu | Where-Object { $_.TimeCreated -ge $Since })

# --- 3. recovered TDRs, the faster signal -----------------------------------
Write-Head 'RECOVERED TDRs (nvlddmkm 153) SINCE MITIGATION'
$tdr = @(Get-WinEvent -FilterHashtable @{
  LogName      = 'System'
  ProviderName = 'nvlddmkm'
  Id           = 153
  StartTime    = $Since
} -ErrorAction SilentlyContinue)

if (-not $tdr) {
  '  none since {0:yyyy-MM-dd HH:mm}. Good sign, and it arrives faster than a bugcheck.' -f $Since
} else {
  $tdr | Group-Object { $_.TimeCreated.ToString('yyyy-MM-dd') } |
    Sort-Object Name | ForEach-Object { '  {0}  {1} event(s)' -f $_.Name, $_.Count }
  ''
  '  Baseline was 153s on 8 separate days out of 25. Compare days-with-events,'
  '  not raw counts - they fire in bursts.'
}

# --- 4. verdict --------------------------------------------------------------
Write-Head 'VERDICT'
$elapsed = ((Get-Date) - $Since).TotalDays
'  {0:N1} days since the ASPM change.' -f $elapsed

if ($gpuSince.Count -gt 0) {
  '  FAILED: {0} GPU bugcheck(s) since the change.' -f $gpuSince.Count
  '  ASPM is ELIMINATED as the cause. Next lever is the NVIDIA driver'
  '  (32.0.15.8195, 2025-11-17, unchanged across every crash so far - so this'
  '  is not an upgrade regression). T1200 is professional-class, so the branch'
  '  matters: Dell OEM vs NVIDIA enterprise. Machine-wide change - confirm first.'
} elseif ($elapsed -ge 14) {
  $p = [math]::Exp(-$elapsed / $BaselineIntervalDays) * 100
  '  PASSES the bar: {0:N1} clear days, ~{1:N1}% likely if the rate were unchanged.' -f $elapsed, $p
  if ($tdr.Count -gt 0) {
    '  BUT event 153 is still firing, so the driver is still unstable - ASPM may'
    '  have suppressed the bugcheck without fixing the fault. Do not close this.'
  } else {
    '  And zero recovered TDRs. Strongest read available short of a dump.'
  }
} else {
  '  TOO EARLY. Need 14 clear days; {0:N1} to go.' -f (14 - $elapsed)
  '  A 0x116 before then eliminates ASPM. Re-run this instead of guessing.'
}

# --- 5. the dumps ------------------------------------------------------------
Write-Head 'DUMPS'
'  C:\Windows\Minidump is NOT readable unelevated - Get-ChildItem prints'
'  Access-denied and returns count 0, which reads as "empty". It is not empty.'
'  MinidumpsCount=5 with Overwrite=1, so each new crash destroys an older dump.'
'  Rescue them from an ELEVATED shell:'
'    Copy-Item -Path C:\Windows\Minidump\*.dmp -Destination $env:USERPROFILE\.claude\logs\minidumps\ -Force -PassThru'
$dest = (Join-Path $env:USERPROFILE '.claude\logs\minidumps')
if (Test-Path $dest) {
  $saved = @(Get-ChildItem $dest -Filter *.dmp -ErrorAction SilentlyContinue)
  '  rescued so far: {0} dmp file(s) in {1}' -f $saved.Count, $dest
  $saved | ForEach-Object { '    {0}  {1:N0} KB' -f $_.Name, ($_.Length / 1KB) }
}
''
