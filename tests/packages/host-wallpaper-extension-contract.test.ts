import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";
import { createWallpaperExtension, wallpaperExtension, type WallpaperExtensionServices } from "../../source/host/extensions/wallpaper/extension.ts";
import type { Clock } from "../../source/host/extensions/scheduling.ts";

describe("wallpaper host extension declaration", () => {
  it("registers under the wallpaper id and depends on settings", () => {
    assert.equal(wallpaperExtension.kind, "host-extension");
    assert.equal(wallpaperExtension.id, HostExtensions.Wallpaper);
    assert.deepEqual(wallpaperExtension.dependencies, [HostExtensions.Settings]);
    assert.equal(typeof wallpaperExtension.start, "function");
  });

  it("keeps the extension declaration and its dependency list immutable", () => {
    assert.equal(Object.isFrozen(wallpaperExtension), true);
    assert.equal(Object.isFrozen(wallpaperExtension.dependencies), true);
  });

  it("starts scheduling through the settings, command, and host logging ports", async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const clock: Clock = { now: () => 10, monotonicNow: () => 20, schedule: () => ({ dispose: () => {} }) };
    let schedulePorts: Parameters<WallpaperExtensionServices["createScheduler"]>[0] | undefined;
    let stop: (() => void) | undefined;
    const services: WallpaperExtensionServices = {
      clock,
      createCommands: ({ settingsPath, log }) => {
        events.push(`commands:${settingsPath}`);
        log("command log");
        return {
          isAvailable: true,
          resolvePlan: async () => {
            events.push("resolve-plan");
            return { tone: "dawn", msUntilNextBoundary: 5_000 };
          },
          paint: async () => { events.push("paint"); },
        };
      },
      createScheduler: (ports) => {
        schedulePorts = ports;
        events.push("scheduler-created");
        return {
          start: () => { events.push("scheduler-started"); },
          dispose: () => { events.push("scheduler-disposed"); },
        };
      },
    };
    const extension = createWallpaperExtension(services);
    const api = await extension.start({
      deps: {
        [HostExtensions.Settings]: {
          getSettingsPath: () => "/settings/slate.json",
          subscribeToUserTimeZone: (listener: () => void) => {
            events.push("timezone-subscribed");
            return () => { events.push("timezone-unsubscribed"); void listener; };
          },
        },
      },
      host: { log: (message: string) => logs.push(message) },
      onStop: (callback: () => void) => { stop = callback; events.push("stop-registered"); },
    });

    assert.equal(api.isEnabled, true);
    assert.deepEqual(events, ["commands:/settings/slate.json", "scheduler-created", "stop-registered", "scheduler-started"]);
    assert.deepEqual(logs, ["command log"]);
    assert.equal(schedulePorts?.clock, clock);
    assert.deepEqual(await schedulePorts?.resolvePlan(), { tone: "dawn", msUntilNextBoundary: 5_000 });
    await schedulePorts?.paint();
    const unsubscribe = schedulePorts?.subscribeToTimeZoneChange(() => {});
    assert.equal(typeof unsubscribe, "function");
    schedulePorts?.log("scheduler log");
    assert.deepEqual(logs, ["command log", "scheduler log"]);
    stop?.();
    assert.equal(events.at(-1), "scheduler-disposed");
  });

  it("returns disabled without constructing a scheduler when its commands are unavailable", async () => {
    let schedulerCreations = 0;
    let stopRegistrations = 0;
    const services: WallpaperExtensionServices = {
      clock: { now: () => 1, monotonicNow: () => 1, schedule: () => ({ dispose: () => {} }) },
      createCommands: () => ({ isAvailable: false, resolvePlan: async () => undefined, paint: async () => {} }),
      createScheduler: () => {
        schedulerCreations += 1;
        return { start: () => {}, dispose: () => {} };
      },
    };
    const extension = createWallpaperExtension(services);
    const api = await extension.start({
      deps: { [HostExtensions.Settings]: { getSettingsPath: () => "/settings.json", subscribeToUserTimeZone: () => () => {} } },
      host: { log: () => {} },
      onStop: () => { stopRegistrations += 1; },
    });

    assert.deepEqual(api, { isEnabled: false });
    assert.equal(schedulerCreations, 0);
    assert.equal(stopRegistrations, 0);
  });
});
