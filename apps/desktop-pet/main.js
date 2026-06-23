import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { existsSync, readFileSync, watchFile, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

let win;
const PID_FILE = resolve(import.meta.dirname, 'pet.pid');
const SIZE_FILE = resolve(import.meta.dirname, 'pet-size.json');
const COMMAND_FILE = resolve(import.meta.dirname, 'pet-command.json');
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
const BASE_WIDTH = pkg.pet?.width ?? 230;
const BASE_HEIGHT = pkg.pet?.height ?? 250;
let currentScale = readSavedScale();

// State replay — buffer the latest values so commands received before the
// renderer is ready are not lost.
let rendererReady = false;
let latestState = 'idle';
let debugEnabled = false;
const debugBuffer = [];

function readSavedScale() {
  try {
    const data = JSON.parse(readFileSync(SIZE_FILE, 'utf8'));
    const s = Number(data?.scale);
    return Number.isFinite(s) ? Math.min(3, Math.max(0.35, s)) : 1;
  } catch {
    return 1;
  }
}

function clampScale(scale, fallback = currentScale) {
  const numeric = Number(scale);
  if (!Number.isFinite(numeric)) return Number.isFinite(fallback) ? fallback : 1;
  return Math.min(3, Math.max(0.35, numeric));
}

function applyScale(scale) {
  currentScale = clampScale(scale);
  if (!win || win.isDestroyed()) return;
  win.setSize(Math.round(BASE_WIDTH * currentScale), Math.round(BASE_HEIGHT * currentScale));
  win.webContents.send('omp-size', currentScale);
  try {
    writeFileSync(SIZE_FILE, JSON.stringify({ scale: currentScale }), 'utf8');
  } catch {}
}

ipcMain.on('pet-resize', (_event, scale) => {
  applyScale(scale);
});

// Forward to renderer only when it's ready; otherwise the value is buffered
// and replayed on did-finish-load.
function fwd(channel, ...args) {
  if (!rendererReady || !win || win.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

function handleLine(cmd) {
  if (cmd.type === 'state') {
    latestState = String(cmd.state || 'idle');
    fwd('omp-state', latestState);
    return;
  }
  if (cmd.type === 'quit') {
    app.quit();
    return;
  }
  if (cmd.type === 'size') {
    applyScale(cmd.scale);
    return;
  }
  if (cmd.type === 'debug') {
    const entry = { event: cmd.event, state: cmd.state, time: cmd.time || Date.now() };
    debugBuffer.push(entry);
    if (debugBuffer.length > 20) debugBuffer.shift();
    fwd('omp-debug', entry);
    return;
  }
  if (cmd.type === 'debug_mode') {
    debugEnabled = !!cmd.enabled;
    fwd('omp-debug-mode', debugEnabled);
    return;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: Math.round(BASE_WIDTH * currentScale),
    height: Math.round(BASE_HEIGHT * currentScale),
    x: pkg.pet?.x,
    y: pkg.pet?.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (pkg.pet?.x == null || pkg.pet?.y == null) {
    const { workArea } = screen.getPrimaryDisplay();
    const w = Math.round(BASE_WIDTH * currentScale);
    const h = Math.round(BASE_HEIGHT * currentScale);
    win.setPosition(
      Math.round(workArea.x + (workArea.width - w) / 2),
      Math.round(workArea.y + (workArea.height - h) / 2),
    );
  }

  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    win.webContents.send('omp-size', currentScale);
    win.webContents.send('omp-state', latestState);
    if (debugEnabled) win.webContents.send('omp-debug-mode', true);
    for (const entry of debugBuffer) {
      win.webContents.send('omp-debug', entry);
    }
  });

  win.on('right-up', () => win.close());

  // Watch command file (atomic rename by extension => reliable on Windows)
  function processCommandFile() {
    let raw;
    try {
      raw = readFileSync(COMMAND_FILE, 'utf8');
    } catch {
      return;
    }
    let cmd;
    try {
      cmd = JSON.parse(raw);
    } catch {
      return;
    }
    handleLine(cmd);
  }

  watchFile(COMMAND_FILE, { interval: 100 }, () => processCommandFile());
  processCommandFile();
}

app.whenReady().then(() => {
  writeFileSync(PID_FILE, String(process.pid), 'utf8');
  createWindow();
});

app.on('before-quit', () => {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {}
});

app.on('window-all-closed', () => app.quit());
