/** The per-run input contract shared by tool-set producers and their callers. */

import type { Context } from "../../context/context.ts";
import type { RemoteExecManager } from "../../agent-exec/executor-resources.ts";
import type { ResourceAccessor } from "../../agent-exec/resource-provider.ts";
import type { SlateMode } from "../mode-processing.ts";
import type { FileOperationLockManager } from "./core/file-operation-locks.ts";
import type { ToolSetHandle } from "./tool-execution.ts";

interface AgentToolsMachineAccess {
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly stateHandler: { getBlobStore(): unknown };
  readonly fileOperationLockManager: FileOperationLockManager;
}

interface AgentToolsConversationInput {
  readonly agentSessionId: string | undefined;
  readonly mode: SlateMode;
  readonly loggingContext: Context;
  readonly requestContext: unknown;
}

interface AgentToolsAvailableServices {
  readonly mcpTools: readonly unknown[];
  readonly repositoryInfos: readonly unknown[];
  readonly blobStore: unknown;
}

interface AgentToolsExecutionPolicy {
  readonly smartModeClassifierMode: boolean | undefined;
  readonly smartModeClassifierShadowMode: boolean | undefined;
  readonly autoRejectFirstAskQuestion: boolean | undefined;
}

export interface AgentToolsGeneratorInput extends
  AgentToolsMachineAccess,
  AgentToolsConversationInput,
  AgentToolsAvailableServices,
  AgentToolsExecutionPolicy {}

export type AgentToolsGenerator = (input: AgentToolsGeneratorInput) => ToolSetHandle;
