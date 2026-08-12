import type { Sandbox } from '@alibaba-group/opensandbox'

function isAlreadyGone(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error)
  return /(?:404|not found|does not exist|no such sandbox|sandbox_not_found)/i.test(value)
}

/**
 * Delete the workload and then release the SDK transport. Cleanup errors are
 * intentionally surfaced to the Agent Host reaper: swallowing them makes a
 * failed DELETE look successful and allows a replacement session to leak the
 * original workload indefinitely.
 */
export async function disposeOpenSandbox(sandbox: Pick<Sandbox, 'kill' | 'close'>): Promise<void> {
  let failure: unknown
  try {
    await sandbox.kill()
  } catch (error) {
    if (!isAlreadyGone(error)) failure = error
  }
  try {
    await sandbox.close()
  } catch (error) {
    if (!failure && !isAlreadyGone(error)) failure = error
  }
  if (failure) throw failure
}
