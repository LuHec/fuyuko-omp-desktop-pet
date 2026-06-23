import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// omp-pet-bridge — thin per-session pipe client.
//
// The pet PROCESS is the single in-memory state authority (it aggregates every
// connected session, debounces, and renders). This extension only tracks this
// session's own signals (agentActive / providerWaiting / streaming / toolCount)
// and forwards hook-derived deltas to the pet over a local named pipe. It owns
// no state machine and no debounce; multiple sessions are coherent because the
// pet aggregates. Connection drop = this session's contribution is dropped.
// ---------------------------------------------------------------------------

const PET_DIR = join(homedir(), ".omp", "omp-desktop-pet");
const PID_FILE = join(PET_DIR, "pet.pid");
const CONTROL_FILE = join(PET_DIR, "pet-control.json");
// Must match the path derived in main.js (both resolve PET_DIR identically).
const PIPE_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\fuyuko-omp-pet"
    : join(PET_DIR, "pet.sock");
const ELECTRON_BIN =
  process.platform === "win32"
    ? join(PET_DIR, "node_modules", "electron", "dist", "electron.exe")
    : join(PET_DIR, "node_modules", ".bin", "electron");

export type PetState =
  | "idle"
  | "waiting"
  | "thinking"
  | "working"
  | "failed"
  | "waving";

const STATE_LOOKUP: Record<string, true> = {
  idle: true,
  waiting: true,
  thinking: true,
  working: true,
  failed: true,
  waving: true,
};

function isPetState(state: string): state is PetState {
  return STATE_LOOKUP[state] === true;
}

type TimerHandle = NodeJS.Timeout;

interface SignalPatch {
  agentActive?: boolean;
  providerWaiting?: boolean;
  streaming?: boolean;
  toolDelta?: number;
  transient?: "failed" | "waving";
  clearTransient?: boolean;
}

