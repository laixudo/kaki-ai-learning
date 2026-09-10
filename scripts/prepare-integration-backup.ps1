param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [switch]$IncludeDatabase
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'source-scope.ps1')
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupRoot "NARRATIVE-DIRECTOR-INTEGRATION-$stamp"
$snapshot = Join-Path $backup 'source-snapshot'
New-Item -ItemType Directory -Force -Path $snapshot | Out-Null

Copy-KakiScopedFiles -SourceRoot $ProjectRoot -DestinationRoot $snapshot
$manifest = @(Get-KakiScopeManifest -Root $snapshot | Sort-Object relative_path)
$manifestPath = Join-Path $backup 'MANIFEST-BEFORE.csv'
$manifest | Export-Csv $manifestPath -NoTypeInformation -Encoding UTF8

if ($IncludeDatabase) {
    $dbOut = Join-Path $backup 'database-before'
    New-Item -ItemType Directory -Force -Path $dbOut | Out-Null
    Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Extension.ToLowerInvariant() -in @('.db','.sqlite','.sqlite3') -and
            $_.FullName -notmatch 'node_modules|\\.venv|\\venv|\\cache|\\uploads'
        } |
        ForEach-Object {
            $relative = $_.FullName.Substring($ProjectRoot.Length).TrimStart('\','/') -replace '\\','/'
            $destination = Join-Path $dbOut ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
            New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        }
}

$zip = Join-Path $backup 'project-source-before.zip'
Compress-Archive -Path (Join-Path $snapshot '*') -DestinationPath $zip -CompressionLevel Optimal
@(
    "created_at=$(Get-Date -Format o)",
    "project_root=$ProjectRoot",
    "backup_directory=$backup",
    "scope=all source and configuration files except dependencies, caches, logs, uploads, secrets, archives and databases",
    "zip_sha256=$((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash)",
    "file_count=$($manifest.Count)"
) | Set-Content (Join-Path $backup 'BACKUP-BASELINE.txt') -Encoding UTF8
$backup | Set-Content (Join-Path $PSScriptRoot 'LAST-BACKUP-DIRECTORY.txt') -Encoding UTF8

Write-Output 'INTEGRATION_BACKUP_READY'
Write-Output "BackupDirectory: $backup"
Write-Output "Manifest: $manifestPath"
Write-Output "Zip: $zip"
Write-Output "SourceFileCount: $($manifest.Count)"
