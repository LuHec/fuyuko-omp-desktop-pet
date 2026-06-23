// Electron main process for the Fuyuko desktop pet.
//
// ARCHITECTURE — the pet process is the SINGLE in-memory state authority.
//   - It listens on a local named pipe. Every OMP session (a separate process
//     running the omp-pet-bridge extension) connects as a client and pushes
//     its hook-derived signals as JSON lines.
//   - The pet keeps one in-memory record per live connection, aggregates all
//     of them by priority (failed > working > thinking > waiting > waving >
//     idle), applies the anti-flicker debounce, owns transient timers, and
//     drives the renderer.
//   - A closed connection = that session is gone, so its contribution is
//     dropped automatically. No PID liveness polling, no stale files, no
//     writes on the hot path.

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PET_DIR = import.meta.dirname;
const PID_FILE = resolve(PET_DIR, 'pet.pid');
const SIZE_FILE = resolve(PET_DIR, 'pet-size.json');
const POS_FILE = resolve(PET_DIR, 'pet-position.json');
// Same path is derived in the extension; both resolve PET_DIR identically.
const PIPE_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\fuyuko-omp-pet'
    : join(PET_DIR, 'pet.sock');

const pkg = JSON.parse(readFileSync(resolve(PET_DIR, 'package.json'), 'utf8'));
const BASE_WIDTH = pkg.pet?.width ?? 230;
const BASE_HEIGHT = pkg.pet?.height ?? 250;

// Anti-flicker: each state must hold at least this long before another may
// replace it visually.
const MIN_VISUAL_MS = {
  idle: 200,
  waiting: 500,
  thinking: 500,
  working: 500,
  failed: 900,
  waving: 600,
};
// Transient display windows — owned here, triggered by session signals.
const TRANSIENT_MS = {
  failed: 3500,
  waving: 900,
};

let win;
let currentScale = readSavedScale();

// Renderer replay buffer: commands received before the renderer is ready are
// flushed on did-finish-load (and again after a renderer crash + reload).
let rendererReady = false;
let latestState = 'idle';
let debugEnabled = false;
const debugBuffer = [];

// --- per-session in-memory state (one record per pipe connection) ---
// socket -> { agentActive, providerWaiting, streaming, toolCount, transient, transientTimer }
const sessions = new Map();
let testOverride = undefined; // { state, timer }

// --- visual debounce state machine ---
let visualState = 'idle';
let visualUntil = 0;
let pendingState = undefined;
let debounceTimer = undefined;

function freshSession() {
  return {
    agentActive: false,
    providerWaiting: false,
    streaming: false,
    toolCount: 0,
    transient: null,
    transientTimer: undefined,
  };
}

function readSavedScale() {
  try {
    const data = JSON.parse(readFileSync(SIZE_FILE, 'utf8'));
    const s = Number(data?.scale);
    return Number.isFinite(s) ? Math.min(3, Math.max(0.35, s)) : 1;
  } catch {
    return 1;
  }
}

function readSavedPos() {
  try {
    const d = JSON.parse(readFileSync(POS_FILE, 'utf8'));
    if (Number.isFinite(d.x) && Number.isFinite(d.y)) return { x: d.x, y: d.y };
  } catch {
    // none yet
  }
  return null;
}

let posSaveTimer = undefined;
function savePos() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(posSaveTimer);
  posSaveTimer = setTimeout(() => {
    try {
      const [x, y] = win.getPosition();
      writeFileSync(POS_FILE, JSON.stringify({ x, y }), 'utf8');
    } catch {
      // best-effort
    }
  }, 400);
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
  } catch {
    // best-effort
  }
}

ipcMain.on('pet-resize', (_event, scale) => {
  applyScale(scale);
});

