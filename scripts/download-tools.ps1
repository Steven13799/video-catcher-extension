param(
  [string]$OutDir = "",
  [switch]$RefreshYtDlp,
  [switch]$YtDlpOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) {
  $OutDir = Join-Path $repoRoot "native-host\tools"
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$ytDlpPath = Join-Path $OutDir "yt-dlp.exe"
$ytDlpDownload = Join-Path $OutDir "yt-dlp.download.exe"
$ytDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
$ffmpegZip = Join-Path $OutDir "ffmpeg-release-essentials.zip"
$ffmpegExtract = Join-Path $OutDir "ffmpeg-extract"
$ffmpegPath = Join-Path $OutDir "ffmpeg.exe"
$ffprobePath = Join-Path $OutDir "ffprobe.exe"

function Find-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }
  return $null
}

function Find-ExistingFfmpegTool([string]$Name) {
  $pathCommand = Find-CommandPath $Name
  if ($pathCommand) {
    return $pathCommand
  }

  $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetPackages) {
    $candidate = Get-ChildItem -Path $wingetPackages -Recurse -Filter $Name -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  return $null
}

function Install-StandaloneYtDlp {
  if (Test-Path -LiteralPath $ytDlpDownload) {
    Remove-Item -LiteralPath $ytDlpDownload -Force
  }

  Write-Host "Downloading the official standalone yt-dlp executable..."
  Invoke-WebRequest -Uri $ytDlpUrl -OutFile $ytDlpDownload
  Unblock-File -LiteralPath $ytDlpDownload

  $versionOutput = & $ytDlpDownload --version 2>&1
  $versionExitCode = $LASTEXITCODE
  $version = [string]($versionOutput | Select-Object -First 1)
  $version = $version.Trim()
  if ($versionExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
    Remove-Item -LiteralPath $ytDlpDownload -Force -ErrorAction SilentlyContinue
    throw "The downloaded yt-dlp.exe did not pass its version check."
  }

  Move-Item -LiteralPath $ytDlpDownload -Destination $ytDlpPath -Force
  Write-Host "yt-dlp $version installed at $ytDlpPath"
}

if ($RefreshYtDlp -or -not (Test-Path -LiteralPath $ytDlpPath)) {
  Install-StandaloneYtDlp
} else {
  $currentVersionOutput = & $ytDlpPath --version 2>&1
  $currentYtDlpVersion = [string]($currentVersionOutput | Select-Object -First 1)
  $currentYtDlpVersion = $currentYtDlpVersion.Trim()
  Write-Host "Using existing yt-dlp $currentYtDlpVersion"
}

if ($YtDlpOnly) {
  Write-Host "yt-dlp ready in $OutDir"
  exit 0
}

if (-not (Test-Path $ffmpegPath)) {
  $existingFfmpeg = Find-ExistingFfmpegTool "ffmpeg.exe"
  if ($existingFfmpeg) {
    Write-Host "Copying existing ffmpeg from $existingFfmpeg"
    Copy-Item -LiteralPath $existingFfmpeg -Destination $ffmpegPath -Force
  } else {
    Write-Host "Downloading ffmpeg essentials..."
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $ffmpegZip
    if (Test-Path $ffmpegExtract) {
      Remove-Item -LiteralPath $ffmpegExtract -Recurse -Force
    }
    Expand-Archive -LiteralPath $ffmpegZip -DestinationPath $ffmpegExtract -Force
    $candidate = Get-ChildItem -Path $ffmpegExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-not $candidate) {
      throw "ffmpeg.exe was not found inside the downloaded archive."
    }
    Copy-Item -LiteralPath $candidate.FullName -Destination $ffmpegPath -Force
    Remove-Item -LiteralPath $ffmpegZip -Force
    Remove-Item -LiteralPath $ffmpegExtract -Recurse -Force
  }
}

if (-not (Test-Path $ffprobePath)) {
  $existingFfprobe = Find-ExistingFfmpegTool "ffprobe.exe"
  if ($existingFfprobe) {
    Write-Host "Copying existing ffprobe from $existingFfprobe"
    Copy-Item -LiteralPath $existingFfprobe -Destination $ffprobePath -Force
  } else {
    Write-Host "Downloading ffmpeg essentials for ffprobe..."
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $ffmpegZip
    if (Test-Path $ffmpegExtract) {
      Remove-Item -LiteralPath $ffmpegExtract -Recurse -Force
    }
    Expand-Archive -LiteralPath $ffmpegZip -DestinationPath $ffmpegExtract -Force
    $candidate = Get-ChildItem -Path $ffmpegExtract -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
    if (-not $candidate) {
      throw "ffprobe.exe was not found inside the downloaded archive."
    }
    Copy-Item -LiteralPath $candidate.FullName -Destination $ffprobePath -Force
    Remove-Item -LiteralPath $ffmpegZip -Force
    Remove-Item -LiteralPath $ffmpegExtract -Recurse -Force
  }
}

Write-Host "Tools ready in $OutDir"
