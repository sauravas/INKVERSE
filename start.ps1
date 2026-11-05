# INKWISE launcher. Builds the frontend if needed, then serves everything
# (app + API + WebSocket) from FastAPI on one port so the phone can reach it.
param([int]$Port = 8000, [switch]$Dev)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.venv\Scripts\python.exe')) {
  Write-Host 'Creating virtualenv...' -ForegroundColor Cyan
  python -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -q -r backend\requirements.txt
}

if ($Dev) {
  Write-Host 'Dev mode: Vite on :5173, API on :8000' -ForegroundColor Cyan
  $env:INKWISE_PUBLIC_PORT = '5173'
  Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$PSScriptRoot\frontend'; npm run dev"
  .\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $Port --reload
  return
}

if (-not (Test-Path 'frontend\dist\index.html')) {
  Write-Host 'Building frontend...' -ForegroundColor Cyan
  Push-Location frontend
  if (-not (Test-Path 'node_modules')) { npm install }
  npm run build
  Pop-Location
}

$env:INKWISE_PUBLIC_PORT = "$Port"
Write-Host "INKWISE on http://localhost:$Port" -ForegroundColor Green
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $Port
