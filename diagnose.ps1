$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = Join-Path $Root '.runtime'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path $Runtime "diagnose-$stamp.txt"
New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("Kaki Learning diagnostic report — $(Get-Date -Format o)")
$lines.Add("Package root: $Root")
$lines.Add("Windows: $([Environment]::OSVersion.VersionString)")
$lines.Add("PowerShell: $($PSVersionTable.PSVersion)")
$lines.Add("Python: $(& (Join-Path $Root '.venv311\Scripts\python.exe') --version 2>&1)")
$lines.Add("Node: $(& node --version 2>&1)")
$lines.Add("npm: $(& npm.cmd --version 2>&1)")
$lines.Add(".env present: $(Test-Path -LiteralPath (Join-Path $Root '.env'))")
$lines.Add("process file present: $(Test-Path -LiteralPath (Join-Path $Runtime 'processes.json'))")
foreach($port in 8001,5174){
    $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    $lines.Add("Port $port listener PID: $($owner -join ',')")
}
foreach($name in 'backend.err.log','frontend.err.log'){
    $path = Join-Path $Runtime $name
    $lines.Add("--- $name (last 60 lines) ---")
    if(Test-Path -LiteralPath $path){ Get-Content -LiteralPath $path -Tail 60 | ForEach-Object { $lines.Add($_) } }
    else { $lines.Add('(not created)') }
}
$lines | Set-Content -LiteralPath $report -Encoding utf8
Write-Host "Diagnostic report created: $report" -ForegroundColor Green
& (Join-Path $Root 'health-check.ps1')
