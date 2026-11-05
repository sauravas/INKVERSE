# INKWISE launcher.
#
# Everything - the app, the API and the WebSocket the phone pairs over - is
# served by FastAPI on ONE port. There is deliberately no second dev server:
# running Vite on :5173 alongside FastAPI on :8000 meant two URLs serving two
# different builds of the app, and whichever one you happened to open decided
# which features you had. With -Dev, Vite rebuilds into frontend/dist in the
# background and FastAPI keeps serving it, so there is still only one address.
#
#   .\start.ps1             build if needed, serve on http://localhost:8000
#   .\start.ps1 -Dev        same port, rebuilds on save, API reloads on save
#   .\start.ps1 -Port 9000  somewhere else
#   .\start.ps1 -Fresh      force a clean rebuild of the frontend first
param(
  [int]$Port = 8000,
  [switch]$Dev,
  [switch]$NoVoice,
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# --------------------------------------------------------------- ports
# Ports this project owns. Anything of ours still holding one is left over from
# a previous run and is stopped; anything else is reported and left alone,
# because killing a stranger's process is not ours to do.
$OwnedPorts = [ordered]@{
  "$Port" = 'INKWISE server'
  '5173'  = 'a Vite dev server from an older INKWISE build'
  '8181'  = 'the whisperflow voice sidecar'
}
$OursByName = 'python', 'pythonw', 'uvicorn', 'node', 'npm'

function Get-PortOwner([int]$p) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  $out = @()
  foreach ($c in $conns) {
    if ($c.OwningProcess -eq 0 -or $c.OwningProcess -eq 4) { continue }
    try { $out += Get-Process -Id $c.OwningProcess -ErrorAction Stop } catch { }
  }
  $out | Sort-Object Id -Unique
}

Write-Host 'Checking ports...' -ForegroundColor Cyan
foreach ($key in $OwnedPorts.Keys) {
  $p = [int]$key
  foreach ($proc in (Get-PortOwner $p)) {
    if ($proc.Id -eq $PID) { continue }
    if ($OursByName -contains $proc.ProcessName) {
      Write-Host ("  freeing port {0} (stopping leftover {1}, pid {2})" -f `
                  $p, $proc.ProcessName, $proc.Id) -ForegroundColor DarkYellow
      try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {
        Write-Host ("  could not stop pid {0}: {1}" -f $proc.Id, $_.Exception.Message) `
                   -ForegroundColor Red
      }
    } else {
      Write-Host ("  port {0} is held by {1} (pid {2}), which is not INKWISE's." -f `
                  $p, $proc.ProcessName, $proc.Id) -ForegroundColor Red
      Write-Host ("  {0} needs it. Close that program, or use -Port <n>." -f `
                  $OwnedPorts[$key]) -ForegroundColor Red
      if ($p -eq $Port) { exit 1 }
    }
  }
}
# Windows holds a closed listener briefly; give it a moment to release.
Start-Sleep -Milliseconds 400

