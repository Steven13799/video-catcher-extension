param(
  [switch]$KeepFiles
)

$ErrorActionPreference = "Stop"
$hostName = "com.video_catcher.host"
$installDir = Join-Path $env:LOCALAPPDATA "VideoCatcher\NativeHost"

$targets = @(
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
)

foreach ($target in $targets) {
  if (Test-Path $target) {
    Remove-Item -Path $target -Recurse -Force
  }
}

if (-not $KeepFiles -and (Test-Path $installDir)) {
  Remove-Item -LiteralPath $installDir -Recurse -Force
}

Write-Host "Video Catcher native host uninstalled."
