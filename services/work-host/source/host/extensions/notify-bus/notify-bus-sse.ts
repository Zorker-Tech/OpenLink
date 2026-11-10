import type { IdleWatchdogPolicy } from "../scheduling.ts";

/** Consume complete SSE blocks while retaining a partial block across stream chunks. */
export async function consumeNotifyEventStream(
  body: ReadableStream<Uint8Array>,
  watchdog: ReturnType<IdleWatchdogPolicy["arm"]>,
  onFrame: (frame: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;

    watchdog.kick();
    buffered += decoder.decode(value, { stream: true });
    const parsed = takeCompleteFrames(buffered);
    buffered = parsed.remainder;
    for (const frame of parsed.frames) onFrame(frame);
  }
}

function takeCompleteFrames(buffer: string): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  let remaining = buffer;
  let boundary = remaining.indexOf("\n\n");
  while (boundary !== -1) {
    frames.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary + 2);
    boundary = remaining.indexOf("\n\n");
  }
  return { frames, remainder: remaining };
}
