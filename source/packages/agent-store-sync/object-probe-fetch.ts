import type { AgentStoreObjectProbeOptions, StoreProbeResponse } from "./object-probe-contracts.ts"

const runDirectly = async <Result>(operation: () => Promise<Result>): Promise<Result> => operation()

export async function fetchObjectProbeResponse(
  options: AgentStoreObjectProbeOptions,
  signedUrl: string,
): Promise<StoreProbeResponse> {
  const withStore = options.runS3 ?? runDirectly
  const fetchSample = (includeRange: boolean): Promise<StoreProbeResponse> => options.fetchImpl(
    signedUrl,
    Object.assign(
      { redirect: "error" as const },
      options.signal === undefined ? {} : { signal: options.signal },
      includeRange ? { headers: { Range: "bytes=0-0" as const } } : {},
    ),
  )

  let response = await withStore(() => fetchSample(true))
  if (response.status === 416) {
    await response.body?.cancel?.()
    response = await withStore(() => fetchSample(false))
  }
  return response
}
