<#
.SYNOPSIS
  Windows toast for the harness doctor. FAIL only, once per changed fail set.

.WHY
  The session-start line (hooks/src/shared/health-alert.ts) is the primary signal. This toast is
  the optional second channel for a FAIL that appears while Dave works. It uses the built-in
  WinRT toast API, so nothing needs installing (BurntToast is not installed). It works only in
  a logged-on session, which is how the scheduled health task runs.

.WHAT IT DOES
  1. Reads the doctor report (default ~/.claude/state/health/latest.json).
  2. Collects the checks whose status is FAIL. WARN never toasts.
  3. Hashes the sorted "section:check" names. If the hash equals the one in the state file
     (default ~/.claude/state/health/last-toast.txt), it stays quiet.
  4. Otherwise it shows one toast and stores the hash.
  5. With no FAIL it clears the stored hash, so a FAIL that comes back toasts again.

  -DryRun prints "TOAST: <title> | <message>" or "NO TOAST: <reason>" and shows nothing. It still
  updates the state file, so point -StateFile at a temp file when you test.
  It never throws and always exits 0: a broken toast must not fail the health task.
  PowerShell 5.1 compatible (Task Scheduler runs powershell.exe), ASCII only.
  scheduled-health-check.bat calls it after each doctor run (D6).
#>
param(
  [string]$Latest = '',
  [string]$StateFile = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Get-HealthDir {
  Join-Path (Join-Path $env:USERPROFILE '.claude') (Join-Path 'state' 'health')
}

function Get-FailNames($doc) {
  $names = @()
  foreach ($c in @($doc.checks)) {
    if ($null -ne $c -and ([string]$c.status).ToUpper() -eq 'FAIL') {
      $names += ('{0}:{1}' -f $c.section, $c.check)
    }
  }
  return @($names | Sort-Object)
}

function Get-Hash([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
}

function Show-Toast([string]$title, [string]$message) {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $xml.GetElementsByTagName('text')
  [void]$texts.Item(0).AppendChild($xml.CreateTextNode($title))
  [void]$texts.Item(1).AppendChild($xml.CreateTextNode($message))
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
}

function Set-State([string]$file, [string]$value) {
  $dir = Split-Path -Parent $file
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -LiteralPath $file -Value $value -Encoding ASCII
}

try {
  $health = Get-HealthDir
  if (-not $Latest) { $Latest = Join-Path $health 'latest.json' }
  if (-not $StateFile) { $StateFile = Join-Path $health 'last-toast.txt' }

  if (-not (Test-Path -LiteralPath $Latest -PathType Leaf)) { Write-Output "NO TOAST: no report at $Latest"; exit 0 }
  $doc = Get-Content -LiteralPath $Latest -Raw | ConvertFrom-Json
  $fails = Get-FailNames $doc

  if ($fails.Count -eq 0) {
    if (Test-Path -LiteralPath $StateFile) { Set-State $StateFile '' }
    Write-Output 'NO TOAST: no FAIL in the report'
    exit 0
  }

  $hash = Get-Hash ($fails -join "`n")
  $last = ''
  if (Test-Path -LiteralPath $StateFile) { $last = (Get-Content -LiteralPath $StateFile -Raw) }
  if ($last -and $last.Trim() -eq $hash) { Write-Output 'NO TOAST: this fail set was already shown'; exit 0 }

  $title = 'CCv3 harness: {0} FAIL' -f $fails.Count
  $shown = ($fails | Select-Object -First 3) -join ', '
  $message = if ($fails.Count -gt 3) { '{0} and {1} more. Run: node scripts/harness-doctor.mjs' -f $shown, ($fails.Count - 3) }
             else { '{0}. Run: node scripts/harness-doctor.mjs' -f $shown }

  if ($DryRun) { Write-Output "TOAST: $title | $message" } else { Show-Toast $title $message }
  Set-State $StateFile $hash
} catch {
  Write-Output ('NO TOAST: error: ' + $_.Exception.Message)
}
exit 0
