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

export function failureFor(error: unknown): { code: string; message: string; transportKind?: string } {
  if (error instanceof SlateGatewayCommandError) return { code: GATEWAY_COMMAND_FAILED, message: error.message };
  if (error instanceof SlateGatewayUnreachableError) return { code: GATEWAY_UNREACHABLE, message: error.message, transportKind: error.kind };
  return { code: GATEWAY_TRANSPORT_FAILED, message: error instanceof Error ? error.message : String(error) };
}

export interface GatewayCommandClient {
  dispatchCommand(method: string, args: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
}

export function createGatewayRequestDispatch(client: GatewayCommandClient, serves: (method: string) => boolean = isCoordinatorMethod) {
  return async (method: string, args: unknown, signal?: AbortSignal): Promise<CoordinatorReplyOutcome> => {
    if (!serves(method)) return { status: "failed", failure: { code: COORDINATOR_UNKNOWN_METHOD, message: `no coordinator method named ${method}` } };
    try {
      const value = validateCoordinatorReply(method, await client.dispatchCommand(method, args, { ...(signal === undefined ? {} : { signal }) }));
      return { status: "ok", value };
    } catch (error) {
      return { status: "failed", failure: failureFor(error) };
    }
  };
}
