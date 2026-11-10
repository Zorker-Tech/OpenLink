/**
 * Moving a command's output to the platform without drowning it.
 *
 * A command can print faster than the platform can deliver, and a thousand one-line writes cost more than the same bytes
 * written once. Both are answered by the same idea: a chunk is put in a buffer, the buffer is delivered on a short timer,
 * and chunks of the same stream that are delivered together go out as one — which changes how many writes there are, never
 * what the reader sees.
 *
 * Two bounds keep that honest:
 *
 * - **the buffer is bounded** — a command that never pauses would otherwise grow it until the process holds more than it
 *   can afford, so reaching the bound delivers at once rather than waiting for the timer;
 * - **delivery is one at a time** — a second delivery waits for the one in flight, and then delivers whatever arrived in the
 *   meantime, so two deliveries can never overtake each other.
 *
 * And one rule keeps the command's fate separate from its output's: **a failed delivery is a lost observation, not a failed
 * command**. Output is how the command is watched, not part of what it did.
 */

type StreamName = "stdout" | "stderr";
type OutputChunk = { readonly type: StreamName; readonly data: Buffer };
type OutputSink = { write(chunk: OutputChunk): Promise<void> };
type OutputStream = AsyncIterable<Buffer> & { on(event: "data", listener: (data: Buffer) => void): unknown };
type LimiterOptions = { readonly flushIntervalMs?: number | undefined; readonly maxBufferedBytes?: number | undefined };
type AttachOptions = {
  readonly stdout?: OutputStream | null | undefined;
  readonly stderr?: OutputStream | null | undefined;
  readonly writable: OutputSink;
  readonly bufferOutputEvents?: boolean | undefined;
  readonly outputLimiterOptions?: LimiterOptions | undefined;
};

const DEFAULTS = { flushIntervalMs: 50, maxBufferedBytes: 256 * 1024 } as const;

/**
 * Chunks of the same stream that are delivered together become one chunk, in the order they arrived: a run of stdout is a
 * single write, and a switch to stderr starts the next one.
 */
function joinAdjacent(chunks: readonly OutputChunk[]): OutputChunk[] {
  const joined: OutputChunk[] = [];
  let current: { type: StreamName; parts: Buffer[] } | undefined;
  for (const chunk of chunks) {
    if (current !== undefined && chunk.type === current.type) {
      current.parts.push(chunk.data);
      continue;
    }
    if (current !== undefined) joined.push({ type: current.type, data: Buffer.concat(current.parts) });
    current = { type: chunk.type, parts: [chunk.data] };
  }
  if (current !== undefined) joined.push({ type: current.type, data: Buffer.concat(current.parts) });
  return joined;
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** A record of what a command printed, delivered in as few writes as the buffer allows. */
class BufferedOutput {
  private buffered: OutputChunk[] = [];
  private bufferedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedBytes: number;

  constructor(private readonly sink: OutputSink, options?: LimiterOptions) {
    this.flushIntervalMs = options?.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULTS.maxBufferedBytes;
  }

  /** A chunk is buffered, and delivered early when the buffer is at its bound: the buffer is what is at risk. */
  async accept(type: StreamName, data: Buffer): Promise<void> {
    if (data.length === 0) return;
    this.buffered.push({ type, data });
    this.bufferedBytes += data.length;
    if (this.bufferedBytes >= this.maxBufferedBytes) {
      await this.drain();
      return;
    }
    this.armTimer();
  }

  async drain(): Promise<void> {
    this.disarmTimer();
    // A delivery already running is waited for, and whatever arrived meanwhile goes out right after it.
    if (this.inFlight !== undefined) {
      await this.inFlight;
      if (this.bufferedBytes > 0) await this.drain();
      return;
    }
    if (this.bufferedBytes === 0) return;
    const delivery = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.inFlight = this.deliver(delivery);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** A stream that ends is drained: what it printed last is not worth dropping for the want of a timer tick. */
  async close(): Promise<void> {
    await this.drain();
  }

  private armTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.flushIntervalMs);
  }

  private disarmTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Each joined chunk is written on its own, and a write that fails is swallowed: the command already ran. */
  private async deliver(chunks: readonly OutputChunk[]): Promise<void> {
    for (const chunk of joinAdjacent(chunks)) {
      try {
        await this.sink.write(chunk);
      } catch {
        // Deliberately ignored.
      }
    }
  }
}

/**
 * Attaches a command's output streams to the sink the platform reads them through.
 *
 * Without buffering every chunk is written as it arrives, which is what watching a command closely wants and what a chatty
 * one must not do. With buffering, both streams feed one limiter, so what the reader sees is in the order it was produced.
 */
export function attachShellOutputStreams(options: AttachOptions): { waitForOutput(): Promise<void>; flush(): Promise<void> } {
  if (!options.bufferOutputEvents) {
    voidPump(options.stdout, "stdout", options.writable);
    voidPump(options.stderr, "stderr", options.writable);
    return { async waitForOutput() {}, async flush() {} };
  }
  const limiter = new BufferedOutput(options.writable, options.outputLimiterOptions);
  let pumpError: unknown;
  const pumped = Promise.all([pump(options.stdout, "stdout", limiter), pump(options.stderr, "stderr", limiter)])
    .then(() => undefined)
    .catch((error: unknown) => {
      // A stream that failed is remembered and reported by the caller that waits for it, not thrown at the command.
      pumpError = error;
    });
  return {
    async waitForOutput() {
      await pumped;
      if (pumpError !== undefined) throw asError(pumpError);
    },
    async flush() {
      await limiter.drain();
    },
  };
}

/** No buffering: each chunk is written as it arrives, and a failed write is not the command's problem. */
function voidPump(stream: OutputStream | null | undefined, type: StreamName, sink: OutputSink): void {
  stream?.on("data", (data) => {
    void sink.write({ type, data }).catch(() => {});
  });
}

async function pump(stream: OutputStream | null | undefined, type: StreamName, limiter: BufferedOutput): Promise<void> {
  if (!stream) return;
  for await (const data of stream) await limiter.accept(type, data);
}
