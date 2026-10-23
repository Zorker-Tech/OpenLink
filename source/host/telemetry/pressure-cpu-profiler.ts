/**
 * Taking a CPU profile while the host is under pressure.
 *
 * A profile is only taken when there is pressure to explain and nothing is already being profiled, and what it leaves
 * behind is bounded — the oldest retainedNames are dropped — so diagnostics cannot fill the disk they were meant to explain.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
export class SlateProfilerCaptureError extends Error {}
export const DEFAULT_PROFILE_DURATION_MS = 15_000,
  DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60_000,
  DEFAULT_MAX_RETAINED_PROFILES = 3,
  DEFAULT_SUSTAINED_PRESSURE_WINDOW_MS = 150_000,
  PROFILER_SAMPLING_INTERVAL_US = 10_000,
  PRESSURE_CPU_PROFILE_PREFIX = "slate-host-pressure-",
  PRESSURE_CPU_PROFILE_DIR = "/tmp/slate-host-profiles";
export interface CpuProfilerBackend {
  start(): Promise<void>;
  stop(): Promise<string>;
  dispose(): void;
}
export function createInspectorBackend(): CpuProfilerBackend {
  let inspectorSession: Session | undefined;
  return {
    start: async () => {
      const sessionStarting = new Session();
      sessionStarting.connect();
      try {
        await sessionStarting.post("Profiler.enable");
        await sessionStarting.post("Profiler.setSamplingInterval", {
          interval: PROFILER_SAMPLING_INTERVAL_US,
        });
        await sessionStarting.post("Profiler.start");
      } catch (failure) {
        try {
          sessionStarting.disconnect();
        } catch {}
        throw failure;
      }
      inspectorSession = sessionStarting;
    },
    stop: async () => {
      const activeSession = inspectorSession;
      if (activeSession == null) throw new Error("profiler session not started");
      try {
        const { profile } = await activeSession.post("Profiler.stop");
        if (profile == null)
          throw new SlateProfilerCaptureError("profiler returned no profile");
        return JSON.stringify(profile);
      } finally {
        activeSession.disconnect();
        inspectorSession = undefined;
      }
    },
    dispose: () => {
      inspectorSession?.disconnect();
      inspectorSession = undefined;
    },
  };
}
export interface PressureCpuProfilerKnobs {
  sustainedPressureWindowMs?: number;
  profileDurationMs?: number;
  minIntervalMs?: number;
  maxRetainedProfiles?: number;
}
export function createPressureCpuProfiler(
  options: PressureCpuProfilerKnobs & {
    directory?: string;
    backend?: CpuProfilerBackend;
    now?: () => number;
    overrides?: () => PressureCpuProfilerKnobs | undefined;
    onCaptured?: (profilePath: string) => void;
  },
) {
  const profileDir = options.directory ?? PRESSURE_CPU_PROFILE_DIR,
    profilerBackend = options.backend ?? createInspectorBackend(),
    clock = options.now ?? Date.now;
  const knobs = () => {
    let liveOverrides: PressureCpuProfilerKnobs | undefined;
    try {
      liveOverrides = options.overrides?.();
    } catch {
      liveOverrides = undefined;
    }
    return {
      sustainedPressureWindowMs:
        liveOverrides?.sustainedPressureWindowMs ??
        options.sustainedPressureWindowMs ??
        DEFAULT_SUSTAINED_PRESSURE_WINDOW_MS,
      profileDurationMs:
        liveOverrides?.profileDurationMs ??
        options.profileDurationMs ??
        DEFAULT_PROFILE_DURATION_MS,
      minIntervalMs:
        liveOverrides?.minIntervalMs ?? options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      maxRetainedProfiles: Math.max(
        1,
        liveOverrides?.maxRetainedProfiles ??
          options.maxRetainedProfiles ??
          DEFAULT_MAX_RETAINED_PROFILES,
      ),
    };
  };
  let captureState: "idle" | "sessionStarting" | "profiling" | "stopping" = "idle",
    deadlineMs = 0,
    lastCaptureAt: number | undefined,
    previousPressureAt: number | undefined,
    isDisposed = false;
  const pruneProfiles = (max: number) => {
    const retainedNames = readdirSync(profileDir)
      .filter((fileName) => fileName.startsWith(PRESSURE_CPU_PROFILE_PREFIX))
      .sort();
    for (const fileName of retainedNames.slice(0, Math.max(0, retainedNames.length - max)))
      rmSync(join(profileDir, fileName), { force: true });
  };
  const completeCapture = async () => {
    captureState = "stopping";
    try {
      const profileText = await profilerBackend.stop();
      if (isDisposed) return;
      mkdirSync(profileDir, { recursive: true });
      const profilePath = join(
        profileDir,
        `${PRESSURE_CPU_PROFILE_PREFIX}${clock()}.cpuprofile`,
      );
      writeFileSync(profilePath, profileText);
      pruneProfiles(knobs().maxRetainedProfiles);
      console.warn(`[slate-host] pressure CPU profile written: ${profilePath}`);
      options.onCaptured?.(profilePath);
    } catch (failure) {
      console.warn("[slate-host] pressure CPU profile capture failed:", failure);
    } finally {
      captureState = "idle";
    }
  };
  return {
    onPressure: () => {
      if (isDisposed || captureState !== "idle") return;
      const currentMs = clock(),
        activeKnobs = knobs();
      if (
        lastCaptureAt != null &&
        currentMs - lastCaptureAt < activeKnobs.minIntervalMs
      )
        return;
      const isSustained =
        previousPressureAt != null &&
        currentMs - previousPressureAt <= activeKnobs.sustainedPressureWindowMs;
      if (!isSustained) {
        previousPressureAt = currentMs;
        return;
      }
      previousPressureAt = undefined;
      captureState = "sessionStarting";
      lastCaptureAt = currentMs;
      void profilerBackend
        .start()
        .then(() => {
          if (isDisposed) {
            profilerBackend.dispose();
            captureState = "idle";
            return;
          }
          if (captureState === "sessionStarting") {
            deadlineMs = clock() + activeKnobs.profileDurationMs;
            captureState = "profiling";
          }
        })
        .catch((failure) => {
          console.warn("[slate-host] pressure CPU profile start failed:", failure);
          captureState = "idle";
          lastCaptureAt = undefined;
        });
    },
    onTick: () => {
      if (isDisposed || captureState !== "profiling" || clock() < deadlineMs)
        return;
      void completeCapture();
    },
    dispose: () => {
      if (isDisposed) return;
      isDisposed = true;
      if (captureState === "sessionStarting" || captureState === "profiling") profilerBackend.dispose();
      captureState = "idle";
    },
  };
}
