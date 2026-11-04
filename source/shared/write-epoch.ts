/**
 * Whether what was written is still what the reader started from.
 *
 * A reader takes a snapshot and later asks whether anything has been written since. A write that is still in flight
 * counts as a change even before it lands, so a reader that starts while a write is half-done is told to read again
 * rather than handed a half-written view; a reset makes every write in flight irrelevant at once.
 */
export class WriteEpoch {
  #inFlightWrites = 0;
  #version = 0;
  #resetId = 0;

  begin(): () => void {
    this.#version += 1;
    this.#inFlightWrites += 1;
    const resetIdAtStart = this.#resetId;
    let finished = false;

    return () => {
      if (finished || resetIdAtStart !== this.#resetId) return;
      finished = true;
      this.#inFlightWrites -= 1;
      if (this.#inFlightWrites === 0) this.#version += 1;
    };
  }

  snapshot(): number {
    return this.#version;
  }

  isStale(observedVersion: number): boolean {
    return this.#inFlightWrites > 0 || observedVersion !== this.#version;
  }

  reset(): void {
    this.#resetId += 1;
    this.#inFlightWrites = 0;
    this.#version += 1;
  }
}
