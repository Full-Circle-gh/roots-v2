<#
.SYNOPSIS
  Sync a local clone of roots-v2 to origin/main before uploading the mini app
  from WeChat Developer Tools.

.WHY THIS EXISTS
  WeChat Developer Tools' Upload button packages whatever is on disk in the
  project folder it has open — it has no idea GitHub exists. A merge to main
  in this repo (on GitHub, or from a Claude Code session) never reaches that
  folder by itself. Run this first, THEN click Upload in the tool, so the
  build WeChat receives is the one that is actually on main.

.PARAMETER Path
  Path to your local clone of roots-v2 — the same folder WeChat Developer
  Tools has open on the miniapp/ subfolder. Defaults to the current directory,
  so `cd` into your clone and just run the script with no arguments.

.PARAMETER Branch
  Branch to sync to. Defaults to main, which is what deploy.yml ships from
  and what production (and this decision) is built against.

.PARAMETER Force
  Local edits in the way (uncommitted changes, or a diverged branch) stop the
  script by default rather than discard anything silently. Pass -Force to
  stash uncommitted changes (git stash push -u), pull, then pop the stash
  back — if the pop conflicts, the script stops with the stash left in place
  so nothing is lost; resolve it by hand (`git stash list`, `git stash pop`).

.EXAMPLE
  cd C:\Users\ash\roots-v2
  .\scripts\sync-miniapp.ps1

.EXAMPLE
  .\scripts\sync-miniapp.ps1 -Path C:\Users\ash\roots-v2 -Force
#>
[CmdletBinding()]
param(
  [string]$Path = ".",
  [string]$Branch = "main",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Fail($msg) {
  Write-Host ""
  Write-Host "✗ $msg" -ForegroundColor Red
  exit 1
}

function Step($msg) {
  Write-Host ""
  Write-Host "→ $msg" -ForegroundColor Cyan
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "git isn't on PATH. Install Git for Windows (https://git-scm.com/download/win) and re-open PowerShell."
}

Push-Location $Path
try {
  # ── Sanity: this is actually a git checkout of THIS repo ──────────────────
  git rev-parse --is-inside-work-tree *> $null
  if ($LASTEXITCODE -ne 0) { Fail "`"$Path`" is not a git repository." }

  $remoteUrl = git remote get-url origin 2>$null
  if ($remoteUrl -notmatch "roots-v2") {
    Fail "origin ($remoteUrl) doesn't look like roots-v2 — pass -Path to the right clone."
  }

  if (-not (Test-Path (Join-Path $Path "miniapp"))) {
    Fail "No miniapp/ folder here — is this the repo root, not the miniapp subfolder?"
  }

  # ── Don't silently discard local edits ─────────────────────────────────────
  # A local change here is most often something made INSIDE WeChat Developer
  # Tools itself (e.g. project.private.config.json, or a debug edit) — never
  # overwrite that without being told to.
  $dirty = git status --porcelain
  $stashed = $false
  if ($dirty) {
    if (-not $Force) {
      Write-Host ""
      Write-Host "Local changes are sitting here, uncommitted:" -ForegroundColor Yellow
      Write-Host $dirty
      Fail "Commit or stash these yourself, or re-run with -Force to stash them automatically (they'll be restored after the pull)."
    }
    Step "Stashing local changes (-Force)…"
    git stash push -u -m "sync-miniapp.ps1 autostash" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "git stash failed — nothing was pulled." }
    $stashed = $true
  }

  $oldHead = git rev-parse --short HEAD

  Step "Fetching origin…"
  git fetch origin
  if ($LASTEXITCODE -ne 0) { Fail "git fetch failed — check your network / GitHub auth." }

  $currentBranch = git rev-parse --abbrev-ref HEAD
  if ($currentBranch -ne $Branch) {
    Step "Checking out $Branch (was on $currentBranch)…"
    git checkout $Branch
    if ($LASTEXITCODE -ne 0) { Fail "git checkout $Branch failed." }
  }

  Step "Pulling origin/$Branch (fast-forward only — never rewrites history here)…"
  git pull --ff-only origin $Branch
  if ($LASTEXITCODE -ne 0) {
    Fail "Fast-forward pull failed — this branch has local commits origin/$Branch doesn't. Sort that out by hand before uploading (WeChat should ship exactly what's on origin/main, nothing extra)."
  }

  if ($stashed) {
    Step "Restoring your stashed local changes…"
    git stash pop
    if ($LASTEXITCODE -ne 0) {
      Write-Host ""
      Write-Host "⚠ Stash pop conflicted. Your changes are safe in the stash — nothing was lost." -ForegroundColor Yellow
      Write-Host "  Run `"git stash list`" and `"git stash pop`" once you've resolved the pull above." -ForegroundColor Yellow
    }
  }

  $newHead = git rev-parse --short HEAD

  Write-Host ""
  if ($oldHead -eq $newHead) {
    Write-Host "✓ Already up to date at $newHead — nothing to pull." -ForegroundColor Green
  } else {
    Write-Host "✓ Synced $oldHead → $newHead" -ForegroundColor Green
    $changed = git diff --name-only $oldHead $newHead -- miniapp/
    if ($changed) {
      Write-Host ""
      Write-Host "  miniapp/ files that changed:" -ForegroundColor Green
      $changed | ForEach-Object { Write-Host "    $_" }
    } else {
      Write-Host "  (nothing under miniapp/ changed in this pull — heads up, the mini app itself didn't move)" -ForegroundColor Yellow
    }
  }

  Write-Host ""
  Write-Host "Now in WeChat Developer Tools:" -ForegroundColor Cyan
  Write-Host "  1. If the project was already open, close and reopen it (or hit its refresh)"
  Write-Host "     so it re-reads the files this pull just changed on disk."
  Write-Host "  2. Click Upload, enter a version number and description, and confirm."
  Write-Host "  3. In mp.weixin.qq.com → 版本管理, set it as the trial version and test it"
  Write-Host "     on a real device before submitting for review / releasing to everyone."
}
finally {
  Pop-Location
}
