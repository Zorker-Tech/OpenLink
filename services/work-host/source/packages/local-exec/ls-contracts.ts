import type { Context } from "../context/context.ts";

export interface LsIgnoreService {
  listWorkspaceIgnoreFilesByRoot(root: string): Promise<readonly string[]>;
  getRepoBlockExcludeGlobs(root: string): Promise<readonly string[]>;
  isRepoBlocked(path: string): Promise<boolean> | boolean;
}

export interface LsTraversalRuntime {
  walk(
    ctx: Context,
    args: {
      root: string;
      excludeGlobs: readonly string[];
      workspaceIgnoreFiles: readonly string[];
      sandboxPolicy?: unknown;
      source: "ls";
    },
  ): { lines: AsyncIterable<string>; didTimeout: Promise<boolean> };
  resolveForIgnore(path: string): Promise<string | null>;
}

export class MissingLsTraversalBindingError extends Error {
  constructor() {
    super("");
    this.name = "MissingLsTraversalBindingError";
  }
}
