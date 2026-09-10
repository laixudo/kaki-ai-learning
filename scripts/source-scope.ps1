$script:KakiExcludedDirectoryNames = @(
    '.git','node_modules','.venv','venv','env','__pycache__','.pytest_cache',
    '.mypy_cache','.ruff_cache','.tox','.nox','.idea','.vscode','.vite',
    'dist','build','coverage','htmlcov','logs','log','uploads','upload',
    'user_uploads','tmp','temp','cache','caches','backups'
)
$script:KakiExcludedFileNames = @(
    '.env','.env.local','.env.development','.env.production','.env.test'
)
$script:KakiExcludedExtensions = @(
    '.pyc','.pyo','.log','.db','.sqlite','.sqlite3','.tmp','.bak','.zip','.7z','.rar'
)

function Get-KakiScopedFiles {
    param([Parameter(Mandatory = $true)][string]$Root)

    $rootPath = (Resolve-Path -LiteralPath $Root).Path
    Get-ChildItem -LiteralPath $rootPath -Recurse -File -Force -ErrorAction Stop |
        Where-Object {
            if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\','/')
            $segments = $relative -split '[\\/]'
            if ($segments.Count -gt 1) {
                foreach ($segment in $segments[0..($segments.Count - 2)]) {
                    if ($script:KakiExcludedDirectoryNames -contains $segment) { return $false }
                }
            }
            if ($script:KakiExcludedFileNames -contains $_.Name) { return $false }
            if ($script:KakiExcludedExtensions -contains $_.Extension.ToLowerInvariant()) { return $false }
            return $true
        } |
        ForEach-Object {
            [pscustomobject]@{
                FullName = $_.FullName
                RelativePath = ($_.FullName.Substring($rootPath.Length).TrimStart('\','/') -replace '\\','/')
                Size = $_.Length
                ModifiedAt = $_.LastWriteTimeUtc.ToString('o')
            }
        }
}

function Copy-KakiScopedFiles {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )
    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    foreach ($file in (Get-KakiScopedFiles -Root $SourceRoot)) {
        $destination = Join-Path $DestinationRoot ($file.RelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)
        $parent = Split-Path $destination -Parent
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
}

function Get-KakiScopeManifest {
    param([Parameter(Mandatory = $true)][string]$Root)
    foreach ($file in (Get-KakiScopedFiles -Root $Root)) {
        [pscustomobject]@{
            relative_path = $file.RelativePath
            size = $file.Size
            modified_at = $file.ModifiedAt
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
        }
    }
}
