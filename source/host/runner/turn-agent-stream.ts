/**
 * One turn's stream, from its Slate action to the checkpoints around it.
 *
 * There are two callers with different lifetimes, so this file owns the difference:
 *
 * - a **path** is built once and reused: the Slate action is assembled, the Agent stream is started, and both are
 *   remembered, so asking it for the same run twice does not project or start again;
 * - a **lifecycle** runs once: every run projects the action and starts the stream for itself, because the projection
 *   carries per-turn identity (action, MCP discovery, state clone, redaction, generation guards) that must not be
 *   shared with the previous turn.
 *
 * Everything outside that difference is the same in both — the projection, the redacted stream start, and the outer
 * attempt that owns checkpointing — so it is written once here and given to either caller.
 */
import type { Context } from "../../packages/context/context.ts";
import type { SlateAgentAction } from "../../packages/agent/agent-action-state.ts";
import type { PrivacyMode } from "../../packages/redaction/privacy-mode.ts";
import {
  createTurnAgentRunInputProjection,
  createTurnAgentStreamStart,
  type BuiltTurnAgentForRun,
  type TurnAgentMcpTurnProvider,
} from "./turn-agent-composition.ts";
import {
  createOuterStreamLifecycle,
  type OuterStreamLifecycleInput,
  type OuterStreamPersistence,
  type StreamAttemptHost,
} from "./stream-attempt.ts";
import type {
  AgentConversationAction,
  AgentConversationState,
} from "../../adapters/interop/agent/agent-turn-stream-contract-adapter.ts";

/** What one stream start needs: the run's context, where to resume from, and where checkpoints go. */
export interface TurnStreamStartInput {
  readonly runCtx: Context;
  readonly resumeFrom?: AgentConversationState;
  readonly persistCheckpoint: (checkpointCtx: Context, checkpoint: AgentConversationState) => Promise<void> | void;
}

/** What a reused path is built from: the Agent, how its action is made, its state, redaction and MCP tools. */
export interface TurnStreamPathInput {
  readonly builtAgent: Pick<BuiltTurnAgentForRun, "agent">;
  readonly assembleSlateTurnAction: (runCtx: Context) => Promise<AgentConversationAction | SlateAgentAction>;
  readonly getConversationState: () => AgentConversationState;
  readonly privacyMode: PrivacyMode;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
}

/** What the outer attempt owns: the attempt host, how checkpoints persist, and the optional ends of a run. */
export interface TurnStreamOuterInput {
  readonly attempt: Omit<StreamAttemptHost<Context, AgentConversationState, AgentConversationState>, "startStream" | "persistCheckpoint">;
  readonly persistence: OuterStreamPersistence<Context, AgentConversationState>;
  readonly cleanup?: () => void | Promise<void>;
  readonly onCompleted?: (state: AgentConversationState) => void | Promise<void>;
}

export interface TurnStreamLifecycleInput extends TurnStreamPathInput, TurnStreamOuterInput {}

/** A stream start that has already projected its action and built its redacted start. */
interface TurnStreamStart {
  startStream(runCtx: Context, resumeFrom: AgentConversationState | undefined, persistCheckpoint: TurnStreamStartInput["persistCheckpoint"]): Promise<AgentConversationState>;
}

export interface TurnStreamPath {
  startStream(input: TurnStreamStartInput): Promise<AgentConversationState>;
  createLifecycle(input: TurnStreamOuterInput): ReturnType<typeof createOuterStreamLifecycle<Context, AgentConversationState>>;
}

export interface TurnStreamLifecycle {
  run(context: Context): Promise<AgentConversationState>;
}

/** The projection and the stream start it feeds, for one run: the part both lifetimes do the same way. */
async function turnStreamStartFor(input: TurnStreamPathInput, runCtx: Context): Promise<TurnStreamStart> {
  const projected = await createTurnAgentRunInputProjection({
    runCtx,
    createAction: input.assembleSlateTurnAction,
    ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
    ...(input.onMcpDiscoveryFailed === undefined ? {} : { onMcpDiscoveryFailed: input.onMcpDiscoveryFailed }),
    getConversationState: input.getConversationState,
  });
  return createTurnAgentStreamStart({
    agent: input.builtAgent,
    baseState: projected.baseState,
    action: projected.action,
    privacyMode: input.privacyMode,
    mcpTools: projected.mcpTools,
  });
}

/** The outer attempt around one stream start: checkpoints, cleanup and completion are the caller's, unchanged. */
function outerLifecycleFor(startStream: TurnStreamStart, input: TurnStreamOuterInput) {
  const attempt: OuterStreamLifecycleInput<Context, AgentConversationState>["attempt"] = {
    ...input.attempt,
    startStream: (runCtx, resumeFrom, persistCheckpoint) =>
      startStream.startStream(runCtx, resumeFrom === undefined ? undefined : resumeFrom, persistCheckpoint),
  };
  return createOuterStreamLifecycle<Context, AgentConversationState>({
    attempt,
    persistence: input.persistence,
    ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
    ...(input.onCompleted === undefined ? {} : { onCompleted: input.onCompleted }),
  });
}

/** A path built once: the first run projects and starts, and later runs take what it remembered. */
export function createTurnStreamPath(input: TurnStreamPathInput): TurnStreamPath {
  let start: Promise<TurnStreamStart> | undefined;
  const rememberedStartFor = (runCtx: Context) => (start ??= turnStreamStartFor(input, runCtx));
  const path: TurnStreamPath = {
    async startStream(streamInput) {
      const remembered = await rememberedStartFor(streamInput.runCtx);
      return remembered.startStream(streamInput.runCtx, streamInput.resumeFrom, streamInput.persistCheckpoint);
    },
    createLifecycle(outerInput) {
      const wrapped: TurnStreamStart = {
        async startStream(runCtx, resumeFrom, persistCheckpoint) {
          const remembered = await rememberedStartFor(runCtx);
          return remembered.startStream(runCtx, resumeFrom, persistCheckpoint);
        },
      };
      return outerLifecycleFor(wrapped, outerInput);
    },
  };
  return path;
}

/** A lifecycle that runs once: its projection, stream start and checkpoints belong to this run only. */
export function createTurnStreamLifecycle(input: TurnStreamLifecycleInput): TurnStreamLifecycle {
  return {
    async run(context) {
      const start = await turnStreamStartFor(input, context);
      return outerLifecycleFor(start, input).run(context);
    },
  };
}
