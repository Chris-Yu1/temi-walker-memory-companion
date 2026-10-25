$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root 'node-local\node.exe'
$backend = Join-Path $root 'server.mjs'
$gateway = Join-Path $root 'public-upload-gateway.mjs'
$tools = Join-Path $root 'tools'
$cloudflared = Join-Path $tools 'cloudflared.exe'
$logDir = Join-Path $root 'outputs\tunnel'
$stdoutLog = Join-Path $logDir 'cloudflared.out.log'
$stderrLog = Join-Path $logDir 'cloudflared.err.log'
$urlFile = Join-Path $root '.public-upload-url'

New-Item -ItemType Directory -Force -Path $tools | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $cloudflared)) {
  Write-Host 'Downloading cloudflared...'
  Invoke-WebRequest `
    -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
    -OutFile $cloudflared
}

$backendListeners = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $backendListeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
}

$gatewayListeners = Get-NetTCPConnection -LocalPort 3300 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $gatewayListeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
}

Write-Host 'Starting backend on port 3000...'
Start-Process -FilePath $node -ArgumentList @($backend) -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 2

Write-Host 'Starting upload-only gateway on port 3300...'
Start-Process -FilePath $node -ArgumentList @($gateway) -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 1

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
Remove-Item $urlFile -Force -ErrorAction SilentlyContinue

Write-Host 'Starting public upload tunnel...'
Start-Process `
  -FilePath $cloudflared `
  -ArgumentList @('tunnel', '--url', 'http://localhost:3300', '--no-autoupdate') `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog

$publicUrl = ''
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  Start-Sleep -Seconds 1
  $combined = ''
  if (Test-Path $stdoutLog) { $combined += Get-Content $stdoutLog -Raw }
  if (Test-Path $stderrLog) { $combined += Get-Content $stderrLog -Raw }
  $match = [regex]::Match($combined, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
  if ($match.Success) {
    $publicUrl = $match.Value
    break
  }
}

if (-not $publicUrl) {
  throw 'Could not create a public tunnel. Check outputs\tunnel\cloudflared.err.log.'
}

Set-Content -Path $urlFile -Value $publicUrl -Encoding ASCII
Write-Host "Public phone upload URL: $publicUrl"
Write-Host 'Create a new QR code in the app. Phones outside this Wi-Fi can upload through that QR code.'
