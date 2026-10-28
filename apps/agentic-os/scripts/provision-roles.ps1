#Requires -Version 7.2
<#
.SYNOPSIS
  Create the agentic_os_app and agentic_os_indexer roles in the CCv3 Postgres container.

.DESCRIPTION
  Default is a dry run: the SQL runs, prints the effective grants, then ROLLBACK.
  -Apply commits, then writes apps/agentic-os/.env.local if that file does not exist.
  Passwords are random per run. They go to psql on stdin only: never in an argument
  list, never printed, never on disk except inside .env.local.

.EXAMPLE
  pwsh -File apps/agentic-os/scripts/provision-roles.ps1            # dry run
  pwsh -File apps/agentic-os/scripts/provision-roles.ps1 -Apply     # commit
#>
[CmdletBinding(DefaultParameterSetName = 'DryRun')]
param(
  [Parameter(ParameterSetName = 'DryRun')][switch]$DryRun,
  [Parameter(ParameterSetName = 'Apply', Mandatory)][switch]$Apply
)
$ErrorActionPreference = 'Stop'

$docker  = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$sqlFile = Join-Path $PSScriptRoot 'provision-roles.sql'
$envFile = Join-Path $PSScriptRoot '..\.env.local'

if (-not (Test-Path $docker))  { throw "docker.exe not found: $docker" }
if (-not (Test-Path $sqlFile)) { throw "SQL file not found: $sqlFile" }
# Re-running resets both passwords. Refuse before the DB changes if the file would not be written.
if ($Apply -and (Test-Path $envFile)) {
  throw "$([IO.Path]::GetFullPath($envFile)) already exists. Refusing: -Apply would rotate passwords the file no longer matches. Move the file first."
}

# Same host port as docker/docker-compose.yml: POSTGRES_PORT, default 5432. Checked before any
# DB call: a bad value must not leave committed passwords with no .env.local to hold them.
$port = if ($env:POSTGRES_PORT) { $env:POSTGRES_PORT } else { '5432' }
if ($port -notmatch '^\d{1,5}$' -or [int]$port -lt 1 -or [int]$port -gt 65535) {
  throw "POSTGRES_PORT is not a port number from 1 to 65535: $port"
}

function New-Password {
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# psql \set value: single-quoted, so double the quote and the backslash.
function ConvertTo-PsqlLiteral([string]$Value) {
  "'" + $Value.Replace('\', '\\').Replace("'", "''") + "'"
}

$appPw     = New-Password
$indexerPw = New-Password
$finish    = if ($Apply) { 'COMMIT' } else { 'ROLLBACK' }

$stdin = @(
  "\set app_pw $(ConvertTo-PsqlLiteral $appPw)"
  "\set indexer_pw $(ConvertTo-PsqlLiteral $indexerPw)"
  "\set finish $finish"
  (Get-Content -Raw $sqlFile)
) -join "`n"

Write-Host ("[provision-roles] mode: {0}" -f $(if ($Apply) { 'APPLY (commit)' } else { 'DRY RUN (rollback)' }))

# VERBOSITY=terse keeps psql from echoing the failing statement, which holds a password.
$output = $stdin | & $docker exec -i continuous-claude-postgres psql -U claude -d continuous_claude `
  -v ON_ERROR_STOP=1 -v VERBOSITY=terse 2>&1
$exitCode = $LASTEXITCODE

# Belt and braces: mask both passwords in anything shown.
$output | ForEach-Object { "$_".Replace($appPw, '***').Replace($indexerPw, '***') } | Write-Host
if ($exitCode -ne 0) { throw "psql exited $exitCode. Nothing was committed." }

if (-not $Apply) {
  Write-Host '[provision-roles] dry run finished: rolled back, no roles created, no file written.'
  return
}

$lines = @(
  "AGENTIC_OS_DATABASE_URL=postgresql://agentic_os_app:$appPw@127.0.0.1:$port/continuous_claude"
  "AGENTIC_OS_INDEXER_DATABASE_URL=postgresql://agentic_os_indexer:$indexerPw@127.0.0.1:$port/continuous_claude"
)
# The file holds passwords: no inherited access, only the account that runs this script.
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow'))
# CreateNew fails if the file appeared since the check above: it never overwrites.
# The ACL is applied at creation, so the passwords are never written under the default ACL.
$stream = [IO.FileSystemAclExtensions]::Create(
  [IO.FileInfo]::new([IO.Path]::GetFullPath($envFile)), [IO.FileMode]::CreateNew,
  [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $acl)
try {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($lines -join "`n") + "`n")
  $stream.Write($bytes, 0, $bytes.Length)
} finally { $stream.Dispose() }
Write-Host "[provision-roles] committed. Wrote $([IO.Path]::GetFullPath($envFile)) (values not shown)."
