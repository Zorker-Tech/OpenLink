/**
 * Whether what was written is still what the reader started from.
 *
 * A reader takes a snapshot and later asks whether anything has been written since. A write that is still in flight
 * counts as a change even before it lands, so a reader that starts while a write is half-done is told to read again
 * rather than handed a half-written view; a reset makes every write in flight irrelevant at once.
 */
export class WriteEpoch { #pending = 0; #epoch = 0; #generation = 0; begin(): () => void { this.#epoch += 1; this.#pending += 1; const generation = this.#generation; let settled = false; return () => { if (settled || generation !== this.#generation) return; settled = true; this.#pending -= 1; if (this.#pending === 0) this.#epoch += 1; }; } snapshot(): number { return this.#epoch; } isStale(snapshotAtStart: number): boolean { return this.#pending > 0 || this.#epoch !== snapshotAtStart; } reset(): void { this.#generation += 1; this.#pending = 0; this.#epoch += 1; } }
