/** Per-request async inboxes for the daemon frames that return from a provider. */
import type { LocalExecBridgeFrame } from "./local-exec-bridge-contracts.ts";

type QueueReader<T> = (result: IteratorResult<T>) => void;

class FrameInbox implements AsyncIterator<LocalExecBridgeFrame>, AsyncIterable<LocalExecBridgeFrame> {
  private readonly buffered: LocalExecBridgeFrame[] = [];
  private readonly readers: QueueReader<LocalExecBridgeFrame>[] = [];
  private closed = false;

  [Symbol.asyncIterator](): AsyncIterator<LocalExecBridgeFrame> {
    return this;
  }

  next(): Promise<IteratorResult<LocalExecBridgeFrame>> {
    const frame = this.buffered.shift();
    if (frame !== undefined) return Promise.resolve({ done: false, value: frame });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.readers.push(resolve));
  }

  push(frame: LocalExecBridgeFrame): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader !== undefined) {
      reader({ done: false, value: frame });
      return;
    }
    this.buffered.push(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
  }
}

export class LocalExecResponseChannels {
  private readonly channels = new Map<string, FrameInbox>();

  open(requestId: string): AsyncIterable<LocalExecBridgeFrame> {
    const inbox = new FrameInbox();
    this.channels.set(requestId, inbox);
    return inbox;
  }

  route(frame: LocalExecBridgeFrame): void {
    if (typeof frame.requestId === "string") this.channels.get(frame.requestId)?.push(frame);
  }

  close(requestId: string): void {
    const inbox = this.channels.get(requestId);
    if (inbox === undefined) return;
    this.channels.delete(requestId);
    inbox.close();
  }
}
