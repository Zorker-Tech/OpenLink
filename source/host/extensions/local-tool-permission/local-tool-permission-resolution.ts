/**
 * What a local tool permission resolved to.
 *
 * A resolution is either granted or refused, and it carries the identifier of the request it answers — so a caller can
 * tell which of its requests was answered and whether the answer was about the same one.
 */
import { type SlateLocalToolPermissionController, type SlateLocalToolResolution } from "./local-tool-permission-controller.ts";

export class SlateLocalToolPermissionResolutionError extends Error {}
export function isSlateLocalToolPermissionResolution(value: unknown): value is SlateLocalToolResolution { return value === "allow-once" || value === "deny" || value === "always" || value === "never"; }

export interface LocalToolPermissionResolutionArgs { readonly agentId: string; readonly entryId: string; readonly requestId: string; readonly resolution: unknown; }
export interface LocalToolPermissionTranscript { readonly widgetResponses: { settleStaleLocalToolPermissionCard(args: { readonly agentId: string; readonly entryId: string; readonly requestId: string }): Promise<boolean | "retired">; expireAllPendingLocalToolPermissionCards?(args: { readonly ifPendingBeforeMs: number }): Promise<void>; }; }

export async function resolveLocalToolPermissionAsk(deps: { readonly asks: SlateLocalToolPermissionController; readonly transcript: LocalToolPermissionTranscript; readonly onStrandedRetirement?: () => void }, args: LocalToolPermissionResolutionArgs): Promise<void> {
  const staleError = new Error("That local-tool permission request is no longer waiting for an answer.");
  if (!isSlateLocalToolPermissionResolution(args.resolution)) throw new SlateLocalToolPermissionResolutionError("Unknown local-tool permission resolution.");
  const pending = deps.asks.getPendingRequestById(args.requestId);
  if (pending === undefined) { if (deps.asks.wasSettled(args.requestId)) return; const settle = await deps.transcript.widgetResponses.settleStaleLocalToolPermissionCard({ agentId: args.agentId, entryId: args.entryId, requestId: args.requestId }); if (settle !== false) { if (settle === "retired") deps.onStrandedRetirement?.(); return; } throw staleError; }
  if (pending.agentId !== args.agentId) throw staleError;
  if (deps.asks.resolveRequest(args.requestId, args.resolution) === undefined) throw staleError;
}
