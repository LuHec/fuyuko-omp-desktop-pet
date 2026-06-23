import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PET_DIR = join(homedir(), ".omp", "omp-desktop-pet");
const PID_FILE = join(PET_DIR, "pet.pid");
const CONTROL_FILE = join(PET_DIR, "pet-control.json");
const COMMAND_FILE = join(PET_DIR, "pet-command.json");
const COMMAND_TMP_FILE = join(PET_DIR, "pet-command.tmp.json");
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

const MIN_VISUAL_MS: Record<PetState, number> = {
  idle: 200,
  waiting: 500,
  thinking: 500,
  working: 500,
  failed: 900,
  waving: 600,
};

const TRANSIENT_MS: Partial<Record<PetState, number>> = {
  failed: 3500,
  waving: 900,
};

interface EventAction {
  agentActive?: boolean;
  providerWaiting?: boolean;
  streaming?: boolean;
  toolDelta?: number;
  transient?: PetState;
  clearTransient?: boolean;
}

export default function ompPetBridge(pi: ExtensionAPI): void {
  let pet: ChildProcess | undefined;

  // Semantic model:
  //   idle     = whole user request finished; waiting for user input
  //   waiting  = request is in flight; waiting for LLM stream / next LLM round
  //   thinking = LLM is streaming thinking/text/tool-call content
  //   working  = an actual tool is executing
  //   failed   = transient after tool failure
  //   waving   = transient for pet start/leave
  let agentActive = false;
  let providerWaiting = false;
  let streaming = false;
  let activeToolCount = 0;
  let transient: { state: PetState; timer: TimerHandle } | undefined;
  let testOverride: { state: PetState; timer: TimerHandle } | undefined;

  let visualState: PetState = "idle";
  let visualUntil = 0;
  let pendingState: PetState | undefined;
  let debounceTimer: TimerHandle | undefined;

  let debugMode = false;
  let commandSeq = 0;


  function send(msg: Record<string, unknown>): void {
    const payload = { ...msg, sentAt: Date.now() };
    try {
      writeFileSync(COMMAND_TMP_FILE, JSON.stringify(payload), "utf8");
      renameSync(COMMAND_TMP_FILE, COMMAND_FILE);
    } catch {
      // file IPC unavailable
    }
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
    if (pet) return;
    // Another session may already own the pet — check PID file
    if (existsSync(PID_FILE)) {
      const existingPid = Number(readFileSync(PID_FILE, "utf8").trim());
      if (Number.isFinite(existingPid) && existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          // Pet already running from another session; use shared file IPC
          return;
        } catch {
          // Stale PID file — clean up and spawn fresh
          try { rmSync(PID_FILE, { force: true }); } catch {}
        }
      }
    }
    pet = spawn(ELECTRON_BIN, [PET_DIR], {
      cwd: PET_DIR,
      detached: false,
      windowsHide: true,
      stdio: "ignore",
    });
    pet.on("exit", () => {
      pet = undefined;
    });
    pet.on("spawn", () => {
      setTimeout(() => {
        send({ type: "state", state: visualState });
        if (debugMode) send({ type: "debug_mode", enabled: true });
      }, 600);
    });
  }

  function resetState(clearFailed = false): void {
    agentActive = false;
    providerWaiting = false;
    streaming = false;
    activeToolCount = 0;
    clearTransient(clearFailed);
    clearTestOverride();
    pendingState = undefined;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  }

  function stopPet(): void {
    resetState(true);
    visualState = "waving";
    send({ type: "state", state: "waving" });

    const pid = pet?.pid;
    setTimeout(() => {
      send({ type: "quit" });
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

  function computeTargetState(): PetState {
    if (testOverride) return testOverride.state;
    if (transient) return transient.state;
    if (activeToolCount > 0) return "working";
    if (streaming) return "thinking";
    if (providerWaiting || agentActive) return "waiting";
    return "idle";
  }

  function setTransient(state: PetState): void {
    if (transient?.state === "failed" && state !== "failed") return;
    clearTransient(true);
    const ms = TRANSIENT_MS[state];
    if (ms == null) return;
    transient = {
      state,
      timer: setTimeout(() => {
        transient = undefined;
        syncVisualState();
      }, ms),
    };
  }

  function clearTransient(clearFailed = false): void {
    if (!transient) return;
    if (transient.state === "failed" && !clearFailed) return;
    clearTimeout(transient.timer);
    transient = undefined;
  }

  function clearTestOverride(): void {
    if (testOverride) {
      clearTimeout(testOverride.timer);
      testOverride = undefined;
    }
  }

  function syncVisualState(): void {
    requestVisualState(computeTargetState());
  }

  function requestVisualState(next: PetState): void {
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

  function flushPending(): void {
    debounceTimer = undefined;
    if (pendingState) {
      applyVisualState(pendingState);
      return;
    }
  }

  function forceVisualState(state: PetState, holdMs: number): void {
    visualState = state;
    visualUntil = Date.now() + holdMs;
    pendingState = undefined;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    send({ type: "state", state });
  }

  function applyVisualState(next: PetState): void {
    visualState = next;
    visualUntil = Date.now() + MIN_VISUAL_MS[next];
    pendingState = undefined;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    send({ type: "state", state: next });
    pi.logger.debug(`[pet] state ${next}`);
  }

  function onEvent(event: string, action: EventAction): void {
    if (!readEnabled()) return;

    if (action.agentActive !== undefined) agentActive = action.agentActive;
    if (action.providerWaiting !== undefined) providerWaiting = action.providerWaiting;
    if (action.streaming !== undefined) streaming = action.streaming;
    if (action.toolDelta !== undefined) {
      activeToolCount = Math.max(0, activeToolCount + action.toolDelta);
    }
    if (action.clearTransient) clearTransient();
    if (action.transient) setTransient(action.transient);

    const target = computeTargetState();
    if (debugMode) {
      send({ type: "debug", event, state: target, time: Date.now() });
    }
    pi.logger.debug(
      `[pet] ${event} -> ${target} | agent=${agentActive} wait=${providerWaiting} stream=${streaming} tools=${activeToolCount} trans=${transient?.state ?? "-"}`,
    );

    syncVisualState();
  }

  pi.registerCommand("pet", {
    description: "Desktop pet: /pet on | off | size 150 | status | debug | update | test <state>",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/);
      const cmd = parts[0] || "on";

      if (cmd === "on") {
        writeEnabled(true);
        startPet();
        onEvent("pet_on", { transient: "waving" });
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
          `pet ${readEnabled() ? "on" : "off"} | state=${visualState} | agent=${agentActive} wait=${providerWaiting} stream=${streaming} tools=${activeToolCount} trans=${transient?.state ?? "-"} | debug=${debugMode}`,
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
        clearTestOverride();
        testOverride = {
          state,
          timer: setTimeout(() => {
            testOverride = undefined;
            if (debugMode) {
              send({ type: "debug", event: "test_end", state: computeTargetState(), time: Date.now() });
            }
            syncVisualState();
          }, 2500),
        };
        if (debugMode) {
          send({ type: "debug", event: "test_start", state, time: Date.now() });
        }
        forceVisualState(state, 2500);
        ctx.ui.notify(`Pet test: ${state} (2.5s)`, "info");
        return;
      }
      ctx.ui.notify(
        "Usage: /pet on | off | size 150 | status | debug | update | test <state>",
        "warning",
      );
    },
  });

  pi.on("session_start", () => {
    if (!readEnabled()) return;
    startPet();
    onEvent("session_start", { transient: "waving" });
  });

  pi.on("session_shutdown", () => {
    if (!readEnabled()) return;
    resetState();
    syncVisualState();
  });

  pi.on("agent_start", () =>
    onEvent("agent_start", {
      agentActive: true,
      providerWaiting: true,
      streaming: false,
      clearTransient: true,
    }),
  );

  pi.on("before_provider_request", () =>
    onEvent("provider_wait", {
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
      onEvent(streamEvent, { providerWaiting: false, streaming: true });
      return;
    }
    if (
      streamEvent === "thinking_end" ||
      streamEvent === "text_end" ||
      streamEvent === "toolcall_end" ||
      streamEvent === "done"
    ) {
      onEvent(streamEvent, { providerWaiting: agentActive, streaming: false });
    }
  });

  pi.on("tool_execution_start", () =>
    onEvent("tool_start", {
      providerWaiting: false,
      streaming: false,
      toolDelta: 1,
      clearTransient: true,
    }),
  );

  pi.on("tool_execution_end", (event) => {
    const nextAction: EventAction = {
      providerWaiting: agentActive,
      streaming: false,
      toolDelta: -1,
    };
    if (event.isError) nextAction.transient = "failed";
    onEvent(event.isError ? "tool_error" : "tool_done", nextAction);
  });

  pi.on("tool_approval_requested", () =>
    onEvent("approval_req", { providerWaiting: true, streaming: false }),
  );

  pi.on("tool_approval_resolved", () =>
    onEvent("approval_done", { providerWaiting: agentActive }),
  );

  pi.on("auto_compaction_start", () =>
    onEvent("compact_start", { agentActive: true, providerWaiting: true }),
  );

  pi.on("auto_compaction_end", () =>
    onEvent("compact_end", { agentActive: false, providerWaiting: false, streaming: false }),
  );

  pi.on("auto_retry_start", () =>
    onEvent("retry_start", { transient: "failed" }),
  );

  pi.on("auto_retry_end", () =>
    onEvent("retry_end", { clearTransient: true, providerWaiting: agentActive }),
  );

  pi.on("agent_end", () => {
    resetState();
    onEvent("agent_end", { agentActive: false, providerWaiting: false, streaming: false });
  });
}
