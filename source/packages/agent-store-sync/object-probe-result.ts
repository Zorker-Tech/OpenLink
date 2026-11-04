import { normalizeS3Etag } from "./etag.ts"
import type { AgentStoreObjectProbeResult, StoreProbeResponse } from "./object-probe-contracts.ts"

export async function classifyObjectProbeResponse(
  response: StoreProbeResponse,
  relPath: string,
): Promise<AgentStoreObjectProbeResult> {
  try {
    if (response.status === 404) return { kind: "absent" }
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`agent-store baseline probe failed for ${relPath}: ${response.status}`)
    }

    const etag = normalizeS3Etag(response.headers.get("etag") ?? undefined)
    if (etag.length === 0) {
      throw new Error(`agent-store baseline probe for ${relPath} returned no usable etag`)
    }
    return { kind: "exists", etag }
  } finally {
    await response.body?.cancel?.()
  }
}
