import type { AccessMode } from '@/lib/chat-sessions'

export type AccessModeTransitionFailure = 'persist' | 'lease' | 'verify'

export type AccessModeTransitionResult<T extends { accessMode: AccessMode }> =
  | { ok: true; mode: AccessMode; resources: T | null; unchanged: boolean }
  | { ok: false; mode: AccessMode; failure: AccessModeTransitionFailure; rollbackSucceeded: boolean }

export async function transitionAccessMode<T extends { accessMode: AccessMode }>({
  currentMode,
  nextMode,
  persistMode,
  leaseRuntime,
  readRuntimeResources,
}: {
  currentMode: AccessMode
  nextMode: AccessMode
  persistMode: (mode: AccessMode) => Promise<boolean>
  leaseRuntime: () => Promise<boolean>
  readRuntimeResources: () => Promise<T | null>
}): Promise<AccessModeTransitionResult<T>> {
  if (currentMode === nextMode) return { ok: true, mode: currentMode, resources: null, unchanged: true }

  let persisted = false
  try {
    persisted = await persistMode(nextMode)
  } catch {
    persisted = false
  }
  if (!persisted) return { ok: false, mode: currentMode, failure: 'persist', rollbackSucceeded: true }

  let failure: AccessModeTransitionFailure = 'lease'
  try {
    if (!await leaseRuntime()) throw new Error('runtime lease failed')
    failure = 'verify'
    const resources = await readRuntimeResources()
    if (!resources || resources.accessMode !== nextMode) throw new Error('runtime policy did not match')
    return { ok: true, mode: nextMode, resources, unchanged: false }
  } catch {
    let rollbackSucceeded = false
    try {
      rollbackSucceeded = await persistMode(currentMode)
      if (rollbackSucceeded) rollbackSucceeded = await leaseRuntime()
    } catch {
      rollbackSucceeded = false
    }
    return { ok: false, mode: currentMode, failure, rollbackSucceeded }
  }
}
