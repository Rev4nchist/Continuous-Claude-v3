<#
.SYNOPSIS
  Windows toast for a fired lane reminder (called by scripts/coordination/reminder-tick.mjs).

.DESCRIPTION
  Shows one toast with -Title and -Message. It uses the built-in WinRT toast API, the same way
  health-toast.ps1 does, so nothing needs installing. It works only in a logged-on session.
  -DryRun prints "TOAST: <title> | <message>" and shows nothing (tests use it).
  It never throws and always exits 0: a broken toast must not change the tick exit code.
  On an error it prints "NO TOAST: error: <text>".
  PowerShell 5.1 compatible (Task Scheduler runs powershell.exe), ASCII only.
#>
param(
  [string]$Title = '',
  [string]$Message = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

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

try {
  if ($DryRun) { Write-Output "TOAST: $Title | $Message" } else { Show-Toast $Title $Message }
} catch {
  Write-Output ('NO TOAST: error: ' + $_.Exception.Message)
}
exit 0
