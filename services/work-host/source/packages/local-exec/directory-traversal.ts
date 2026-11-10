/** Slate's workspace-confined, cancellable directory traversal for local listings. */
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { minimatch } from "minimatch";

import type { Context } from "../context/context.ts";
import type { LsTraversalRuntime } from "./ls-contracts.ts";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function excluded(relativePath: string, patterns: readonly string[]): boolean {
  const portable = relativePath.split(path.sep).join("/");
  return patterns.some((pattern) =>
    minimatch(portable, pattern, { dot: true })
    || minimatch(portable + "/", pattern, { dot: true })
  );
}

export class LocalDirectoryTraversal implements LsTraversalRuntime {
  readonly #root: string;
  #resolvedRoot: Promise<string> | undefined;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  walk(
    context: Context,
    args: {
      readonly root: string;
      readonly excludeGlobs: readonly string[];
      readonly workspaceIgnoreFiles: readonly string[];
      readonly sandboxPolicy?: unknown;
      readonly source: "ls";
    },
  ): { lines: AsyncIterable<string>; didTimeout: Promise<boolean> } {
    const root = path.resolve(args.root);
    if (!isWithin(this.#root, root)) {
      throw new TypeError("local directory traversal root is outside the local-exec workspace");
    }
    let settle!: (timedOut: boolean) => void;
    const didTimeout = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const lines = this.#walk(context, root, args.excludeGlobs, settle);
    return { lines, didTimeout };
  }

  async resolveForIgnore(filePath: string): Promise<string | null> {
    try {
      const resolved = await realpath(filePath);
      const resolvedRoot = await this.#resolveRoot();
      return isWithin(resolvedRoot, resolved) ? resolved : null;
    } catch {
      return null;
    }
  }

  async #resolveRoot(): Promise<string> {
    const pending = this.#resolvedRoot ?? (this.#resolvedRoot = realpath(this.#root));
    try {
      return await pending;
    } catch (error) {
      if (this.#resolvedRoot === pending) this.#resolvedRoot = undefined;
      throw error;
    }
  }

  async *#walk(
    context: Context,
    root: string,
    excludeGlobs: readonly string[],
    settle: (timedOut: boolean) => void,
  ): AsyncIterable<string> {
    const pending = [root];
    try {
      while (pending.length > 0) {
        if (context.signal.aborted) {
          settle(true);
          return;
        }
        const directory = pending.shift()!;
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (directory === root) throw error;
          continue;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (context.signal.aborted) {
            settle(true);
            return;
          }
          const absolute = path.join(directory, entry.name);
          const relative = path.relative(root, absolute);
          if (excluded(relative, excludeGlobs)) continue;
          if (entry.isDirectory()) {
            pending.push(absolute);
            continue;
          }
          if (entry.isFile() || entry.isSymbolicLink()) yield relative;
        }
      }
      settle(false);
    } catch (error) {
      settle(false);
      throw error;
    }
  }
}
