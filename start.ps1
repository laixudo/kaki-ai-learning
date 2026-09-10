param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = Join-Path $Root ".runtime"
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Python = Join-Path $Root ".venv311\Scripts\python.exe"

New-Item -ItemType Directory -Path $Runtime -Force | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $Root ".env"))) {
    throw "Missing local .env. Create a production .env with MODE=production, a supported non-mock provider, a strong SECRET_KEY, and the provider credential before starting."
}

if (-not (Test-Path -LiteralPath $Python)) {
    Write-Host "First launch: creating the Python 3.11 environment..."
    & py -3.11 -m venv (Join-Path $Root ".venv311")
    if ($LASTEXITCODE -ne 0) { throw "Python 3.11 was not found. Install it and run start.ps1 again." }
}

$requirementsStamp = Join-Path $Runtime "python-dependencies.ready"
if (-not (Test-Path -LiteralPath $requirementsStamp)) {
    Write-Host "First launch: installing backend dependencies..."
    & $Python -m pip install --upgrade pip
    & $Python -m pip install -r (Join-Path $Backend "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Backend dependency installation failed. Check the network and retry." }
    Set-Content -LiteralPath $requirementsStamp -Value "ready" -Encoding utf8
}

if (-not (Test-Path -LiteralPath (Join-Path $Frontend "node_modules"))) {
    Write-Host "First launch: installing frontend dependencies..."
    Push-Location $Frontend
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed. Check Node.js and the network." }
    }
    finally { Pop-Location }
}

& (Join-Path $Root "stop.ps1") -Quiet

$backendOut = Join-Path $Runtime "backend.out.log"
$backendErr = Join-Path $Runtime "backend.err.log"
$frontendOut = Join-Path $Runtime "frontend.out.log"
$frontendErr = Join-Path $Runtime "frontend.err.log"
$env:VITE_API_PROXY_TARGET = "http://127.0.0.1:8001"
$env:VITE_API_BASE_URL = ""
$env:VITE_DATA_MODE = "real"
# Call-overlay ASR runs on the backend faster-whisper adapter; prefer the
# locally cached base model for reliable zh-CN utterances (tiny stays the
# code-level fallback when this variable is not set).
if (-not $env:WORKSPACE_WHISPER_MODEL) { $env:WORKSPACE_WHISPER_MODEL = "base" }

Write-Host "Starting the Kaki Learning backend and frontend..."
$backendProcess = Start-Process -FilePath $Python -ArgumentList @("-m","uvicorn","app:app","--host","127.0.0.1","--port","8001") -WorkingDirectory $Backend -WindowStyle Hidden -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr -PassThru
$frontendProcess = Start-Process -FilePath "npm.cmd" -ArgumentList @("run","dev","--","--host","127.0.0.1","--port","5174") -WorkingDirectory $Frontend -WindowStyle Hidden -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr -PassThru

@{ backend = $backendProcess.Id; frontend = $frontendProcess.Id } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Runtime "processes.json") -Encoding utf8

function Wait-Endpoint([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
        }
        catch { Start-Sleep -Milliseconds 700 }
    }
    return $false
}

if (-not (Wait-Endpoint "http://127.0.0.1:8001/api/health" 90)) {
    throw "Backend startup timed out. See $backendErr"
}
if (-not (Wait-Endpoint "http://127.0.0.1:5174/" 60)) {
    throw "Frontend startup timed out. See $frontendErr"
}

Write-Host "Verifying canonical API routes..." -ForegroundColor Cyan
$routeChecks = @(
    @{ Url="http://127.0.0.1:8001/api/notes";             Desc="/api/notes";             ExpectNot=404 },
    @{ Url="http://127.0.0.1:8001/api/learning-graphs";   Desc="/api/learning-graphs";   ExpectNot=404 },
    @{ Url="http://127.0.0.1:8001/api/adventure/current";  Desc="/api/adventure/current";  ExpectNot=404 }
)
$allRoutesOk = $true
foreach ($check in $routeChecks) {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $check.Url -TimeoutSec 10
        if ($resp.StatusCode -eq $check.ExpectNot) {
            Write-Host "  FAIL: $($check.Desc) returned $($check.ExpectNot) (route not found)" -ForegroundColor Red
            $allRoutesOk = $false
        } else {
            Write-Host "  PASS: $($check.Desc) -> $($resp.StatusCode)" -ForegroundColor Green
        }
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq $check.ExpectNot) {
            Write-Host "  FAIL: $($check.Desc) returned $statusCode (route not found)" -ForegroundColor Red
            $allRoutesOk = $false
        } else {
            Write-Host "  PASS: $($check.Desc) -> $statusCode" -ForegroundColor Green
        }
    }
}
if (-not $allRoutesOk) {
    Write-Host "WARNING: Some canonical routes are missing. Check that backend was started from kaki-learning-final/backend." -ForegroundColor Yellow
}

Write-Host "Student: http://127.0.0.1:5174/" -ForegroundColor Green
Write-Host "Admin:   http://127.0.0.1:5174/admin/login" -ForegroundColor Green
Write-Host "Health:  run .\health-check.ps1" -ForegroundColor Green
if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:5174/"
}