export default function ompPetBridge(pi: ExtensionAPI): void {
  let pet: ChildProcess | undefined;
  let sock: Socket | undefined;
  let connected = false;
  let reconnectTimer: TimerHandle | undefined;
  let debugMode = false;
  // Cached so the agent hot path (every hook) never touches the disk.
  let enabledCached = false;
  let shutdown = false;

  // This session's own signals — tracked only to send deltas and to resync
  // after a reconnect. No timing, no visual logic lives here.
  let agentActive = false;
  let providerWaiting = false;
  let streaming = false;
  let toolCount = 0;

  function send(msg: Record<string, unknown>): void {
    if (!connected || !sock) return;
    try {
      sock.write(JSON.stringify(msg) + "\n");
    } catch {
      // connection lost; 'close' will trigger reconnect
    }
  }

  // Forward a hook-derived change. Computes the delta vs. the tracked signals
  // and only sends what actually moved. transient/clearTransient are forwarded
  // as event signals; the pet owns their timers.
  function pushState(event: string, patch: SignalPatch): void {
    if (!enabledCached) return;
    const msg: Record<string, unknown> = { type: "state" };
    let any = false;
    if (patch.agentActive !== undefined && patch.agentActive !== agentActive) {
      agentActive = patch.agentActive;
      msg.agentActive = agentActive;
      any = true;
    }
    if (patch.providerWaiting !== undefined && patch.providerWaiting !== providerWaiting) {
      providerWaiting = patch.providerWaiting;
      msg.providerWaiting = providerWaiting;
      any = true;
    }
    if (patch.streaming !== undefined && patch.streaming !== streaming) {
      streaming = patch.streaming;
      msg.streaming = streaming;
      any = true;
    }
    if (patch.toolDelta !== undefined) {
      const next = Math.max(0, toolCount + patch.toolDelta);
      if (next !== toolCount) {
        toolCount = next;
        msg.toolCount = toolCount;
        any = true;
      }
    }
    if (patch.clearTransient) {
      msg.clearTransient = true;
      any = true;
    } else if (patch.transient) {
      msg.transient = patch.transient;
      any = true;
    }
    if (event) msg.event = event;
    if (any) send(msg);
    if (debugMode) {
      send({ type: "debug", event, state: localPreview(), time: Date.now() });
    }
  }

  function pushReset(event: string): void {
    agentActive = false;
    providerWaiting = false;
    streaming = false;
    toolCount = 0;
    send({
      type: "state",
      event,
      agentActive: false,
      providerWaiting: false,
      streaming: false,
      toolCount: 0,
    });
  }

  // Best-effort preview of this session's own state (debug bubble only; the
  // real visual state is decided by the pet's aggregator).
  function localPreview(): PetState {
    if (toolCount > 0) return "working";
    if (streaming) return "thinking";
    if (providerWaiting || agentActive) return "waiting";
    return "idle";
  }

  function connectPipe(): void {
    if (connected) return;
    try {
      sock = connect(PIPE_PATH);
    } catch {
      sock = undefined;
      scheduleReconnect();
      return;
    }
    sock.on("connect", () => {
      connected = true;
      // Resync: push this session's current signals so a fresh/restarted pet
      // picks up where we are.
      send({ type: "state", agentActive, providerWaiting, streaming, toolCount });
    });
    sock.on("close", () => {
      connected = false;
      sock = undefined;
      scheduleReconnect();
    });
    // Swallow socket errors; 'close' already drives reconnect.
    sock.on("error", () => {});
  }

  function scheduleReconnect(): void {
    clearTimeout(reconnectTimer);
    if (!enabledCached || shutdown) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      startPet();
      connectPipe();
    }, 1000);
  }

  function killPid(pid: number): void {
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // ignore
    }
  }

  function killPidFile(): void {
    if (!existsSync(PID_FILE)) return;
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) killPid(pid);
    try {
      rmSync(PID_FILE, { force: true });
    } catch {
      // ignore
    }
  }

  function startPet(): void {
    if (pet) {
      connectPipe();
      return;
    }
    // Another session may already own the pet — check the PID file.
    if (existsSync(PID_FILE)) {
      const existingPid = Number(readFileSync(PID_FILE, "utf8").trim());
      if (Number.isFinite(existingPid) && existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          connectPipe();
          return; // pet already running from another session
        } catch {
          try {
            rmSync(PID_FILE, { force: true });
          } catch {
            // stale PID file — fall through to spawn
          }
        }
      }
    }
    if (!existsSync(ELECTRON_BIN)) {
      pi.logger.debug(`[pet] electron executable missing: ${ELECTRON_BIN}`);
      return;
    }
    pet = spawn(ELECTRON_BIN, [PET_DIR], {
      cwd: PET_DIR,
      detached: false,
      windowsHide: true,
      stdio: "ignore",
    });
    pet.on("error", (err) => {
      pi.logger.debug(`[pet] failed to start electron: ${err.message}`);
      pet = undefined;
    });
    pet.on("exit", () => {
      pet = undefined;
    });
    pet.on("spawn", () => connectPipe());
  }

  function stopPet(): void {
    pushReset("pet_off");
    send({ type: "quit" });
    connected = false;
    clearTimeout(reconnectTimer);
    try {
      sock?.destroy();
    } catch {
      // ignore
    }
    sock = undefined;
    const pid = pet?.pid;
    setTimeout(() => {
      // quit is the graceful path; kill + PID cleanup is the fallback for a
      // pet that didn't honor it (or one owned by another session).
      if (pid) killPid(pid);
      killPidFile();
    }, 800);
    pet = undefined;
  }

  function readEnabled(): boolean {
    try {
      if (!existsSync(CONTROL_FILE)) return false;
      const parsed = JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
      return parsed.enabled === true;
    } catch {
      return false;
    }
  }

  function writeEnabled(enabled: boolean): void {
    try {
      let sourceDir: string | undefined;
      if (existsSync(CONTROL_FILE)) {
        try {
          sourceDir = JSON.parse(readFileSync(CONTROL_FILE, "utf8")).sourceDir;
        } catch {
          // ignore
        }
      }
      writeFileSync(CONTROL_FILE, JSON.stringify({ enabled, sourceDir }), "utf8");
    } catch {
      // ignore
    }
    enabledCached = enabled;
  }

  function readSourceDir(): string | undefined {
    try {
      if (!existsSync(CONTROL_FILE)) return undefined;
      const parsed = JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
      return typeof parsed.sourceDir === "string" ? parsed.sourceDir : undefined;
    } catch {
      return undefined;
    }
  }

  function normalizeScale(raw: string): number | undefined {
    const cleaned = raw.trim().replace(/%$/, "");
    if (!cleaned) return undefined;
    const numeric = Number(cleaned);
    if (!Number.isFinite(numeric)) return undefined;
    const scale = numeric > 10 ? numeric / 100 : numeric;
    return Math.min(3, Math.max(0.35, scale));
  }

  enabledCached = readEnabled();

  pi.registerCommand("pet", {
    description: "Desktop pet: /pet on | off | size 150 | status | debug | update | test <state>",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/);
      const cmd = parts[0] || "on";

      if (cmd === "on") {
        writeEnabled(true);
        startPet();
        pushState("pet_on", { transient: "waving" });
        ctx.ui.notify("Desktop pet enabled", "info");
        return;
      }
      if (cmd === "off") {
        writeEnabled(false);
        stopPet();
        ctx.ui.notify("Desktop pet disabled", "info");
        return;
      }
      if (cmd === "size") {
        const scale = normalizeScale(parts[1] ?? "");
        if (scale == null) {
          ctx.ui.notify("Usage: /pet size 35..300 or /pet size 0.35..3", "warning");
          return;
        }
        startPet();
        send({ type: "size", scale });
        ctx.ui.notify(`Pet size ${Math.round(scale * 100)}%`, "info");
        return;
      }
      if (cmd === "status") {
        ctx.ui.notify(
          `pet ${enabledCached ? "on" : "off"} | ` +
            `agent=${agentActive} wait=${providerWaiting} stream=${streaming} ` +
            `tools=${toolCount} | debug=${debugMode}`,
          "info",
        );
        return;
      }
      if (cmd === "debug") {
        debugMode = !debugMode;
        startPet();
        send({ type: "debug_mode", enabled: debugMode });
        ctx.ui.notify(
          debugMode ? "Pet debug ON — event bubble visible" : "Pet debug OFF",
          "info",
        );
        return;
      }
      if (cmd === "update") {
        const sourceDir = readSourceDir();
        if (!sourceDir) {
          ctx.ui.notify(
            "No source directory recorded. Reinstall from a GitHub clone or run install.ps1.",
            "warning",
          );
          return;
        }
        const updateScript = join(sourceDir, "install.ps1");
        if (!existsSync(updateScript)) {
          ctx.ui.notify("Installer missing in source directory. Reinstall required.", "warning");
          return;
        }
        ctx.ui.notify("Updating Fuyuko from source...", "info");
        const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
        const updater = spawn(
          shell,
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", updateScript, "-Update"],
          { detached: true, windowsHide: true, stdio: "ignore" },
        );
        updater.on("exit", (code) => {
          if (code === 0) {
            ctx.ui.notify("Fuyuko update complete. Restart OMP to apply.", "info");
          } else {
            ctx.ui.notify(`Fuyuko update failed (exit ${code ?? "unknown"}).`, "error");
          }
        });
        return;
      }
      if (cmd === "test") {
        const state = parts[1] ?? "";
        if (!isPetState(state)) {
          ctx.ui.notify(
            `Usage: /pet test <${Object.keys(STATE_LOOKUP).join("|")}>`,
            "warning",
          );
          return;
        }
        startPet();
        send({ type: "test", state });
        ctx.ui.notify(`Pet test: ${state} (2.5s)`, "info");
        return;
      }
      ctx.ui.notify(
        "Usage: /pet on | off | size 150 | status | debug | update | test <state>",
        "warning",
      );
    },
  });

  // --- OMP event wiring → forward as signal deltas ---

  pi.on("session_start", () => {
    enabledCached = readEnabled();
    if (!enabledCached) return;
    startPet();
    pushState("session_start", { transient: "waving" });
  });

  pi.on("session_shutdown", () => {
    shutdown = true;
    pushReset("session_shutdown");
    clearTimeout(reconnectTimer);
    try {
      sock?.destroy();
    } catch {
      // ignore
    }
    sock = undefined;
    connected = false;
  });

  pi.on("agent_start", () =>
    pushState("agent_start", {
      agentActive: true,
      providerWaiting: true,
      streaming: false,
      clearTransient: true,
    }),
  );

  pi.on("before_provider_request", () =>
    pushState("provider_wait", {
      agentActive: true,
      providerWaiting: true,
      streaming: false,
    }),
  );

  pi.on("message_update", (event) => {
    const streamEvent = event.assistantMessageEvent.type;
    if (
      streamEvent === "thinking_start" ||
      streamEvent === "thinking_delta" ||
      streamEvent === "text_start" ||
      streamEvent === "text_delta" ||
      streamEvent === "toolcall_start" ||
      streamEvent === "toolcall_delta"
    ) {
      pushState(streamEvent, { providerWaiting: false, streaming: true });
      return;
    }
    if (
      streamEvent === "thinking_end" ||
      streamEvent === "text_end" ||
      streamEvent === "toolcall_end" ||
      streamEvent === "done"
    ) {
      pushState(streamEvent, { providerWaiting: agentActive, streaming: false });
    }
  });

  pi.on("tool_execution_start", () =>
    pushState("tool_start", {
      providerWaiting: false,
      streaming: false,
      toolDelta: 1,
      clearTransient: true,
    }),
  );

  pi.on("tool_execution_end", (event) => {
    const patch: SignalPatch = {
      providerWaiting: agentActive,
      streaming: false,
      toolDelta: -1,
    };
    if (event.isError) patch.transient = "failed";
    pushState(event.isError ? "tool_error" : "tool_done", patch);
  });

  pi.on("tool_approval_requested", () =>
    pushState("approval_req", { providerWaiting: true, streaming: false }),
  );

  pi.on("tool_approval_resolved", () =>
    pushState("approval_done", { providerWaiting: agentActive }),
  );

  pi.on("auto_compaction_start", () =>
    pushState("compact_start", { agentActive: true, providerWaiting: true }),
  );

  pi.on("auto_compaction_end", () =>
    pushState("compact_end", {
      agentActive: false,
      providerWaiting: false,
      streaming: false,
    }),
  );

  pi.on("auto_retry_start", () => pushState("retry_start", { transient: "failed" }));

  pi.on("auto_retry_end", () =>
    pushState("retry_end", { clearTransient: true, providerWaiting: agentActive }),
  );

  pi.on("agent_end", () => pushReset("agent_end"));
}
