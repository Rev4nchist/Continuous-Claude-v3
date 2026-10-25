# A path under skills/synced/<id>/ is a Claude app skill-sync copy.
# The installer does not own it. Both separators are accepted.

function Test-PruneManagedSyncPath {
    param([Parameter(Mandatory = $false)][AllowEmptyString()][string]$Tail)
    if ([string]::IsNullOrEmpty($Tail)) { return $false }
    $norm = $Tail -replace '\\', '/'
    # Anchored at the start so skills/kept/skills/synced/... is still a leftover.
    return [bool]($norm -match '^/?skills/synced/[^/]+(/|$)')
}
