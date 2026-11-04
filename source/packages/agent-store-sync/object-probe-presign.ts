import { assertAddressSafe } from "./presigned-url.ts"
import { normalizeRelPath } from "./safe-paths.ts"
import type { AgentStoreObjectProbeOptions, SignedObjectRead } from "./object-probe-contracts.ts"

const runDirectly = async <Result>(operation: () => Promise<Result>): Promise<Result> => operation()

export async function requestSignedObjectRead(
  options: AgentStoreObjectProbeOptions,
): Promise<SignedObjectRead> {
  const withPresign = options.runPresign ?? runDirectly
  const [signedRead] = await withPresign(() => options.client.presignReads({
    agentId: options.agentId,
    relPaths: [options.relPath],
    signal: options.signal,
  }))
  if (signedRead === undefined) {
    throw new Error(`agent-store baseline probe returned no read for ${options.relPath}`)
  }

  let requestedPath: string
  let signedPath: string
  try {
    requestedPath = normalizeRelPath(options.relPath)
    signedPath = normalizeRelPath(signedRead.relPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`agent-store baseline probe relPath mismatch for ${options.relPath}: ${message}`)
  }
  if (signedPath !== requestedPath) {
    throw new Error(`agent-store baseline probe relPath mismatch for ${options.relPath} (got ${signedRead.relPath})`)
  }

  assertAddressSafe({
    rawUrl: signedRead.url,
    relPath: options.relPath,
    validatePresignedUrl: options.validatePresignedUrl,
  })
  return signedRead
}
