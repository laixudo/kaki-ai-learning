# ============================================================================
# Kaki Learning — Web Takeover runner (Windows PowerShell)
# Starts: synthetic DB -> backend (TAKEOVER_BACKEND_PORT default 18001)
#         -> frontend (TAKEOVER_FRONTEND_PORT default 15174) -> smoke tests.
# Everything stays inside this isolated directory; never touches the formal
# project and never calls an external LLM (MODE=mock).
# Env overrides: TAKEOVER_PYTHON, TAKEOVER_BACKEND_PORT, TAKEOVER_FRONTEND_PORT,
#                TAKEOVER_DB_PATH, TAKEOVER_NO_SMOKE
# ============================================================================
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Python = if ($env:TAKEOVER_PYTHON) { $env:TAKEOVER_PYTHON } else { "py" }
$BackendPort = if ($env:TAKEOVER_BACKEND_PORT) { $env:TAKEOVER_BACKEND_PORT } else { "18001" }
$FrontendPort = if ($env:TAKEOVER_FRONTEND_PORT) { $env:TAKEOVER_FRONTEND_PORT } else { "15174" }
$DbPath = if ($env:TAKEOVER_DB_PATH) { $env:TAKEOVER_DB_PATH } else { Join-Path $Root "backend\ml_learning.synthetic.db" }

New-Item -ItemType Directory -Path (Join-Path $ScriptDir "logs") -Force | Out-Null

if (-not (Test-Path -LiteralPath $DbPath)) {
    Write-Host "[takeover] synthetic DB missing -> creating from scratch..."
    Push-Location $Root
    try { & $Python takeover_tools/create_synthetic_database.py --force }
    finally { Pop-Location }
}

Write-Host "[takeover] backend -> http://127.0.0.1:$BackendPort"
Push-Location $Root
try { $env:TAKEOVER_BACKEND_PORT = $BackendPort; & $Python takeover_tools/run_backend.py --detach }
finally { Pop-Location }

Write-Host "[takeover] frontend -> http://127.0.0.1:$FrontendPort"
Push-Location $Root
try {
    $env:TAKEOVER_FRONTEND_PORT = $FrontendPort
    $env:TAKEOVER_BACKEND_PORT = $BackendPort
    & node takeover_tools/run_frontend.mjs --detach
}
finally { Pop-Location }

if ($env:TAKEOVER_NO_SMOKE -ne "1") {
    Write-Host "[takeover] running smoke tests..."
    Push-Location $Root
    try {
        & $Python takeover_tools/smoke_test.py `
            --backend-url "http://127.0.0.1:$BackendPort" `
            --frontend-url "http://127.0.0.1:$FrontendPort"
    }
    finally { Pop-Location }
}

Write-Host "[takeover] READY -> http://127.0.0.1:$FrontendPort/"
Write-Host "[takeover] stop with: $Python $ScriptDir\stop_services.py"
