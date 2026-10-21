/**
 * The configuration a gateway starts with.
 *
 * The file holds the port and the token a client must present, and a token that is not there is minted once and written
 * back; a configuration that cannot be read or does not hold what it must is refused rather than guessed at.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isLoopbackHost } from "./gateway-protocol.ts";

export { isLoopbackHost };

export class SlateGatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlateGatewayConfigError";
  }
}

export interface GatewayServerConfig {
  readonly host: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer };
}

/** The values an environment may use to say yes. */
const AFFIRMATIVES = new Set(["1", "true", "yes"]);

function isTruthyEnv(value: string | undefined): boolean {
  return value != null && AFFIRMATIVES.has(value.trim().toLowerCase());
}

/** A port is a positive whole number, and anything else is not a port at all. */
function readPort(raw: string | undefined): number | undefined {
  if (raw == null || raw.length === 0) return undefined;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** A path from the environment, with the padding an environment can carry taken off. */
function pathFromEnv(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed == null || trimmed.length === 0 ? undefined : trimmed;
}

/** The certificate and key a gateway serves TLS with, when it was told to serve any. */
function resolveTls(env: NodeJS.ProcessEnv): GatewayServerConfig["tls"] {
  const certPath = pathFromEnv(env.SLATE_GATEWAY_TLS_CERT);
  const keyPath = pathFromEnv(env.SLATE_GATEWAY_TLS_KEY);
  if (certPath === undefined && keyPath === undefined) return undefined;
  if (certPath === undefined || keyPath === undefined) {
    throw new SlateGatewayConfigError("Gateway TLS needs both SLATE_GATEWAY_TLS_CERT and SLATE_GATEWAY_TLS_KEY.");
  }
  try {
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch (error) {
    throw new SlateGatewayConfigError(`Failed to read gateway TLS cert/key (${certPath}, ${keyPath}): ${String(error)}`);
  }
}

/**
 * The configuration for this environment.
 *
 * A gateway is authenticated when it is reachable from somewhere other than this machine, when the environment asks for
 * it, or when a token was pinned — and a pinned token is used rather than replaced, so a restart does not invalidate
 * what clients already hold.
 */
export function resolveGatewayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  generateToken: () => string = () => randomBytes(32).toString("base64url"),
): GatewayServerConfig {
  const host = env.SLATE_GATEWAY_BIND_HOST?.trim() || "127.0.0.1";
  const port = readPort(env.SLATE_HOST_PORT);
  const tls = resolveTls(env);
  const pinnedToken = pathFromEnv(env.SLATE_GATEWAY_TOKEN);
  const needsToken = !isLoopbackHost(host) || isTruthyEnv(env.SLATE_GATEWAY_REQUIRE_AUTH) || pinnedToken !== undefined;
  const authToken = needsToken ? (pinnedToken ?? generateToken()) : undefined;
  return { host, ...(port === undefined ? {} : { port }), ...(authToken === undefined ? {} : { authToken }), ...(tls === undefined ? {} : { tls }) };
}

export function gatewayScheme(config: GatewayServerConfig): "http" | "https" {
  return config.tls == null ? "http" : "https";
}
