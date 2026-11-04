import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDebouncePolicy, realClock } from "../extensions/scheduling.ts";
import { WatchedDirectory } from "../watched-directory.ts";
import {
  AUTOMATION_MAX_RUN_HISTORY,
  type AutomationConfig,
  type AutomationRun,
} from "./automation.ts";
import { parseStoredConfig, parseStoredRun, serializeConfig } from "./automation-store-codecs.ts";
import {
  AUTOMATION_CHANGE_DEBOUNCE_MS,
  CONFIG_FILENAME,
  RUNS_FILENAME,
} from "./automation-store-contracts.ts";

export class AutomationFileRepository {
  readonly watchedDirectory: WatchedDirectory;

  constructor(readonly automationsDir: string) {
    this.watchedDirectory = new WatchedDirectory(
      automationsDir,
      createDebouncePolicy(realClock, {
        name: "slate-automation-store-change",
        delayMs: AUTOMATION_CHANGE_DEBOUNCE_MS,
      }),
    );
  }

  location(): string {
    return this.watchedDirectory.getLocation();
  }

  setOnChange(listener?: (() => void) | null): void {
    this.watchedDirectory.setOnChange(listener);
  }

  configPath(id: string): string {
    return join(this.automationsDir, id, CONFIG_FILENAME);
  }

  runsPath(id: string): string {
    return join(this.automationsDir, id, RUNS_FILENAME);
  }

  listIds(): string[] {
    return this.watchedDirectory.listSubdirectoryNames();
  }

  readConfig(id: string): AutomationConfig | null {
    const path = this.configPath(id);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    return parseStoredConfig(raw, this.fileBirthTime(path));
  }

  writeConfig(id: string, config: AutomationConfig): void {
    this.watchedDirectory.writeFileAtomic(this.configPath(id), serializeConfig(config));
  }

  readRuns(id: string): AutomationRun[] {
    let decoded: unknown;
    try {
      decoded = JSON.parse(readFileSync(this.runsPath(id), "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(decoded)) return [];

    return decoded
      .flatMap((entry) => {
        const run = parseStoredRun(entry);
        return run == null ? [] : [run];
      })
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, AUTOMATION_MAX_RUN_HISTORY);
  }

  writeRuns(id: string, runs: readonly AutomationRun[]): void {
    this.watchedDirectory.writeFileAtomic(this.runsPath(id), `${JSON.stringify(runs, null, 2)}\n`);
  }

  removeFolder(id: string): boolean {
    const folder = join(this.automationsDir, id);
    try {
      if (!statSync(folder).isDirectory()) return false;
    } catch {
      return false;
    }
    rmSync(folder, { recursive: true, force: true });
    this.watchedDirectory.scheduleNotify();
    return true;
  }

  stopWatching(): void {
    this.watchedDirectory.stopWatching();
  }

  private fileBirthTime(path: string): number {
    try {
      const stats = statSync(path);
      return Math.floor(stats.birthtimeMs || stats.mtimeMs);
    } catch {
      return Date.now();
    }
  }
}
