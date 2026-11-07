/** Lists a workspace directory and reports how complete its bounded tree is. */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { SlateDirectoryTreeFile, SlateDirectoryTreeNode } from "../agent-exec/ls.ts";
import type { Context } from "../context/context.ts";
import type { SandboxRule } from "./sandbox-policy.ts";
import { buildLocalDirectoryTree, type DirectoryTreeNodeInit } from "./ls-tree-builder.ts";
import { MissingLsTraversalBindingError, type LsIgnoreService, type LsTraversalRuntime } from "./ls-contracts.ts";

const DEFAULT_CHARACTER_BUDGET = 2_500;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface LocalLsArgs {
  readonly path: string;
  readonly ignore?: readonly string[];
  readonly sandboxPolicy?: SandboxRule;
  readonly timeoutMs?: number;
}

export type LocalLsOutcome =
  | { readonly kind: "success"; readonly root?: SlateDirectoryTreeNode }
  | { readonly kind: "timeout"; readonly root?: SlateDirectoryTreeNode }
  | { readonly kind: "error"; readonly path: string; readonly error: string };

interface MutableDirectoryTreeNode {
  readonly absPath: string;
  readonly childrenDirs: SlateDirectoryTreeNode[];
  readonly childrenFiles: SlateDirectoryTreeFile[];
  childrenWereProcessed: boolean;
  readonly fullSubtreeExtensionCounts: Record<string, number>;
  numFiles: number;
}

export class LocalLsExecutor {
  constructor(
    private readonly _permissionsService: unknown,
    private readonly ignoreService: LsIgnoreService,
    private readonly workspacePath: string,
    private readonly traversal?: LsTraversalRuntime,
  ) {}

  async execute(parentContext: Context, args: LocalLsArgs): Promise<LocalLsOutcome> {
    const targetPath = resolve(this.workspacePath, args.path);
    try {
      let metadata;
      try {
        metadata = await stat(targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return this.errorResult(targetPath, `Path does not exist: ${targetPath}`);
        }
        return this.errorResult(targetPath, error instanceof Error ? error.message : "Unknown error occurred");
      }

      if (!metadata.isDirectory()) return this.errorResult(targetPath, `Path is not a directory: ${targetPath}`);
      if (this.traversal === undefined) throw new MissingLsTraversalBindingError();

      const context = parentContext.withTimeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const { tree, didTimeout } = await buildLocalDirectoryTree({
        context,
        root: targetPath,
        ignoreGlobs: args.ignore ?? [],
        sandboxPolicy: args.sandboxPolicy,
        characterBudget: DEFAULT_CHARACTER_BUDGET,
        ignoreService: this.ignoreService,
        traversal: this.traversal,
        createDirectory(fields: DirectoryTreeNodeInit): MutableDirectoryTreeNode {
          return {
            absPath: fields.absPath,
            childrenDirs: [],
            childrenFiles: [],
            childrenWereProcessed: fields.childrenWereProcessed,
            fullSubtreeExtensionCounts: fields.fullSubtreeExtensionCounts,
            numFiles: 0,
          };
        },
        createFile: (name) => ({ name }),
      });

      return didTimeout
        ? { kind: "timeout", root: tree }
        : { kind: "success", root: tree };
    } catch (error) {
      if (error instanceof MissingLsTraversalBindingError) throw error;
      return this.errorResult(targetPath, error instanceof Error ? error.message : "Unknown error occurred");
    }
  }

  private errorResult(path: string, error: string): LocalLsOutcome {
    return { kind: "error", path, error };
  }
}

export { MissingLsTraversalBindingError } from "./ls-contracts.ts";
export type { LsIgnoreService, LsTraversalRuntime } from "./ls-contracts.ts";
