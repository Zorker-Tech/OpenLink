import { getSlateRootDir } from "../../host-paths.ts";
import { diskPressureGuard, sampleVolumes, type DiskPressureReport } from "./disk-pressure-guard.ts";
import { createDiskPressureReminderEpisodes, type DiskPressureReminderEpisodes } from "./disk-pressure-reminder-ledger.ts";

export interface DiskPressureWatch {
  readonly level: "soft" | "hard" | null;
  readonly reminderEpisodes: DiskPressureReminderEpisodes;
  subscribe(listener: (level: "soft" | "hard" | null) => void): () => void;
  dispose(): void;
}

interface DiskPressureWatchOptions {
  readonly isInBox: boolean;
  readonly polling: { start(callback: () => Promise<void>): { dispose(): void } };
  readonly report: (report: DiskPressureReport) => void;
  readonly log: (message: string) => void;
}

/** Hold the box poller, current pressure level and listeners for one watch lifetime. */
class DiskPressureWatchController {
  #listeners = new Set<(level: "soft" | "hard" | null) => void>();
  #currentLevel: "soft" | "hard" | null = null;
  #guard: ReturnType<typeof diskPressureGuard> | undefined;
  #poller: { dispose(): void } | undefined;

  readonly reminderEpisodes: DiskPressureReminderEpisodes;

  constructor(private readonly options: DiskPressureWatchOptions) {
    this.reminderEpisodes = createDiskPressureReminderEpisodes({
      ...(options.isInBox ? { rootDir: getSlateRootDir() } : {}),
      onLedgerError: (error) => options.log(`disk-pressure reminder ledger failed: ${String(error)}`),
    });
  }

  start(): void {
    if (!this.options.isInBox) return;
    this.#guard = diskPressureGuard({
      readVolumes: this.readVolumes,
      report: this.options.report,
      onPressureChange: (next) => this.publish(next),
      onSuccessfulSample: (next, complete) => this.reminderEpisodes.observePressure(next, complete),
      log: this.options.log,
    });
    this.#poller = this.options.polling.start(async () => {
      this.#guard?.onTick();
    });
  }

  get level(): "soft" | "hard" | null {
    return this.#currentLevel;
  }

  subscribe(listener: (level: "soft" | "hard" | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#poller?.dispose();
    this.#poller = undefined;
    this.#guard?.dispose();
    this.#guard = undefined;
    this.#listeners.clear();
  }

  private readonly readVolumes = () => sampleVolumes([
    { volume: "workspace", path: "/workspace" },
    { volume: "slate_data", path: getSlateRootDir() },
    { volume: "temp", path: "/tmp" },
  ]);

  private publish(level: "soft" | "hard" | null): void {
    this.#currentLevel = level;
    for (const listener of [...this.#listeners]) listener(level);
  }
}

/** Start the sampler in a box and return its public watch controls. */
export function startDiskPressureWatch(options: DiskPressureWatchOptions): DiskPressureWatch {
  const controller = new DiskPressureWatchController(options);
  controller.start();
  return {
    get level() {
      return controller.level;
    },
    reminderEpisodes: controller.reminderEpisodes,
    subscribe: (listener) => controller.subscribe(listener),
    dispose: () => controller.dispose(),
  };
}
