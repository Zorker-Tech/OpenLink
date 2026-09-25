/**
 * Keeping the output of a shell command that was interrupted.
 *
 * A command that is interrupted still produced output, and the output is often the only evidence of what
 * it was doing when it stopped — so it is kept in memory, keyed by the call, until the caller asks for it
 * or the call ends. The buffer keeps the *end* of the output rather than the beginning, because what a
 * command was doing when it stopped is at the end, and it is capped so a chatty command cannot grow
 * without limit. The number of buffers is capped too, dropping the oldest first: a session that
 * interrupts many commands at once should not be able to hold them all forever.
 */

const MAX_SHELL_SNAPSHOT_CHARS = 20_000
const MAX_SHELL_SNAPSHOT_COUNT = 100

const shellOutputSnapshots = new Map<string, string>()

function ensureSnapshotCapacity(toolCallId: string): void {
  if (shellOutputSnapshots.has(toolCallId) || shellOutputSnapshots.size < MAX_SHELL_SNAPSHOT_COUNT) return
  const oldestKey = shellOutputSnapshots.keys().next().value
  if (oldestKey !== undefined) shellOutputSnapshots.delete(oldestKey)
}

export function startInterruptedShellOutputSnapshot(toolCallId: string): void {
  ensureSnapshotCapacity(toolCallId)
  shellOutputSnapshots.set(toolCallId, "")
}

export function appendInterruptedShellOutputSnapshot(toolCallId: string, output: string): void {
  if (output.length === 0) return
  const existing = shellOutputSnapshots.get(toolCallId)
  if (existing === undefined) {
    ensureSnapshotCapacity(toolCallId)
    shellOutputSnapshots.set(toolCallId, output.slice(-MAX_SHELL_SNAPSHOT_CHARS))
    return
  }
  shellOutputSnapshots.set(toolCallId, `${existing}${output}`.slice(-MAX_SHELL_SNAPSHOT_CHARS))
}

export function getInterruptedShellOutputSnapshot(toolCallId: string): string | undefined {
  return shellOutputSnapshots.get(toolCallId)
}

export function clearInterruptedShellOutputSnapshot(toolCallId: string): void {
  shellOutputSnapshots.delete(toolCallId)
}
