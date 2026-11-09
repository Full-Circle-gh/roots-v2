<#
.SYNOPSIS
  Let WeChat Developer Tools import/upload the tacetapp repo root (not only miniapp/).

.DESCRIPTION
  Writes repo-root project.config.json with miniprogramRoot = miniapp/ if missing or
  if miniprogramRoot is not set. Safe to run repeatedly.

.EXAMPLE
  cd C:\Users\Asher\tacetapp
  .\scripts\fix-wechat-root-import.ps1
#>
[CmdletBinding()]
param(
  [string]$Path = "."
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path $Path).Path
$cfgPath = Join-Path $root "project.config.json"
$miniApp = Join-Path $root "miniapp\app.json"

if (-not (Test-Path $miniApp)) {
  Write-Host "✗ miniapp\app.json not found under $root — open the tacetapp repo root, not some other folder." -ForegroundColor Red
  exit 1
}

$needWrite = $true
if (Test-Path $cfgPath) {
  try {
    $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($existing.miniprogramRoot -match 'miniapp') {
      Write-Host "✓ project.config.json already points at miniapp/" -ForegroundColor Green
      $needWrite = $false
    }
  } catch {
    Write-Host "→ Replacing invalid project.config.json at repo root…" -ForegroundColor Yellow
  }
}

if ($needWrite) {
  $json = @'
{
  "miniprogramRoot": "miniapp/",
  "compileType": "miniprogram",
  "appid": "wxba58433954562887",
  "projectname": "tacetapp",
  "libVersion": "3.5.5",
  "setting": {
    "ignoreUploadUnusedFiles": false,
    "es6": true,
    "minified": true,
    "urlCheck": true
  }
}
'@
  [System.IO.File]::WriteAllText($cfgPath, $json.Trim() + "`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host "✓ Wrote $cfgPath" -ForegroundColor Green
}

$test = Join-Path $root "scripts\test_wechat_project_import.js"
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path $test)) {
  Write-Host ""
  node $test
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "Next in WeChat Developer Tools:" -ForegroundColor Cyan
Write-Host "  1. Project → Close"
Write-Host "  2. Import → select this folder: $root"
Write-Host "  3. AppID wxba58433954562887 — simulator should load Home"
