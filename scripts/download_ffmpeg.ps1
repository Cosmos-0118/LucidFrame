param(
    [string]$BaseDir = "$PSScriptRoot/../bin",
    [switch]$Force
)

[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$zipPath   = Join-Path $BaseDir 'ffmpeg-release-essentials.zip'
$targetExe = Join-Path $BaseDir 'ffmpeg.exe'

if (-not (Test-Path -LiteralPath $BaseDir)) {
    New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null
}

$needsDownload = $Force -or -not (Test-Path -LiteralPath $targetExe)

if ($needsDownload) {
    Write-Host "[get ] ffmpeg essentials -> $zipPath"
    try {
        Invoke-WebRequest -Uri $ffmpegUrl -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
    }
    catch {
        throw "FFmpeg download failed: $_"
    }

    Write-Host "[unzip] extracting ffmpeg.exe"
    try {
        # Extract to a temp dir first
        $tmpDir = Join-Path $BaseDir 'ffmpeg_tmp'
        if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $tmpDir -Force
        $exe = Get-ChildItem -LiteralPath $tmpDir -Recurse -Filter ffmpeg.exe | Select-Object -First 1
        if (-not $exe) { throw "ffmpeg.exe not found in archive" }
        Copy-Item -LiteralPath $exe.FullName -Destination $targetExe -Force
        Remove-Item -LiteralPath $tmpDir -Recurse -Force
    }
    catch {
        throw "FFmpeg extract failed: $_"
    }

    Write-Host "[done] ffmpeg.exe -> $targetExe"
}
else {
    Write-Host "[skip] ffmpeg.exe already present at $targetExe"
}
