<#
.SYNOPSIS
  Pull origin/main, then upload the mini app straight from that checkout via
  WeChat's official CLI (miniprogram-ci) — no WeChat Developer Tools GUI step,
  and no local project folder that can go stale against GitHub.

.PARAMETER Version
  Mini-program version string, e.g. 1.2.3. Must be higher than whatever you
  last uploaded (check mp.weixin.qq.com → 版本管理 if unsure).

.PARAMETER KeyPath
  Path to your mini-program upload private key (.key file). Generate/download
  it from mp.weixin.qq.com → 开发 → 开发管理 → 开发设置 → 小程序代码上传密钥.
  This file is a secret — it is already covered by .gitignore (*.key) and
  must never be committed or shared.

.PARAMETER Robot
  The CI "robot" number (1-30) that key was issued for, from the same console
  page.

.PARAMETER Desc
  Upload description shown in 版本管理. Optional — defaults to something
  generic; pass your own so the version history is actually readable later.

.PARAMETER Path
  Path to your local clone of roots-v2. Defaults to the current directory.

.EXAMPLE
  cd C:\Users\ash\roots-v2
  .\scripts\upload-miniapp.ps1 -Version 1.2.3 -KeyPath C:\keys\private.wxba58433954562887.key -Robot 1 -Desc "one word for one wait (#108)"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$KeyPath,
  [Parameter(Mandatory = $true)][int]$Robot,
  [string]$Desc = "",
  [string]$Path = "."
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Host "✗ -Version must look like 1.2.3 (got: $Version)" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $KeyPath)) {
  Write-Host "✗ Private key not found: $KeyPath" -ForegroundColor Red
  exit 1
}

# ── Step 1: make sure the checkout matches origin/main first ────────────────
# The whole point — WeChat has no idea GitHub exists, so nothing that follows
# means anything unless this checkout is current.
& "$PSScriptRoot\sync-miniapp.ps1" -Path $Path -Branch main
if ($LASTEXITCODE -ne 0) {
  Write-Host "✗ Sync failed — not uploading a possibly-stale checkout." -ForegroundColor Red
  exit 1
}

# ── Step 2: make sure the upload tool is actually installed ─────────────────
Push-Location $Path
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "✗ Node.js isn't on PATH. Install it from https://nodejs.org/ first." -ForegroundColor Red
    exit 1
  }
  # Deliberately isolated in its own subfolder, not the repo's own
  # node_modules — miniprogram-ci pulls an old Babel 6 toolchain that has
  # nothing to do with this app, and only this script ever needs it.
  $toolDir = "scripts/miniapp-ci-tool"
  if (-not (Test-Path "$toolDir/node_modules/miniprogram-ci")) {
    Write-Host ""
    Write-Host "→ Installing miniprogram-ci into $toolDir (first run only)…" -ForegroundColor Cyan
    npm install --prefix $toolDir
    if ($LASTEXITCODE -ne 0) {
      Write-Host "✗ npm install failed." -ForegroundColor Red
      exit 1
    }
  }

  # ── Step 3: upload ──────────────────────────────────────────────────────
  Write-Host ""
  Write-Host "→ Uploading version $Version…" -ForegroundColor Cyan
  $uploadArgs = @("scripts/upload_miniapp.js", "--version", $Version, "--key", $KeyPath, "--robot", $Robot)
  if ($Desc) { $uploadArgs += @("--desc", $Desc) }
  node @uploadArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Upload script exited with an error — see above." -ForegroundColor Red
    exit 1
  }
}
finally {
  Pop-Location
}
