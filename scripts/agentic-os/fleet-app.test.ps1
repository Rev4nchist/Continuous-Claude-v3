# End-to-end check of start-fleet, stop-fleet and install-fleet-shortcut. Runs the real scripts on ports 3012 and 3013.
# Needs the app folder with node_modules and .env.local. Pass -AppDir when you run it from a worktree.
# Never touches port 3010. Run: pwsh -File scripts/agentic-os/fleet-app.test.ps1 [-AppDir <path>]
param([string]$AppDir = '')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
. (Join-Path $here 'fleet-app-lib.ps1')

$fail = 0; $pass = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host "PASS  $name"; $script:pass++ } else { Write-Host "FAIL  $name"; $script:fail++ }
}
function Run([string]$script, [string[]]$more) {
  $a = @('-NoProfile', '-File', (Join-Path $here $script)) + $more
  $out = & pwsh @a 2>&1 | Out-String
  return @{ Code = $LASTEXITCODE; Out = $out }
}

$app = Get-FleetAppDir $AppDir
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("fleet-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
$state = Join-Path $tmp 'state'; $lnks = Join-Path $tmp 'lnk'
$port = 3012; $decoyPort = 3013
$common = @('-Port', "$port", '-AppDir', $app, '-StateDir', $state)
$decoy = $null
$mayStop = $false   # the cleanup stops port $port only after the busy-port guard passed

try {
  if ((Get-PortOwnerPid $port) -ne 0 -or (Get-PortOwnerPid $decoyPort) -ne 0) { throw "ports $port/$decoyPort are busy; free them first" }
  # Next 16 allows one dev server per app folder. A running Fleet app on any port makes the start step fail.
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ([string]$_.CommandLine).IndexOf((Join-Path $app 'node_modules\next\dist\bin\next'), [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  if ($running.Count -gt 0) { throw "SKIP: a Fleet app already runs from $app (pid $($running[0].ProcessId)). Stop it with stop-fleet.ps1, then run this test." }

  $mayStop = $true

  # sibling folder: a path that only shares the prefix is not a Fleet process
  $sib = [pscustomobject]@{ Name = 'node.exe'; CommandLine = "node $app-old\node_modules\next\dist\bin\next dev" }
  $own = [pscustomobject]@{ Name = 'node.exe'; CommandLine = "node $app\node_modules\next\dist\bin\next dev" }
  Check 'a sibling folder with the same prefix is not Fleet' (-not (Test-IsFleetProcess $sib $app))
  Check 'a process inside the app folder is Fleet' (Test-IsFleetProcess $own $app)

  # pid reuse: a "parent" that started after its child is a reused id and must be rejected
  $old = [pscustomobject]@{ CreationDate = [datetime]'2026-01-01T10:00:00' }
  $new = [pscustomobject]@{ CreationDate = [datetime]'2026-01-01T10:05:00' }
  Check 'a parent that started before its child is real' (Test-IsRealParent $old $new)
  Check 'a parent that started after its child is a reused id' (-not (Test-IsRealParent $new $old))
  Check 'a missing parent is not real' (-not (Test-IsRealParent $null $new))

  # install: two shortcuts that point at the real scripts; a second run keeps two; -Remove deletes both
  $r = Run 'install-fleet-shortcut.ps1' @('-Dir', $lnks)
  $sh = New-Object -ComObject WScript.Shell
  $startLnk = $sh.CreateShortcut((Join-Path $lnks 'Fleet.lnk'))
  $stopLnk = $sh.CreateShortcut((Join-Path $lnks 'Fleet - stop.lnk'))
  Check 'install writes Fleet.lnk to start-fleet.ps1' ($r.Code -eq 0 -and $startLnk.Arguments -like '*start-fleet.ps1*')
  Check 'install writes Fleet - stop.lnk to stop-fleet.ps1' ($stopLnk.Arguments -like '*stop-fleet.ps1*')
  Run 'install-fleet-shortcut.ps1' @('-Dir', $lnks) | Out-Null
  Check 'install twice keeps exactly two shortcuts' ((Get-ChildItem $lnks -Filter *.lnk).Count -eq 2)
  Run 'install-fleet-shortcut.ps1' @('-Dir', $lnks, '-Remove') | Out-Null
  Check 'install -Remove deletes both' ((Get-ChildItem $lnks -Filter *.lnk).Count -eq 0)

  # start: the app answers and a pid file exists
  $r = Run 'start-fleet.ps1' ($common + @('-NoWindow'))
  $owner1 = Get-PortOwnerPid $port
  $http = try { (Invoke-WebRequest "http://localhost:$port" -UseBasicParsing -TimeoutSec 20).StatusCode } catch { 0 }
  Check 'start exits 0' ($r.Code -eq 0)
  Check 'start: the page answers 200' ($http -eq 200)
  Check 'start writes the pid file' (Test-Path (Join-Path $state "fleet-app-$port.pid"))
  Check 'the port owner is a Fleet process' (Test-IsFleetProcess (Get-ProcInfo $owner1) $app)

  # start again: reuse, no second server
  $r = Run 'start-fleet.ps1' ($common + @('-NoWindow'))
  Check 'second start exits 0 and says already running' ($r.Code -eq 0 -and $r.Out -match 'already running')
  Check 'second start keeps the same port owner' ((Get-PortOwnerPid $port) -eq $owner1)

  # stop: port free, processes gone
  $set = @(Get-FleetProcessSet $owner1 $app)
  $r = Run 'stop-fleet.ps1' $common
  Check 'stop exits 0' ($r.Code -eq 0)
  Check 'stop frees the port' ((Get-PortOwnerPid $port) -eq 0)
  Check 'stop ended every Fleet process it found' (@($set | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -eq 0)
  Check 'stop removes the pid file' (-not (Test-Path (Join-Path $state "fleet-app-$port.pid")))

  # stop again: nothing to stop
  $r = Run 'stop-fleet.ps1' $common
  Check 'stop when not running exits 0' ($r.Code -eq 0 -and $r.Out -match 'not running')

  # decoy: a non-Fleet program holds the port. Start and stop must leave it alone.
  $decoy = Start-Process pwsh -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-Command', "`$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$decoyPort);`$l.Start();Start-Sleep 120")
  $until = (Get-Date).AddSeconds(15)
  while ((Get-PortOwnerPid $decoyPort) -eq 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 200 }
  $dcommon = @('-Port', "$decoyPort", '-AppDir', $app, '-StateDir', $state)
  $r = Run 'start-fleet.ps1' ($dcommon + @('-NoWindow'))
  Check 'start refuses a port held by another program (exit 2)' ($r.Code -eq 2)
  $r = Run 'stop-fleet.ps1' $dcommon
  Check 'stop refuses a port held by another program (exit 2)' ($r.Code -eq 2)
  Check 'the decoy is still alive' ($null -ne (Get-Process -Id $decoy.Id -ErrorAction SilentlyContinue))

  # not ready: an app folder without node_modules
  $empty = Join-Path $tmp 'empty-app'; New-Item -ItemType Directory -Force $empty | Out-Null
  $r = Run 'start-fleet.ps1' @('-Port', "$port", '-AppDir', $empty, '-StateDir', $state, '-NoWindow')
  Check 'start with a missing install exits 3 and names the fix' ($r.Code -eq 3 -and $r.Out -match 'NOT READY')
}
finally {
  if ($mayStop) { Run 'stop-fleet.ps1' $common | Out-Null }
  if ($decoy) { Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "`n$pass passed, $fail failed"
exit ([int]($fail -gt 0))
