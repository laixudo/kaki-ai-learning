param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$Baseline = Join-Path (Split-Path $PSScriptRoot -Parent) 'baseline\FROZEN-FILE-HASHES.csv'
if (-not (Test-Path $Baseline)) { throw "Frozen baseline not found: $Baseline" }

$results = @()
$failed = $false
foreach ($row in (Import-Csv $Baseline)) {
    $relative = $row.relative_path -replace '/', [IO.Path]::DirectorySeparatorChar
    $path = Join-Path $ProjectRoot $relative
    $exists = Test-Path $path -PathType Leaf
    $actual = if ($exists) { (Get-FileHash $path -Algorithm SHA256).Hash.ToUpperInvariant() } else { '' }
    $match = $exists -and ($actual -eq $row.sha256.ToUpperInvariant())
    if (-not $match) { $failed = $true }
    $results += [pscustomobject]@{
        relative_path = $row.relative_path
        exists = $exists
        expected_sha256 = $row.sha256
        actual_sha256 = $actual
        match = $match
    }
}

$report = Join-Path $PSScriptRoot 'FROZEN-BOUNDARY-CHECK.csv'
$results | Export-Csv $report -NoTypeInformation -Encoding UTF8
if ($failed) {
    Write-Error "Frozen boundary mismatch. Do not integrate. Report: $report"
    exit 2
}
Write-Output "FROZEN_BOUNDARIES_OK"
Write-Output "Report: $report"
