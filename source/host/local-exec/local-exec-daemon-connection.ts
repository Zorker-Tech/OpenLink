import { SLATE_GATEWAY } from "../../shared/gateway-wire.ts";
import { getSlateBackendClientHeaders } from "../../adapters/interop/backend/slate-client-metadata-adapter.ts";
import { LOCAL_EXEC_CONNECTION_PATH, type LocalExecBackendConnectionRequest } from "./local-exec-daemon-run-contracts.ts";
import type { LocalExecConnection } from "./local-exec-daemon-protocol.ts";

/** Ask the account backend to exchange a short-lived local-exec handoff credential for a gateway connection. */
export async function resolveLocalExecConnectionFromBackend(args: LocalExecBackendConnectionRequest): Promise<LocalExecConnection | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL(LOCAL_EXEC_CONNECTION_PATH, args.backendUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...getSlateBackendClientHeaders() },
      body: JSON.stringify({ credential: args.credential }),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const connection = payload as Record<string, unknown>;
  const baseUrl = typeof connection.baseUrl === "string" ? connection.baseUrl : "";
  if (baseUrl.length === 0) return null;
  const token = typeof connection.token === "string" && connection.token.length > 0 ? connection.token : undefined;
  const networkToken = typeof connection.networkToken === "string" ? connection.networkToken : "";
  return {
    baseUrl,
    ...(token === undefined ? {} : { token }),
    ...(networkToken.length === 0 ? {} : { headers: { [SLATE_GATEWAY.headers.networkToken]: networkToken } }),
  };
}
