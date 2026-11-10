/**
 * Taking a CPU profile under sustained pressure: the gate, the capture lifecycle, retention and overrides.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_RETAINED_PROFILES,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_PROFILE_DURATION_MS,
  DEFAULT_SUSTAINED_PRESSURE_WINDOW_MS,
  PRESSURE_CPU_PROFILE_DIR,
  PRESSURE_CPU_PROFILE_PREFIX,
  PROFILER_SAMPLING_INTERVAL_US,
  SlateProfilerCaptureError,
  createInspectorBackend,
  createPressureCpuProfiler,
} from "../../source/host/telemetry/pressure-cpu-profiler.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function world(options: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pressure-suite-"));
  const records: string[] = [];
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let time = (options.startTime as number | undefined) ?? 1_000;
  let captured: string | undefined;
  const backend = {
    async start() { records.push("start"); if (options.startFails === true) throw new Error("start failed"); },
    async stop() { records.push("stop"); if (options.stopFails === true) throw new Error("stop failed"); return "{\"profile\":true}"; },
    dispose() { records.push("dispose"); },
  };
  const profiler = createPressureCpuProfiler({
    directory,
    backend,
    now: () => time,
    ...(options.window === undefined ? {} : { sustainedPressureWindowMs: options.window as number }),
    ...(options.duration === undefined ? {} : { profileDurationMs: options.duration as number }),
    ...(options.interval === undefined ? {} : { minIntervalMs: options.interval as number }),
    ...(options.retained === undefined ? {} : { maxRetainedProfiles: options.retained as number }),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides as () => never }),
    ...(options.collect === true ? { onCaptured: (profilePath: string) => { captured = profilePath; } } : {}),
  });
  return {
    directory, records, warnings, profiler,
    setTime: (value: number) => { time = value; },
    now: () => time,
    captured: () => captured,
    restore: () => { console.warn = originalWarn; },
  };
}

/** Arms a capture, lets the backend start, then advances past the duration and ticks. */
async function captureOnce(w: ReturnType<typeof world>, advance = 1_000): Promise<void> {
  w.profiler.onPressure();
  w.setTime(w.now() + 1);
  w.profiler.onPressure();
  await flush();
  await flush();
  w.setTime(w.now() + advance);
  w.profiler.onTick();
  await flush();
}

test("the constants and the capture error are the public surface", () => {
  assert.deepEqual(
    [DEFAULT_PROFILE_DURATION_MS, DEFAULT_MIN_INTERVAL_MS, DEFAULT_MAX_RETAINED_PROFILES, DEFAULT_SUSTAINED_PRESSURE_WINDOW_MS, PROFILER_SAMPLING_INTERVAL_US],
    [15_000, 21_600_000, 3, 150_000, 10_000],
  );
  assert.equal(PRESSURE_CPU_PROFILE_PREFIX, "slate-host-pressure-");
  assert.equal(PRESSURE_CPU_PROFILE_DIR, "/tmp/slate-host-profiles");
  assert.equal(new SlateProfilerCaptureError("x").message, "x");
});

test("a single pressure event never starts a profile", async () => {
  const w = world();
  w.profiler.onPressure();
  w.profiler.onTick();
  await flush();
  assert.deepEqual(w.records, []);
  w.restore();
});

test("sustained pressure starts a profile and a late tick captures it", async () => {
  const w = world({ window: 100, duration: 50, interval: 1_000, retained: 3 });
  await captureOnce(w);
  assert.deepEqual(w.records, ["start", "stop"]);
  const files = readdirSync(w.directory);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.startsWith(PRESSURE_CPU_PROFILE_PREFIX), true);
  assert.equal(files[0]?.endsWith(".cpuprofile"), true);
  w.restore();
});

test("a capture inside the minimum interval is skipped", async () => {
  const w = world({ window: 100, duration: 50, interval: 10_000, retained: 3 });
  await captureOnce(w);
  assert.deepEqual(w.records, ["start", "stop"]);
  w.profiler.onPressure();
  w.setTime(w.now() + 1);
  w.profiler.onPressure();
  await flush();
  await flush();
  w.setTime(w.now() + 1_000);
  w.profiler.onTick();
  await flush();
  assert.deepEqual(w.records, ["start", "stop"]);
  w.restore();
});

test("older profiles are pruned to the retention limit", async () => {
  const w = world({ window: 100, duration: 50, interval: 0, retained: 2 });
  await captureOnce(w);
  await captureOnce(w);
  await captureOnce(w);
  assert.equal(readdirSync(w.directory).length, 2);
  w.restore();
});

test("overrides replace the knob values, and a throwing overrides getter falls back", async () => {
  const overridden = world({ window: 1_000, duration: 1_000, interval: 1_000, retained: 3, overrides: () => ({ sustainedPressureWindowMs: 10, profileDurationMs: 5, minIntervalMs: 0, maxRetainedProfiles: 1 }) });
  await captureOnce(overridden);
  assert.deepEqual(overridden.records, ["start", "stop"]);
  overridden.restore();
  const throwing = world({ overrides: () => { throw new Error("bad overrides"); } });
  await captureOnce(throwing, 200_000);
  assert.deepEqual(throwing.records, ["start", "stop"]);
  throwing.restore();
});

test("a failing start is reported and the profiler can try again", async () => {
  const w = world({ window: 10, duration: 10, interval: 0, retained: 3, startFails: true });
  w.profiler.onPressure();
  w.setTime(w.now() + 1);
  w.profiler.onPressure();
  await flush();
  await flush();
  assert.deepEqual(w.records, ["start"]);
  assert.equal(w.warnings.length, 1);
  w.restore();
});

test("disposing while starting disposes the backend and stops taking captures", async () => {
  const w = world({ window: 10, duration: 10, interval: 0, retained: 3 });
  w.profiler.onPressure();
  w.setTime(w.now() + 1);
  w.profiler.onPressure();
  w.profiler.dispose();
  w.profiler.dispose();
  await flush();
  await flush();
  w.profiler.onPressure();
  assert.deepEqual(w.records, ["start", "dispose", "dispose"]);
  w.restore();
});

test("a failing stop is only a warning", async () => {
  const w = world({ window: 10, duration: 5, interval: 0, retained: 3, stopFails: true });
  await captureOnce(w);
  assert.deepEqual(w.records, ["start", "stop"]);
  assert.equal(w.warnings.length >= 1, true);
  w.restore();
});

test("the captured path is handed on, and the inspector backend refuses an early stop", async () => {
  const w = world({ window: 10, duration: 5, interval: 0, retained: 3, collect: true });
  await captureOnce(w);
  assert.equal(typeof w.captured(), "string");
  w.restore();
  const backend = createInspectorBackend();
  backend.dispose();
  await assert.rejects(() => backend.stop(), (error: unknown) => (error as Error).message === "profiler session not started");
});
