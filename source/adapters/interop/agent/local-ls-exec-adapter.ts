/** Execute a local listing and wrap its result in the Agent executor message. */

import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { Context } from "../../../packages/context/context.ts"
import {
  LsDirectoryTreeNode_File as LsDirectoryTreeFile,
  LsDirectoryTreeNode,
  LsError,
  LsResult,
  LsSuccess,
  LsTimeout,
} from "../proto/generated/agent/v1/ls_exec_pb.ts"
import { buildLocalDirectoryTree, type DirectoryTreeNodeInit } from "../../../packages/local-exec/ls-tree-builder.ts"
import { MissingLsTraversalBindingError, type LsIgnoreService, type LsTraversalRuntime } from "../../../packages/local-exec/ls-contracts.ts"

const DEFAULT_CHARACTER_BUDGET = 2_500
const DEFAULT_TIMEOUT_MS = 5_000

export class LocalLsExecutor {
  constructor(
    private readonly _permissionsService: unknown,
    private readonly ignoreService: LsIgnoreService,
    private readonly workspacePath: string,
    private readonly traversal?: LsTraversalRuntime,
  ) {}

  async execute(
    parentContext: Context,
    args: {
      readonly path: string
      readonly ignore?: readonly string[]
      readonly timeoutMs?: number
      readonly sandboxPolicy?: unknown
    },
  ): Promise<LsResult> {
    const targetPath = resolve(this.workspacePath, args.path)
    try {
      let metadata
      try {
        metadata = await stat(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return this.errorResult(targetPath, `Path does not exist: ${targetPath}`)
        }
        return this.errorResult(targetPath, error instanceof Error ? error.message : "Unknown error occurred")
      }

      if (!metadata.isDirectory()) return this.errorResult(targetPath, `Path is not a directory: ${targetPath}`)
      if (this.traversal === undefined) throw new MissingLsTraversalBindingError()

      const context = parentContext.withTimeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const { tree, didTimeout } = await buildLocalDirectoryTree({
        context,
        root: targetPath,
        ignoreGlobs: args.ignore ?? [],
        sandboxPolicy: args.sandboxPolicy,
        characterBudget: DEFAULT_CHARACTER_BUDGET,
        ignoreService: this.ignoreService,
        traversal: this.traversal,
        createDirectory: (fields: DirectoryTreeNodeInit) => new LsDirectoryTreeNode(fields as never),
        createFile: name => new LsDirectoryTreeFile({ name }),
      })

      return didTimeout
        ? new LsResult({ result: { case: "timeout", value: new LsTimeout({ directoryTreeRoot: tree }) } })
        : new LsResult({ result: { case: "success", value: new LsSuccess({ directoryTreeRoot: tree }) } })
    } catch (error) {
      if (error instanceof MissingLsTraversalBindingError) throw error
      return this.errorResult(targetPath, error instanceof Error ? error.message : "Unknown error occurred")
    }
  }

  private errorResult(path: string, error: string): LsResult {
    return new LsResult({ result: { case: "error", value: new LsError({ path, error }) } })
  }
}
