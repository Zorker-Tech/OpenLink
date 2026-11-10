/** A directory the host watches: what it is watching, and how a change to it is noticed. */
import { mkdirSync, readdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs"; import { dirname } from "node:path"; import type { DebouncePolicy } from "./extensions/scheduling.ts";

type ChangeCallback = (() => void) & { dispose(): void };

export class WatchedDirectory {
  #fsWatcher: FSWatcher | undefined;
  #changeCallback: ChangeCallback | undefined;

  constructor(
    readonly root: string,
    readonly debounce: DebouncePolicy,
    readonly reportFailure: (error: unknown) => void = () => {},
  ) {}

  getLocation(): string {
    return this.root;
  }

  listSubdirectoryNames(): string[] {
    try {
      const entries = readdirSync(this.root, { withFileTypes: true });
      const directories: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) directories.push(entry.name);
      }
      return directories.sort();
    } catch {
      return [];
    }
  }

  setOnChange(onChange?: (() => void) | null): void {
    this.#changeCallback?.dispose();
    if (onChange == null) {
      this.#changeCallback = undefined;
      this.stopWatching();
      return;
    }
    this.#changeCallback = this.debounce.wrap(onChange);
    this.startWatching();
  }

  startWatching(): void {
    if (this.#fsWatcher !== undefined) return;
    try {
      mkdirSync(this.root, { recursive: true });
      const watcher = watch(this.root, { recursive: true }, () => this.scheduleNotify());
      this.#fsWatcher = watcher;
    } catch (error) {
      this.reportFailure(error);
    }
  }

  stopWatching(): void {
    this.#fsWatcher?.close();
    this.#fsWatcher = undefined;
    this.#changeCallback?.dispose();
    this.#changeCallback = undefined;
  }

  scheduleNotify(): void {
    this.#changeCallback?.();
  }

  writeFileAtomic(path: string, contents: string): void {
    const parentDirectory = dirname(path);
    mkdirSync(parentDirectory, { recursive: true });
    const stagedPath = `${path}.tmp`;
    writeFileSync(stagedPath, contents, "utf8");
    renameSync(stagedPath, path);
    this.scheduleNotify();
  }
}
