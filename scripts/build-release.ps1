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
    signed = $false
    signing = "unsigned-beta"
    node = ">=20"
    createdAtIso = (Get-Date).ToUniversalTime().ToString("o")
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir "release.json") -Encoding UTF8

  $warning = @"
Astarray Lite unsigned beta

This build is NOT code-signed.
Windows may show "Unknown publisher" when installing or running it.

SHA-256 of ${tarball}:
$hash

Verify before installing:
  Get-FileHash -Algorithm SHA256 -LiteralPath $tarball

Install:
  powershell -ExecutionPolicy Bypass -File install.ps1 -Tarball $tarball -Sha256 $hash

Only run artifacts from a source you trust.
"@
  $warning | Set-Content -LiteralPath (Join-Path $OutputDir "README-unsigned.txt") -Encoding UTF8

  Write-Host "Release artifacts written to $OutputDir (unsigned beta)"
  Write-Host "Install with:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File $OutputDir\install.ps1 -Tarball $OutputDir\$tarball -Sha256 $hash"
}
finally {
  Pop-Location
}