function fwd(channel, ...args) {
  if (!rendererReady || !win || win.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

// --- aggregation ---
function aggregateTarget() {
  if (testOverride) return testOverride.state;
  let failed = false;
  let working = false;
  let thinking = false;
  let waiting = false;
  let waving = false;
  for (const s of sessions.values()) {
    if (s.transient === 'failed') failed = true;
    if (s.toolCount > 0) working = true;
    if (s.streaming) thinking = true;
    if (s.agentActive || s.providerWaiting) waiting = true;
    if (s.transient === 'waving') waving = true;
  }
  if (failed) return 'failed';
  if (working) return 'working';
  if (thinking) return 'thinking';
  if (waiting) return 'waiting';
  if (waving) return 'waving';
  return 'idle';
}

function syncVisualState() {
  requestVisualState(aggregateTarget());
}

function flushPending() {
  debounceTimer = undefined;
  if (pendingState) applyVisualState(pendingState);
}

function requestVisualState(next) {
  if (next === visualState) {
    pendingState = undefined;
    return;
  }
  const now = Date.now();
  if (now >= visualUntil) {
    applyVisualState(next);
    return;
  }
  pendingState = next;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, visualUntil - now);
}

function applyVisualState(next) {
  visualState = next;
  visualUntil = Date.now() + (MIN_VISUAL_MS[next] ?? 200);
  pendingState = undefined;
  clearTimeout(debounceTimer);
  debounceTimer = undefined;
  latestState = next;
  fwd('omp-state', next);
}

function forceVisualState(state, holdMs) {
  visualState = state;
  visualUntil = Date.now() + holdMs;
  pendingState = undefined;
  clearTimeout(debounceTimer);
  debounceTimer = undefined;
  latestState = state;
  fwd('omp-state', state);
}

function applyTestOverride(state) {
  if (testOverride) clearTimeout(testOverride.timer);
  testOverride = {
    state,
    timer: setTimeout(() => {
      testOverride = undefined;
      syncVisualState();
    }, 2500),
  };
  forceVisualState(state, 2500);
}

// --- per-session transient timers (owned here) ---
function setSessionTransient(s, state) {
  // "failed" is sticky: a lesser transient cannot displace it.
  if (s.transient === 'failed' && state !== 'failed') return;
  if (s.transient === state) return;
  clearTimeout(s.transientTimer);
  const ms = TRANSIENT_MS[state];
  if (ms == null) return;
  s.transient = state;
  s.transientTimer = setTimeout(() => {
    s.transient = null;
    s.transientTimer = undefined;
    syncVisualState();
  }, ms);
}

function clearSessionTransient(s, force = false) {
  if (!s.transient) return;
  if (s.transient === 'failed' && !force) return;
  clearTimeout(s.transientTimer);
  s.transient = null;
  s.transientTimer = undefined;
}

// Apply one state message to a session; returns whether anything moved.
function applyStateMessage(s, msg) {
  let changed = false;
  if (msg.agentActive !== undefined && s.agentActive !== msg.agentActive) {
    s.agentActive = msg.agentActive;
    changed = true;
  }
  if (msg.providerWaiting !== undefined && s.providerWaiting !== msg.providerWaiting) {
    s.providerWaiting = msg.providerWaiting;
    changed = true;
  }
  if (msg.streaming !== undefined && s.streaming !== msg.streaming) {
    s.streaming = msg.streaming;
    changed = true;
  }
  if (msg.toolCount !== undefined && s.toolCount !== msg.toolCount) {
    s.toolCount = Math.max(0, msg.toolCount);
    changed = true;
  }
  if (msg.clearTransient) {
    clearSessionTransient(s, true);
    changed = true;
  } else if (msg.transient) {
    setSessionTransient(s, msg.transient);
    changed = true;
  }
  return changed;
}

// --- control channel (multiplexed on the same pipe) ---
function handleControl(msg) {
  switch (msg.type) {
    case 'size':
      applyScale(msg.scale);
      break;
    case 'debug': {
      const entry = { event: msg.event, state: msg.state, time: msg.time || Date.now() };
      debugBuffer.push(entry);
      if (debugBuffer.length > 20) debugBuffer.shift();
      fwd('omp-debug', entry);
      break;
    }
    case 'debug_mode':
      debugEnabled = !!msg.enabled;
      fwd('omp-debug-mode', debugEnabled);
      break;
    case 'test':
      applyTestOverride(String(msg.state || 'idle'));
      break;
    case 'quit':
      app.quit();
      break;
    default:
      break;
  }
}

// --- pipe server ---
function startServer() {
  const server = createServer((sock) => {
    sessions.set(sock, freshSession());
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const s = sessions.get(sock);
        if (!s) continue;
        if (msg.type === 'state') {
          const changed = applyStateMessage(s, msg);
          if (debugEnabled && msg.event) {
            fwd('omp-debug', { event: msg.event, state: aggregateTarget(), time: Date.now() });
          }
          if (changed) syncVisualState();
        } else {
          handleControl(msg);
        }
      }
    });
    sock.on('close', () => {
      const s = sessions.get(sock);
      if (s?.transientTimer) clearTimeout(s.transientTimer);
      sessions.delete(sock);
      syncVisualState();
    });
    // Swallow socket errors; 'close' already handles cleanup.
    sock.on('error', () => {});
  });

  if (process.platform !== 'win32') {
    try {
      rmSync(PIPE_PATH, { force: true });
    } catch {
      // ignore
    }
  }
  server.listen(PIPE_PATH);
  server.on('error', (err) => console.error('[pet] pipe server error:', err));
}

function createWindow() {
  const savedPos = readSavedPos();
  win = new BrowserWindow({
    width: Math.round(BASE_WIDTH * currentScale),
    height: Math.round(BASE_HEIGHT * currentScale),
    x: savedPos ? savedPos.x : pkg.pet?.x,
    y: savedPos ? savedPos.y : pkg.pet?.y,
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

  if (savedPos == null && (pkg.pet?.x == null || pkg.pet?.y == null)) {
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

  // Crash recovery: a dead renderer reloads instead of vanishing silently.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[pet] render-process-gone:', details?.reason);
    setTimeout(() => {
      try {
        if (win && !win.isDestroyed()) win.reload();
      } catch {
        // ignore
      }
    }, 500);
  });

  win.on('moved', savePos);
}

app.whenReady().then(() => {
  try {
    writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    // best-effort
  }
  startServer();
  createWindow();
  syncVisualState();
});

app.on('before-quit', () => {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    // ignore
  }
  if (process.platform !== 'win32') {
    try {
      rmSync(PIPE_PATH, { force: true });
    } catch {
      // ignore
    }
  }
});

app.on('window-all-closed', () => app.quit());

// Never let an unexpected exception silently kill the pet. Log and survive.
process.on('uncaughtException', (err) => {
  console.error('[pet] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[pet] unhandledRejection:', reason);
});
