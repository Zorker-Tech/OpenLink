/**
 * Keeping the output of a shell command that was interrupted.
 *
 * A command that is interrupted still produced output, and the output is often the only evidence of what it was doing
 * when it stopped, so it is kept by call until the caller asks for it or the call ends. A buffer keeps the end of the
 * output rather than the beginning — what a command was doing when it stopped is at the end — and is capped so that a
 * chatty command cannot grow without limit. The number of buffers is capped too, dropping the oldest first, so that a
 * session interrupting many commands at once cannot hold them all forever.
 */

/** How much of one command's output is kept: the last this many characters. */
const MAX_SNAPSHOT_CHARS = 20_000;

/** How many interrupted commands are kept at once. */
const MAX_SNAPSHOT_COUNT = 100;

/** The output of each interrupted call, in the order the calls started. */
const snapshotByCall = new Map<string, string>();

/** The call that started first, which is the one dropped when the map is full. */
function oldestCall(): string | undefined {
  return snapshotByCall.keys().next().value;
}

/** Make room for one call: a call that is already kept stays, and nothing is dropped until the cap is reached. */
function makeRoomFor(toolCallId: string): void {
  if (snapshotByCall.has(toolCallId) || snapshotByCall.size < MAX_SNAPSHOT_COUNT) return;
  const oldest = oldestCall();
  if (oldest !== undefined) snapshotByCall.delete(oldest);
}

export function startInterruptedShellOutputSnapshot(toolCallId: string): void {
  makeRoomFor(toolCallId);
  snapshotByCall.set(toolCallId, "");
}

export function appendInterruptedShellOutputSnapshot(toolCallId: string, output: string): void {
  if (output.length === 0) return;
  makeRoomFor(toolCallId);
  const kept = snapshotByCall.get(toolCallId) ?? "";
  snapshotByCall.set(toolCallId, `${kept}${output}`.slice(-MAX_SNAPSHOT_CHARS));
}

export function getInterruptedShellOutputSnapshot(toolCallId: string): string | undefined {
  return snapshotByCall.get(toolCallId);
}

export function clearInterruptedShellOutputSnapshot(toolCallId: string): void {
  snapshotByCall.delete(toolCallId);
}