# --------------------------------------------------------------- ollama
# One server, not several. Ollama's own log fills with
#   "listen tcp 0.0.0.0:11434: bind: Only one usage of each socket address..."
# when extra copies are launched on top of a running one; they all exit, but
# the noise hides real errors.
function Test-Ollama {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (Get-Command ollama -ErrorAction SilentlyContinue) {
  if (Test-Ollama) {
    Write-Host 'Ollama already running.' -ForegroundColor DarkGray
  } else {
    $stale = Get-Process ollama -ErrorAction SilentlyContinue
    if ($stale) {
      Write-Host '  stopping an Ollama that is not answering...' -ForegroundColor DarkYellow
      $stale | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
    Write-Host 'Starting Ollama...' -ForegroundColor Cyan
    Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
    for ($i = 0; $i -lt 20 -and -not (Test-Ollama); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Ollama)) {
      Write-Host '  Ollama did not come up. INKWISE still runs; answers will not.' `
                 -ForegroundColor Yellow
    }
  }
} else {
  Write-Host 'Ollama is not installed - writing works, answers will not.' `
             -ForegroundColor Yellow
}

# --------------------------------------------------------------- python
if (-not (Test-Path '.venv\Scripts\python.exe')) {
  Write-Host 'Creating virtualenv...' -ForegroundColor Cyan
  python -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -q -r backend\requirements.txt
}
$Py = (Resolve-Path '.venv\Scripts\python.exe').Path

# --------------------------------------------------------------- voice
# whisperflow runs in its own environment: it pins its own FastAPI and needs
# PyTorch, neither of which belongs in INKWISE's. Skipped with -NoVoice; without
# it the microphone button simply says voice is unavailable.
if (-not $NoVoice -and -not (Test-Path 'speech\.venv\Scripts\python.exe')) {
  $py311 = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python31*\python.exe" `
           -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($py311) {
    Write-Host 'Setting up voice (whisperflow, ~1 GB, once)...' -ForegroundColor Cyan
    if (Get-Command uv -ErrorAction SilentlyContinue) {
      uv venv speech\.venv --python $py311.FullName
      uv pip install --python speech\.venv\Scripts\python.exe whisperflow
    } else {
      & $py311.FullName -m venv speech\.venv
      .\speech\.venv\Scripts\python.exe -m pip install -q whisperflow
    }
  } else {
    Write-Host 'Voice needs Python 3.11-3.12; skipping (everything else works).' `
               -ForegroundColor Yellow
  }
}

# --------------------------------------------------------------- frontend
# The build is what :8000 serves, so a stale dist is the same bug as two ports:
# the app you see is not the code in the tree. Rebuild whenever any source is
# newer than the build.
function Test-BuildStale {
  if ($Fresh) { return $true }
  $index = 'frontend\dist\index.html'
  if (-not (Test-Path $index)) { return $true }
  $built = (Get-Item $index).LastWriteTimeUtc
  $sources = @()
  foreach ($dir in 'frontend\src', 'frontend\public') {
    if (Test-Path $dir) { $sources += Get-ChildItem $dir -Recurse -File }
  }
  foreach ($f in 'frontend\index.html', 'frontend\package.json', 'frontend\vite.config.js') {
    if (Test-Path $f) { $sources += Get-Item $f }
  }
  foreach ($f in $sources) { if ($f.LastWriteTimeUtc -gt $built) { return $true } }
  return $false
}

$stale = Test-BuildStale
Push-Location frontend
if (-not (Test-Path 'node_modules')) {
  Write-Host 'Installing frontend dependencies...' -ForegroundColor Cyan
  npm install
}
if ($Dev) {
  Write-Host 'Dev mode: rebuilding frontend/dist on every save.' -ForegroundColor Cyan
  npm run build                      # one full build so there is something to serve
  Start-Process powershell -WindowStyle Minimized -ArgumentList '-NoExit', '-Command', `
    "Set-Location '$PSScriptRoot\frontend'; npm run build -- --watch"
} elseif ($stale) {
  Write-Host 'Building frontend (sources changed since the last build)...' -ForegroundColor Cyan
  npm run build
} else {
  Write-Host 'Frontend build is up to date.' -ForegroundColor DarkGray
}
Pop-Location

# --------------------------------------------------------------- serve
$env:INKWISE_PUBLIC_PORT = "$Port"
$lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and
                       $_.IPAddress -notlike '169.254.*' -and
                       ($_.PrefixOrigin -eq 'Dhcp' -or $_.PrefixOrigin -eq 'Manual') } |
        Select-Object -First 1).IPAddress

Write-Host ''
Write-Host "INKWISE on http://localhost:$Port" -ForegroundColor Green
if ($lan) { Write-Host "  phone:   http://${lan}:$Port" -ForegroundColor Green }
Write-Host '  one port serves the app, the API and the pairing socket.' -ForegroundColor DarkGray
Write-Host ''

$uvicorn = @('-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend',
             '--host', '0.0.0.0', '--port', "$Port")
if ($Dev) { $uvicorn += '--reload' }
& $Py @uvicorn
