param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'build\plyt-server.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    & (Join-Path $root 'build-server.ps1')
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Server build failed.' }
}
$previousPort=$env:PORT
$previousHost=$env:PLYT_HOST
$env:PORT = "$Port"
$env:PLYT_HOST = '127.0.0.1'
Write-Host "PLYT web: http://127.0.0.1:$Port"
Write-Host 'Keep this window open while using the app or web.'
Push-Location -LiteralPath $root
try {
    & $exe
    if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE" }
} finally {
    Pop-Location
    $env:PORT=$previousPort
    $env:PLYT_HOST=$previousHost
}
