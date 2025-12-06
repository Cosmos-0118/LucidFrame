param(
    [string]$Python = "python",
    [switch]$Force,
    [switch]$SkipModels,
    [switch]$SkipFFmpeg
)

<#
Sets up Python env and installs deps with the appropriate PyTorch build depending on GPU:
- CUDA GPU -> torch + torchvision + torchaudio CUDA wheels
- AMD GPU (Windows: DirectML) -> torch-directml
- Otherwise CPU wheels
Also triggers model download (unless -SkipModels) and FFmpeg download (unless -SkipFFmpeg).
#>

[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$venvPath = Join-Path $repoRoot '.venv'
$activate = Join-Path $venvPath 'Scripts' | Join-Path -ChildPath 'Activate.ps1'

function Ensure-Venv {
    if (-not (Test-Path -LiteralPath $venvPath) -or $Force) {
        Write-Host "[venv] creating venv at $venvPath"
        & $Python -m venv $venvPath
    }
    else {
        Write-Host "[venv] using existing venv at $venvPath"
    }
}

function Detect-GPU {
    # Basic detection using wmic; not perfect but good enough for selection.
    $gpus = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ' | '
    $hasNvidia = $gpus -match 'NVIDIA'
    $hasAmd = $gpus -match 'AMD|Radeon'
    return @{ HasNvidia = $hasNvidia; HasAmd = $hasAmd; Names = $gpus }
}

function Install-Torch {
    param([bool]$HasNvidia,[bool]$HasAmd)
    Write-Host "[gpu ] detected: $($gpuInfo.Names)"
    $pip = "$venvPath/Scripts/pip.exe"
    if ($HasNvidia) {
        Write-Host "[pip ] installing torch CUDA build"
        & $pip install --extra-index-url https://download.pytorch.org/whl/cu124 torch torchvision torchaudio
    }
    elseif ($HasAmd) {
        Write-Host "[pip ] installing torch-directml (AMD/DirectML)"
        & $pip install torch-directml
    }
    else {
        Write-Host "[pip ] installing torch CPU build"
        & $pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
    }
}

function Install-CoreDeps {
    $pip = "$venvPath/Scripts/pip.exe"
    Write-Host "[pip ] installing core deps"
    & $pip install -r (Join-Path $repoRoot 'requirements.txt')
}

function Install-ModelDeps {
    $pip = "$venvPath/Scripts/pip.exe"
    Write-Host "[pip ] installing model wrappers"
    & $pip install realesrgan
    & $pip install git+https://github.com/TencentARC/GFPGAN.git
    # RIFE is not installed here; you can add a chosen implementation later.
}

function Download-Models {
    if ($SkipModels) { Write-Host "[models] skip (-SkipModels set)"; return }
    $dlScript = Join-Path $repoRoot 'download_models.ps1'
    if (-not (Test-Path -LiteralPath $dlScript)) {
        Write-Warning "[models] download_models.ps1 not found; skipping model download."
        return
    }
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $dlScript
}

function Download-FFmpeg {
    if ($SkipFFmpeg) { Write-Host "[ffmpeg] skip (-SkipFFmpeg set)"; return }
    & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts' 'download_ffmpeg.ps1')
}

Ensure-Venv
$gpuInfo = Detect-GPU
Install-Torch -HasNvidia:$($gpuInfo.HasNvidia) -HasAmd:$($gpuInfo.HasAmd)
Install-CoreDeps
Install-ModelDeps
Download-Models
Download-FFmpeg

Write-Host "[done] Environment ready. Activate with: `n`$activate"