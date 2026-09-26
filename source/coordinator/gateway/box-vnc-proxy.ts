/**
 * Proxying a box's remote desktop through the gateway.
 *
 * The desktop is reached through the gateway rather than directly, so the proxy is what a viewer connects to: the
 * request is checked, the box is found, and the two sides are wired together — with the viewer's own request and the
 * box's answer passed through as they are.
 */
import {
  BOX_FORK_NOVNC_PORT,
  BOX_PRIMARY_NOVNC_PORT,
  buildBoxNoVncUrl,
  isBoxSpecialTreatmentNoVncUrl
} from "../../packages/constants/box-endpoints.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface VncProxyDescriptor {
  primaryUrl: string;
  forkBaseUrl: string;
  networkToken: string;
}

export interface ForeverBoxWindowStatus {
  vncUrl: string;
  [key: string]: unknown;
}

export interface ForeverBoxStatus {
  vncUrl?: string | null;
  windows?: ForeverBoxWindowStatus[] | null;
  [key: string]: unknown;
}

export function proxifyBoxVncUrl(vncUrl: string, vncProxy: VncProxyDescriptor): string {
  let parsed: URL;
  try {
    parsed = new URL(vncUrl);
  } catch {
    return vncUrl;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !parsed.pathname.endsWith("/vnc.html")) return vncUrl;
  const port = Number.parseInt(parsed.port, 10);
  if (port === BOX_PRIMARY_NOVNC_PORT) return vncProxy.primaryUrl;
  if (port === BOX_FORK_NOVNC_PORT) {
    return buildBoxNoVncUrl(vncProxy.forkBaseUrl, vncProxy.networkToken, forkDisplayToken(parsed), isBoxSpecialTreatmentNoVncUrl(vncProxy.primaryUrl));
  }
  return vncUrl;
}

function forkDisplayToken(parsed: URL): string | undefined {
  const path = parsed.searchParams.get("path");
  const queryIndex = path?.indexOf("?") ?? -1;
  if (path == null || queryIndex < 0) return undefined;
  const token = new URLSearchParams(path.slice(queryIndex + 1)).get("token");
  return token != null && token.length > 0 ? token : undefined;
}

export function proxifyForeverBoxStatus<T extends ForeverBoxStatus>(status: T, vncProxy: VncProxyDescriptor | null): T {
  if (vncProxy == null) return status;
  const proxified = { ...status, vncUrl: status.vncUrl != null ? proxifyBoxVncUrl(status.vncUrl, vncProxy) : status.vncUrl };
  if (status.windows == null) return proxified as T;
  return { ...proxified, windows: status.windows.map((window) => ({ ...window, vncUrl: proxifyBoxVncUrl(window.vncUrl, vncProxy) })) } as T;
}
