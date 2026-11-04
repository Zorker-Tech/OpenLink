import {
  BOX_FORK_NOVNC_PORT,
  BOX_PRIMARY_NOVNC_PORT,
  buildBoxNoVncUrl,
  isBoxSpecialTreatmentNoVncUrl,
} from "../../packages/constants/box-endpoints.ts"
import type { VncProxyDescriptor } from "./box-vnc-proxy-contracts.ts"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"])

interface LoopbackViewer {
  readonly port: number
  readonly url: URL
}

function loopbackViewer(value: string): LoopbackViewer | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || !url.pathname.endsWith("/vnc.html")) return undefined
  const port = Number.parseInt(url.port, 10)
  return port === BOX_PRIMARY_NOVNC_PORT || port === BOX_FORK_NOVNC_PORT
    ? { port, url }
    : undefined
}

function forkDisplayToken(url: URL): string | undefined {
  const nestedPath = url.searchParams.get("path")
  const nestedQueryStart = nestedPath?.indexOf("?") ?? -1
  if (nestedPath == null || nestedQueryStart < 0) return undefined

  const token = new URLSearchParams(nestedPath.slice(nestedQueryStart + 1)).get("token")
  return token !== null && token.length > 0 ? token : undefined
}

export function proxifyBoxVncUrl(vncUrl: string, proxy: VncProxyDescriptor): string {
  const viewer = loopbackViewer(vncUrl)
  if (viewer === undefined) return vncUrl
  if (viewer.port === BOX_PRIMARY_NOVNC_PORT) return proxy.primaryUrl

  return buildBoxNoVncUrl(
    proxy.forkBaseUrl,
    proxy.networkToken,
    forkDisplayToken(viewer.url),
    isBoxSpecialTreatmentNoVncUrl(proxy.primaryUrl),
  )
}
