import type {
  TurnMcpCall,
  TurnMcpExecutorPort,
  TurnMcpResourceImplementation,
  TurnMcpResultView,
} from "../../../host/runner/turn-mcp-execution-contracts.ts";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/** Projects only the call facts the turn uses for timing, telemetry and an authentication card. */
export function turnMcpCallFromInterop(request: unknown): TurnMcpCall {
  const fields = recordOf(request) ?? {};
  const connectorId = typeof fields.providerIdentifier === "string" ? fields.providerIdentifier : "";
  const serverId = typeof fields.serverIdentifier === "string" ? fields.serverIdentifier : "";
  const callId = typeof fields.toolCallId === "string" ? fields.toolCallId : undefined;
  return { connectorId, serverId, ...(callId === undefined ? {} : { callId }), request };
}

/** Executes an encoded MCP request and exposes a small turn-owned view of its result. */
export function turnMcpExecutorPortFromInterop(executor: unknown): TurnMcpExecutorPort {
  const execute = typeof executor === "object" && executor !== null ? Reflect.get(executor, "execute") : undefined;
  if (typeof execute !== "function") throw new TypeError("MCP executor resource is not executable");
  return {
    async execute(context, call, options): Promise<TurnMcpResultView> {
      const result = await execute.call(executor, context, call.request, options);
      const resultFields = recordOf(recordOf(result)?.result);
      const errorMessage = recordOf(resultFields?.value);
      return {
        kind: resultFields?.case === "error" ? "error" : resultFields?.case === "success" ? "success" : "other",
        encodedResult: result,
        appendAuthenticationNote(note) {
          if (typeof errorMessage?.error === "string") errorMessage.error = `${errorMessage.error}\n${note}`;
        },
      };
    },
  };
}

/** Re-enters the generated MCP resource with an encoded request while the turn policy sees only its own call contract. */
export function turnMcpResourceImplementationFromInterop(
  execute: (context: unknown, call: TurnMcpCall, options?: unknown) => Promise<unknown>,
): TurnMcpResourceImplementation {
  return {
    async execute(context, request, options) {
      return execute(context, turnMcpCallFromInterop(request), options);
    },
  };
}
