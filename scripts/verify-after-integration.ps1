param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'source-scope.ps1')
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$BackupDirectory = (Resolve-Path -LiteralPath $BackupDirectory).Path
& (Join-Path $PSScriptRoot 'verify-frozen-boundaries.ps1') -ProjectRoot $ProjectRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$manifestPath = Join-Path $BackupDirectory 'MANIFEST-BEFORE.csv'
$allowedPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'baseline\ALLOWED-CHANGES.txt'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Backup manifest missing: $manifestPath" }
$before = @{}
foreach ($row in (Import-Csv $manifestPath)) { $before[$row.relative_path] = $row.sha256.ToUpperInvariant() }
$current = @{}
foreach ($row in (Get-KakiScopeManifest -Root $ProjectRoot)) { $current[$row.relative_path] = $row.sha256.ToUpperInvariant() }
$allowed = Get-Content -LiteralPath $allowedPath | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }

function Test-Allowed([string]$Relative) {
    foreach ($pattern in $allowed) {
        $wildcard = $pattern.Trim() -replace '\*\*','*'
        if ($Relative -like $wildcard) { return $true }
    }
    return $false
}

$changes = @()
foreach ($path in (($before.Keys + $current.Keys) | Sort-Object -Unique)) {
    $old = $before[$path]
    $new = $current[$path]
    if ($old -ne $new) {
        $changes += [pscustomobject]@{
            relative_path = $path
            change = if (-not $old) {'added'} elseif (-not $new) {'deleted'} else {'modified'}
            allowed = Test-Allowed $path
            before_sha256 = $old
            after_sha256 = $new
        }
    }
}
$report = Join-Path $BackupDirectory 'CHANGED-FILES-AFTER.csv'
$changes | Export-Csv $report -NoTypeInformation -Encoding UTF8
$outside = @($changes | Where-Object { -not $_.allowed })
if ($outside.Count -gt 0) {
    Write-Error "Changes outside whitelist detected. Stop and rollback. Report: $report"
    exit 3
}
Write-Output 'INTEGRATION_BOUNDARY_OK'
Write-Output "Changed files: $($changes.Count)"
Write-Output "Report: $report"
