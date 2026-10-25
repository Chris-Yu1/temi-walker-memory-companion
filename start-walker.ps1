$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root 'node-local\node.exe'
$angularCli = Join-Path $root 'node_modules\@angular\cli\bin\ng.js'
$backend = Join-Path $root 'server.mjs'
$staticFrontend = Join-Path $root 'static-frontend.mjs'

function Get-PreferredIPv4 {
  try {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.PrefixOrigin -ne 'WellKnown' -and
        $_.InterfaceAlias -notlike '*vEthernet*' -and
        $_.InterfaceAlias -notlike '*Loopback*' -and
        $_.InterfaceAlias -notlike '*Docker*' -and
        $_.InterfaceAlias -notlike '*VMware*' -and
        $_.InterfaceAlias -notlike '*VirtualBox*'
      } |
      Sort-Object @{
        Expression = {
          if ($_.InterfaceAlias -match 'Wi-?Fi|WLAN|Wireless') { 0 } else { 1 }
        }
      }, InterfaceMetric, InterfaceIndex

    $netIp = ($addresses | Select-Object -First 1).IPAddress
    if ($netIp) {
      return $netIp
    }
  } catch {
    # Fall back to ipconfig on machines where CIM network queries are blocked.
  }

  $ipconfig = ipconfig
  $matches = $ipconfig | Select-String -Pattern 'IPv4.*?:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)'
  $ips = $matches | ForEach-Object { $_.Matches[0].Groups[1].Value } |
    Where-Object {
      $_ -notlike '127.*' -and
      $_ -notlike '169.254.*' -and
      $_ -notlike '172.1[6-9].*' -and
      $_ -notlike '172.2[0-9].*' -and
      $_ -notlike '172.3[0-1].*'
    }

  return ($ips | Select-Object -First 1)
}

if (-not (Test-Path $node)) {
  throw "Local Node.js was not found at $node"
}

if (-not (Test-Path $angularCli)) {
  throw "Angular CLI was not found at $angularCli. Run npm install first."
}

$computerIp = Get-PreferredIPv4
if (-not $computerIp) {
  $computerIp = 'localhost'
}

$envFile = Join-Path $root 'src\assets\env.js'
Set-Content -Path $envFile -Encoding UTF8 -Value @"
window.__env = window.__env || {};
window.__env.BACKEND_URL = "$computerIp";
window.__env.ROSBRIDGE_PORT = window.__env.ROSBRIDGE_PORT || "9090";
"@

if (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $node -ArgumentList @($backend) -WorkingDirectory $root -WindowStyle Hidden
}

$frontendListeners = Get-NetTCPConnection -LocalPort 4200 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $frontendListeners) {
  Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
}

& $node $angularCli build

Start-Process -FilePath $node -ArgumentList @($staticFrontend) -WorkingDirectory $root -WindowStyle Hidden

Start-Sleep -Seconds 5

$displayIp = Get-PreferredIPv4
if (-not $displayIp) {
  Write-Host "The app is running, but I could not detect this computer's Wi-Fi IP."
  Write-Host "Open the app on Walker with: http://<computer-ip>:4200/?robot=walker"
  exit 0
}

$walkerUrl = "http://$displayIp`:4200/?robot=walker&ros_ip=192.168.4.1&ros_port=9090"

Write-Host "Walker app is ready."
Write-Host "Open this URL in the Walker browser:"
Write-Host $walkerUrl
Write-Host ""
Write-Host "Backend health check:"
Write-Host "http://$displayIp`:3000/"
