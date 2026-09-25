/**
 * What the function that builds a tool set is given.
 *
 * A tool set is not assembled from configuration alone: it needs the workspace's own tools, the
 * repository information the request context carries, the store a tool may spill to, the mode the
 * conversation is in, the lock manager that serializes writes, and the classifier's state. The contract
 * is written out rather than passed as an untyped bag because the call site and the builder are separate
 * owners: the handler has the values, the builder knows what they mean, and this is what the two agree
 * on. It deliberately says nothing about how the handler is configured or who owns the state.
 */

import type { Context } from "../../context/context.ts"
import type { AgentMode } from "../../proto/generated/agent/v1/agent_pb.ts"
import type { FileOperationLockManager } from "./core/file-operation-locks.ts"
import type { ToolSetHandle } from "./tool-execution.ts"

export interface AgentToolsGeneratorInput {
  readonly resourceAccessor: unknown
  readonly stateHandler: {
    getBlobStore(): unknown
  }
  readonly agentSessionId: string | undefined
  readonly mcpTools: readonly unknown[]
  readonly repositoryInfos: readonly unknown[]
  readonly blobStore: unknown
  readonly mode: AgentMode
  readonly loggingContext: Context
  readonly requestContext: unknown
  readonly fileOperationLockManager: FileOperationLockManager
  readonly smartModeClassifierMode: unknown
  readonly smartModeClassifierShadowMode: unknown
  readonly autoRejectFirstAskQuestion: boolean | undefined
}

export type AgentToolsGenerator = (input: AgentToolsGeneratorInput) => ToolSetHandle
