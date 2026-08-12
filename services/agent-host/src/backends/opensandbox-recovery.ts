import { ConnectionConfig, SandboxManager } from '@alibaba-group/opensandbox'

export interface OpenSandboxConnectionOptions {
  domain: string
  protocol: 'http' | 'https'
  apiKey: string
  useServerProxy?: boolean
}

/**
 * Remove workloads left behind by an Agent Host restart before a durable Chat
 * session is materialised again. Chat-session leases are the authority at the
 * Web boundary; reaching this function means the old in-process runtime is no
 * longer owned by this Agent Host and a new runtime is being created.
 *
 * Filtering by all ownership metadata is important. A Project VM contains
 * workloads for many Chat sessions and a project-wide cleanup would destroy
 * unrelated active work.
 */
export async function cleanupOpenSandboxSessionWorkloads(
  connectionOptions: OpenSandboxConnectionOptions,
  metadata: Record<string, string>,
): Promise<void> {
  const connection = new ConnectionConfig({
    domain: connectionOptions.domain,
    protocol: connectionOptions.protocol,
    apiKey: connectionOptions.apiKey,
    requestTimeoutSeconds: 120,
    ...(connectionOptions.useServerProxy === undefined ? {} : { useServerProxy: connectionOptions.useServerProxy }),
  })
  const manager = SandboxManager.create({ connectionConfig: connection })
  try {
    // Deleting page one repeatedly avoids skipping items as the filtered result
    // shrinks. The bound protects the Agent Host from a broken control plane
    // returning the same item forever.
    for (let pass = 0; pass < 1_000; pass += 1) {
      const listed = await manager.listSandboxInfos({ metadata, page: 1, pageSize: 100 })
      if (listed.items.length === 0) return
      for (const sandbox of listed.items) await manager.killSandbox(sandbox.id)
    }
    throw new Error('OpenSandbox stale-session cleanup exceeded its safety bound')
  } finally {
    await manager.close()
  }
}
