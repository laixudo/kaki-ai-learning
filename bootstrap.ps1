param([switch]$SkipFrontend)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = Join-Path $Root '.runtime'
$Venv = Join-Path $Root '.venv311'
$Python = Join-Path $Venv 'Scripts\python.exe'
New-Item -ItemType Directory -Path $Runtime -Force | Out-Null

Write-Host 'Checking Python 3.11...' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $Python)) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) { & py -3.11 -m venv $Venv }
    else {
        $systemPython = Get-Command python -ErrorAction SilentlyContinue
        if (-not $systemPython) { throw 'Python 3.11 is required. Install it from python.org, then run bootstrap.ps1 again.' }
        & python -m venv $Venv
    }
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Python environment.' }
}

Write-Host 'Installing backend dependencies...' -ForegroundColor Cyan
& $Python -m pip install --upgrade pip
& $Python -m pip install -r (Join-Path $Root 'backend\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }

if (-not $SkipFrontend) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer is required. Install the LTS version, then retry.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm was not found on PATH.' }
    $nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
    if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required; found major version $nodeMajor." }
    Write-Host 'Installing frontend dependencies...' -ForegroundColor Cyan
    Push-Location (Join-Path $Root 'frontend')
    try { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' } }
    finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath (Join-Path $Root '.env'))) {
    Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination (Join-Path $Root '.env')
    Write-Host 'Created .env from the safe template. Fill the required secret, admin password and AI provider key before start.' -ForegroundColor Yellow
}
'ready' | Set-Content -LiteralPath (Join-Path $Runtime 'bootstrap.ready') -Encoding utf8
'ready' | Set-Content -LiteralPath (Join-Path $Runtime 'python-dependencies.ready') -Encoding utf8
Write-Host 'Bootstrap complete. Next: edit .env, then run .\start.ps1 -NoBrowser' -ForegroundColor Green
