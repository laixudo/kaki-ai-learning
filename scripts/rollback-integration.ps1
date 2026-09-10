param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [switch]$ConfirmRollback,
    [switch]$RestoreDatabase
)

$ErrorActionPreference = 'Stop'
if (-not $ConfirmRollback) { throw 'Rollback requires -ConfirmRollback' }
. (Join-Path $PSScriptRoot 'source-scope.ps1')
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$BackupDirectory = (Resolve-Path -LiteralPath $BackupDirectory).Path
$snapshot = Join-Path $BackupDirectory 'source-snapshot'
$manifestPath = Join-Path $BackupDirectory 'MANIFEST-BEFORE.csv'
if (-not (Test-Path -LiteralPath $snapshot)) { throw "Snapshot missing: $snapshot" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Manifest missing: $manifestPath" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$failed = Join-Path $BackupDirectory "failed-state-before-rollback-$stamp"
New-Item -ItemType Directory -Force -Path $failed | Out-Null
Copy-KakiScopedFiles -SourceRoot $ProjectRoot -DestinationRoot $failed

$before = @{}
foreach ($row in (Import-Csv $manifestPath)) { $before[$row.relative_path] = $row.sha256.ToUpperInvariant() }
$current = @{}
foreach ($row in (Get-KakiScopeManifest -Root $ProjectRoot)) { $current[$row.relative_path] = $row.sha256.ToUpperInvariant() }

# Remove source/configuration files added during the failed integration. Excluded data directories and databases are untouched.
foreach ($relative in $current.Keys) {
    if (-not $before.ContainsKey($relative)) {
        $path = Join-Path $ProjectRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
    }
}

# Restore every pre-integration source/configuration file.
foreach ($relative in $before.Keys) {
    $source = Join-Path $snapshot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    $destination = Join-Path $ProjectRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Snapshot file missing: $relative" }
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

$failedHashes = @()
foreach ($row in (Get-KakiScopeManifest -Root $ProjectRoot)) {
    $expected = $before[$row.relative_path]
    if (-not $expected -or $row.sha256.ToUpperInvariant() -ne $expected) {
        $failedHashes += $row.relative_path
    }
}
if ($failedHashes.Count -gt 0) { throw "Rollback verification failed: $($failedHashes -join ', ')" }

if ($RestoreDatabase) {
    $dbDir = Join-Path $BackupDirectory 'database-before'
    if (-not (Test-Path -LiteralPath $dbDir)) { throw 'Database backup not present' }
    throw 'Database restore is intentionally manual. Review database-before and the failed state before restoring data.'
}

Write-Output 'ROLLBACK_COMPLETE'
Write-Output "FailedStateSavedTo: $failed"
Write-Output "RestoredSourceFiles: $($before.Count)"
