/**
 * Reading the events a server sends over one connection.
 *
 * What arrives is a stream of blocks, each with its own fields, and a block may be split across reads or several may
 * arrive at once: the decoder holds what is incomplete until the rest arrives, and hands over each event as soon as it
 * is whole — with the fields it carries, the event's own name, and the id a client resumes from.
 */

/** A line feed, which is what a block is separated by. */
const LF = 10;

/** The separator between two blocks. */
const BLOCK_SEPARATOR = "\n\n";

export class SseBlockDecoder {
  private readonly decoder = new TextDecoder();

  /** What has arrived of a block that is not finished yet, in the pieces it arrived in. */
  private readonly pending: string[] = [];

  /** Whether the last piece ended on a line feed, which is how a block can be split between one read and the next. */
  private endedOnLineFeed = false;

  constructor(private readonly onBlock: (block: string) => void) {}

  push(bytes: Uint8Array): void {
    const chunk = this.decoder.decode(bytes, { stream: true });
    if (chunk.length === 0) return;

    let start = 0;
    if (this.endedOnLineFeed && chunk.charCodeAt(0) === LF) {
      // The block already ended on its first line feed; this one is half of the separator, so the block is whole.
      const joined = this.pending.join("");
      this.onBlock(joined.slice(0, joined.length - 1));
      this.pending.length = 0;
      start = 1;
    }

    let separator = chunk.indexOf(BLOCK_SEPARATOR, start);
    while (separator >= 0) {
      const untilSeparator = chunk.slice(start, separator);
      if (this.pending.length === 0) this.onBlock(untilSeparator);
      else {
        this.pending.push(untilSeparator);
        this.onBlock(this.pending.join(""));
        this.pending.length = 0;
      }
      start = separator + BLOCK_SEPARATOR.length;
      separator = chunk.indexOf(BLOCK_SEPARATOR, start);
    }

    const tail = start === 0 ? chunk : chunk.slice(start);
    if (tail.length > 0) this.pending.push(tail);
    const last = this.pending.at(-1) ?? "";
    this.endedOnLineFeed = last.length > 0 && last.charCodeAt(last.length - 1) === LF;
  }
}
