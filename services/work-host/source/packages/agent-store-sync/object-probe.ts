import type {
  AgentStoreObjectProbeOptions,
  AgentStoreObjectProbeResult as ProbeResult,
} from "./object-probe-contracts.ts"
import { fetchObjectProbeResponse } from "./object-probe-fetch.ts"
import { requestSignedObjectRead } from "./object-probe-presign.ts"
import { classifyObjectProbeResponse } from "./object-probe-result.ts"

export type { AgentStoreObjectProbeResult } from "./object-probe-contracts.ts"

export async function probeAgentStoreObject(
  options: AgentStoreObjectProbeOptions,
): Promise<ProbeResult> {
  const signedRead = await requestSignedObjectRead(options)
  const response = await fetchObjectProbeResponse(options, signedRead.url)
  return classifyObjectProbeResponse(response, options.relPath)
}
