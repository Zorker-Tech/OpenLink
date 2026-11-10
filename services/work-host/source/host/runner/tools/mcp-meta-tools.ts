/**
 * The meta tools the runner serves for MCP.
 *
 * They are the ones the platform answers itself rather than passing to a server — listing what is available and
 * describing a server's tools — and each of them is bounded in how long it may take.
 */
import {
  buildToolCallExecutionTimedOutMessage,
  toolCallExecutionGuardMs,
} from "../../../packages/agent/tools/tool-execution-timeout.ts";

export function slateToolCallExecutionTimeoutMs(
  toolName: string,
  isComputerUseSubagent: boolean,
): number {
  return toolCallExecutionGuardMs(isComputerUseSubagent ? "subagent" : toolName, undefined);
}

export class SlateToolCallExecutionTimeoutError extends Error {
  override readonly name = "ToolCallExecutionTimeoutError";
  constructor(
    readonly toolName: string,
    readonly executionTimeoutMs: number,
  ) {
    super(buildToolCallExecutionTimedOutMessage({ toolName, executionTimeoutMs }));
  }
}

export interface DynamicToolRegistry {
  resolveToolName(rawArgumentText: string): string | undefined;
}

export interface StreamingInvocationTool<Context, Handler, Meta, Result> {
  readonly name: string;
  execute(
    runContext: Context,
    interactionHandler: Handler,
    argumentChunks: AsyncIterable<string>,
    invocationMeta: Meta,
  ): Promise<Result>;
}

async function withTimeout<Result>(
  pendingOperation: Promise<Result>,
  timeoutMs: number,
  makeTimeoutError: () => Error,
): Promise<Result> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pendingOperation,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(makeTimeoutError()), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
  }
}

export function wrapDynamicInvocationToolWithTimeout<
  Context,
  Handler,
  Meta,
  Result,
  Tool extends StreamingInvocationTool<Context, Handler, Meta, Result>,
>(
  streamingTool: Tool,
  toolRegistry: DynamicToolRegistry,
  isComputerUseSubagent: boolean,
): Tool {
  return {
    ...streamingTool,
    async execute(
      runContext: Context,
      interactionHandler: Handler,
      argumentChunks: AsyncIterable<string>,
      invocationMeta: Meta,
    ): Promise<Result> {
      let rawArgumentText = "";
      for await (const argumentChunk of argumentChunks) rawArgumentText += argumentChunk;
      const resolvedToolName = toolRegistry.resolveToolName(rawArgumentText) ?? streamingTool.name;
      const executionTimeoutMs = slateToolCallExecutionTimeoutMs(
        resolvedToolName,
        isComputerUseSubagent,
      );
      const replay = (async function* () {
        yield rawArgumentText;
      })();
      return withTimeout(
        streamingTool.execute(runContext, interactionHandler, replay, invocationMeta),
        executionTimeoutMs,
        () => new SlateToolCallExecutionTimeoutError(resolvedToolName, executionTimeoutMs),
      );
    },
  };
}

export interface McpToolForMeta {
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly plugin?: unknown;
  readonly marketplace?: unknown;
  readonly pluginId?: string;
  readonly marketplaceId?: string;
}

export interface McpToolDescriptor {
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpDescriptor {
  readonly serverIdentifier: string;
  readonly serverName: string;
  readonly plugin?: unknown;
  readonly marketplace?: unknown;
  readonly pluginDbId?: string;
  readonly marketplaceId?: string;
  readonly tools: McpToolDescriptor[];
}

export function createSlateMcpMetaToolOptions(catalogTools: readonly McpToolForMeta[]) {
  const descriptorsByServer = new Map<string, Omit<McpDescriptor, "serverIdentifier">>();
  for (const streamingTool of catalogTools) {
    const serverIdentifier = streamingTool.providerIdentifier;
    let serverDescriptor = descriptorsByServer.get(serverIdentifier);
    if (serverDescriptor == null) {
      serverDescriptor = {
        serverName: streamingTool.providerIdentifier,
        ...(streamingTool.plugin == null ? {} : { plugin: streamingTool.plugin }),
        ...(streamingTool.marketplace == null ? {} : { marketplace: streamingTool.marketplace }),
        ...(streamingTool.pluginId == null ? {} : { pluginDbId: streamingTool.pluginId }),
        ...(streamingTool.marketplaceId == null ? {} : { marketplaceId: streamingTool.marketplaceId }),
        tools: [],
      };
      descriptorsByServer.set(serverIdentifier, serverDescriptor);
    }
    serverDescriptor.tools.push({
      toolName: streamingTool.toolName,
      ...(streamingTool.description == null ? {} : { description: streamingTool.description }),
      ...(streamingTool.inputSchema == null ? {} : { inputSchema: streamingTool.inputSchema }),
    });
  }
  return {
    enabled: true,
    mcpDescriptors: [...descriptorsByServer.entries()].map(([serverIdentifier, serverDescriptor]) => ({
      serverIdentifier,
      ...serverDescriptor,
      tools: serverDescriptor.tools.sort((left, right) => left.toolName.localeCompare(right.toolName)),
    })),
  };
}
