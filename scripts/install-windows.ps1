# OPEN Booru — Windows installer (English)
# Usage (from anywhere, PowerShell):
#   irm https://raw.githubusercontent.com/RegentsVoice/OPEN_Booru/main/scripts/install-windows.ps1 | iex
# Or inside a cloned repo:
#   .\scripts\install-windows.ps1
$ErrorActionPreference = 'Stop'

$RepoUrl  = if ($env:OPEN_BOORU_REPO) { $env:OPEN_BOORU_REPO } else { 'https://github.com/RegentsVoice/OPEN_Booru.git' }
$RepoName = 'OPEN_Booru'
$SparkUrl = 'https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js'

Write-Host '==> OPEN Booru installer (Windows)'

function Test-Node {
    try { Get-Command node -EA Stop | Out-Null; Get-Command npm -EA Stop | Out-Null; return $true }
    catch { return $false }
}

$Root = $null
if ((Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match '"name"\s*:\s*"open-booru"')) {
    $Root = (Get-Location).Path
    Write-Host "==> Using current directory: $Root"
} elseif ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\package.json'))) {
    $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    Write-Host "==> Using repo next to script: $Root"
} else {
    if (-not (Get-Command git -EA SilentlyContinue)) {
        Write-Host '==> git not found. Install Git for Windows, then re-run.'
        Write-Host '    https://git-scm.com/download/win'
        exit 1
    }
    $Target = if ($env:OPEN_BOORU_DIR) { $env:OPEN_BOORU_DIR } else { Join-Path $HOME $RepoName }
    if (Test-Path (Join-Path $Target '.git')) {
        Write-Host "==> Updating existing clone: $Target"
        git -C $Target pull --ff-only 2>$null
    } else {
        Write-Host "==> Cloning $RepoUrl → $Target"
        git clone $RepoUrl $Target
    }
    $Root = $Target
}
Set-Location $Root

if (Test-Node) {
    Write-Host "==> Node $(node -v), npm $(npm -v) found"
} else {
    Write-Host '==> Installing Node.js LTS via winget...'
    if (-not (Get-Command winget -EA SilentlyContinue)) {
        Write-Host 'ERROR: winget not available. Install Node 18+ LTS from https://nodejs.org/ and re-run.'
        exit 1
    }
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Test-Node)) {
        Write-Host 'ERROR: Node installed but not on PATH. Open a NEW PowerShell window and run this script again.'
        exit 1
    }
}
$major = [int]((node -v) -replace '^v','').Split('.')[0]
if ($major -lt 18) {
    Write-Host "ERROR: Node.js >= 18 required (found $(node -v))"
    exit 1
}

$SparkDir = Join-Path $Root 'public\lib'
$SparkFile = Join-Path $SparkDir 'spark-md5.min.js'
New-Item -ItemType Directory -Force -Path $SparkDir | Out-Null
if ((Test-Path $SparkFile) -and ((Get-Item $SparkFile).Length -gt 0)) {
    Write-Host '==> spark-md5.min.js already present'
} else {
    Write-Host '==> Downloading spark-md5.min.js...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $SparkUrl -OutFile $SparkFile -UseBasicParsing
    if (-not (Test-Path $SparkFile) -or (Get-Item $SparkFile).Length -lt 100) {
        Write-Host 'ERROR: failed to download spark-md5'
        exit 1
    }
}

Write-Host '==> npm install...'
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Wasm = Join-Path $Root 'node_modules\sql.js\dist\sql-wasm.wasm'
if (Test-Path $Wasm) {
    $wsz = (Get-Item $Wasm).Length
    if ($wsz -lt 1000) {
        Write-Host "WARN: sql-wasm.wasm looks corrupt ($wsz bytes). Try: npm install sql.js --force"
    } else {
        Write-Host "==> sql-wasm.wasm OK ($wsz bytes)"
    }
}

Write-Host ''
Write-Host '==> Installation complete.'
Write-Host ''
Write-Host "    Project path:  $Root"
Write-Host "    Start server:  cd `"$Root`"; npm start"
Write-Host '    Open browser:  http://localhost:3001'
Write-Host ''
