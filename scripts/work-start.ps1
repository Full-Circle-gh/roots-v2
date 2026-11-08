# Start a work session: sync from GitHub, then remind how local → GitHub flow works.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\work-start.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '[work] installing git hooks (if needed)…'
node scripts/install-git-hooks.js

Write-Host '[work] pulling latest from GitHub into your local copy…'
npm run sync
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host 'Ready. Edit locally → git commit → GitHub updates automatically (post-commit push).'
Write-Host 'Run:  npm start'
