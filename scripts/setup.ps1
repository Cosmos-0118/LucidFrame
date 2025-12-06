param(
    [string]$Python = "python",
    [switch]$Force,
    [switch]$SkipFFmpeg,
    [switch]$CPUOnly
)

# One-liner setup: venv -> deps -> ffmpeg. Models are listed at the end.
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$venvPath = Join-Path $repoRoot '.venv'
$pip     = Join-Path $venvPath 'Scripts' | Join-Path -ChildPath 'pip.exe'
$activate= Join-Path $venvPath 'Scripts' | Join-Path -ChildPath 'Activate.ps1'

function Ensure-Venv {
    if ($Force -or -not (Test-Path -LiteralPath $venvPath)) {
        Write-Host "[venv] creating venv at $venvPath"
        & $Python -m venv $venvPath
    }
    else {
        Write-Host "[venv] using existing venv at $venvPath"
    }
}

function Detect-GPU {
    $names = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ' | '
    return @{
        Names = $names
        HasNvidia = -not $CPUOnly -and ($names -match 'NVIDIA')
        HasAmd    = -not $CPUOnly -and ($names -match 'AMD|Radeon')
    }
}

function Install-Torch {
    param([bool]$HasNvidia,[bool]$HasAmd)
    Write-Host "[gpu ] detected: $($gpuInfo.Names)"
    if ($HasNvidia) {
        Write-Host "[pip ] torch CUDA build"
        & $pip install --extra-index-url https://download.pytorch.org/whl/cu124 torch torchvision torchaudio
    }
    elseif ($HasAmd) {
        Write-Host "[pip ] torch-directml (AMD/DirectML)"
        & $pip install torch-directml
    }
    else {
        Write-Host "[pip ] torch CPU build"
        & $pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
    }
}

function Install-CoreDeps {
    Write-Host "[pip ] installing requirements.txt"
    & $pip install -r (Join-Path $repoRoot 'requirements.txt')
}

function Install-ModelDeps {
    Write-Host "[pip ] installing model wrappers (realesrgan, gfpgan)"
    & $pip install realesrgan
    & $pip install git+https://github.com/TencentARC/GFPGAN.git
}

function Download-FFmpeg {
    if ($SkipFFmpeg) { Write-Host "[ffmpeg] skip (-SkipFFmpeg)"; return }
    & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts' 'download_ffmpeg.ps1') -Force:$Force
}

Ensure-Venv
$gpuInfo = Detect-GPU
Install-Torch -HasNvidia:$($gpuInfo.HasNvidia) -HasAmd:$($gpuInfo.HasAmd)
Install-CoreDeps
Install-ModelDeps
Download-FFmpeg

Write-Host "[done] Environment ready." -ForegroundColor Green
Write-Host "Activate with:`n`n    . $activate`n"
Write-Host "Download models via manifest (recommended):" -ForegroundColor Yellow
Write-Host "  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/fetch_models.ps1"
Write-Host "Or ensure runtime resources (models + ffmpeg) in app data:" -ForegroundColor Yellow
Write-Host "  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/ensure_resources.ps1"
Write-Host "Files expected:"
Write-Host "  realesrgan: x4plus, x2plus, x4plus_anime_6B"
Write-Host "  gfpgan: GFPGANv1.4.pth"
