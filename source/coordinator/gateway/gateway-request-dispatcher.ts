/**
 * Sending a request to the host's gateway and reading the answer.
 *
 * The request carries the command and its arguments, is bounded by its own deadline, and what comes back is either the
 * result or the error the gateway answered with.
 */
import { COORDINATOR_UNKNOWN_METHOD, type CoordinatorReplyOutcome } from "../../shared/rpc/coordinator-port.ts";
import { isCoordinatorMethod, validateCoordinatorReply } from "../../shared/rpc/coordinator.ts";
import { SlateGatewayCommandError } from "./gateway-errors.ts";
import { SlateGatewayUnreachableError } from "./gateway-reachability.ts";

export const GATEWAY_COMMAND_FAILED = "gateway-command-failed";
export const GATEWAY_UNREACHABLE = "gateway-unreachable";
export const GATEWAY_TRANSPORT_FAILED = "gateway-transport-failed";

export function failureFor(reason: unknown): { code: string; message: string; transportKind?: string } {
  const message = reason instanceof Error ? reason.message : String(reason);

  if (reason instanceof SlateGatewayCommandError) {
    return { code: GATEWAY_COMMAND_FAILED, message };
  }
  if (reason instanceof SlateGatewayUnreachableError) {
    return { code: GATEWAY_UNREACHABLE, message, transportKind: reason.kind };
  }
  return { code: GATEWAY_TRANSPORT_FAILED, message };
}

export interface GatewayRequestPort {
  dispatchCommand(method: string, args: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
}

function unknownMethodReply(method: string): CoordinatorReplyOutcome {
  return {
    status: "failed",
    failure: { code: COORDINATOR_UNKNOWN_METHOD, message: `no coordinator method named ${method}` },
  };
}

function failedReply(reason: unknown): CoordinatorReplyOutcome {
  return { status: "failed", failure: failureFor(reason) };
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export function createGatewayRequestDispatch(
  gateway: GatewayRequestPort,
  isSupported: (method: string) => boolean = isCoordinatorMethod,
) {
  return async function dispatch(method: string, input: unknown, signal?: AbortSignal): Promise<CoordinatorReplyOutcome> {
    if (!isSupported(method)) return unknownMethodReply(method);

    try {
      const rawReply = await gateway.dispatchCommand(method, input, signalOptions(signal));
      return { status: "ok", value: validateCoordinatorReply(method, rawReply) };
    } catch (reason) {
      return failedReply(reason);
    }
  };
}
