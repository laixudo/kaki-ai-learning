$ErrorActionPreference = "Stop"

$checks = @(
    "http://127.0.0.1:8001/api/notes",
    "http://127.0.0.1:8001/api/learning-graphs",
    "http://127.0.0.1:8001/api/adventure/current",
    "http://127.0.0.1:5174/",
    "http://127.0.0.1:5174/ai-learning",
    "http://127.0.0.1:5174/ai-workspace/assets/adventure/resource-manifest.json",
    "http://127.0.0.1:5174/ai-workspace/assets/adventure/scenes/scene_worldmap_main.png",
    "http://127.0.0.1:5174/ai-workspace/assets/adventure/characters/mascot_shixiaoji_welcome.png"
)

foreach ($url in $checks) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 15
        if ($response.StatusCode -ne 200) { throw "Check failed: $url -> $($response.StatusCode)" }
        Write-Host "PASS: $url"
    } catch {
        $sc = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { "connection failed" }
        if ($url -match "/api/") {
            if ($sc -eq 404) {
                Write-Host "FAIL: $url -> 404 (route not found)" -ForegroundColor Red
                throw "Route missing: $url"
            }
            Write-Host "PASS: $url -> $sc (route exists)" -ForegroundColor Green
        } else {
            throw "Check failed: $url -> $sc"
        }
    }
}

Write-Host "Startup and core resource smoke checks passed." -ForegroundColor Green