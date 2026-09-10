$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$results = @()
function Check-Url([string]$Name, [string]$Url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 10
        $script:results += [pscustomobject]@{ Name=$Name; Status='PASS'; Http=$response.StatusCode; Detail=$Url }
        return $response
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        $script:results += [pscustomobject]@{ Name=$Name; Status='FAIL'; Http=$code; Detail=$_.Exception.Message }
        return $null
    }
}
$health = Check-Url 'Backend' 'http://127.0.0.1:8001/api/health'
Check-Url 'Frontend' 'http://127.0.0.1:5174/' | Out-Null
Check-Url 'AI learning page' 'http://127.0.0.1:5174/ai-learning' | Out-Null
if ($health) {
    try {
        $payload = $health.Content | ConvertFrom-Json
        $provider = if ($payload.provider) { $payload.provider } else { $payload.data.provider_status.provider }
        $mode = if ($payload.mode) { $payload.mode } else { $payload.data.mode }
        $database = if ($payload.backend -eq 'connected' -or $payload.services.postgresql -eq $true -or $payload.data.database_connected -ne $false) { 'PASS' } else { 'FAIL' }
        $results += [pscustomobject]@{ Name='Database'; Status=$database; Http=''; Detail='Backend database connection' }
        $results += [pscustomobject]@{ Name='Provider config'; Status=$(if($provider -and $provider -ne 'mock'){'PASS'}else{'FAIL'}); Http=''; Detail="mode=$mode provider=$provider" }
    } catch { $results += [pscustomobject]@{ Name='Health payload'; Status='FAIL'; Http=''; Detail=$_.Exception.Message } }
}
$results | Format-Table -AutoSize
if ($results.Status -contains 'FAIL') { exit 1 }
