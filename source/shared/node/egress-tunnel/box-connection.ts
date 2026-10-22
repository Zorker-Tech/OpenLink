/**
 * How a tunnel to a box is opened.
 *
 * A box is reached through a tunnel rather than directly, and the tunnel needs to know where to connect, what to
 * present, and — when the box is also being looked at — how its remote desktop is proxied. What comes back is the
 * connection a caller makes requests over.
 */
export const TUNNEL_WS_PORT = 8790;

export interface BoxConnection {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly vncProxy?: unknown;
}

export interface TunnelConfig {
  readonly url: string;
  readonly bearer: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowPrivateTargets: boolean;
}

/** The tunnel speaks over a socket, secure when the box was reached securely. */
function tunnelProtocol(protocol: string): "ws:" | "wss:" {
  return protocol === "https:" || protocol === "wss:" ? "wss:" : "ws:";
}

/**
 * Where the tunnel listens, when the box is proxied through a pod.
 *
 * The pod's own hostname carries its port as a suffix (`box-8080`), and the tunnel takes that slot rather than a port
 * of its own; a hostname without one is not a pod we can proxy through.
 */
function proxiedHostname(hostname: string): string | null {
  const [label, ...rest] = hostname.split(".");
  if (label == null || !/-\d+$/.test(label)) return null;
  return [label.replace(/-\d+$/, `-${TUNNEL_WS_PORT}`), ...rest].join(".");
}

/** The socket URL for this box, or nothing when its address is not one. */
export function tunnelWsUrlFor(baseUrl: string, podProxied: boolean): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (podProxied) {
    const hostname = proxiedHostname(url.hostname);
    if (hostname === null) return null;
    url.hostname = hostname;
  } else {
    url.port = String(TUNNEL_WS_PORT);
  }
  url.protocol = tunnelProtocol(url.protocol);
  url.pathname = "/";
  url.search = "";
  return url.toString();
}

/**
 * The tunnel configuration for a box, or nothing when there is nothing to connect with.
 *
 * A box with no token is a box this build cannot reach, and a box whose address is not a URL is one it cannot reach
 * either: both are answered as nothing rather than as a configuration that would fail on first use.
 */
export function tunnelConfigFor(info: BoxConnection): TunnelConfig | null {
  if (info.token == null || info.token.length === 0) return null;
  const url = tunnelWsUrlFor(info.baseUrl, info.vncProxy != null);
  if (url == null) return null;
  return {
    url,
    bearer: info.token,
    ...(info.headers != null ? { headers: info.headers } : {}),
    allowPrivateTargets: false,
  };
}
