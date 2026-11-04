/**
 * What a local tool permission resolved to.
 *
 * A resolution is either granted or refused, and it carries the identifier of the request it answers — so a caller can
 * tell which of its requests was answered and whether the answer was about the same one.
 */
import type {
  SlateLocalToolPermissionController,
  SlateLocalToolResolution,
} from "./local-tool-permission-controller.ts";

export class SlateLocalToolPermissionResolutionError extends Error {}

const ACCEPTED_RESOLUTIONS = new Set<string>(["allow-once", "deny", "always", "never"]);
const STALE_REQUEST_MESSAGE = "That local-tool permission request is no longer waiting for an answer.";

export interface LocalToolPermissionResolutionArgs {
  readonly agentId: string;
  readonly entryId: string;
  readonly requestId: string;
  readonly resolution: unknown;
}

export interface LocalToolPermissionTranscript {
  readonly widgetResponses: {
    settleStaleLocalToolPermissionCard(args: {
      readonly agentId: string;
      readonly entryId: string;
      readonly requestId: string;
    }): Promise<boolean | "retired">;
    expireAllPendingLocalToolPermissionCards?(args: { readonly ifPendingBeforeMs: number }): Promise<void>;
  };
}

export interface LocalToolPermissionResolutionDependencies {
  readonly asks: SlateLocalToolPermissionController;
  readonly transcript: LocalToolPermissionTranscript;
  readonly onStrandedRetirement?: (() => void) | undefined;
}

export function isSlateLocalToolPermissionResolution(
  value: unknown,
): value is SlateLocalToolResolution {
  return typeof value === "string" && ACCEPTED_RESOLUTIONS.has(value);
}

export async function resolveLocalToolPermissionAsk(
  dependencies: LocalToolPermissionResolutionDependencies,
  args: LocalToolPermissionResolutionArgs,
): Promise<void> {
  if (!isSlateLocalToolPermissionResolution(args.resolution)) {
    throw new SlateLocalToolPermissionResolutionError("Unknown local-tool permission resolution.");
  }

  const pending = dependencies.asks.getPendingRequestById(args.requestId);
  if (pending !== undefined) {
    if (pending.agentId !== args.agentId) throw new Error(STALE_REQUEST_MESSAGE);
    if (dependencies.asks.resolveRequest(args.requestId, args.resolution) === undefined) {
      throw new Error(STALE_REQUEST_MESSAGE);
    }
    return;
  }

  if (dependencies.asks.wasSettled(args.requestId)) return;

  const result = await dependencies.transcript.widgetResponses.settleStaleLocalToolPermissionCard({
    agentId: args.agentId,
    entryId: args.entryId,
    requestId: args.requestId,
  });
  if (result === false) throw new Error(STALE_REQUEST_MESSAGE);
  if (result === "retired") dependencies.onStrandedRetirement?.();
}
