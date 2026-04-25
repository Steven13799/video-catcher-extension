param(
  [string]$Version = "",
  [switch]$SkipToolDownload
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot "manifest.json") -Raw | ConvertFrom-Json
if (-not $Version) {
  $Version = $manifest.version
}

Push-Location (Join-Path $repoRoot "native-host")
try {
  cargo build --release
} finally {
  Pop-Location
}

if (-not $SkipToolDownload) {
  & (Join-Path $PSScriptRoot "download-tools.ps1")
}

$releaseRoot = Join-Path $repoRoot ".release"
$packageRoot = Join-Path $releaseRoot "video-catcher-extension-$Version"
$zipPath = Join-Path $releaseRoot "video-catcher-extension-$Version.zip"

if (Test-Path $packageRoot) {
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

$include = @(
  ".github",
  "docs",
  "icons",
  "native-host\host-manifest",
  "scripts",
  "tests",
  "background.js",
  "content.js",
  "injected.js",
  "manifest.json",
  "popup.html",
  "popup.js",
  "shared.js",
  "README.md",
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
  "CONTRIBUTING.md"
)

foreach ($item in $include) {
  $src = Join-Path $repoRoot $item
  if (Test-Path $src) {
    $dest = Join-Path $packageRoot $item
    $destParent = Split-Path -Parent $dest
    if ($destParent) {
      New-Item -ItemType Directory -Path $destParent -Force | Out-Null
    }
    Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force
  }
}

New-Item -ItemType Directory -Path (Join-Path $packageRoot "native-host") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "native-host\target\release\video-catcher-host.exe") -Destination (Join-Path $packageRoot "native-host\video-catcher-host.exe") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "native-host\tools\yt-dlp.exe") -Destination (Join-Path $packageRoot "native-host\yt-dlp.exe") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "native-host\tools\ffmpeg.exe") -Destination (Join-Path $packageRoot "native-host\ffmpeg.exe") -Force

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $zipPath

Write-Host "Release package: $zipPath"
