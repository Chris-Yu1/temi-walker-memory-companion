$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root 'node-local\node.exe'
$angularCli = Join-Path $root 'node_modules\@angular\cli\bin\ng.js'
$backend = Join-Path $root 'server.mjs'
$adb = Join-Path $root 'android-tools\platform-tools\adb.exe'
$temiAddress = '192.168.1.109:5555'
$temiAppUrl = 'http://localhost:4200/'
$speechModelSource = Join-Path $root 'speech-models\vosk-model-small-en-us-0.15'
$speechModelRoot = Join-Path $env:TEMP 'temi-vosk-model'
$speechModelTarget = Join-Path $speechModelRoot 'vosk-model-small-en-us-0.15'

$ipconfig = ipconfig | Out-String
$robotIp = $temiAddress.Split(':')[0]
$robotSubnet = ($robotIp -split '\.')[0..2] -join '.'
$escapedSubnet = [regex]::Escape($robotSubnet)
$ipMatches = [regex]::Matches($ipconfig, "IPv4[^:]*:\s*($escapedSubnet\.\d+)")
$computerIp = $ipMatches | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne $robotIp } | Select-Object -First 1

if (-not $computerIp) {
  Write-Host "Warning: could not find this computer on the $robotSubnet.x network; trying ADB connection anyway."
}

if (-not (Test-Path (Join-Path $speechModelTarget 'am\final.mdl'))) {
  New-Item -ItemType Directory -Force -Path $speechModelRoot | Out-Null
  Copy-Item -Recurse -Force $speechModelSource $speechModelRoot
}

if (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $node -ArgumentList @($backend) -WorkingDirectory $root -WindowStyle Hidden
}

if (-not (Get-NetTCPConnection -LocalPort 4200 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $node -ArgumentList @($angularCli, 'serve', '--host', '0.0.0.0', '--port', '4200') -WorkingDirectory $root -WindowStyle Hidden
}

Start-Sleep -Seconds 5
& $adb connect $temiAddress | Out-Host
& $adb -s $temiAddress reverse tcp:4200 tcp:4200 | Out-Null
& $adb -s $temiAddress reverse tcp:3000 tcp:3000 | Out-Null
& $adb -s $temiAddress shell appops set acr.browser.barebones RECORD_AUDIO allow
& $adb -s $temiAddress shell appops set acr.browser.barebones CAMERA allow
& $adb -s $temiAddress shell appops set com.robotemi.browser RECORD_AUDIO allow
& $adb -s $temiAddress shell appops set com.robotemi.browser CAMERA allow
& $adb -s $temiAddress shell appops set com.memory.temiweb RECORD_AUDIO allow
& $adb -s $temiAddress shell appops set com.memory.temiweb CAMERA allow
& $adb -s $temiAddress shell pm grant acr.browser.barebones android.permission.RECORD_AUDIO
& $adb -s $temiAddress shell pm grant acr.browser.barebones android.permission.CAMERA
& $adb -s $temiAddress shell pm grant acr.browser.barebones android.permission.READ_EXTERNAL_STORAGE
& $adb -s $temiAddress shell pm grant com.robotemi.browser android.permission.RECORD_AUDIO
& $adb -s $temiAddress shell pm grant com.robotemi.browser android.permission.CAMERA
& $adb -s $temiAddress shell pm grant com.robotemi.browser android.permission.READ_EXTERNAL_STORAGE
& $adb -s $temiAddress shell pm grant com.memory.temiweb android.permission.RECORD_AUDIO
& $adb -s $temiAddress shell pm grant com.memory.temiweb android.permission.CAMERA
& $adb -s $temiAddress shell am force-stop acr.browser.barebones
& $adb -s $temiAddress shell am force-stop com.robotemi.browser
& $adb -s $temiAddress shell am force-stop com.memory.temiweb
& $adb -s $temiAddress shell monkey -p com.memory.temiweb 1 | Out-Host

Write-Host "temi app: $temiAppUrl (ADB reverse to this computer)"
Write-Host "Robot: $temiAddress"
