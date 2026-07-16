# PowerShell launcher (preferred on Windows)
$ErrorActionPreference = 'SilentlyContinue'
Set-Location -LiteralPath $PSScriptRoot

Write-Host '[1/2] Killing leftover electron.exe ...'
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host '[2/2] Starting 竞品情报 ...'
Write-Host 'If it exits immediately, check .data\startup.log'
Write-Host ''

npm start
$code = $LASTEXITCODE
Write-Host ''
Write-Host "Exit code: $code"

$log = Join-Path $PSScriptRoot '.data\startup.log'
if (Test-Path -LiteralPath $log) {
  Write-Host '---- startup.log tail ----'
  Get-Content -LiteralPath $log -Tail 20
}

Write-Host ''
Read-Host 'Press Enter to close'
