param(
    [string]$Manifest = "../models/manifest.json",
    [string]$TargetDir,
    [switch]$Force,
    [switch]$Verbose
)

# Ensure models and ffmpeg are present in a runtime-safe location (per-user app data by default).
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

function Resolve-TargetDir {
    param([string]$Custom)
    if ($Custom) { return Resolve-Path -LiteralPath $Custom }
    if ($IsWindows) {
        $base = Join-Path $env:LOCALAPPDATA 'LucidFrame/resources'
    }
    elseif ($IsMacOS) {
        $base = Join-Path $env:HOME 'Library/Application Support/LucidFrame/resources'
    }
    else {
        $base = Join-Path $env:HOME '.local/share/LucidFrame/resources'
    }
    if (-not (Test-Path -LiteralPath $base)) { New-Item -ItemType Directory -Path $base -Force | Out-Null }
    return (Resolve-Path -LiteralPath $base)
}

$destRoot = Resolve-TargetDir -Custom $TargetDir
Write-Host "[dest] $destRoot"

# 1) Models
pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fetch_models.ps1') -Manifest $Manifest -TargetDir $destRoot -Force:$Force -Verbose:$Verbose

# 2) FFmpeg
$binDir = Join-Path $destRoot 'bin'
if (-not (Test-Path -LiteralPath $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
$ffmpegScript = Join-Path $PSScriptRoot 'download_ffmpeg.ps1'
& pwsh -NoProfile -ExecutionPolicy Bypass -File $ffmpegScript -BaseDir $binDir -Force:$Force

Write-Host "[done] Resources ready at $destRoot"
Write-Host "Models dir: $(Join-Path $destRoot 'realesrgan')"
Write-Host "FFmpeg   : $(Join-Path $binDir 'ffmpeg.exe')"