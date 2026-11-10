import { createKey, type ContextKey } from "../packages/context/context.ts";
import type { SlateLocalToolGate, SlateLocalToolRequest, SlateLocalToolScope } from "./local-tool-permission-contracts.ts";

export const slateLocalToolScopeKey: ContextKey<SlateLocalToolScope | undefined> = createKey(
  Symbol("slate.local-tool.scope"),
  undefined,
);
export const slateTurnDirectionEpochKey: ContextKey<number | undefined> = createKey(
  Symbol("slate.local-tool.direction-epoch"),
  undefined,
);

export class SlateLocalToolPermissionDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SlateLocalToolPermissionDeniedError";
  }
}

export async function authorizeLocalToolAction(
  gate: SlateLocalToolGate,
  scope: SlateLocalToolScope | undefined,
  request: SlateLocalToolRequest,
): Promise<string | undefined> {
  const { allowed, reason, approvalId } = await gate.authorize(scope, request);
  if (allowed) return approvalId;
  throw new SlateLocalToolPermissionDeniedError(reason);
}
