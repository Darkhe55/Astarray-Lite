param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "AstarrayLite")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InstallDir)) {
  Write-Host "Astarray Lite is not installed at $InstallDir"
  exit 0
}

$resolved = (Resolve-Path -LiteralPath $InstallDir).Path
$expectedRoot = (Resolve-Path -LiteralPath $env:LOCALAPPDATA).Path
if (-not $resolved.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove a directory outside LOCALAPPDATA: $resolved"
}

Write-Host "Removing $resolved"
Remove-Item -LiteralPath $resolved -Recurse -Force
Write-Host "Removed. Remove the bin directory from PATH manually if you added it."
