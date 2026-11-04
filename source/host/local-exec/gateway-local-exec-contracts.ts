import type { Context } from "../../packages/context/context.ts";
import type { LocalExecFailureClassification } from "./local-exec-failure-classifier.ts";
import type { GatewayLocalExecManager } from "./gateway-local-exec-manager.ts";
import type { LocalExecMessage, SlateLocalToolGate, SlateLocalToolScope } from "../../shared/local-tool-permission-machinery.ts";
import type { LocalExecWireJsonValue } from "../../shared/local-exec-protocol.ts";

export type BoxContext = Context;

export interface GatewayExecServerMessage {
  readonly message?: { readonly case?: string; readonly value?: Record<string, unknown> };
  toJson(): unknown;
}

export type GatewayExecControl =
  | { readonly case: "throw"; readonly error: string; readonly stackTrace?: string }
  | { readonly case: "streamClose" }
  | { readonly case: undefined };

export interface GatewayLocalExecCodec<Client = unknown, Accessor = unknown> {
  encodeRequest?(message: GatewayExecServerMessage): LocalExecWireJsonValue;
  decodeClient(json: unknown): Client;
  decodeControl(json: unknown): GatewayExecControl;
  createRemoteAccessor(manager: GatewayLocalExecManager<Client>): Accessor;
}

export interface LocalExecFailureReport extends LocalExecFailureClassification {
  readonly site: "exec";
  readonly conversationId?: string;
}

export interface GatewayLocalToolGate extends SlateLocalToolGate {
  blockedReason(): string | undefined;
  requiresApproval(): boolean;
}

export type { LocalExecMessage, SlateLocalToolScope };
