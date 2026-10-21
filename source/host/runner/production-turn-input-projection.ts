/**
 * The typed handoff between the host's turn preparation and the stream.
 *
 * The host has already produced the generated action and knows where the conversation state lives; the runner-side
 * projection (action, optional MCP discovery, account refresh, cloned state) owns the order. This file is only the shape
 * the host is given back: the action, the tools, the cloned state, and the turn-scope identities that travel with them.
 *
 * Two rules:
 *
 * - **the action is generated, never coerced** — the callback has to return the generated action, because a structural
 *   prompt-collector output that merely looks like one would be a silent behaviour change;
 * - **a turn-scope identity is copied, not wrapped** — the acknowledgement token, the cancellation and the emitter go
 *   through as the same values the caller handed in, so a card emitted here is cancelled by the same turn that cancelled.
 */
import type { Context } from "../../packages/context/context.ts";
import type { ConversationAction, ConversationStateStructure } from "../../packages/proto/generated/agent/v1/agent_pb.ts";
import { createTurnAgentRunInputProjection, type TurnAgentMcpTurnProvider } from "./turn-agent-composition.ts";
import type { ProductionTurnCancelThisRun, ProductionTurnEmitUpdate } from "../runner-production-bridge.ts";
import { presentOptions } from "./optional-options.ts";

export interface ProductionTurnAgentInputProjectionInput {
  readonly runCtx: Context;
  readonly createAction: (runCtx: Context) => Promise<ConversationAction>;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
  readonly getConversationState: () => ConversationStateStructure;
  readonly ackToken?: string | undefined;
  readonly cancelThisRun?: ProductionTurnCancelThisRun;
  readonly emitUpdate?: ProductionTurnEmitUpdate;
}

export interface ProductionTurnAgentInputProjection {
  readonly action: ConversationAction;
  readonly mcpTools: readonly unknown[];
  readonly baseState: ConversationStateStructure;
  readonly ackToken?: string | undefined;
  readonly cancelThisRun?: ProductionTurnCancelThisRun;
  readonly emitUpdate?: ProductionTurnEmitUpdate;
}

/** The projection the stream is started from, with the turn's own identities carried through unchanged. */
export async function createProductionTurnAgentInputProjection(input: ProductionTurnAgentInputProjectionInput): Promise<ProductionTurnAgentInputProjection> {
  const projected = await createTurnAgentRunInputProjection({
    runCtx: input.runCtx,
    createAction: input.createAction,
    getConversationState: input.getConversationState,
    ...presentOptions({ mcp: input.mcp, onMcpDiscoveryFailed: input.onMcpDiscoveryFailed }),
  });
  return {
    action: projected.action,
    mcpTools: projected.mcpTools,
    baseState: projected.baseState,
    ...presentOptions({ ackToken: input.ackToken, cancelThisRun: input.cancelThisRun, emitUpdate: input.emitUpdate }),
  };
}
