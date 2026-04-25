param(
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) {
  $OutDir = Join-Path $repoRoot "native-host\tools"
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$ytDlpPath = Join-Path $OutDir "yt-dlp.exe"
$ffmpegZip = Join-Path $OutDir "ffmpeg-release-essentials.zip"
$ffmpegExtract = Join-Path $OutDir "ffmpeg-extract"
$ffmpegPath = Join-Path $OutDir "ffmpeg.exe"

function Find-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }
  return $null
}

function Find-ExistingFfmpeg {
  $pathCommand = Find-CommandPath "ffmpeg.exe"
  if ($pathCommand) {
    return $pathCommand
  }

  $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetPackages) {
    $candidate = Get-ChildItem -Path $wingetPackages -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  return $null
}

if (-not (Test-Path $ytDlpPath)) {
  $existingYtDlp = Find-CommandPath "yt-dlp.exe"
  if ($existingYtDlp) {
    Write-Host "Copying existing yt-dlp from $existingYtDlp"
    Copy-Item -LiteralPath $existingYtDlp -Destination $ytDlpPath -Force
  } else {
    Write-Host "Downloading yt-dlp..."
    Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $ytDlpPath
  }
}

if (-not (Test-Path $ffmpegPath)) {
  $existingFfmpeg = Find-ExistingFfmpeg
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

Write-Host "Tools ready in $OutDir"
