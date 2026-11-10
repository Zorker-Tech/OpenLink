import type { StateBackstopDeps } from "./state-backstop-contracts.ts"

export async function uploadStateSnapshot(
  deps: StateBackstopDeps,
  agentId: string,
  bytes: Uint8Array,
  storagePath: string,
): Promise<void> {
  const { sourceId } = await deps.sourceMap.getOrCreate(agentId)
  const destination = deps.objectStoreProvider.forStore(sourceId)
  await destination.put(storagePath, bytes)
}

export async function downloadStateSnapshot(
  deps: StateBackstopDeps,
  agentId: string,
  storagePath: string,
): Promise<Uint8Array | null> {
  const { sourceId } = await deps.sourceMap.getOrCreate(agentId)
  return deps.objectStoreProvider.forStore(sourceId).get(storagePath)
}
