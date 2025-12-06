param(
    [string]$Manifest = "../models/manifest.json",
    [string]$TargetDir,
    [switch]$Force,
    [switch]$Verbose
)

[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

function Read-Manifest($path) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Manifest not found: $path" }
    Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Ensure-Dir($path) {
    $dir = Split-Path -Path $path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

function Get-FileHashHex($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower()
}

function Download-File($url, $dest) {
    Write-Host "[get ] $url"; Write-Host "      -> $dest"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

$manifestPath = Resolve-Path -LiteralPath $Manifest
$manifest = Read-Manifest $manifestPath
$baseUrl = $manifest.base_url
$files = $manifest.files
$targetRoot = if ($TargetDir) { Resolve-Path -LiteralPath $TargetDir } else { Split-Path -Path $manifestPath -Parent }

foreach ($f in $files) {
    $dest = Join-Path $targetRoot $f.name
    Ensure-Dir $dest
    $expected = $f.sha256
    $needs = $Force -or -not (Test-Path -LiteralPath $dest)
    if (-not $needs -and $expected -and ($hash = Get-FileHashHex $dest)) {
        if ($hash -ne $expected.ToLower()) { Write-Host "[hash] mismatch, re-downloading $($f.name)"; $needs = $true }
    }
    if ($needs) {
        $url = ($f.url -match '^https?://') ? $f.url : ($baseUrl + $f.url)
        Download-File $url $dest
        if ($expected) {
            $hash = Get-FileHashHex $dest
            if ($hash -ne $expected.ToLower()) { throw "Hash mismatch for $($f.name). Got $hash" }
        }
    }
    elseif ($Verbose) {
        Write-Host "[skip] $($f.name) exists"
    }
}

Write-Host "[done] Models fetched."
