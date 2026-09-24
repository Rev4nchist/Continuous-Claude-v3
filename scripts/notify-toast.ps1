# Show a Windows toast notification (no module needed). Run with Windows PowerShell 5.1:
#   powershell.exe -NoProfile -File scripts\notify-toast.ps1 -Title "..." -Body "..."
# Uses the WinRT toast API under PowerShell's own app id. Exit 0 = shown, 1 = the API refused.
# If a toast cannot be shown (policy, focus assist), msg.exe to the current session is the fallback.
param(
  [Parameter(Mandatory)] [string] $Title,
  [Parameter(Mandatory)] [string] $Body
)
$ErrorActionPreference = 'Stop'
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $esc = { param($s) [Security.SecurityElement]::Escape($s) }
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$(& $esc $Title)</text><text>$(& $esc $Body)</text></binding></visual></toast>")
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  exit 0
} catch {
  try { & msg.exe $env:USERNAME "$Title`n$Body"; exit 0 } catch { Write-Output "notify-toast: could not notify ($($_.Exception.Message))"; exit 1 }
}
