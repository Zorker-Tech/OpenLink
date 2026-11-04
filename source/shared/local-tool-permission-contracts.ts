import type { SlateLocalToolAction } from "./local-tool-permission.ts";

export interface SlateLocalToolRequest {
  readonly action: SlateLocalToolAction;
  readonly target: string;
  readonly resourcePath?: string;
  readonly attachToResourcePath?: string;
  readonly outlivesScope?: boolean;
  readonly signal?: AbortSignal;
  readonly description?: string;
}

export interface SlateLocalToolApproval {
  readonly action: SlateLocalToolAction;
  readonly target: string;
  readonly resourcePath?: string;
}

export interface SlateLocalToolScope {
  readonly agentId: string;
  readonly toolCallId?: string;
  readonly action?: SlateLocalToolAction;
  readonly directionEpoch?: number;
}

export interface SlateLocalToolGate {
  authorize(
    scope: SlateLocalToolScope | undefined,
    request: SlateLocalToolRequest,
  ): Promise<{ readonly allowed: boolean; readonly reason: string; readonly approvalId?: string }>;
}

export type LocalExecMessage = { readonly case?: string; readonly value: Record<string, unknown> };
