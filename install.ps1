param(
  [string]$RepoUrl = "https://github.com/LuHec/fuyuko-omp-desktop-pet.git",
  [string]$Branch = "main",
  [string]$SourceDir = (Join-Path (Join-Path $env:USERPROFILE ".omp") ".fuyuko-src"),
  [switch]$Update,
  [switch]$SkipInstallDeps
)

$ErrorActionPreference = "Stop"


function Write-Info([string]$Message) {
  Write-Host $Message
}

function Test-GitAvailable {
  return [bool](Get-Command git -ErrorAction SilentlyContinue)
}

function Update-SourceCache([string]$Dir, [string]$Url, [string]$Branch) {
  $Dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir)


  if (Test-Path (Join-Path $Dir ".git")) {
    Write-Info "Pulling latest source into $Dir ..."
    Push-Location $Dir
    try {
      git fetch origin $Branch
      if ($LASTEXITCODE -ne 0) { throw "git fetch failed with exit $LASTEXITCODE" }
      git reset --hard "origin/$Branch"
      if ($LASTEXITCODE -ne 0) { throw "git reset failed with exit $LASTEXITCODE" }
    }
    finally {
      Pop-Location
    }
    return $Dir
  }

  Write-Info "Fetching source from $Url (branch $Branch) ..."
  Remove-Item -Recurse -Force -Path $Dir -ErrorAction SilentlyContinue

  if (Test-GitAvailable) {
    $parent = Split-Path -Parent $Dir
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    git clone -b $Branch --single-branch $Url $Dir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit $LASTEXITCODE" }
    return $Dir
  }

  # Fallback: download GitHub archive zip when git is unavailable.
  $temp = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    $base = $Url -replace '\.git$',''
    $zipUrl = "$base/archive/refs/heads/$Branch.zip"
    $zipFile = Join-Path $temp "repo.zip"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing
    Expand-Archive -Path $zipFile -DestinationPath $temp -Force
    $extracted = Get-ChildItem -Path $temp -Directory | Select-Object -First 1
    if (-not $extracted) {
      throw "Downloaded archive did not contain a directory."
    }
    Move-Item -Path $extracted.FullName -Destination $Dir -Force
  }
  finally {
    Remove-Item -Recurse -Force -Path $temp -ErrorAction SilentlyContinue
  }

  if (-not (Test-Path (Join-Path $Dir "apps/desktop-pet"))) {
    throw "Source does not contain the expected apps/desktop-pet folder."
  }

  return $Dir
}

# ---------------------------------------------------------------------------
# Resolve the source package root.
# ---------------------------------------------------------------------------
$InvocationRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$IsGitRepo = Test-Path (Join-Path $InvocationRoot ".git")
$LayoutOk = Test-Path (Join-Path $InvocationRoot "apps/desktop-pet")

$PackageRoot = $InvocationRoot

if ($Update) {
  if ($IsGitRepo -and $LayoutOk) {
    Write-Info "Updating from local clone: $InvocationRoot"
    Push-Location $InvocationRoot
    try {
      git pull
      if ($LASTEXITCODE -ne 0) { throw "git pull failed with exit $LASTEXITCODE" }
    }
    finally {
      Pop-Location
    }
    $PackageRoot = $InvocationRoot
  }
  else {
    $PackageRoot = Update-SourceCache -Dir $SourceDir -Url $RepoUrl -Branch $Branch
  }
}
else {
  if (-not ($IsGitRepo -and $LayoutOk)) {
    Write-Info "This folder is not a git clone. Fetching remote source first ..."
    $PackageRoot = Update-SourceCache -Dir $SourceDir -Url $RepoUrl -Branch $Branch
  }
}

if (-not (Test-Path (Join-Path $PackageRoot "apps/desktop-pet"))) {
  throw "Could not resolve a valid package root (missing apps/desktop-pet): $PackageRoot"
}

# ---------------------------------------------------------------------------
# Install / update the runtime files under ~/.omp.
# ---------------------------------------------------------------------------
$OmpRoot = Join-Path $env:USERPROFILE ".omp"
$TargetPet = Join-Path $OmpRoot "omp-desktop-pet"
$TargetExt = Join-Path $OmpRoot "agent\extensions\omp-pet-bridge"
$ControlFile = Join-Path $TargetPet "pet-control.json"
$PidFile = Join-Path $TargetPet "pet.pid"

Write-Info "Installing Fuyuko OMP desktop pet..."
Write-Info "Package root: $PackageRoot"
Write-Info "Target pet app: $TargetPet"
Write-Info "Target extension: $TargetExt"

New-Item -ItemType Directory -Force -Path $TargetPet | Out-Null
New-Item -ItemType Directory -Force -Path $TargetExt | Out-Null

# Stop any running pet so its files can be replaced cleanly.
if (Test-Path $PidFile) {
  $rawPid = Get-Content $PidFile -Raw
  if ($rawPid -match '^\s*(\d+)\s*$') {
    $runningPet = Get-Process -Id $matches[1] -ErrorAction SilentlyContinue
    if ($runningPet) {
      Stop-Process -Id $runningPet.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
}

# Remove runtime files that must not be migrated across machines.
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $TargetPet "pet-command.json")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $TargetPet "pet-command.tmp.json")

Copy-Item -Recurse -Force (Join-Path $PackageRoot "apps\desktop-pet\*") $TargetPet
Copy-Item -Force (Join-Path $PackageRoot "extensions\omp-pet-bridge\index.ts") (Join-Path $TargetExt "index.ts")

# Preserve existing control settings; record the source directory for /pet update.
$control = @{ enabled = $true; sourceDir = $PackageRoot }
if (Test-Path $ControlFile) {
  try {
    $existing = Get-Content $ControlFile -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($existing) {
      $existing.enabled = $true
      $existing.sourceDir = $PackageRoot
      $control = $existing
    }
  }
  catch {
    # ignore corrupted control file and use defaults
  }
}
$control | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -Path $ControlFile

if (-not $SkipInstallDeps) {
  $ElectronExe = Join-Path $TargetPet "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path $ElectronExe)) {
    Push-Location $TargetPet
    try {
      if (Get-Command bun -ErrorAction SilentlyContinue) {
        Write-Info "Installing Electron dependencies with bun..."
        bun install
      }
      elseif (Get-Command npm -ErrorAction SilentlyContinue) {
        Write-Info "Installing Electron dependencies with npm..."
        npm install
      }
      else {
        throw "Neither bun nor npm is available. Install Bun or Node.js, then rerun this script."
      }
    }
    finally {
      Pop-Location
    }
  }
  else {
    Write-Info "Electron dependency already present; skipping dependency install."
  }
}

Write-Info "Done."
if ($Update) {
  Write-Info "Files updated. Restart OMP to load the new extension and pet."
}
else {
  Write-Info "Restart OMP to load the extension."
  Write-Info "Commands after restart: /pet status, /pet debug, /pet test working, /pet test thinking, /pet update"
}
