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

function Assert-LastExitCode([string]$Step) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit $LASTEXITCODE"
  }
}

function Test-GitAvailable {
  return [bool](Get-Command git -ErrorAction SilentlyContinue)
}

function Invoke-InDirectory([string]$Directory, [scriptblock]$Action) {
  Push-Location $Directory
  try {
    & $Action
  }
  finally {
    Pop-Location
  }
}

function Test-PackageLayout([string]$Path) {
  return (Test-Path (Join-Path $Path "apps\desktop-pet")) -and
    (Test-Path (Join-Path $Path "extensions\omp-pet-bridge\index.ts"))
}

function Update-SourceCache([string]$Dir, [string]$Url, [string]$Branch) {
  $Dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir)

  if (Test-Path (Join-Path $Dir ".git")) {
    Write-Info "Pulling latest source into $Dir ..."
    Invoke-InDirectory $Dir {
      git fetch origin $Branch
      Assert-LastExitCode "git fetch"
      git reset --hard "origin/$Branch"
      Assert-LastExitCode "git reset"
    }
    return $Dir
  }

  Write-Info "Fetching source from $Url (branch $Branch) ..."
  Remove-Item -Recurse -Force -Path $Dir -ErrorAction SilentlyContinue

  if (Test-GitAvailable) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dir) | Out-Null
    git clone -b $Branch --single-branch $Url $Dir
    Assert-LastExitCode "git clone"
    return $Dir
  }

  $temp = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    $base = $Url -replace '\.git$',''
    $zipFile = Join-Path $temp "repo.zip"
    Invoke-WebRequest -Uri "$base/archive/refs/heads/$Branch.zip" -OutFile $zipFile -UseBasicParsing
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

  return $Dir
}

function Resolve-PackageRoot {
  $invocationRoot = Split-Path -Parent $MyInvocation.ScriptName
  if (-not $invocationRoot) {
    $invocationRoot = Split-Path -Parent $PSCommandPath
  }

  $isLocalClone = (Test-Path (Join-Path $invocationRoot ".git")) -and (Test-PackageLayout $invocationRoot)
  if ($Update) {
    if ($isLocalClone) {
      Write-Info "Updating from local clone: $invocationRoot"
      Invoke-InDirectory $invocationRoot {
        git pull
        Assert-LastExitCode "git pull"
      }
      return $invocationRoot
    }
    return Update-SourceCache -Dir $SourceDir -Url $RepoUrl -Branch $Branch
  }

  if ($isLocalClone) {
    return $invocationRoot
  }

  Write-Info "This folder is not a git clone. Fetching remote source first ..."
  return Update-SourceCache -Dir $SourceDir -Url $RepoUrl -Branch $Branch
}

function Stop-InstalledPet([string]$PidFile) {
  if (-not (Test-Path $PidFile)) {
    return
  }

  $rawPid = Get-Content $PidFile -Raw
  if ($rawPid -match '^\s*(\d+)\s*$') {
    $runningPet = Get-Process -Id $matches[1] -ErrorAction SilentlyContinue
    if ($runningPet) {
      Stop-Process -Id $runningPet.Id -Force -ErrorAction SilentlyContinue
    }
  }

  Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
}

function Write-ControlFile([string]$ControlFile, [string]$PackageRoot) {
  $control = [ordered]@{ enabled = $true; sourceDir = $PackageRoot }

  if (Test-Path $ControlFile) {
    try {
      $existing = Get-Content $ControlFile -Raw | ConvertFrom-Json -ErrorAction Stop
      foreach ($property in $existing.PSObject.Properties) {
        $control[$property.Name] = $property.Value
      }
    }
    catch {
      $control = [ordered]@{ enabled = $true; sourceDir = $PackageRoot }
    }
  }

  $control.enabled = $true
  $control.sourceDir = $PackageRoot
  $control | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -Path $ControlFile
}

function Install-PetDependencies([string]$TargetPet, [string]$ElectronExe) {
  if (Test-Path $ElectronExe) {
    Write-Info "Electron dependency already present; skipping dependency install."
    return
  }

  Invoke-InDirectory $TargetPet {
    if (Get-Command bun -ErrorAction SilentlyContinue) {
      Write-Info "Installing Electron dependencies with bun..."
      bun install --force
      Assert-LastExitCode "bun install"
    }
    elseif (Get-Command npm -ErrorAction SilentlyContinue) {
      Write-Info "Installing Electron dependencies with npm..."
      npm install
      Assert-LastExitCode "npm install"
    }
    else {
      throw "Neither bun nor npm is available. Install Bun or Node.js, then rerun this script."
    }
  }

  if (-not (Test-Path $ElectronExe)) {
    throw "Electron dependency install did not produce $ElectronExe"
  }
}

$PackageRoot = Resolve-PackageRoot
if (-not (Test-PackageLayout $PackageRoot)) {
  throw "Could not resolve a valid package root: $PackageRoot"
}

$OmpRoot = Join-Path $env:USERPROFILE ".omp"
$TargetPet = Join-Path $OmpRoot "omp-desktop-pet"
$TargetExt = Join-Path $OmpRoot "agent\extensions\omp-pet-bridge"
$ControlFile = Join-Path $TargetPet "pet-control.json"
$PidFile = Join-Path $TargetPet "pet.pid"
$ElectronExe = Join-Path $TargetPet "node_modules\electron\dist\electron.exe"

Write-Info "Installing Fuyuko OMP desktop pet..."
Write-Info "Package root: $PackageRoot"
Write-Info "Target pet app: $TargetPet"
Write-Info "Target extension: $TargetExt"

New-Item -ItemType Directory -Force -Path $TargetPet | Out-Null
New-Item -ItemType Directory -Force -Path $TargetExt | Out-Null

Stop-InstalledPet -PidFile $PidFile

Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $TargetPet "pet-command.json")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $TargetPet "pet-command.tmp.json")

Copy-Item -Recurse -Force (Join-Path $PackageRoot "apps\desktop-pet\*") $TargetPet
Copy-Item -Force (Join-Path $PackageRoot "extensions\omp-pet-bridge\index.ts") (Join-Path $TargetExt "index.ts")
Write-ControlFile -ControlFile $ControlFile -PackageRoot $PackageRoot

if (-not $SkipInstallDeps) {
  Install-PetDependencies -TargetPet $TargetPet -ElectronExe $ElectronExe
}

Write-Info "Done."
if ($Update) {
  Write-Info "Files updated. Restart OMP to load the new extension and pet."
}
else {
  Write-Info "Restart OMP to load the extension."
  Write-Info "Commands after restart: /pet status, /pet debug, /pet test working, /pet test thinking, /pet update"
}
