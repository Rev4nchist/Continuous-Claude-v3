# A path under skills/synced/<id>/ is a Claude app skill-sync copy.
# The installer does not own it. Both separators are accepted.

function Test-PruneManagedSyncPath {
    param([Parameter(Mandatory = $false)][AllowEmptyString()][string]$Tail)
    if ([string]::IsNullOrEmpty($Tail)) { return $false }
    $norm = $Tail -replace '\\', '/'
    return [bool]($norm -match '(^|/)skills/synced/[^/]+/')
}
