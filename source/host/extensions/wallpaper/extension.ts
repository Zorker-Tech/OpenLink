/** Host lifecycle wiring for the optional wallpaper scheduler. */
import { defineHostExtension } from "../host-extensions.ts";
import { realClock, type Clock } from "../scheduling.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { createBoxWallpaperCommands } from "./box-wallpaper-commands.ts";
import { SlateWallpaperSchedule } from "./wallpaper-service.ts";

interface WallpaperSettingsPort {
  getSettingsPath(): string;
  subscribeToUserTimeZone(listener: () => void): () => void;
}

type WallpaperCommandPort = Pick<
  ReturnType<typeof createBoxWallpaperCommands>,
  "isAvailable" | "resolvePlan" | "paint"
>;
type WallpaperCommandOptions = Parameters<typeof createBoxWallpaperCommands>[0];
type WallpaperSchedulePorts = ConstructorParameters<typeof SlateWallpaperSchedule>[0];

export interface WallpaperExtensionServices {
  readonly clock: Clock;
  createCommands(options: WallpaperCommandOptions): WallpaperCommandPort;
  createScheduler(ports: WallpaperSchedulePorts): Pick<SlateWallpaperSchedule, "start" | "dispose">;
}

interface WallpaperExtensionApi {
  readonly isEnabled: boolean;
}

interface WallpaperHostPort {
  log(message: string): void;
}

const productionServices: WallpaperExtensionServices = {
  clock: realClock,
  createCommands: (options) => createBoxWallpaperCommands(options),
  createScheduler: (ports) => new SlateWallpaperSchedule(ports),
};

export function createWallpaperExtension(services: WallpaperExtensionServices = productionServices) {
  return defineHostExtension<WallpaperExtensionApi, WallpaperHostPort>({
    id: HostExtensions.Wallpaper,
    dependencies: [HostExtensions.Settings],
    start: (context) => {
      const settings = context.deps[HostExtensions.Settings] as WallpaperSettingsPort;
      const log = (message: string): void => context.host.log(message);
      const commands = services.createCommands({ settingsPath: settings.getSettingsPath(), log });
      if (!commands.isAvailable) return { isEnabled: false };

      const scheduler = services.createScheduler({
        clock: services.clock,
        resolvePlan: () => commands.resolvePlan(),
        paint: () => commands.paint(),
        subscribeToTimeZoneChange: (listener) => settings.subscribeToUserTimeZone(listener),
        log,
      });
      context.onStop(() => scheduler.dispose());
      scheduler.start();
      return { isEnabled: true };
    },
  });
}

export const wallpaperExtension = createWallpaperExtension();
