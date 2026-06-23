# Fuyuko OMP Desktop Pet

This package installs the Fuyuko desktop pet for OMP on another Windows machine.

## What is included

```text
fuyuko-omp-desktop-pet/
  install.ps1                       # Windows installer (also used by /pet update)
  manifest.json
  README.md
  apps/
    desktop-pet/                    # Electron desktop pet
      main.js                       # Electron main process
      index.html                    # Renderer + animation logic
      index.ts
      package.json
      tsconfig.json
      assets/fuyuko/
        spritesheet.png             # Current 11-row high-resolution atlas
        pet.json
        backup-20260623-11row-replace/  # Previous 9-row material backup
  extensions/
    omp-pet-bridge/
      index.ts                      # OMP extension (state bridge)
  dlc/                              # Extra art resources only; installer does not apply these
    fuyuko-11row-highres.png
    fuyuko-11row-index.txt
  docs/fuyuko-source-extended-11row-actions.txt
```

## Runtime design

- OMP loads `~/.omp/agent/extensions/omp-pet-bridge/index.ts` per OMP session.
- The desktop pet is a singleton Electron process under `~/.omp/omp-desktop-pet`.
- Multi-session IPC uses a shared command file: `~/.omp/omp-desktop-pet/pet-command.json`.
- The extension writes commands atomically through a temp file + rename.
- Electron `main.js` watches the command file and forwards state to the renderer.

## Current animation atlas

Current atlas:

```text
apps/desktop-pet/assets/fuyuko/spritesheet.png
4608 x 6864 PNG, transparent RGBA
8 columns x 11 rows
high-res cell: 576 x 624
runtime logical cell: 192 x 208
runtime background-size: 1536 x 2288
```

Rows:

| Row zero-based | Name | Frames | Used for |
|---:|---|---:|---|
| 0 | idle | 6 | idle |
| 1 | running-right | 8 | drag/move right |
| 2 | running-left | 8 | drag/move left |
| 3 | waving | 4 | pet start / greeting |
| 4 | jumping | 5 | available action |
| 5 | failed | 8 | tool failure |
| 6 | waiting | 6 | waiting for model/user/tool approval |
| 7 | running | 6 | one possible `working` visual |
| 8 | review | 6 | one possible `thinking` visual |
| 9 | sos-dance | 8 | one possible `working` visual |
| 10 | contempt-look | 8 | one possible `thinking` visual |

`working` randomly picks `running` or `sos-dance`.
`thinking` randomly picks `review` or `contempt-look`.
The semantic state label/class remains `working` or `thinking`.

All CSS state motion is vertical-only (`translateY`) to avoid sideways shake/rotation.

## Install

1. Clone this repo on the target machine (`git clone https://github.com/LuHec/fuyuko-omp-desktop-pet.git`), or copy this whole folder there.
2. Close OMP completely.
3. Open PowerShell in this folder.
4. If script execution is blocked for this one run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

5. Run:

```powershell
.\install.ps1
```
> If you are running a downloaded copy of `install.ps1` rather than a git clone, edit the `RepoUrl` default at the top of the script or pass it: ` .\install.ps1 -RepoUrl https://github.com/LuHec/fuyuko-omp-desktop-pet.git`.


The installer copies files to:

```text
$env:USERPROFILE\.omp\omp-desktop-pet
$env:USERPROFILE\.omp\agent\extensions\omp-pet-bridge
```

It also installs Electron dependencies with Bun if available, otherwise npm.

If dependencies are already installed or you want to install them manually:

```powershell
.\install.ps1 -SkipInstallDeps
cd $env:USERPROFILE\.omp\omp-desktop-pet
npm install
```

6. Restart OMP.

## Update from source

If you installed from a GitHub clone, you can update without leaving OMP:

```text
/pet update
```

Or, from the local clone folder, run:

```powershell
.\install.ps1 -Update
```

The installer will pull the latest source (via `git`, or a GitHub zip fallback if `git` is not installed), copy the files into `~/.omp`, and keep your `pet-control.json` settings.

After the update finishes, **restart OMP** to load the new extension and pet assets.

## Useful OMP commands

```text
/pet status
/pet debug
/pet test working
/pet test thinking
/pet test failed
/pet update
/pet off
/pet on
```

## Restore previous 9-row art

A backup is included at:

```text
apps/desktop-pet/assets/fuyuko/backup-20260623-11row-replace/spritesheet.png
```

To restore it manually on an installed machine:

```powershell
Copy-Item -Force `
  "$env:USERPROFILE\.omp\omp-desktop-pet\assets\fuyuko\backup-20260623-11row-replace\spritesheet.png" `
  "$env:USERPROFILE\.omp\omp-desktop-pet\assets\fuyuko\spritesheet.png"
```

If restoring the 9-row art, also change `index.html` background-size back to:

```css
background-size: 1536px 1872px;
```

## DLC resources

`dlc/` contains extra source art only. `install.ps1` does not install or activate these files.

## Notes

- Do not copy `pet.pid`, `pet-command.json`, or `pet-size.json` between machines.
- Restart OMP after changing extension code or renderer files.
- If the pet does not appear, check `%USERPROFILE%\.omp\omp-desktop-pet\pet-control.json` contains `{"enabled":true}` and rerun dependency install.
