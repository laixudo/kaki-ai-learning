param([switch]$Quiet)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Root '.runtime\processes.json'

function Stop-SavedProcessTree([int]$RootProcessId) {
    $ordered = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootProcessId)
    while ($queue.Count -gt 0) {
        $currentId = $queue.Dequeue()
        $ordered.Add($currentId)
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$currentId" -ErrorAction SilentlyContinue | ForEach-Object {
            $queue.Enqueue([int]$_.ProcessId)
        }
    }
    for ($index = $ordered.Count - 1; $index -ge 0; $index--) {
        Stop-Process -Id $ordered[$index] -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Path -LiteralPath $PidFile) {
    try {
        $saved = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
        @($saved.backend, $saved.frontend) | Where-Object { $_ } | ForEach-Object {
            Stop-SavedProcessTree ([int]$_)
        }
    }
    finally { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue }
}

if (-not $Quiet) { Write-Host 'Services started by this package have stopped.' }
