param(
  [Parameter(Mandatory = $true)]
  [string]$Tarball,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "AstarrayLite"),
  [string]$Sha256 = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20 or newer is required. Install it from https://nodejs.org/."
}
$nodeVersion = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeVersion -lt 20) {
  throw "Node.js 20 or newer is required (found $nodeVersion)."
}
if (-not (Test-Path -LiteralPath $Tarball)) {
  throw "Tarball not found: $Tarball"
}

$resolvedTarball = (Resolve-Path -LiteralPath $Tarball).Path
$actualHash = (Get-FileHash -LiteralPath $resolvedTarball -Algorithm SHA256).Hash
if ($Sha256 -ne "") {
  $expectedHash = $Sha256 -replace "^sha256:", ""
  if ($actualHash -ne $expectedHash.ToUpperInvariant()) {
    throw "SHA-256 mismatch. Expected $expectedHash but got $actualHash"
  }
  Write-Host "SHA-256 verified: $actualHash"
}

Write-Host "UNSIGNED BETA: this package has no Authenticode certificate." -ForegroundColor Yellow
Write-Host "Windows may show 'Unknown publisher'. Verify the SHA-256 before installing." -ForegroundColor Yellow

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "Installing Astarray Lite into $InstallDir"
$cacheDir = Join-Path $InstallDir "npm-cache"
& npm install --prefix $InstallDir --cache $cacheDir --ignore-scripts --no-audit --no-fund $resolvedTarball
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed with exit code $LASTEXITCODE"
}

$binDir = Join-Path $InstallDir "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$cli = Join-Path $InstallDir "node_modules\astarray-lite\dist\cli\main.js"
if (-not (Test-Path -LiteralPath $cli)) {
  throw "Installed CLI entry is missing: $cli"
}
$launcher = Join-Path $binDir "astarray-lite.cmd"
@"
@echo off
node "$cli" %*
"@ | Set-Content -LiteralPath $launcher -Encoding ASCII

Write-Host ""
Write-Host "Installed: $launcher"
Write-Host "Add the following directory to PATH: $binDir"
Write-Host ""
Write-Host "Set ASTRARRAY_LITE_API_KEY, then run:"
Write-Host "  astarray-lite run --kernel lite `"hello`""
