param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$Baseline = Join-Path (Split-Path $PSScriptRoot -Parent) 'baseline\RUNTIME-REFERENCE-HASHES.csv'
if (-not (Test-Path -LiteralPath $Baseline)) { throw "Runtime baseline not found: $Baseline" }
$results = @()
$failed = $false
foreach ($row in (Import-Csv $Baseline)) {
    $path = Join-Path $ProjectRoot ($row.relative_path -replace '/', [IO.Path]::DirectorySeparatorChar)
    $exists = Test-Path -LiteralPath $path -PathType Leaf
    $actual = if ($exists) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToUpperInvariant() } else { '' }
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
$report = Join-Path $PSScriptRoot 'RUNTIME-REFERENCE-CHECK.csv'
$results | Export-Csv $report -NoTypeInformation -Encoding UTF8
if ($failed) {
    Write-Error "Runtime reference mismatch. The project changed after context collection; do not apply the reference integration guide. Report: $report"
    exit 4
}
Write-Output 'RUNTIME_REFERENCE_OK'
Write-Output "Report: $report"
