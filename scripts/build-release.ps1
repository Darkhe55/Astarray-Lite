param(
  [string]$OutputDir = "release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  npm run check
  if ($LASTEXITCODE -ne 0) { throw "check failed" }

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  $tarball = (npm pack --ignore-scripts --cache .npm-cache --pack-destination $OutputDir | Select-Object -Last 1)
  if ([string]::IsNullOrWhiteSpace($tarball)) { throw "npm pack produced no tarball" }

  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\install.ps1") -Destination $OutputDir -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "packaging\uninstall.ps1") -Destination $OutputDir -Force

  $tarballPath = Join-Path $OutputDir $tarball
  $hash = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash
  $manifest = [ordered]@{
    schemaVersion = 1
    package = "astarray-lite"
    tarball = $tarball
    sha256 = $hash
    node = ">=20"
    createdAtIso = (Get-Date).ToUniversalTime().ToString("o")
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir "release.json") -Encoding UTF8

  Write-Host "Release artifacts written to $OutputDir"
  Write-Host "Install with:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File $OutputDir\install.ps1 -Tarball $OutputDir\$tarball"
}
finally {
  Pop-Location
}
