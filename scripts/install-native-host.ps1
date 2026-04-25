param(
  [ValidateSet("Brave", "Chrome", "Both")]
  [string]$Browser = "Both",
  [string]$ExtensionId = "jjmpkelicjdcdmiiiopaipbpcbnnfalj"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $env:LOCALAPPDATA "VideoCatcher\NativeHost"
$manifestPath = Join-Path $installDir "com.video_catcher.host.json"
$hostName = "com.video_catcher.host"

function Find-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }
  return $null
}

function Find-FirstExisting([string[]]$Candidates, [string]$Name) {
  foreach ($candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "$Name not found. Build the host and download tools first. See docs/native-host.md."
}

function Ensure-HostBuilt {
  $releaseHost = Join-Path $repoRoot "native-host\target\release\video-catcher-host.exe"
  if (Test-Path -LiteralPath $releaseHost) {
    return
  }

  $cargoToml = Join-Path $repoRoot "native-host\Cargo.toml"
  if ((Test-Path -LiteralPath $cargoToml) -and (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Push-Location (Join-Path $repoRoot "native-host")
    try {
      cargo build --release
    } finally {
      Pop-Location
    }
  }
}

function Ensure-ToolsDownloaded {
  $ytDlp = Join-Path $repoRoot "native-host\tools\yt-dlp.exe"
  $ffmpeg = Join-Path $repoRoot "native-host\tools\ffmpeg.exe"
  if ((Test-Path -LiteralPath $ytDlp) -and (Test-Path -LiteralPath $ffmpeg)) {
    return
  }

  $downloadScript = Join-Path $PSScriptRoot "download-tools.ps1"
  if (Test-Path -LiteralPath $downloadScript) {
    & $downloadScript
  }
}

Ensure-HostBuilt
Ensure-ToolsDownloaded

$hostExe = Find-FirstExisting @(
  (Join-Path $repoRoot "native-host\target\release\video-catcher-host.exe"),
  (Join-Path $repoRoot "native-host\video-catcher-host.exe"),
  (Join-Path $repoRoot "bin\video-catcher-host.exe")
) "video-catcher-host.exe"

$ytDlpExe = Find-FirstExisting @(
  (Join-Path $repoRoot "native-host\tools\yt-dlp.exe"),
  (Join-Path $repoRoot "native-host\yt-dlp.exe"),
  (Join-Path $repoRoot "tools\yt-dlp.exe"),
  (Find-CommandPath "yt-dlp.exe")
) "yt-dlp.exe"

$ffmpegExe = Find-FirstExisting @(
  (Join-Path $repoRoot "native-host\tools\ffmpeg.exe"),
  (Join-Path $repoRoot "native-host\ffmpeg.exe"),
  (Join-Path $repoRoot "tools\ffmpeg.exe"),
  (Find-CommandPath "ffmpeg.exe")
) "ffmpeg.exe"

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath $hostExe -Destination (Join-Path $installDir "video-catcher-host.exe") -Force
Copy-Item -LiteralPath $ytDlpExe -Destination (Join-Path $installDir "yt-dlp.exe") -Force
Copy-Item -LiteralPath $ffmpegExe -Destination (Join-Path $installDir "ffmpeg.exe") -Force

$installedHost = Join-Path $installDir "video-catcher-host.exe"
$escapedHost = $installedHost.Replace("\", "\\")
$manifest = @"
{
  "name": "$hostName",
  "description": "Video Catcher native host for yt-dlp and ffmpeg",
  "path": "$escapedHost",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@

Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8

$targets = @()
if ($Browser -eq "Brave" -or $Browser -eq "Both") {
  $targets += "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
}
if ($Browser -eq "Chrome" -or $Browser -eq "Both") {
  $targets += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
}

foreach ($target in $targets) {
  New-Item -Path $target -Force | Out-Null
  Set-ItemProperty -Path $target -Name "(default)" -Value $manifestPath
}

Write-Host "Video Catcher native host installed."
Write-Host "Manifest: $manifestPath"
Write-Host "Extension ID: $ExtensionId"
